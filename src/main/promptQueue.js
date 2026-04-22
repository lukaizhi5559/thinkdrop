/**
 * promptQueue.js — Persistent serial prompt queue for stategraph:process.
 *
 * Works like a printer queue:
 * - User can submit prompts at any time, they are enqueued immediately
 * - Only ONE prompt runs through stategraph at a time
 * - When the running prompt finishes, the next pending one starts automatically
 * - Queue is persisted to ~/.thinkdrop/prompt-queue.json so items survive restarts
 * - On restart: any item that was mid-run (status='running') is reset to 'pending'
 *   and the user gets a 10-second countdown alert before it auto-triggers
 *
 * IPC events (main → renderer):
 *   prompt-queue:update          — full PromptQueueItem[] snapshot
 *   prompt-queue:restart-alert   — { items: PromptQueueItem[], countdownMs: number }
 *   prompt-queue:restart-cancel  — alert dismissed
 *
 * IPC events (renderer → main, handled in main.js):
 *   prompt-queue:submit          — { prompt, selectedText?, responseLanguage? }
 *   prompt-queue:cancel          — { id }
 *   prompt-queue:dismiss-alert   — cancel the restart countdown
 */

const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Storage path ──────────────────────────────────────────────────────────────
const QUEUE_DIR  = path.join(os.homedir(), '.thinkdrop');
const QUEUE_FILE = path.join(QUEUE_DIR, 'prompt-queue.json');

// ── Types (JSDoc only) ────────────────────────────────────────────────────────
/**
 * @typedef {'pending'|'running'|'done'|'error'|'cancelled'} PQStatus
 * @typedef {{ id: string, prompt: string, selectedText: string, responseLanguage: string|null, status: PQStatus, createdAt: number, startedAt: number|null, doneAt: number|null, error: string|null }} PromptQueueItem
 */

// ── In-memory state ───────────────────────────────────────────────────────────
/** @type {Map<string, PromptQueueItem>} */
const _items = new Map();

/** @type {((items: PromptQueueItem[]) => void) | null} */
let _broadcastFn = null;

/** @type {(() => void) | null} — called by promptQueue to trigger next execution */
let _runNextFn = null;

/** @type {NodeJS.Timeout | null} */
let _restartCountdownTimer = null;

/**
 * IDs of items that were loaded from persistence on startup (crashed/unfinished).
 * Used to evict them when a fresh user prompt arrives so they don't race.
 * @type {Set<string>}
 */
let _crashedItemIds = new Set();

// ── Persistence ───────────────────────────────────────────────────────────────
function _save() {
  try {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
    const arr = Array.from(_items.values());
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (err) {
    console.error('[PromptQueue] Failed to persist queue:', err.message);
  }
}

function _load() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch (_) {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _uid() {
  return `pq_${randomBytes(4).toString('hex')}`;
}

function _broadcast() {
  // Only broadcast pending + running items — done/cancelled/error are removed from view
  // after completion so the queue tab stays clean.
  const visible = Array.from(_items.values()).filter(i => i.status === 'pending' || i.status === 'running');
  if (_broadcastFn) _broadcastFn(visible);
}

function _getSnapshot() {
  return Array.from(_items.values());
}

// ── Core queue logic ──────────────────────────────────────────────────────────

/**
 * Enqueue a new prompt. Returns the item id.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.selectedText]
 * @param {string|null} [opts.responseLanguage]
 * @param {string|null} [opts._planFile]  — set by plan:approve to re-run with a plan file
 * @param {string|null} [opts.sessionId]
 * @param {string} [opts.userId]
 * @param {boolean} [opts._forceNewPlan]  — set by plan:new to skip existing-plan reuse
 * @param {Array|null} [opts._skillPlan]  — set by plan:approve (planSkills gate) to skip replanning
 * @param {string|null} [opts._skillPlanFile] — path to the .md plan file for status tracking
 * @param {boolean} [opts._planCorrectionMode] — set when user is correcting a pending plan
 * @param {string|null} [opts._planCorrectionText] — raw correction prompt text
 * @param {string|null} [opts._basePlanFile] — original pending plan file being corrected
 * @param {string|null} [opts._skillPlanJson] — base64 skill plan JSON from plan:generated event
 * @param {string|null} [opts._planCorrectionSourcePrompt] — original prompt that generated the pending plan
 * @returns {string} id
 */
function enqueue(prompt, { selectedText = '', responseLanguage = null, _planFile = null, sessionId = null, userId = 'default_user', _forceNewPlan = false, _skillPlan = null, _skillPlanFile = null, _planCorrectionMode = false, _planCorrectionText = null, _basePlanFile = null, _skillPlanJson = null, _planCorrectionSourcePrompt = null } = {}) {
  const id = _uid();

  // If a new prompt comes in while crashed-session items are still pending restart,
  // cancel those crashed items so they don't race with the new one.
  if (_restartCountdownTimer) {
    clearTimeout(_restartCountdownTimer);
    _restartCountdownTimer = null;
    for (const [itemId, item] of _items) {
      if (item.status === 'pending') {
        _items.set(itemId, { ...item, status: 'cancelled', doneAt: Date.now() });
        console.log(`[PromptQueue] Cancelled stale restart item: ${itemId}`);
      }
    }
    _save();
    _broadcast();
  }

  // If this is a fresh user prompt (not a plan:approve re-enqueue), evict any
  // pending crashed items from the last session so they don't run ahead of it.
  const _isFreshUserPrompt = !_planFile && !_skillPlan && !_planCorrectionMode;
  if (_isFreshUserPrompt && _crashedItemIds.size > 0) {
    for (const crashedId of _crashedItemIds) {
      const crashedItem = _items.get(crashedId);
      if (crashedItem && crashedItem.status === 'pending') {
        _items.set(crashedId, { ...crashedItem, status: 'cancelled', doneAt: Date.now() });
        console.log(`[PromptQueue] Evicted stale crash-session item: ${crashedId}`);
      }
    }
    _crashedItemIds.clear();
    _save();
    _broadcast();
  }

  /** @type {PromptQueueItem} */
  const item = {
    id,
    prompt,
    selectedText,
    responseLanguage,
    _planFile,
    _skillPlan,
    _skillPlanFile,
    _planCorrectionMode,
    _planCorrectionText,
    _basePlanFile,
    _skillPlanJson,
    _planCorrectionSourcePrompt,
    sessionId,
    userId,
    _forceNewPlan,
    status: 'pending',
    createdAt: Date.now(),
    startedAt: null,
    doneAt: null,
    error: null,
  };
  _items.set(id, item);
  _save();
  _broadcast();
  console.log(`[PromptQueue] Enqueued: "${prompt.slice(0, 60)}" id=${id}`);
  // Attempt to start processing if nothing is running
  _tryAdvance();
  return id;
}

/**
 * Cancel a pending item. No-op if it's already running (can't cancel mid-run here).
 * @param {string} id
 */
function cancel(id) {
  const item = _items.get(id);
  if (!item || item.status !== 'pending') return;
  _items.set(id, { ...item, status: 'cancelled', doneAt: Date.now() });
  _save();
  _broadcast();
  console.log(`[PromptQueue] Cancelled: ${id}`);
}

/**
 * Called by the stategraph runner when a prompt finishes (success or error).
 * @param {string} id
 * @param {{ error?: string }} [opts]
 */
function markDone(id, { error } = {}) {
  const item = _items.get(id);
  if (!item) return;
  _items.set(id, {
    ...item,
    status: error ? 'error' : 'done',
    doneAt: Date.now(),
    error: error || null,
  });
  _save();
  _broadcast();
  console.log(`[PromptQueue] Done: ${id}${error ? ` (error: ${error.slice(0, 60)})` : ''}`);
  // Advance to next pending item
  _tryAdvance();
}

/**
 * Try to start the next pending item if nothing is currently running.
 * Calls _runNextFn which is injected from main.js.
 */
function _tryAdvance() {
  const isRunning = Array.from(_items.values()).some(i => i.status === 'running');
  if (isRunning) return;

  const next = Array.from(_items.values())
    .filter(i => i.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)[0];

  if (!next) return;

  // Mark as running
  _items.set(next.id, { ...next, status: 'running', startedAt: Date.now() });
  _save();
  _broadcast();

  console.log(`[PromptQueue] Starting: "${next.prompt.slice(0, 60)}" id=${next.id}`);
  if (_runNextFn) {
    _runNextFn(next);
  } else {
    console.warn('[PromptQueue] _runNextFn not set — cannot start prompt');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} InitOpts
 * @property {(items: PromptQueueItem[]) => void} broadcast     — push visible queue to renderer
 * @property {(item: PromptQueueItem) => void}   runPrompt     — execute a prompt through stategraph
 * @property {(items: PromptQueueItem[], countdownMs: number) => void} alertRestart — show countdown alert
 */

/**
 * Initialize the queue. Must be called once after app ready.
 * Loads persisted items, detects any mid-run items from last crash,
 * and schedules a 10-second restart alert before auto-triggering them.
 *
 * @param {InitOpts} opts
 */
function init({ broadcast, runPrompt, alertRestart }) {
  _broadcastFn = broadcast;
  _runNextFn = runPrompt;

  // Load persisted items
  const persisted = _load();
  let crashedItems = [];

  for (const item of persisted) {
    if (item.status === 'running') {
      // Was mid-run when app shut down — reset to pending so it can be re-triggered
      const reset = { ...item, status: 'pending', startedAt: null };
      _items.set(item.id, reset);
      crashedItems.push(reset);
    } else if (item.status === 'pending') {
      _items.set(item.id, item);
      crashedItems.push(item);
    }
    // done/error/cancelled items are NOT reloaded — they're historical
  }

  _save();

  if (crashedItems.length > 0) {
    console.log(`[PromptQueue] Found ${crashedItems.length} unfinished prompt(s) from last session`);
    _crashedItemIds = new Set(crashedItems.map(i => i.id));
    // Show alert — user must explicitly click Resume to continue.
    // Auto-triggering was removed: pending prompts should never fire silently on launch.
    alertRestart(crashedItems, 0);
  }
  // Don't auto-start fresh items at init — wait for explicit enqueue or restart countdown
}

/**
 * Dismiss the restart countdown (user cancelled).
 * Clears pending items that were loaded from persistence.
 */
function dismissRestartAlert() {
  if (_restartCountdownTimer) {
    clearTimeout(_restartCountdownTimer);
    _restartCountdownTimer = null;
  }
  // Cancel all pending items that came from persistence (not newly submitted ones)
  for (const [id, item] of _items) {
    if (item.status === 'pending') {
      _items.set(id, { ...item, status: 'cancelled', doneAt: Date.now() });
    }
  }
  _crashedItemIds.clear();
  _save();
  _broadcast();
  console.log('[PromptQueue] Restart alert dismissed — pending items cancelled');
}

/**
 * Resume pending prompts — called explicitly when user clicks "Resume" in the restart alert.
 * Only triggers execution; does not cancel any items.
 */
function resumePendingPrompts() {
  console.log('[PromptQueue] User clicked Resume — triggering pending prompts');
  _tryAdvance();
}

/**
 * Get the current running item id (or null).
 * @returns {string|null}
 */
function getRunningId() {
  const running = Array.from(_items.values()).find(i => i.status === 'running');
  return running ? running.id : null;
}

/**
 * Get all visible items (pending + running).
 * @returns {PromptQueueItem[]}
 */
function getVisible() {
  return Array.from(_items.values())
    .filter(i => i.status === 'pending' || i.status === 'running')
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Track an externally-driven prompt (e.g. /voice/inject) in the queue UI.
 * Inserts the item directly as 'running' without going through _tryAdvance,
 * so it doesn't interfere with the normal serial prompt queue.
 * Call markDone(id) when the external execution completes.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.selectedText]
 * @param {string|null} [opts.responseLanguage]
 * @returns {string} id
 */
function trackExternal(prompt, { selectedText = '', responseLanguage = null } = {}) {
  const id = _uid();
  const item = {
    id,
    prompt,
    selectedText,
    responseLanguage,
    status: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
    doneAt: null,
    error: null,
  };
  _items.set(id, item);
  _save();
  _broadcast();
  console.log(`[PromptQueue] Tracking external: "${prompt.slice(0, 60)}" id=${id}`);
  return id;
}

module.exports = {
  init,
  enqueue,
  cancel,
  markDone,
  trackExternal,
  dismissRestartAlert,
  resumePendingPrompts,
  getRunningId,
  getVisible,
  _getSnapshot,
};
