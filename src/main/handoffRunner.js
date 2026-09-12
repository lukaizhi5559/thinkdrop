'use strict';

/**
 * handoffRunner.js — Concurrent stategraph execution for comms-graph handoffs
 *
 * Each handoff from comms-graph spawns an INDEPENDENT stategraph instance
 * (not through the serial promptQueue). This enables concurrent background
 * tasks without blocking each other.
 *
 * Per-agent locking is handled by comms-graph's agentLock module.
 * This runner:
 *   1. Creates a new StateGraphBuilder.full() instance per task
 *   2. Sets initialState.progressCallback so rich events (plan:generated,
 *      preflight:*, plan:step_start, ask_user) reach the renderer
 *   3. Executes it with its own AbortController
 *   4. Detects the real final state (awaiting-approval / plan-error /
 *      pending-question / done) instead of treating every exit as "done"
 *   5. Streams progress back to comms-graph (via /comms.progress)
 *   6. Notifies comms-graph on completion (via /comms.complete)
 *   7. Sends results to the renderer (via IPC)
 *   8. Supports resume(taskId, planFile) for plan approval and
 *      answerQuestion(taskId, answer) for ask_user responses
 */

const http = require('http');
const { StateGraphBuilder, RealMCPAdapter, ThinkDropLLMBackend } = require('@thinkdrop/stategraph');

const COMMS_GRAPH_PORT = parseInt(process.env.COMMS_GRAPH_PORT || '3015', 10);

// ── Active runs ────────────────────────────────────────────────────────────────
/** @type {Map<string, { abortController: AbortController, stateGraph: any, progressCallback: Function }>} */
const _activeRuns = new Map();

// ── Pending plan contexts (per task) ───────────────────────────────────────────
/** @type {Map<string, { planFile: string, prompt: string, agentId: string|null, source: string, originalPrompt: string|null, sessionId: string|null }>} */
const _pendingPlanContexts = new Map();

// ── Pending question resolvers (per task) ──────────────────────────────────────
/** @type {Map<string, { resolve: (answer: string) => void }>} */
const _pendingQuestionResolvers = new Map();

// ── IPC broadcast (set by main.js) ─────────────────────────────────────────────
let _ipcBroadcast = null;
let _mcpClient = null;
let _mcpAdapter = null;
let _llmBackend = null;
let _setPendingPreflightPrompt = null;

function init({ mcpClient, mcpAdapter, llmBackend, ipcBroadcast, setPendingPreflightPrompt }) {
  _mcpClient = mcpClient;
  _mcpAdapter = mcpAdapter;
  _llmBackend = llmBackend;
  _ipcBroadcast = ipcBroadcast;
  _setPendingPreflightPrompt = setPendingPreflightPrompt;
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
  return StateGraphBuilder.full({
    mcpAdapter: _mcpAdapter,
    llmBackend: _llmBackend,
    logger: console,
  });
}

// ── Build a progressCallback that forwards events to renderer + comms-graph ──
function _makeProgressCallback(taskId, agentId) {
  return (event) => {
    if (!event || typeof event !== 'object') return;

    // Tag the event with taskId so the renderer can route it to the right queue card
    const taggedEvent = { ...event, taskId };

    // Forward all rich events to the renderer (plan:generated, preflight:*, plan:step_start, etc.)
    if (_ipcBroadcast) {
      _ipcBroadcast('automation:progress', taggedEvent);
    }

    // Forward step-level info to comms-graph (for the basic queue card status)
    if (event.type === 'step_start' || event.type === 'step_done' || event.type === 'step_failed') {
      _notifyProgress(taskId, agentId, {
        step: event.stepIndex || 0,
        totalSteps: event.totalSteps || 0,
        currentStep: event.description || event.title || event.skill || event.type,
      });
    } else if (event.type === 'plan:generated' || event.type === 'plan:found_existing') {
      _notifyProgress(taskId, agentId, {
        step: 0,
        totalSteps: 0,
        currentStep: 'Plan ready — awaiting approval',
      });
    } else if (event.type === 'planning') {
      _notifyProgress(taskId, agentId, {
        step: 0,
        totalSteps: 0,
        currentStep: event.message || 'Planning…',
      });
    } else if (event.type === 'preflight:start') {
      _notifyProgress(taskId, agentId, {
        step: 0,
        totalSteps: 0,
        currentStep: event.message || 'Preparing agents…',
      });
    } else if (event.type === 'all_done') {
      _notifyProgress(taskId, agentId, {
        step: event.completedCount || 0,
        totalSteps: event.totalCount || 0,
        currentStep: 'Complete',
      });
    }
  };
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
 * @param {string|null} [args.planFile] - Plan file to execute (for resume after approval)
 */
async function execute({ taskId, prompt, agentId, source, originalPrompt, sessionId, planFile }) {
  if (!_mcpAdapter || !_llmBackend) {
    console.error('[HandoffRunner] Not initialized — call init() first');
    _notifyComplete(taskId, agentId, 'failed', 'HandoffRunner not initialized');
    return;
  }

  const abortController = new AbortController();
  const progressCallback = _makeProgressCallback(taskId, agentId);
  let stateGraph = null;

  try {
    stateGraph = _createStateGraph();
    _activeRuns.set(taskId, { abortController, stateGraph, progressCallback });

    console.log(`[HandoffRunner] Starting task ${taskId}: ${prompt.substring(0, 80)}${planFile ? ' (with plan)' : ''}`);

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
      // CRITICAL: set progressCallback so rich events reach the renderer
      progressCallback,
      // If resuming with an approved plan, set _planFile so planExecutor runs it
      ...(planFile ? { _planFile: planFile } : {}),
    };

    // Execute the stategraph
    const finalState = await stateGraph.execute(initialState, null, abortController.signal);

    const answer = finalState.answer || '';
    const intent = finalState?.intent?.type || 'command_automate';

    // Extract web search sources from finalState.contextDocs so the queue card
    // can render the Perplexity-style favicon pill + dropdown.
    const sources = Array.isArray(finalState.contextDocs)
      ? finalState.contextDocs
          .filter(d => d && d.url && d.url.startsWith('http'))
          .slice(0, 10)
          .map(d => {
            let hostname = '';
            try { hostname = new URL(d.url).hostname.replace(/^www\./, ''); } catch (_) {}
            return { url: d.url, title: (d.text || d.title || hostname).split('\n')[0].trim() || hostname, hostname };
          })
      : [];

    // ── Detect the real final state ────────────────────────────────────────────
    if (finalState.awaitingPlanApproval) {
      // StateGraph paused for plan approval — store context for resume()
      const planFileFromState = finalState._skillPlanFile || finalState._planFile || finalState.planFile || null;
      _pendingPlanContexts.set(taskId, {
        planFile: planFileFromState,
        prompt,
        agentId,
        source,
        originalPrompt,
        sessionId: finalState.resolvedSessionId || sessionId || null,
      });
      console.log(`[HandoffRunner] Task ${taskId} awaiting plan approval — planFile=${planFileFromState}`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'awaiting-approval', '');
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer: '',
          sources,
          status: 'awaiting-approval',
          planFile: planFileFromState,
          agentId,
          source,
        });
      }
      return { ok: true, status: 'awaiting-approval', planFile: planFileFromState };

    } else if (finalState.planError && finalState.preflightAuthRequired) {
      // Preflight auth required — resumable warning state, NOT a terminal failure.
      // The user needs to sign in; the task will resume after auth succeeds.
      console.log(`[HandoffRunner] Task ${taskId} auth required: ${finalState.planError}`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'auth-required', finalState.planError);
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer: '',
          sources,
          error: finalState.planError,
          status: 'auth-required',
          agentId,
          source,
        });
      }
      // Populate the per-task pending map so the preflight:auth_continue
      // handler in main.js can resume this task after sign-in.
      if (typeof _setPendingPreflightPrompt === 'function') {
        _setPendingPreflightPrompt(taskId, {
          prompt,
          agentId: agentId || null,
          source: source || 'text',
          originalPrompt: originalPrompt || null,
          sessionId: finalState.resolvedSessionId || sessionId || null,
        });
      }
      return { ok: false, status: 'auth-required', error: finalState.planError };

    } else if (finalState.planError) {
      // Preflight or plan generation failed
      console.error(`[HandoffRunner] Task ${taskId} plan error: ${finalState.planError}`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'failed', finalState.planError);
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer: '',
          sources,
          error: finalState.planError,
          status: 'failed',
          agentId,
          source,
        });
      }
      return { ok: false, status: 'failed', error: finalState.planError };

    } else if (finalState.pendingQuestion) {
      // StateGraph is waiting for user input (ask_user)
      // The question event was already forwarded via progressCallback
      // Store a resolver so answerQuestion() can resolve it
      console.log(`[HandoffRunner] Task ${taskId} waiting for user input`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'waiting-for-input', '');
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer: '',
          sources,
          status: 'waiting-for-input',
          agentId,
          source,
        });
      }
      return { ok: true, status: 'waiting-for-input' };

    } else {
      // Normal completion
      const thinking = finalState.thinking || null;
      console.log(`[HandoffRunner] Task ${taskId} completed — ${answer.length} chars${thinking ? ` (thinking: ${thinking.length} chars)` : ''}${sources.length ? ` (sources: ${sources.length})` : ''}`);
      // Emit pipeline:done so AutomationProgress clears the planning spinner.
      // This is critical for tasks that skip executeCommand (e.g. general_knowledge
      // intent) — without it, the "Breaking down your request..." spinner stays
      // forever because all_done never fires.
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'done', answer);
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer,
          thinking,
          sources,
          intent,
          status: 'done',
          agentId,
          source,
        });
      }
      return { ok: true, status: 'done', answer, thinking, intent };
    }

  } catch (err) {
    console.error(`[HandoffRunner] Task ${taskId} failed:`, err.message);

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

    return { ok: false, status, error: err.message };

  } finally {
    _activeRuns.delete(taskId);
  }
}

// ── Resume a task after plan approval ──────────────────────────────────────────
/**
 * Re-executes a handoff task with the approved plan file.
 * @param {string} taskId
 * @param {string} planFile
 */
async function resume(taskId, planFile) {
  const ctx = _pendingPlanContexts.get(taskId);
  if (!ctx) {
    console.warn(`[HandoffRunner] resume: no pending plan context for task ${taskId}`);
    return { ok: false, error: 'No pending plan context' };
  }
  _pendingPlanContexts.delete(taskId);

  console.log(`[HandoffRunner] Resuming task ${taskId} with plan ${planFile}`);
  return execute({
    taskId,
    prompt: ctx.prompt,
    agentId: ctx.agentId,
    source: ctx.source,
    originalPrompt: ctx.originalPrompt,
    sessionId: ctx.sessionId,
    planFile,
  });
}

// ── Answer a pending question for a task ──────────────────────────────────────
/**
 * Resolves a pending ask_user question for a task.
 * Currently a placeholder — the actual question resolution mechanism
 * depends on how the StateGraph handles pending questions. For now,
 * we re-run the StateGraph with the answer injected.
 * @param {string} taskId
 * @param {string} answer
 */
async function answerQuestion(taskId, answer) {
  const resolver = _pendingQuestionResolvers.get(taskId);
  if (resolver) {
    resolver.resolve(answer);
    _pendingQuestionResolvers.delete(taskId);
    return { ok: true };
  }
  console.warn(`[HandoffRunner] answerQuestion: no pending question for task ${taskId}`);
  return { ok: false, error: 'No pending question' };
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

module.exports = { init, execute, resume, answerQuestion, cancel, getActiveCount, getActiveTaskIds };
