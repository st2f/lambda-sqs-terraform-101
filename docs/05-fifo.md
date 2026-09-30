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

## 23. FIFO + Partial Batch Failure

Send three messages, `A`, `B`, `C`, to one message group in a single batch, with `B` poisoned. Run it twice and compare the two outcomes: with the structured handler, only `B` leaves the group; with a FIFO-aware handler, `B` and `C` stay together.

Prerequisites:

- The resources from Increment 22 are deployed, with the FIFO mapping `Enabled` and `ReportBatchItemFailures` set. The FIFO queue and FIFO DLQ are empty; purge the DLQ if Increment 22 left `B` in it.
- The currently deployed handler is the structured one from `src/handler-sqs-structured.ts`.
- AWS CLI credentials can apply Terraform, send SQS messages, purge the FIFO DLQ, and read Lambda logs. Run commands from the repository root; Terraform is initialized in `terraform/`.

Relevant files:

- `terraform/main.tf` sets the FIFO mapping's batch size from `local.sqs_fifo_batch_size`, now 3 instead of 1.
- `src/handler-sqs-fifo.ts` processes records in order and, at the first failure, reports that record and every later record in `batchItemFailures`. It logs the later records as `Image job not attempted`.
- `test/handler-sqs-fifo.test.ts` checks that a failure reports the failed and later records, never earlier ones, and does not process later records. `npm run invoke:sqs:fifo` runs one local delivery.
- `package.json` adds `build:fifo`. `npm run build` still bundles the structured handler, so earlier exercises keep their meaning.

### Two outcomes

With `ReportBatchItemFailures`, Lambda deletes every record in the batch that is not listed in `batchItemFailures`. What the handler lists decides what stays in the group:

```text
Structured handler            FIFO handler
A  ok      -> deleted         A  ok             -> deleted
B  failed  -> retried alone   B  failed         -> retried
C  ok      -> deleted         C  not attempted  -> retried with B
```

AWS's guidance for FIFO is the right-hand column: stop at the first failure and report the failed and all unprocessed records.

### Outcome 1: the structured handler

Keep the structured handler's behavior, and change the mapping:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-23-batch.tfplan
terraform -chdir=terraform show increment-23-batch.tfplan
```

Expect two in-place updates and no replacement or destroy:

- `aws_lambda_event_source_mapping.image_jobs_fifo`, with `batch_size` going from `1` to `3`. This is the change the exercise is about.
- `aws_lambda_function.image_processor`, with only `source_code_hash` changing

```bash
terraform -chdir=terraform apply increment-23-batch.tfplan

aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_arn)" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize}'
```

Define a helper that sends `A`, `B`, `C` to `customer-1` in one `send-message-batch` call, so they are more likely to arrive in one invocation. `B` carries an operation the handler rejects:

```bash
FIFO_REGION="$(terraform -chdir=terraform output -raw aws_region)"
FIFO_URL="$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_url)"
FIFO_DLQ_URL="$(terraform -chdir=terraform output -raw image_jobs_fifo_dead_letter_queue_url)"
LOG_GROUP="$(terraform -chdir=terraform output -raw lambda_log_group_name)"

send_abc() {
  local entries
  entries="$(mktemp)"
  cat > "$entries" <<JSON
[
  {"Id":"a","MessageGroupId":"customer-1","MessageDeduplicationId":"$1-A","MessageBody":"{\"jobId\":\"$1-A\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
  {"Id":"b","MessageGroupId":"customer-1","MessageDeduplicationId":"$1-B","MessageBody":"{\"jobId\":\"$1-B\",\"imageId\":\"image-456\",\"operation\":\"unsupported\"}"},
  {"Id":"c","MessageGroupId":"customer-1","MessageDeduplicationId":"$1-C","MessageBody":"{\"jobId\":\"$1-C\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
]
JSON
  aws sqs send-message-batch --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
    --entries "file://$entries" \
    --query 'Successful[].{Id:Id,MessageId:MessageId,Sequence:SequenceNumber}'
  rm "$entries"
}

send_abc job-23-structured
sleep 180
aws logs tail "$LOG_GROUP" --region "$FIFO_REGION" --since 10m \
  --format short --filter-pattern '"job-23-structured"'
```

Only `B` left the group; `A` and `C` were deleted as soon as the first invocation returned.

```text
A  processed
B  failed x3 -> moved out of the group to the DLQ
C  processed
```

Check the DLQ and purge it before the next step:

```bash
aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_DLQ_URL" \
  --max-number-of-messages 10 --visibility-timeout 0 \
  --query 'Messages[].Body'
aws sqs purge-queue --region "$FIFO_REGION" --queue-url "$FIFO_DLQ_URL"
```

Expect only `job-23-structured-B` in the DLQ. SQS allows one purge per queue every 60 seconds, so wait that long before purging this DLQ again.

### Outcome 2: the FIFO handler

```bash
npm run invoke:sqs:fifo
npm run build:fifo
terraform -chdir=terraform plan -out=increment-23-handler.tfplan
terraform -chdir=terraform show increment-23-handler.tfplan
terraform -chdir=terraform apply increment-23-handler.tfplan
```

The local invocation should print one `Image job processed` JSON object. The plan should update only the Lambda function's code in place, with no change to the queues, IAM policy, or mappings. Send the same three messages with a new prefix:

```bash
send_abc job-23-fifo
sleep 180
aws logs tail "$LOG_GROUP" --region "$FIFO_REGION" --since 10m \
  --format short --filter-pattern '"job-23-fifo"'
```

Expect:

```text
A  processed
B  failed on every delivery
C  not attempted, returned to the queue with B
```

Check the receive counts and the DLQ:

```bash
aws sqs get-queue-attributes --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs receive-message --region "$FIFO_REGION" --queue-url "$FIFO_DLQ_URL" \
  --max-number-of-messages 10 --visibility-timeout 0 \
  --message-system-attribute-names MessageGroupId \
  --query 'Messages[].{Group:Attributes.MessageGroupId,Body:Body,MessageId:MessageId}'
```

Expect B and C in the DLQ:

```txt
[
    {
        "Group": "customer-1",
        "Body": "{\"jobId\":\"job-23-fifo-B\",\"imageId\":\"image-456\",\"operation\":\"unsupported\"}",
        "MessageId": "4bf0..."
    },
    {
        "Group": "customer-1",
        "Body": "{\"jobId\":\"job-23-fifo-C\",\"imageId\":\"image-456\",\"operation\":\"resize\"}",
        "MessageId": "e9f..."
    }
]
```

Purge the DLQ afterwards:

```bash
aws sqs purge-queue --region "$FIFO_REGION" --queue-url "$FIFO_DLQ_URL"
```

### What to take away

- **Partial batch responses are a deletion list.** Records you do not report are deleted, so what you report decides what stays in the group.
- **Structured handler:** only the failed record leaves the group; later records in the batch are already done.
- **FIFO handler:** the failed record and everything after it stay in the group and are retried together.
- **Unprocessed records are not free.** They are received again with the failed record, so their receive counts rise with it and `maxReceiveCount` can affect messages that never failed.
- **Batch size:** with batch size 1, as in Increment 22, there are no later records, so the two handlers behave the same.

## 24. Observe FIFO Concurrency

Give successful jobs a three-second processing delay, then send work to two message groups. The delay is intentionally inefficient: it creates a wide enough interval to see that different groups can overlap while messages within one group remain ordered.

Prerequisites:

- The FIFO queue and mapping from Increment 23 are deployed and the FIFO queue and DLQ are empty.
- The FIFO-aware handler is the intended deployed handler. The standard queue should be idle because both mappings invoke the same Lambda function.
- AWS CLI credentials can apply Terraform, send SQS messages, and read Lambda logs. Run commands from the repository root; Terraform is initialized in `terraform/`.

Relevant changes:

- `src/handler-sqs-fifo.ts` logs `Image job started` and `Image job processed` with an ISO timestamp and `MessageGroupId`, with a three-second delay between them. The delay is application behavior for this experiment, not a Lambda or SQS setting.
- `terraform/main.tf` returns the FIFO mapping's batch size from three to one. One message per invocation makes the concurrency boundary unambiguous: overlapping start/finish intervals belong to separate Lambda invocations, not to records in one batch.
- `test/handler-sqs-fifo.test.ts` injects a zero-delay or fake wait, so local tests verify the behavior without becoming slow.

No reserved concurrency, maximum concurrency, or other scaling control is added. This increment observes the default behavior rather than tuning it.

### Build and inspect the change

Run the local checks and build the FIFO-aware handler:

```bash
npm run check
npm run invoke:sqs:fifo
npm run build:fifo
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-24.tfplan
terraform -chdir=terraform show increment-24.tfplan
```

The local invocation uses a 100 ms delay so it remains quick, but its two JSON log entries show the fields that the deployed three-second experiment uses. Expect two in-place updates in the Terraform plan:

- `aws_lambda_event_source_mapping.image_jobs_fifo` changes `batch_size` from `3` to `1`;
- `aws_lambda_function.image_processor` changes `source_code_hash` for the new handler code.

There should be no queue, IAM, or event-source-mapping replacement. Apply the reviewed plan, then verify the deployed batch size:

```bash
terraform -chdir=terraform apply increment-24.tfplan

aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_arn)" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize}'
```

Wait for `State` to be `Enabled` and confirm `BatchSize` is `1`.

### Send two ordered streams

Send `A`, `B` for `customer-1` and `X`, `Y` for `customer-2` in one API call. The run ID avoids FIFO's five-minute deduplication window if the experiment is repeated:

```bash
FIFO_REGION="$(terraform -chdir=terraform output -raw aws_region)"
FIFO_URL="$(terraform -chdir=terraform output -raw image_jobs_fifo_queue_url)"
LOG_GROUP="$(terraform -chdir=terraform output -raw lambda_log_group_name)"
RUN_ID="job-24-$(date +%s)"
ENTRIES_FILE="$(mktemp)"

cat > "$ENTRIES_FILE" <<JSON
[
  {"Id":"a","MessageGroupId":"customer-1","MessageDeduplicationId":"$RUN_ID-a","MessageBody":"{\"jobId\":\"$RUN_ID-customer-1-A\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
  {"Id":"x","MessageGroupId":"customer-2","MessageDeduplicationId":"$RUN_ID-x","MessageBody":"{\"jobId\":\"$RUN_ID-customer-2-X\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
  {"Id":"b","MessageGroupId":"customer-1","MessageDeduplicationId":"$RUN_ID-b","MessageBody":"{\"jobId\":\"$RUN_ID-customer-1-B\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
  {"Id":"y","MessageGroupId":"customer-2","MessageDeduplicationId":"$RUN_ID-y","MessageBody":"{\"jobId\":\"$RUN_ID-customer-2-Y\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
]
JSON

aws sqs send-message-batch --region "$FIFO_REGION" --queue-url "$FIFO_URL" \
  --entries "file://$ENTRIES_FILE" \
  --query 'Successful[].{Id:Id,MessageId:MessageId,Sequence:SequenceNumber}'
rm "$ENTRIES_FILE"
```

All four entries should succeed. Their global display order is not the ordering guarantee; compare sequence and processing only within each message group.

### Observe the overlap and the ordering boundary

Allow the four jobs to finish, then filter the shared log group by this run's unique prefix:

```bash
sleep 15
aws logs tail "$LOG_GROUP" --region "$FIFO_REGION" --since 5m \
  --format short --filter-pattern "\"$RUN_ID\""
```

Each job has a start and processed entry. Use the embedded `timestamp`, `messageGroupId`, and `jobId` to compare the intervals. A typical result has this shape (the two groups can exchange places):

```text
customer-1 A  started   12:00:00
customer-2 X  started   12:00:00
customer-1 A  processed 12:00:03
customer-2 X  processed 12:00:03
customer-1 B  started   12:00:03
customer-2 Y  started   12:00:03
customer-1 B  processed 12:00:06
customer-2 Y  processed 12:00:06
```

The evidence to look for is two different things:

- **Across groups:** an `A`/`X` start occurs before the other group's corresponding `processed` entry. Their three-second intervals overlap, so separate Lambda invocations were in progress concurrently.
- **Within a group:** `B` does not start before `A` is processed, and `Y` does not start before `X` is processed. SQS does not make a later message in a group available while an earlier message from that group is in flight.

```text
customer-1: A ─────────→ B ─────────→
customer-2:   X ─────────→ Y ─────────→
              ↑ overlap    ↑ overlap
```

Exact cross-group order and timestamps are nondeterministic. If the intervals do not overlap, that single run proves only that concurrency was possible but not used; confirm the mapping is enabled, the function has no account-level concurrency constraint, and repeat with a fresh `RUN_ID`.

### What to take away

- **Lambda concurrency** means more than one invocation of the function can be in progress at once. It is not parallel execution of records inside one JavaScript handler invocation.
- **The event source mapping** polls SQS and decides when batches become Lambda invocations. With batch size one here, every observed processing interval is one invocation.
- **FIFO constrains each message group.** At most one Lambda invocation can process messages from a given group at a time, preserving that group's order. Different groups are independent and can supply concurrent work.
- **Ordering and concurrency are related, not opposites.** Choosing one global group serializes all work; choosing meaningful independent groups preserves order where needed while allowing overlap elsewhere. More groups only create the opportunity for concurrency—available messages, Lambda capacity, and event-source-mapping scaling still determine what happens at a particular moment.
