# 06 Terraform Versus Runtime

## 25. Terraform State and Runtime State

Answer two different questions about the standard source queue and its event source mapping:

- **What does Terraform believe exists?**
- **What is actually happening at runtime?**

Then show that a clean `terraform validate` and a `No changes` plan can coexist with a consumer that fails every batch.

The failure is already deployed. Increment 24 deployed the FIFO-aware handler, which spends three seconds on every successful job. The FIFO mapping delivers one record per invocation, so that fit inside the five-second Lambda timeout. The standard queue's mapping still delivers up to four records per invocation, and the same function processes them one after another. Every resource matches its configuration; only the combination is wrong.

Prerequisites:

- The infrastructure and handler from Increment 24 are deployed. `dist/handler.js` is still the `npm run build:fifo` output. Do not rebuild it before this exercise; another build would make the plan show a code change.
- The standard source queue is empty and nothing else sends to it during the exercise. Existing messages in the standard DLQ can stay; you will note their count first.
- AWS CLI credentials can run `terraform plan`, read Lambda, SQS, CloudWatch Logs, and CloudWatch metrics, and send SQS messages. Run commands from the repository root on macOS, with Terraform initialized in `terraform/`.

Relevant files: none change. `terraform/main.tf` defines `aws_sqs_queue.image_jobs`, `aws_lambda_event_source_mapping.image_jobs`, and the Lambda timeout. `terraform/terraform.tfstate` is Terraform's local record of what it created; it is gitignored.

### Four views of the same resources

| View | Where it lives | What it answers |
| --- | --- | --- |
| Terraform configuration | `terraform/*.tf` | What you **want** to exist. Values can be expressions, such as `6 * local.lambda_timeout_seconds + local.sqs_batching_window_seconds`. |
| Terraform state | `terraform/terraform.tfstate` | What Terraform **recorded** after its last apply or refresh. Each resource address maps to a real AWS ID, with resolved attribute values. |
| AWS resource configuration | AWS control-plane APIs (`get-queue-attributes`, `list-event-source-mappings`) | How the resource is **configured now**. |
| Runtime observations | CloudWatch Logs, CloudWatch metrics, queue counts | What the system **did** with real messages. |

Terraform reconciles the first three views. It has no knowledge of the fourth.

### 1. Read the configuration

Find these values in `terraform/main.tf` and work out the resolved numbers yourself:

- source queue `visibility_timeout_seconds` and `redrive_policy.maxReceiveCount`;
- mapping `batch_size`, `maximum_batching_window_in_seconds`, `function_response_types`, and `enabled`;
- Lambda `timeout`.

The configuration does not contain the queue URL or the mapping UUID. AWS assigns those when it creates a resource, and only the state records them.

### 2. Ask Terraform what it believes

```bash
terraform -chdir=terraform state list
terraform -chdir=terraform state show aws_sqs_queue.image_jobs
terraform -chdir=terraform state show aws_lambda_event_source_mapping.image_jobs
```

`state list` prints resource **addresses**, which is how Terraform identifies resources, alongside the `data.*` sources it read. `state show` prints the attributes recorded for one address. Neither command contacts AWS: you are reading a local file, which may be out of date.

In the output, find:

- `id`, the real AWS identity behind each address. For the queue it is the URL; for the mapping it is the UUID.
- the resolved values of the settings from step 1. Compare them with your arithmetic.
- the mapping's `state` and `last_processing_result`. These are AWS-reported status fields, not settings you configure. Terraform stores whatever AWS returned when it last read the resource.

### 3. Ask AWS what is configured now

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names VisibilityTimeout RedrivePolicy ApproximateNumberOfMessages

aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,BatchSize:BatchSize,Window:MaximumBatchingWindowInSeconds,ResponseTypes:FunctionResponseTypes,LastProcessingResult:LastProcessingResult}'

aws lambda get-function-configuration \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --query '{Timeout:Timeout,CodeSha256:CodeSha256}'
```

Check that the UUID matches the mapping's `id` in the state, then compare each value with steps 1 and 2. Also compare `CodeSha256` with `terraform -chdir=terraform output -raw lambda_source_code_hash`. That hash is all Terraform knows about the code: it identifies a ZIP file, not which handler is inside it or what that handler does.

Record the standard DLQ count as a baseline:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names ApproximateNumberOfMessages
```

### 4. Get Terraform's verdict

```bash
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan
```

Expect `Success! The configuration is valid.` and then `No changes. Your infrastructure matches the configuration.`

- `validate` checks the configuration only: syntax, types, references, and required arguments. It reads neither the state nor AWS.
- `plan` refreshes the state from the AWS APIs and compares the result with the configuration. `No changes` means the three views agree. It does not mean that the configured system works.

Before continuing, predict from what you have read so far: what happens when three valid `resize` jobs reach the standard queue at once?

### 5. Observe runtime behavior

Set the metric window's start, then send three valid jobs in one call. You do not control how the event source mapping groups them into batches; it can deliver them together or split them across invocations:

```bash
RT_REGION="$(terraform -chdir=terraform output -raw aws_region)"
RT_FUNCTION="$(terraform -chdir=terraform output -raw lambda_function_name)"
RT_LOG_GROUP="$(terraform -chdir=terraform output -raw lambda_log_group_name)"
RT_RUN="job-25-$(date +%s)"
RT_START="$(date -u -v-2M +%Y-%m-%dT%H:%M:%SZ)"

aws sqs send-message-batch --region "$RT_REGION" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --entries "[
    {\"Id\":\"a\",\"MessageBody\":\"{\\\"jobId\\\":\\\"$RT_RUN-A\\\",\\\"imageId\\\":\\\"image-456\\\",\\\"operation\\\":\\\"resize\\\"}\"},
    {\"Id\":\"b\",\"MessageBody\":\"{\\\"jobId\\\":\\\"$RT_RUN-B\\\",\\\"imageId\\\":\\\"image-456\\\",\\\"operation\\\":\\\"resize\\\"}\"},
    {\"Id\":\"c\",\"MessageBody\":\"{\\\"jobId\\\":\\\"$RT_RUN-C\\\",\\\"imageId\\\":\\\"image-456\\\",\\\"operation\\\":\\\"resize\\\"}\"}
  ]"
```

All three entries should be under `Successful`. Allow time for retries. A failed batch reappears after the visibility timeout, and a message that is still failing after its last allowed receive moves to the DLQ:

```bash
sleep 180
```

**Logs.** Show this run's job entries, then the invocation reports in the same period. The Node.js runtime does not log a separate timeout message; a timed-out invocation's `REPORT` line ends with `Status: timeout`:

```bash
aws logs tail "$RT_LOG_GROUP" --region "$RT_REGION" --since 10m \
  --format short --filter-pattern "\"$RT_RUN\""

aws logs tail "$RT_LOG_GROUP" --region "$RT_REGION" --since 10m \
  --format short --filter-pattern '"REPORT"'
```

Each entry carries a request ID, which identifies one invocation. Use it to group the job entries into batches and match each batch to its `REPORT` line. For each job ID, count the `Image job started` and `Image job processed` entries and their `receiveCount` values. Pay attention to any job that logs `processed` and is delivered again anyway, and to how batch composition changes between attempts.

**Metrics.** Set the window's end and read the Lambda error count and maximum duration:

```bash
RT_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

aws cloudwatch get-metric-statistics \
  --region "$RT_REGION" --namespace AWS/Lambda --metric-name Errors \
  --dimensions "Name=FunctionName,Value=$RT_FUNCTION" \
  --start-time "$RT_START" --end-time "$RT_END" \
  --period 60 --statistics Sum \
  --query '{Errors:sum(Datapoints[].Sum),ReportedMinutes:length(Datapoints)}' --no-cli-pager

aws cloudwatch get-metric-statistics \
  --region "$RT_REGION" --namespace AWS/Lambda --metric-name Duration \
  --dimensions "Name=FunctionName,Value=$RT_FUNCTION" \
  --start-time "$RT_START" --end-time "$RT_END" \
  --period 60 --statistics Maximum \
  --query '{MaxDurationMs:max(Datapoints[].Maximum),ReportedMinutes:length(Datapoints)}' --no-cli-pager
```

If `ReportedMinutes` is zero, CloudWatch has not published the points yet. Wait a minute, refresh `RT_END`, and repeat.

**Queues.** Read the standard DLQ count again and compare it with the baseline.

**Conclusion:** the timeouts appear only in the step 5 evidence: `Status: timeout` in `REPORT` lines, nonzero Lambda `Errors`, a `Duration` maximum of about 5000 ms, and repeated `receiveCount` values. The configuration, the state, the AWS resource configuration, `validate`, and `plan` all describe a correctly deployed system.

### 6. Improper versus proper configuration

The standard queue's mapping must satisfy one rule that Terraform never checks:

```text
batch_size × time per record  <  Lambda timeout
```

The current deployment gives `4 × 3 s = 12 s` of worst-case work and a `5 s` timeout. Any of the alternatives below satisfies the rule:

| Setting | Where | Current (improper) | Proper: smaller batches | Proper: longer timeout |
| --- | --- | --- | --- | --- |
| Time per record | `src/handler-sqs-fifo.ts` (`processingDelayMs`) | 3 s | 3 s | 3 s |
| Standard mapping `batch_size` | `local.sqs_batch_size` | 4 | 1 | 4 |
| Lambda `timeout` | `local.lambda_timeout_seconds` | 5 s | 5 s | 15 s |
| Worst-case invocation duration | derived | 12 s, **exceeds the timeout** | 3 s | 12 s |
| Standard queue `visibility_timeout_seconds` | derived: `6 × timeout + 5` | 35 s | 35 s | 95 s |
| Result | runtime | multi-record batches time out and are retried | every invocation finishes | every invocation finishes |

Trade-offs:

- **Smaller batches** keep failures quick to surface but use one invocation per message. They also give up batching for the standard queue, which Increments 12–14 introduced.
- **A longer timeout** keeps batching. Because visibility is derived from the timeout, a failed batch now waits 95 s instead of 35 s before redelivery. The FIFO queue's visibility also changes, from 30 s to 90 s, because it uses the same timeout.
- Both alternatives are Terraform-only changes, and `plan` would show them as ordinary in-place updates. The fact that one is correct and the current settings are not comes from the handler's processing time, which Terraform cannot see.

The root cause is that one function, built from one handler, serves two queues with different needs. The FIFO mapping's batch size of 1 hides the 3 s delay; the standard mapping's batch size of 4 exposes it.

### Cleanup

If any jobs from this run reached the standard DLQ, leave them or purge the standard DLQ if nothing else there is still needed. Purging deletes every message in it.

The mismatch stays deployed. Every standard-queue batch with more than one valid job will fail until the handler, batch size, or timeout changes.

### What to take away

- **Configuration is intent; state is a record.** State links each Terraform address to a real AWS ID and stores attribute values from the last apply or refresh. `state show` reads that record without checking it against AWS.
- **`plan` compares configuration with the current resource configuration.** It refreshes the state from AWS, so `No changes` means that what AWS reports matches what you declared. It inspects resources, never message flow.
- **`validate` proves less than `plan`.** It checks that the configuration is internally consistent, without contacting AWS.
- **Correct resources can still form a broken system.** Batch size, per-record processing time, and function timeout are each valid alone. Whether they work together depends on code and data that Terraform never executes. Only runtime evidence such as logs, metrics, and queue counts can show this.
