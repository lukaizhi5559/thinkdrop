#!/bin/bash
# Auto-restarting wrapper for command-service (port 3007).
#
# Toggle:
#   THINKDROP_SUPERVISE_COMMAND=1  → supervised mode (auto-restart on crash, prod-like)
#   unset / =0                     → dev mode (run node once, let crashes surface)
#
# Dev mode is the default so crashes stay loud and visible during development.
# In dev mode this script `exec`s node directly, so the recorded PID IS the
# node process and existing stop/pkill logic is unchanged.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_PATH="$PROJECT_ROOT/mcp-services/command-service"
LOG_FILE="$PROJECT_ROOT/logs/command.log"
MAX_LOG_SIZE=$((50 * 1024 * 1024))  # 50MB

# Rotate log if it exceeds MAX_LOG_SIZE (checked on each start/restart)
_rotate_log() {
  if [ -f "$LOG_FILE" ]; then
    local file_size
    file_size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$file_size" -gt "$MAX_LOG_SIZE" ]; then
      mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d_%H%M%S).old"
      echo "[$(date)] Rotated command.log (was ${file_size} bytes)" >> "$LOG_FILE"
    fi
  fi
}

_rotate_log

cd "$SERVICE_PATH"
export NODE_OPTIONS="--max-old-space-size=256"

if [ "${THINKDROP_SUPERVISE_COMMAND:-0}" != "1" ]; then
  # Dev mode: run once, let crashes surface.
  exec node src/server.cjs >> "$LOG_FILE" 2>&1
fi

# Supervised mode: restart with backoff + crash cap.
CRASHES=0
while true; do
  _rotate_log
  node src/server.cjs >> "$LOG_FILE" 2>&1
  EXIT=$?
  [ $EXIT -eq 0 ] && CRASHES=0
  CRASHES=$((CRASHES+1))
  if [ $CRASHES -ge 10 ]; then
    echo "[$(date)] command-service crashed 10x — giving up. See $LOG_FILE" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] command-service exited ($EXIT) — restarting in ${CRASHES}s (crash #$CRASHES)" >> "$LOG_FILE"
  sleep $CRASHES
done
