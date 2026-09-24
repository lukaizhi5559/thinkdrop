#!/bin/bash
# print-page.sh <url> <winId> [print|save]
#
# Render a webpage and print (or save) it, guarding against bot walls and
# blank headless renders. Three tiers:
#   1. headless playwright-cli session — DOM wall-check before pdf
#   2. headed 1x1 playwright-cli session — real Chrome window (nearly
#      invisible), better fingerprint + persistent profile cookies →
#      passes most bot walls (verified: Google SERP, Cloudflare recipes)
#   3. window-scoped `screencapture -l<winId>` — the real visible page
#
# Wall detection happens on the DOM (title/innerText/landed URL) — PDF bytes
# are compressed and unreadable to grep. Byte-grep + link-annotation count
# remain as backstops on the finished PDF.
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
sess1="tdh$$"
sess2="tdf$$"

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

# Bot-wall markers checked against the live DOM — Cloudflare, Google CAPTCHA
# (/sorry/index), consent interstitials, and generic verification walls.
WALL_RE='just a moment|verify you are human|challenges\.cloudflare\.com|cf-chl|cf_chl|unusual traffic|not a robot|recaptcha|sorry/index|attention required|access denied|pardon our interruption|are you a robot|consent\.[a-z-]+\.[a-z]{2,}'

# One-line JSON {t,b,u} for the session's current page, or empty on failure.
page_json() {
  deadline 10 playwright-cli -s="$1" eval 'JSON.stringify({t:document.title,b:(document.body&&document.body.innerText||"").slice(0,2000),u:location.href})' 2>/dev/null \
    | awk '/^### Result/{getline; print; exit}'
}

# true when the DOM JSON shows a bot wall (or is empty — no usable page).
dom_walled() {
  [ -z "$1" ] && return 0
  printf '%s' "$1" | grep -aqiE "$WALL_RE"
}

# true when $f is a plausible real-page PDF: exists, >12KB, no byte-visible
# wall markers, and has link annotations (a ≤2-page PDF with zero /URI
# annotations is almost always a wall/consent page).
pdf_ok() {
  [ -f "$f" ] || return 1
  [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -gt 12000 ] || return 1
  ! grep -aqE "Just a moment|challenges\.cloudflare\.com|Verify you are human|unusual traffic|recaptcha|sorry/index" "$f" 2>/dev/null || return 1
  local uris pages
  uris=$(strings "$f" | grep -c 'URI')
  pages=$(strings "$f" | grep -c '/Type /Page')
  if [ "$uris" -eq 0 ] && [ "$pages" -le 2 ]; then return 1; fi
  return 0
}

trap 'playwright-cli -s=$sess1 close >/dev/null 2>&1; playwright-cli -s=$sess2 close >/dev/null 2>&1' EXIT

# playwright-cli drops .playwright-cli/ artifacts (snapshots, console logs)
# into cwd — keep them in a temp dir.
workdir="/tmp/td-print-$$"
mkdir -p "$workdir" && cd "$workdir" || exit 1

# ── Tier 1: headless playwright-cli (≤35s) ──────────────────────────────────
deadline 20 playwright-cli -s="$sess1" open --browser chrome "$URL" >/dev/null 2>&1
J1=$(page_json "$sess1")
if ! dom_walled "$J1"; then
  sleep 1
  deadline 12 playwright-cli -s="$sess1" pdf --filename "$f" >/dev/null 2>&1
fi
playwright-cli -s="$sess1" close >/dev/null 2>&1

# ── Tier 2: headed 1x1 Chrome + persistent profile — passes most walls ──────
if ! pdf_ok; then
  rm -f "$f"
  deadline 25 playwright-cli -s="$sess2" open --browser chrome --headed --persistent \
    --profile "$HOME/.thinkdrop/print-profile" "$URL" >/dev/null 2>&1
  deadline 5 playwright-cli -s="$sess2" resize 1 1 >/dev/null 2>&1
  sleep 2
  J2=$(page_json "$sess2")
  if ! dom_walled "$J2"; then
    deadline 12 playwright-cli -s="$sess2" pdf --filename "$f" >/dev/null 2>&1
  fi
  playwright-cli -s="$sess2" close >/dev/null 2>&1
fi

# ── Tier 3: window-scoped screenshot of the real visible page ────────────────
if ! pdf_ok; then
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
