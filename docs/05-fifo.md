# 05 FIFO Behavior and Concurrency

## 21. Introduce a FIFO Queue

Create a FIFO queue beside the standard one and use the AWS CLI to see how message groups, ordering, and deduplication behave. The FIFO queue has no Lambda consumer and no failures yet: it is an isolated experiment, so you observe SQS ordering rather than handler behavior.

Prerequisites:

- The standard-queue resources in `terraform/main.tf` are deployed. They are not changed by this increment; the alarm and the standard queue keep working.
- AWS CLI credentials can apply Terraform and send, receive, and purge SQS messages. Run commands from the repository root; Terraform is initialized in `terraform/`.
- Nothing else uses the FIFO queue. The purge steps below delete every message in it.

Relevant files: `terraform/main.tf` defines `aws_sqs_queue.image_jobs_fifo`; `terraform/outputs.tf` exposes its URL, ARN, and name. No application code changes.

### The queue

| Setting | Value | Meaning |
| --- | --- | --- |
| `name` | `<function>-image-jobs.fifo` | SQS requires the `.fifo` suffix on a FIFO queue's name. It is part of the identity: a standard queue cannot be converted to FIFO, or the reverse, so changing `fifo_queue` forces replacement. |
| `fifo_queue` | `true` | Enables ordering within a message group and deduplication. |
| `content_based_deduplication` | `false` | SQS will not derive a deduplication ID from the body. Each send must provide `MessageDeduplicationId`, which makes the mechanism visible. |

There is no `redrive_policy` at this point, so a message that is received but never deleted stays in this queue. Increment 22 adds a redrive policy and a consumer.

### Review and create the queue

```bash
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-21.tfplan
terraform -chdir=terraform show increment-21.tfplan
```

Expect exactly one addition, `aws_sqs_queue.image_jobs_fifo`, and no change to any existing resource. Apply the saved plan:

```bash
terraform -chdir=terraform apply increment-21.tfplan
```

A FIFO queue costs slightly more per request than a standard queue; at this volume the cost is negligible. An idle queue costs nothing, and `terraform destroy` removes it.

Set shell variables for the rest of the exercise:

```bash
FIFO_REGION="$(terraform -chdir=terraform output -raw aws_region)"
FIFO_URL="$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_url)"
aws sqs get-queue-attributes --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --attribute-names FifoQueue ContentBasedDeduplication VisibilityTimeout
```

Expect `FifoQueue: "true"` and `ContentBasedDeduplication: "false"`.

### Order within one group

Send five jobs to one group. `MessageGroupId` defines the ordering scope; each `MessageDeduplicationId` is unique:

```bash
for n in 1 2 3 4 5; do
  aws sqs send-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
    --message-group-id customer-1 \
    --message-deduplication-id "job-21-c1-$n" \
    --message-body "{\"jobId\":\"job-21-c1-$n\",\"imageId\":\"image-456\",\"operation\":\"resize\"}" \
    --query '{MessageId:MessageId,Sequence:SequenceNumber}'
done
```

Each response has a `MessageId` and a `SequenceNumber` that increases with each send. Receive them:

```bash
aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --max-number-of-messages 10 --wait-time-seconds 5 \
  --message-system-attribute-names MessageGroupId \
  --query 'Messages[].{Group:Attributes.MessageGroupId,Body:Body}'
```

Expect all five messages in `customer-1` in the order they were sent, `job-21-c1-1` through `job-21-c1-5`. They are now in flight and are not deleted. Receive again immediately:

```bash
aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --max-number-of-messages 10 --wait-time-seconds 5 \
  --query 'Messages[].Body'
```

Expect no messages until the visibility timeout (30 seconds by default) expires. SQS does not deliver later messages in a group while earlier ones are in flight, because that could break the order. Clear the queue before the next experiment:

```bash
aws sqs purge-queue --region "$FIFO_REGION" --queue-url "$FIFO_URL"
sleep 60
```

### Two groups

Send an interleaved sequence to two groups. The messages alternate in time:

```bash
for n in 1 2 3; do
  for group in customer-1 customer-2; do
    aws sqs send-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
      --message-group-id "$group" \
      --message-deduplication-id "job-21-$group-$n" \
      --message-body "{\"jobId\":\"job-21-$group-$n\",\"imageId\":\"image-456\",\"operation\":\"resize\"}" \
      --query 'SequenceNumber' --output text
  done
done

aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --max-number-of-messages 10 --wait-time-seconds 5 \
  --message-system-attribute-names MessageGroupId \
  --query 'Messages[].{Group:Attributes.MessageGroupId,Body:Body}'
```

Within each group, the numbers must appear in increasing order. The result may list the groups separated or interleaved, and a single call may return fewer than six messages; repeat the receive after the visibility timeout to see the rest. The order across groups is not guaranteed, and it does not need to be: ordering applies only within a message group.

```bash
aws sqs purge-queue --region "$FIFO_REGION" --queue-url "$FIFO_URL"
sleep 60
```

### Deduplication

Send the same deduplication ID twice with different bodies:

```bash
for body in first second; do
  aws sqs send-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
    --message-group-id customer-1 \
    --message-deduplication-id job-21-duplicate \
    --message-body "{\"jobId\":\"job-21-duplicate\",\"imageId\":\"image-456\",\"operation\":\"resize\",\"attempt\":\"$body\"}" \
    --query 'MessageId'
done
sleep 5
aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --max-number-of-messages 10 --wait-time-seconds 5 \
  --query 'Messages[].Body'
```

Both sends succeed and return a `MessageId`, and the second call is not an error. The receive returns only the `first` body, because SQS discarded the second within the five-minute deduplication interval. The deduplication ID, not the body, decides what is a duplicate; with `content_based_deduplication` on, SQS would derive the ID from a hash of the body instead. Clear the queue:

```bash
aws sqs purge-queue --region "$FIFO_REGION" --queue-url "$FIFO_URL"
```

### What to take away

- A FIFO queue preserves order within a `MessageGroupId`, not across the whole queue. Choose the group by the entity whose events must stay ordered.
- The deduplication ID makes a repeated send within five minutes a no-op. It protects against producer retries; it is not consumer-side idempotency, and it does not stop a message from being delivered twice to a consumer.
- FIFO does not mean one globally serialized consumer. While a group has messages in flight, SQS holds back that group's later messages; other groups remain available, so several consumers can work on different groups at once. Ordering limits concurrency inside a group, not between groups.
- Rollback: remove the FIFO resource and its outputs, then `terraform apply`. Nothing else depends on it.

## 22. FIFO Poison Message

Attach the existing Lambda to the FIFO queue and send one poison message inside one of two message groups. The poison message blocks the messages behind it in its own group while the other group keeps flowing. The queue's DLQ bounds the retries.

Prerequisites:

- The resources from Increment 21 and the structured handler are deployed: `dist/handler.js` is built from `src/handler-sqs-structured.ts`. The handler is not changed in this increment.
- The FIFO queue is empty. The standard queue and its DLQ can be idle; this exercise does not use them.
- AWS CLI credentials can apply Terraform, send and receive SQS messages, purge the FIFO DLQ, and read Lambda logs. Run commands from the repository root; Terraform is initialized in `terraform/`.

Relevant files: `terraform/main.tf` gains `aws_sqs_queue.image_jobs_fifo_dead_letter`, a redrive policy and visibility timeout on `aws_sqs_queue.image_jobs_fifo`, the FIFO queue in the Lambda's SQS permissions, and `aws_lambda_event_source_mapping.image_jobs_fifo`. `terraform/outputs.tf` exposes the FIFO DLQ.

### What changes, and why each piece is needed

| Change | Purpose |
| --- | --- |
| `aws_sqs_queue.image_jobs_fifo_dead_letter` | A FIFO queue can only dead-letter into a FIFO queue, so the DLQ has its own `.fifo` name. |
| `redrive_policy` on the FIFO queue, `maxReceiveCount` 3 | Without it, a failed message keeps returning and keeps blocking its group until retention expires. Three is deliberately low for the exercise |
| `visibility_timeout_seconds` 30 | Six times the Lambda timeout. Each retry of the poison message waits about 30 seconds, so the block is visible in timestamps. |
| FIFO ARN in `aws_iam_role_policy.lambda_sqs` | The same execution role must receive from and delete from the FIFO queue. Without it the mapping cannot poll |
| `aws_lambda_event_source_mapping.image_jobs_fifo`, batch size 1 | Connects the FIFO queue to the existing function. With one record per invocation, reporting a failed record is equivalent to failing the whole invocation, so the effect on ordering comes from FIFO itself. Larger batches come in next increment |

The standard-queue mapping and the handler are untouched. Both mappings invoke the same function and write to the same log group, so filter logs by the job IDs below.

### Review and apply

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-22.tfplan
terraform -chdir=terraform show increment-22.tfplan
```

Expect these changes and no replacement:

- a new FIFO DLQ;
- an in-place update of `aws_sqs_queue.image_jobs_fifo` adding the redrive policy and visibility timeout;
- an in-place update of the inline IAM policy;
- and a new `aws_lambda_event_source_mapping.image_jobs_fifo`.

The Lambda code should be unchanged. Apply the saved plan:

```bash
terraform -chdir=terraform apply increment-22.tfplan
```

Mapping creation is asynchronous. Wait until this reports `Enabled`:

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,BatchSize:BatchSize}'
```

### Send the two groups

Set variables and send the jobs. The poison message is `B`: its operation is one the handler rejects. The group and letter are in each `jobId`, because the handler's logs do not include the message group.:

```bash
FIFO_REGION="$(terraform -chdir=terraform output -raw aws_region)"
FIFO_URL="$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_url)"
FIFO_DLQ_URL="$(terraform -chdir=terraform output -raw image_jobs_fifo_dead_letter_queue_url)"
LOG_GROUP="$(terraform -chdir=terraform output -raw lambda_log_group_name)"

send() { # group letter operation
  aws sqs send-message --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
    --message-group-id "$1" --message-deduplication-id "job-22-$1-$2" \
    --message-body "{\"jobId\":\"job-22-$1-$2\",\"imageId\":\"image-456\",\"operation\":\"$3\"}" \
    --query 'MessageId' --output text
}

send customer-1 A resize
send customer-1 B unsupported
send customer-1 C resize
send customer-2 X resize
send customer-2 Y resize
send customer-2 Z resize
```

Each send returns a `MessageId`. Record the one for `customer-1` `B`; it follows that message through every retry.

### Observe the block

Wait for the retries to finish. `B` needs three receives about 30 seconds apart, so allow about three minutes:

```bash
sleep 180
aws logs tail "$LOG_GROUP" --region "$FIFO_REGION" --since 10m \
  --format short --filter-pattern '"job-22"'
```

The log lines are in time order, with a timestamp on each. Expect:

- `job-22-customer-2-X`, `Y`, and `Z` logged as `Image job processed` within a few seconds of sending, and in that order. `customer-2` is not affected by `B`.
- `job-22-customer-1-A` processed promptly, in the same initial burst.
- `job-22-customer-1-B` logged as `Image job failed` with `errorType: "UnsupportedOperation"` and `receiveCount` 1, 2, and 3, each about 30 seconds after the last.
- `job-22-customer-1-C` logged as processed only after the third failure of `B`. It does not appear between `B`'s retries, although it was already waiting in the queue.

The `messageId` on the three `B` failures is identical and equals the `MessageId` you recorded. Lambda request IDs differ. `C` was never received while `B` was still in the queue: FIFO will not hand out a later message of a group while an earlier one has not been deleted.

### Verify the DLQ and queue state

```bash
aws sqs get-queue-attributes --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_DLQ_URL" \
  --max-number-of-messages 10 --visibility-timeout 0 \
  --attribute-names ApproximateReceiveCount \
  --message-system-attribute-names MessageGroupId \
  --query 'Messages[].{Group:Attributes.MessageGroupId,Body:Body,MessageId:MessageId}'
```

The source queue should settle at zero visible and zero in-flight. The DLQ should hold only the body of `job-22-customer-1-B`, with `MessageGroupId` `customer-1`. Using `--visibility-timeout 0` inspects without hiding it. Counts are approximate and lag; repeat the reads if they have not settled.

### Explain the ordering

- **Within `customer-1`:** `B` blocked `C`. After `B` is removed, `C` runs. The block lasts as long as `B` stays in the queue. Here the DLQ limits that to three receives. Without a redrive policy, it would last until the retention period ended, about four days by default.
- **Across groups:** `customer-2` is an independent ordering scope. Its messages kept flowing while `customer-1` was stuck. A poison message costs throughput only for its own group.
- **Retry and error handling matter more with FIFO:** a failed message is not merely delayed. It holds back every later message of its group, so the order the producer chose becomes the order in which failures are discovered. Bounding retries and watching the DLQ are part of the ordering design.
- **DLQ and ordering:** once `B` moves to the DLQ, `C` is processed before `B`. Order in the source queue is preserved only while messages stay in it; dead-lettering removes the failed message from the sequence, so replaying `B` later would run it after `C`.

### Clear and roll back

Purge the FIFO DLQ after inspecting it. This deletes every message in it:

```bash
aws sqs purge-queue --region "$FIFO_REGION" --queue-url "$FIFO_DLQ_URL"
```

Rollback: remove the FIFO DLQ, the redrive policy, the FIFO mapping, and the FIFO queue ARN from the IAM policy, then `terraform apply`. A live mapping should be removed before, or in the same apply as, the queue it reads from.
