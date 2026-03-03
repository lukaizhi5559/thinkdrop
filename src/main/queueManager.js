/**
 * queueManager.js — In-memory queue + cron store for ResultsWindow tabs.
 *
 * Acts as the source of truth for the renderer's Queue and Cron tabs.
 * DuckDB persistence will be wired in a later pass; for now items are kept
 * in memory and survive for the lifetime of the Electron process.
 *
 * IPC contracts (main → renderer):
 *   queue:update  — full QueueItem[] snapshot
 *   cron:update   — full CronItem[] snapshot
 *
 * IPC contracts (renderer → main, handled in main.js):
 *   queue:rerun   { id }
 *   queue:cancel  { id }
 *   cron:toggle   { id }
 *   cron:delete   { id }
 *   cron:run-now  { id }
 */

const { randomBytes } = require('crypto');

// ── In-memory stores ──────────────────────────────────────────────────────────
/** @type {Map<string, import('../../src/renderer/components/TabComponents').QueueItem>} */
const _queue = new Map();
/** @type {Map<string, import('../../src/renderer/components/TabComponents').CronItem>} */
const _cron  = new Map();

/** @type {((items: any[]) => void) | null} */
let _broadcastQueue = null;
/** @type {((items: any[]) => void) | null} */
let _broadcastCron  = null;

// ── Init: inject broadcast callbacks from main.js ────────────────────────────
/**
 * @param {{ queue: (items: any[]) => void, cron: (items: any[]) => void }} callbacks
 */
function init({ queue, cron }) {
  _broadcastQueue = queue;
  _broadcastCron  = cron;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _uid() {
  return `q_${randomBytes(4).toString('hex')}`;
}

function _broadcastQueueNow() {
  if (_broadcastQueue) _broadcastQueue(Array.from(_queue.values()));
}

function _broadcastCronNow() {
  if (_broadcastCron) _broadcastCron(Array.from(_cron.values()));
}

// ── Queue API ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a new task and immediately broadcast.
 * Returns the new item id.
 */
function enqueue(prompt, { projectName } = {}) {
  const id = _uid();
  _queue.set(id, {
    id,
    prompt,
    status: 'waiting',
    createdAt: Date.now(),
    projectName: projectName || null,
  });
  _broadcastQueueNow();
  return id;
}

/**
 * Transition a queue item to a new status.
 */
function setQueueStatus(id, status, { error } = {}) {
  const item = _queue.get(id);
  if (!item) return;
  _queue.set(id, { ...item, status, updatedAt: Date.now(), error: error || item.error });
  _broadcastQueueNow();
}

/**
 * Remove a queue item entirely.
 */
function removeQueueItem(id) {
  _queue.delete(id);
  _broadcastQueueNow();
}

/**
 * Get a snapshot of all queue items.
 */
function getQueue() {
  return Array.from(_queue.values());
}

// ── Cron API ──────────────────────────────────────────────────────────────────

/**
 * Register a cron task (called after a scheduled task is confirmed).
 */
function registerCron({ id, label, schedule, nextRun, plistLabel } = {}) {
  const cronId = id || `cron_${randomBytes(4).toString('hex')}`;
  _cron.set(cronId, {
    id: cronId,
    label: label || 'Unnamed task',
    schedule: schedule || 'Custom schedule',
    nextRun: nextRun || null,
    lastRun: null,
    status: 'active',
    plistLabel: plistLabel || null,
  });
  _broadcastCronNow();
  return cronId;
}

/**
 * Mark a cron task's last run time and update status.
 */
function recordCronRun(id) {
  const item = _cron.get(id);
  if (!item) return;
  _cron.set(id, { ...item, lastRun: new Date().toLocaleTimeString(), status: 'idle' });
  _broadcastCronNow();
}

/**
 * Toggle a cron task between active/paused.
 */
function toggleCron(id) {
  const item = _cron.get(id);
  if (!item) return;
  const next = item.status === 'paused' ? 'active' : 'paused';
  _cron.set(id, { ...item, status: next });
  _broadcastCronNow();
}

/**
 * Remove a cron task.
 */
function removeCron(id) {
  _cron.delete(id);
  _broadcastCronNow();
}

/**
 * Get a snapshot of all cron tasks.
 */
function getCron() {
  return Array.from(_cron.values());
}

/**
 * Sync cron entries from the scheduler's pending-schedule records.
 * Call this once at app startup after scheduler is initialized.
 */
function syncFromScheduler(pendingItems = []) {
  for (const p of pendingItems) {
    if (!_cron.has(p.id)) {
      registerCron({
        id: p.id,
        label: p.label,
        schedule: p.targetMs
          ? `Once at ${new Date(p.targetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'Scheduled',
        plistLabel: p.plistLabel || null,
      });
    }
  }
}

module.exports = {
  init,
  // queue
  enqueue,
  setQueueStatus,
  removeQueueItem,
  getQueue,
  // cron
  registerCron,
  recordCronRun,
  toggleCron,
  removeCron,
  getCron,
  syncFromScheduler,
};
