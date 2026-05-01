#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/agent_provenance_backend"
FRONTEND_DIR="$ROOT_DIR/agent_provenance_react"
BACKEND_HOST="${PROVENANCE_BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${PROVENANCE_BACKEND_PORT:-8008}"
FRONTEND_PORT="${PROVENANCE_FRONTEND_PORT:-3000}"
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"

cleanup() {
  jobs -p | xargs -r kill
}

trap cleanup EXIT INT TERM

if [ -x "$BACKEND_DIR/.venv/bin/python" ]; then
  PYTHON="$BACKEND_DIR/.venv/bin/python"
else
  PYTHON="${PYTHON:-python3}"
fi

echo "Starting provenance backend at $BACKEND_URL"
(
  cd "$BACKEND_DIR"
  "$PYTHON" -m uvicorn app:app --host "$BACKEND_HOST" --port "$BACKEND_PORT"
) &

echo "Starting React frontend at http://127.0.0.1:${FRONTEND_PORT}"
(
  cd "$FRONTEND_DIR"
  PROVENANCE_BACKEND_URL="$BACKEND_URL" npm run dev -- --port "$FRONTEND_PORT"
) &

wait
