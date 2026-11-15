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
  PLAN_TIME_PHRASE_RE,
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

/**
 * The "ask" — in a paste+question turn ("<600-char quoted block> … what
 * does X mean?") the request lives in the trailing segment, not the pasted
 * material above it. Matchers may still generate CANDIDATES on full
 * userText, but judgments about intent (confirmJudgment state, control
 * verdicts) must scope to the ask or quoted vocabulary reads as intent
 * (observed: a pasted routing audit containing "AGENTS.md rule" + "what
 * does envelope mean" → rule-author verdict YES → guardian dead end).
 *
 * Short / single-segment text returns whole — zero behavior change for the
 * common case. Multi-segment text returns the trailing line/sentence
 * cluster, expanded backwards while it's a bare fragment ("ok?", "right?").
 */
function deriveRequestText(userText) {
  const t = String(userText || '').trim();
  if (t.length <= 200) return t;
  const segs = t
    .split(/\n+|(?<=[.!?])\s+(?=[-–—•>*"'(\[{~]*\s*[A-Z0-9])/)
    .map(s => s.trim().replace(/^[-–—•>*\s"'(\[{~]+/, ''))
    .filter(Boolean);
  if (segs.length <= 1) return t;
  let out = segs[segs.length - 1];
  for (let i = segs.length - 2; i >= 0 && out.length < 15; i--) {
    out = `${segs[i]} ${out}`;
  }
  return out;
}

const _QUESTION_RE = /^(?:what|who|whom|whose|which|when|where|why|how|does|do|did|is|are|was|were|can|could|should|would|will|may|explain|define|describe)\b/i;

// Plan-existence phrasing — "do we have a plan for X", "i thought we had a
// plan", "what plans do I have", "what's the plan for dinner". Informational
// existence asks only — exported so classify's phrase guard can exclude them
// (a bare "plan for X" inside an existence ask is not a draft request).
const PLAN_EXISTENCE_RE = /\b(?:do|did|does)\s+(?:we|i|you)\s+(?:have|got)\b[^.?!]{0,50}\bplans?\b|\b(?:have|has|had|got)\s+(?:we|i|you)\b[^.?!]{0,50}\bplans?\b|\b(?:is|are|was|were)\s+there\b[^.?!]{0,50}\bplans?\b|\bi\s+thought\s+we\s+(?:had|have)\b[^.?!]{0,50}\bplans?\b|\bwhat\s+plans?\b|\bwhat(?:'s| is)\s+the\s+plans?\b/i;
const _PLAN_ASK_RE = PLAN_EXISTENCE_RE;

/** Plan referent — DEFINITE referents only ("the nylas plan", "the plan for
 * lunch"). The old catch-all `(\w…) plan` scraped junk tokens out of any
 * prompt mentioning "plan" ("We have a", "idea I brought up forgot that")
 * and let the downstream fuzz-match bind an unrelated saved plan. */
function _planRef(userText) {
  const s = String(userText || '');
  const m = s.match(/\b(?:the|that|this|my|our|a|an)\s+([\w][\w .-]{0,40}?)\s+plan\b/i)
    || s.match(/\b(?:the|that|this|my|our)\s+plan\s+(?:for|about|on|regarding|named|called|titled|of)\s+([\w][\w .-]{1,40})/i);
  if (!m || !m[1]) return null;
  const token = m[1].trim();
  // "the plan" alone carries no name; >4 content words is a clause, not a
  // referent ("the idea I brought up forgot that plan" — 7 words).
  const words = token.split(/[^a-z0-9]+/i).filter(t => t.length > 1 && !/^(the|a|an|my|our|new|next|same|plan)$/i.test(t));
  // A token ending in a closed-class word is a clause fragment, not a name
  // ("the difference between a plan" scrapes "difference between a").
  const rawWords = token.split(/[^a-z0-9]+/i).filter(Boolean);
  const tail = rawWords[rawWords.length - 1] || '';
  const tailJunk = /^(the|a|an|of|for|to|and|or|but|between|with|from|by|in|on|at|as|about|into|like|vs|than)$/i.test(tail);
  const informational = /\b(?:thought|think|remember|had|have|has|was|were|is|are|there|what|which|show|tell|do we|did we|find|search|look|any)\b/i.test(s);
  return { token, meaningful: words.length > 0 && words.length <= 4 && !tailJunk, informational };
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
  const isQuestion = /\?\s*$/.test(userText) || _QUESTION_RE.test(userText);
  const requestText = deriveRequestText(userText);
  const requestIsQuestion = /\?\s*$/.test(requestText) || _QUESTION_RE.test(requestText);

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
    requestText,
    requestIsQuestion,
    wordCount,
    exitish,
    exitishInline: PLANNING_EXIT_INLINE_RE.test(t) && !PLANNING_EXIT_RE.test(t) && !PLANNING_EXIT_NEG_RE.test(t),
    cancelish,
    confirmish,
    runish,
    planRef: _planRef(userText),
    // Time-scoped plan recall — "what plans did I do last week". Matched
    // phrase is stored; window math lives in system-map.planWindowFor.
    planTimeScope: (() => {
      if (!/\bplans?\b/i.test(userText)) return null;
      const tm = userText.match(PLAN_TIME_PHRASE_RE);
      return tm ? tm[0] : null;
    })(),
    // Plan-existence question — "do we have a plan for X", "i thought we had
    // a plan", "what plans do I have". Informational only: a definite
    // referent still wins above; this is the honest "no plan named X" path.
    planAsk: _PLAN_ASK_RE.test(userText),
    logMention: /\blogs?\b/i.test(userText),
    explicitTool,
  });
}

module.exports = { computeTurnFacts, deriveRequestText, PLAN_EXISTENCE_RE };
