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

// ── Pending question contexts (per task) ──────────────────────────────────────
// When a task pauses on ask_user (pendingQuestion), we store the full paused
// finalState so answerQuestion() can rebuild a resume initialState — mirroring
// the serial path's pausedAutomationState resume in main.js. Without this, card
// answers (try_again / skip / corrections) get submitted as fresh prompts and
// misrouted through planning (which once deep-linked "try_again" into a bogus
// URL and closed the user's signed-in session).
/** @type {Map<string, { finalState: any, prompt: string, agentId: string|null, source: string, originalPrompt: string|null, sessionId: string|null }>} */
const _pendingQuestions = new Map();

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

function _notifyComplete(taskId, agentId, status, result, items) {
  return _postToComms('/comms.complete', { taskId, agentId, status, result, items: items || null });
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
 * @param {string[]|null} [args.preflightAuthBypass] - Agent IDs to treat as authed for this run only
 * @param {Object|null}  [args._resumeState] - Paused finalState to resume from (ask_user answer)
 */
async function execute({ taskId, prompt, agentId, source, originalPrompt, sessionId, planFile, preflightAuthBypass, _resumeState }) {
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

    // A fresh execute() for a taskId supersedes any stale paused question.
    _pendingQuestions.delete(taskId);

    // Build initial state for the stategraph.
    // _resumeState: a paused finalState from answerQuestion() — spread it as the
    // base so skillPlan/_skillPlan/cursor/history carry over, then re-apply the
    // live run wiring (callbacks, adapters) that can't be serialized.
    const initialState = _resumeState
      ? {
          ..._resumeState,
          mcpAdapter: _mcpAdapter,
          llmBackend: _llmBackend,
          progressCallback,
          _handoffTaskId: taskId,
          _handoffSource: source,
        }
      : {
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
          // Auth bypass: user chose "proceed without" — treat listed agents as
          // authed for this run only (not persisted to auth cache or authed_at)
          ...(preflightAuthBypass?.length ? { preflightAuthBypass } : {}),
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

    // Extract structured page cards (items) from skillResults — any step with
    // an `items` array (web.crawl extractItems, browser.agent extract_items).
    // Merge, dedupe by url, cap at 24 so the renderer can show them as cards.
    const items = [
      ...(Array.isArray(finalState.skillResults)
        ? finalState.skillResults
            .filter(r => r && Array.isArray(r.items) && r.items.length > 0)
            .flatMap(r => r.items)
        : []),
      // web_search image/video results land in contextDocs (not skillResults) —
      // map them into items so they render as cards too.
      ...(Array.isArray(finalState.contextDocs)
        ? finalState.contextDocs
            .filter(d => d && (d.isImage || d.imageUrl || d.mediaType === 'video') && (d.imageUrl || d.url))
            .map(d => ({
              title: d.title || undefined,
              imageUrl: d.imageUrl,
              url: (d.url && d.url.startsWith('http')) ? d.url : (d.originalUrl || undefined),
              snippet: d.snippet || undefined,
              mediaType: d.mediaType || undefined,
              duration: d.duration || undefined,
              channel: d.channel || undefined,
            }))
        : []),
    ]
          .reduce((acc, it) => {
            if (!it || typeof it !== 'object') return acc;
            const url = (it.url || '').toString().trim();
            const imageUrl = (it.imageUrl || '').toString().trim();
            if (!url && !imageUrl) return acc;
            const key = (url || imageUrl) + '|' + (it.title || '') + '|' + (it.mediaType || '');
            if (acc._seen.has(key)) return acc;
            acc._seen.add(key);
            let hostname = it.hostname || null;
            if (!hostname) {
              try { hostname = new URL(url || imageUrl).hostname; } catch (_) {}
            }
            acc.push({
              title: it.title || undefined,
              imageUrl: imageUrl || undefined,
              url: url || undefined,
              price: it.price || undefined,
              snippet: it.snippet || undefined,
              hostname: hostname || undefined,
              mediaType: it.mediaType || undefined,
              videoUrl: it.videoUrl || undefined,
              embedUrl: it.embedUrl || undefined,
              posterUrl: it.posterUrl || undefined,
              duration: it.duration || undefined,
              channel: it.channel || undefined,
              sourceUrl: it.sourceUrl || undefined,
            });
            return acc;
          }, Object.assign([], { _seen: new Set() }))
          .slice(0, 24);

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
          items,
          intent,
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
          items,
          intent,
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
          items,
          intent,
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
      console.log(`[HandoffRunner] Task ${taskId} waiting for user input`);
      // Store the paused state so answerQuestion() can resume mid-plan.
      _pendingQuestions.set(taskId, { finalState, prompt, agentId, source, originalPrompt, sessionId });
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'waiting-for-input', '');
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer: '',
          sources,
          items,
          status: 'waiting-for-input',
          agentId,
          source,
        });
      }
      return { ok: true, status: 'waiting-for-input' };

    } else {
      // Normal completion
      const thinking = finalState.thinking || null;
      console.log(`[HandoffRunner] Task ${taskId} completed — ${answer.length} chars${thinking ? ` (thinking: ${thinking.length} chars)` : ''}${sources.length ? ` (sources: ${sources.length})` : ''}${items.length ? ` (items: ${items.length})` : ''}`);
      // Emit pipeline:done so AutomationProgress clears the planning spinner.
      // This is critical for tasks that skip executeCommand (e.g. general_knowledge
      // intent) — without it, the "Breaking down your request..." spinner stays
      // forever because all_done never fires.
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'done', answer, items);
      if (_ipcBroadcast) {
        _ipcBroadcast('task:complete', {
          taskId,
          prompt: originalPrompt || prompt,
          answer,
          thinking,
          sources,
          items,
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
/** @param {string} taskId */
function hasPendingQuestion(taskId) {
  return _pendingQuestions.has(taskId);
}

/**
 * Resumes a task paused on ask_user. Rebuilds a resume initialState from the
 * stored finalState — mirroring the serial path's _isAgentAskUser branches in
 * main.js — and re-executes the graph via execute({_resumeState}).
 * @param {string} taskId
 * @param {string} answer
 */
async function answerQuestion(taskId, answer) {
  const ctx = _pendingQuestions.get(taskId);
  if (!ctx) {
    console.warn(`[HandoffRunner] answerQuestion: no pending question for task ${taskId}`);
    return { ok: false, error: 'No pending question' };
  }
  _pendingQuestions.delete(taskId);

  const paused = ctx.finalState;
  const pq = paused.pendingQuestion || {};
  const chosen = (answer || '').trim();
  const _agentId = pq.agentId || ctx.agentId || null;
  const _stepIdx = pq.stepIndex ?? paused.skillCursor ?? 0;
  const _uiStepIdx = pq.uiStepIndex ?? _stepIdx;
  const _resumeSkill = pq.skill || paused.skillPlan?.[_stepIdx]?.skill || 'browser.agent';
  const _originalTask = (pq.originalTask || paused.skillPlan?.[_stepIdx]?.args?.task || ctx.prompt || '')
    .replace(/\s*\[Resume context:[\s\S]*?\]\s*$/g, '').trim();
  const _description = paused.skillPlan?.[_stepIdx]?.description || _originalTask;
  const _remainingSteps = Array.isArray(paused.skillPlan)
    ? paused.skillPlan.slice(Math.max(paused.skillCursor || 0, _stepIdx + 1))
    : [];

  const _broadcastDone = (status) => {
    _notifyComplete(taskId, ctx.agentId, status, '');
    if (_ipcBroadcast) {
      _ipcBroadcast('task:complete', {
        taskId, prompt: ctx.originalPrompt || ctx.prompt, answer: '',
        status, agentId: ctx.agentId, source: ctx.source,
      });
    }
  };
  const _emitResuming = () => {
    if (_ipcBroadcast) _ipcBroadcast('automation:progress', { type: 'resuming', taskId, agentId: _agentId, stepIndex: _uiStepIdx });
  };
  const _reExecute = (resumeState) => execute({
    taskId, prompt: ctx.prompt, agentId: ctx.agentId, source: ctx.source,
    originalPrompt: ctx.originalPrompt, sessionId: ctx.sessionId, _resumeState: resumeState,
  });
  const _baseResume = {
    ...paused,
    message: ctx.prompt,
    failedStep: null, pendingQuestion: null, recoveryAction: null,
    // recoveryContext must be cleared — planSkillsV2's _skillPlan fast-path
    // (line ~888) is gated on !recoveryContext; a stale one would replan.
    recoveryContext: null,
    answer: undefined, commandExecuted: false,
    stepRetryCount: 0, _planFile: null, _skillPlanFile: null,
  };

  console.log(`[HandoffRunner] answerQuestion task=${taskId} answer="${chosen.slice(0, 60)}" agent=${_agentId} step=${_stepIdx}`);

  // ── Helper: build the resume step args for the failed skill ──────────────
  // For agent skills (browser.agent, cli.agent, app.agent), synthesize the
  // standard { action: 'run', agentId, task } shape. For non-agent skills
  // (shell.run, fs.read, synthesize, etc.), reuse the original step's args
  // verbatim — shell.run needs cmd/argv or goal, NOT action/agentId/task.
  const _AGENT_SKILLS = new Set(['browser.agent', 'cli.agent', 'app.agent', 'video.agent', 'web.agent']);
  const _buildResumeStep = (taskText) => {
    const _origStep = paused.skillPlan?.[_stepIdx] || {};
    if (_AGENT_SKILLS.has(_resumeSkill)) {
      // Agent skill — synthesize the standard run shape
      return { skill: _resumeSkill, args: { action: 'run', agentId: _agentId, task: taskText }, description: _description };
    }
    // Non-agent skill (shell.run, fs.read, synthesize, etc.) — reuse original args.
    // For shell.run, the original cmd/argv/goal is the correct re-execution shape.
    // Inject [Resume context] into goal-based shell.run steps so the LLM can adapt
    // (e.g. file-not-found stderr → ask user for the path), but keep cmd/argv steps
    // verbatim (deterministic re-run).
    const _origArgs = _origStep.args || {};
    if (_resumeSkill === 'shell.run' && _origArgs.goal && taskText !== _originalTask) {
      return { skill: _resumeSkill, args: { ..._origArgs, goal: taskText }, description: _description };
    }
    return { skill: _resumeSkill, args: _origArgs, description: _description };
  };

  // ── Try again / Retry — re-run the SAME step with the original task ──────
  // Accept "try_again", "try again", and the literal "Retry" label emitted by
  // executeCommand.js's generic pendingQuestion (options: ['Retry','Skip this step']).
  if (chosen === 'try_again' || /^try\s+again$/i.test(chosen) || /^retry$/i.test(chosen)) {
    _emitResuming();
    return _reExecute({
      ..._baseResume,
      _skillPlan: [
        _buildResumeStep(_originalTask),
        ..._remainingSteps,
      ],
      _skillPlanIsResume: true,
      _resumeStepIndex: _uiStepIdx,
      skillPlan: null, skillCursor: 0, skillResults: [],
    });
  }

  // ── Try to finish — plan extension from partial progress ──────────────────
  if (chosen === 'try_to_finish' && pq.partialProgress && Array.isArray(pq.partialProgress.remaining) && pq.partialProgress.remaining.length > 0) {
    const _completedContext = pq.partialProgress.completed?.length > 0
      ? `\n\n[Already completed — do NOT redo these:\n${pq.partialProgress.completed.map(c => `  - ${c}`).join('\n')}\n]`
      : '';
    const _extendTask = `${_originalTask}\n\n[Plan extension — finish the remaining work from the current page state.\nRemaining work:\n${pq.partialProgress.remaining.map(r => `  - ${r}`).join('\n')}${_completedContext}\n\nThe browser is already on the target page. Do NOT navigate away or re-authenticate. Continue from the current state.]`;
    _emitResuming();
    return _reExecute({
      ..._baseResume,
      _skillPlan: [
        _buildResumeStep(_extendTask),
      ],
      _skillPlanIsResume: true,
      _resumeStepIndex: _uiStepIdx,
      skillPlan: null, skillCursor: 0,
    });
  }

  // ── Skip this step — advance past the failed step ──────────────────────────
  if (/^skip(\s+this\s+step)?$/i.test(chosen)) {
    _emitResuming();
    return _reExecute({
      ..._baseResume,
      _skillPlan: _remainingSteps,
      _skillPlanIsResume: true,
      _resumeStepIndex: _uiStepIdx + 1,
      skillPlan: null, skillCursor: 0,
      skillResults: [...(paused.skillResults || []), { step: _stepIdx + 1, skill: _resumeSkill, ok: false, skipped: true }],
    });
  }

  // ── Proceed anyway — skip the training gate, let planSkills generate a real ─
  // plan (mirrors the serial _skipTrainingGate resume in main.js).
  if (/^proceed_anyway$/i.test(chosen) || /^proceed\s+anyway$/i.test(chosen)) {
    const _proceedAgent = paused.preflightResult?.agents?.find(a => a.agentId?.toLowerCase() === _agentId?.toLowerCase());
    const _proceedDeepLinkUrl = _proceedAgent?.deepLinkUrl || null;
    _emitResuming();
    return _reExecute({
      ..._baseResume,
      _skipTrainingGate: true,
      _proceedAgentId: _agentId,
      _proceedDeepLinkUrl,
      skillPlan: null, skillCursor: 0, skillResults: [],
    });
  }

  // ── Record recipe / open agent training / guided train ─────────────────────
  // guided_train needs the serial path's plan-generation + trainer wiring; for
  // a handoff task we degrade to opening the training tab fresh.
  if (/^(record_recipe|open_agents_training|open_agents_training_here|train_recipe|guided_train)$/i.test(chosen)) {
    const _mode = chosen === 'open_agents_training_here' ? 'here' : 'fresh';
    if (_ipcBroadcast) {
      _ipcBroadcast('agents:open-training', {
        agentId: _agentId,
        mode: _mode,
        task: pq.originalTask || _originalTask || null,
        startUrl: _mode === 'here' ? (pq.currentUrl || null) : null,
        keepSession: _mode === 'here' ? pq.keepSession === true : false,
        browserSessionId: pq.sessionId || null,
      });
    }
    _broadcastDone('cancelled');
    return { ok: true, status: 'cancelled', reason: 'training-handoff' };
  }

  // ── Shell allowlist answer — write to allowed-commands.json and retry ────────
  // Mirrors main.js serial resume (line ~5106). The allowlist card emits
  // options: [`Allow "X" and retry`, `Cancel`]. shell.run auto-reloads the
  // allowlist file on mtime change (shell.run.cjs:784-787), so the retry sees
  // the newly-allowed command without a service restart.
  if (pq._isShellAllowlist || pq.userAllowlistHint) {
    const _cmdName = pq.commandName || '';
    const _wantsAllow = /^allow\b/i.test(chosen) || /add\s*to\s*allowlist/i.test(chosen);
    if (_wantsAllow && _cmdName) {
      try {
        const _fs = require('fs');
        const _path = require('path');
        const allowPath = _path.join(require('os').homedir(), '.thinkdrop', 'allowed-commands.json');
        const allowDir = _path.dirname(allowPath);
        if (!_fs.existsSync(allowDir)) _fs.mkdirSync(allowDir, { recursive: true });
        let existing = [];
        if (_fs.existsSync(allowPath)) {
          const rawAllow = JSON.parse(_fs.readFileSync(allowPath, 'utf8'));
          existing = Array.isArray(rawAllow) ? rawAllow
            : (Array.isArray(rawAllow?.commands) ? rawAllow.commands : []);
        }
        const normalized = [...new Set(
          [...existing, _cmdName]
            .filter((v) => typeof v === 'string')
            .map((v) => _path.basename(v.trim()))
            .filter(Boolean)
        )].sort();
        _fs.writeFileSync(allowPath, JSON.stringify({ commands: normalized }, null, 2), 'utf8');
        console.log(`[HandoffRunner] Allowlisted command "${_cmdName}" — retrying step`);
        _emitResuming();
        return _reExecute({
          ..._baseResume,
          _skillPlan: [
            _buildResumeStep(_originalTask),
            ..._remainingSteps,
          ],
          _skillPlanIsResume: true,
          _resumeStepIndex: _uiStepIdx,
          skillPlan: null, skillCursor: 0, skillResults: [],
        });
      } catch (allowErr) {
        console.error(`[HandoffRunner] Failed to update allowlist: ${allowErr.message}`);
        _broadcastDone('failed');
        return { ok: false, error: `Failed to update allowlist: ${allowErr.message}` };
      }
    }
    // Cancel or any other answer → abort the task
    _broadcastDone('cancelled');
    return { ok: true, status: 'cancelled', reason: 'allowlist-denied' };
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────
  if (/^(cancel|no)$/i.test(chosen)) {
    _broadcastDone('cancelled');
    return { ok: true, status: 'cancelled' };
  }

  // ── Non-agent question (planner clarification etc.) — inject the answer as ──
  // the message with prior state retained; the graph re-processes it in context.
  if (pq._isAgentAskUser !== true && !paused.failedStep) {
    _emitResuming();
    return _reExecute({
      ..._baseResume,
      message: chosen,
      resolvedMessage: chosen,
    });
  }

  // ── Free text (incl. "Correct and retry" follow-ups) — re-run the same ─────
  // agent step with the answer injected as [Resume context: Q&A], accumulating
  // Q&A history across resume turns.
  const _priorQAHistory = Array.isArray(paused._askUserHistory) ? [...paused._askUserHistory] : [];
  _priorQAHistory.push({ question: pq.question || '', answer: chosen });
  const _qaLines = _priorQAHistory.map((qa, i) => `  ${i + 1}. Q: "${qa.question}" → A: "${qa.answer}"`).join('\n');
  const _taskWithAnswer = `${_originalTask}\n\n[Resume context:\n  Previous Q&A:\n${_qaLines}\n  Continue from this point. If the user's latest answer indicates a DIRECTION (e.g. "duration" / "Specify duration") but does NOT contain the actual VALUE needed to proceed, your NEXT action MUST be ask_user with an EMPTY options array asking for the specific value (e.g. "What duration?"). Do NOT repeat the previous choice question. Do NOT guess values.]`;

  _emitResuming();
  return _reExecute({
    ..._baseResume,
    _skillPlan: [
      _buildResumeStep(_taskWithAnswer),
      ..._remainingSteps,
    ],
    _skillPlanIsResume: true,
    _resumeStepIndex: _uiStepIdx,
    skillPlan: null, skillCursor: 0,
    _askUserHistory: _priorQAHistory,
  });
}

// ── Cancel a running task ──────────────────────────────────────────────────────
function cancel(taskId) {
  _pendingQuestions.delete(taskId);
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

module.exports = { init, execute, resume, answerQuestion, hasPendingQuestion, cancel, getActiveCount, getActiveTaskIds };
