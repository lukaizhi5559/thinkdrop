'use strict';
/* Unit test for path-context — the compile-time verify→repair→reject ladder.
 * Run: node shared/path-context.test.cjs */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('./path-context.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pathctx-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// Real fixtures: an existing repo dir + a moved-tree layout.
const EXISTING = path.join(TMP, 'projects', 'thinkdrop');
const NESTED = path.join(EXISTING, 'stategraph-module');
fs.mkdirSync(NESTED, { recursive: true });
fs.mkdirSync(path.join(EXISTING, '.git'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'thinkdrop2', 'keep'), { recursive: true });
const FILE_TGT = path.join(TMP, 'notes.txt');
fs.writeFileSync(FILE_TGT, 'hi');

// ── expandPath ──────────────────────────────────────────────────────────────
assert(pc.expandPath('~/x') === path.join(os.homedir(), 'x'), 'tilde expands');
assert(pc.expandPath('$HOME/x') === path.join(os.homedir(), 'x'), '$HOME expands');
assert(pc.expandPath('${HOME}/x') === path.join(os.homedir(), 'x'), '${HOME} expands');
assert(pc.expandPath('/abs/x') === '/abs/x', 'absolute passthrough');
assert(pc.expandPath('$OTHER/x') === null, 'unknown var → null (unverifiable)');
assert(pc.expandPath('`pwd`/x') === null, 'backtick → null');
assert(pc.expandPath('rel/x') === 'rel/x', 'relative passthrough (resolver decides)');

// ── collectPlanProvidedPaths ────────────────────────────────────────────────
{
  const steps = [
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `mkdir -p ${TMP}/made && git clone https://x/y ${TMP}/cloned && echo hi > ${TMP}/out.txt`] } },
    { skill: 'fs.write', args: { saveToFile: `${TMP}/save-target.txt` } },
  ];
  const prov = pc.collectPlanProvidedPaths(steps);
  assert(prov.has(`${TMP}/made`), 'mkdir target provided');
  assert(prov.has(`${TMP}/cloned`), 'git clone dest provided');
  assert(prov.has(`${TMP}/out.txt`), 'redirect target provided');
  assert(prov.has(`${TMP}/save-target.txt`), 'write-skill target provided');
}

// ── collectMustExistPaths ───────────────────────────────────────────────────
{
  const steps = [
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `cd ${EXISTING} && git status`] } },
    { skill: 'shell.run', args: { cmd: 'git', argv: ['-C', NESTED, 'status'] } },
    { skill: 'fs.read', args: { path: FILE_TGT } },
    { skill: 'shell.run', args: { cmd: 'curl', argv: ['-C', '-', '-o', '/tmp/x.bin', 'https://x'] } },
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'cd $UNRESOLVED_DIR/x'] } },
  ];
  const must = pc.collectMustExistPaths(steps).map(x => x.path);
  assert(must.includes(EXISTING), 'cd inside bash -c collected');
  assert(must.includes(NESTED), 'git -C argv collected');
  assert(must.includes(FILE_TGT), 'read-skill path collected');
  assert(!must.some(p => p.includes('x.bin')), 'output target not collected');
  // curl -C is not a path operand — a -C flag on a non-git cmd must not flag.
  assert(!must.some(p => p.endsWith('/-') || p === '-'), 'curl -C operand not collected');
  assert(!must.some(p => p.includes('UNRESOLVED')), 'unresolvable var not collected');
}

// ── missingInputPaths — plan-provided exclusion ─────────────────────────────
{
  const steps = [
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `mkdir -p ${TMP}/newrepo && cd ${TMP}/newrepo && git status`] } },
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `cd ${TMP}/newrepo/gen.txt || true`] } },
  ];
  const missing = pc.missingInputPaths(steps);
  assert(!missing.some(m => m.path === `${TMP}/newrepo`), 'mkdir-provided dir not flagged');
}

// ── repairMissingPaths ──────────────────────────────────────────────────────
{
  // Parent (later step) + child (earlier step): flat length-sort means the
  // parent repairs first and the child anchors under it — one probe total.
  const real = path.join(TMP, 'moved', 'repo');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(real, '.git'), { recursive: true });
  const steps = [
    { skill: 'shell.run', args: { cmd: 'git', argv: ['-C', '/gone/repo/sub', 'status'] }, description: 'git status' },
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'cd /gone/repo && git status'] }, description: 'cd then git' },
  ];
  const missing = pc.missingInputPaths(steps);
  const probes = [];
  const rep = pc.repairMissingPaths(steps, missing, {
    probe: (b, o) => { probes.push(b); return [real]; },
    journal: () => [],
  });
  assert(rep.repairs.length === 2, `both repaired: ${JSON.stringify(rep.repairs)}`);
  assert(rep.stillMissing.length === 0, 'nothing left missing');
  // Parent (shorter path) repairs first; child anchors under it without a probe.
  assert(probes.filter(b => b === 'repo').length === 1, 'parent probed once');
  assert(!probes.includes('sub'), 'child anchored under repaired parent — never probed');
  assert(steps[0].args.argv[1] === path.join(real, 'sub'), `child argv rewritten: ${steps[0].args.argv[1]}`);
  assert(steps[1].args.argv[1].includes(`cd ${real}`), 'bash -c body rewritten');
}

{
  // Ambiguity → stillMissing (never guess at a mutation target).
  const steps = [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'cd /gone/proj && git status'] } }];
  const rep = pc.repairMissingPaths(steps, pc.missingInputPaths(steps), {
    probe: () => ['/a/proj', '/b/proj'],
    journal: () => [],
  });
  assert(rep.repairs.length === 0 && rep.stillMissing.length === 1, 'ambiguous candidates → not repaired');
}

{
  // Boundary-safe rewrite: a longer path sharing the missing path's prefix
  // must not be corrupted.
  const steps = [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `cd /gone/thinkdrop && ls ${TMP}/thinkdrop2/keep`] } }];
  const rep = pc.repairMissingPaths(steps, pc.missingInputPaths(steps), {
    probe: () => [EXISTING],
    journal: () => [],
  });
  assert(rep.repairs.length === 1, 'parent repaired');
  assert(steps[0].args.argv[1].includes(`${TMP}/thinkdrop2/keep`), 'similar-prefix path untouched');
  assert(steps[0].args.argv[1].includes(`cd ${EXISTING}`), 'missing parent rewritten');
}

{
  // wantDir heuristic: a dotted basename probes for FILES.
  const steps = [{ skill: 'fs.read', args: { path: '/gone/report.txt' } }];
  const probes = [];
  pc.repairMissingPaths(steps, pc.missingInputPaths(steps), {
    probe: (b, o) => { probes.push(o?.wantDir); return []; },
    journal: () => [],
  });
  assert(probes[0] === false, `file basename probes wantDir=false, got ${probes[0]}`);
}

{
  // git-shaped step prefers the candidate containing .git.
  const withGit = path.join(TMP, 'cand-git');
  const noGit = path.join(TMP, 'cand-nogit');
  fs.mkdirSync(path.join(withGit, '.git'), { recursive: true });
  fs.mkdirSync(noGit, { recursive: true });
  const steps = [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'cd /gone/repo && git status'] } }];
  const rep = pc.repairMissingPaths(steps, pc.missingInputPaths(steps), {
    probe: () => [noGit, withGit],
    journal: () => [],
  });
  assert(rep.repairs.length === 1 && rep.repairs[0].to === withGit, `git-shaped prefers .git dir: ${JSON.stringify(rep.repairs)}`);
}

{
  // Journal candidates are consulted before probing.
  const journaled = path.join(TMP, 'journaled-repo');
  fs.mkdirSync(journaled, { recursive: true });
  const steps = [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'cd /gone/repo && git status'] } }];
  let probed = false;
  const rep = pc.repairMissingPaths(steps, pc.missingInputPaths(steps), {
    probe: () => { probed = true; return []; },
    journal: () => [journaled],
  });
  assert(rep.repairs.length === 1 && rep.repairs[0].to === journaled, 'journal hit repairs without probing');
  assert(!probed, 'probe skipped when journal resolves');
}

// ── journalRecord / journalCandidates (real journal, tmp HOME) ──────────────
{
  // Redirect the journal by pointing JOURNAL_PATH's dirname at TMP — the
  // module binds JOURNAL_PATH at load, so exercise it in a subprocess-less
  // way via the exported functions against the real file only if writable.
  // Safer: verify the pure contract — record ignores nonexistent paths.
  pc.journalRecord(['/definitely/not/here/x']); // must not throw
  assert(!pc.journalCandidates('x').length, 'nonexistent path never journaled');
}

// ── repoTopology ────────────────────────────────────────────────────────────
{
  const topo = pc.repoTopology(TMP, { maxDepth: 3 });
  assert(topo.includes(EXISTING), `topology finds nested repo: ${JSON.stringify(topo)}`);
  assert(!pc.repoTopology('/definitely/missing').length, 'missing root → empty');
}

// ── Slice semantics (dispatch gate) ─────────────────────────────────────────
// missingInputPaths(prefix) — a step cd-ing into a dir an EARLIER step
// created is not missing; the same cd with no creator step IS missing.
{
  const dir = path.join(TMP, 'made-later');
  const steps = [
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `mkdir -p ${dir}`] } },
    { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', `cd ${dir} && ls`] } },
  ];
  const full = pc.missingInputPaths(steps);
  assert(!full.length, 'cd into a dir the plan itself creates is not missing');
  const solo = pc.missingInputPaths([steps[1]]);
  assert(solo.length === 1 && solo[0].path === dir, 'same cd without the creator step IS missing');
}

console.log('path-context.test.cjs: all assertions passed');
