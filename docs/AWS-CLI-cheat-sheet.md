# AWS CLI cheat sheet

Short versions of the commands used throughout the lessons. Run them from the repository root, with Terraform initialized in `terraform/`.

## Pager

AWS CLI v2 pipes terminal output through a pager. If `LESS` is already set (oh-my-zsh sets `LESS=-R`), `less` pages every result and clears the screen when you quit, so the output disappears.

| Option | Effect |
| --- | --- |
| `export AWS_PAGER="less -FRX"` in `~/.zshrc` | Short output prints directly; long output is paged and stays on screen after `q`. `-F` quits if the output fits one screen, `-X` keeps it on screen, and `-R` keeps colors. |
| `export AWS_PAGER=""` | Never page. |
| `--no-cli-pager` | Disable the pager for one command. |

Piped or redirected output, such as `aws ... | jq` or `aws ... > out.json`, is never paged. Terraform does not use a pager.

## Variables

Paste once per shell. Every command below uses these variables:

```bash
TF() { terraform -chdir=terraform output -raw "$1"; }
REGION="$(TF aws_region)"
FUNCTION="$(TF lambda_function_name)"
LOG_GROUP="$(TF lambda_log_group_name)"
QUEUE_URL="$(TF image_jobs_queue_url)"
DLQ_URL="$(TF image_jobs_dead_letter_queue_url)"
FIFO_URL="$(TF image_jobs_fifo_queue_url)"
FIFO_DLQ_URL="$(TF image_jobs_fifo_dead_letter_queue_url)"
```

## How many messages are in each queue?

```bash
for url in "$QUEUE_URL" "$DLQ_URL" "$FIFO_URL" "$FIFO_DLQ_URL"; do
  printf '%-50s ' "${url##*/}"
  aws sqs get-queue-attributes --region "$REGION" --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text
done
```

The first column is **visible**: messages waiting to be received. The second is **in flight**: messages that were received and are hidden by their visibility timeout, neither deleted nor visible yet. Both values are approximate and can lag by a few seconds.

## Queue configuration

```bash
aws sqs get-queue-attributes --region "$REGION" --queue-url "$QUEUE_URL" \
  --attribute-names VisibilityTimeout RedrivePolicy MessageRetentionPeriod
```

## Peek at a message without consuming it

```bash
aws sqs receive-message --region "$REGION" --queue-url "$DLQ_URL" \
  --attribute-names All --max-number-of-messages 1 \
  --visibility-timeout 0 --wait-time-seconds 5 \
  --query 'Messages[0].{MessageId:MessageId,Body:Body,ReceiveCount:Attributes.ApproximateReceiveCount}'
```

`--visibility-timeout 0` makes the message visible again immediately. Each peek still counts as a receive: it increments `ApproximateReceiveCount`, and on a source queue it counts toward `maxReceiveCount`. Do not peek at a source queue while its Lambda mapping is enabled; you would compete with Lambda for the messages.

## Send a test job

```bash
# Standard queue
aws sqs send-message --region "$REGION" --queue-url "$QUEUE_URL" \
  --message-body '{"jobId":"job-manual-1","imageId":"image-456","operation":"resize"}'

# FIFO queue: needs a group ID, and a deduplication ID that is unique within five minutes
aws sqs send-message --region "$REGION" --queue-url "$FIFO_URL" \
  --message-group-id customer-1 --message-deduplication-id "manual-$(date +%s)" \
  --message-body '{"jobId":"job-manual-2","imageId":"image-456","operation":"resize"}'
```

Use `"operation":"unsupported"` to send a poison job.

## Purge a queue

```bash
aws sqs purge-queue --region "$REGION" --queue-url "$DLQ_URL"
```

Purging **permanently deletes every message** in the queue. Peek at the queue first if the messages might matter. Deletion can take up to 60 seconds, and SQS allows one purge per queue every 60 seconds. Replace `$DLQ_URL` with `$QUEUE_URL`, `$FIFO_URL`, or `$FIFO_DLQ_URL` as needed.

## Event source mappings

```bash
aws lambda list-event-source-mappings --region "$REGION" --function-name "$FUNCTION" \
  --query 'EventSourceMappings[].[EventSourceArn,State,BatchSize,MaximumBatchingWindowInSeconds]' \
  --output table
```

`State` should be `Enabled`. Change mappings through Terraform, not the CLI, so the configuration stays the source of truth.

## Lambda configuration

```bash
aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION" \
  --query '{Timeout:Timeout,Memory:MemorySize,Runtime:Runtime,CodeSha256:CodeSha256,LastModified:LastModified}'
```

## Logs

```bash
# Last 10 minutes
aws logs tail "$LOG_GROUP" --region "$REGION" --since 10m --format short

# Follow live; stop with Ctrl-C
aws logs tail "$LOG_GROUP" --region "$REGION" --follow --format short

# One job or run; the filter is a quoted substring
aws logs tail "$LOG_GROUP" --region "$REGION" --since 30m --format short --filter-pattern '"job-25"'

# One line per invocation, ending in "Status: timeout" if the invocation timed out
aws logs tail "$LOG_GROUP" --region "$REGION" --since 30m --format short --filter-pattern '"REPORT"'

# Errors only
aws logs tail "$LOG_GROUP" --region "$REGION" --since 30m --format short --filter-pattern '"ERROR"'
```

## Metrics: the last 15 minutes in one line

The `date -v` syntax is for macOS:

```bash
aws cloudwatch get-metric-statistics --region "$REGION" \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions "Name=FunctionName,Value=$FUNCTION" \
  --start-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Sum \
  --query '{Errors:sum(Datapoints[].Sum),ReportedMinutes:length(Datapoints)}'
```

Use `--metric-name Invocations` the same way, or `Duration` with `--statistics Maximum` and `max(Datapoints[].Maximum)`. For queue metrics, switch to `--namespace AWS/SQS` with `--dimensions "Name=QueueName,Value=${QUEUE_URL##*/}"`. `NumberOfMessagesSent` and `NumberOfMessagesReceived` count events; `ApproximateNumberOfMessagesVisible` is a depth, so read it with `Maximum`.
