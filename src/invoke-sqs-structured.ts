import { sqsEvent } from "../fixtures/sqs-event.js";
import { handler } from "./handler-sqs-structured.js";

await handler(sqsEvent);
