# Lambda + SQS + Terraform 101

This repository is a hands-on lab for learning how a TypeScript and Node.js
backend behaves when AWS Lambda consumes work from Amazon SQS. Terraform keeps
the infrastructure and service relationships explicit, while AWS CLI exercises
make deployed behavior observable.

The image-processing domain is fictional and no images are processed. This is
a learning environment rather than a production template: each increment
isolates one AWS or Terraform behavior and verifies it experimentally.

## Learning path

### 01 Foundations

- Documentation: [docs/01-foundations.md](docs/01-foundations.md)
- Code snapshot: [01-foundations](https://github.com/st2f/lambda-sqs-terraform-101/tree/01-foundations)

1. [Minimal TypeScript Lambda Locally](docs/01-foundations.md#1-minimal-typescript-lambda-locally)
2. [Deploy One Lambda With Terraform](docs/01-foundations.md#2-deploy-one-lambda-with-terraform)
3. [Observe Lambda in AWS](docs/01-foundations.md#3-observe-lambda-in-aws)
4. [Add a Standard SQS Queue With Terraform](docs/01-foundations.md#4-add-a-standard-sqs-queue-with-terraform)
5. [Connect SQS to Lambda](docs/01-foundations.md#5-connect-sqs-to-lambda)
6. [Inspect an Actual SQS Lambda Event](docs/01-foundations.md#6-inspect-an-actual-sqs-lambda-event)
7. [Introduce a Processing Failure](docs/01-foundations.md#7-introduce-a-processing-failure)
8. [Visibility Timeout Versus Lambda Timeout](docs/01-foundations.md#8-visibility-timeout-versus-lambda-timeout)
9. [Add a Dead-Letter Queue](docs/01-foundations.md#9-add-a-dead-letter-queue)

### 02 Failure Recovery

Documentation: [docs/02-failure-recovery.md](docs/02-failure-recovery.md)

10. [Debug a Message in the DLQ](docs/02-failure-recovery.md#10-debug-a-message-in-the-dlq)
11. Redrive a Corrected Message Manually

### Planned sections

- Increments 12–14: batch processing and partial batch responses
- Increments 15–20: failure diagnosis and observability
- Increments 21–24: FIFO behavior and concurrency
- Increments 25–30: Terraform state, drift, testing, and review
- Increments 31–32: optional tooling

## Project commands

- `npm run build` — bundle the SQS handler into `dist/handler.js` for Lambda.
- `npm run invoke` — process the example image job locally.
- `npm test` — run the tests once with Vitest.
- `npm run typecheck` — check TypeScript without emitting JavaScript.
- `npm run check` — run both the type checker and tests.

The detailed documents state each increment's prerequisites, commands in
execution order, and expected observations.
