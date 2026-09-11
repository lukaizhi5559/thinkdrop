'use strict';

/**
 * handoffRunner.js — Concurrent stategraph execution for comms-graph handoffs
 *
 * Each handoff from comms-graph spawns an INDEPENDENT stategraph instance
 * (not through the serial promptQueue). This enables concurrent background
 * tasks without blocking each other.
 *
 * Per-agent locking is handled by comms-graph's agentLock module.
 * This runner just:
 *   1. Creates a new StateGraphBuilder.full() instance per task
 *   2. Executes it with its own AbortController
 *   3. Streams progress back to comms-graph (via /comms.progress)
 *   4. Notifies comms-graph on completion (via /comms.complete)
 *   5. Sends results to the renderer (via IPC)
 */

const http = require('http');
const { StateGraphBuilder, RealMCPAdapter, ThinkDropLLMBackend } = require('@thinkdrop/stategraph');

const COMMS_GRAPH_PORT = parseInt(process.env.COMMS_GRAPH_PORT || '3015', 10);

// ── Active runs ────────────────────────────────────────────────────────────────
/** @type {Map<string, { abortController: AbortController, stateGraph: any }>} */
const _activeRuns = new Map();

// ── IPC broadcast (set by main.js) ─────────────────────────────────────────────
let _ipcBroadcast = null;
let _mcpClient = null;
let _mcpAdapter = null;
let _llmBackend = null;

function init({ mcpClient, mcpAdapter, llmBackend, ipcBroadcast }) {
  _mcpClient = mcpClient;
  _mcpAdapter = mcpAdapter;
  _llmBackend = llmBackend;
  _ipcBroadcast = ipcBroadcast;
}

// ── HTTP helpers (notify comms-graph) ──────────────────────────────────────────
function _postToComms(path, body) {
  return new Promise((resolve) => {
    const json = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: COMMS_GRAPH_PORT,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
      timeout: 3000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(json);
    req.end();
  });
}

function _notifyProgress(taskId, agentId, progress) {
  return _postToComms('/comms.progress', { taskId, agentId, progress });
}

function _notifyComplete(taskId, agentId, status, result) {
  return _postToComms('/comms.complete', { taskId, agentId, status, result });
}

// ── Create a fresh stategraph instance for a handoff task ──────────────────────
function _createStateGraph() {
  // Each handoff gets its own builder + graph instance
  // This allows true concurrency — no shared state between tasks
  const builder = new StateGraphBuilder();
  return builder.full(_mcpAdapter, _llmBackend);
}

// ── Execute a handoff task ─────────────────────────────────────────────────────
/**
 * @param {Object} args
 * @param {string} args.taskId       - comms-graph task ID
 * @param {string} args.prompt       - English prompt
 * @param {string|null} [args.agentId] - Target agent
 * @param {string} [args.source]     - 'voice' or 'text'
 * @param {string|null} [args.originalPrompt] - Non-English original
 * @param {string|null} [args.sessionId] - Existing session ID
 */
async function execute({ taskId, prompt, agentId, source, originalPrompt, sessionId }) {
  if (!_mcpAdapter || !_llmBackend) {
    console.error('[HandoffRunner] Not initialized — call init() first');
    _notifyComplete(taskId, agentId, 'failed', 'HandoffRunner not initialized');
    return;
  }

  const abortController = new AbortController();
  let stateGraph = null;

  try {
    stateGraph = _createStateGraph();
    _activeRuns.set(taskId, { abortController, stateGraph });

    console.log(`[HandoffRunner] Starting task ${taskId}: ${prompt.substring(0, 80)}`);

    // Notify comms-graph that the task is running
    _notifyProgress(taskId, agentId, { step: 0, totalSteps: 0, currentStep: 'Initializing' });

    // Build initial state for the stategraph
    const initialState = {
      message: prompt,
      resolvedMessage: prompt,
      intent: { type: 'command_automate' }, // Handoffs are always command_automate
      sessionId: sessionId || null,
      userId: 'default_user',
      mcpAdapter: _mcpAdapter,
      llmBackend: _llmBackend,
      _handoffTaskId: taskId,
      _handoffSource: source,
    };

    // Progress callback — streams to comms-graph + renderer
    const onProgress = async (nodeName, state, durationMs, phase) => {
      if (phase === 'completed') {
        const stepInfo = {
          step: state._stepIndex || 0,
          totalSteps: state._totalSteps || 0,
          currentStep: nodeName,
        };
        _notifyProgress(taskId, agentId, stepInfo);

        // Also broadcast to renderer for queue card updates
        if (_ipcBroadcast) {
          _ipcBroadcast('task:progress', {
            taskId,
            node: nodeName,
            ...stepInfo,
          });
        }
      }
    };

    // Execute the stategraph
    const finalState = await stateGraph.execute(initialState, onProgress, abortController.signal);

    const answer = finalState.answer || '';
    const intent = finalState?.intent?.type || 'command_automate';

    console.log(`[HandoffRunner] Task ${taskId} completed — ${answer.length} chars`);

    // Notify comms-graph of completion
    _notifyComplete(taskId, agentId, 'done', answer);

    // Broadcast completion to renderer (for task-complete banner)
    if (_ipcBroadcast) {
      _ipcBroadcast('task:complete', {
        taskId,
        prompt: originalPrompt || prompt,
        answer,
        intent,
        agentId,
        source,
      });
    }

    return { ok: true, answer, intent };

  } catch (err) {
    console.error(`[HandoffRunner] Task ${taskId} failed:`, err.message);

    // Check if it was aborted
    const status = abortController.signal.aborted ? 'cancelled' : 'failed';
    _notifyComplete(taskId, agentId, status, err.message);

    if (_ipcBroadcast) {
      _ipcBroadcast('task:complete', {
        taskId,
        prompt: originalPrompt || prompt,
        answer: '',
        error: err.message,
        status,
        agentId,
        source,
      });
    }

    return { ok: false, error: err.message };

  } finally {
    _activeRuns.delete(taskId);
  }
}

// ── Cancel a running task ──────────────────────────────────────────────────────
function cancel(taskId) {
  const run = _activeRuns.get(taskId);
  if (!run) return false;
  run.abortController.abort();
  console.log(`[HandoffRunner] Cancelled task ${taskId}`);
  return true;
}

// ── Get active run count ───────────────────────────────────────────────────────
function getActiveCount() {
  return _activeRuns.size;
}

// ── Get active task IDs ────────────────────────────────────────────────────────
function getActiveTaskIds() {
  return Array.from(_activeRuns.keys());
}

module.exports = { init, execute, cancel, getActiveCount, getActiveTaskIds };
