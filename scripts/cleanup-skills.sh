#!/bin/bash
# cleanup-skills.sh — One-time cleanup of broken skills and recipes
# Phase 0.1: Delete 6 broken trainer recipes (eNN selectors) + 168 auto-generated skill dirs
set -e

SKILLS_DIR="$HOME/.thinkdrop/skills"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "Skills directory does not exist: $SKILLS_DIR"
  exit 0
fi

echo "=== Phase 0.1: Cleaning up skills directory ==="
echo ""

# ── Delete 6 broken trainer recipes (eNN selectors, never work on re-run) ────
BROKEN_RECIPES=(
  "twitter/twitter.post.on.twitter.excited.recipe.json"
  "google_sheets/google_sheets.create.a.new.spreadsheet.recipe.json"
  "google_docs/google_docs.create.a.new.document.recipe.json"
  "notion/notion.create.a.new.page.recipe.json"
  "gmail/gmail.check.for.unread.emails.recipe.json"
  "linkedin/linkedin.post.a.short.update.recipe.json"
)

echo "--- Deleting broken trainer recipes ---"
for recipe in "${BROKEN_RECIPES[@]}"; do
  if [ -f "$SKILLS_DIR/$recipe" ]; then
    echo "  Deleting: $recipe"
    rm "$SKILLS_DIR/$recipe"
  fi
done

# ── Delete all auto-generated skill dirs (skill.json + index.cjs pattern) ────
# These have use_count: 0 — never invoked. Stale selectors from one-time scans.
echo ""
echo "--- Deleting auto-generated skill directories ---"
DELETED_COUNT=0
find "$SKILLS_DIR" -maxdepth 1 -type d | while read dir; do
  [ "$dir" = "$SKILLS_DIR" ] && continue
  if [ -f "$dir/skill.json" ] && [ -f "$dir/index.cjs" ]; then
    echo "  Deleting: $(basename "$dir")"
    rm -rf "$dir"
  fi
done

# ── Delete now-empty service dirs (twitter, gmail, etc.) ─────────────────────
echo ""
echo "--- Deleting empty service directories ---"
find "$SKILLS_DIR" -maxdepth 1 -type d -empty -delete 2>/dev/null || true

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleanup complete ==="
echo "Remaining files in skills dir:"
find "$SKILLS_DIR" -type f 2>/dev/null | wc -l
echo "Remaining dirs in skills dir:"
find "$SKILLS_DIR" -maxdepth 1 -type d 2>/dev/null | wc -l
