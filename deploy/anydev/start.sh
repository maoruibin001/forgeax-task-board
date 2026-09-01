#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$APP_DIR/.env"
SESSION_NAME="forgeax-task-board"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; copy deploy/anydev/env.example and set a unique password." >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

PORT="${PORT:-19080}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if curl -fsS --max-time 2 --user "$TASK_BOARD_AUTH_USER:$TASK_BOARD_AUTH_PASSWORD" "http://127.0.0.1:$PORT/api/summary" >/dev/null; then
    echo "Task Board is already running in tmux session $SESSION_NAME"
    exit 0
  fi
  tmux kill-session -t "$SESSION_NAME"
fi

if ss -lnt | awk '{print $4}' | grep -Eq "(^|:)$PORT$"; then
  echo "Port $PORT is already in use" >&2
  exit 1
fi

mkdir -p "$APP_DIR/data"
if [[ ! -f "$APP_DIR/data/tasks.json" ]]; then
  printf '[]\n' > "$APP_DIR/data/tasks.json"
fi

tmux new-session -d -s "$SESSION_NAME" "$APP_DIR/deploy/anydev/run.sh"

for _ in {1..50}; do
  if curl -fsS --max-time 1 --user "$TASK_BOARD_AUTH_USER:$TASK_BOARD_AUTH_PASSWORD" "http://127.0.0.1:$PORT/api/summary" >/dev/null 2>&1; then
    echo "Task Board started on $TASK_BOARD_HOST:$PORT with required tag $TASK_BOARD_REQUIRED_TAG"
    exit 0
  fi
  sleep 0.1
done

echo "Task Board failed to become ready; inspect data/server-error.log" >&2
exit 1
