# Idempotent consumer

The safe manual replay pattern is:

```text
Original message remains in DLQ
              │
              │ copy its body
              ▼
New SQS message enters source queue
              │
              ▼
Idempotent consumer processes logical job
              │
              ▼
Verify success
              │
              ▼
Delete original DLQ message
```

There are two identities:

- **SQS message ID:** identifies one physical delivery. The replay gets a new ID.
- **Application job ID:** identifies the logical operation. Both messages contain the same `jobId`.

An idempotent consumer uses the application identity—typically `jobId`—to prevent repeated delivery or replay from repeating harmful side effects.

For example, it might atomically record:

```text
jobId=FAIL → completed
```

Before processing, it checks or conditionally creates that record. If the same job appears again, it returns success without repeating the operation.

Keeping the original until success avoids message loss. Idempotency addresses the opposite risk: duplicates caused by copying, retries, or uncertainty about whether processing succeeded. This provides effectively-once business behavior on top of SQS’s at-least-once delivery—not literal exactly-once message delivery.
