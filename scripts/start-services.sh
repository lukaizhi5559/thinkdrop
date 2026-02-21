#!/bin/bash

# ThinkDrop - Start All MCP Services

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "🚀 ThinkDrop - Starting All MCP Services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

mkdir -p logs

PIDS_FILE="$PROJECT_ROOT/.service-pids"
> "$PIDS_FILE"

# Start a Node.js service (yarn dev)
start_node_service() {
    local service_name=$1
    local service_path=$2
    local memory_limit=$3

    echo "📦 Starting $service_name..."

    cd "$service_path"
    export NODE_OPTIONS="--max-old-space-size=$memory_limit"
    yarn dev > "$PROJECT_ROOT/logs/$service_name.log" 2>&1 &
    local pid=$!
    echo "$service_name:$pid" >> "$PIDS_FILE"
    sleep 1

    if kill -0 $pid 2>/dev/null; then
        echo "   ✅ PID $pid"
    else
        echo "   ❌ Failed to start — check logs/$service_name.log"
    fi

    echo ""
    cd "$PROJECT_ROOT"
}

# Start a Node.js service (npm run dev) — for services without yarn
start_npm_service() {
    local service_name=$1
    local service_path=$2
    local memory_limit=$3

    echo "📦 Starting $service_name..."

    cd "$service_path"
    export NODE_OPTIONS="--max-old-space-size=$memory_limit"
    npm run dev > "$PROJECT_ROOT/logs/$service_name.log" 2>&1 &
    local pid=$!
    echo "$service_name:$pid" >> "$PIDS_FILE"
    sleep 1

    if kill -0 $pid 2>/dev/null; then
        echo "   ✅ PID $pid"
    else
        echo "   ❌ Failed to start — check logs/$service_name.log"
    fi

    echo ""
    cd "$PROJECT_ROOT"
}

# Start a Node.js service via 'npm start' (avoids devDep issues like nodemon)
start_npm_start_service() {
    local service_name=$1
    local service_path=$2
    local memory_limit=$3

    echo "📦 Starting $service_name..."

    cd "$service_path"
    export NODE_OPTIONS="--max-old-space-size=$memory_limit"
    npm start > "$PROJECT_ROOT/logs/$service_name.log" 2>&1 &
    local pid=$!
    echo "$service_name:$pid" >> "$PIDS_FILE"
    sleep 1

    if kill -0 $pid 2>/dev/null; then
        echo "   ✅ PID $pid"
    else
        echo "   ❌ Failed to start — check logs/$service_name.log"
    fi

    echo ""
    cd "$PROJECT_ROOT"
}

# Start a Python service
start_python_service() {
    local service_name=$1
    local service_path=$2

    echo "🐍 Starting $service_name (Python)..."

    cd "$service_path"

    if [ ! -d "venv" ]; then
        echo "   ⚠️  No venv found — run: cd $service_path && ./setup.sh"
        echo ""
        cd "$PROJECT_ROOT"
        return 1
    fi

    if [ -f "src/server.py" ]; then
        venv/bin/python src/server.py > "$PROJECT_ROOT/logs/$service_name.log" 2>&1 &
    elif [ -f "server.py" ]; then
        venv/bin/python server.py > "$PROJECT_ROOT/logs/$service_name.log" 2>&1 &
    else
        echo "   ❌ No server.py found"
        cd "$PROJECT_ROOT"
        return 1
    fi

    local pid=$!
    echo "$service_name:$pid" >> "$PIDS_FILE"
    sleep 1

    if kill -0 $pid 2>/dev/null; then
        echo "   ✅ PID $pid"
    else
        echo "   ❌ Failed to start — check logs/$service_name.log"
    fi

    echo ""
    cd "$PROJECT_ROOT"
}

# ── Pre-flight: kill ALL orphaned MCP service nodemon instances ───────────────
# Multiple restarts leave nodemon orphans; kill them all before starting fresh
for svc in thinkdrop-user-memory-service thinkdrop-phi4-service thinkdrop-web-search conversation-service command-service screen-intelligence-service; do
    pkill -9 -f "${svc}/node_modules/nodemon" 2>/dev/null || true
    pkill -9 -f "${svc}/src/server" 2>/dev/null || true
done
# Release any remaining DuckDB lock holders
DB_FILE="$PROJECT_ROOT/mcp-services/thinkdrop-user-memory-service/data/user_memory.duckdb"
if [ -f "$DB_FILE" ]; then
    lsof "$DB_FILE" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill -9 2>/dev/null || true
fi
sleep 1

# ── Start services in dependency order ──────────────────────────────────────

# 1. User Memory Service — port 3001
start_node_service "user-memory" "$PROJECT_ROOT/mcp-services/thinkdrop-user-memory-service" 512
sleep 2

# 2. Web Search Service — port 3002
start_node_service "web-search" "$PROJECT_ROOT/mcp-services/thinkdrop-web-search" 256
sleep 2

# 3. Conversation Service — port 3004
start_node_service "conversation" "$PROJECT_ROOT/mcp-services/conversation-service" 512
sleep 2

# 4. Coreference Service (Python) — port 3006
start_python_service "coreference" "$PROJECT_ROOT/mcp-services/coreference-service"
sleep 2

# 5. Phi4 Service — port 3005 (heavy, load last among core services)
start_node_service "phi4" "$PROJECT_ROOT/mcp-services/thinkdrop-phi4-service" 768
sleep 3

# 6. Command Service — port 3007 (uses npm start → node src/http-server.cjs, avoids nodemon)
start_npm_start_service "command" "$PROJECT_ROOT/mcp-services/command-service" 256
sleep 2

# 7. Screen Intelligence Service — port 3008 (has own yarn.lock; must use npm)
start_npm_service "screen-intelligence" "$PROJECT_ROOT/mcp-services/screen-intelligence-service" 256
sleep 2

# ── Summary ─────────────────────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All services started!"
echo ""
echo "📊 Health Checks:"
echo "   • User Memory:         http://localhost:3001/service.health"
echo "   • Web Search:          http://localhost:3002/service.health"
echo "   • Conversation:        http://localhost:3004/service.health"
echo "   • Phi4:                http://localhost:3009/service.health"
echo "   • Coreference:         http://localhost:3005/health"
echo "   • Command:             http://localhost:3007/health"
echo "   • Screen Intelligence: http://localhost:3008/service.health"
echo ""
echo "📝 Logs:"
echo "   tail -f logs/*.log"
echo ""
echo "🛑 To stop:  yarn stop:services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
