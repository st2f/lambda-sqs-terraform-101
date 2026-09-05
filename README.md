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
