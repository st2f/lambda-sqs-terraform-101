import { sqsEvent } from "../fixtures/sqs-event.js";
import { processFifoEvent } from "./handler-sqs-fifo.js";

const fifoEvent = {
  Records: sqsEvent.Records.map((record) => ({
    ...record,
    attributes: { ...record.attributes, MessageGroupId: "customer-1" },
  })),
};

await processFifoEvent(fifoEvent, { delayMs: 100 });
