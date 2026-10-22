// context-refs.test.cjs — extraction + plan-format refs round-trip.
// Run: node shared/context-refs.test.cjs
const { extractContextRefs, mergeRefs, isLocalMultiEntityTask } = require('./context-refs.cjs');
const { parseRefs, upsertRefs, TASK_STATUS } = require('./plan-format.cjs');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

// ── extraction ────────────────────────────────────────────────────────────
{
  const refs = extractContextRefs('[File: /Users/x/notes.md]\n\nSummarize this');
  check('chip [File:] extracts a file ref', refs.length === 1 && refs[0].path === '/Users/x/notes.md' && refs[0].type === 'file');
}
{
  const refs = extractContextRefs('[Folder: ~/Desktop/projects/thinkdrop]\n\nfind the repos');
  check('chip [Folder:] extracts + tilde-expands', refs.length === 1 && refs[0].type === 'folder' && /^\/[^~]/.test(refs[0].path));
}
{
  const refs = extractContextRefs('commit the work in /Users/x/proj/a and /Users/x/proj/a');
  check('bare absolute paths dedupe', refs.length === 1 && refs[0].path === '/Users/x/proj/a');
}
{
  const refs = extractContextRefs('open https://github.com/x/y and tell me about it');
  check('URLs do not leak path refs', !refs.some(r => r.path.includes('github.com')));
}
{
  check('empty input → []', extractContextRefs('').length === 0 && extractContextRefs(null).length === 0);
}

// ── multi-entity shape detector ───────────────────────────────────────────
check('folder-anchored iterate prompt → localMultiEntity',
  isLocalMultiEntityTask('find all repos under ~/Desktop/projects and commit each one') === true);
check('plain question is not multi-entity',
  isLocalMultiEntityTask('what time is it') === false);

// ── plan-format round-trip ────────────────────────────────────────────────
{
  const base = '---\nstatus: ready\n---\n# Plan: t\n\n## Task 1 — a\nPrompt: x\n';
  const withRefs = upsertRefs(base, [
    { type: 'file', path: '/tmp/a.txt' },
    { type: 'folder', path: '/tmp/dir', note: 'root' },
  ]);
  const parsed = parseRefs(withRefs);
  check('upsertRefs writes parseable refs', parsed.length === 2);
  check('ref note survives', parsed[1].note === 'root');
  const again = upsertRefs(withRefs, [{ type: 'file', path: '/tmp/a.txt' }, { type: 'plan', path: '/tmp/p.md' }]);
  check('re-upsert merges + dedupes', parseRefs(again).length === 3);
}

// ── mergeRefs ─────────────────────────────────────────────────────────────
{
  const merged = mergeRefs([{ type: 'file', path: '/a' }], [{ type: 'file', path: '/a' }, { type: 'file', path: '/b' }]);
  check('mergeRefs dedupes by path', merged.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
