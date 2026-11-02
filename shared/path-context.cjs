'use strict';

/**
 * path-context.cjs — compile-time filesystem grounding.
 *
 * Compiled plans emit literal argv (MUTATION DISCIPLINE), which makes them
 * deterministic but brittle: the stepgen can bake a path that does not exist
 * on this machine (observed: "/Users/luca/dev/thinkdrop" — every `cd` failed
 * and each failure burned a multi-minute cli.agent recovery loop).
 *
 * This module gives the compiler a verify → repair → reject ladder:
 *   1. missingInputPaths() — fs.existsSync every input a plan reads/chdirs
 *      into, minus paths the plan itself creates.
 *   2. repairMissingPaths() — journal → mdfind/find candidates by basename;
 *      rewrite ONLY on a single unambiguous candidate (never guess at a
 *      mutation target — a wrong-repo commit is worse than a rejected plan).
 *   3. still-missing → caller rejects the compile (handoff) or records a
 *      contract violation (plan lane).
 *
 * The path journal (~/.thinkdrop/path-journal.json) is a candidate
 * GENERATOR, never a source of truth: every lookup re-verifies with
 * existsSync and evicts stale entries — so a moved folder degrades to a
 * fresh probe instead of a wrong answer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const JOURNAL_PATH = path.join(os.homedir(), '.thinkdrop', 'path-journal.json');
const JOURNAL_MAX = 500;
const PROBE_TIMEOUT_MS = 5000;

// Skills whose path args are inputs that must already exist.
const READ_SKILLS = new Set([
  'fs.read', 'doc.read', 'fs.list', 'fs.stat', 'fs.tree', 'image.analyze',
]);
// Arg keys that name an existing location when they appear on a read skill or
// as a working-directory context on any skill.
const READ_PATH_KEYS = new Set(['path', 'filePath', 'dir', 'directory', 'root']);
const WRITE_PATH_KEYS = new Set(['saveToFile', 'outputPath', 'out', 'dest', 'draftPath']);

// Absolute-path token: /… or ~ or $HOME…
const _ABS_TOKEN_RE = /^(~|\/|\$\{?HOME\}?)[^\s]*$/;

// ── Path expansion ─────────────────────────────────────────────────────────
// Expands ~ and $HOME/${HOME}. Returns null when the token still carries
// unresolvable variables — we verify only what we can fully resolve and never
// flag a path we can't check.
function expandPath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  s = s.replace(/\$\{?HOME\}?/g, os.homedir());
  if (/[\$`]/.test(s)) return null; // still has $VAR/`subst` — can't verify
  return s;
}

// Resolve a token from argv/script text against the step's cwd; absolute wins.
// Returns null for relative paths with no cwd context (can't verify safely).
function _resolveTok(tok, cwd) {
  if (typeof tok !== 'string' || !tok) return null;
  const t = tok.replace(/^['"]|['"]$/g, '').trim();
  if (!t || /[\$`{*?\[\]]/.test(t)) return null; // unresolvable var or glob
  if (_ABS_TOKEN_RE.test(t)) return expandPath(t);
  const base = expandPath(cwd);
  if (!base) return null;
  return path.resolve(base, t);
}

// All shell-ish text of a step (cmd + argv joined + goal strings) in one blob
// for creation-pattern scanning.
function _stepShellText(step) {
  const a = step?.args || {};
  const parts = [];
  if (typeof a.cmd === 'string') parts.push(a.cmd);
  if (Array.isArray(a.argv)) parts.push(...a.argv.filter(x => typeof x === 'string'));
  if (typeof a.script === 'string') parts.push(a.script);
  return parts.join(' ');
}

// ── Plan-provided paths ────────────────────────────────────────────────────
// Locations earlier steps create — mkdir, git clone, git init, > redirects,
// touch, and explicit write-skill targets. A must-exist reference to one of
// these is legal even though it doesn't exist yet at compile time.
function collectPlanProvidedPaths(steps) {
  const provided = new Set();
  for (const step of steps || []) {
    if (!step || typeof step !== 'object') continue;
    const a = step.args || {};
    const cwd = a.cwd;
    const text = _stepShellText(step);
    for (const m of text.matchAll(/\bmkdir\s+(?:-[a-zA-Z]+\s+)*["']?([^\s'";|&]+)/g)) {
      const p = _resolveTok(m[1], cwd); if (p) provided.add(p);
    }
    for (const m of text.matchAll(/\bgit\s+clone\s+\S+\s+["']?([^\s'";|&]+)/g)) {
      const p = _resolveTok(m[1], cwd); if (p) provided.add(p);
    }
    for (const m of text.matchAll(/\bgit\s+init(?:\s+["']?([^\s'";|&]+))?/g)) {
      const p = _resolveTok(m[1] || cwd, cwd); if (p) provided.add(p);
    }
    for (const m of text.matchAll(/\btouch\s+["']?([^\s'";|&]+)/g)) {
      const p = _resolveTok(m[1], cwd); if (p) provided.add(p);
    }
    for (const m of text.matchAll(/(?<![\d>&])>>?\s*["']?([^\s'";|&]+)/g)) {
      const p = _resolveTok(m[1], cwd); if (p) provided.add(p);
    }
    for (const k of WRITE_PATH_KEYS) {
      const p = expandPath(a[k]);
      if (p && path.isAbsolute(p)) provided.add(p);
    }
  }
  return provided;
}

// ── Must-exist paths ───────────────────────────────────────────────────────
// Inputs the plan reads or chdirs into: cwd args, read-skill paths, cd/pushd
// targets, git -C/--git-dir/--work-tree targets (argv and inside bash -c
// scripts). Output/write targets are deliberately NOT here — they may not
// exist yet by design.
function collectMustExistPaths(steps) {
  const out = [];
  const seen = new Set();
  const push = (stepIndex, p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ stepIndex, path: p });
  };

  (steps || []).forEach((step, i) => {
    if (!step || typeof step !== 'object') return;
    const a = step.args || {};
    const cwd = expandPath(a.cwd);
    if (cwd && path.isAbsolute(cwd)) push(i, cwd);
    if (READ_SKILLS.has(step.skill)) {
      for (const k of READ_PATH_KEYS) {
        const p = expandPath(a[k]);
        if (p && path.isAbsolute(p)) push(i, p);
      }
    }
    if (step.skill !== 'shell.run') return;
    // argv tokens: cd <dir>, pushd <dir> in any interpreter; -C/--git-dir/
    // --work-tree ONLY when cmd is git — `curl -C`/`make -C` mean something
    // else entirely and flagging their operand as a path rejects good plans.
    // The same shapes inside bash -c script strings are caught by the text
    // passes below.
    const argv = Array.isArray(a.argv) ? a.argv : [];
    const _isGitCmd = a.cmd === 'git';
    for (let t = 0; t < argv.length; t++) {
      const tok = argv[t];
      if (typeof tok !== 'string') continue;
      if (/^(cd|pushd)$/.test(tok) || (_isGitCmd && /^(--git-dir|--work-tree|-C)$/.test(tok))) {
        const p = _resolveTok(argv[t + 1], cwd); if (p) push(i, p);
      }
      if (_isGitCmd && /^--git-dir=|^--work-tree=/.test(tok)) {
        const p = _resolveTok(tok.split('=')[1], cwd); if (p) push(i, p);
      }
    }
    const text = _stepShellText(step);
    for (const m of text.matchAll(/\b(?:cd|pushd)\s+["']?([^\s'";|&]+)/g)) {
      const p = _resolveTok(m[1], cwd); if (p) push(i, p);
    }
    for (const m of text.matchAll(/\bgit\s+(?:-C\s+["']?([^\s'";|&]+)|--git-dir[= ]["']?([^\s'";|&]+)|--work-tree[= ]["']?([^\s'";|&]+))/g)) {
      for (const g of m.slice(1)) {
        const p = _resolveTok(g, cwd); if (p) push(i, p);
      }
    }
  });
  return out;
}

// Entries whose path fails existsSync and isn't provided by the plan itself.
function missingInputPaths(steps) {
  const provided = collectPlanProvidedPaths(steps);
  return collectMustExistPaths(steps)
    .filter(({ path: p }) => !provided.has(p) && !fs.existsSync(p));
}

// ── Path journal ───────────────────────────────────────────────────────────
// Candidate generator only: every read re-verifies existsSync and evicts
// stale entries, so a moved folder degrades to a fresh probe. Populated ONLY
// from verified sources — attachments and compile-verified paths — never
// unverified model output.
function readPathJournal() {
  try {
    const raw = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
    return raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object'
      ? raw.entries
      : {};
  } catch (_) { return {}; }
}

function writePathJournal(entries) {
  try {
    const keys = Object.keys(entries);
    if (keys.length > JOURNAL_MAX) {
      const sorted = keys.sort((a, b) => (entries[b].lastSeen || 0) - (entries[a].lastSeen || 0));
      const keep = {};
      for (const k of sorted.slice(0, JOURNAL_MAX)) keep[k] = entries[k];
      entries = keep;
    }
    fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
    fs.writeFileSync(JOURNAL_PATH, JSON.stringify({ v: 1, entries }, null, 1));
  } catch (_) { /* journal is advisory — never break compile on write */ }
}

// Record verified paths into the journal. kind: 'dir'|'file'|'repo' —
// inferred by stat when not supplied. source: 'attachment'|'compile-verified'|'runtime'.
function journalRecord(paths, { kind = null, source = 'compile-verified' } = {}) {
  try {
    const entries = readPathJournal();
    const now = Date.now();
    let dirty = false;
    for (const p of paths || []) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) continue;
      const e = entries[p] || {};
      const k = e.kind || kind || (() => { try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch (_) { return 'dir'; } })();
      entries[p] = {
        kind: k,
        source: e.source || source,
        basename: path.basename(p),
        lastSeen: now,
        lastVerified: now,
      };
      dirty = true;
    }
    if (dirty) writePathJournal(entries);
  } catch (_) {}
}

// Journal candidates for a missing path's basename — verified live, stale
// entries evicted. A moved folder evicts here and the caller's live probe
// (mdfind/find by basename) usually finds it at the new location.
function journalCandidates(basename) {
  if (!basename) return [];
  const entries = readPathJournal();
  const hits = [];
  let dirty = false;
  for (const [p, e] of Object.entries(entries)) {
    if (e.basename !== basename) continue;
    if (fs.existsSync(p)) hits.push(p);
    else { delete entries[p]; dirty = true; }
  }
  if (dirty) writePathJournal(entries);
  return hits;
}

// Relevant journal entries for a prompt — basenames whose tokens appear in
// the prompt text (cheap relevance; the journal itself stays small anyway).
function journalRelevantPaths(prompt, { limit = 12 } = {}) {
  const entries = readPathJournal();
  const text = String(prompt || '').toLowerCase();
  const hits = [];
  for (const [p, e] of Object.entries(entries)) {
    if (hits.length >= limit) break;
    const tokens = String(e.basename || '').split(/[^a-z0-9]+/i).filter(t => t.length > 2);
    if (tokens.some(t => text.includes(t.toLowerCase())) && fs.existsSync(p)) hits.push(p);
  }
  return hits;
}

// ── Candidate discovery ────────────────────────────────────────────────────
// mdfind on darwin (whole-disk Spotlight index, ~100ms), bounded `find $HOME`
// elsewhere. Returns existing paths only.
function findCandidates(basename, { wantDir = true } = {}) {
  if (!basename || /[/\\]/.test(basename)) return [];
  const out = [];
  if (process.platform === 'darwin') {
    try {
      const res = execFileSync('mdfind', ['-name', basename], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
      for (const line of res.split('\n')) {
        const p = line.trim();
        if (!p) continue;
        try {
          const st = fs.statSync(p);
          if (wantDir ? st.isDirectory() : st.isFile()) out.push(p);
        } catch (_) {}
      }
    } catch (_) {}
  } else {
    try {
      const res = execFileSync('find', [os.homedir(), '-maxdepth', '4', '-name', basename, wantDir ? '-type' : '-type', wantDir ? 'd' : 'f'],
        { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
      for (const line of res.split('\n')) {
        const p = line.trim();
        if (p && fs.existsSync(p)) out.push(p);
      }
    } catch (_) {}
  }
  return [...new Set(out)];
}

// ── Repair ─────────────────────────────────────────────────────────────────
// Rewrite each missing path when exactly ONE strong candidate exists.
// Candidates: journal first, then live probe. A git-shaped step prefers
// candidates containing .git. Ambiguity → left missing (the caller rejects).
function repairMissingPaths(steps, missingList, { probe = findCandidates, journal = journalCandidates } = {}) {
  const repairs = [];
  const stillMissing = [];
  // Ancestors first: a wrong-root compile usually relocates a whole tree —
  // the parent must repair (and anchor) before any descendant resolves,
  // regardless of which step referenced them first. Flat order, not grouped
  // by step — a child path in an earlier step would otherwise resolve
  // before its parent's repair exists to anchor it.
  const _gitShapeCache = new Map();
  for (const { stepIndex, path: missing } of (missingList || []).slice().sort((a, b) => a.path.length - b.path.length)) {
    const step = steps[stepIndex];
    if (!step) { stillMissing.push({ stepIndex, path: missing, candidates: 0 }); continue; }
    const a = step.args || {};
    if (!_gitShapeCache.has(stepIndex)) {
      _gitShapeCache.set(stepIndex,
        /git/.test(_stepShellText(step)) || /\b(git|repo|commit|push|branch|diff)\b/i.test(step.description || ''));
    }
    const _gitShaped = _gitShapeCache.get(stepIndex);
    {
      // If an ancestor of this path was already repaired this pass, prefer
      // the moved-tree resolution (repairedAncestor + suffix) — a wrong-root
      // compile usually relocates a whole repo, not one dir at a time.
      const parentFix = repairs
        .filter(r => missing.startsWith(r.from + path.sep) || missing === r.from)
        .sort((a, b) => b.from.length - a.from.length)[0];
      let cands = [];
      if (parentFix) {
        const anchored = parentFix.to + missing.slice(parentFix.from.length);
        if (fs.existsSync(anchored)) cands = [anchored];
      }
      if (!cands.length) {
        const basename = path.basename(missing);
        // Extension-less basenames are almost always dirs; dotted ones are
        // files — pick the probe accordingly so a missing file.txt can't be
        // "repaired" to a directory.
        const wantDir = !path.extname(basename);
        cands = journal(basename);
        if (!cands.length) cands = probe(basename, { wantDir });
        cands = [...new Set(cands)];
      }
      if (_gitShaped) {
        const withGit = cands.filter(c => { try { return fs.statSync(path.join(c, '.git')).isDirectory() || fs.statSync(path.join(c, '.git')).isFile(); } catch (_) { return false; } });
        if (withGit.length) cands = withGit;
      }
      if (cands.length !== 1) { stillMissing.push({ stepIndex, path: missing, candidates: cands.length }); continue; }
      const fixed = cands[0];
      // Rewrite every occurrence of the missing path in args (cwd, argv,
      // script strings). Boundary-anchored: the path must be followed by
      // end, a separator, or a terminator — otherwise `/x/thinkdrop2` would
      // get corrupted by a `/x/thinkdrop` repair.
      const _esc = missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const _missingRe = new RegExp(`${_esc}(?=$|[/\\s'";&|)])`, 'g');
      const _rewrite = (v) => typeof v === 'string' && v.includes(missing) ? v.replace(_missingRe, fixed) : v;
      for (const k of Object.keys(a)) {
        if (Array.isArray(a[k])) a[k] = a[k].map(_rewrite);
        else a[k] = _rewrite(a[k]);
      }
      repairs.push({ stepIndex, from: missing, to: fixed });
    }
  }
  return { repairs, stillMissing };
}

// ── Repo topology ──────────────────────────────────────────────────────────
// Fresh shallow .git scan under a root — more truthful than any cached tree;
// run only for git-shaped tasks once a root has resolved.
function repoTopology(root, { maxDepth = 3 } = {}) {
  const r = expandPath(root);
  if (!r || !fs.existsSync(r)) return [];
  try {
    const res = execFileSync('find', [r, '-maxdepth', String(maxDepth), '-name', '.git', '-prune'],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
    return res.split('\n').map(l => l.trim()).filter(Boolean)
      .map(g => path.dirname(g)).sort();
  } catch (_) { return []; }
}

module.exports = {
  JOURNAL_PATH,
  expandPath,
  collectPlanProvidedPaths,
  collectMustExistPaths,
  missingInputPaths,
  readPathJournal,
  writePathJournal,
  journalRecord,
  journalCandidates,
  journalRelevantPaths,
  findCandidates,
  repairMissingPaths,
  repoTopology,
};
