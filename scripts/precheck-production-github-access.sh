#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_FILE="${WORKFLOW_FILE:-production-release-gate.yml}"
REF_BRANCH="${REF_BRANCH:-main}"

REQUIRED_SCOPES=("repo" "workflow")

print_missing_scopes() {
  local scopes_csv="$1"
  local missing=()

  for scope in "${REQUIRED_SCOPES[@]}"; do
    if [[ ",${scopes_csv}," != *",${scope},"* ]]; then
      missing+=("${scope}")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "FAIL: Missing required GitHub token scopes: ${missing[*]}" >&2
    echo "Hint: run 'gh auth refresh -h github.com -s repo,workflow' or login with a token that has these scopes." >&2
    exit 1
  fi
}

if ! command -v gh >/dev/null 2>&1; then
  echo "FAIL: GitHub CLI (gh) is not installed." >&2
  exit 1
fi

echo "Checking GitHub CLI authentication..."
if ! gh auth status >/dev/null 2>&1; then
  echo "FAIL: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

echo "Checking GitHub token scopes..."
headers="$(gh api -i /user 2>/dev/null || true)"
if [[ -z "${headers}" ]]; then
  echo "FAIL: Unable to query GitHub API for scope inspection." >&2
  exit 1
fi

scopes_line="$(printf '%s\n' "${headers}" | grep -i '^x-oauth-scopes:' | head -n 1 || true)"
if [[ -z "${scopes_line}" ]]; then
  echo "FAIL: Could not detect x-oauth-scopes header from GitHub API response." >&2
  echo "Hint: ensure gh auth token is PAT/user token and not a restricted integration token." >&2
  exit 1
fi

scopes_csv="$(printf '%s' "${scopes_line}" | cut -d ':' -f2- | tr -d '\r' | tr -d ' ' )"
echo "Detected scopes: ${scopes_csv:-none}"
print_missing_scopes "${scopes_csv}"

if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  REPO="${GITHUB_REPOSITORY}"
else
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi

if [[ -z "${REPO}" ]]; then
  echo "FAIL: Could not resolve repository. Set GITHUB_REPOSITORY=owner/repo." >&2
  exit 1
fi

echo "Repository: ${REPO}"

echo "Checking repository access..."
if ! gh repo view "${REPO}" --json nameWithOwner -q .nameWithOwner >/dev/null 2>&1; then
  echo "FAIL: Cannot access repository ${REPO}. Check account permissions." >&2
  exit 1
fi

echo "Checking workflows visibility..."
if ! gh workflow list --repo "${REPO}" >/dev/null 2>&1; then
  echo "FAIL: Cannot list workflows for ${REPO}. Ensure Actions permissions are granted." >&2
  exit 1
fi

echo "Checking workflow exists..."
if ! gh workflow view "${WORKFLOW_FILE}" --repo "${REPO}" >/dev/null 2>&1; then
  echo "FAIL: Workflow ${WORKFLOW_FILE} not found in ${REPO}." >&2
  exit 1
fi

echo "Checking ability to dispatch workflow..."
if ! gh workflow run "${WORKFLOW_FILE}" --repo "${REPO}" --ref "${REF_BRANCH}" -f run_live_smoke=false >/dev/null 2>&1; then
  echo "FAIL: Unable to dispatch workflow ${WORKFLOW_FILE}." >&2
  echo "Hint: if you see 403, verify repository role has Actions write permission and token scopes include repo + workflow." >&2
  exit 1
fi

echo "Checking latest run can be queried..."
if ! gh run list --repo "${REPO}" --workflow "${WORKFLOW_FILE}" --limit 1 >/dev/null 2>&1; then
  echo "FAIL: Workflow dispatched but run list is inaccessible. Check Actions read permission." >&2
  exit 1
fi

echo "PASS: GitHub Actions access is ready for production release gate."
