# 04 Failure Diagnosis and Observability

## 15. Terraform Change → Runtime Consequence

| Terraform change | AWS resource affected | Runtime consequence | How to verify |
| --- | --- | --- | --- |
| Change `sqs_batch_size` | Lambda event source mapping; updated in place | Changes the maximum number of SQS records passed to one Lambda invocation. It does not guarantee that Lambda will wait for or deliver that many records. | Inspect the Terraform plan; query `BatchSize` with `aws lambda list-event-source-mappings`; compare the number of records in `SQS event received` logs. |
| Change `sqs_visibility_timeout_seconds` | Source SQS queue; updated in place | Changes how long received messages remain hidden. After a failed invocation, messages cannot be received again until this timeout expires. A timeout that is too short can make a message visible while its previous invocation is still running. | Inspect the Terraform plan; query `VisibilityTimeout` with `aws sqs get-queue-attributes`; compare failure and redelivery timestamps and `ApproximateReceiveCount` in the Lambda logs. |
| Change `lambda_timeout_seconds` | Lambda function; updated in place. In this repository, the derived source-queue visibility timeout also updates the SQS queue in place. | Changes the maximum invocation duration. The repository recalculates visibility as six times the Lambda timeout plus the batching window, preserving the intended relationship between processing and redelivery. | Inspect both resources in the Terraform plan; query `Timeout` with `aws lambda get-function-configuration`; query `VisibilityTimeout` with `aws sqs get-queue-attributes`; invoke work that exceeds the old or new limit. |
| Change `sqs_max_receive_count` | Source SQS queue redrive policy; updated in place | Changes how many times an individual message can be received before SQS moves it to the DLQ. The count belongs to each message, not to a Lambda batch. | Inspect the Terraform plan; query `RedrivePolicy` with `aws sqs get-queue-attributes`; follow one poison message's `ApproximateReceiveCount`; inspect the DLQ. |
| Change the event source mapping `enabled` value | Lambda event source mapping; updated in place | When disabled, messages accumulate in SQS and do not invoke this Lambda through the mapping. Re-enabling it allows polling and consumption to resume. | Inspect the Terraform plan; query `State` with `aws lambda list-event-source-mappings`; compare source-queue depth with Lambda logs before and after the change. |

## 16. Break the Event Source Mapping

Pause the SQS event source mapping while leaving the queue, Lambda, and handler deployed. A valid job should wait in SQS without producing an invocation. Restoring the mapping should consume that same job.

Prerequisites:

- The Lambda, source queue, DLQ, IAM policy, and event source mapping in `terraform/main.tf` are deployed in the configured AWS region.
- The source queue is empty and has no other consumers or producers during this experiment. Leave any messages already in the DLQ untouched.
- AWS CLI credentials can apply Terraform, send SQS messages, inspect the mapping and queue, and read Lambda logs.
- Run the commands from the repository root. Terraform has been initialized in `terraform/`.

Relevant files:

- `terraform/variables.tf` defines `sqs_mapping_enabled`, which defaults to `true`.
- `terraform/main.tf` uses that variable for the existing event source mapping's `enabled` setting. The deployed handler remains `dist/handler.js`, built from `src/handler-sqs.ts`.

### Disable polling

Build the existing handler, run local checks, and review a plan with the mapping disabled:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -var='sqs_mapping_enabled=false' -out=increment-16-disable.tfplan
terraform -chdir=terraform show increment-16-disable.tfplan
```

Expect an in-place update of `aws_lambda_event_source_mapping.image_jobs` from `enabled = true` to `false`, with no queue, Lambda, or IAM replacement. Review the complete plan before applying the saved artifact:

```bash
terraform -chdir=terraform apply increment-16-disable.tfplan

aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,Source:EventSourceArn}'
```

Wait until the mapping reports `Disabled` before publishing. `Disabling` is a transition state; an invocation already in flight may finish during that transition. Disabling this mapping pauses the SQS examples that use it until the mapping is restored.

### Observe messages waiting without an invocation

Send two valid jobs to the source queue:

```bash
aws sqs send-message-batch \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries '[
    {"Id":"one","MessageBody":"{\"jobId\":\"increment-16-one\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"two","MessageBody":"{\"jobId\":\"increment-16-two\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"}
  ]'

aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m
```

Expect approximately two visible messages and zero in flight. The logs should have no `SQS event received` or `Image job received` entry for `increment-16-one` or `increment-16-two` while the mapping is `Disabled`. Older invocations can still appear in the log window. Queue counts are approximate and can lag, so repeat the attribute query if needed. Do not receive or delete these messages manually: they are the work to observe after restoring polling.

### Restore polling and observe consumption

Plan again with the default `true` value and review the change before applying it:

```bash
terraform -chdir=terraform plan -out=increment-16-enable.tfplan
terraform -chdir=terraform show increment-16-enable.tfplan
terraform -chdir=terraform apply increment-16-enable.tfplan

aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,Source:EventSourceArn}'
```

Expect the same mapping UUID and an eventual `Enabled` state. Once enabled, inspect the logs and source queue:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 10m

aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

Expect both job IDs in `Image job received` entries and, after processing settles, zero visible and zero in-flight source messages. The jobs may arrive in one batch or separate invocations. A disabled mapping explains the earlier lack of invocations; the handler could only run after Lambda resumed polling the queue.
