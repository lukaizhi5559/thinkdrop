'use strict';
/**
 * gatherPending.cjs — lifecycle authority tests.
 * Run: node src/main/gatherPending.test.cjs
 *
 * Regression coverage for the input-lockout bug: task:cancel / task:delete
 * killed the task without draining its pending gather batch, so a stale
 * single-question batch kept intercepting every typed submit as an "answer"
 * to a dead wait while the card and gather:pending state never cleared.
 */

const assert = require('assert');
const gp = require('./gatherPending.cjs');

// ── Effect recorder — injected IPC/journal effects ──────────────────────────
let emits;
function reset() {
  emits = [];
  gp.batches.clear();
  gp.setLegacy(null);
  gp.init({
    sendUnified: (ch, payload) => emits.push(['unified', ch, payload]),
    postUserWait: (taskId, waiting) => emits.push(['userwait', taskId, waiting]),
    postThought: (text) => emits.push(['thought', text]),
    sendGhost: (ch, payload) => emits.push(['ghost', ch, payload]),
  });
}
reset();

function addBatch(key, { taskId = null, questions = [{ id: 'q1', text: 'pick?' }] } = {}) {
  let resolved = null;
  gp.batches.set(key, {
    resolve: (v) => { resolved = v; },
    data: { batchId: key, questions, taskId },
    timer: setTimeout(() => {}, 60000),
  });
  return { get resolved() { return resolved; } };
}

// ── resolveBatch is the complete settle ──────────────────────────────────────
{
  const b = addBatch('b1', { taskId: 'task_A' });
  assert(gp.resolveBatch('b1', { q1: 'answer one' }), 'resolveBatch resolves');
  assert(b.resolved?.q1 === 'answer one', 'answer delivered to waiter');
  assert(!gp.batches.size, 'batch removed');
  const clear = emits.find(e => e[0] === 'unified' && e[1] === 'gather:question_batch');
  assert(clear && clear[2].active === false && clear[2].taskId === 'task_A', 'card-clear emitted with taskId');
  assert(emits.some(e => e[0] === 'userwait' && e[1] === 'task_A' && e[2] === false), 'waiting-for-input cleared');
  assert(emits.some(e => e[0] === 'ghost' && e[1] === 'gather:question-pending' && e[2].active === false), 'beacon cleared');
}
reset();

// ── THE BUG: task cancel drains only its own tagged batches ─────────────────
{
  const dead = addBatch('deadBatch', { taskId: 'task_DEAD' });
  const live = addBatch('liveBatch', { taskId: 'task_LIVE' });
  const n = gp.drainForTasks('task_DEAD');
  assert(n === 1, `drained 1, got ${n}`);
  assert(dead.resolved && Object.keys(dead.resolved).length === 0, 'dead batch resolved empty');
  assert(gp.batches.has('liveBatch') && !gp.batches.has('deadBatch'), 'unrelated batch survives');
  assert(live.resolved === null, 'live wait untouched');
  const clear = emits.filter(e => e[0] === 'unified' && e[1] === 'gather:question_batch');
  assert(clear.length === 1 && clear[0][2].taskId === 'task_DEAD', 'clear scoped to dead task');
  // The live batch is a REAL pending question — free text still routes to it.
  assert(gp.tryResolveFreeText('answer to live'), 'live pending batch still intercepts typed text');
  assert(live.resolved?.q1 === 'answer to live', 'answer attributed to the live batch');
  // THE LOCKOUT REGRESSION: once nothing is pending, typed text must NOT be eaten.
  assert(!gp.tryResolveFreeText('new prompt'), 'empty state → free text flows to comms');
}
reset();

// ── Untagged batches: serial-run only, gated by the untagged flag ────────────
{
  const serial = addBatch('serialBatch', { taskId: null });
  assert(gp.drainForTasks('task_X') === 0, 'untagged batch not drained by task cancel');
  assert(gp.batches.has('serialBatch'), 'untagged survives task-scoped drain');
  assert(gp.drainForTasks('task_X', { untagged: true }) === 1, 'untagged drains under flag');
  assert(serial.resolved, 'serial wait resolved');
}
reset();

// ── Legacy single-question wait ──────────────────────────────────────────────
{
  let resolved = null;
  gp.setLegacy({ resolve: (v) => { resolved = v; }, question: 'which one?', taskId: null });
  assert(gp.drainForTasks('task_X') === 0, 'untagged legacy survives task drain');
  assert(gp.getLegacy(), 'legacy still pending');
  assert(gp.drainForTasks('task_X', { legacy: true }) === 1, 'legacy drains under flag');
  assert(resolved === '', 'legacy resolved with empty dismissal');
  assert(!gp.getLegacy(), 'legacy cleared');
  assert(emits.some(e => e[0] === 'unified' && e[1] === 'gather:pending' && e[2].active === false), 'gather:pending cleared — composer freed');
}
reset();

// Tagged legacy (future-proof) drains on its task.
{
  let resolved = null;
  gp.setLegacy({ resolve: (v) => { resolved = v; }, question: 'q?', taskId: 'task_T' });
  assert(gp.drainForTasks('task_T') === 1, 'tagged legacy drains on its task');
  assert(resolved === '', 'resolved empty');
}
reset();

// ── Serial-abort drain = automation cancel semantics ─────────────────────────
{
  const a = addBatch('a', { taskId: 'task_1' });
  const b = addBatch('b', { taskId: null });
  let leg = null;
  gp.setLegacy({ resolve: (v) => { leg = v; }, question: 'q', taskId: null });
  const n = gp.drainForTasks(new Set(['task_1']), { untagged: true, legacy: true });
  assert(n === 3, `serial abort drains all, got ${n}`);
  assert(a.resolved && b.resolved && leg === '', 'everything settled');
  assert(!gp.batches.size && !gp.getLegacy(), 'state empty');
}
reset();

// ── tryResolveFreeText: the interceptor that caused the visible lockout ──────
{
  const single = addBatch('s1', { taskId: 'task_S' });
  assert(gp.tryResolveFreeText('the second one'), 'single-question batch intercepts');
  assert(single.resolved?.q1 === 'the second one', 'text attributed to the question');
}
reset();
{
  addBatch('m1', { questions: [{ id: 'a', text: 'first?' }, { id: 'b', text: 'second?' }] });
  assert(!gp.tryResolveFreeText('the second one'), 'multi-question batch never intercepted by free text');
  gp.batches.clear();
  addBatch('x1'), addBatch('x2');
  assert(!gp.tryResolveFreeText('anything'), 'two pending batches → no free-text hijack');
}
reset();

// ── resolveLegacy emits the clears ───────────────────────────────────────────
{
  let resolved = null;
  gp.setLegacy({ resolve: (v) => { resolved = v; }, question: 'which file?', taskId: 'task_L' });
  assert(gp.resolveLegacy('the first file', { thought: true }), 'legacy resolves');
  assert(resolved === 'the first file', 'answer delivered');
  assert(emits.some(e => e[0] === 'unified' && e[1] === 'gather:pending' && e[2].active === false), 'pending cleared');
  assert(emits.some(e => e[0] === 'userwait' && e[1] === 'task_L' && e[2] === false), 'tagged legacy clears userwait');
  assert(emits.some(e => e[0] === 'thought' && /answered a clarifying question/.test(e[1])), 'thought audit on answer');
  assert(!gp.resolveLegacy('x'), 'second resolve no-ops');
}
reset();

// ── findBatchKey resolution order ────────────────────────────────────────────
{
  addBatch('kb1', { taskId: 'task_1' });
  addBatch('kb2', { taskId: 'task_2' });
  assert(gp.findBatchKey({ batchId: 'kb2' }) === 'kb2', 'explicit batchId wins');
  assert(gp.findBatchKey({ taskId: 'task_1' }) === 'kb1', 'taskId lookup');
  assert(gp.findBatchKey({}) === null, 'two batches → no size-1 fallback');
  gp.batches.delete('kb2');
  assert(gp.findBatchKey({}) === 'kb1', 'single-batch fallback');
}
reset();

// ── resurface re-emits live waits after hide/show ────────────────────────────
{
  addBatch('rb', { taskId: 'task_R' });
  gp.setLegacy({ resolve: () => {}, question: 'serial q', taskId: null });
  gp.resurface();
  const pend = emits.find(e => e[0] === 'unified' && e[1] === 'gather:pending');
  assert(pend && pend[2].active === true && pend[2].question === 'serial q', 'legacy re-surfaced');
  const batch = emits.find(e => e[0] === 'unified' && e[1] === 'gather:question_batch');
  assert(batch && batch[2].active === true && batch[2].taskId === 'task_R', 'batch re-surfaced with taskId');
}
reset();

// ── pendingSummary (beacon payload) ──────────────────────────────────────────
{
  addBatch('pb', { taskId: 'task_P', questions: [{ id: 'q1' }, { id: 'q2' }] });
  gp.setLegacy({ resolve: () => {}, question: 'leg?', taskId: null });
  const s = gp.pendingSummary();
  assert(s.length === 2, 'both waits summarized');
  assert(s[0].count === 2 && s[0].taskId === 'task_P', 'batch counted + tagged');
  assert(s[1].batchId === null && s[1].taskId === null, 'legacy untagged');
}
reset();

console.log('gatherPending.test.cjs — all assertions passed');
