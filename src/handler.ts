export interface ImageJobEvent {
  jobId: string;
  imageId: string;
  operation: "resize";
}

export interface ImageJobResult {
  jobId: string;
  status: "accepted";
}

/**
 * The Lambda handler is the function AWS will call for each invocation.
 * Increment 1 calls it directly; no AWS services are involved yet.
 */
export async function handler(event: ImageJobEvent): Promise<ImageJobResult> {
  console.log(
    JSON.stringify({
      message: "Image job received",
      jobId: event.jobId,
      imageId: event.imageId,
      operation: event.operation,
    }),
  );

  return {
    jobId: event.jobId,
    status: "accepted",
  };
}
