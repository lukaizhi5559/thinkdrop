'use strict';

/**
 * planRunner.js — Executes an approved ThinkDrop plan (v2 `## Task` format)
 *
 * Reads a plan.md, checks the auth run-gate, then dispatches each Task as its
 * own stategraph run through the existing comms-graph handoff path:
 *
 *   POST /comms.proactive  →  comms-graph handoff (journal + agentLock)
 *                          →  /comms.handoff back to main.js
 *                          →  handoffRunner.execute → stategraph
 *
 * Why through the journal instead of calling handoffRunner directly:
 *   - agentLock serializes same-service tasks for free (the Google Doc/Calendar
 *     /Sheet case — all `google.agent` — becomes 3 sequential runs, and each
 *     run's navigate+act stay adjacent → no cross-service page contamination)
 *   - tasks get queue cards, progress, cancel, and completion events for free
 *   - different-agent tasks parallelize via the lock's per-agent granularity
 *
 * Scheduling: a task dispatches when every entry in its `Depends on` list is
 * done. Independent tasks dispatch immediately — `Mode: parallel` is
 * informational (the lock decides actual concurrency per agent).
 *
 * Result propagation: a dependent task's prompt is prefixed with the prior
 * task's result so the run knows what "the doc I just made" refers to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const planFormat = require('../../shared/plan-format.cjs');
const { canonicalAgent: _canonicalAgent } = require('../../shared/agent-canonical.cjs');

// Generic = a command-service skill (browser.agent, web.agent, turn.loop.agent)
// — generic lanes never gate auth; prefer a real service agent as the lock key
// when steps resolved to one.
function _isGenericAgent(agentId) {
  try { return require('../../shared/skill-index.cjs').skillExists(agentId); }
  catch (_) { return false; }
}

// Degenerate background-generated step shape — the failure mode that sent the
// wrong-recipient email: a single page flow split into per-field dom.act
// micro-steps with no verification before synthesize. Each micro-step loses
// cross-field context (the send step's executor invented a recipient from a
// cached flow). Flagged plans dispatch deterministicPlan:null so planSkillsV2
// live-plans instead — slower, never wrong.
const _INTERACTIVE_STEP_SKILLS = new Set(['url.first.agent', 'dom.act', 'tab.map.agent', 'turn.loop.agent']);
function _stepsLookDegenerate(task, steps) {
  if (String(task.stepsStatus || '').toLowerCase() === 'failed') return 'steps-status-failed';
  if (!steps.some(s => s && _INTERACTIVE_STEP_SKILLS.has(s.skill))) return null;
  const domActs = steps.filter(s => s && s.skill === 'dom.act').length;
  const hasVerify = steps.some(s => s && s.skill === 'turn.loop.agent'
    && (s.args?.mode === 'verify' || /confirm|verif|check/i.test(`${s.args?.goal || ''} ${s.description || ''}`)));
  if (domActs >= 3 && !hasVerify) return `${domActs} per-action dom.act steps, no verify step`;
  return null;
}

const COMMS_GRAPH_PORT = parseInt(process.env.COMMS_GRAPH_PORT || '3015', 10);

// ── Module state ──────────────────────────────────────────────────────────────

let _ipcBroadcast = null;   // (channel, payload) — renderer events
let _onAuthRequired = null; // (planId, blockers) — raise sign-in/bypass UI
let _onReview = null;       // (payload) — main.js tracks pending review gates

/** @type {Map<string, {planPath:string, planId:string, tasks:Array, results:Map<number,string>, dispatched:Map<number,string>, status:string, sessionId:string|null, bypassed:Set<string>, cancelled:boolean}>} */
const _runs = new Map();

function _plansDir() {
  return process.env.THINKDROP_PLANS_DIR
    || path.join(os.homedir(), '.thinkdrop', 'plans');
}

function init({ ipcBroadcast, onAuthRequired, onReview } = {}) {
  _ipcBroadcast = ipcBroadcast || null;
  _onAuthRequired = onAuthRequired || null;
  _onReview = onReview || null;
}

function _emit(channel, payload) {
  try { _ipcBroadcast && _ipcBroadcast(channel, payload); } catch (_) {}
}

function _planIdFromPath(planPath) {
  return path.basename(planPath, '.md');
}

function _postToComms(urlPath, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: COMMS_GRAPH_PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(res.statusCode === 200 ? {} : null); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// ── Plan file load / status write-back ────────────────────────────────────────

function _loadPlan(planPath) {
  const content = fs.readFileSync(planPath, 'utf8');
  const fm = planFormat.parseFrontmatter(content) || {};
  const tasks = planFormat.parseTasks(content);
  return { content, fm, tasks };
}

function _writeTaskStatus(run, taskNum, status, result) {
  try {
    const content = fs.readFileSync(run.planPath, 'utf8');
    let updated = planFormat.updateTaskStatus(content, taskNum, status, result);
    if (status === planFormat.TASK_STATUS.RUNNING) {
      updated = planFormat.updateFrontmatterStatus(updated, 'running');
    }
    fs.writeFileSync(run.planPath, updated, 'utf8');
    run.tasks = planFormat.parseTasks(updated);
  } catch (err) {
    console.warn(`[PlanRunner] Status write failed for task ${taskNum}: ${err.message}`);
  }
  _emit('plan:task_progress', {
    planId: run.planId, taskNum, status, result: result || null,
  });
}

function _writePlanStatus(run, status) {
  run.status = status;
  try {
    const content = fs.readFileSync(run.planPath, 'utf8');
    fs.writeFileSync(run.planPath, planFormat.updateFrontmatterStatus(content, status), 'utf8');
  } catch (_) {}
  _emit('plan:status', { planId: run.planId, status });
}

// ── Scheduling ────────────────────────────────────────────────────────────────

// A task's effective dependencies: explicit `dependsOn` plus — when Mode is
// sequential — the previous task number, so "sequential" chains 1→2→3 even
// without explicit Depends on fields.
function _effectiveDeps(run, task) {
  const deps = new Set(task.dependsOn || []);
  if (String(task.mode || '').toLowerCase() === 'sequential') {
    const prev = run.tasks.filter(t => t.num < task.num).map(t => t.num).pop();
    if (prev !== undefined) deps.add(prev);
  }
  return [...deps];
}

function _depsDone(run, task) {
  return _effectiveDeps(run, task).every(dep => {
    const r = run.results.get(dep);
    return r !== undefined && r._status === 'done';
  });
}

function _depsFailed(run, task) {
  return _effectiveDeps(run, task).some(dep => {
    const r = run.results.get(dep);
    return r !== undefined && r._status !== 'done';
  });
}

async function _dispatchTask(run, task) {
  let prompt = task.prompt || task.title;
  // Inject upstream results so "the doc I just made" resolves in the child run.
  const depBits = _effectiveDeps(run, task)
    .map(dep => run.results.get(dep))
    .filter(r => r && r._status === 'done' && r.result)
    .map((r, i) => `Result of earlier step ${i + 1}: ${String(r.result).slice(0, 300)}`);
  if (depBits.length) {
    prompt = `[Prior step results — context only]\n${depBits.join('\n')}\n\n[Your task]\n${prompt}`;
  }

  // Re-normalize steps at dispatch — heals plans generated before the
  // service-resolution fix (stale web.agent docs.new steps → google.agent),
  // and produces the lock agent: first non-generic (service) canonical agent.
  let steps = Array.isArray(task.steps) && task.steps.length ? task.steps : null;
  let lockAgent = _canonicalAgent(task.agents?.[0]);
  if (steps) {
    try {
      const { normalizeTaskStepsAsync } = require('../../shared/plan-steps.cjs');
      const norm = await normalizeTaskStepsAsync(task);
      steps = norm.steps;
      const serviceAgent = norm.agents.find(a => !_isGenericAgent(a));
      if (serviceAgent) lockAgent = serviceAgent;
    } catch (_) {}
  }

  // Dispatch gate — degenerate step lists (per-field dom.act chains without a
  // verify step, or generation that exhausted retries) fall back to live
  // planning: deterministicPlan:null → planSkillsV2 plans with live context.
  const degenerate = steps ? _stepsLookDegenerate(task, steps) : null;
  if (degenerate) {
    console.warn(`[PlanRunner] Task ${task.num} steps degenerate (${degenerate}) — dispatching deterministicPlan:null for live planning`);
    steps = null;
  }

  const resp = await _postToComms('/comms.proactive', {
    prompt,
    sessionId: run.sessionId,
    // Canonical agentId → agentLock serializes tasks that share one session
    // (google_docs/calendar/sheets → google.agent). Same-service "parallel"
    // tasks cannot run side-by-side — they would collide on the profile's
    // single browser window; different services still parallelize.
    agentId: lockAgent,
    userApproved: true,          // plan was approved by the user at run time
    planId: run.planId,
    planTaskNum: task.num,
    planTask: true,              // → stategraph _planTask short-circuit
    preflightAuthBypass: run.bypassed.size ? [...run.bypassed] : null,
    // Steps pre-generated during planning → stategraph adopts them as
    // _deterministicPlan and skips the LLM planning pass entirely.
    deterministicPlan: steps,
    source: 'plan',
  });
  if (!resp || !resp.taskId) {
    _writeTaskStatus(run, task.num, planFormat.TASK_STATUS.FAILED, 'Dispatch to comms-graph failed');
    run.results.set(task.num, { _status: 'failed', result: 'dispatch failed' });
    return;
  }
  run.dispatched.set(task.num, resp.taskId);
  _writeTaskStatus(run, task.num, planFormat.TASK_STATUS.RUNNING);
}

/** Re-scan the run and dispatch every task whose dependencies are satisfied. */
async function _schedule(run) {
  if (run.cancelled) return;
  let dispatchedAny = false;
  for (const task of run.tasks) {
    if (run.dispatched.has(task.num) || run.results.has(task.num)) continue;
    if (task.status === planFormat.TASK_STATUS.RUNNING || task.status === planFormat.TASK_STATUS.DONE) continue;
    if (_depsFailed(run, task)) {
      _writeTaskStatus(run, task.num, planFormat.TASK_STATUS.SKIPPED, 'Dependency failed');
      run.results.set(task.num, { _status: 'skipped', result: 'dependency failed' });
      dispatchedAny = true;
      continue;
    }
    if (!_depsDone(run, task)) continue;
    // Approval gate — commit-type tasks (book/buy/send/…) hold here until the
    // user reviews what the gather tasks produced and approves via the
    // plan:review card / voice "go ahead". Held tasks are NOT stuck.
    if (task.approval === 'required' && !run.approved.has(task.num)) {
      if (!run.reviewRequested.has(task.num)) {
        run.reviewRequested.add(task.num);
        const priorResults = _effectiveDeps(run, task)
          .map(dn => ({ taskNum: dn, result: run.results.get(dn)?.result || null }))
          .filter(r => r.result);
        const payload = {
          planId: run.planId,
          taskNum: task.num,
          title: task.title,
          prompt: task.prompt,
          priorResults,
        };
        _emit('plan:review', payload);
        if (_onReview) { try { _onReview(payload); } catch (_) {} }
      }
      continue;
    }
    run.dispatched.set(task.num, null); // mark in-flight before await
    await _dispatchTask(run, task);
    dispatchedAny = true;
  }

  // Terminal check: everything has a result and nothing is in-flight.
  if (run.tasks.every(t => run.results.has(t.num))) {
    const failed = run.tasks.filter(t => run.results.get(t.num)?._status !== 'done');
    _writePlanStatus(run, failed.length ? 'failed' : 'done');
    _emit('plan:complete', {
      planId: run.planId,
      status: failed.length ? 'failed' : 'done',
      failedTasks: failed.map(t => t.num),
      results: [...run.results.entries()].map(([n, r]) => ({ taskNum: n, status: r._status, result: r.result || null })),
    });
    _runs.delete(run.planId);
  } else if (!dispatchedAny && ![...run.dispatched.values()].length) {
    // Held-for-review tasks aren't stuck — only fail tasks that are neither
    // resulted, dispatched, nor awaiting approval.
    const stuck = run.tasks.filter(t =>
      !run.results.has(t.num)
      && !(t.approval === 'required' && !run.approved.has(t.num)));
    if (stuck.length) {
      for (const t of stuck) {
        _writeTaskStatus(run, t.num, planFormat.TASK_STATUS.FAILED, 'Unsatisfiable dependencies');
        run.results.set(t.num, { _status: 'failed', result: 'unsatisfiable dependencies' });
      }
      _writePlanStatus(run, 'failed');
      _runs.delete(run.planId);
    }
  }
}

// ── Completion hook (wired from handoffRunner via setOnTaskComplete) ─────────

/**
 * Called by handoffRunner whenever a journal task reaches a status.
 * Maps (taskId) back to the plan run and advances scheduling.
 */
function onTaskComplete(taskId, status, result) {
  for (const run of _runs.values()) {
    for (const [taskNum, tid] of run.dispatched.entries()) {
      if (tid !== taskId) continue;
      const isDone = status === 'done';
      const isFailed = status === 'failed' || status === 'cancelled' || status === 'auth-required';
      if (!isDone && !isFailed) return; // awaiting-approval / waiting-for-input — still active
      const summary = isDone ? (typeof result === 'string' ? result : (result?.answer || '')) : `Task ${status}: ${result || ''}`;
      run.results.set(taskNum, { _status: isDone ? 'done' : status, result: summary });
      _writeTaskStatus(run, taskNum,
        isDone ? planFormat.TASK_STATUS.DONE : planFormat.TASK_STATUS.FAILED, summary);
      _schedule(run).catch(err => console.warn(`[PlanRunner] schedule error: ${err.message}`));
      return;
    }
  }
}

/**
 * Register the journal taskId for a dispatched plan task.
 * main.js calls this when /comms.proactive returns the taskId — the runner
 * needs it to match completions and support cancel.
 */
function bindTaskId(planId, taskNum, taskId) {
  const run = _runs.get(planId);
  if (run && run.dispatched.has(taskNum)) run.dispatched.set(taskNum, taskId);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start (or resume) a plan. Checks the auth run-gate first.
 * @param {string} planPath - absolute path to plan.md
 * @param {Object} [opts]
 * @param {string[]} [opts.bypassAgents] - agents the user bypassed for auth
 * @param {string} [opts.sessionId]
 * @returns {{ok:boolean, planId:string, blockers?:Array, error?:string}}
 */
async function startPlan(planPath, opts = {}) {
  const planId = _planIdFromPath(planPath);
  if (_runs.has(planId)) {
    // Already running — just re-enter the scheduler (idempotent resume).
    await _schedule(_runs.get(planId));
    return { ok: true, planId, resumed: true };
  }

  let plan;
  try { plan = _loadPlan(planPath); } catch (err) {
    return { ok: false, planId, error: `Cannot read plan: ${err.message}` };
  }
  if (!planFormat.isTaskPlan(plan.content) || !plan.tasks.length) {
    return { ok: false, planId, error: 'Plan has no ## Task sections — use planExecutor for legacy plans' };
  }

  const bypassed = new Set([...(opts.bypassAgents || []), ...((plan.fm.auth_bypass && plan.fm.auth_bypass !== '[]')
    ? JSON.parse(plan.fm.auth_bypass) : [])].map(a => String(a).toLowerCase()));

  // Run gate — unresolved auth blocks start unless bypassed.
  try {
    const { assessRunGate } = require('../../comms-graph/src/planPreflight.cjs');
    const gate = assessRunGate(plan.tasks, bypassed);
    if (!gate.ok) {
      _onAuthRequired && _onAuthRequired(planId, gate.blockers, planPath);
      _emit('plan:auth_required', { planId, blockers: gate.blockers });
      return { ok: false, planId, blockers: gate.blockers };
    }
  } catch (err) {
    console.warn(`[PlanRunner] Run-gate assessment failed (proceeding): ${err.message}`);
  }

  // Persist the bypass decision so restarts keep it.
  if (bypassed.size) {
    try {
      fs.writeFileSync(planPath,
        planFormat.setFrontmatterField(plan.content, 'auth_bypass', JSON.stringify([...bypassed])), 'utf8');
    } catch (_) {}
  }

  // Heal stale per-task '🔄 running' — reachable only when no live run exists
  // (_runs.has early-return above), so a disk 'running' marker is definitionally
  // an orphan from a crashed/interrupted run. Without this, _schedule skips the
  // task and a resumed plan fails it as 'Unsatisfiable dependencies'.
  try {
    const staleRunning = plan.tasks.filter(t => t.status === planFormat.TASK_STATUS.RUNNING);
    if (staleRunning.length) {
      let content = plan.content;
      for (const t of staleRunning) {
        content = planFormat.updateTaskStatus(content, t.num, planFormat.TASK_STATUS.PENDING, null);
        t.status = planFormat.TASK_STATUS.PENDING;
      }
      fs.writeFileSync(planPath, content, 'utf8');
      plan.content = content;
      console.log(`[PlanRunner] Healed ${staleRunning.length} stale running task(s): ${planId}`);
    }
  } catch (err) {
    console.warn(`[PlanRunner] Stale-running heal failed (proceeding): ${err.message}`);
  }

  const run = {
    planId,
    planPath,
    tasks: plan.tasks,
    results: new Map(),
    dispatched: new Map(),
    status: 'running',
    sessionId: opts.sessionId || plan.fm.plan_session_id || null,
    bypassed,
    approved: new Set(),        // task nums the user approved at the review gate
    reviewRequested: new Set(), // dedupe — one plan:review emit per task
    cancelled: false,
  };
  // Pre-fill results for tasks already done (restart/resume mid-run).
  for (const t of plan.tasks) {
    if (t.status === planFormat.TASK_STATUS.DONE) run.results.set(t.num, { _status: 'done', result: t.result });
  }
  _runs.set(planId, run);
  _writePlanStatus(run, 'running');
  await _schedule(run);
  return { ok: true, planId };
}

function cancelPlan(planId) {
  const run = _runs.get(planId);
  if (!run) return false;
  run.cancelled = true;
  // One atomic plan-scoped cancel: marks every plan task 'cancelled' in the
  // journal first, then removes each — parked ('waiting-for-agent') tasks can
  // never be resumed by a sibling's lock release.
  _postToComms('/comms.cancel', { planId }).catch(() => {});
  // Kill anything already spawned in main.
  try {
    const handoffRunner = require('./handoffRunner');
    for (const taskId of run.dispatched.values()) {
      if (taskId) try { handoffRunner.cancel(taskId); } catch (_) {}
    }
  } catch (_) {}
  // Undispatched tasks never started — mark them skipped in the plan file.
  for (const task of run.tasks) {
    if (!run.results.has(task.num) && !run.dispatched.has(task.num)) {
      _writeTaskStatus(run, task.num, planFormat.TASK_STATUS.SKIPPED || 'skipped', 'Plan cancelled');
    }
  }
  _writePlanStatus(run, 'cancelled');
  _runs.delete(planId);
  return true;
}

/**
 * Review-gate resolution — called from main.js when the user approves or
 * skips a held commit task. Approving schedules it for dispatch; skipping
 * marks it skipped (dependents then skip via _depsFailed).
 */
async function approvePlanTask(planId, taskNum, { skip = false } = {}) {
  const run = _runs.get(planId);
  if (!run) return { ok: false, error: 'no active run for plan' };
  const task = run.tasks.find(t => t.num === taskNum);
  if (!task) return { ok: false, error: `no task ${taskNum}` };
  run.reviewRequested.delete(taskNum);
  if (skip) {
    _writeTaskStatus(run, taskNum, planFormat.TASK_STATUS.SKIPPED, 'Skipped at review gate');
    run.results.set(taskNum, { _status: 'skipped', result: 'skipped by user at review' });
  } else {
    run.approved.add(taskNum);
  }
  _emit('plan:review', { planId, taskNum, resolved: true, skipped: skip });
  if (_onReview) { try { _onReview({ planId, taskNum, resolved: true }); } catch (_) {} }
  await _schedule(run);
  return { ok: true };
}

function getRun(planId) { return _runs.get(planId) || null; }
function listRuns() {
  return [..._runs.values()].map(r => ({
    planId: r.planId, status: r.status,
    tasks: r.tasks.map(t => ({ num: t.num, title: t.title, status: t.status })),
  }));
}

module.exports = { init, startPlan, cancelPlan, getRun, listRuns, onTaskComplete, bindTaskId, approvePlanTask };
