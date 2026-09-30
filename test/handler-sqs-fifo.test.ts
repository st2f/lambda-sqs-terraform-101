import { afterEach, describe, expect, it, vi } from "vitest";

import { sqsEvent } from "../fixtures/sqs-event.js";
import { processFifoEvent } from "../src/handler-sqs-fifo.js";

function record(id: string, operation: string, receiveCount = "1") {
  return {
    ...sqsEvent.Records[0],
    messageId: id,
    body: JSON.stringify({
      jobId: `job-${id}`,
      imageId: "image-456",
      operation,
    }),
    attributes: {
      ...sqsEvent.Records[0].attributes,
      ApproximateReceiveCount: receiveCount,
      MessageGroupId: "customer-1",
    },
  };
}

const noDelay = { delayMs: 0 };

describe("FIFO SQS handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("processes every record in order when all succeed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await processFifoEvent({
        Records: [record("a", "resize"), record("b", "resize"), record("c", "resize")],
      }, noDelay),
    ).toEqual({ batchItemFailures: [] });
    expect(log.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ message }) => message === "Image job processed")
      .map(({ messageId }) => messageId))
      .toEqual(["a", "b", "c"]);
  });

  it("logs the group and brackets the controlled delay", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const wait = vi.fn(async () => undefined);

    await processFifoEvent(
      { Records: [record("a", "resize")] },
      { delayMs: 3_000, wait },
    );

    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(3_000);
    expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual([
      expect.objectContaining({
        timestamp: expect.any(String),
        message: "Image job started",
        messageId: "a",
        messageGroupId: "customer-1",
        delayMs: 3_000,
      }),
      expect.objectContaining({
        timestamp: expect.any(String),
        message: "Image job processed",
        messageId: "a",
        messageGroupId: "customer-1",
      }),
    ]);
  });

  it("reports the failed record and every later record, not earlier ones", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await processFifoEvent({
        Records: [
          record("a", "resize"),
          record("b", "unsupported"),
          record("c", "resize"),
        ],
      }, noDelay),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: "b" }, { itemIdentifier: "c" }],
    });

    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1][0])).messageId).toBe("a");
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
      level: "error",
      messageId: "b",
      messageGroupId: "customer-1",
      jobId: "job-b",
      errorType: "UnsupportedOperation",
    });
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      level: "warn",
      message: "Image job not attempted",
      messageId: "c",
      messageGroupId: "customer-1",
      receiveCount: 1,
      blockedBy: "b",
    });
  });

  it("does not process a record after a failure even if it would succeed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await processFifoEvent(
      { Records: [record("b", "unsupported"), record("c", "resize")] },
      noDelay,
    );

    expect(log).not.toHaveBeenCalled();
  });

  it("reports every record when the first one fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await processFifoEvent({
        Records: [
          record("a", "unsupported", "2"),
          record("b", "resize", "2"),
        ],
      }, noDelay),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: "a" }, { itemIdentifier: "b" }],
    });
  });
});
