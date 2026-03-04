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
const http = require('http');

// ── Creator pipeline helper ───────────────────────────────────────────────────
/**
 * POST to the command-service /command.automate endpoint.
 * Returns the parsed response body or throws on network/parse error.
 */
function _callCommandService(skill, args, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill, args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: port || parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10),
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs || 300000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('command-service timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
 * @param {string} id
 * @param {string} status
 * @param {{ error?: string, round?: object, skillName?: string, skillSecrets?: string[] }} [extra]
 */
function setQueueStatus(id, status, { error, round, skillName, skillSecrets } = {}) {
  const item = _queue.get(id);
  if (!item) return;
  const rounds = round
    ? [...(item.rounds || []).filter(r => r.round !== round.round), round]
    : item.rounds;
  _queue.set(id, {
    ...item,
    status,
    updatedAt: Date.now(),
    error: error || item.error,
    rounds,
    ...(skillName    != null ? { skillName }    : {}),
    ...(skillSecrets != null ? { skillSecrets } : {}),
  });
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

// ── Creator pipeline ──────────────────────────────────────────────────────────
// Active AbortControllers keyed by queue item id — for queue:cancel support.
const _creatorAborts = new Map();

/**
 * Submit a prompt through the full creator.agent → reviewer.agent pipeline.
 * Drives queue item through: waiting → planning → building → testing → done | error
 *
 * @param {string} prompt      User's project prompt
 * @param {object} [opts]
 * @param {string} [opts.name] Optional project name slug
 * @param {number} [opts.port] command-service port override
 * @returns {Promise<{ id: string, projectId: string, verdict: string }>}
 */
async function submitToCreator(prompt, { name, port } = {}) {
  const id = enqueue(prompt, { projectName: name || null });
  const logger = console;

  const abort = new AbortController();
  _creatorAborts.set(id, abort);

  async function phase(status, fn) {
    if (abort.signal.aborted) throw new Error('cancelled');
    setQueueStatus(id, status);
    return fn();
  }

  try {
    // ── planning: Phase 1 + 2 (BDD tests + agent plan) ──────────────────────
    const createResult = await phase('planning', async () => {
      const res = await _callCommandService('creator.agent', {
        action: 'create_project',
        prompt,
        name: name || undefined,
      }, port, 600000);
      const data = res?.data || res;
      if (!data?.ok) throw new Error(data?.error || 'creator.agent create_project failed');
      return data;
    });

    const projectId = createResult.id;

    // Update item with project name now that we have it
    const item = _queue.get(id);
    if (item) _queue.set(id, { ...item, projectName: projectId });
    _broadcastQueueNow();

    // ── building: Phase 3 already ran inside create_project (prototype scaffold)
    // We just transition the label so the UI shows the right phase.
    setQueueStatus(id, 'building');

    // ── testing: reviewer.agent gate ─────────────────────────────────────────
    const reviewResult = await phase('testing', async () => {
      const res = await _callCommandService('reviewer.agent', {
        action: 'review',
        projectId,
      }, port, 180000);
      const data = res?.data || res;
      if (!data) throw new Error('reviewer.agent returned no data');
      return data;
    });

    // ── done ──────────────────────────────────────────────────────────────────
    const verdict = reviewResult?.verdict || 'pass';
    const finalStatus = verdict === 'fail' ? 'error' : 'done';
    const errMsg = verdict === 'fail'
      ? 'Reviewer: ' + (reviewResult?.blockers?.[0] || reviewResult?.notes || 'see reviewer output')
      : undefined;

    setQueueStatus(id, finalStatus, { error: errMsg });
    _creatorAborts.delete(id);

    logger.info('[queueManager] submitToCreator done', { id, projectId, verdict });
    return { id, projectId, verdict };

  } catch (err) {
    if (!abort.signal.aborted) {
      setQueueStatus(id, 'error', { error: err.message });
      logger.error('[queueManager] submitToCreator error', { id, error: err.message });
    }
    _creatorAborts.delete(id);
    throw err;
  }
}

/**
 * Cancel an in-flight creator pipeline run.
 */
function cancelCreator(id) {
  const ctrl = _creatorAborts.get(id);
  if (ctrl) { ctrl.abort(); _creatorAborts.delete(id); }
  setQueueStatus(id, 'error', { error: 'Cancelled by user' });
}

module.exports = {
  init,
  // queue
  enqueue,
  setQueueStatus,
  removeQueueItem,
  getQueue,
  submitToCreator,
  cancelCreator,
  // cron
  registerCron,
  recordCronRun,
  toggleCron,
  removeCron,
  getCron,
  syncFromScheduler,
};
