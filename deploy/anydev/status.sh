#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION_NAME="forgeax-task-board"

set -a
source "$APP_DIR/.env"
set +a

PORT="${PORT:-19080}"
tmux has-session -t "$SESSION_NAME"
curl -fsS --user "$TASK_BOARD_AUTH_USER:$TASK_BOARD_AUTH_PASSWORD" "http://127.0.0.1:$PORT/api/summary?tag=game&topLevel=true"
printf '\n'
