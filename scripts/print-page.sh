#!/bin/bash
# print-page.sh <url> <winId> [print|save]
#
# Render a webpage and print (or save) it, guarding against bot walls and
# blank headless renders. Three tiers:
#   1. headless `playwright pdf` — invisible; works on non-walled sites
#   2. headed 1x1 playwright-cli session — real Chrome window (nearly
#      invisible), better fingerprint → passes most bot walls; persistent
#      profile accumulates clearance cookies over time
#   3. window-scoped `screencapture -l<winId>` — the real visible page
#
# Prints "MODE=pdf|window-capture" then "PRINTED: <path>" or "SAVED: <path>".

URL="$1"
WINID="$2"
MODE="${3:-print}"

if [ -z "$URL" ]; then
  echo "usage: print-page.sh <url> <winId> [print|save]" >&2
  exit 2
fi

# Host sanity gate — reject garbage before any network attempt. A bad host
# (e.g. "4.2" from a star rating → inet 4.0.0.2) would otherwise hang a whole
# tier on connection timeout.
HOST=$(printf '%s' "$URL" | sed -E 's|^[a-zA-Z]+://||; s|/.*$||; s|:.*$||')
if [ "$HOST" != "localhost" ] \
   && ! printf '%s' "$HOST" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' \
   && ! printf '%s' "$HOST" | grep -qE '\.[a-zA-Z]{2,63}$'; then
  echo "ERROR: '$HOST' is not a plausible host — refusing to render" >&2
  exit 2
fi

f="/tmp/thinkdrop_page_$(date +%s).pdf"
sess="td$$"

# true when $f is missing, bot-walled, or implausibly small (blank render)
walled() {
  [ ! -f "$f" ] && return 0
  grep -aqE "Just a moment|challenges\.cloudflare\.com|Verify you are human" "$f" 2>/dev/null && return 0
  [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -le 12000 ]
}

# Run a command with a hard deadline — macOS has no GNU timeout.
deadline() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}

trap 'playwright-cli -s=$sess close >/dev/null 2>&1' EXIT

# playwright-cli drops .playwright-cli/ artifacts (snapshots, console logs)
# into cwd — keep them in a temp dir.
workdir="/tmp/td-print-$$"
mkdir -p "$workdir" && cd "$workdir" || exit 1

# ── Tier 1: headless playwright pdf (≤15s) ──────────────────────────────────
deadline 15 playwright pdf --channel chrome --wait-for-timeout 3500 "$URL" "$f" 2>/dev/null

# ── Tier 2: headed 1x1 Chrome — passes most bot walls ───────────────────────
if walled; then
  deadline 20 playwright-cli -s=$sess open --browser chrome --headed --persistent \
    --profile "$HOME/.thinkdrop/print-profile" "$URL" >/dev/null 2>&1
  deadline 5 playwright-cli -s=$sess resize 1 1 >/dev/null 2>&1
  sleep 3
  deadline 12 playwright-cli -s=$sess pdf --filename "$f" >/dev/null 2>&1
  playwright-cli -s=$sess close >/dev/null 2>&1
fi

# ── Tier 3: window-scoped screenshot of the real visible page ────────────────
if walled; then
  f="/tmp/thinkdrop_page_$(date +%s).png"
  if [ -n "$WINID" ]; then
    screencapture -l"$WINID" -o -x "$f"
  else
    screencapture -x "$f"
  fi
  echo "MODE=window-capture"
else
  echo "MODE=pdf"
fi

if [ "$MODE" = "print" ]; then
  lp "$f" && echo "PRINTED: $f"
else
  echo "SAVED: $f"
fi
