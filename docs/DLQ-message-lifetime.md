# DLQ should have the longer retention period

For a standard SQS queue, moving a message to a DLQ does not reset the message’s retention clock.

Example:

```text
Source retention: 4 days
DLQ retention:    4 days

Day 0: Message enters source queue
Day 3: Message moves to DLQ
Day 4: Message expires
```

Although the message entered the DLQ on day 3, it has only about one day left because its age is still calculated from day 0.

In this project:

```text
Source retention:  4 days
DLQ retention:    14 days
```

Therefore, even if a message spends almost four days in the source queue, it should remain available in the DLQ for roughly another ten days. That gives you time to inspect, diagnose, and potentially redrive it.

One subtlety: the DLQ’s `ApproximateAgeOfOldestMessage` metric measures time since the message reached the DLQ, even though expiration uses its original source-queue enqueue time. Those two notions of “age” can therefore differ.
