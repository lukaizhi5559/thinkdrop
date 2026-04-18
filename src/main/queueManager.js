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
  // Auto-remove terminal items after 30s so the Queue tab stays clean
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    setTimeout(() => {
      if (_queue.has(id)) {
        _queue.delete(id);
        _broadcastQueueNow();
      }
    }, 30_000);
  }
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
 * Merge external cron items (from command-service /skill.schedule/list) into the
 * in-memory _cron Map without blowing away existing run history.
 *
 * For each incoming item:
 *  - If the id already exists in _cron: update label/schedule/status/type but KEEP runs[].
 *  - If the id is new: insert as-is (no run history yet).
 *
 * Does NOT broadcast — caller decides when to send cron:update.
 *
 * @param {Array<{id: string, label: string, schedule: string, status: string, type?: string}>} items
 */
function mergeCronItems(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || !item.id) continue;
    const existing = _cron.get(item.id);
    if (existing) {
      // Preserve run history — only refresh schedulable metadata
      _cron.set(item.id, {
        ...existing,
        label:    item.label    != null ? item.label    : existing.label,
        schedule: item.schedule != null ? item.schedule : existing.schedule,
        status:   item.status   != null ? item.status   : existing.status,
        type:     item.type     != null ? item.type     : existing.type,
      });
    } else {
      _cron.set(item.id, { runs: [], ...item });
    }
  }
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
 * Start tracking a new cron run (called at bridge fire time).
 */
function recordCronRunStart(skillName, runId) {
  const item = _cron.get(skillName);
  const run = {
    id: runId,
    startedAt: new Date().toLocaleTimeString(),
    status: 'running',
    steps: [],
    _startMs: Date.now(),
  };
  if (item) {
    const prev = item.runs || [];
    const trimmed = [run, ...prev].slice(0, 5); // keep last 5 runs
    _cron.set(skillName, {
      ...item,
      status: 'active',
      activeRunId: runId,
      runCount: (item.runCount || 0) + 1,
      runs: trimmed,
    });
  }
  _broadcastCronNow();
}

/**
 * Upsert a step within an active cron run.
 */
function recordCronStep(skillName, runId, stepData) {
  const item = _cron.get(skillName);
  if (!item) return;
  const runs = item.runs || [];
  const runIdx = runs.findIndex(r => r.id === runId);
  if (runIdx === -1) return;
  const run = runs[runIdx];
  const steps = [...(run.steps || [])];
  const existing = steps.findIndex(s => s.index === stepData.index);
  if (existing >= 0) {
    steps[existing] = { ...steps[existing], ...stepData };
  } else {
    steps.push(stepData);
  }
  const updatedRuns = [...runs];
  updatedRuns[runIdx] = { ...run, steps };
  _cron.set(skillName, { ...item, runs: updatedRuns });
  _broadcastCronNow();
}

/**
 * Finalize a cron run as done or failed.
 */
function recordCronRunDone(skillName, runId, status) {
  const item = _cron.get(skillName);
  if (!item) return;
  const runs = (item.runs || []).map(r => {
    if (r.id !== runId) return r;
    const durationMs = r._startMs ? Date.now() - r._startMs : undefined;
    const { _startMs: _removed, ...rest } = r;
    return { ...rest, status, durationMs };
  });
  _cron.set(skillName, {
    ...item,
    status: status === 'failed' ? 'error' : 'active',
    lastRun: new Date().toLocaleTimeString(),
    activeRunId: null,
    runs,
    lastError: status === 'failed' ? 'Last run failed' : item.lastError,
  });
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
  mergeCronItems,
  recordCronRun,
  recordCronRunStart,
  recordCronStep,
  recordCronRunDone,
  toggleCron,
  removeCron,
  getCron,
  syncFromScheduler,
};
