import {
  parseJob,
  type SqsBatchResponse,
  type SqsEvent,
} from "./handler-sqs-structured.js";

const processingDelayMs = 3_000;

type Wait = (milliseconds: number) => Promise<void>;

const wait: Wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface ProcessingOptions {
  delayMs?: number;
  wait?: Wait;
}

/**
 * Process FIFO records in order and stop at the first failure.
 *
 * The failed record and every later record are returned in batchItemFailures.
 * Reporting only the failed record would let Lambda delete the later records,
 * so they would be processed before the failed record is retried.
 */
export async function processFifoEvent(
  event: SqsEvent,
  options: ProcessingOptions = {},
): Promise<SqsBatchResponse> {
  const delayMs = options.delayMs ?? processingDelayMs;
  const delay = options.wait ?? wait;

  for (const [index, record] of event.Records.entries()) {
    const receiveCount = Number(record.attributes.ApproximateReceiveCount);
    const messageGroupId = record.attributes.MessageGroupId;
    let jobId: string | undefined;
    let operation: string | undefined;

    try {
      ({ jobId, operation } = parseJob(record.body));
      if (operation !== "resize") {
        throw new Error("UnsupportedOperation");
      }

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "Image job started",
        messageId: record.messageId,
        messageGroupId,
        jobId,
        delayMs,
        receiveCount,
      }));

      await delay(delayMs);

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "Image job processed",
        messageId: record.messageId,
        messageGroupId,
        jobId,
        operation,
        receiveCount,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        message: "Image job failed",
        messageId: record.messageId,
        messageGroupId,
        jobId,
        operation,
        receiveCount,
        errorType: error instanceof SyntaxError
          ? "InvalidJson"
          : error instanceof Error ? error.message : "UnexpectedError",
      }));

      const unprocessed = event.Records.slice(index + 1);
      for (const skipped of unprocessed) {
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: "Image job not attempted",
          messageId: skipped.messageId,
          messageGroupId: skipped.attributes.MessageGroupId,
          receiveCount: Number(skipped.attributes.ApproximateReceiveCount),
          blockedBy: record.messageId,
        }));
      }

      return {
        batchItemFailures: [record, ...unprocessed].map((failed) => ({
          itemIdentifier: failed.messageId,
        })),
      };
    }
  }

  return { batchItemFailures: [] };
}

/** AWS entry point: use a visible delay so overlapping FIFO groups are observable. */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  return processFifoEvent(event);
}
