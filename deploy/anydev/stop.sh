#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION_NAME="forgeax-task-board"

set -a
source "$APP_DIR/.env"
set +a

PORT="${PORT:-19080}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
  for _ in {1..50}; do
    if ! ss -lnt | awk '{print $4}' | grep -Eq "(^|:)$PORT$"; then
      echo "Task Board stopped"
      exit 0
    fi
    sleep 0.1
  done
  echo "Task Board session stopped but port $PORT is still in use" >&2
  exit 1
else
  echo "Task Board is not running"
fi
