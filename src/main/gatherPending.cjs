'use strict';
/**
 * gatherPending.cjs — pending gather-question lifecycle authority.
 *
 * Owns every "waiting for the user's answer" wait the main process holds:
 *   - batches:  task-scoped question batches (Grill-Me/clarify/ask_user cards).
 *               Handoff tasks ALWAYS tag entries with data.taskId —
 *               handoffRunner._taskGatherCallback normalizes even legacy string
 *               asks into {batch:true, taskId} so card rendering and drains are
 *               task-precise. Untagged batches belong to the serial run.
 *   - legacy:   the single pendingGatherResolve-style wait — serial-run only;
 *               taskId is null today but honored when set.
 *
 * The one rule this module enforces: every wait reaches a terminal state
 * through ONE settle path, no matter which cancel entrypoint fired
 * (automation cancel, task:cancel, task:delete, timeout, answer). Before this
 * module, task:cancel/task:delete killed the task without draining its batch —
 * the stale single-question batch then intercepted every typed submit as an
 * "answer" to a dead wait and gather:pending never cleared: permanent input
 * lockout.
 *
 * All outward effects (IPC to renderer, comms-graph journal, GhostLayer
 * beacon, thought-engine audit) are injected via init() so the lifecycle is
 * testable without Electron.
 */

const batches = new Map(); // batchId → { resolve, data: { batchId, questions, routeConfirmation, taskId }, timer }
let legacy = null;         // { resolve, question, taskId }

let fx = {
  sendUnified: () => {},   // safeSendUnified(channel, payload)
  postUserWait: () => {},  // _postUserWait(taskId, waiting)
  postThought: () => {},   // _postThoughtInput(text)
  sendGhost: () => {},     // _sendGhostChannel(channel, payload)
};

function init(effects) { Object.assign(fx, effects || {}); }

function getLegacy() { return legacy; }
function setLegacy(entry) { legacy = entry || null; }

function pendingSummary() {
  const pending = [];
  for (const [k, e] of batches) {
    const qs = e.data?.questions || [];
    pending.push({
      batchId: k,
      taskId: e.data?.taskId || null,
      count: qs.length || 1,
      question: qs[0]?.question || qs[0]?.text || '',
    });
  }
  if (legacy) {
    pending.push({ batchId: null, taskId: legacy.taskId || null, count: 1, question: legacy.question || '' });
  }
  return pending;
}

// GhostLayer "waiting for your answer" beacon — broadcast on every mutation.
function broadcastPending() {
  const pending = pendingSummary();
  fx.sendGhost('gather:question-pending', {
    active: pending.length > 0,
    total: pending.reduce((n, p) => n + p.count, 0),
    pending: pending.slice(0, 5),
  });
}

// THE settle path: clear card + userwait + beacon, audit, resolve the awaited
// promise. Empty {} answers = dismissal (timeout, cancel drain).
function resolveBatch(key, answers) {
  const entry = batches.get(key);
  if (!entry) return false;
  batches.delete(key);
  clearTimeout(entry.timer);
  const questions = entry.data?.questions || [];
  const batchTaskId = entry.data?.taskId || null;
  fx.sendUnified('gather:question_batch', { active: false, batchId: key, questions: null, taskId: batchTaskId });
  fx.postUserWait(batchTaskId, false);
  broadcastPending();
  const answered = Object.entries(answers || {}).filter(([, v]) => String(v ?? '').trim());
  if (answered.length) {
    const qa = answered.map(([qid, v]) => {
      const q = questions.find((x) => x && x.id === qid);
      return `"${(q?.question || q?.text || qid).slice(0, 80)}" → "${String(v).slice(0, 100)}"`;
    }).join('; ');
    fx.postThought(`User answered clarifying questions about their request — ${qa}`);
  } else {
    fx.postThought('User dismissed the clarifying questions without answering.');
  }
  try { entry.resolve(answers || {}); } catch (_) {}
  return true;
}

// The legacy settle path — same contract as resolveBatch for the serial-run
// single-question wait. thought: the gather:answer IPC audits answers; typed /
// voice / cancel-drain paths historically don't.
function resolveLegacy(answer, { thought = false } = {}) {
  if (!legacy) return false;
  const { resolve, question, taskId } = legacy;
  legacy = null;
  fx.sendUnified('gather:pending', { active: false, question: null });
  if (taskId) fx.postUserWait(taskId, false);
  broadcastPending();
  if (thought) {
    fx.postThought(`User answered a clarifying question — "${(question || '').slice(0, 120)}" → "${String(answer || '').slice(0, 160)}"`);
  }
  try { resolve(answer); } catch (_) {}
  return true;
}

// Drain every wait owned by the given task(s). Called from ALL cancel
// entrypoints so a dead task can never leave a live wait behind:
//   - task:cancel / task:delete → drainForTasks(taskId) — tagged batches only.
//   - _cancelAutomationRun    → drainForTasks(deadTaskIds, { untagged: serialAborted, legacy: true })
//     (untagged state is serial-run state — drain it only when the serial run
//     itself aborted; legacy was unconditional before and stays so here).
// Returns the number of waits settled.
function drainForTasks(taskIds, { untagged = false, legacy: drainLegacy = false } = {}) {
  const ids = taskIds instanceof Set ? taskIds : new Set([].concat(taskIds || []).filter(Boolean));
  let n = 0;
  for (const [k, e] of batches) {
    const btid = e.data?.taskId || null;
    if (btid ? !ids.has(btid) : !untagged) continue;
    if (resolveBatch(k, {})) n++;
  }
  if (legacy && (drainLegacy || (legacy.taskId && ids.has(legacy.taskId)))) {
    if (resolveLegacy('')) n++;
  }
  return n;
}

// Settle EVERY pending wait — a fresh user prompt supersedes all outstanding
// question cards (tagged batches, untagged batches, and the legacy wait).
// Same single settle path as drainForTasks: each wait resolves {} so the
// card clears (gather:question_batch active:false), userwait flips off, and
// the awaiting task proceeds as "dismissed" instead of hanging on a card the
// user already moved past.
function drainAll() {
  const ids = [...batches.values()].map(e => e.data?.taskId).filter(Boolean);
  return drainForTasks(ids, { untagged: true, legacy: true });
}

// Free-text answers (typed prompt or voice transcript) resolve a pending
// batch instead of spawning a new task — single-question batches only; free
// text can't attribute answers to multiple slots.
function tryResolveFreeText(text) {
  if (!text || batches.size !== 1) return false;
  const [key, entry] = [...batches.entries()][0];
  const qs = entry.data?.questions || [];
  if (qs.length !== 1) return false;
  const qid = qs[0].id || 'q1';
  console.log(`[GatherContext] free-text intercepted as batch answer — "${String(text).slice(0, 60)}" → batch ${key}`);
  resolveBatch(key, { [qid]: text });
  return true;
}

// Locate the batch an answer belongs to: explicit batchId first, then owning
// taskId, then the single-pending-batch fallback (older renderers that didn't
// echo batchId still resolve correctly).
function findBatchKey({ batchId, taskId } = {}) {
  if (batchId && batches.has(batchId)) return batchId;
  if (taskId) {
    for (const [k, e] of batches) { if (e.data?.taskId === taskId) return k; }
  }
  if (batches.size === 1) return [...batches.keys()][0];
  return null;
}

// Re-surface live waits after a hide/show cycle — renderer gather state resets
// on window show, so every pending card/pill must be re-emitted.
function resurface() {
  if (legacy) {
    fx.sendUnified('gather:pending', { active: true, question: legacy.question });
  }
  for (const [, entry] of batches) {
    fx.sendUnified('gather:question_batch', {
      active: true,
      batchId: entry.data.batchId,
      questions: entry.data.questions,
      routeConfirmation: entry.data.routeConfirmation || null,
      taskId: entry.data.taskId || null,
    });
  }
}

module.exports = {
  init,
  batches,
  getLegacy,
  setLegacy,
  pendingSummary,
  broadcastPending,
  resolveBatch,
  resolveLegacy,
  drainForTasks,
  drainAll,
  tryResolveFreeText,
  findBatchKey,
  resurface,
};
