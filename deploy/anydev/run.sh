#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$APP_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

mkdir -p "$APP_DIR/data"

while true; do
  echo "[$(date -Is)] starting task board" >> "$APP_DIR/data/supervisor.log"
  set +e
  /usr/local/bin/bun "$APP_DIR/server.ts" >> "$APP_DIR/data/server.log" 2>> "$APP_DIR/data/server-error.log"
  exit_code=$?
  set -e
  echo "[$(date -Is)] task board exited with $exit_code; restarting in 2 seconds" >> "$APP_DIR/data/supervisor.log"
  sleep 2
done
