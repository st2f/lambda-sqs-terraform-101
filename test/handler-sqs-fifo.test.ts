import { afterEach, describe, expect, it, vi } from "vitest";

import { sqsEvent } from "../fixtures/sqs-event.js";
import { handler } from "../src/handler-sqs-fifo.js";

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
    },
  };
}

describe("FIFO SQS handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("processes every record in order when all succeed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await handler({
        Records: [record("a", "resize"), record("b", "resize"), record("c", "resize")],
      }),
    ).toEqual({ batchItemFailures: [] });
    expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)).messageId))
      .toEqual(["a", "b", "c"]);
  });

  it("reports the failed record and every later record, not earlier ones", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await handler({
        Records: [
          record("a", "resize"),
          record("b", "unsupported"),
          record("c", "resize"),
        ],
      }),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: "b" }, { itemIdentifier: "c" }],
    });

    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0])).messageId).toBe("a");
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
      level: "error",
      messageId: "b",
      jobId: "job-b",
      errorType: "UnsupportedOperation",
    });
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      level: "warn",
      message: "Image job not attempted",
      messageId: "c",
      receiveCount: 1,
      blockedBy: "b",
    });
  });

  it("does not process a record after a failure even if it would succeed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await handler({ Records: [record("b", "unsupported"), record("c", "resize")] });

    expect(log).not.toHaveBeenCalled();
  });

  it("reports every record when the first one fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await handler({
        Records: [
          record("a", "unsupported", "2"),
          record("b", "resize", "2"),
        ],
      }),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: "a" }, { itemIdentifier: "b" }],
    });
  });
});
