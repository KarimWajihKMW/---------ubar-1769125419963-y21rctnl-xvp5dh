#!/usr/bin/env bash
set -euo pipefail

RUN_TESTS="${RUN_TESTS:-1}"
RUN_BUILD="${RUN_BUILD:-1}"
RUN_GH_PRECHECK="${RUN_GH_PRECHECK:-1}"

score=0
max_score=4
issues=()

step_ok() {
  local label="$1"
  echo "OK  ${label}"
  score=$((score + 1))
}

step_fail() {
  local label="$1"
  local reason="$2"
  echo "FAIL ${label}: ${reason}"
  issues+=("${label}: ${reason}")
}

echo "Readiness evaluation started"

echo "Checking repository sync status..."
if git fetch origin main --quiet 2>/dev/null; then
  local_head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse origin/main)"
  if [[ "${local_head}" == "${remote_head}" ]]; then
    step_ok "git_main_sync"
  else
    step_fail "git_main_sync" "local HEAD differs from origin/main"
  fi
else
  step_fail "git_main_sync" "unable to fetch origin/main"
fi

if [[ "${RUN_TESTS}" == "1" ]]; then
  echo "Running gateway integration test..."
  if npm run test:gateway >/tmp/readiness-test.log 2>&1; then
    step_ok "test_gateway"
  else
    step_fail "test_gateway" "npm run test:gateway failed"
    tail -n 20 /tmp/readiness-test.log || true
  fi
else
  echo "SKIP test_gateway (RUN_TESTS=0)"
  max_score=$((max_score - 1))
fi

if [[ "${RUN_BUILD}" == "1" ]]; then
  echo "Running build check..."
  if npm run build >/tmp/readiness-build.log 2>&1; then
    step_ok "build"
  else
    step_fail "build" "npm run build failed"
    tail -n 20 /tmp/readiness-build.log || true
  fi
else
  echo "SKIP build (RUN_BUILD=0)"
  max_score=$((max_score - 1))
fi

if [[ "${RUN_GH_PRECHECK}" == "1" ]]; then
  echo "Running GitHub precheck..."
  if npm run precheck:prod:github >/tmp/readiness-gh.log 2>&1; then
    step_ok "github_dispatch_access"
  else
    step_fail "github_dispatch_access" "missing GitHub permissions/scopes for workflow dispatch"
    tail -n 20 /tmp/readiness-gh.log || true
  fi
else
  echo "SKIP github_dispatch_access (RUN_GH_PRECHECK=0)"
  max_score=$((max_score - 1))
fi

if [[ "${max_score}" -le 0 ]]; then
  percent=0
else
  percent=$((score * 100 / max_score))
fi

echo
echo "Readiness score: ${percent}% (${score}/${max_score})"

if [[ "${percent}" -eq 100 ]]; then
  echo "Status: 100% ready for production go-live verification."
  exit 0
fi

echo "Status: not yet 100%."
if [[ "${#issues[@]}" -gt 0 ]]; then
  echo "Open issues:"
  for item in "${issues[@]}"; do
    echo "- ${item}"
  done
fi

exit 1
