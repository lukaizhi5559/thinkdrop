'use strict';
/**
 * shared/agent-canonical.cjs — canonical agent map, dependency-free.
 *
 * Service-specific agents that share one authentication/profile collapse to a
 * canonical parent agent (one browser profile → one session). Used by:
 *   - stategraph resolveAgent (prevents phantom per-service agents)
 *   - main.js planRunner (canonical agentId → agentLock serializes same-session
 *     plan tasks even when a plan marks them parallel)
 *   - comms-graph planPreflight (auth checks against the canonical ledger key)
 *
 * NOTE: gmail.agent is NOT mapped to google.agent — it has separate auth.
 */
const AGENT_CANONICAL_MAP = {
  'google_docs.agent': 'google.agent',
  'google_sheets.agent': 'google.agent',
  'google_calendar.agent': 'google.agent',
  'google_drive.agent': 'google.agent',
  'google_slides.agent': 'google.agent',
};

/**
 * @param {string|null|undefined} agentId
 * @returns {string|null} canonical agentId (identity when unmapped/empty)
 */
function canonicalAgent(agentId) {
  if (!agentId) return agentId || null;
  const a = String(agentId).trim().toLowerCase();
  return AGENT_CANONICAL_MAP[a] || agentId;
}

module.exports = { AGENT_CANONICAL_MAP, canonicalAgent };
