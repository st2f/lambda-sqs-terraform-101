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

- `npm run invoke` — invoke the handler locally with the example event.
- `npm test` — run the handler test once with Vitest.
- `npm run typecheck` — ask TypeScript to check the project without emitting
  JavaScript.
- `npm run check` — run both the type checker and tests.
