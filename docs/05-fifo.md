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

There is no `redrive_policy`, so a message that is received but never deleted stays in this queue. Failures come in Increment 22.

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
