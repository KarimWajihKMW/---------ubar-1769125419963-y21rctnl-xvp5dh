#!/usr/bin/env bash
set -euo pipefail

issues=()

ok() {
  echo "OK  $1"
}

fail() {
  echo "FAIL $1: $2"
  issues+=("$1: $2")
}

echo "Live readiness precheck"

if [[ -z "${GATEWAY_BASE_URL:-}" ]]; then
  fail "gateway_base_url" "missing GATEWAY_BASE_URL"
else
  base="${GATEWAY_BASE_URL%/}"
  if curl -fsS --max-time 6 "${base}/health" >/tmp/readiness-live-health.json 2>/tmp/readiness-live-health.err; then
    ok "gateway_health"
  else
    err="$(tail -n 1 /tmp/readiness-live-health.err 2>/dev/null || echo 'health endpoint unreachable')"
    fail "gateway_health" "${err}"
  fi
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "gh_cli" "GitHub CLI is not installed"
else
  ok "gh_cli"
fi

if [[ -z "${GH_PAT:-}" ]]; then
  fail "gh_pat" "missing GH_PAT (token with repo and workflow scopes)"
else
  scopes_headers="$(env GITHUB_TOKEN="${GH_PAT}" gh api -i /user 2>/tmp/readiness-live-gh.err || true)"
  if [[ -z "${scopes_headers}" ]]; then
    err="$(tail -n 1 /tmp/readiness-live-gh.err 2>/dev/null || echo 'cannot query GitHub API with GH_PAT')"
    fail "gh_pat_auth" "${err}"
  else
    scopes_line="$(printf '%s\n' "${scopes_headers}" | grep -i '^x-oauth-scopes:' | head -n 1 || true)"
    scopes_csv="$(printf '%s' "${scopes_line}" | cut -d ':' -f2- | tr -d '\r' | tr -d ' ')"
    if [[ ",${scopes_csv}," == *",repo," && ",${scopes_csv}," == *",workflow," ]]; then
      ok "gh_pat_scopes"
    else
      fail "gh_pat_scopes" "required scopes repo,workflow missing (detected: ${scopes_csv:-none})"
    fi
  fi
fi

if [[ "${#issues[@]}" -gt 0 ]]; then
  echo
  echo "Live readiness failed."
  for item in "${issues[@]}"; do
    echo "- ${item}"
  done
  echo
  echo "Next command after fixing failures:"
  echo "GH_PAT=<token-with-repo-and-workflow-scopes> GATEWAY_BASE_URL=https://<gateway-host> npm run go-live:prod"
  exit 1
fi

echo
echo "Live readiness passed."
echo "Run now: GH_PAT=<token-with-repo-and-workflow-scopes> GATEWAY_BASE_URL=${GATEWAY_BASE_URL%/} npm run go-live:prod"
