import { sqsEvent } from "../fixtures/sqs-event.js";
import { handler } from "./handler-sqs-fifo.js";

await handler(sqsEvent);
