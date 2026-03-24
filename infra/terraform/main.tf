terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_vpc" "ubar" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "ubar-vpc"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.ubar.id
  cidr_block              = var.public_subnet_a_cidr
  availability_zone       = var.az_a
  map_public_ip_on_launch = true

  tags = {
    Name = "ubar-public-a"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.ubar.id
  cidr_block        = var.private_subnet_a_cidr
  availability_zone = var.az_a

  tags = {
    Name = "ubar-private-a"
  }
}

resource "aws_s3_bucket" "backups" {
  bucket = var.backup_bucket_name

  tags = {
    Name = "ubar-backups"
  }
}

resource "aws_db_subnet_group" "ubar" {
  name       = "ubar-db-subnet-group"
  subnet_ids = [aws_subnet.private_a.id]

  tags = {
    Name = "ubar-db-subnet-group"
  }
}

resource "aws_db_instance" "ubar" {
  identifier             = "ubar-postgres"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  db_name                = var.db_name
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.ubar.name
  skip_final_snapshot    = true
  publicly_accessible    = false
  backup_retention_period = 7

  tags = {
    Name = "ubar-postgres"
  }
}
