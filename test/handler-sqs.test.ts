import { afterEach, describe, expect, it, vi } from "vitest";

import { handler } from "../src/handler-sqs.js";
import { sqsEvent } from "../fixtures/sqs-event.js";

function eventWithBody(body: string) {
  return { Records: [{ ...sqsEvent.Records[0], body }] };
}

function record(messageId: string, jobId: string) {
  return {
    ...sqsEvent.Records[0],
    messageId,
    body: JSON.stringify({
      jobId,
      imageId: "image-456",
      operation: "resize",
    }),
  };
}

describe("SQS handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid image job delivered by SQS", async () => {
    // Given an SQS delivery containing a valid image job.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // When the Lambda handles the delivery
    const result = await handler(sqsEvent);

    // Then it accepts the application job from the message body
    expect(result).toEqual([{
      jobId: "job-601",
      status: "accepted",
    }]);

    // And it records the useful delivery context without logging other fields
    expect(log).toHaveBeenCalledTimes(2);
    const envelope = JSON.parse(String(log.mock.calls[0][0]));
    expect(envelope).toEqual({
      message: "SQS event received",
      Records: [
        {
          messageId: sqsEvent.Records[0].messageId,
          body: sqsEvent.Records[0].body,
          bodyTruncated: false,
          attributes: {
            ApproximateReceiveCount: "1",
            SentTimestamp: "1788775200000",
            ApproximateFirstReceiveTimestamp: "1788775201000",
          },
          eventSource: "aws:sqs",
          eventSourceARN: sqsEvent.Records[0].eventSourceARN,
          awsRegion: "eu-west-1",
        },
      ],
    });
    expect(JSON.parse(String(log.mock.calls[1][0]))).toEqual({
      message: "Image job received",
      jobId: "job-601",
      imageId: "image-456",
      operation: "resize",
    });
  });

  it("accepts a job beyond the logged body preview", async () => {
    // Given a valid job whose identifiers occur after the preview limit 200
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = JSON.stringify({
      padding: "x".repeat(250),
      jobId: "job-long",
      imageId: "image-456",
      operation: "resize",
    });

    // When the Lambda handles the delivery
    const result = await handler(eventWithBody(body));

    // Then it processes the complete body successfully
    expect(result).toEqual([{
      jobId: "job-long",
      status: "accepted",
    }]);

    // And it limits the body included in the delivery log
    expect(JSON.parse(String(log.mock.calls[0][0])).Records[0]).toMatchObject({
      body: body.slice(0, 200),
      bodyTruncated: true,
    });
  });

  it.each(["{broken", "null", '{"jobId":42}'])(
    "rejects an invalid SQS message body: %s",
    async (body) => {
      // Given an SQS delivery whose body is not a valid image job
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // When the Lambda handles the delivery
      const result = handler(eventWithBody(body));

      // Then it rejects the message so SQS can apply its retry policy
      await expect(result).rejects.toThrow();
    },
  );

  it("accepts the job preserved by the completed failure exercise", async () => {
    // Given the same body as the message waiting in the DLQ
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = eventWithBody(
      JSON.stringify({
        jobId: "FAIL",
        imageId: "image-456",
        operation: "resize",
      }),
    );

    // When the corrected Lambda handles the replayed delivery
    const result = await handler(event);

    // Then it accepts the job instead of repeating the old failure
    expect(result).toEqual([{ jobId: "FAIL", status: "accepted" }]);
  });

  it("processes every record in a successful batch", async () => {
    // Given three valid jobs delivered to one Lambda invocation
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = {
      Records: [
        record("message-1", "job-1201"),
        record("message-2", "job-1202"),
        record("message-3", "job-1203"),
      ],
    };

    // When the Lambda handles the batch
    const result = await handler(event);

    // Then every job is processed explicitly in record order
    expect(result).toEqual([
      { jobId: "job-1201", status: "accepted" },
      { jobId: "job-1202", status: "accepted" },
      { jobId: "job-1203", status: "accepted" },
    ]);
    expect(log).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(log.mock.calls[0][0])).Records).toHaveLength(3);
    expect(log.mock.calls.slice(1).map(([entry]) => JSON.parse(String(entry)).jobId))
      .toEqual(["job-1201", "job-1202", "job-1203"]);
  });

  it("rejects the whole invocation when one record fails", async () => {
    // Given GOOD-1, GOOD-2, an invalid job, and GOOD-3 in one delivery
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = {
      Records: [
        record("message-1", "GOOD-1"),
        record("message-2", "GOOD-2"),
        {
          ...sqsEvent.Records[0],
          messageId: "message-3",
          body: JSON.stringify({
            jobId: "FAIL",
            imageId: "image-456",
            operation: "unsupported",
          }),
        },
        record("message-4", "GOOD-3"),
      ],
    };

    // When the Lambda handles the batch using default failure behavior
    const result = handler(event);

    // Then the invocation fails after GOOD-1 and GOOD-2 have done their work
    await expect(result).rejects.toThrow("Invalid image job");
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.slice(1).map(([entry]) => JSON.parse(String(entry)).jobId))
      .toEqual(["GOOD-1", "GOOD-2"]);
  });
});
