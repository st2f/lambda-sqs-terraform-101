# Terraform change count: intended vs. dependency-induced updates

Example:

```text
Plan: 1 to add, 2 to change, 0 to destroy.
```

The changes are:

1. `aws_sqs_queue.image_jobs` — real intended change: add the redrive policy.
2. `aws_iam_role_policy.lambda_sqs` — conservative planned update.

Why Terraform reports the IAM update:

- The IAM policy refers to `aws_sqs_queue.image_jobs.arn`
  ([main.tf](../terraform/main.tf)).
- That queue is changing because it gains the redrive policy.
- Terraform consequently postpones evaluating `data.aws_iam_policy_document.lambda_sqs` until apply.
- Its resulting JSON becomes `(known after apply)`, so Terraform must
  conservatively plan an IAM policy update.

```terraform
# data.aws_iam_policy_document.lambda_sqs will be read during apply
  # (depends on a resource or a module with changes pending)
<= data "aws_iam_policy_document" "lambda_sqs" {
      ...
    }
```

This is not adding DLQ access to Lambda. The planned policy still contains only:

```text
sqs:DeleteMessage
sqs:GetQueueAttributes
sqs:ReceiveMessage
```

and only the source queue ARN—not the DLQ ARN. In the recorded apply, the
document recomputed to the same policy and Terraform reported:

```text
Apply complete! Resources: 1 added, 1 changed, 0 destroyed.
```

Only the source queue was actually changed. The planned IAM update disappeared
once its deferred input became known, illustrating that the plan's change count
can be conservative when values are deferred until apply.

```text
1 add:
  DLQ

2 changes:
  source queue redrive policy       ← intentional functional change
  Lambda SQS IAM inline policy      ← dependency-induced possible rewrite
```
