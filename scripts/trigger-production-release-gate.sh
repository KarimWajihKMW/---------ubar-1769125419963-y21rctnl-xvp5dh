#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_FILE="production-release-gate.yml"
RUN_LIVE_SMOKE="${RUN_LIVE_SMOKE:-0}"
GATEWAY_BASE_URL_INPUT="${GATEWAY_BASE_URL:-}"
SMOKE_TENANT_ID_INPUT="${SMOKE_TENANT_ID:-public}"
SMOKE_ROLE_INPUT="${SMOKE_ROLE:-support}"
REF_BRANCH="${REF_BRANCH:-main}"
WAIT_FOR_COMPLETION="${WAIT_FOR_COMPLETION:-1}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required to trigger workflows." >&2
  exit 1
fi

if [[ "${RUN_LIVE_SMOKE}" == "1" && -z "${GATEWAY_BASE_URL_INPUT}" ]]; then
  echo "When RUN_LIVE_SMOKE=1, set GATEWAY_BASE_URL." >&2
  exit 1
fi

if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  REPO_ARG=("--repo" "${GITHUB_REPOSITORY}")
else
  REPO_ARG=()
fi

echo "Triggering workflow ${WORKFLOW_FILE} on ref ${REF_BRANCH}..."

gh workflow run "${WORKFLOW_FILE}" \
  "${REPO_ARG[@]}" \
  --ref "${REF_BRANCH}" \
  -f run_live_smoke="$( [[ "${RUN_LIVE_SMOKE}" == "1" ]] && echo true || echo false )" \
  -f gateway_base_url="${GATEWAY_BASE_URL_INPUT}" \
  -f smoke_tenant_id="${SMOKE_TENANT_ID_INPUT}" \
  -f smoke_role="${SMOKE_ROLE_INPUT}"

if [[ "${WAIT_FOR_COMPLETION}" != "1" ]]; then
  echo "Workflow dispatched. Set WAIT_FOR_COMPLETION=1 to watch run status."
  exit 0
fi

sleep 3
RUN_ID="$(gh run list "${REPO_ARG[@]}" --workflow "${WORKFLOW_FILE}" --branch "${REF_BRANCH}" --limit 1 --json databaseId --jq '.[0].databaseId')"

if [[ -z "${RUN_ID}" || "${RUN_ID}" == "null" ]]; then
  echo "Workflow dispatched, but could not resolve run id for watch." >&2
  exit 1
fi

echo "Watching run id ${RUN_ID}..."
gh run watch "${RUN_ID}" "${REPO_ARG[@]}" --exit-status

echo "Production release gate workflow completed successfully."
