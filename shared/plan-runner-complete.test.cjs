'use strict';
/**
 * plan-runner-complete.test.cjs — auto-fresh re-run + terminal settle
 *
 * Regression (2026-10-29): "Run all" on an already-complete plan looked dead.
 * startPlan now auto-implies `fresh` when every task is done (reset file,
 * re-dispatch — the documented contract), and the stuck-fail branch emits
 * plan:complete like the normal terminal path.
 *
 * Leak fix (this run): the test previously POSTed real dispatches to the
 * live comms-graph :3015 whenever the app was running — its "research
 * patterns" fixture ran the real stategraph and parked ghost tasks on the
 * __run__ lock (observed: task_e395debe + task_08d26372). A stub server now
 * answers /comms.proactive, and COMMS_GRAPH_PORT is set BEFORE the planRunner
 * require — the port is captured at module load.
 *
 * Run: node shared/plan-runner-complete.test.cjs
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));

// Stub comms-graph: /comms.proactive answers {taskId} so dispatch "succeeds"
// locally; bodies are captured so assertions can verify WHAT dispatched and
// prove nothing reaches a real service.
let nextTaskId = 1;
const dispatched = [];
const commsSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/comms.proactive') {
      try { dispatched.push(JSON.parse(body || '{}')); } catch (_) {}
      res.writeHead(200).end(JSON.stringify({ ok: true, taskId: `task_fake_${nextTaskId++}` }));
    } else {
      res.writeHead(200).end('{}');
    }
  });
});

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

// onTaskComplete fires _schedule un-awaited — poll until the stub sees the
// next dispatch (or the condition holds) rather than racing setImmediate.
async function waitFor(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  return cond();
}

const DONE_PLAN = `---
id: plan_runner_done
created: 2026-10-29T00:00:00.000Z
kind: task_plan
status: done
original_prompt: "research and scaffold"
plan_session_id: sess_x
auth_bypass: []
refs: []
---
# Plan: Done plan

## Tasks

## Task 1 — Research
- **Prompt**: research patterns
- **Agents**: —
- **Depends on**: —
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ✅ done
- **Result**: found it

## Task 2 — Scaffold
- **Prompt**: scaffold workspace
- **Agents**: —
- **Depends on**: Task 1
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ✅ done
- **Result**: scaffolded

## Risks
`;

const STUCK_PLAN = `---
id: plan_runner_stuck
created: 2026-10-29T00:00:00.000Z
kind: task_plan
status: ready
original_prompt: "depends on a task that does not exist"
plan_session_id: sess_x
auth_bypass: []
refs: []
---
# Plan: Stuck plan

## Tasks

## Task 1 — Orphan
- **Prompt**: needs a dep that will never exist
- **Agents**: —
- **Depends on**: Task 99
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ⬜ pending
- **Result**: —

## Risks
`;

function _cleanup(savedPort) {
  try { commsSrv.close(); } catch (_) {}
  if (savedPort === undefined) delete process.env.COMMS_GRAPH_PORT;
  else process.env.COMMS_GRAPH_PORT = savedPort;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async () => {
  const _savedPort = process.env.COMMS_GRAPH_PORT;
  await new Promise(r => commsSrv.listen(0, '127.0.0.1', r));
  // Must be set before require — planRunner caches COMMS_GRAPH_PORT at load.
  process.env.COMMS_GRAPH_PORT = String(commsSrv.address().port);
  const planRunner = require('../src/main/planRunner.js');
  const emitted = [];
  planRunner.init({ ipcBroadcast: (ch, p) => emitted.push({ ch, ...(p || {}) }) });

  try {
    console.log('\nplanRunner synchronous-completion tests');

    // ── All-done plan → auto-fresh re-run (reset file, dispatch task 1) ─────
    const donePath = path.join(tmpDir, 'plan_runner_done.md');
    fs.writeFileSync(donePath, DONE_PLAN, 'utf8');
    emitted.length = 0;
    const r1 = await planRunner.startPlan(donePath, { autoApprove: true });
    check('all-done plan → ok', r1.ok === true);
    check('all-done plan → run stays live (no completed report)',
      r1.completed == null, JSON.stringify(r1.completed));
    check('exactly one dispatch captured', dispatched.length === 1, String(dispatched.length));
    check('dispatched task 1 prompt', dispatched[0]?.prompt === 'research patterns', dispatched[0]?.prompt);
    check('dispatch is a plan task', dispatched[0]?.planTask === true && dispatched[0]?.planTaskNum === 1
      && dispatched[0]?.planId === 'plan_runner_done' && dispatched[0]?.source === 'plan');
    const midContent = fs.readFileSync(donePath, 'utf8');
    check('task 1 reset to running on disk', /Task 1[\s\S]*?🔄 running/i.test(midContent));
    check('task 2 still pending on disk', /Task 2[\s\S]*?⬜ pending/i.test(midContent));
    check('no terminal emit yet (no plan:complete)',
      !emitted.some(e => e.ch === 'plan:complete'));

    // ── Drive the dispatch chain hermetically → terminal done ──────────────
    planRunner.onTaskComplete('task_fake_1', 'done', 'found it');
    check('task 2 dispatched after task 1 completes',
      await waitFor(() => dispatched.length === 2), String(dispatched.length));
    check('task 2 prompt carries prior-step result + own prompt',
      typeof dispatched[1]?.prompt === 'string'
      && dispatched[1].prompt.includes('found it')
      && dispatched[1].prompt.includes('scaffold workspace'),
      dispatched[1]?.prompt);
    check('task 2 carries priorResults', Array.isArray(dispatched[1]?.priorResults)
      && dispatched[1].priorResults.some(r => r.result === 'found it'),
      JSON.stringify(dispatched[1]?.priorResults));
    planRunner.onTaskComplete('task_fake_2', 'done', 'scaffolded');
    const settled = await waitFor(() => emitted.some(e => e.ch === 'plan:complete'));
    const complete1 = emitted.filter(e => e.ch === 'plan:complete');
    check('plan:complete emitted once', settled && complete1.length === 1, String(complete1.length));
    check('plan:complete status done', complete1[0]?.status === 'done', complete1[0]?.status);
    check('plan:complete results cover both tasks',
      complete1[0]?.results?.length === 2 && complete1[0].results.every(x => x.status === 'done'));
    check('run removed after terminal', planRunner.getRun('plan_runner_done') == null);
    check('plan file ends status done', /status: done/.test(fs.readFileSync(donePath, 'utf8')));

    // ── Unsatisfiable-dep plan → stuck-fail branch → completed 'failed' ─────
    const stuckPath = path.join(tmpDir, 'plan_runner_stuck.md');
    fs.writeFileSync(stuckPath, STUCK_PLAN, 'utf8');
    emitted.length = 0;
    dispatched.length = 0;
    const r2 = await planRunner.startPlan(stuckPath, { autoApprove: true });
    check('stuck plan → ok', r2.ok === true);
    check('stuck plan → completed reported', !!r2.completed);
    check('stuck plan → completed.status failed', r2.completed && r2.completed.status === 'failed', JSON.stringify(r2.completed));
    check('stuck plan → failedTasks [1]', r2.completed && r2.completed.failedTasks.length === 1 && r2.completed.failedTasks[0] === 1);
    const complete2 = emitted.filter(e => e.ch === 'plan:complete');
    check('stuck-fail branch emits plan:complete', complete2.length === 1);
    check('stuck plan:complete status failed', complete2[0] && complete2[0].status === 'failed');
    check('fail path dispatches nothing', dispatched.length === 0, String(dispatched.length));

    // ── Re-entry on the now-done plan → auto-fresh again, no stale state ────
    dispatched.length = 0;
    const r3 = await planRunner.startPlan(donePath, { autoApprove: true });
    check('re-run on done plan → ok', r3.ok === true, JSON.stringify(r3));
    check('re-run → fresh dispatch (auto-fresh)', dispatched.length === 1
      && dispatched[0]?.planTaskNum === 1, JSON.stringify(dispatched.map(d => d.planTaskNum)));
    check('re-run → not a resume of a stale run', r3.resumed !== true);
    planRunner.cancelPlan('plan_runner_done');

    console.log(`\n${passed}/${tests} passed`);
    _cleanup(_savedPort);
    process.exit(passed === tests ? 0 : 1);
  } catch (e) {
    console.error(e);
    _cleanup(_savedPort);
    process.exit(1);
  }
})();
