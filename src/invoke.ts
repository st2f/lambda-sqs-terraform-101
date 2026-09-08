import {
  processImageJob,
  type ImageJobEvent,
} from "./process-image-job.js";

const event: ImageJobEvent = {
  jobId: "job-123",
  imageId: "image-456",
  operation: "resize",
};

console.log("Processing an image job locally...");
const result = await processImageJob(event);
console.log("Processing result:", JSON.stringify(result));
