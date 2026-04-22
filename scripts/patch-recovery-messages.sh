#!/bin/bash
# Patches old recovery messages stored as role='assistant' → role='system'
# Run this ONLY when the conversation-service is stopped (DuckDB requires exclusive lock).
#
# Usage:
#   ./scripts/patch-recovery-messages.sh

DB_PATH="$(dirname "$0")/../mcp-services/conversation-service/data/conversation.duckdb"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database not found at: $DB_PATH"
  exit 1
fi

echo "🔧 Patching recovery messages in: $DB_PATH"

duckdb "$DB_PATH" <<'SQL'
UPDATE conversation_messages
SET role = 'system'
WHERE role = 'assistant'
AND (
     content LIKE '%returned a navigation%welcome page%'
  OR content LIKE '%requires login or redirected%'
  OR content LIKE '%automatic search fallbacks failed%'
  OR content LIKE '%all auto-fallbacks%'
  OR content LIKE '%Which alternative source should I try%'
);

SELECT
  CASE WHEN count(*) = 0 THEN '✅ No rows updated (already clean or no matches)'
       ELSE '✅ Updated ' || count(*) || ' row(s) from assistant → system'
  END AS result
FROM (
  SELECT 1 FROM conversation_messages
  WHERE role = 'system'
  AND (
       content LIKE '%returned a navigation%welcome page%'
    OR content LIKE '%requires login or redirected%'
    OR content LIKE '%automatic search fallbacks failed%'
    OR content LIKE '%all auto-fallbacks%'
    OR content LIKE '%Which alternative source should I try%'
  )
) t;
SQL

echo "Done."
