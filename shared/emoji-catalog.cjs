'use strict';

/**
 * shared/emoji-catalog.cjs — Optyon's emoji catalog (node wrapper).
 *
 * Data lives in emoji-catalog.json so BOTH consumers can read it: node via
 * require() here, the renderer via a plain JSON import (Vite dev can't
 * interop a .cjs source file — serving it verbatim crashed the GhostLayer).
 *
 * FACES holds ~100 parametric face specs — line-art SVG components
 * ({head?, l, r, brows, mouth, extra[]}), NEVER glyphs. The renderer's
 * avatarFaces.tsx paints specs; nothing here is pixel data itself.
 *
 * RESOLVE is a separate routing table: glyph + alias words per face key so
 * incoming emoji characters and free text map to a catalog key. Glyphs are
 * lookup metadata — the only place a real glyph is *rendered* is the
 * fullscreen overlay display path when avatar mode is OFF.
 *
 * resolvers:
 *   resolveFace(input)  — glyph | catalog key | alias | free text → key|null
 *   glyphForText(text)  — literal emoji glyph, or alias→glyph (display fill)
 *   FACE_KEYS           — all catalog keys (LLM option lists)
 */

const { FACES, RESOLVE } = require('./emoji-catalog.json');

const FACE_KEYS = Object.keys(FACES);

// Lookup indexes built once.
const _byGlyph = new Map();
const _byAlias = new Map(); // alias (lowercased) → key
for (const key of FACE_KEYS) {
  const r = RESOLVE[key] || {};
  if (r.glyph) _byGlyph.set(r.glyph.replace(/️/g, ''), key);   // strip VS16 for matching
  for (const a of (r.aliases || [])) _byAlias.set(String(a).toLowerCase(), key);
}
// Aliases sorted longest-first — phrase hits beat single words.
const _aliasList = [..._byAlias.keys()].sort((a, b) => b.length - a.length);
const _GLYPH_RE = /\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic}|\u{FE0F}\p{Extended_Pictographic})*/u;

function _wordHit(text, alias) {
  // Word-boundary contains — 'sad' must not hit inside 'saddle'.
  const re = new RegExp(`(?:^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i');
  return re.test(text);
}

/**
 * resolveFace(input) → catalog key | null.
 * Accepts an emoji glyph, a catalog key, an alias, or free text containing
 * any of those.
 */
function resolveFace(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (FACES[s]) return s;
  const glyph = (s.match(_GLYPH_RE) || [])[0];
  if (glyph && _byGlyph.has(glyph.replace(/️/g, ''))) return _byGlyph.get(glyph.replace(/️/g, ''));
  const lower = s.toLowerCase();
  if (_byAlias.has(lower)) return _byAlias.get(lower);
  for (const a of _aliasList) {
    if (_wordHit(lower, a)) return _byAlias.get(a);
  }
  return null;
}

/**
 * glyphForText(text) → emoji glyph | null. First a literal glyph in the
 * text, else the resolved face's catalog glyph. Used by display-arg fills —
 * the glyph is what the fullscreen overlay renders (avatar mode is OFF).
 */
function glyphForText(text) {
  const s = String(text || '');
  const glyph = (s.match(_GLYPH_RE) || [])[0];
  if (glyph) return glyph;
  const key = resolveFace(s);
  return key && RESOLVE[key] ? (RESOLVE[key].glyph || null) : null;
}

module.exports = { FACES, RESOLVE, FACE_KEYS, resolveFace, glyphForText };
