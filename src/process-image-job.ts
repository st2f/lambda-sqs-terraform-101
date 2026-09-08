export interface ImageJobEvent {
  jobId: string;
  imageId: string;
  operation: "resize";
}

export interface ImageJobResult {
  jobId: string;
  status: "accepted";
}

/** Application behavior shared by delivery-specific Lambda handlers. */
export async function processImageJob(
  event: ImageJobEvent,
): Promise<ImageJobResult> {
  console.log(
    JSON.stringify({
      message: "Image job received",
      jobId: event.jobId,
      imageId: event.imageId,
      operation: event.operation,
    }),
  );

  if (event.jobId === "FAIL") {
    throw new Error("Intentional failure for observation exercise");
  }

  return {
    jobId: event.jobId,
    status: "accepted",
  };
}
