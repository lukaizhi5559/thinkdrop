'use strict';
/**
 * turn-facts.cjs — compute routing truth ONCE, consume everywhere.
 *
 * Same pattern as stategraph's taskFacts (preflightAgents.js:905): several
 * layers used to re-derive "what is this turn" from raw prompt text and could
 * disagree — critically, context blobs ([Highlighted:…], [File:…], [Folder:…],
 * [Context:…], [Thought:…]) ride INSIDE the prompt, so matchers that ran on
 * raw text fired on quoted/attached content (observed: a highlighted "My
 * current plan…" rerouted a vocab question to status_check; an inline exit
 * phrase inside a selection printed "Planning mode isn't on right now.").
 *
 * Rules for consumers:
 *   - match/control decisions read `userText` (blob-stripped) or a computed
 *     verdict field — NEVER rawText;
 *   - rawText + attachments are for answering nodes that need the content;
 *   - a lexical fact that overrides a lane/agent/exit still needs a semantic
 *     verdict (decision.confirmJudgment) — facts answer shape, not meaning.
 */

const {
  ATTACHMENT_TAG_RE,
  FILE_REF_TAG_LINE_RE,
} = require('./text-patterns.cjs');
const {
  PLANNING_EXIT_RE,
  PLANNING_EXIT_INLINE_RE,
  PLANNING_EXIT_NEG_RE,
  PLAN_CONFIRM_RE,
  PLAN_RUN_RE,
  PLAN_RUN_NEG_RE,
} = require('./plan-check-phrases.cjs');

// Matches main.js's PLAN_CANCEL_RE — keep in sync (src/main/main.js).
const CANCEL_RE = /\bcancel\b|\bnever ?mind\b|\bforget (?:it|that|this)\b|\babort\b|\bstop (?:it|this|that|everything|the plan)\b/i;
const CANCEL_NEG_RE = /(don'?t|do not)\s+(?:cancel|abort|stop)/i;

const _ATTACH_RE = /\[(File|Folder|Context|Thought|Highlighted):\s*([^\]]*)\]/gi;

/** Plan referent — same shapes server.cjs used, but on userText only. */
function _planRef(userText) {
  const s = String(userText || '');
  const m = s.match(/\bthe\s+([\w][\w .-]{0,40}?)\s+plan\b/i)
    || s.match(/\bplan\s+(?:for|about|on)\s+([\w][\w .-]{1,40})/i)
    || s.match(/\b([\w][\w .-]{0,40}?)\s+plan\b/i);
  if (!m || !m[1]) return null;
  const token = m[1].trim();
  // "the plan" / "my plan" carries no name — a probe would fuzz-match noise.
  const meaningful = token.split(/[^a-z0-9]+/i).filter(t => t.length > 1 && !/^(the|a|an|my|our|new|next|same|plan)$/i.test(t));
  const informational = /\b(?:thought|think|remember|had|have|has|was|were|is|are|there|what|which|show|tell|do we|did we|find|search|look|any)\b/i.test(s);
  return { token, meaningful: meaningful.length > 0, informational };
}

/**
 * @param {object} o
 * @param {string} o.rawText        full prompt, blobs intact
 * @param {string} [o.selectedText] armed selection text (separate field when known)
 * @param {object} [o.explicitTool] precomputed artifactReferent.resolveExplicitTool result
 * @returns {object} frozen facts — match on these, never on rawText.
 */
function computeTurnFacts({ rawText, selectedText = '', explicitTool = null } = {}) {
  const raw = String(rawText || '');

  const attachments = [];
  for (const m of raw.matchAll(_ATTACH_RE)) {
    attachments.push({ kind: m[1].toLowerCase(), value: m[2].trim() });
  }
  const selLines = String(selectedText || '').split('\n').map(s => s.trim()).filter(s => s.length > 2);
  // Same rule as server.cjs: file/folder chips are path pointers, not content —
  // a selection made only of them isn't self-contained QA context.
  const hasSelectionContext = selLines.length
    ? selLines.some(l => !FILE_REF_TAG_LINE_RE.test(l))
    : attachments.some(a => a.kind !== 'file' && a.kind !== 'folder' && a.value.length > 2);

  // Strip the selected text verbatim first (exact-string removal — a `]` inside
  // the blob would truncate a non-greedy tag regex), then the tag wrappers.
  let userText = raw;
  for (const chunk of selLines) userText = userText.split(chunk).join(' ');
  userText = userText.replace(ATTACHMENT_TAG_RE, ' ').replace(/\s{2,}/g, ' ').trim();

  const t = userText.toLowerCase();
  const wordCount = t ? t.split(/\s+/).length : 0;
  const isQuestion = /\?\s*$/.test(userText)
    || /^(?:what|who|whom|whose|which|when|where|why|how|does|do|did|is|are|was|were|can|could|should|would|will|may|explain|define|describe)\b/i.test(userText);

  const exitish = (PLANNING_EXIT_RE.test(t) || PLANNING_EXIT_INLINE_RE.test(t)) && !PLANNING_EXIT_NEG_RE.test(t);
  const cancelish = CANCEL_RE.test(t) && !CANCEL_NEG_RE.test(t);
  const confirmish = userText.length <= 80
    && /^[\s"'(\[]*(yes|yeah|yep|yup|sure|ok|okay|go|do|run|send|start|proceed|looks? good|sounds? good|let'?s|please|alright|absolutely|definitely|approved?|confirm|fire|ship|launch|execute|kick)\b/i.test(userText)
    && !PLAN_RUN_NEG_RE.test(userText);
  const runish = t.length <= 45 && PLAN_RUN_RE.test(t) && !PLAN_RUN_NEG_RE.test(t);

  return Object.freeze({
    rawText: raw,
    userText,
    attachments,
    hasSelectionContext,
    isQuestion,
    wordCount,
    exitish,
    exitishInline: PLANNING_EXIT_INLINE_RE.test(t) && !PLANNING_EXIT_RE.test(t) && !PLANNING_EXIT_NEG_RE.test(t),
    cancelish,
    confirmish,
    runish,
    planRef: _planRef(userText),
    logMention: /\blogs?\b/i.test(userText),
    explicitTool,
  });
}

module.exports = { computeTurnFacts };
