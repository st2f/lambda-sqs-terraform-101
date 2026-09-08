import { afterEach, describe, expect, it, vi } from "vitest";

import { handler } from "../src/handler-sqs.js";
import { sqsEvent } from "../fixtures/sqs-event.js";

function eventWithBody(body: string) {
  return { Records: [{ ...sqsEvent.Records[0], body }] };
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
    expect(result).toEqual({
      jobId: "job-601",
      status: "accepted",
    });

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
    expect(result).toEqual({
      jobId: "job-long",
      status: "accepted",
    });

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

  it("fails a job marked for the observation exercise", async () => {
    // Given an SQS delivery containing the exercise's failure marker.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = eventWithBody(
      JSON.stringify({
        jobId: "FAIL",
        imageId: "image-456",
        operation: "resize",
      }),
    );

    // When the Lambda handles the delivery
    const result = handler(event);

    // Then it exposes the intentional failure for retry observation
    await expect(result).rejects.toThrow(
      "Intentional failure for observation exercise",
    );
  });

  it("rejects a delivery containing more than one SQS record", async () => {
    // Given a delivery that violates this increment's one-record contract
    const event = { Records: [sqsEvent.Records[0], sqsEvent.Records[0]] };

    // When the Lambda handles the delivery
    const result = handler(event);

    // Then it rejects the whole delivery rather than acknowledging unseen work
    await expect(result).rejects.toThrow("exactly one SQS record");
  });
});
