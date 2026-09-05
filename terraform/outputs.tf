output "aws_region" {
  description = "AWS region containing the lab resources."
  value       = var.aws_region
}

output "lambda_function_name" {
  description = "Name to use when invoking or inspecting the Lambda."
  value       = aws_lambda_function.image_processor.function_name
}

output "lambda_function_arn" {
  description = "Globally unique AWS identifier for the Lambda function."
  value       = aws_lambda_function.image_processor.arn
}

output "lambda_source_code_hash" {
  description = "Base64-encoded SHA-256 hash of the ZIP Terraform deployed."
  value       = data.archive_file.lambda.output_base64sha256
}

output "lambda_execution_role_arn" {
  description = "IAM role assumed by the Lambda execution environment."
  value       = aws_iam_role.lambda.arn
}

output "lambda_log_group_name" {
  description = "CloudWatch Logs group receiving the Lambda's logs."
  value       = aws_cloudwatch_log_group.lambda.name
}
