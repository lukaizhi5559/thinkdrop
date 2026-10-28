'use strict';
/**
 * decision-state.cjs — per-site state shaping for the local decision model.
 *
 * `state` on a decision.answer call is the model's scratch context for ONE
 * verdict — not memory. The full transcript/history/blob stays in
 * englishText / convHistory / selectedText for the answering nodes; each
 * decision call gets only the slice its question needs, sized to a per-site
 * budget, so tev1-class models stay in their fast band (measured: ~160ms on
 * a small state vs ~1.8s+ on an 8KB state — prompt eval dominates).
 *
 * Integrity: history turns are compressed to one-line previews rather than
 * dropped, so referents ("that event I just set") still resolve at ~1/10
 * the tokens. The message is appended LAST and is never cut — oldest turns
 * are dropped first when over budget.
 */

const { ATTACHMENT_TAG_RE } = require('./text-patterns.cjs');

// Per-site character budgets — sized to each question's actual needs.
const SITE_BUDGETS = {
  'classify.intent': 800,   // clean message + ~2 turn previews + plan/hosts lines
  'missing-detail': 600,    // message + last 1–2 turns (referent establishment)
  'classifyTask': 2000,     // message + ~6 previews (follow-up detection)
  'pin-escape': 500,        // message + plan title/task titles
  'plan-resume': 500,       // message + paused-plan title/counts
  'agent.pick': 500,        // userText + candidate agent
  'voice.tool-check': 600,  // instruction + openPlan + selection presence
  'screen.stale': 300,      // request + digest age
  'stall': 800,
  'route-pick': 800,
};
const DEFAULT_BUDGET = 2000;
// Global backstop — even an unshaped caller can't exceed this.
const STATE_MAX = parseInt(process.env.DECISION_STATE_MAX || '3000', 10);

function _stripTags(text) {
  const s = String(text || '');
  return s
    // Leading multi-line attachment block — the injection format is
    // "[Highlighted: …]\n\n<user text>", so the tag's true terminator is the
    // LAST ']' before the blank line (a lazy first-']' match stops inside
    // the blob and leaves most of it behind).
    .replace(/^\s*\[(?:Thought|File|Folder|Context|Highlighted):[\s\S]*\]\n\n/, ' ')
    .replace(/^\s*\[(?:Thought|File|Folder|Context|Highlighted):[\s\S]*\]\s*$/, ' ')
    .replace(ATTACHMENT_TAG_RE, ' ');
}

/** One-line preview of a turn/message — tag-stripped, collapsed, capped. */
function previewLine(text, maxChars = 250) {
  const s = _stripTags(text).replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

/**
 * Assemble a shaped decision state.
 * @param {object} o
 * @param {string}  o.message   current user message (always kept, tag-stripped)
 * @param {Array<string|{role:string, content:string}>} [o.history] prior turns
 * @param {string|string[]} [o.extras] small extra lines (open plan, bound hosts)
 * @param {number}  [o.budget]  char budget; SITE_BUDGETS[site] or DEFAULT_BUDGET
 * @param {string}  [o.site]
 * @returns {string}
 */
function buildDecisionState({ message, history = [], extras = [], budget, site } = {}) {
  const cap = budget || (site && SITE_BUDGETS[site]) || DEFAULT_BUDGET;
  const parts = [].concat(extras).filter(Boolean)
    .map(l => previewLine(l, 300)).filter(Boolean);
  const msg = previewLine(message, Math.min(1200, cap));
  const previews = (history || []).filter(Boolean).map(t => {
    const isObj = typeof t === 'object' && t;
    const role = isObj ? (t.role === 'assistant' ? 'Assistant' : 'User') : '';
    const body = previewLine(isObj ? t.content : t, 250);
    return body ? (role ? `${role}: ${body}` : body) : '';
  }).filter(Boolean);
  const fixedLen = parts.join('\n').length + msg.length + 20;
  let room = cap - fixedLen;
  const kept = [];
  for (let i = previews.length - 1; i >= 0 && room > 0; i--) {
    const l = previews[i];
    if (l.length > room && kept.length) break;
    kept.unshift(l);
    room -= l.length + 1;
  }
  if (kept.length) parts.push(`Recent:\n${kept.join('\n')}`);
  parts.push(`Current message: ${msg}`);
  return parts.join('\n').slice(0, Math.max(cap, msg.length + 40));
}

/** Backstop clamp — keeps the TAIL: callers append "Current message:" last. */
function clampState(state, max = STATE_MAX) {
  const s = String(state || '');
  return s.length <= max ? s : s.slice(-max);
}

// ── Adaptive local↔remote chooser ──────────────────────────────────────────
// Per-site rolling latency (EWMA, α=0.3): run the leg that has been faster;
// every RESAMPLE_EVERY calls (and on cold start) race BOTH legs — first
// valid answer wins and returns immediately while the loser keeps running
// in the background to feed the EWMA. Self-tuning: a faster model or box
// re-favors local automatically; the local 0.8b only pays its ~160ms when
// state is shaped (see buildDecisionState).
const _adaptive = new Map(); // site -> {localMs, remoteMs, calls}
const _ALPHA = 0.3;
const ADAPTIVE_RESAMPLE_EVERY = parseInt(process.env.DECISION_ADAPTIVE_RESAMPLE || '20', 10);

function adaptiveEnabled() {
  return process.env.DECISION_ADAPTIVE === '1';
}

function _ewma(prev, v) { return prev == null ? v : prev * (1 - _ALPHA) + v * _ALPHA; }

/**
 * @param {string} site     EWMA bucket ('classify.intent', 'classifyTask', …)
 * @param {() => Promise<*>} localFn   resolves a normalized result or null
 * @param {() => Promise<*>} remoteFn  resolves a normalized result or null
 * @param {{logger?: {info:Function}, resampleEvery?: number}} [opts]
 * @returns {Promise<*|null>} the winning leg's value (null when both fail)
 */
async function adaptiveChoose(site, localFn, remoteFn, opts = {}) {
  const log = opts.logger || { info: () => {} };
  const st = _adaptive.get(site) || { localMs: null, remoteMs: null, calls: 0 };
  _adaptive.set(site, st);
  st.calls++;
  const resampleEvery = opts.resampleEvery || ADAPTIVE_RESAMPLE_EVERY;
  const timed = async (fn, leg) => {
    const t0 = Date.now();
    const v = await fn();
    return { v, ms: Date.now() - t0, leg };
  };
  const mustRace = st.localMs == null || st.remoteMs == null || st.calls % resampleEvery === 0;
  if (mustRace) {
    const lp = timed(localFn, 'local').catch(() => null);
    const rp = timed(remoteFn, 'remote').catch(() => null);
    // First VALID answer wins; the loser settles in background for the EWMA.
    const first = await new Promise((resolve) => {
      let pending = 2;
      const check = (r) => { if (r && r.v != null) resolve(r); else if (--pending === 0) resolve(null); };
      lp.then(check); rp.then(check);
    });
    Promise.all([lp, rp]).then(([lr, rr]) => {
      if (lr) st.localMs = _ewma(st.localMs, lr.ms);
      if (rr) st.remoteMs = _ewma(st.remoteMs, rr.ms);
    });
    log.info(`[DecisionAdaptive] site=${site} mode=race pick=${first?.leg || 'none'}`);
    return first?.v ?? null;
  }
  const favored = st.localMs <= st.remoteMs ? 'local' : 'remote';
  const order = favored === 'local'
    ? [[localFn, 'local'], [remoteFn, 'remote']]
    : [[remoteFn, 'remote'], [localFn, 'local']];
  for (const [fn, leg] of order) {
    try {
      const { v, ms } = await timed(fn, leg);
      if (v == null) continue;
      if (leg === 'local') st.localMs = _ewma(st.localMs, ms); else st.remoteMs = _ewma(st.remoteMs, ms);
      log.info(`[DecisionAdaptive] site=${site} pick=${leg} ms=${ms}`);
      return v;
    } catch (_) { /* favored leg failed — try the other */ }
  }
  return null;
}

module.exports = { SITE_BUDGETS, DEFAULT_BUDGET, STATE_MAX, previewLine, buildDecisionState, clampState, adaptiveEnabled, adaptiveChoose, _stripTags };
