'use strict';
/**
 * plan-runner-needs-plan.test.cjs — held-run + terminal-fail settle
 *
 * Regression (2026-10-30): a plan task escalated needs_plan (spurious
 * agent_not_onboarded on edit.agent) and onTaskComplete's
 * `if (!isDone && !isFailed) return` silently dropped it — the run stayed
 * 'running', the task stayed dispatched, and the queue card spun for 40min.
 * needs_plan now behaves like plan_update (task ⏸ blocked, run 'revising',
 * dispatch bookkeeping cleared for re-dispatch), and failPlan() terminalizes
 * a run whose replan produced nothing.
 *
 * Run: node shared/plan-runner-needs-plan.test.cjs
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-np-'));

// Stub comms-graph: /comms.proactive answers {taskId} so dispatch "succeeds".
let nextTaskId = 1;
const commsSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/comms.proactive') {
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

const RUNNING_PLAN = `---
id: plan_np_held
created: 2026-10-30T00:00:00.000Z
kind: task_plan
status: ready
original_prompt: "update the rtf file"
plan_session_id: sess_x
auth_bypass: []
refs: []
---
# Plan: RTF update

## Tasks

## Task 1 — Update memory verses
- **Prompt**: advance Exodus 6 → 7 for all kids
- **Agents**: edit.agent
- **Depends on**: —
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ⬜ pending
- **Result**: —

## Task 2 — Swap worship songs
- **Prompt**: pick 3 new songs excluding current ones
- **Agents**: fs.read
- **Depends on**: Task 1
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ⬜ pending
- **Result**: —

## Risks
`;

(async () => {
  await new Promise(r => commsSrv.listen(0, '127.0.0.1', r));
  process.env.COMMS_GRAPH_PORT = String(commsSrv.address().port);

  const planRunner = require('../src/main/planRunner.js');
  const emitted = [];
  planRunner.init({ ipcBroadcast: (ch, p) => emitted.push({ ch, ...(p || {}) }) });

  const planPath = path.join(tmpDir, 'plan_np_held.md');
  fs.writeFileSync(planPath, RUNNING_PLAN, 'utf8');

  const r = await planRunner.startPlan(planPath, { autoApprove: true });
  check('plan starts', r.ok === true, JSON.stringify(r));
  const run = planRunner.getRun('plan_np_held');
  check('run is running', run && run.status === 'running', run?.status);
  check('task 1 dispatched', run.dispatched.has(1) && !!run.dispatched.get(1));
  const dispatchedTaskId = run.dispatched.get(1);

  // ── needs_plan on a dispatched task → hold as 'revising' ──────────────
  emitted.length = 0;
  planRunner.onTaskComplete(dispatchedTaskId, 'needs_plan',
    JSON.stringify({ reason: 'agent_not_onboarded', proposal: 're-pin to a registered agent' }));
  check('run held as revising', run.status === 'revising', run.status);
  check('plan:status revising emitted', emitted.some(e => e.ch === 'plan:status' && e.status === 'revising'));
  check('dispatch bookkeeping cleared (redispatchable)', !run.dispatched.has(1));
  check('result bookkeeping cleared', !run.results.has(1));
  const content = fs.readFileSync(planPath, 'utf8');
  check('task 1 marked blocked in plan file', /Task 1[\s\S]*?⏸ blocked/i.test(content), content.match(/Task 1[\s\S]{0,400}/)?.[0]);
  check('escalation reason in plan file', /escalated to planning: agent_not_onboarded/i.test(content));
  check('plan NOT failed/done — still resumable', !/status: (failed|done)/.test(content.match(/---[\s\S]*?---/)?.[0] || ''));

  // ── Revised plan re-dispatches the held task on restart ────────────────
  const r2 = await planRunner.startPlan(planPath, { autoApprove: true });
  check('re-enter after revising starts ok', r2.ok === true, JSON.stringify(r2));
  check('task 1 re-dispatched', run.dispatched.has(1) && !!run.dispatched.get(1));

  // ── failPlan terminalizes the held run ─────────────────────────────────
  emitted.length = 0;
  planRunner.onTaskComplete(run.dispatched.get(1), 'needs_plan', JSON.stringify({ reason: 'still broken' }));
  check('second escalation holds again', run.status === 'revising');
  const failed = planRunner.failPlan('plan_np_held', 'planning produced no runnable plan');
  check('failPlan returns true', failed === true);
  const completes = emitted.filter(e => e.ch === 'plan:complete');
  check('plan:complete emitted', completes.length === 1);
  check('plan:complete status failed', completes[0]?.status === 'failed');
  check('failedTasks non-empty', completes[0]?.failedTasks?.length >= 1);
  check('run removed from _runs', planRunner.getRun('plan_np_held') == null);
  const after = fs.readFileSync(planPath, 'utf8');
  check('plan file status failed', /status: failed/.test(after.match(/---[\s\S]*?---/)?.[0] || ''), after.slice(0, 300));
  check('fail reason recorded on tasks', /replanning failed/.test(after));
  check('failPlan on gone run → false', planRunner.failPlan('plan_np_held') === false);

  commsSrv.close();
  console.log(`\n${passed}/${tests} passed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); commsSrv.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
