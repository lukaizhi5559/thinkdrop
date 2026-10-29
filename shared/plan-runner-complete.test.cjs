'use strict';
/**
 * plan-runner-complete.test.cjs — synchronous-terminal run reporting
 *
 * Regression (2026-10-29): "Run all" on an already-complete plan looked
 * dead. startPlan pre-seeded results for disk-done tasks → _schedule
 * terminalized inside the call → plan:complete landed FIRST → then the
 * plan:check {started:true} re-emit replaced `check` wholesale and wiped
 * `finished`, leaving a permanent "Plan run — running…" card with queued
 * rows. startPlan now reports `completed`, and the stuck-fail branch emits
 * plan:complete like the normal terminal path.
 *
 * Run: node shared/plan-runner-complete.test.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
const planRunner = require('../src/main/planRunner.js');

const emitted = [];
planRunner.init({ ipcBroadcast: (ch, p) => emitted.push({ ch, ...(p || {}) }) });

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
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

(async () => {
  console.log('\nplanRunner synchronous-completion tests');

  // ── All-done plan → terminalizes inside startPlan ────────────────────────
  const donePath = path.join(tmpDir, 'plan_runner_done.md');
  fs.writeFileSync(donePath, DONE_PLAN, 'utf8');
  emitted.length = 0;
  const r1 = await planRunner.startPlan(donePath, { autoApprove: true });
  check('all-done plan → ok', r1.ok === true);
  check('all-done plan → completed reported', !!r1.completed);
  check('all-done plan → completed.status done', r1.completed && r1.completed.status === 'done', JSON.stringify(r1.completed));
  check('all-done plan → failedTasks empty', r1.completed && r1.completed.failedTasks.length === 0);
  check('all-done plan → results cover both tasks',
    r1.completed && r1.completed.results.length === 2
    && r1.completed.results.every(x => x.status === 'done'));
  const complete1 = emitted.filter(e => e.ch === 'plan:complete');
  check('plan:complete emitted once', complete1.length === 1);
  check('plan:complete status done', complete1[0] && complete1[0].status === 'done');
  check('no task dispatched (no plan:task_progress)',
    !emitted.some(e => e.ch === 'plan:task_progress'));
  check('plan file ends status done', /status: done/.test(fs.readFileSync(donePath, 'utf8')));

  // ── Unsatisfiable-dep plan → stuck-fail branch → completed 'failed' ──────
  const stuckPath = path.join(tmpDir, 'plan_runner_stuck.md');
  fs.writeFileSync(stuckPath, STUCK_PLAN, 'utf8');
  emitted.length = 0;
  const r2 = await planRunner.startPlan(stuckPath, { autoApprove: true });
  check('stuck plan → ok', r2.ok === true);
  check('stuck plan → completed reported', !!r2.completed);
  check('stuck plan → completed.status failed', r2.completed && r2.completed.status === 'failed', JSON.stringify(r2.completed));
  check('stuck plan → failedTasks [1]', r2.completed && r2.completed.failedTasks.length === 1 && r2.completed.failedTasks[0] === 1);
  const complete2 = emitted.filter(e => e.ch === 'plan:complete');
  check('stuck-fail branch emits plan:complete', complete2.length === 1);
  check('stuck plan:complete status failed', complete2[0] && complete2[0].status === 'failed');

  // ── Re-entry after terminal completion → fresh run, no stale state ────────
  const r3 = await planRunner.startPlan(donePath, { autoApprove: true });
  check('re-run on done plan → completed done again', r3.ok === true && r3.completed && r3.completed.status === 'done');

  console.log(`\n${passed}/${tests} passed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
