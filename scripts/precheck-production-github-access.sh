#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_FILE="${WORKFLOW_FILE:-production-release-gate.yml}"
REF_BRANCH="${REF_BRANCH:-main}"

if ! command -v gh >/dev/null 2>&1; then
  echo "FAIL: GitHub CLI (gh) is not installed." >&2
  exit 1
fi

echo "Checking GitHub CLI authentication..."
if ! gh auth status >/dev/null 2>&1; then
  echo "FAIL: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

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
  echo "Hint: if you see 403, grant token/user Actions write access (workflow scope) and repo access." >&2
  exit 1
fi

echo "Checking latest run can be queried..."
if ! gh run list --repo "${REPO}" --workflow "${WORKFLOW_FILE}" --limit 1 >/dev/null 2>&1; then
  echo "FAIL: Workflow dispatched but run list is inaccessible. Check Actions read permission." >&2
  exit 1
fi

echo "PASS: GitHub Actions access is ready for production release gate."
