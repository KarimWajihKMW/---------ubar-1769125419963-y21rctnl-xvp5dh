#!/usr/bin/env bash
set -euo pipefail

# Loads .env if present (kept local; .env is gitignored)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required (set it in .env or env var)}"

# JWT_SECRET is strongly recommended so tokens don't break after restart
if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "⚠️  JWT_SECRET is not set. Tokens will change after restart." >&2
fi

export PORT="${PORT:-3000}"

echo "🚀 Starting server on port $PORT"
node server.js
