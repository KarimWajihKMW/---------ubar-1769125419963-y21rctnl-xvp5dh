#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GATEWAY_BASE_URL:-}" ]]; then
  echo "GATEWAY_BASE_URL is required." >&2
  echo "Example: GATEWAY_BASE_URL=https://api.example.com npm run go-live:prod" >&2
  exit 1
fi

# Optional: supply a higher-privilege PAT via GH_PAT for workflow dispatch.
if [[ -n "${GH_PAT:-}" ]]; then
  export GITHUB_TOKEN="${GH_PAT}"
fi

echo "Step 1/2: checking GitHub access and token scopes..."
if ! npm run precheck:prod:github; then
  echo
  echo "Go-live blocked at GitHub precheck." >&2
  echo "Fix: provide a token with repo + workflow scopes (use GH_PAT) and retry." >&2
  echo "Example: GH_PAT=<token> GATEWAY_BASE_URL=https://api.example.com npm run go-live:prod" >&2
  exit 1
fi

echo "Step 2/2: triggering production release gate with live smoke..."
RUN_LIVE_SMOKE=1 \
GATEWAY_BASE_URL="${GATEWAY_BASE_URL}" \
SMOKE_TENANT_ID="${SMOKE_TENANT_ID:-public}" \
SMOKE_ROLE="${SMOKE_ROLE:-support}" \
npm run trigger:prod:gate

echo "Go-live verification completed successfully."
