# Terraform Baseline (AWS)

This Terraform baseline prepares cloud infrastructure for running Ubar at scale.

## Included components

- VPC with public/private subnets
- EKS cluster skeleton
- RDS PostgreSQL skeleton
- S3 bucket for backups

## Usage

```bash
cd infra/terraform
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

## Notes

- Fill `terraform.tfvars` with your real AWS/account values.
- This is a secure baseline intended to be expanded per environment.
