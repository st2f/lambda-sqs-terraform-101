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

    // Then it reports no failed SQS records
    expect(result).toEqual({ batchItemFailures: [] });

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
    expect(result).toEqual({ batchItemFailures: [] });

    // And it limits the body included in the delivery log
    expect(JSON.parse(String(log.mock.calls[0][0])).Records[0]).toMatchObject({
      body: body.slice(0, 200),
      bodyTruncated: true,
    });
  });

  it.each(["{broken", "null", '{"jobId":42}'])(
    "reports an invalid SQS message body: %s",
    async (body) => {
      // Given an SQS delivery whose body is not a valid image job
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      // When the Lambda handles the delivery
      const result = await handler(eventWithBody(body));

      // Then it identifies only that message for retry and records the failure
      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: sqsEvent.Records[0].messageId }],
      });
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
        message: "SQS record failed",
        messageId: sqsEvent.Records[0].messageId,
      });
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

    // Then it accepts the job instead of reporting it for retry
    expect(result).toEqual({ batchItemFailures: [] });
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

    // Then every job is processed explicitly and none is reported for retry
    expect(result).toEqual({ batchItemFailures: [] });
    expect(log).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(log.mock.calls[0][0])).Records).toHaveLength(3);
    expect(log.mock.calls.slice(1).map(([entry]) => JSON.parse(String(entry)).jobId))
      .toEqual(["job-1201", "job-1202", "job-1203"]);
  });

  it("reports one failed record and continues processing the batch", async () => {
    // Given GOOD-1, GOOD-2, an invalid job, and GOOD-3 in one delivery
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
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

    // When the Lambda handles the batch using partial batch responses
    const result = await handler(event);

    // Then only FAIL is reported, and processing continues with GOOD-3
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-3" }],
    });
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.slice(1).map(([entry]) => JSON.parse(String(entry)).jobId))
      .toEqual(["GOOD-1", "GOOD-2", "GOOD-3"]);
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({
      message: "SQS record failed",
      messageId: "message-3",
      errorName: "Error",
      errorMessage: "Invalid image job",
    });
  });
});
