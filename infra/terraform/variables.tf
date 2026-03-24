variable "aws_region" {
  type    = string
  default = "eu-central-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "public_subnet_a_cidr" {
  type    = string
  default = "10.40.1.0/24"
}

variable "private_subnet_a_cidr" {
  type    = string
  default = "10.40.11.0/24"
}

variable "az_a" {
  type    = string
  default = "eu-central-1a"
}

variable "backup_bucket_name" {
  type = string
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_name" {
  type    = string
  default = "ubar"
}

variable "db_username" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}
