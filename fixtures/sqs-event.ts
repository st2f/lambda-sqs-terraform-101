// Synthetic standard-queue event for local exercises, not a capture from AWS.
// The receipt handle, account ID, and queue identity are placeholders.
export const sqsEvent = {
  Records: [
    {
      messageId: "6aeac006-064a-4ca9-a010-000000000601",
      receiptHandle: "EXAMPLE-RECEIPT-HANDLE-DO-NOT-LOG",
      body: '{"jobId":"job-601","imageId":"image-456","operation":"resize"}',
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1788775200000",
        SenderId: "EXAMPLE-SENDER-DO-NOT-LOG",
        ApproximateFirstReceiveTimestamp: "1788775201000",
      },
      messageAttributes: {},
      md5OfBody: "05915f5169747c3551357fa6aa15ac7b",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:eu-west-1:123456789012:example-image-jobs",
      awsRegion: "eu-west-1",
    },
  ],
};
