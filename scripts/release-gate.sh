#!/usr/bin/env bash
set -euo pipefail

echo "Running production preflight..."
npm run preflight:prod

echo "Running gateway integration tests..."
npm run test:gateway

echo "Running build check..."
npm run build

echo "Release gate passed."
