# Lambda + SQS + DLQ + Terraform Learning Plan

## Goal

Build a very small AWS project incrementally to understand how to deploy, test, debug, and observe:

- AWS Lambda
- SQS
- Lambda event source mappings
- SQS visibility timeout
- retries
- dead-letter queues (DLQ)
- redrive policies
- batch processing
- partial batch failures
- FIFO queues
- message groups
- poison messages
- CloudWatch logs
- CloudWatch metrics
- Terraform resources and relationships
- Terraform plan/apply/output/state inspection
- debugging deployed infrastructure
- distinguishing application failures from infrastructure/configuration failures

The goal is NOT to build a production application.

The goal is to develop enough operational intuition to safely understand, test, debug, and review Lambda/SQS/Terraform changes in an existing application.

Use an invented image-processing domain.

Example message:

```json
{
  "jobId": "job-123",
  "imageId": "image-456",
  "operation": "resize"
}
```

No actual image processing is required.

The Lambda may simply validate the message and log what it would do.

Keep each increment independently understandable.

---

## Constraints

- Use TypeScript and Node.js.
- Use Terraform for AWS infrastructure.
- Use the official AWS provider.
- Pin Terraform provider versions rather than using unconstrained latest versions.
- Keep the Lambda code deliberately small.
- Do not build an HTTP API.
- Do not introduce API Gateway.
- Do not introduce databases.
- Do not introduce EventBridge initially.
- Do not introduce Step Functions.
- Do not introduce SNS.
- Do not introduce application frameworks.
- Do not introduce CDK or Serverless Framework.
- Do not introduce LocalStack or MiniStack initially.
- Do not build generic Terraform modules initially.
- Keep Terraform resources explicit.
- Use AWS CLI for manual experiments.
- Use only an isolated personal/dev AWS account.
- Apply consistent names and tags.
- Explain ongoing costs.
- Never connect to work resources.
- Do not hide or swallow failures.
- Keep costs negligible.
- Never use proprietary work identifiers or architecture.
- Do not optimize for production scale.
- Do not catch exceptions merely to report success.
- Make retry and DLQ failures deliberately observable.

---

## Increment 1 — Minimal TypeScript Lambda Locally

Create a very small TypeScript Lambda handler.

Input conceptually represents:

```json
{
  "jobId": "job-123",
  "imageId": "image-456",
  "operation": "resize"
}
```

For now, invoke the handler directly from a local script or test.

The handler should:

1. receive the event
2. log useful structured information
3. return successfully

Explain:

- Lambda handler
- invocation
- event
- execution environment
- statelessness as an application assumption
- why local invocation is NOT the same as testing AWS infrastructure

Do not use SQS yet.

---

## Increment 2 — Deploy One Lambda With Terraform

Create explicit Terraform configuration for:

```text
Terraform
↓
Lambda
```

Include only what is required:

- Lambda function
- execution IAM role
- basic logging permissions
- packaging/build step as simply as reasonably possible

Run:

```bash
terraform init
terraform fmt
terraform validate
terraform plan
```

Before applying, explain the plan.

Then deploy.

Invoke the Lambda manually using AWS CLI.

Verify its CloudWatch logs.

Explain:

- Terraform provider
- resource
- IAM execution role
- Lambda function ARN
- Terraform plan
- Terraform apply
- Terraform output
- Terraform state at a conceptual level

The important question is:

How do I prove that the deployed Lambda is actually the code/configuration I think Terraform created?

Do not introduce SQS yet.

---

## Increment 3 — Observe Lambda in AWS

Trigger the Lambda several times manually.

Inspect:

- CloudWatch log group
- log streams
- invocation logs
- duration
- request ID
- error count
- invocation count

Make one invocation fail intentionally.

For example:

```json
{
  "jobId": "FAIL",
  "imageId": "image-456",
  "operation": "resize"
}
```

The handler should throw an error for that input.

Observe the difference between:

successful invocation

and:

failed invocation

Explain:

- application log
- Lambda platform log
- invocation error
- CloudWatch metric
- why a thrown error matters to AWS integrations

Do not catch and swallow the intentional failure.

---

## Increment 4 — Add a Standard SQS Queue With Terraform

Create:

```text
Producer/manual CLI
       ↓
      SQS
```

Do NOT connect it to Lambda yet.

Create the queue using Terraform.

Add useful Terraform outputs:

- queue URL
- queue ARN
- queue name

Use AWS CLI to:

1. send a message
2. inspect queue attributes
3. receive a message manually
4. delete a message manually

Explain:

- queue URL versus ARN
- message ID
- receipt handle
- receive
- delete
- visibility timeout

Demonstrate what happens if a message is received but NOT deleted.

Wait for the visibility timeout and receive it again.

This increment should make visibility timeout concrete before Lambda is involved.

---

## Increment 5 — Connect SQS to Lambda

Create:

```text
SQS
↓
Lambda event source mapping
↓
Lambda
```

Use Terraform.

Before applying, explain the resources involved.

The connection must be represented explicitly using the appropriate Lambda event source mapping resource.

Explain:

- SQS does not simply push directly into the Lambda handler
- Lambda polls SQS
- event source mapping
- queue ARN
- Lambda permissions required to consume messages
- batch size

Send one message through AWS CLI.

Observe:

1. SQS message arrives.
2. Lambda consumes it.
3. Lambda logs the message.
4. Successful processing removes the message.

Verify queue state afterward.

The key question:

Which Terraform resource creates the relationship between this queue and this Lambda?

---

## Increment 6 — Inspect an Actual SQS Lambda Event

Log a deliberately limited/safe representation of the received Lambda event.

Inspect fields such as:

- `Records`
- `messageId`
- `body`
- `attributes`
- `eventSource`
- `eventSourceARN`
- `awsRegion`

Parse the JSON body into the image-processing job.

Explain the distinction between:

Lambda invocation event

and:

application message body

Write a unit test for the handler using a representative SQS event fixture.

The unit test should NOT claim to test SQS itself.

---

## Increment 7 — Introduce a Processing Failure

Make the handler throw when:

operation = "FAIL"

Send one failing SQS message.

Observe:

```text
SQS
↓
Lambda receives message
↓
handler fails
↓
message is not deleted
↓
visibility timeout
↓
message becomes visible again
↓
Lambda retries
```

Inspect:

- Lambda logs
- SQS approximate message counts
- ApproximateReceiveCount
- repeated Lambda request IDs
- message ID across retries

Do NOT create a DLQ yet.

Explain exactly who is responsible for:

- invoking Lambda
- determining success/failure
- hiding the message
- making the message visible again

---

## Increment 8 — Visibility Timeout Versus Lambda Timeout

Configure deliberately short but safe values for learning.

Inspect:

Lambda timeout SQS visibility timeout

Explain why these values are related.

Create a handler mode that waits for a controlled period.

Do NOT create pathological or expensive retry loops.

Experiment with processing duration relative to the configured timeout.

Observe failures.

Explain:

- Lambda timeout
- visibility timeout
- message redelivery
- duplicate processing risk
- why infrastructure timing settings are part of application correctness

Record the relationship in the README.

---

## Increment 9 — Add a Dead-Letter Queue

Create:

```text
source queue
    ↓ repeated failure
DLQ
```

Use Terraform to create:

- source queue
- dead-letter queue
- redrive configuration

Set a deliberately low maxReceiveCount for the exercise so behavior is observable quickly.

Do NOT use this low value as a production recommendation.

Before applying, inspect the Terraform plan.

Answer:

1. Which queue points to which?
2. Where is maxReceiveCount configured?
3. What ARN is referenced?
4. Does Lambda know directly about the DLQ?

Send a poison message.

Observe:

```text
receive #1 → fail
receive #2 → fail
...
→ DLQ
```

Verify the message actually arrives in the DLQ.

Inspect its body and attributes.

Explain:

- redrive policy
- max receive count
- source queue
- DLQ
- why this DLQ belongs conceptually to SQS retry behavior rather than being a Lambda exception handler

---

## Increment 10 — Debug a Message in the DLQ

Take one failed message from the DLQ.

Given only:

- message contents
- Lambda logs
- queue configuration
- Terraform configuration

diagnose why it failed.

Create a README debugging checklist:

### SQS → Lambda failure checklist

1. Did the message reach the source queue?
2. Is the event source mapping enabled?
3. Does Lambda have permission to consume the queue?
4. Is Lambda being invoked?
5. Does the handler throw?
6. Is the body parseable?
7. What is ApproximateReceiveCount?
8. What is the queue visibility timeout?
9. What is the Lambda timeout?
10. Is a redrive policy configured?
11. Has the message reached the DLQ?
12. What do CloudWatch logs show for the matching message ID/job ID?

Practice debugging before changing code.

---

## Increment 11 — Redrive a Corrected Message Manually

Fix the condition causing the poison message to fail.

Take a message from the DLQ and send its body back to the source queue manually.

Observe successful processing.

Explain:

- redrive conceptually
- why fixing code does not automatically reprocess existing DLQ messages
- why replay must be deliberate
- duplicate-processing considerations

Do not automate DLQ replay yet.

---

## Increment 12 — Process a Batch

Set an SQS event source mapping batch size greater than 1.

Send several messages.

Observe one Lambda invocation receiving several records.

Change the handler so it processes each record explicitly.

Explain:

```text
SQS messages
↓
Lambda batch
↓
one invocation
```

Write unit tests for:

- all messages succeed
- one message fails

Initially use default Lambda batch failure behavior.

Observe what happens when one record throws.

---

## Increment 13 — Understand Whole-Batch Failure

Create a batch containing:

```text
GOOD-1
GOOD-2
FAIL
GOOD-3
```

Let processing throw on the failing record.

Observe which messages are retried.

Explain why successfully processed messages can be delivered again when the invocation is considered failed.

Discuss:

- at-least-once delivery
- duplicate processing
- idempotency
- poison messages

Do NOT implement an idempotency store.

The goal is to understand the problem.

---

## Increment 14 — Add Partial Batch Responses

Configure the event source mapping to support partial batch failure reporting.

Change the handler so it returns the appropriate failed-message identifiers instead of failing the entire successfully processed batch.

Repeat:

```text
GOOD-1
GOOD-2
FAIL
GOOD-3
```

Observe which message is retried.

Compare behavior before and after.

Explain:

- ReportBatchItemFailures
- batchItemFailures
- why simply returning this structure without configuring the event source mapping is insufficient
- why throwing from the whole invocation has different semantics

Keep the implementation explicit.

Do not introduce AWS Lambda Powertools yet.

---

## Increment 15 — Terraform Change → Runtime Consequence Exercise

Without changing application code, modify ONE Terraform setting at a time.

Examples:

- batch size
- visibility timeout
- Lambda timeout
- max receive count
- event source mapping enabled/disabled

For each:

1. predict the Terraform plan
2. predict whether AWS updates or replaces a resource
3. predict runtime behavior
4. apply
5. trigger messages
6. observe
7. compare prediction with reality

Create a table:

```text
Terraform change
→ AWS resource affected
→ runtime consequence
→ how to verify
```

This increment is particularly important.

---

## Increment 16 — Break the Event Source Mapping

Deliberately disable the event source mapping through Terraform.

Send messages.

Observe:

```text
messages accumulate in SQS
Lambda receives nothing
```

Inspect:

- queue depth
- Lambda logs
- event source mapping status

Then re-enable it.

Observe messages being consumed.

The purpose is to distinguish:

consumer code broken

from:

consumer is not being invoked

---

## Increment 17 — Break IAM Deliberately

Temporarily remove or alter one required SQS permission from the Lambda execution role.

Apply the Terraform change.

Observe actual behavior.

Inspect:

- event source mapping state/errors
- Lambda invocation behavior
- relevant AWS error information

Restore the permission.

Explain the difference between:

- Lambda execution-role permissions
- event source mapping configuration
- application-level message-processing errors

Do not randomly modify policies.

Make one controlled change and restore it afterward.

---

## Increment 18 — Add Structured Logging

Change logs from ad hoc strings to small structured JSON logs.

Include useful correlation fields such as:

```json
{
  "level": "info",
  "jobId": "job-123",
  "messageId": "...",
  "operation": "resize"
}
```

On failure include:

```json
{
  "level": "error",
  "jobId": "job-123",
  "messageId": "...",
  "errorType": "UnsupportedOperation"
}
```

Do not log the entire Lambda/SQS event unnecessarily.

Explain:

- correlation IDs
- message ID
- business/job ID
- structured logs
- why these make retries visible

Process one poison message and follow it across repeated invocations using the identifiers.

---

## Increment 19 — Observe Useful Metrics

Inspect useful built-in metrics for:

### Lambda

- invocations
- errors

### SQS

- messages received
- messages sent
- DLQ message count

Use a known workload that makes these five observations interpretable. Do not build a large dashboard.

Defer source-queue depth and message age until a deliberately paused consumer creates a visible backlog. Defer duration until a controlled processing delay or timeout changes it. Defer throttles until a separate controlled concurrency-limit experiment produces them.

Use the AWS console and/or CLI to understand what each metric tells you.

Given a scenario such as:

queue depth increasing Lambda invocation count = 0

explain likely categories of failure.

Given:

Lambda errors increasing same messages repeatedly received

explain likely categories of failure.

---

## Increment 20 — Add One CloudWatch Alarm

Create ONE useful alarm with Terraform.

For example:

DLQ has visible messages

or another simple failure signal.

Trigger it intentionally.

Observe its state transition.

Explain:

- metric
- alarm
- threshold
- evaluation period
- why logs alone are not sufficient operational monitoring

Do not introduce SNS notifications unless required for understanding the alarm.

---

## Increment 21 — Introduce a FIFO Queue

Do this only after standard SQS behavior is clear.

Create a separate FIFO experiment.

Use:

image-jobs.fifo

rather than replacing the standard queue immediately.

Send messages with:

MessageGroupId = customer-1

Observe ordering.

Then send messages using:

customer-1 customer-2

Explain:

- FIFO queue naming
- message group
- ordering scope
- deduplication ID/content-based deduplication
- why FIFO does not mean one globally serialized consumer in every situation

Do not introduce failure yet.

---

## Increment 22 — FIFO Poison Message

Send:

```text
group customer-1:
A
B ← fails
C
group customer-2:
X
Y
Z
```

Observe behavior.

Explain how a poison message affects ordering within its message group.

Compare with the second group.

Do not guess.

Use actual logs/message observations.

Explain why retry/error handling has special importance with FIFO ordering.

---

## Increment 23 — FIFO + Partial Batch Failure

Configure and implement partial batch responses for FIFO.

Create a batch where one FIFO record fails.

Preserve FIFO ordering semantics when deciding which records should be marked failed/unprocessed.

Explain why continuing past a failed FIFO record can violate expected ordering.

Demonstrate correct behavior.

---

## Increment 24 — Add Concurrency Observation

Do not optimize concurrency.

Instead create messages belonging to multiple groups and add a short controlled processing delay.

Use structured logs with timestamps and message-group IDs.

Observe whether separate groups can progress independently.

Explain at a conceptual level:

- Lambda concurrency
- SQS event-source mapping concurrency
- FIFO message-group constraints
- why concurrency and ordering are related but not identical concepts

Do not tune advanced scaling parameters yet.

---

## Increment 25 — Terraform State and Runtime State

Practice answering:

What does Terraform believe exists?

versus:

What is actually happening at runtime?

Use:

- terraform state list
- terraform state show
- AWS CLI inspection
- CloudWatch logs
- CloudWatch metrics

Pick the source queue and event source mapping.

Compare:

Terraform configuration Terraform state AWS resource configuration runtime observations

Explain why passing:

terraform validate

or:

terraform plan

does NOT prove that the application behaves correctly.
