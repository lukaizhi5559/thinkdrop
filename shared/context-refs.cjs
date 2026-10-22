'use strict';

/**
 * context-refs.cjs — extract file/folder/plan references from prompt text into
 * a structured `refs[]` carrier that flows end-to-end:
 *
 *   prompt chips/paths → plan frontmatter (`refs:`) → planRunner dispatch
 *   → handoff planMeta → stategraph state._refs → task.agent args.refs
 *
 * One or many references — never a single hardcoded field. The plan file itself
 * rides as { type: 'plan', path } so the durable .md stays the source of truth
 * on resume/restart.
 *
 * Ref shape: { type: 'file'|'folder'|'plan', path: <absolute or ~>, note? }
 */

const os = require('os');
const path = require('path');

// [File: /path] / [Folder: /path] / [Context: /path] chips injected by the
// renderer — same tag family as shared/text-patterns ATTACHMENT_TAG_RE, but
// capturing so we keep the payload.
const _CHIP_RE = /\[(File|Folder|Context):\s*([^\]]+?)\s*\]/gi;

// Bare path tokens in prose: ~/… or /abs/… with at least one inner separator.
// Conservative — no URLs (://) and no trailing punctuation greed.
const _BARE_PATH_RE = /(?:^|[\s"'`(])(~\/[^\s'"`()\[\],;:!?]+|\/(?!\/)[\w.][^\s'"`()\[\],;:!?]*\/[^\s'"`()\[\],;:!?]+)/g;

const _TRAILING_PUNCT_RE = /[.,;:!?'")\]]+$/;

function _normalize(p) {
  let s = String(p || '').trim().replace(_TRAILING_PUNCT_RE, '').trim();
  if (!s) return '';
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  return s;
}

function _isAbsolutePath(s) {
  return s.startsWith('/') && !s.startsWith('//') && !/:\/\//.test(s);
}

/**
 * Extract reference paths from text.
 * @param {string} text
 * @returns {Array<{type:'file'|'folder', path:string}>} deduped by normalized path.
 */
function extractContextRefs(text) {
  const refs = [];
  const seen = new Set();
  const push = (type, rawPath, note) => {
    const p = _normalize(rawPath);
    if (!p || !_isAbsolutePath(p) || seen.has(p)) return;
    seen.add(p);
    refs.push({ type, path: p, ...(note ? { note } : {}) });
  };

  const s = String(text || '');

  // Chips are authoritative about type.
  let m;
  _CHIP_RE.lastIndex = 0;
  while ((m = _CHIP_RE.exec(s)) !== null) {
    const kind = m[1].toLowerCase();
    push(kind === 'folder' ? 'folder' : 'file', m[2]);
  }

  // Bare paths — type best-effort: trailing '/' or known dir-ish names → folder,
  // extensioned basename → file, default folder (paths in automation prompts
  // overwhelmingly anchor directories).
  _BARE_PATH_RE.lastIndex = 0;
  while ((m = _BARE_PATH_RE.exec(s)) !== null) {
    const raw = m[1];
    if (/^(https?|wss?|ftp):/i.test(raw)) continue;
    const base = raw.replace(/\/+$/, '').split('/').pop() || '';
    const type = /\.[a-z0-9]{1,8}$/i.test(base) ? 'file' : 'folder';
    push(type, raw);
  }

  return refs;
}

/**
 * Merge refs arrays, deduping by path (first occurrence wins on type/note).
 */
function mergeRefs(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      if (!r || typeof r.path !== 'string') continue;
      const p = _normalize(r.path);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push({ ...r, path: p });
    }
  }
  return out;
}

// ── Local multi-entity shape ──────────────────────────────────────────────────

// A file/folder anchor + per-entity iteration + a side-effecting verb is a
// plan-shaped task even when zero external services are named ("scan this
// folder and commit each repo"). Shared by comms-graph classify (planning
// routing) and stategraph gatherPlanContext (needs_plan escalation — a task
// with this shape should be drafted, not grilled).
const _LOCAL_ANCHOR_RE = /\[(?:File|Folder|Context):|~\/?[\w.-]|\/[\w.-]+(?:\/[\w .-]+)+|\bthis (?:directory|folder|repo|repository|project|workspace)\b/i;
const _ITERATE_EACH_RE = /\b(?:each|every|all|per[- ]|repos\b|repositories|nested|subdirector(?:y|ies)|recursiv\w*)/i;
const _SIDE_EFFECT_RE = /\b(?:commit|stage|push|update|fix|clean|build|scan|examine|inspect|rename|delete|install|test|deploy|organize|audit|report)\w*\b/i;

function isLocalMultiEntityTask(text) {
  // Scrub URLs/emails so path-looking fragments inside them don't anchor.
  const s = String(text || '').replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+/gi, ' ');
  return _LOCAL_ANCHOR_RE.test(s) && _ITERATE_EACH_RE.test(s) && _SIDE_EFFECT_RE.test(s);
}

module.exports = { extractContextRefs, mergeRefs, isLocalMultiEntityTask };
