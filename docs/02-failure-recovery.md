# 02 Failure Recovery

Debug failed SQS deliveries and replay them deliberately after correcting the consumer.

## 10. Debug a Message in the DLQ

Diagnose one failed message by correlating evidence across SQS, Lambda,
CloudWatch Logs, IAM, and Terraform before changing the application. This
increment makes no code or infrastructure change: the goal is to distinguish
delivery and configuration failures from an application failure.

Prerequisites:

- The Lambda, source queue, DLQ, IAM policy, and event source mapping are
  deployed.
- The poison message from Increment 9 remains in the DLQ.
- Your AWS CLI credentials can read SQS, Lambda, IAM, and CloudWatch Logs.
- Run all commands from the repository root.

Relevant files:

- `src/handler-sqs.ts` parses the SQS body and validates the job.
- `src/process-image-job.ts` contains the controlled failure condition.
- `terraform/main.tf` declares the queue timing, redrive policy, IAM policy,
  Lambda function, and event source mapping.
- `terraform/outputs.tf` supplies the identifiers used below.

### Inspect the failed message without deleting it

Receive one message from the DLQ, limiting the output to evidence useful for
diagnosis. A zero-second visibility timeout makes it immediately available
again, and no `delete-message` command is used:

```bash
aws sqs receive-message \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_dead_letter_queue_url)" \
  --attribute-names All \
  --message-attribute-names All \
  --max-number-of-messages 1 \
  --visibility-timeout 0 \
  --wait-time-seconds 10 \
  --query 'Messages[0].{MessageId:MessageId,Body:Body,Attributes:Attributes}'
```

Expect the `FAIL` job body, the same message ID seen in Increment 9, and a
`DeadLetterQueueSourceArn` identifying the source queue. Each inspection is
another receive, so `ApproximateReceiveCount` can be higher than the value
previously observed. Copy the returned message ID into a shell variable and
note the `jobId` in the body:

```bash
DLQ_MESSAGE_ID="replace-with-the-returned-message-id"
```

### Verify the delivery path and configuration

Confirm that the mapping from the source queue is still enabled:

```bash
aws lambda list-event-source-mappings \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --event-source-arn "$(terraform -chdir=terraform output -raw image_jobs_queue_arn)" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize,LastResult:LastProcessingResult}'
```

Expect one mapping with `State` equal to `Enabled` and batch size `1`. Next,
inspect the Lambda execution role's inline queue policy:

```bash
aws iam get-role-policy \
  --role-name "$(terraform -chdir=terraform output -raw lambda_function_name)-execution-role" \
  --policy-name "$(terraform -chdir=terraform output -raw lambda_function_name)-sqs-consumer" \
  --query 'PolicyDocument.Statement[].{Effect:Effect,Actions:Action,Resources:Resource}'
```

Expect `Allow` for `ReceiveMessage`, `DeleteMessage`, and `GetQueueAttributes`
on the source queue ARN. Lambda needs no permission on the DLQ because SQS owns
the redrive operation.

Read the source queue's retry and visibility configuration and the function's
timeout from the services that enforce them:

```bash
aws sqs get-queue-attributes \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --queue-url "$(terraform -chdir=terraform output -raw image_jobs_queue_url)" \
  --attribute-names QueueArn VisibilityTimeout RedrivePolicy

aws lambda get-function-configuration \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --function-name "$(terraform -chdir=terraform output -raw lambda_function_name)" \
  --query '{Timeout:Timeout,Role:Role}'
```

Expect a 30-second visibility timeout, a redrive policy targeting the DLQ with
`maxReceiveCount` `3`, and a 5-second Lambda timeout. These values agree with
`terraform/main.tf`; they do not explain a function that throws after only a
few milliseconds.

### Correlate the message with the failure

Find the delivery log using the SQS message ID. Its log prefix contains the
Lambda request ID for that particular invocation:

```bash
aws logs filter-log-events \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --log-group-name "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --filter-pattern "\"${DLQ_MESSAGE_ID}\"" \
  --query 'events[].message' \
  --output text
```

Copy one request ID from that result, then retrieve every log event for the
invocation:

```bash
LAMBDA_REQUEST_ID="replace-with-a-request-id-from-the-result"

aws logs filter-log-events \
  --region "$(terraform -chdir=terraform output -raw aws_region)" \
  --log-group-name "$(terraform -chdir=terraform output -raw lambda_log_group_name)" \
  --filter-pattern "\"${LAMBDA_REQUEST_ID}\"" \
  --query 'events[].message' \
  --output text
```

The invocation logs the parsed job and then reports `Intentional failure for
observation exercise`. The body was therefore valid JSON, passed the handler's
shape checks, and reached the application function. The matching source shows
the cause:

```bash
rg -n -C 4 'jobId === "FAIL"|Intentional failure' src/process-image-job.ts
```

The diagnosis is an intentional application failure triggered by
`jobId: "FAIL"`. It is not an event source mapping, IAM, JSON parsing,
visibility timeout, or Lambda timeout failure. Do not fix it yet; Increment 11
will correct the condition and deliberately replay the preserved message.

### SQS → Lambda failure checklist

Use this order to avoid changing code before proving which boundary failed:

1. **Did the message reach the source queue?** Match its
   `DeadLetterQueueSourceArn` and message ID to the source queue and delivery
   logs.
2. **Is the event source mapping enabled?** Expect exactly one matching mapping
   in state `Enabled`.
3. **Does Lambda have permission to consume the queue?** Check the execution
   role for receive, delete, and queue-attribute permissions on the source ARN.
4. **Is Lambda being invoked?** Look for Lambda request IDs associated with the
   SQS message ID.
5. **Does the handler throw?** Inspect the complete logs for a matching request
   ID and its error.
6. **Is the body parseable?** Compare the DLQ body with the handler validation
   and check whether the parsed application log was emitted.
7. **What is `ApproximateReceiveCount`?** Compare the Lambda delivery counts;
   remember that manual DLQ inspection also increments the value.
8. **What is the queue visibility timeout?** Read `VisibilityTimeout` from the
   source queue, not the DLQ.
9. **What is the Lambda timeout?** Read the deployed function configuration and
   compare it with the observed invocation duration.
10. **Is a redrive policy configured?** Check its target ARN and
    `maxReceiveCount` on the source queue.
11. **Has the message reached the DLQ?** Receive it without deleting it and
    verify `DeadLetterQueueSourceArn`.
12. **What do CloudWatch logs show for the matching message ID/job ID?** Trace
    message ID → request ID → parsed job → exact exception.
