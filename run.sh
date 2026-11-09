#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PY="${AUTOCUT_PYTHON:-python3}"
"$PY" -m pip install -q -r requirements.txt 2>/dev/null || true

exec "$PY" -m uvicorn backend.main:app \
  --host "${AUTOCUT_HOST:-127.0.0.1}" \
  --port "${AUTOCUT_PORT:-8787}" "$@"
