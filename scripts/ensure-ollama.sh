#!/bin/bash

# ThinkDrop - Ensure Ollama is running for local decision inference
#
# Called by start-services.sh before phi4 boots (phi4's decision.answer
# route talks to Ollama at OLLAMA_HOST). Fail-open at every step: if Ollama
# can't be brought up, decision.answer returns DECISION_UNAVAILABLE and
# callers fall back to the remote backend — nothing else breaks.
#
# Env:
#   OLLAMA_HOST        (default http://localhost:11434)
#   DECISION_MODEL     (default: RAM-tier pick — mirrors phi4 decision.js)
#   DECISION_MODEL_SMALL / _MID / _LARGE   tier overrides
#   SKIP_OLLAMA_PULL=1 skip `ollama pull` (offline machines)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PIDS_FILE="${PIDS_FILE:-$PROJECT_ROOT/.service-pids}"
mkdir -p "$PROJECT_ROOT/logs"

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
OLLAMA_PORT="$(echo "$OLLAMA_HOST" | sed -E 's|.*:([0-9]+).*|\1|')"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))

echo "🧠 Ensuring Ollama (local decision model backend)..."

# 1. Binary present?
if ! command -v ollama >/dev/null 2>&1; then
    echo "   ⚠️  ollama not installed — decision.answer will fall back to remote."
    echo "      Install: brew install ollama"
    exit 0
fi

# 2. Version check — decision.answer relies on format:'json' + keep_alive.
#    Warn rather than auto-upgrade a brew-managed install.
MIN_OLLAMA="0.3.5"
OLLAMA_VER="$(ollama --version 2>/dev/null | sed -E 's/[^0-9.]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
if [ -n "$OLLAMA_VER" ]; then
    if [ "$(printf '%s\n%s\n' "$MIN_OLLAMA" "$OLLAMA_VER" | sort -V | head -1)" != "$MIN_OLLAMA" ]; then
        echo "   ⚠️  ollama $OLLAMA_VER is old (<$MIN_OLLAMA) — run: brew upgrade ollama"
    else
        echo "   version $OLLAMA_VER ✅"
    fi
fi

# 3. Server up?
if ! curl -sf --max-time 2 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
    echo "   starting ollama serve..."
    nohup ollama serve > "$PROJECT_ROOT/logs/ollama.log" 2>&1 &
    OLLAMA_PID=$!
    echo "ollama:$OLLAMA_PID" >> "$PIDS_FILE"
    # Wait for readiness (≤15s — model dir scan can take a moment)
    for _ in $(seq 1 15); do
        curl -sf --max-time 1 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1 && break
        sleep 1
    done
    if curl -sf --max-time 2 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
        echo "   ✅ ollama serve up (PID $OLLAMA_PID)"
    else
        echo "   ⚠️  ollama serve did not respond within 15s — decision.answer will fall back to remote"
        exit 0
    fi
else
    echo "   already running ✅"
fi

# 4. Decision model pulled? Mirrors phi4's tier selection so the pulled model
#    matches what decision.answer will request.
pick_model() {
    if [ -n "${DECISION_MODEL:-}" ]; then echo "$DECISION_MODEL"; return; fi
    if [ "$RAM_GB" -lt 12 ]; then echo "${DECISION_MODEL_SMALL:-tev1:0.8b}"
    elif [ "$RAM_GB" -lt 24 ]; then echo "${DECISION_MODEL_MID:-d3:2b}"
    else echo "${DECISION_MODEL_LARGE:-nimble:latest}"; fi
}
MODEL="$(pick_model)"

if [ "${SKIP_OLLAMA_PULL:-0}" = "1" ]; then
    echo "   SKIP_OLLAMA_PULL=1 — not checking model"
elif ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$MODEL"; then
    echo "   model $MODEL present ✅"
else
    echo "   pulling $MODEL (one-time download)..."
    if ollama pull "$MODEL" > "$PROJECT_ROOT/logs/ollama-pull.log" 2>&1; then
        echo "   ✅ $MODEL pulled"
    else
        echo "   ⚠️  pull failed — check logs/ollama-pull.log; decision.answer falls back to remote"
    fi
fi

echo ""
