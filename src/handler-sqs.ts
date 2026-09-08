import {
  processImageJob,
  type ImageJobEvent,
  type ImageJobResult,
} from "./process-image-job.js";

// Only the SQS fields used by this handler; AWS supplies additional fields.
export interface SqsEvent {
  Records: Array<{
    messageId: string;
    body: string;
    attributes: {
      ApproximateReceiveCount: string;
      SentTimestamp: string;
      ApproximateFirstReceiveTimestamp: string;
    };
    eventSource: string;
    eventSourceARN: string;
    awsRegion: string;
  }>;
}

/** Inspect an SQS delivery envelope and process its image job. */
export async function handler(
  event: ImageJobEvent | SqsEvent,
): Promise<ImageJobResult> {
  if (!("Records" in event)) {
    return processImageJob(event);
  }

  // This increment uses batch_size = 1. Reject rather than ignore extra work.
  if (event.Records.length !== 1) {
    throw new Error("This increment expects exactly one SQS record");
  }
  const record = event.Records[0];

  // Explicit selection avoids logging receipt handles or arbitrary attributes.
  // Body previews are for this lab's invented data; truncation is not redaction.
  console.log(JSON.stringify({
    message: "SQS event received",
    Records: [{
      messageId: record.messageId,
      body: record.body.slice(0, 200),
      bodyTruncated: record.body.length > 200,
      attributes: {
        ApproximateReceiveCount: record.attributes.ApproximateReceiveCount,
        SentTimestamp: record.attributes.SentTimestamp,
        ApproximateFirstReceiveTimestamp: record.attributes.ApproximateFirstReceiveTimestamp,
      },
      eventSource: record.eventSource,
      eventSourceARN: record.eventSourceARN,
      awsRegion: record.awsRegion,
    }],
  }));

  const job: unknown = JSON.parse(record.body);
  if (
    typeof job !== "object" || job === null ||
    !("jobId" in job) || typeof job.jobId !== "string" ||
    !("imageId" in job) || typeof job.imageId !== "string" ||
    !("operation" in job) || job.operation !== "resize"
  ) {
    throw new Error("Invalid image job");
  }

  return processImageJob({
    jobId: job.jobId,
    imageId: job.imageId,
    operation: job.operation,
  });
}
