# 03 Batch Processing

Observe several SQS messages delivered to one Lambda invocation and the default failure boundary for that batch.

## 12. Process a Batch

The event source mapping now requests up to three messages and waits up to five seconds to assemble a batch:

```text
SQS messages
     ↓
Lambda batch (up to 3 records)
     ↓
one invocation
```

`src/handler-sqs.ts` iterates through `event.Records` in order and awaits each job explicitly. This sequential loop makes the experiment easy to read; it is not a claim that sequential processing is always the right production choice. The handler returns results to make local tests observable, but the SQS event source mapping only checks whether the Lambda invocation succeeded or failed.

Prerequisites:

- The Lambda, source queue, DLQ, IAM policy, and event source mapping are deployed.
- The source queue and DLQ are empty before each experiment.
- Your AWS CLI credentials can deploy with Terraform, send SQS messages, and read CloudWatch Logs.
- Run all commands from the repository root.

Relevant files:

- `src/handler-sqs.ts` logs the delivery envelope and processes every record.
- `test/handler-sqs.test.ts` covers a successful batch and a batch containing one malformed message.
- `terraform/main.tf` configures a batch size of three and a five-second batching window. The queue visibility timeout consequently changes from 30 to 35 seconds: six times the five-second Lambda timeout, plus that window.

### Build and inspect the change

Run the local checks, build the deployment artifact, and inspect a saved plan:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-12.tfplan
terraform -chdir=terraform show increment-12.tfplan
```

Expect in-place updates to the Lambda code, event source mapping (`BatchSize` from `1` to `3` and batching window from `0` to `5`), and source queue visibility timeout (from `30` to `35`). The DLQ, IAM resources, and queue redrive policy should not be replaced. After reviewing the complete plan, apply exactly that artifact:

```bash
terraform -chdir=terraform apply increment-12.tfplan
```

Confirm the runtime mapping before publishing messages:

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize,Window:MaximumBatchingWindowInSeconds}'
```

Expect one enabled mapping with batch size `3` and window `5`.

### Observe one successful batch

Publish three messages in one SQS API request. `send-message-batch` is an API batch for the producer; it is distinct from the Lambda delivery batch that the event source mapping subsequently assembles.

```bash
aws sqs send-message-batch \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries '[
    {"Id":"one","MessageBody":"{\"jobId\":\"job-1201\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"two","MessageBody":"{\"jobId\":\"job-1202\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"three","MessageBody":"{\"jobId\":\"job-1203\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
  ]'
```

Inspect recent logs after the batching window:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m
```

Expect one `START`/`END`/`REPORT` invocation whose `SQS event received` entry contains three records, followed by one `Image job received` entry per job. SQS and Lambda batch sizes are maximums rather than guarantees, so a standard queue may occasionally yield a smaller delivery despite the batching window.

Verify that all successful messages were acknowledged and removed:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

Both approximate counts should settle at `0`.

### Observe one record failing the batch

Publish a fresh three-message batch whose second body is malformed JSON:

```bash
aws sqs send-message-batch \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries '[
    {"Id":"one","MessageBody":"{\"jobId\":\"job-1211\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"broken","MessageBody":"{broken"},
    {"Id":"three","MessageBody":"{\"jobId\":\"job-1213\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
  ]'
```

Tail the logs again:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m
```

`JSON.parse` throws when the loop reaches the malformed record. Any records processed earlier in that delivery have already performed their application work; records later in the delivery are not reached during that attempt. Because a standard queue does not guarantee ordering, the malformed message is not guaranteed to be the second delivered record. With the default event source mapping behavior, the exception fails the Lambda invocation, so Lambda does not acknowledge any individual record in that delivery. Every message in the batch becomes eligible for redelivery after the 35-second visibility timeout, including any message whose application work already ran. This is the whole-batch failure behavior that Increment 13 examines directly.

The malformed message will cause repeated failures and can eventually reach the DLQ under the source queue's `maxReceiveCount = 3` policy. Valid companions may succeed in a later invocation or may be retried with it because standard queue delivery and subsequent batch composition are not guaranteed. Leave those messages in place until you have captured the retry evidence you want; disabling the mapping or cleaning up messages changes AWS state and is deliberately not automated here.

When you're done, purge both lab queues:

```bash
aws sqs purge-queue \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)"

aws sqs purge-queue \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)"
```

Wait at least 60 seconds, then verify:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

## 13. Understand Whole-Batch Failure

This experiment follows four logical jobs through the default SQS/Lambda failure boundary:

```text
GOOD-1 ─┐
GOOD-2 ─┤
FAIL   ─┼─→ one Lambda invocation ─→ failure
GOOD-3 ─┘                              ↓
                         no records are acknowledged
```

`FAIL` is valid JSON but has an unsupported `operation`. The handler rejects it through its normal image-job validation; there is no special failure branch for that job ID.

Prerequisites:

- An existing deployment contains the Lambda, source queue, DLQ, IAM policy, and enabled event source mapping defined by this repository.
- The source queue and DLQ are empty before the experiment.
- Your AWS CLI credentials can deploy with Terraform, send SQS messages, read queue attributes, and read CloudWatch Logs.
- Run all commands from the repository root.

Relevant files:

- `src/handler-sqs.ts` validates and processes records sequentially, and lets a record failure reject the invocation.
- `test/handler-sqs.test.ts` shows that `GOOD-1` and `GOOD-2` perform their work before `FAIL` throws, while `GOOD-3` is not reached in that local ordering.
- `terraform/main.tf` raises the event-source mapping batch limit from three to four. Partial batch responses remain disabled.

### Build and inspect the change

Run the local checks, build the deployment artifact, and inspect a saved plan:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-13.tfplan
terraform -chdir=terraform show increment-13.tfplan
```

Expect an in-place update to the event source mapping's `BatchSize`, from `3` to `4`. The handler source is unchanged, so rebuilding should leave its code hash unchanged. No queue, Lambda, IAM, or DLQ resource should be replaced. After reviewing the complete plan, apply exactly that artifact:

```bash
terraform -chdir=terraform apply increment-13.tfplan
```

Confirm that the deployed mapping has the intended failure semantics:

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize,Window:MaximumBatchingWindowInSeconds,ResponseTypes:FunctionResponseTypes}'
```

Expect one enabled mapping with batch size `4`, window `5`, and no response types. In particular, `ReportBatchItemFailures` must not appear; that belongs to Increment 14.

### Publish the four jobs

Send all four messages in one producer API call:

```bash
aws sqs send-message-batch \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries '[
    {"Id":"good-1","MessageBody":"{\"jobId\":\"GOOD-1\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"good-2","MessageBody":"{\"jobId\":\"GOOD-2\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"fail","MessageBody":"{\"jobId\":\"FAIL\",\"imageId\":\"image-456\",\"operation\":\"unsupported\"}"},
    {"Id":"good-3","MessageBody":"{\"jobId\":\"GOOD-3\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
  ]'
```

The producer batch is not a delivery-order guarantee. Confirm the actual record order in the first `SQS event received` log rather than assuming the order above:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m
```

Ideally, the envelope contains all four records. Batch size is a maximum, so Lambda may receive fewer; if that prevents the intended observation, repeat with a fresh set of job IDs after the source queue has settled. For a four-record delivery, expect `Image job received` entries only for valid jobs that occur before `FAIL` in the logged record order, followed by an invocation error. Records after `FAIL` have not yet performed application work.

### Observe the retry

Immediately after the failure, the delivery remains in flight rather than being deleted:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

After at least the 35-second visibility timeout, inspect the logs again:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 10m
```

Example (possible variation)

| Receive | Delivered records | Application processing | Result |
| --- | --- | --- | --- |
| 1 | `FAIL`, `GOOD-3`, `GOOD-1`, `GOOD-2` | None | `FAIL` is first and immediately throws |
| 2a | `GOOD-2` | `GOOD-2` | Success; deleted |
| 2b | `GOOD-1`, `FAIL`, `GOOD-3` | `GOOD-1` | Failure; all three become eligible again |
| 3a | `GOOD-3`, `GOOD-1` | Both | Success; deleted |
| 3b | `FAIL` | None | Failure; eventually DLQ |

In a retry envelope, `ApproximateReceiveCount` is greater than `1`. A valid job logged as processed before the first failure can be logged again: its work succeeded, but the Lambda invocation did not, so the event source mapping did not acknowledge any record in that delivery.

SQS standard queues provide at-least-once delivery, and whole-batch failure adds another clear duplicate path. A production consumer therefore normally makes the side effect idempotent, often by recording the logical operation key (for example, `jobId`) and treating a repeat as already completed. This lab does not add an idempotency store because doing so would hide the duplicate behavior being studied.

`FAIL` is a poison message: retrying the unchanged body cannot make validation succeed. With `maxReceiveCount = 3`, it can eventually move to the DLQ. Its valid batch companions can also be retried, can later succeed in a different batch, or can reach the DLQ with it. Standard queues do not promise the same ordering or batch composition on each receive, so the exact grouping is an observation, not a guarantee.

After the retry evidence is visible, inspect both queues:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

Leave the messages in place until you have finished comparing their log histories and receive counts. Increment 14 will change the acknowledgement contract so successfully processed records can be removed independently.

## 14. Add Partial Batch Responses

This experiment repeats the same four-job batch after changing the contract between the handler and the event source mapping:

```text
GOOD-1 ─→ processed ─┐
GOOD-2 ─→ processed ─┤
FAIL   ─→ reported  ─┼─→ { batchItemFailures: [{ itemIdentifier: FAIL message ID }] }
GOOD-3 ─→ processed ─┘
```

The Lambda invocation now completes successfully even though one record failed. Its return value tells the event source mapping which individual SQS message must become visible again. The other messages can be acknowledged and deleted.

Prerequisites: same as in previous step.

Relevant files:

- `src/handler-sqs.ts` catches each record's error, logs it, continues processing, and returns failed message IDs in `batchItemFailures`.
- `test/handler-sqs.test.ts` verifies that `GOOD-3` is processed after `FAIL` and only `FAIL` is reported for retry.
- `terraform/main.tf` enables `ReportBatchItemFailures` on the event source mapping.

### Build and inspect the change

Run the local checks, build the deployment artifact, and inspect a saved plan:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-14.tfplan
terraform -chdir=terraform show increment-14.tfplan
```

Expect in-place updates to the Lambda code and event source mapping. The mapping gains `ReportBatchItemFailures` in `FunctionResponseTypes`; its batch size and batching window remain unchanged. No queue, Lambda, IAM, or DLQ resource should be replaced. After reviewing the complete plan, apply exactly that artifact:

```bash
terraform -chdir=terraform apply increment-14.tfplan
```

Confirm both sides of the deployed contract before publishing messages:

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize,Window:MaximumBatchingWindowInSeconds,ResponseTypes:FunctionResponseTypes}'
```

Expect one enabled mapping with batch size `4`, window `5`, and `ResponseTypes` containing `ReportBatchItemFailures`.

The configuration and handler response are both necessary. If the handler returns `batchItemFailures` without enabling `ReportBatchItemFailures`, the mapping ignores that structure and treats the successful invocation as a fully successful batch. If the mapping is enabled but the handler throws, the invocation still fails as a whole and every message in that delivery becomes eligible for retry.

### Repeat the four-job delivery

Send the same logical jobs as Increment 13:

```bash
aws sqs send-message-batch \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries '[
    {"Id":"good-1","MessageBody":"{\"jobId\":\"GOOD-1\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"good-2","MessageBody":"{\"jobId\":\"GOOD-2\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"fail","MessageBody":"{\"jobId\":\"FAIL\",\"imageId\":\"image-456\",\"operation\":\"unsupported\"}"},
    {"Id":"good-3","MessageBody":"{\"jobId\":\"GOOD-3\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
  ]'
```

Inspect the first invocation:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m
```

Confirm the actual delivery from the `SQS event received` entry because a batch size of four is a maximum and a standard queue does not guarantee order. When all four arrive together, expect an `Image job received` entry for every valid job, including valid jobs after `FAIL` in the delivery order. Expect one `SQS record failed` error log containing `FAIL`'s SQS message ID. Unlike Increment 13, the invocation has normal `END` and `REPORT` entries without a platform `Invoke Error`: the record-level error was converted into a successful partial batch response rather than thrown from the handler.

### Observe only the failed message retry

After at least the 35-second visibility timeout, inspect the logs again:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 10m
```

Example (possible variation)

| Receive | Delivered records | Application processing | Result |
| --- | --- | --- | --- |
| 1a | `GOOD-1` | `GOOD-1` | Success; empty failure list; deleted |
| 1b | `FAIL`, `GOOD-3`, `GOOD-2` | `GOOD-3`, `GOOD-2` | Success; only `FAIL` reported; valid messages deleted |
| 2 | `FAIL` | None | Success; `FAIL` reported again |
| 3 | `FAIL` | None | Success; `FAIL` reported again and eventually moved to the DLQ |

In this example, Lambda split the messages' first delivery across two concurrent invocations even though the configured maximum batch size was four. The second invocation logged a record-level `ERROR` for `FAIL`, continued with `GOOD-3` and `GOOD-2`, and ended normally without a platform `Invoke Error`. On later receives, only the same `FAIL` message ID returned, with `ApproximateReceiveCount` increasing from `1` to `2` and then `3`.

Expect a later envelope containing only `FAIL`, with the same `messageId` and an `ApproximateReceiveCount` greater than `1`. The valid message IDs should not appear in a retry caused by this record-level failure. Because `FAIL` remains a poison message and `maxReceiveCount = 3`, it can eventually move to the DLQ.

Verify that the source queue has settled and inspect the DLQ:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

The expected final state is an empty source queue and one visible `FAIL` message in the DLQ. Queue counts are approximate and can lag briefly.

### Compare the acknowledgement boundaries

| Behavior | Increment 13: thrown error | Increment 14: partial response |
| --- | --- | --- |
| Lambda invocation | Failed | Successful |
| Valid records before `FAIL` | Work may run; message is retried | Work runs; message is acknowledged |
| Valid records after `FAIL` | Not reached by the sequential loop | Processed and acknowledged |
| `FAIL` | Retried | Retried |
| Required mapping response type | None | `ReportBatchItemFailures` |

Partial batch responses remove the deterministic whole-batch duplicate path, but they do not change SQS's at-least-once delivery model. A message can still be delivered more than once, so real side effects should still be idempotent. This increment deliberately keeps the implementation explicit and does not introduce AWS Lambda Powertools or an idempotency store.
