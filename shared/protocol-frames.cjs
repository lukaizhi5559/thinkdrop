'use strict';

/**
 * protocol-frames.cjs — Strip machine-protocol frames from user-facing text.
 *
 * Two leak shapes observed in production:
 *   1. Sentinel chunks — the answer stream carries metadata as
 *      `\x00NAME\x00<payload>` (ITEMS/SOURCES/ENGINE/SEARCHING/REPLACE).
 *      Renderers split on them, but if a concatenated stream or a stored
 *      answer reaches a text surface the raw payload paints as garbage.
 *   2. Bare JSON tool frames — the LLM sometimes emits its tool-call wire
 *      format as answer text: `{"id":"0","text":"tokyo weather"}` followed by
 *      `{"id":"0","response":"{...}"}`. _stripToolMarkup covers the XML
 *      spellings (<tool_call>) but not this concatenated-JSON spelling
 *      (observed: a web_search answer whose entire body was two frames).
 *
 * Balanced-brace scanning, not regex — payloads nest and contain quotes.
 */

const SENTINEL_FRAME_RE = /\x00[A-Z_]+\x00[\s\S]*?(?=\x00[A-Z_]+\x00|$)/g;
// Candidate start of a JSON tool frame: {"id":"<digits>", "<known key>":
const JSON_FRAME_START_RE = /\{"id":"\d+"\s*,\s*"(?:text|response|action|tool|tool_call|query|args|items|url|result)"/g;

/**
 * Find the end index of a balanced {...} object starting at `start`, honoring
 * strings and escapes. Returns index AFTER the closing brace, or -1 when the
 * braces never balance (truncated/not actually JSON).
 */
function _balancedEnd(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
  }
  return -1;
}

/** Remove every balanced {"id":"<digits>",...} frame from text. */
function stripJsonToolFrames(text) {
  if (typeof text !== 'string' || text.indexOf('{"id"') === -1) return text;
  const spans = [];
  JSON_FRAME_START_RE.lastIndex = 0;
  let m;
  while ((m = JSON_FRAME_START_RE.exec(text)) !== null) {
    const end = _balancedEnd(text, m.index);
    if (end === -1) {
      JSON_FRAME_START_RE.lastIndex = m.index + 1;
      continue;
    }
    spans.push([m.index, end]);
    JSON_FRAME_START_RE.lastIndex = end;
  }
  if (!spans.length) return text;
  let out = '', cursor = 0;
  for (const [a, b] of spans) { out += text.slice(cursor, a); cursor = b; }
  return out + text.slice(cursor);
}

/**
 * Strip sentinel chunks and JSON tool frames, collapse the blank runs they
 * leave. Returns the cleaned string (unchanged type for non-strings).
 */
function stripProtocolFrames(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.replace(SENTINEL_FRAME_RE, '');
  out = stripJsonToolFrames(out);
  return out.replace(/(\n\s*){3,}/g, '\n\n').trim();
}

module.exports = { stripProtocolFrames, stripJsonToolFrames };
