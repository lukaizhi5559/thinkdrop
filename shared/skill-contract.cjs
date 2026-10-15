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

module.exports = { canonicalizeSkillResult };
