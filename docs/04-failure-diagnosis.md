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

## 18. Add Structured Logging

Follow one poison message through repeated SQS deliveries using small, record-level JSON logs. Each attempt records the SQS `messageId`, the job's `jobId`, and `receiveCount`, so the same message can be recognized when Lambda invokes the handler again.

Prerequisites:

- The Lambda, source queue, DLQ, execution role, and enabled SQS event source mapping in `terraform/main.tf` are deployed. The role has `sqs:ReceiveMessage`, and the mapping uses `ReportBatchItemFailures`.
- The source queue and DLQ are empty, with no other producers or consumers during the experiment.
- AWS CLI credentials can deploy with Terraform, send SQS messages, and read Lambda logs and queue attributes. Run commands from the repository root; Terraform is initialized in `terraform/`.

Relevant files:

- `src/handler-sqs-structured.ts` logs a small JSON object for each record and returns failed message IDs for retry. It does not log the full SQS event or message body.
- `test/handler-sqs-structured.test.ts` checks the fields shared by repeated deliveries of one poison message.
- `src/invoke-sqs-structured.ts` provides a local successful invocation through `npm run invoke:sqs:structured`.
- `package.json` builds this new handler into `dist/handler.js`. Terraform still deploys `handler.handler` from that ZIP; no Terraform configuration changes are needed.

The earlier `src/handler-sqs.ts` and its tests remain available locally. Deploying this new handler changes the SQS logs: the earlier envelope-log example cannot be replayed in AWS until the build entry is switched back and redeployed.

### Build and deploy the logging change

Run local checks, build the ZIP input, and inspect a saved Terraform plan:

```bash
npm run check
npm run invoke:sqs:structured
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-18.tfplan
terraform -chdir=terraform show increment-18.tfplan
```

The local invocation should print one `Image job processed` JSON object containing `level`, `messageId`, `jobId`, `operation`, and `receiveCount`. The plan should update only the Lambda code in place because the bundled handler changed; the queue, DLQ, IAM policy, and event source mapping should remain as deployed. Review the complete plan before applying it:

```bash
terraform -chdir=terraform apply increment-18.tfplan
```

### Trace one failed message

Send a job whose operation the handler rejects:

```bash
aws sqs send-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --message-body '{"jobId":"job-18-poison","imageId":"image-456","operation":"unsupported"}'
```

SQS returns a `MessageId`. Keep it for comparison with the log entries. Follow the Lambda logs until the failed record has appeared on multiple deliveries, then stop the tail with Ctrl-C:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m --follow
```

Each failure log has `level: "error"`, the same `messageId` from the send response, `jobId: "job-18-poison"`, `operation: "unsupported"`, and `errorType: "UnsupportedOperation"`. The `receiveCount` rises on later deliveries, usually from `1` to `2` to `3`; the source queue's visibility timeout is 35 seconds, so retries are separated in time. The handler reports this message ID in `batchItemFailures`, allowing the Lambda invocation to finish normally while SQS retries the failed record.

The `messageId` follows this particular SQS message through retries. The `jobId` is the business identifier in its body; a separately sent message for the same job could have a different `messageId`. Lambda's invocation request ID identifies one invocation, so it changes between retries. These fields answer different correlation questions without logging the entire event.

After the repeated failures have settled, inspect the source queue:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

The source queue should eventually have zero visible and zero in-flight messages. Check the DLQ:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

The DLQ should eventually have one visible message. Queue counts are approximate and can lag; repeat the read if the log history shows the retries but the queue counts have not settled yet.

## 19. Observe Useful Metrics

CloudWatch's built-in Lambda and SQS metrics show activity across the function and queues, without reading individual messages. Send one successful job and one poison job, then compare the resulting counts. The structured handler reports the poison record as a partial batch failure, which makes its retries especially useful for interpreting these metrics.

Prerequisites:

- The Lambda, source queue, DLQ, execution role, and enabled SQS event source mapping in `terraform/main.tf` are deployed. The deployed `dist/handler.js` is built from `src/handler-sqs-structured.ts`; the role can receive SQS messages and the mapping uses `ReportBatchItemFailures`.
- The source queue is empty and no other producer or consumer uses it during this experiment. Existing DLQ messages can remain; note their count before sending new work.
- AWS CLI credentials can send SQS messages and read CloudWatch metrics and SQS queue attributes. Run commands from the repository root on macOS, with Terraform initialized in `terraform/`.

Relevant files: `terraform/outputs.tf` supplies the function and queue names used as metric dimensions. `src/handler-sqs-structured.ts` processes `resize` and reports `unsupported` as a failed record. No infrastructure change or deployment is needed.

### Produce a small, known workload

Set the metric window's start **before** sending. The two-minute margin includes the start of the minute in which SQS accepts the messages; it should exclude older exercises. The `date -v` syntax is for macOS:

```bash
METRIC_REGION="$(terraform -chdir=terraform output -raw aws_region)"
METRIC_FUNCTION="$(terraform -chdir=terraform output -raw lambda_function_name)"
METRIC_QUEUE="$(terraform -chdir=terraform output -raw image_jobs_queue_name)"
METRIC_DLQ="$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_name)"
METRIC_START="$(date -u -v-2M +%Y-%m-%dT%H:%M:%SZ)"
```

Record the current DLQ count:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages
```

Keep this approximate count as a baseline. Send the two jobs to the source queue:

```bash
aws sqs send-message-batch \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries '[
    {"Id":"ok","MessageBody":"{\"jobId\":\"job-19-ok\",\"imageId\":\"image-456\",\"operation\":\"resize\"}"},
    {"Id":"poison","MessageBody":"{\"jobId\":\"job-19-poison\",\"imageId\":\"image-456\",\"operation\":\"unsupported\"}"}
  ]'
```

Both entries should appear under `Successful`, with none under `Failed`. Allow the poison message to be received repeatedly and moved to the DLQ:

```bash
sleep 180
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages
```

The DLQ's approximate visible count should be one above the baseline. If it has not risen, wait and repeat this read before interpreting the metrics. CloudWatch may need another minute or two to publish the recent points.

Set the window's end after the wait:

```bash
METRIC_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

### Read Lambda metrics

Each command names its metric in the result. `ReportedMinutes` is the number of one-minute periods with data; the other field is the value to interpret. This avoids matching unlabeled arrays to names printed by a loop. CloudWatch can return raw points out of time order, so these queries reduce them to one result per metric.

```bash
aws cloudwatch get-metric-statistics \
  --region "$METRIC_REGION" --namespace AWS/Lambda --metric-name Invocations \
  --dimensions "Name=FunctionName,Value=$METRIC_FUNCTION" \
  --start-time "$METRIC_START" --end-time "$METRIC_END" \
  --period 60 --statistics Sum \
  --query '{Invocations:sum(Datapoints[].Sum),ReportedMinutes:length(Datapoints)}' --no-cli-pager
```

For example, `"Invocations": 3` means the handler ran three times during this window; it does not mean three distinct messages. One initial batch and two retries could produce that value. Batch composition can change the exact number.

```bash
aws cloudwatch get-metric-statistics \
  --region "$METRIC_REGION" --namespace AWS/Lambda --metric-name Errors \
  --dimensions "Name=FunctionName,Value=$METRIC_FUNCTION" \
  --start-time "$METRIC_START" --end-time "$METRIC_END" \
  --period 60 --statistics Sum \
  --query '{Errors:sum(Datapoints[].Sum),ReportedMinutes:length(Datapoints)}' --no-cli-pager
```

`"Errors": 0` with `ReportedMinutes` greater than zero means no invocation failed with a function or runtime error. The poison _record_ did fail; the handler returned its message ID in `batchItemFailures`, so Lambda treated the invocation as successful. `ReportedMinutes: 0` instead means CloudWatch returned no samples for this metric in the window.

### Read source-queue metrics

```bash
aws cloudwatch get-metric-statistics \
  --region "$METRIC_REGION" --namespace AWS/SQS --metric-name NumberOfMessagesSent \
  --dimensions "Name=QueueName,Value=$METRIC_QUEUE" \
  --start-time "$METRIC_START" --end-time "$METRIC_END" \
  --period 60 --statistics Sum \
  --query '{MessagesSent:sum(Datapoints[].Sum),ReportedMinutes:length(Datapoints)}' --no-cli-pager
```

`MessagesSent` should be 2: the successful `send-message-batch` call added two messages to the source queue. This is a send count, not the current queue depth.

```bash
aws cloudwatch get-metric-statistics \
  --region "$METRIC_REGION" --namespace AWS/SQS --metric-name NumberOfMessagesReceived \
  --dimensions "Name=QueueName,Value=$METRIC_QUEUE" \
  --start-time "$METRIC_START" --end-time "$METRIC_END" \
  --period 60 --statistics Sum \
  --query '{MessagesReceived:sum(Datapoints[].Sum),ReportedMinutes:length(Datapoints)}' --no-cli-pager
```

`MessagesReceived` should be at least 4: the successful job was received once and the poison job about three times. A receive counts an attempt, so the same SQS message can contribute more than once. SQS is an at-least-once service, so duplicates can make the count higher.

### Check the DLQ

```bash
aws cloudwatch get-metric-statistics \
  --region "$METRIC_REGION" --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions "Name=QueueName,Value=$METRIC_DLQ" \
  --start-time "$METRIC_START" --end-time "$METRIC_END" \
  --period 60 --statistics Maximum \
  --query '{PeakDlqVisible:max(Datapoints[].Maximum),ReportedMinutes:length(Datapoints)}' --no-cli-pager
```

Compare `PeakDlqVisible` with the baseline you recorded. A baseline of `1` and a peak of `2` means one new message reached the DLQ. Automatic redrive does not increment the DLQ's `NumberOfMessagesSent` metric. If `ReportedMinutes` is zero or the peak has not updated, wait a minute or two, refresh `METRIC_END`, and repeat this read.

The five observations describe different stages of this workload: two messages were sent, the source queue recorded more than two receives, Lambda ran, no invocation failed, and one message reached the DLQ. The repeated receives and growing DLQ are consistent with the poison record being returned in `batchItemFailures`. Lambda `Errors` remains zero because the handler invocation completed successfully.

## 20. Add One CloudWatch Alarm

Alarm on the signal that a job has exhausted its retries: at least one visible message in the DLQ. Terraform creates the alarm, a poison job trips it, and clearing the DLQ lets it recover. The alarm has no notification action; you observe its state transitions with the CLI.

Prerequisites:

- The Lambda, source queue, DLQ, execution role, and enabled SQS event source mapping in `terraform/main.tf` are deployed. The deployed `dist/handler.js` is built from `src/handler-sqs-structured.ts`, and the mapping uses `ReportBatchItemFailures`.
- The source queue **and the DLQ** are empty, with no other producer or consumer during the experiment. A leftover DLQ message would put the alarm into `ALARM` as soon as it exists and hide the transition. Inspect the DLQ before deciding whether to purge it; the purge step at the end of this exercise deletes every message in it.
- AWS CLI credentials can apply Terraform, send SQS messages, purge the DLQ, and read CloudWatch alarms. Run commands from the repository root; Terraform is initialized in `terraform/`.

Relevant files: `terraform/main.tf` defines `aws_cloudwatch_metric_alarm.dlq_has_messages`; `terraform/outputs.tf` exposes its name as `dlq_alarm_name`. No application change is needed.

### The alarm, piece by piece

| Setting | Value | Meaning |
| --- | --- | --- |
| Metric | `AWS/SQS` `ApproximateNumberOfMessagesVisible`, dimension `QueueName` = the DLQ | Messages waiting in the DLQ that a consumer could receive. Nothing consumes this queue, so a failed job stays visible. |
| Statistic and period | `Maximum` over 60 seconds | The highest count seen in each one-minute window. |
| Threshold | `GreaterThanThreshold` `0` | Any visible DLQ message breaches. Tuned for a lab where the DLQ is normally empty. |
| Evaluation periods | `1` | One breaching period is enough to enter `ALARM`; one non-breaching period returns it to `OK`. Larger values trade speed for fewer false alarms. |
| Missing data | `notBreaching` | An inactive SQS queue may stop publishing metrics after several hours. Treating missing data as `notBreaching` avoids INSUFFICIENT_DATA during normal inactivity, with the trade-off that an unexpected metrics gap will not trigger the alarm. |

The metric only sees what SQS already counted. Logs show why a record failed, but nobody reads logs continuously: the alarm turns a state that a person would otherwise have to go looking for into something that announces itself. It also catches failures that never log, such as a Lambda that is never invoked and a queue that fills up.

### Review and create the alarm

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-20.tfplan
terraform -chdir=terraform show increment-20.tfplan
```

Expect exactly one addition, `aws_cloudwatch_metric_alarm.dlq_has_messages`, and no change to the queues, Lambda, IAM policy, or mapping. The alarm references the DLQ by name only; SQS does not know about it. Apply the saved plan:

```bash
terraform -chdir=terraform apply increment-20.tfplan
```

CloudWatch standard alarms cost about $0.10 per month each; a lab alarm left running is negligible, and `terraform destroy` removes it.

Read the initial state:

```bash
aws cloudwatch describe-alarms \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --alarm-names "$(terraform -chdir=terraform output -raw dlq_alarm_name)" \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason}' --no-cli-pager
```

A new alarm starts in `INSUFFICIENT_DATA` and moves to `OK` after its first evaluation, usually within a few minutes. Repeat the command until it reports `OK` before sending work.

### Trigger the alarm

```bash
aws sqs send-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --message-body '{"jobId":"job-20-poison","imageId":"image-456","operation":"unsupported"}'
sleep 240
```

The handler reports the record as failed on each delivery. With `maxReceiveCount` 3 and a 35-second visibility timeout, SQS moves it to the DLQ after roughly two minutes. The extra wait covers SQS and CloudWatch metric delay.

```bash
aws cloudwatch describe-alarms \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --alarm-names "$(terraform -chdir=terraform output -raw dlq_alarm_name)" \
  --query 'MetricAlarms[].{State:StateValue,Reason:StateReason,Updated:StateUpdatedTimestamp}' --no-cli-pager
```

Expect `State: ALARM`; the reason names the datapoint that crossed the threshold. If it is still `OK`, wait a minute and repeat: metric publication and evaluation each lag. Lambda `Errors` stays at zero throughout, as in Increment 19, so an alarm on that metric would have missed this failure.

Read the transition history:

```bash
aws cloudwatch describe-alarm-history \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --alarm-name "$(terraform -chdir=terraform output -raw dlq_alarm_name)" \
  --history-item-type StateUpdate --max-items 5 \
  --query 'AlarmHistoryItems[].{Time:Timestamp,Summary:HistorySummary}' --no-cli-pager
```

Expect entries such as `INSUFFICIENT_DATA to OK` and `OK to ALARM`, newest first.

### Clear the condition and watch recovery

Investigate the failed job first if this were real work. For this lab, confirm the DLQ contains only `job-20-poison`, then purge it. Purging permanently deletes all its messages:

```bash
aws sqs purge-queue \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)"
sleep 180
```

Repeat the `describe-alarms` command. Expect `State: OK` again, and a further `ALARM to OK` entry in the history. The alarm recovers only when the underlying condition is gone: it reflects the DLQ's current contents, not whether someone has noticed the failure.

### What to take away

- A metric is a number CloudWatch keeps over time. An alarm is a rule evaluated against it: statistic, period, threshold, and evaluation periods decide when its state changes.
- The alarm and the redrive policy are unrelated resources. The redrive policy moves the message; the alarm only watches the resulting DLQ depth.
- A DLQ alarm answers "did work exhaust its retries?". It does not detect a disabled mapping or missing IAM permission, since no message reaches the DLQ. Queue depth with zero invocations, from Increment 19, would be a separate signal.
- Rollback: remove the alarm resource and its output, then `terraform apply`. Nothing else depends on it.
