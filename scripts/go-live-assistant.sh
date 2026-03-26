#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${GO_LIVE_ENV_FILE:-.env.go-live}"

if [[ -f "${ENV_FILE}" ]]; then
  echo "Loading go-live environment from ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -z "${GATEWAY_BASE_URL:-}" || -z "${GH_PAT:-}" ]]; then
  echo "Missing required values for go-live assistant." >&2
  echo "Required: GATEWAY_BASE_URL and GH_PAT" >&2
  echo "Option 1: export env vars in shell." >&2
  echo "Option 2: create ${ENV_FILE} with:" >&2
  echo "  GATEWAY_BASE_URL=https://<gateway-host>" >&2
  echo "  GH_PAT=<token-with-repo-and-workflow-scopes>" >&2
  exit 1
fi

echo "Running live readiness precheck..."
GH_PAT="${GH_PAT}" GATEWAY_BASE_URL="${GATEWAY_BASE_URL}" npm run readiness:live

echo "Running one-command go-live verification..."
GH_PAT="${GH_PAT}" GATEWAY_BASE_URL="${GATEWAY_BASE_URL}" npm run go-live:prod

echo "Go-live assistant completed successfully."
