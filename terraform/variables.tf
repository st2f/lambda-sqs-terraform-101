variable "aws_region" {
  description = "AWS region in which to create the lab resources."
  type        = string
  default     = "eu-north-1"
}

variable "project_name" {
  description = "Name used as a prefix for the lab resources."
  type        = string
  default     = "lambda-sqs-terraform-101"
}

variable "environment" {
  description = "Environment label used in resource names and tags."
  type        = string
  default     = "dev"
}
