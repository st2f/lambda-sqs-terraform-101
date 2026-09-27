import { afterEach, describe, expect, it, vi } from "vitest";

import { sqsEvent } from "../fixtures/sqs-event.js";
import { handler } from "../src/handler-sqs-structured.js";

describe("structured SQS handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a successful record with both correlation IDs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await handler(sqsEvent)).toEqual({ batchItemFailures: [] });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      level: "info",
      message: "Image job processed",
      messageId: sqsEvent.Records[0].messageId,
      jobId: "job-601",
      operation: "resize",
      receiveCount: 1,
    });
  });

  it("correlates poison-message retries and reports only that record", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const poison = {
      ...sqsEvent.Records[0],
      messageId: "poison-message",
      body: JSON.stringify({
        jobId: "job-18-poison",
        imageId: "image-456",
        operation: "unsupported",
      }),
    };
    const good = sqsEvent.Records[0];

    expect(await handler({ Records: [poison, good] })).toEqual({
      batchItemFailures: [{ itemIdentifier: "poison-message" }],
    });
    expect(log).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();

    const retry = {
      ...poison,
      attributes: { ...poison.attributes, ApproximateReceiveCount: "2" },
    };
    expect(await handler({ Records: [retry] })).toEqual({
      batchItemFailures: [{ itemIdentifier: "poison-message" }],
    });
    expect(error.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual([
      {
        level: "error",
        message: "Image job failed",
        messageId: "poison-message",
        jobId: "job-18-poison",
        operation: "unsupported",
        receiveCount: 1,
        errorType: "UnsupportedOperation",
      },
      {
        level: "error",
        message: "Image job failed",
        messageId: "poison-message",
        jobId: "job-18-poison",
        operation: "unsupported",
        receiveCount: 2,
        errorType: "UnsupportedOperation",
      },
    ]);
  });
});
