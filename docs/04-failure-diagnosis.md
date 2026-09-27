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

## 17. Break IAM Deliberately

Remove only `sqs:ReceiveMessage` from the Lambda execution role's queue policy. This permission lets the Lambda event source mapping poll SQS. Send one valid job, inspect where processing stops, then restore the permission so the waiting job can run.

Prerequisites:

- The Lambda, source queue, DLQ, execution role with its inline SQS policy, and event source mapping in `terraform/main.tf` are deployed. The mapping is enabled and the source queue is empty.
- No other consumer or producer uses the source queue during this experiment. Leave existing DLQ messages untouched.
- AWS CLI credentials can apply Terraform, send SQS messages, inspect IAM policies and the mapping, read queue attributes, and read Lambda logs.
- Run commands from the repository root. Terraform is initialized in `terraform/`.

Relevant files:

- `terraform/variables.tf` defines `grant_sqs_receive_message`, which defaults to `true`.
- `terraform/main.tf` grants the execution role `sqs:DeleteMessage` and `sqs:GetQueueAttributes`, and includes `sqs:ReceiveMessage` only while the variable is true. The deployed handler is `dist/handler.js`, built from `src/handler-sqs.ts`.

### Remove the receive permission

Run local checks, build the existing handler, and review a saved plan:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -var='grant_sqs_receive_message=false' -out=increment-17-deny.tfplan
terraform -chdir=terraform show increment-17-deny.tfplan
```

The local checks should pass. The saved plan should update `aws_iam_role_policy.lambda_sqs` in place, removing only `sqs:ReceiveMessage`; it should leave the queue, Lambda code, and mapping configuration alone.

```bash
terraform -chdir=terraform apply increment-17-deny.tfplan
sleep 120
```

The apply should report one changed resource. The wait should allow IAM policy to propagate.

```bash
aws iam get-role-policy \
  --role-name "$(terraform -chdir=terraform output -raw lambda_function_name)-execution-role" \
  --policy-name "$(terraform -chdir=terraform output -raw lambda_function_name)-sqs-consumer" \
  --query 'PolicyDocument.Statement[].Action'
```

The action list should contain `sqs:DeleteMessage` and `sqs:GetQueueAttributes`, but no `sqs:ReceiveMessage`.

```bash
aws iam simulate-principal-policy \
  --policy-source-arn "$(terraform -chdir=terraform output -raw lambda_execution_role_arn)" \
  --action-names sqs:ReceiveMessage \
  --resource-arns "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision}'
```

Here, `Decision: implicitDeny` means that the role has no permission granting `sqs:ReceiveMessage` on this queue. This is the IAM result; the event source mapping command below will not report it.

### Find where processing stops

Send one valid job:

```bash
aws sqs send-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --message-body '{"jobId":"increment-17-iam","imageId":"image-456","operation":"resize"}'
sleep 60
```

SQS returns a `MessageId` when it accepts the job. The wait gives the poller time to act and the approximate queue count time to settle.

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,Queue:EventSourceArn,Function:FunctionArn}'
```

One mapping with `State: Enabled`, the source queue ARN, and the Lambda function ARN confirms that the connection still exists and is configured to run. Record its UUID for the restoration check. These values can be unchanged after the IAM edit: the mapping output does not report whether SQS authorized a receive request. An empty list would mean no mapping matches this queue and function; `Disabled` would be a separate mapping problem.

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

About one visible message and zero in flight means the job is waiting in SQS. The counts are approximate and can lag.

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 10m
```

There should be no `SQS event received` or `Image job received` entry for `increment-17-iam`; older jobs may still appear in the log window. Together, the IAM denial, waiting message, and missing job-specific log place the failure before the handler. Because the job was not received, it produces no handler error and does not advance toward the DLQ's receive-count threshold.

### Restore the permission and consume the waiting job

```bash
terraform -chdir=terraform plan -out=increment-17-restore.tfplan
terraform -chdir=terraform show increment-17-restore.tfplan
```

The saved plan should add `sqs:ReceiveMessage` to the policy in place. If AWS deactivated the mapping, the plan may also correct its state.

```bash
terraform -chdir=terraform apply increment-17-restore.tfplan
sleep 120
```

The apply should complete the planned changes. The wait gives the restored permission time to propagate.

```bash
aws iam get-role-policy \
  --role-name "$(terraform -chdir=terraform output -raw lambda_function_name)-execution-role" \
  --policy-name "$(terraform -chdir=terraform output -raw lambda_function_name)-sqs-consumer" \
  --query 'PolicyDocument.Statement[].Action'
```

The action list should again contain `sqs:ReceiveMessage`, alongside `sqs:GetQueueAttributes` and `sqs:DeleteMessage`.

Check the role's decision for this queue:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn "$(terraform -chdir=terraform output -raw lambda_execution_role_arn)" \
  --action-names sqs:ReceiveMessage \
  --resource-arns "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision}'
```

`Decision: allowed` shows that the role can again receive from this queue.

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,Queue:EventSourceArn,Function:FunctionArn}'
```

The UUID should match the earlier mapping and its state should be `Enabled`, confirming that the queue-to-function connection remains in place.

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 15m
```

An `Image job received` entry for the waiting job shows that delivery resumed after the permission was restored.

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

After processing settles, the source queue should have zero visible and zero in-flight messages. The role policy controls whether Lambda can receive from SQS; the event source mapping connects the queue to the function; the handler runs only after Lambda receives the message.
