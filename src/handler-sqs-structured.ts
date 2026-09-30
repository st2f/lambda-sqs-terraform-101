export interface SqsEvent {
  Records: Array<{
    messageId: string;
    body: string;
    attributes: {
      ApproximateReceiveCount: string;
      MessageGroupId?: string;
    };
  }>;
}

export interface SqsBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

export function parseJob(body: string): { jobId: string; operation: string } {
  const value: unknown = JSON.parse(body);
  if (
    typeof value !== "object" || value === null ||
    !("jobId" in value) || typeof value.jobId !== "string" ||
    !("imageId" in value) || typeof value.imageId !== "string" ||
    !("operation" in value) || typeof value.operation !== "string"
  ) {
    throw new Error("InvalidJob");
  }
  return { jobId: value.jobId, operation: value.operation };
}

/** Process SQS records and log only the fields needed to follow each delivery. */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: SqsBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
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
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
