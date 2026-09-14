# 03 Batch Processing

Observe several SQS messages delivered to one Lambda invocation and the default
failure boundary for that batch.

## 12. Process a Batch

The event source mapping now requests up to three messages and waits up to five
seconds to assemble a batch:

```text
SQS messages
     ↓
Lambda batch (up to 3 records)
     ↓
one invocation
```

`src/handler-sqs.ts` iterates through `event.Records` in order and awaits each
job explicitly. This sequential loop makes the experiment easy to read; it is
not a claim that sequential processing is always the right production choice.
The handler returns results to make local tests observable, but the SQS event
source mapping only checks whether the Lambda invocation succeeded or failed.

Prerequisites:

- The Lambda, source queue, DLQ, IAM policy, and event source mapping are
  deployed.
- The source queue and DLQ are empty before each experiment.
- Your AWS CLI credentials can deploy with Terraform, send SQS messages, and
  read CloudWatch Logs.
- Run all commands from the repository root.

Relevant files:

- `src/handler-sqs.ts` logs the delivery envelope and processes every record.
- `test/handler-sqs.test.ts` covers a successful batch and a batch containing
  one malformed message.
- `terraform/main.tf` configures a batch size of three and a five-second
  batching window. The queue visibility timeout consequently changes from 30
  to 35 seconds: six times the five-second Lambda timeout, plus that window.

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

Expect in-place updates to the Lambda code, event source mapping (`BatchSize`
from `1` to `3` and batching window from `0` to `5`), and source queue
visibility timeout (from `30` to `35`). The DLQ, IAM resources, and queue
redrive policy should not be replaced. After reviewing the complete plan,
apply exactly that artifact:

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

Publish three messages in one SQS API request. `send-message-batch` is an API
batch for the producer; it is distinct from the Lambda delivery batch that the
event source mapping subsequently assembles.

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

Expect one `START`/`END`/`REPORT` invocation whose `SQS event received` entry
contains three records, followed by one `Image job received` entry per job.
SQS and Lambda batch sizes are maximums rather than guarantees, so a standard
queue may occasionally yield a smaller delivery despite the batching window.

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

`JSON.parse` throws when the loop reaches the malformed record. Any records
processed earlier in that delivery have already performed their application
work; records later in the delivery are not reached during that attempt.
Because a standard queue does not guarantee ordering, the malformed message is
not guaranteed to be the second delivered record. With the default event
source mapping behavior, the exception fails the Lambda invocation, so Lambda
does not acknowledge any individual record in that delivery. Every message in
the batch becomes eligible for redelivery after the 35-second visibility
timeout, including any message whose application work already ran. This is the
whole-batch failure behavior that Increment 13 examines directly.

The malformed message will cause repeated failures and can eventually reach
the DLQ under the source queue's `maxReceiveCount = 3` policy. Valid companions
may succeed in a later invocation or may be retried with it because standard
queue delivery and subsequent batch composition are not guaranteed. Leave
those messages in place until you have captured the retry evidence you want;
disabling the mapping or cleaning up messages changes AWS state and is
deliberately not automated here.
