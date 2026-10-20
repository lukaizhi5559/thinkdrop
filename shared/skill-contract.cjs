'use strict';

/**
 * skill-contract.cjs — canonical skill result envelope.
 *
 * INVARIANT: `stdout` is the step's DATA PRODUCT — the text a next step or
 * the user consumes. `summary` is a one-line narration for humans (progress
 * cards, logs). stdout is NEVER narration: a step that produced no data
 * returns stdout:''.
 *
 * Why this exists: ~20 skills each returned a different shape (stdout |
 * result | text | content | summary), and every consumer — {{PREV_OUTPUT}}
 * templating, journal artifacts, contract paths, progress events — guessed
 * a different field, so each new scenario broke somewhere new. Now the
 * shape is normalized once at the command-service dispatch boundary
 * (server.cjs executeAutomation call site) and every consumer can read the
 * same field.
 *
 * All original fields are preserved — only `ok`/`stdout`/`summary` are
 * guaranteed/normalized. CONTRACT[N].outputs.* paths are unaffected.
 */

// Per-skill extractors for shapes where the data product doesn't already
// live in `stdout`. Only needed when a skill's stdout is missing or means
// something else; skills that already emit real stdout pass through.
const _STDOUT_EXTRACTORS = {
  'doc.read':          r => r.text || '',
  'fs.read':           r => r.content || r.text || '',
  'media.transcribe':  r => r.text || r.transcript || '',
  'image.analyze':     r => r.text || r.description || '',
  'screen.capture':    r => r.text || '',
  'system.introspect': r => r.text || (r.data ? JSON.stringify(r.data) : ''),
  'web.crawl':         r => r.content || r.text || '',
  // user.agent's data product is the `resolved` map — serialize it so
  // stdout-based consumers see the values, while structured consumers
  // ({{user.agent.resolved.*}}) read the preserved `resolved` field.
  'user.agent':        r => (r.resolved && Object.keys(r.resolved).length) ? JSON.stringify(r.resolved) : (r.summary || ''),
  // form.fill.agent's data product is the fill report — status, per-field
  // filled/skipped/missing lists and the form's own validation messages, so
  // synthesize reports real field state instead of narrating from memory.
  'form.fill.agent':   r => JSON.stringify({
    status: r.status || (r.ok ? 'filled' : 'failed'),
    filled: (r.filledFields || []).map((f) => ({ field: f.label || f.key, value: f.value })),
    validationIssues: (r.validationIssues || []).map((v) => ({ field: v.label || v.key, message: (v.messages || [])[0], current: v.current })),
    missing: (r.missingFields || []).map((m) => ({ field: m.label || m.key, required: m.required !== false })),
    leftoversHandled: r.leftoversHandled || [],
  }),
};

function _firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function canonicalizeSkillResult(skill, raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, stdout: '', summary: '', error: 'empty skill result' };
  }

  const extractor = _STDOUT_EXTRACTORS[skill];
  const stdout = extractor
    ? (extractor(raw) || '')
    : _firstString(raw.stdout, typeof raw.result === 'string' ? raw.result : null, raw.text, raw.content);

  // ok: explicit ok wins, then success, then absence-of-error. The default
  // branch in executeAutomation returns {success:false} without ok.
  const ok = raw.ok !== undefined ? !!raw.ok
    : raw.success !== undefined ? !!raw.success
    : !raw.error;

  // summary: keep the skill's narration if present; fabricate nothing.
  // stdout is the data channel — cards/logs that want narration read summary.
  const summary = typeof raw.summary === 'string' ? raw.summary : '';

  return { ...raw, ok, stdout, summary };
}

/**
 * Extract user.agent's structured product from a raw skill result, whatever
 * shape it arrived in: direct call, wrapped envelope ({data:{result}}), or a
 * JSON-string stdout. Returns {resolved, missingFields, sources, summary} —
 * the fields downstream `{{user.agent.resolved.*}}` templating needs.
 */
function extractUserAgentResult(raw) {
  if (!raw || typeof raw !== 'object') return { resolved: {}, missingFields: [], sources: [], summary: '' };
  // Unwrap common envelopes until a user.agent-shaped object surfaces.
  let r = raw;
  for (let i = 0; i < 3; i++) {
    if (r.resolved || r.missingFields || typeof r.summary === 'string') break;
    const next = r.data?.result || r.data || r.result || r.stdout;
    if (next && typeof next === 'object') { r = next; continue; }
    if (typeof next === 'string') {
      try { const p = JSON.parse(next); if (p && typeof p === 'object') { r = p; continue; } } catch (_) {}
    }
    break;
  }
  return {
    resolved:      (r.resolved && typeof r.resolved === 'object') ? r.resolved : {},
    missingFields: Array.isArray(r.missingFields) ? r.missingFields : [],
    sources:       Array.isArray(r.sources) ? r.sources : [],
    summary:       typeof r.summary === 'string' ? r.summary : '',
  };
}

module.exports = { canonicalizeSkillResult, extractUserAgentResult };
