# Lambda + SQS + Terraform 101

This learning project builds a small image-processing workflow one increment at
a time. Increment 1 is a minimal TypeScript Lambda handler invoked entirely on
the local machine. It does not create or contact any AWS resources.

## Increment 1

The sample event represents an image job:

```json
{
  "jobId": "job-123",
  "imageId": "image-456",
  "operation": "resize"
}
```

Install the development dependencies, invoke the handler, and run the checks:

```bash
npm install
npm run invoke
npm run check
```

Expected invocation output includes a structured JSON log and the successful
result:

```text
Invoking handler locally...
{"message":"Image job received","jobId":"job-123","imageId":"image-456","operation":"resize"}
Handler result: {"jobId":"job-123","status":"accepted"}
```

### Concepts introduced

- **Handler:** the exported `handler` function is the entry point that AWS
  Lambda will call after it is deployed in a later increment.
- **Invocation:** one execution of the handler. `src/invoke.ts` performs a local
  invocation by calling the function like any other JavaScript function.
- **Event:** the input value supplied to a handler. Here TypeScript's
  `ImageJobEvent` interface documents and checks the shape during development;
  it does not validate data at runtime.
- **Execution environment:** in AWS, Lambda creates and reuses an isolated
  runtime containing Node.js and the function code. In this increment, the
  local Node.js process stands in for that environment.
- **Statelessness:** handler correctness should not depend on in-memory state
  left by a previous invocation. Lambda may reuse an environment, but it may
  also replace it at any time.

Local invocation proves that ordinary TypeScript/JavaScript behavior works. It
does **not** test Lambda packaging, the configured runtime and handler name,
IAM permissions, networking, CloudWatch logging, or any Terraform-managed AWS
resource. Those boundaries are introduced and verified in later increments.

## Project commands

- `npm run build` — bundle the handler into `dist/handler.js` for Lambda.
- `npm run invoke` — invoke the handler locally with the example event.
- `npm test` — run the handler test once with Vitest.
- `npm run typecheck` — ask TypeScript to check the project without emitting
  JavaScript.
- `npm run check` — run both the type checker and tests.

## Increment 2

Increment 2 deploys the same handler as one AWS Lambda function. There is no
SQS queue or event source mapping yet.

```text
Terraform ──creates──> Lambda ──writes──> CloudWatch Logs
                         │
                         └──assumes──> IAM execution role
```

The configuration is kept explicit in `terraform/`:

- `aws_lambda_function.image_processor` configures the code archive, Node.js
  runtime, exported handler, memory, timeout, and execution role.
- `aws_iam_role.lambda` trusts the Lambda service to assume the role.
- `aws_iam_role_policy_attachment.lambda_basic_execution` attaches AWS's basic
  logging policy to that role. This is the Lambda's permission to write logs;
  it is not permission for a human to invoke the function.
- `aws_cloudwatch_log_group.lambda` manages the log group and retains logs for
  seven days rather than leaving an automatically created group behind.
- `archive_file.lambda` packages the compiled JavaScript and calculates the
  content hash that tells Terraform when deployed code has changed.

The AWS provider translates the resource declarations into AWS API calls. Its
version constraint is in `terraform/versions.tf`; `terraform init` records the
exact selected versions in `.terraform.lock.hcl`.

### Build and inspect the plan

Use AWS credentials for a dedicated personal/dev account, then run:

```bash
npm run check
npm run build
terraform -chdir=terraform init
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-2.tfplan
terraform -chdir=terraform show increment-2.tfplan
```

The plan should add one Lambda, one execution role, one logging-policy
attachment, and one log group. A plan is a proposed change calculated from the
configuration, Terraform state, and current AWS state; inspect it before apply.

### Deploy and prove what is running

Apply the already-reviewed saved plan:

```bash
terraform -chdir=terraform apply increment-2.tfplan
terraform -chdir=terraform output
```

Terraform state records the mapping between resource addresses in this project
and remote AWS objects. It is not a runtime health check and must not contain
secrets committed to Git.

Invoke the deployed function and inspect the response:

```bash
aws lambda invoke \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"jobId":"job-123","imageId":"image-456","operation":"resize"}' \
  lambda-response.json

cat lambda-response.json
```

Then inspect the deployed configuration and recent logs:

```bash
aws lambda get-function-configuration \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)"

terraform -chdir=terraform output -raw lambda_source_code_hash

aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 10m
```

Together, these checks prove different things: Terraform state identifies the
managed object, `get-function-configuration` shows the actual AWS runtime and
handler configuration, the successful invocation proves the archive can load,
and CloudWatch logs prove that the deployed handler processed the expected
event. The Lambda ARN output is the stable AWS identifier other services will
reference in later increments.

## Increment 3

Increment 3 keeps the infrastructure from increment 2 and makes Lambda's
runtime signals observable. The handler now treats `jobId: "FAIL"` as a poison
test value: it logs the received job and then throws an `Error`. The error is
deliberately not caught, so Lambda records the invocation as failed.

### Prepare and deploy the code change

First run the local checks and rebuild the deployment artifact:

```bash
npm run check
npm run build
terraform -chdir=terraform plan -out=increment-3.tfplan
terraform -chdir=terraform show increment-3.tfplan
```

The plan should update `aws_lambda_function.image_processor` in place because
the archive's `source_code_hash` changed. It should not add or remove resources.
After reviewing that result, deploy the saved plan:

```bash
terraform -chdir=terraform apply increment-3.tfplan
```

This deployment is part of the experiment: the observations below are only
meaningful after AWS has the new handler code.

### Invoke successes and one failure

Invoke three successful jobs. `--log-type Tail` asks Lambda to include the last
4 KB of execution logs in each synchronous response; decoding `LogResult`
makes the application and platform records immediately visible.

```bash
for job_id in job-101 job-102 job-103; do
  aws lambda invoke \
    --region "$(terraform -chdir=terraform output -raw aws_region)" \
    --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
    --cli-binary-format raw-in-base64-out \
    --log-type Tail \
    --payload "{\"jobId\":\"${job_id}\",\"imageId\":\"image-456\",\"operation\":\"resize\"}" \
    --query 'LogResult' \
    --output text \
    success-response.json | base64 --decode
done

cat success-response.json
```

Now invoke the intentional failure. The `invoke` API call itself can succeed
while the function fails, so do not use only the shell exit status as the
result. `FunctionError: Unhandled` in the CLI response and the error document
in `failure-response.json` are the important distinction.

```bash
aws lambda invoke \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --cli-binary-format raw-in-base64-out \
  --log-type Tail \
  --payload '{"jobId":"FAIL","imageId":"image-456","operation":"resize"}' \
  --query '{FunctionError:FunctionError,LogResult:LogResult}' \
  --output json \
  failure-response.json > failure-invoke-metadata.json

cat failure-response.json
cat failure-invoke-metadata.json
```

The command separates the function response payload from the AWS API metadata.
Decode the failure's `LogResult` to see its logs without waiting for CloudWatch
Logs search (`jq` extracts the base64 field from the metadata JSON):

```bash
jq -r '.LogResult' failure-invoke-metadata.json | base64 --decode
```

Expect three successes, one error, and four total invocations if these are the
only calls in the selected metric time window.

### Inspect the CloudWatch log hierarchy

The log group belongs to the function and survives across execution
environments. A log stream normally represents one Lambda execution
environment and can therefore contain multiple invocations.

```bash
aws logs describe-log-groups \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --log-group-name-prefix "$(terraform -chdir=terraform output -raw lambda_log_group_name)"

aws logs describe-log-streams \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --log-group-name "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --order-by LastEventTime \
  --descending

aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 15m
```

For each invocation, compare the structured `Image job received` application
log with Lambda's platform-generated `START`, `END`, and `REPORT` records. The
same request ID correlates those records. `REPORT` includes billed and actual
duration, memory configuration, and peak memory use. A failed invocation also
contains the uncaught error and stack trace.

### Inspect invocation and error metrics

CloudWatch metrics can take a few minutes to appear. These commands use a
30-minute UTC window and five-minute buckets; on macOS, `date -v-30M` computes
the start of that window.

```bash
aws cloudwatch get-metric-statistics \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions "Name=FunctionName,Value=$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --statistics Sum \
  --period 300 \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

aws cloudwatch get-metric-statistics \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions "Name=FunctionName,Value=$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --statistics Sum \
  --period 300 \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`Invocations` counts attempts, whether successful or failed. `Errors` counts
invocations where the function returned an error. CloudWatch publishes these
as separate time-series data, not by parsing your application log messages.
Throwing matters when an AWS service invokes Lambda because the failure signal
is what lets that integration retry or route failed work. Catching the error
and returning success would hide that signal even if an error message were
logged.

## Increment 4

Increment 4 adds one standard SQS queue but does not connect it to Lambda:

```text
AWS CLI ──send/receive/delete──> SQS

Lambda (still invoked manually; no connection to SQS yet)
```

`aws_sqs_queue.image_jobs` uses a deliberately short 30-second visibility
timeout. Receiving a message temporarily hides it; it does not acknowledge or
delete it. If the receiver does not delete the message before that timeout
expires, SQS makes it eligible for delivery again.

### Plan and deploy the queue

Format and validate the Terraform configuration, then inspect a saved plan:

```bash
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-4.tfplan
terraform -chdir=terraform show increment-4.tfplan
```

The plan should add exactly one `aws_sqs_queue.image_jobs` resource and three
outputs. It should not change the Lambda, its IAM role, or its log group. After
reviewing the plan, apply it and inspect the output values:

```bash
terraform -chdir=terraform apply increment-4.tfplan
terraform -chdir=terraform output
```

The queue URL is its regional SQS API endpoint and is used by commands that
operate on messages. The ARN is the global AWS identifier used in IAM policies
and service integrations. The queue name is the human-readable final component
of both identifiers.

### Send and inspect one message

Send one image job and retain the returned message ID:

```bash
aws sqs send-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --message-body '{"jobId":"job-201","imageId":"image-456","operation":"resize"}'
```

`MessageId` identifies the stored message. It is not the token used to delete
a received copy. Inspect the queue's identity, configured timeout, and
approximate visible-message count:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names QueueArn VisibilityTimeout ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

The approximate counters are eventually consistent, so a freshly sent or
received message might not be reflected immediately.

### Receive without deleting

Receive the message and save the full response. `ApproximateReceiveCount`
starts at 1 and helps demonstrate redelivery:

```bash
aws sqs receive-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --max-number-of-messages 1 \
  --wait-time-seconds 2 \
  --message-system-attribute-names ApproximateReceiveCount SentTimestamp \
  > first-receive.json

jq '.Messages[0] | {MessageId, ReceiptHandle, Attributes, Body}' first-receive.json
```

The receipt handle identifies this particular receipt of the message. It is
opaque and can be long. Immediately try another receive:

```bash
aws sqs receive-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --max-number-of-messages 1 \
  --wait-time-seconds 2
```

An empty response is expected because the first receive made the message
invisible for 30 seconds. Now let that visibility timeout expire and receive
again:

```bash
sleep 32

aws sqs receive-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --max-number-of-messages 1 \
  --wait-time-seconds 2 \
  --message-system-attribute-names ApproximateReceiveCount SentTimestamp \
  > second-receive.json

jq '.Messages[0] | {MessageId, ReceiptHandle, Attributes, Body}' second-receive.json
```

The second response should contain the same message ID and body, an
`ApproximateReceiveCount` of 2, and a new receipt handle. Standard queues use
at-least-once delivery, so consumers must also tolerate duplicates. Letting the
visibility timeout expire is the easiest way to demonstrate a redelivery
deliberately.

### Delete the received message

Delete using the newest receipt handle:

```bash
aws sqs delete-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' second-receive.json)"

aws sqs receive-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --max-number-of-messages 1 \
  --wait-time-seconds 2
```

The final receive should be empty. Deleting acknowledges this delivery and
tells SQS that the consumer no longer wants the message delivered. SQS cannot
verify whether the consumer's application-level processing was correct;
deletion expresses only the consumer's decision. Without deletion, SQS makes
the message available again after the visibility timeout, regardless of what
the consumer actually did.

SQS has no continuously running compute in this design, but API requests and
data transfer can incur usage charges. The small number of requests and tiny
payloads in this lab should be negligible; the queue remains deployed until a
later `terraform destroy` removes it.

## Increment 5

Increment 5 connects the standard queue to the existing Lambda:

```text
AWS CLI ──send──> SQS
                    ↑ poll/receive/delete
            Lambda event source mapping
                    ↓ invoke
                  Lambda
```

SQS does not call the handler directly. The Lambda service manages pollers for
the event source mapping. A poller receives messages using the Lambda execution
role's permissions, invokes the function with a batch, and deletes successfully
processed messages from SQS. With the mapping's `batch_size` set to 1, each
invocation receives at most one message during this exercise.

Two Terraform resources create the required behavior:

- `aws_iam_role_policy.lambda_sqs` lets the execution role call
  `ReceiveMessage`, `DeleteMessage`, and `GetQueueAttributes` on this queue
  only. Although the handler does not call the SQS API itself, the managed
  poller uses these execution-role permissions on the function's behalf.
- `aws_lambda_event_source_mapping.image_jobs` creates the polling relationship.
  Its `event_source_arn` identifies the queue, while `function_name` identifies
  the invocation target. The queue URL is not used for this relationship.

### Plan and deploy the connection

Run the local checks and build first because Terraform still evaluates the
Lambda deployment archive while planning:

```bash
npm run check
npm run build
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=increment-5.tfplan
terraform -chdir=terraform show increment-5.tfplan
```

The plan should add one inline IAM role policy and one Lambda event source
mapping. It should not replace the queue, Lambda, execution role, or log group.
After reviewing the plan, apply it:

```bash
terraform -chdir=terraform apply increment-5.tfplan
```

The explicit `depends_on` makes Terraform wait until the queue permissions have
been attached before asking AWS to create the mapping. This is needed because
AWS validates the function role's SQS permissions when the mapping is created.

### Inspect the polling relationship

Inspect the deployed mapping before sending a message:

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,BatchSize:BatchSize,EventSourceArn:EventSourceArn,FunctionArn:FunctionArn}'
```

Expect one mapping with state `Enabled`, batch size `1`, the queue ARN as its
event source, and the Lambda ARN as its target. If its state is briefly
`Creating` or `Enabling`, wait and inspect it again before continuing.

### Send one message through SQS

Send a new image job and note the returned `MessageId`:

```bash
aws sqs send-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --message-body '{"jobId":"job-301","imageId":"image-456","operation":"resize"}'
```

A successful `SendMessage` response proves that SQS accepted the message. The
enabled poller may receive it too quickly for an approximate queue counter to
show `1`, so that counter is not a reliable way to capture every transition.

Wait a few seconds, then inspect recent Lambda logs:

```bash
aws logs tail "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --since 5m
```

A new Lambda request proves that the event source mapping invoked the function.
The current handler logs `Image job received`, but its `jobId`, `imageId`, and
`operation` properties are missing. This is expected: Lambda supplied an SQS
event whose messages are inside a `Records` array, while the TypeScript handler
still assumes that the image job is the top-level event. TypeScript types are
removed during compilation and therefore do not validate an AWS event at
runtime. Increment 6 will inspect and parse the real SQS event shape.

### Verify successful consumption

Inspect the queue after the invocation:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs receive-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --max-number-of-messages 1 \
  --wait-time-seconds 2
```

Both approximate counters should settle at `0`, and the manual receive should
be empty. The event source mapping considered the invocation successful because
the handler resolved rather than throwing, so its poller deleted the message.
As established in increment 4, this deletion records the consumer's decision
that no further delivery is required; it does not prove that the handler's
application-level interpretation was correct.

Once connected, the poller continuously performs SQS receives, including when
the queue is empty. This can incur SQS request charges, though the cost of this
small learning setup should remain negligible.
