#!/usr/bin/env bash
set -euo pipefail

echo "Running production preflight..."
npm run preflight:prod

echo "Running gateway integration tests..."
npm run test:gateway

echo "Running build check..."
npm run build

if [[ "${RUN_PROD_SMOKE:-0}" == "1" ]]; then
	if [[ -z "${GATEWAY_BASE_URL:-}" ]]; then
		echo "RUN_PROD_SMOKE=1 but GATEWAY_BASE_URL is not set" >&2
		exit 1
	fi
	echo "Running production smoke checks..."
	npm run smoke:prod
fi

echo "Release gate passed."
