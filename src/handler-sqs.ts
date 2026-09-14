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

/** Inspect an SQS delivery envelope and process each image job explicitly. */
export async function handler(
  event: ImageJobEvent | SqsEvent,
): Promise<ImageJobResult | ImageJobResult[]> {
  if (!("Records" in event)) {
    return processImageJob(event);
  }

  // Explicit selection avoids logging receipt handles or arbitrary attributes.
  // Body previews are for this lab's invented data; truncation is not redaction.
  console.log(JSON.stringify({
    message: "SQS event received",
    Records: event.Records.map((record) => ({
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
    })),
  }));

  const results: ImageJobResult[] = [];

  for (const record of event.Records) {
    const job: unknown = JSON.parse(record.body);
    if (
      typeof job !== "object" || job === null ||
      !("jobId" in job) || typeof job.jobId !== "string" ||
      !("imageId" in job) || typeof job.imageId !== "string" ||
      !("operation" in job) || job.operation !== "resize"
    ) {
      throw new Error("Invalid image job");
    }

    results.push(await processImageJob({
      jobId: job.jobId,
      imageId: job.imageId,
      operation: job.operation,
    }));
  }

  return results;
}
