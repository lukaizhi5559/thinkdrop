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

cd "$SERVICE_PATH"
export NODE_OPTIONS="--max-old-space-size=256"

if [ "${THINKDROP_SUPERVISE_COMMAND:-0}" != "1" ]; then
  # Dev mode: run once, let crashes surface.
  exec node src/server.cjs >> "$LOG_FILE" 2>&1
fi

# Supervised mode: restart with backoff + crash cap.
CRASHES=0
while true; do
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
