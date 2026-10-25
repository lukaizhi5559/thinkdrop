'use strict';

/**
 * vocalization-tags.cjs — Resemble paralinguistic tags → display emoji
 *
 * persona.md teaches the model to insert inline vocalization markup —
 * [laugh] [sigh] [gasp] [um] [crying] — for Resemble TTS. On voice turns the
 * tags ride the spoken text into TTS untouched. On TEXT turns nothing
 * consumes them, so they painted literally in the feed (observed: "[sigh]
 * Forgive me — …"). This module maps them to emoji instead — same idea as
 * the MOODS emoji schema in shared/screen-output.cjs.
 */

const TAG_EMOJI = {
  laugh:  '😄',
  sigh:   '😮‍💨',
  gasp:   '😮',
  um:     '🤔',
  crying: '😢',
};

const _TAG_NAMES = Object.keys(TAG_EMOJI);
const _TAG_RE = new RegExp(`\\[(${_TAG_NAMES.join('|')})\\]`, 'gi');

/** Replace known vocalization tags with emoji; everything else passes through. */
function replaceVocalizationTags(text) {
  return String(text || '').replace(_TAG_RE, (_, t) => TAG_EMOJI[t.toLowerCase()]);
}

// True when `inner` (text after '[' so far) could still complete to a tag —
// lets the streaming mapper hold only plausible prefixes like "[si", never
// "[File:" or "[4]".
function _couldBeTag(inner) {
  const t = inner.toLowerCase();
  return /^[a-z]*$/.test(t) && _TAG_NAMES.some(n => n.startsWith(t));
}

// A '[' run longer than the longest tag can't resolve — flush it literally.
const _MAX_HOLD = Math.max(..._TAG_NAMES.map(n => n.length)) + 2;

/**
 * Streaming variant — vocalization tags can straddle chunk boundaries
 * ("[si" + "gh]"). push() emits mapped text and holds a trailing unclosed
 * '[' run only while it remains a plausible tag prefix; flush() releases
 * whatever is left at end-of-stream. Returns chars emitted per push so it
 * composes with callers that count visible output (askStream's retry gate).
 */
function createVocalizationMapper(onEmit) {
  let pending = '';
  return {
    push(chunk) {
      let s = pending + String(chunk || '');
      pending = '';
      let out = '';
      let i = 0;
      while (i < s.length) {
        const lb = s.indexOf('[', i);
        if (lb === -1) { out += s.slice(i); break; }
        out += s.slice(i, lb);
        const rb = s.indexOf(']', lb + 1);
        if (rb === -1) {
          const frag = s.slice(lb);
          if (frag.length <= _MAX_HOLD && _couldBeTag(frag.slice(1))) pending = frag;
          else out += frag;
          break;
        }
        const emoji = TAG_EMOJI[s.slice(lb + 1, rb).toLowerCase()];
        out += emoji !== undefined ? emoji : s.slice(lb, rb + 1);
        i = rb + 1;
      }
      if (out && onEmit) onEmit(out);
      return out.length;
    },
    flush() {
      const rest = pending;
      pending = '';
      if (rest && onEmit) onEmit(rest);
      return rest;
    },
  };
}

module.exports = { TAG_EMOJI, replaceVocalizationTags, createVocalizationMapper };
