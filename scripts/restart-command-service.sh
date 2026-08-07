#!/bin/bash
# Restart just the command-service (port 3007)
# Run this from your terminal whenever command-service needs to pick up code changes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDS_FILE="$PROJECT_ROOT/.service-pids"
LOG_FILE="$PROJECT_ROOT/logs/command.log"
SERVICE_PATH="$PROJECT_ROOT/mcp-services/command-service"

echo "🔄 Restarting command-service..."

# Kill existing command-service process
OLD_PID=$(grep "^command:" "$PIDS_FILE" 2>/dev/null | cut -d: -f2)
if [ -n "$OLD_PID" ]; then
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID"
    echo "   Killed old PID $OLD_PID"
    sleep 1
  fi
  # Remove old entry from pids file
  sed -i '' "/^command:/d" "$PIDS_FILE"
fi

# Also kill any stray node processes running command-service
pkill -f "command-service/src/server.cjs" 2>/dev/null || true
sleep 1

# Start fresh — routed through supervise-command-service.sh so it can
# auto-restart when THINKDROP_SUPERVISE_COMMAND=1 (prod-like). Default
# (unset/0) exec's node directly, so the recorded PID is the node process
# and the pkill above still works.
bash "$SCRIPT_DIR/supervise-command-service.sh" &
NEW_PID=$!
echo "command:$NEW_PID" >> "$PIDS_FILE"
sleep 2

if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "   ✅ command-service started — PID $NEW_PID"
  echo "   📋 Log: tail -f $LOG_FILE"
else
  echo "   ❌ Failed to start — check $LOG_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi
