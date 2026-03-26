#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GATEWAY_BASE_URL:-}" ]]; then
  echo "GATEWAY_BASE_URL is required." >&2
  echo "Example: GATEWAY_BASE_URL=https://api.example.com npm run go-live:prod" >&2
  exit 1
fi

echo "Step 1/2: checking GitHub access and token scopes..."
npm run precheck:prod:github

echo "Step 2/2: triggering production release gate with live smoke..."
RUN_LIVE_SMOKE=1 \
GATEWAY_BASE_URL="${GATEWAY_BASE_URL}" \
SMOKE_TENANT_ID="${SMOKE_TENANT_ID:-public}" \
SMOKE_ROLE="${SMOKE_ROLE:-support}" \
npm run trigger:prod:gate

echo "Go-live verification completed successfully."
