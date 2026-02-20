#!/bin/bash

# ThinkDrop - Stop All MCP Services

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "🛑 ThinkDrop - Stopping All MCP Services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PIDS_FILE="$PROJECT_ROOT/.service-pids"

if [ ! -f "$PIDS_FILE" ]; then
    echo "⚠️  No PID file found — killing by process name and port..."
    pkill -f "thinkdrop-user-memory-service" 2>/dev/null || true
    pkill -f "thinkdrop-web-search" 2>/dev/null || true
    pkill -f "conversation-service" 2>/dev/null || true
    pkill -f "coreference-service.*server.py" 2>/dev/null || true
    pkill -f "thinkdrop-phi4-service" 2>/dev/null || true
    pkill -f "command-service.*http-server" 2>/dev/null || true
    pkill -f "screen-intelligence-service" 2>/dev/null || true
else
    # Stop by PID
    while IFS=: read -r service_name pid; do
        echo "🛑 Stopping $service_name (PID: $pid)..."
        if kill -0 $pid 2>/dev/null; then
            kill $pid
            sleep 1
            if kill -0 $pid 2>/dev/null; then
                echo "   ⚠️  Force killing..."
                kill -9 $pid 2>/dev/null || true
            fi
            echo "   ✅ Stopped"
        else
            echo "   ⚠️  Already stopped"
        fi
    done < "$PIDS_FILE"
    rm -f "$PIDS_FILE"
fi

# Final cleanup by port (catches orphaned child processes)
echo ""
echo "🧹 Cleaning up orphaned processes on service ports..."
for port in 3001 3002 3004 3005 3006 3007 3008; do
    lsof -ti:$port | xargs kill -9 2>/dev/null || true
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All services stopped"
echo ""
echo "📝 Logs preserved in ./logs/"
echo "🚀 To restart: yarn start:services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
