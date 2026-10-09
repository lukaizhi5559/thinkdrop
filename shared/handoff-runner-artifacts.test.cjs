'use strict';

/**
 * handoff-runner-artifacts.test.cjs
 *
 * Regression: a step that fails and is then recovered by ThinRecovery
 * (fs.read fails → cli.agent run succeeds at the SAME stepIndex) used to
 * render a red ✗ with the SUCCESS text — the all_done merge pinned
 * prev.status === 'failed' forever while still overwriting the output.
 *
 * skillResults append one entry per ATTEMPT, both mapped to the same
 * step index (step: skillCursor + 1 — the cursor does not advance across
 * a recovery), so the LAST result for an index is the authoritative one:
 *   [ {step:1, fs.read, ok:false}, {step:1, cli.agent, ok:true} ] → 'done'
 *
 * The pin still protects genuinely-failed steps from ambiguous later
 * results (ok undefined) — those keep 'failed'.
 *
 * USAGE: node shared/handoff-runner-artifacts.test.cjs
 */

const hr = require('../src/main/handoffRunner.js');

let total = 0, passed = 0, failed = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — ${detail}`); }
}

function snapshot(taskId) {
  return hr._artifactSnapshot(taskId);
}

function reset(taskId) {
  hr._runArtifacts.delete(taskId);
}

// ── Observed bug: fs.read fails → cli.agent recovers → step must be done ────
{
  const t = 't_recover';
  reset(t);
  hr._recordStepArtifact(t, { type: 'step_failed', stepIndex: 0, skill: 'fs.read', description: 'Read /x.pdf', error: 'File too large: 672.6KB (limit 100.0KB)' });
  check('live: step_failed → status failed', snapshot(t).steps[0].status === 'failed', JSON.stringify(snapshot(t).steps[0]));

  hr._recordStepArtifact(t, { type: 'step_done', stepIndex: 0, skill: 'cli.agent', description: 'Read /x.pdf', stdout: 'Successfully read the last 50 lines… Task completed.' });
  const live = snapshot(t).steps[0];
  check('live: step_done recovery → status done', live.status === 'done', JSON.stringify(live));

  hr._recordAllDoneArtifacts(t, {
    type: 'all_done',
    skillResults: [
      { step: 1, skill: 'fs.read', ok: false, error: 'File too large: 672.6KB (limit 100.0KB)' },
      { step: 1, skill: 'cli.agent', ok: true, stdout: 'Successfully read the last 50 lines… Task completed.' },
    ],
  });
  const fin = snapshot(t).steps[0];
  check('all_done: last result authoritative → done (was: pinned failed)', fin.status === 'done', JSON.stringify(fin));
  check('all_done: skill = cli.agent', fin.skill === 'cli.agent', fin.skill);
  check('all_done: output = recovery stdout', /Successfully read the last 50 lines/.test(fin.output || ''), fin.output);
  check('all_done: recoveredFrom = fs.read', fin.recoveredFrom === 'fs.read', fin.recoveredFrom);
}

// ── Genuine failure must stay failed ────────────────────────────────────────
{
  const t = 't_genuine_fail';
  reset(t);
  hr._recordStepArtifact(t, { type: 'step_failed', stepIndex: 0, skill: 'fs.read', description: 'Read /x.pdf', error: 'ENOENT' });
  hr._recordAllDoneArtifacts(t, {
    type: 'all_done',
    skillResults: [{ step: 1, skill: 'fs.read', ok: false, error: 'ENOENT' }],
  });
  check('genuine failure → stays failed', snapshot(t).steps[0].status === 'failed', JSON.stringify(snapshot(t).steps[0]));
}

// ── Ambiguous later result respects the pin ──────────────────────────────────
{
  const t = 't_ambiguous';
  reset(t);
  hr._recordStepArtifact(t, { type: 'step_failed', stepIndex: 0, skill: 'fs.read', description: 'Read /x.pdf', error: 'ENOENT' });
  hr._recordAllDoneArtifacts(t, {
    type: 'all_done',
    skillResults: [{ step: 1, skill: 'fs.read', stdout: 'partial' }], // ok undefined — ambiguous
  });
  check('ambiguous ok:undefined → keeps pinned failed', snapshot(t).steps[0].status === 'failed', JSON.stringify(snapshot(t).steps[0]));
}

// ── Recovery then ANOTHER failure → last result (fail) wins ──────────────────
{
  const t = 't_fail_after_recover';
  reset(t);
  hr._recordAllDoneArtifacts(t, {
    type: 'all_done',
    skillResults: [
      { step: 1, skill: 'cli.agent', ok: true, stdout: 'recovered once' },
      { step: 1, skill: 'cli.agent', ok: false, error: 'then failed again' },
    ],
  });
  check('recover-then-fail → last result failed wins', snapshot(t).steps[0].status === 'failed', JSON.stringify(snapshot(t).steps[0]));
}

// ── Skipped pin: a real step_done after a skipped signal → done ──────────────
{
  const t = 't_skipped_then_ran';
  reset(t);
  hr._recordStepArtifact(t, { type: 'step_done', stepIndex: 0, skill: 'shell.run', description: 'Maybe run', stdout: 'skipped', skipped: true });
  check('skipped signal → skipped', snapshot(t).steps[0].status === 'skipped', JSON.stringify(snapshot(t).steps[0]));
  hr._recordStepArtifact(t, { type: 'step_done', stepIndex: 0, skill: 'shell.run', description: 'Actually ran', stdout: 'done for real' });
  check('step_done after skipped → done (last event wins)', snapshot(t).steps[0].status === 'done', JSON.stringify(snapshot(t).steps[0]));
}

// ── plan: namespaced events behave identically ───────────────────────────────
{
  const t = 't_plan_ns';
  reset(t);
  hr._recordStepArtifact(t, { type: 'plan:step_failed', stepIndex: 0, skill: 'fs.read', error: 'too large' });
  hr._recordStepArtifact(t, { type: 'plan:step_done', stepIndex: 0, skill: 'cli.agent', stdout: 'recovered' });
  check('plan:step_failed → done after plan:step_done', snapshot(t).steps[0].status === 'done', JSON.stringify(snapshot(t).steps[0]));
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${passed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
