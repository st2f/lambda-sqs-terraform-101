import { handler } from "./handler-sqs.js";
import { sqsEvent } from "../fixtures/sqs-event.js";

console.log("Invoking the SQS handler locally with a synthetic event...");
const result = await handler(sqsEvent);
console.log("Handler result:", JSON.stringify(result));
