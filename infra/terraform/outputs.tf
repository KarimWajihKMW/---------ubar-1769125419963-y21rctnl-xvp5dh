output "vpc_id" {
  value = aws_vpc.ubar.id
}

output "postgres_endpoint" {
  value = aws_db_instance.ubar.address
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}
