#!/bin/sh
set -eu

python -m uvicorn app:app \
  --app-dir /app/agent_provenance_backend \
  --host 127.0.0.1 \
  --port 8008 &

exec node /app/agent_provenance_react/server.js
