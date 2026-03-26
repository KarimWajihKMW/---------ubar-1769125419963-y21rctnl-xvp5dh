#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-ubar}"
SECRET_NAME="${SECRET_NAME:-ubar-secrets}"

required_vars=(
  DATABASE_URL
  JWT_SECRET
  METRICS_TOKEN
  BILLING_WEBHOOK_SECRET
  PAYMENT_WEBHOOK_SECRET
)

for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing required env var: ${v}" >&2
    exit 1
  fi
done

kubectl -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --from-literal=JWT_SECRET="${JWT_SECRET}" \
  --from-literal=METRICS_TOKEN="${METRICS_TOKEN}" \
  --from-literal=BILLING_WEBHOOK_SECRET="${BILLING_WEBHOOK_SECRET}" \
  --from-literal=PAYMENT_WEBHOOK_SECRET="${PAYMENT_WEBHOOK_SECRET}" \
  --from-literal=STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}" \
  --from-literal=STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret ${SECRET_NAME} synced in namespace ${NAMESPACE}."
