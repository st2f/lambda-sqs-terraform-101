import { handler } from "./handler.js";
import type { ImageJobEvent } from "./handler.js";

const event: ImageJobEvent = {
  jobId: "job-123",
  imageId: "image-456",
  operation: "resize",
};

console.log("Invoking handler locally...");
const result = await handler(event);
console.log("Handler result:", JSON.stringify(result));

