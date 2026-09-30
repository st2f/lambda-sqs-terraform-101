import {
  parseJob,
  type SqsBatchResponse,
  type SqsEvent,
} from "./handler-sqs-structured.js";

/**
 * Process FIFO records in order and stop at the first failure.
 *
 * The failed record and every later record are returned in batchItemFailures.
 * Reporting only the failed record would let Lambda delete the later records,
 * so they would be processed before the failed record is retried.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  for (const [index, record] of event.Records.entries()) {
    const receiveCount = Number(record.attributes.ApproximateReceiveCount);
    let jobId: string | undefined;
    let operation: string | undefined;

    try {
      ({ jobId, operation } = parseJob(record.body));
      if (operation !== "resize") {
        throw new Error("UnsupportedOperation");
      }

      console.log(JSON.stringify({
        level: "info",
        message: "Image job processed",
        messageId: record.messageId,
        jobId,
        operation,
        receiveCount,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        message: "Image job failed",
        messageId: record.messageId,
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
          level: "warn",
          message: "Image job not attempted",
          messageId: skipped.messageId,
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
