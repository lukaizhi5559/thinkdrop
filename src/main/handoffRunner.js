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

// ── Per-run artifact accumulation ──────────────────────────────────────────────
// Steps/files/drafts produced during the run — persisted onto the journal task
// via /comms.complete so queue cards re-expand to real artifacts (step list,
// saved-file links, pending drafts) after a restart instead of empty state.
/** @type {Map<string, { steps: Map<number, any>, savedFilePaths: Set<string>, drafts: Map<string, any> }>} */
const _runArtifacts = new Map();

const _ARTIFACT_MAX_STEPS = 50;
const _ARTIFACT_MAX_OUTPUT = 2000;

function _artifactFor(taskId) {
  let a = _runArtifacts.get(taskId);
  if (!a) {
    a = { steps: new Map(), savedFilePaths: new Set(), drafts: new Map() };
    _runArtifacts.set(taskId, a);
  }
  return a;
}

function _recordStepArtifact(taskId, event) {
  const a = _artifactFor(taskId);
  const idx = typeof event.stepIndex === 'number' ? event.stepIndex
    : (typeof event.step === 'number' ? event.step - 1 : a.steps.size);
  const prev = a.steps.get(idx) || {};
  const output = String(event.error || event.stdout || '').trim();
  a.steps.set(idx, {
    title: event.description || event.title || prev.title || event.skill || 'Step',
    status: event.type === 'step_failed' || /step_failed$/.test(event.type) ? 'failed'
      : (event.skipped === true || prev.status === 'skipped') ? 'skipped'
      : 'done',
    skill: event.skill || prev.skill || undefined,
    output: output ? output.slice(0, _ARTIFACT_MAX_OUTPUT) : prev.output || undefined,
    savedFilePath: event.savedFilePath || prev.savedFilePath || undefined,
    draftPath: event.draftPath || prev.draftPath || undefined,
    openIn: Array.isArray(event.openIn) ? event.openIn : prev.openIn || undefined,
    diff: event.diff || prev.diff || undefined,
  });
  if (event.savedFilePath) a.savedFilePaths.add(event.savedFilePath);
  // A step_done carrying draftPath is the same draft all_done lists — record
  // it eagerly so a failed-after-draft run still shows the pending draft.
  if (event.draftPath) {
    a.drafts.set(event.draftPath, {
      draftPath: event.draftPath,
      filePath: event.filePath || null,
      openIn: Array.isArray(event.openIn) ? event.openIn : [],
      diff: event.diff || null,
    });
  }
  // Bound growth — a runaway loop can't bloat the journal.
  while (a.steps.size > _ARTIFACT_MAX_STEPS) {
    a.steps.delete(Math.min(...a.steps.keys()));
  }
}

function _recordAllDoneArtifacts(taskId, event) {
  const a = _artifactFor(taskId);
  for (const p of (Array.isArray(event.savedFilePaths) ? event.savedFilePaths : [])) {
    if (p) a.savedFilePaths.add(p);
  }
  for (const d of (Array.isArray(event.drafts) ? event.drafts : [])) {
    if (d?.draftPath) {
      a.drafts.set(d.draftPath, {
        draftPath: d.draftPath,
        filePath: d.filePath || null,
        openIn: Array.isArray(d.openIn) ? d.openIn : [],
        diff: d.diff || null,
      });
    }
  }
  // skillResults carry per-step status detail (skipped/needs_input) the
  // step_done stream may not — merge by index without clobbering failures.
  for (const r of (Array.isArray(event.skillResults) ? event.skillResults : [])) {
    if (!r || typeof r !== 'object') continue;
    const idx = typeof r.stepIndex === 'number' ? r.stepIndex
      : (typeof r.step === 'number' ? r.step - 1 : null);
    if (idx === null) continue;
    const prev = a.steps.get(idx) || {};
    const status = prev.status === 'failed' ? 'failed'
      : r.skipped ? 'skipped'
      : r.ok === false ? 'failed'
      : 'done';
    const output = String(r.error || r.stdout || '').trim();
    a.steps.set(idx, {
      title: r.description || prev.title || r.skill || 'Step',
      status,
      skill: r.skill || prev.skill || undefined,
      output: output ? output.slice(0, _ARTIFACT_MAX_OUTPUT) : prev.output || undefined,
      savedFilePath: r.savedFilePath || prev.savedFilePath || undefined,
      draftPath: r.draftPath || prev.draftPath || undefined,
      openIn: Array.isArray(r.openIn) ? r.openIn : prev.openIn || undefined,
      diff: r.diff || prev.diff || undefined,
    });
  }
  while (a.steps.size > _ARTIFACT_MAX_STEPS) {
    a.steps.delete(Math.min(...a.steps.keys()));
  }
}

function _artifactSnapshot(taskId) {
  const a = _runArtifacts.get(taskId);
  if (!a) return null;
  const steps = [...a.steps.keys()].sort((x, y) => x - y).map(k => a.steps.get(k));
  const savedFilePaths = [...a.savedFilePaths];
  const drafts = [...a.drafts.values()];
  if (steps.length === 0 && savedFilePaths.length === 0 && drafts.length === 0) return null;
  return { steps, savedFilePaths, drafts };
}

// A task that emits no progress for this long is considered stalled (provider
// hang, runaway graph). It is force-failed so the serial prompt queue isn't
// poisoned for every subsequent prompt.
const RUN_STALL_MS = parseInt(process.env.TASK_RUN_STALL_MS || '240000', 10);

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
// Live gatherAnswerCallback — registered late via setGatherAnswerCallback()
// because main.js defines it after init() runs. The clarify gate and the
// grill/batch-question UX in gatherPlanContext both need it; without it,
// concurrent handoff tasks cannot ask the user clarifying questions.
let _gatherAnswerCallback = null;

// Browser-session bridge — main.js owns the cross-prompt session vars; the
// comms-graph path must inject prior context into initialState and persist the
// run's final session, or promotion and close-all protection see nothing.
let _getPriorBrowserContext = null;
let _persistBrowserSession = null;
let _closeBrowserSessions = null;

function init({ mcpClient, mcpAdapter, llmBackend, ipcBroadcast, setPendingPreflightPrompt, gatherAnswerCallback, getPriorBrowserContext, persistBrowserSession, closeBrowserSessions }) {
  _mcpClient = mcpClient;
  _mcpAdapter = mcpAdapter;
  _llmBackend = llmBackend;
  _ipcBroadcast = ipcBroadcast;
  _setPendingPreflightPrompt = setPendingPreflightPrompt;
  if (gatherAnswerCallback) _gatherAnswerCallback = gatherAnswerCallback;
  _getPriorBrowserContext = getPriorBrowserContext || null;
  _persistBrowserSession = persistBrowserSession || null;
  _closeBrowserSessions = closeBrowserSessions || null;
}

function setGatherAnswerCallback(cb) {
  _gatherAnswerCallback = cb;
}

// Tag batch questions with the owning taskId so the feed's QueueTaskCard
// (task-scoped AutomationProgress) renders the QuestionCard inline instead of
// the untagged global instance, which is hidden while a live run card exists.
// Legacy string-mode questions pass through untouched.
function _taskGatherCallback(taskId) {
  if (typeof _gatherAnswerCallback !== 'function') return null;
  return (q) => _gatherAnswerCallback(
    q && typeof q === 'object' && q.batch ? { ...q, taskId } : q
  );
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
  // Also broadcast to the renderer — comms-graph's SSE stream has no subscriber,
  // so without this the card's status never leaves queued/awaiting-approval.
  if (_ipcBroadcast) {
    _ipcBroadcast('task:progress', { taskId, ...progress, node: progress.currentStep });
  }
  return _postToComms('/comms.progress', { taskId, agentId, progress });
}

function _notifyComplete(taskId, agentId, status, result, items, sessionId = null, planFile = null, trace = null, artifacts = null) {
  return _postToComms('/comms.complete', { taskId, agentId, status, result, items: items || null, sessionId, planFile, trace, artifacts });
}

// ── Create a fresh stategraph instance for a handoff task ──────────────────────
function _createStateGraph() {
  return StateGraphBuilder.full({
    mcpAdapter: _mcpAdapter,
    llmBackend: _llmBackend,
    logger: console,
  });
}

// ── Friendly labels for graph-node progress events ────────────────────────────
// Emitted by StateGraphBuilder's node wrapper ({type:'node'}) and shown on the
// queue card's status line so the user sees which pipeline stage is running.
const _NODE_LABELS = {
  resolveReferences: 'Reading your request…',
  clarify: 'Checking requirements…',
  decomposePrompt: 'Breaking down the request…',
  parseIntent: 'Understanding intent…',
  checkPlanCache: 'Checking saved plans…',
  fastLanePlan: 'Checking fast path…',
  parseSkill: 'Matching skills…',
  enrichIntent: 'Enriching context…',
  routeIntent: 'Routing…',
  resolveUserContext: 'Loading your context…',
  resolveAgent: 'Selecting agents…',
  preflightAgents: 'Checking agent readiness…',
  gatherPlanContext: 'Gathering requirements…',
  planSkills: 'Planning steps…',
  executeCommand: 'Executing steps…',
  reviewExecution: 'Reviewing results…',
  evaluateSkills: 'Evaluating…',
  retrieveMemory: 'Recalling context…',
  synthesize: 'Writing answer…',
  summarizeMultiIntent: 'Summarizing…',
  advanceQueue: 'Next item…',
  planExecutor: 'Running saved plan…',
  logConversation: 'Wrapping up…',
};

// ── Build a progressCallback that forwards events to renderer + comms-graph ──
function _makeProgressCallback(taskId, agentId) {
  return (event) => {
    if (!event || typeof event !== 'object') return;

    // Any progress event proves the run is alive — re-arm the stall watchdog.
    _activeRuns.get(taskId)?.armStall?.();

    // Tag the event with taskId so the renderer can route it to the right queue card
    const taggedEvent = { ...event, taskId };

    // Accumulate run artifacts for journal persistence — queue cards re-expand
    // to real steps/files/drafts after restart (see _artifactSnapshot).
    if (event.type === 'step_done' || event.type === 'step_failed'
        || event.type === 'plan:step_done' || event.type === 'plan:step_failed') {
      _recordStepArtifact(taskId, event);
    } else if (event.type === 'all_done' || event.type === 'plan:complete') {
      _recordAllDoneArtifacts(taskId, event);
    }

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
    } else if (event.type === 'node') {
      // Per-node stage indicator — renderer-only status line (no comms POST;
      // a full run fires ~10 of these and comms doesn't consume them).
      if (_ipcBroadcast) {
        _ipcBroadcast('task:progress', {
          taskId, node: event.label || _NODE_LABELS[event.node] || event.node,
        });
      }
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
async function execute({ taskId, prompt, agentId, source, originalPrompt, sessionId, planFile, preflightAuthBypass, userApproved, thoughtContext, guessedIntent, _resumeState, _deterministicPlan, _deterministicTemplate, _deterministicLowRisk, _deterministicExternal, _deterministicServiceAgent, _resumeMultiIntent, _resumeIntentQueue, _resumeIntentResults, _resumeDataContext }) {
  if (!_mcpAdapter || !_llmBackend) {
    console.error('[HandoffRunner] Not initialized — call init() first');
    _notifyComplete(taskId, agentId, 'failed', 'HandoffRunner not initialized', null, sessionId);
    return;
  }

  const abortController = new AbortController();
  const progressCallback = _makeProgressCallback(taskId, agentId);
  let stateGraph = null;

  try {
    stateGraph = _createStateGraph();
    _activeRuns.set(taskId, { abortController, stateGraph, progressCallback });

    // Stall watchdog: if no progress events arrive for RUN_STALL_MS, abort the
    // run and reject — the serial prompt queue must not hang forever on a
    // stuck provider call.
    let _stallReject;
    const _stallPromise = new Promise((_, reject) => { _stallReject = reject; });
    const _armStall = () => {
      const run = _activeRuns.get(taskId);
      if (!run) return;
      clearTimeout(run.stallTimer);
      run.stallTimer = setTimeout(() => {
        const err = new Error(`Task stalled — no progress for ${RUN_STALL_MS}ms`);
        err._stalled = true;
        abortController.abort();
        _stallReject(err);
      }, RUN_STALL_MS);
    };
    _activeRuns.get(taskId).armStall = _armStall;
    _armStall();

    console.log(`[HandoffRunner] Starting task ${taskId}: ${prompt.substring(0, 80)}${planFile ? ' (with plan)' : ''}`);

    // Notify comms-graph that the task is running
    _notifyProgress(taskId, agentId, { step: 0, totalSteps: 0, currentStep: 'Initializing' });

    // A fresh execute() for a taskId supersedes any stale paused question.
    _pendingQuestions.delete(taskId);

    // Build initial state for the stategraph.
    // _resumeState: a paused finalState from answerQuestion() — spread it as the
    // base so skillPlan/_skillPlan/cursor/history carry over, then re-apply the
    // live run wiring (callbacks, adapters) that can't be serialized.
    // Stream callback: forward each synthesis token to the renderer as a
    // ws-bridge chunk tagged with this taskId, so the live answer bubble /
    // AutomationProgress card streams the answer as it's generated — same
    // shape main.js's serial streamCallback already uses.
    const streamCallback = (token) => {
      if (token && _ipcBroadcast) {
        _ipcBroadcast('ws-bridge:message', { type: 'chunk', text: token, taskId });
      }
    };

    const initialState = _resumeState
      ? {
          ..._resumeState,
          mcpAdapter: _mcpAdapter,
          llmBackend: _llmBackend,
          progressCallback,
          streamCallback,
          gatherAnswerCallback: _taskGatherCallback(taskId),
          _handoffTaskId: taskId,
          _handoffSource: source,
          // Live value wins — a session may have been born/died while the task
          // was paused; resolveReferencesV2 re-validates compatibility anyway.
          priorBrowserContext: _getPriorBrowserContext?.() || _resumeState?.priorBrowserContext || null,
        }
      : {
          message: prompt,
          resolvedMessage: prompt,
          intent: { type: 'command_automate' }, // Handoffs are always command_automate
          sessionId: sessionId || null,
          userId: process.env.MONITOR_USER_ID || 'local_user',
          // context.sessionId pins resolveReferencesV2's history fetch and
          // logConversation's session — this is what makes task recall work.
          // userId must match the monitor's MONITOR_USER_ID ('local_user') —
          // all memory/episodic rows live under that id.
          context: { sessionId: sessionId || null, userId: process.env.MONITOR_USER_ID || 'local_user', source: 'thinkdrop_electron' },
          mcpAdapter: _mcpAdapter,
          llmBackend: _llmBackend,
          _handoffTaskId: taskId,
          _handoffSource: source,
          // CRITICAL: set progressCallback so rich events reach the renderer
          progressCallback,
          // Token streaming for the synthesize step (and any node that pushes
          // partial output) — previously only the serial path had this wired.
          streamCallback,
          // Clarification surface — the clarify gate and grill/batch questions
          // emit gather:question_batch cards and await answers, same as the
          // serial path in main.js.
          gatherAnswerCallback: _taskGatherCallback(taskId),
          // If resuming with an approved plan, set _planFile so planExecutor runs it
          ...(planFile ? { _planFile: planFile } : {}),
          // Deterministic fast-path metadata survives the approval round-trip —
          // executeCommand uses it for the direct step-output answer + 10s cap.
          ...(_deterministicPlan ? { _deterministicPlan, _deterministicTemplate, _deterministicLowRisk, _deterministicExternal, _deterministicServiceAgent } : {}),
          // Multi-intent queue restored across a plan-approval resume —
          // planExecutor maps these _resume* fields onto isMultiIntent/
          // intentQueue/intentResults/dataContext, and advanceQueue pops
          // the next step after this plan completes.
          ...(_resumeMultiIntent ? {
            _resumeMultiIntent:   true,
            _resumeIntentQueue:   _resumeIntentQueue || [],
            _resumeIntentResults: _resumeIntentResults || [],
            _resumeDataContext:   _resumeDataContext || {},
          } : {}),
          // Auth bypass: user chose "proceed without" — treat listed agents as
          // authed for this run only (not persisted to auth cache or authed_at)
          ...(preflightAuthBypass?.length ? { preflightAuthBypass } : {}),
          // Proactive dispatch whose thought was already approved in the Brain —
          // planSkillsV2 skips the duplicate Queue plan-approval gate for it.
          ...(userApproved ? { userApproved: true } : {}),
          // Reply to a proactive Thought card — resolveReferencesV2 splits the
          // card from the message, injects it as a labeled turn, and reports
          // the lifecycle outcome back to the thought engine.
          ...(thoughtContext ? { _thoughtAttachment: thoughtContext } : {}),
          // comms-graph's deterministic intentGuesser verdict — decomposePromptV2
          // uses it as a prior and as the parse-failure fallback instead of
          // defaulting to command_automate.
          ...(guessedIntent ? { _carriedHint: guessedIntent } : {}),
          // Same cross-prompt session continuity as the serial path — without
          // this the promotion matrix in resolveReferencesV2 never sees the
          // prior browser session and plan-level close-all runs unprotected.
          priorBrowserContext: _getPriorBrowserContext?.() || null,
        };

    // Always normalize to a mutable array — main.js pushes mid-run
    // "Proceed without" clicks into this same array while the graph is
    // running (shared by reference into the live state).
    if (!Array.isArray(initialState.preflightAuthBypass)) {
      initialState.preflightAuthBypass = initialState.preflightAuthBypass ? [initialState.preflightAuthBypass] : [];
    }
    // Mid-run "I've already signed in" queue — preflightAgents re-verifies
    // these agents once the auth loop finishes.
    if (!Array.isArray(initialState._authContinueQueued)) initialState._authContinueQueued = [];

    // Expose the live state on the run entry so main.js auth handlers can
    // push mid-run decisions into it.
    const _runEntry = _activeRuns.get(taskId);
    if (_runEntry) _runEntry.state = initialState;

    // Execute the stategraph
    const finalState = await Promise.race([
      stateGraph.execute(initialState, null, abortController.signal),
      _stallPromise,
    ]);

    // Persist/clear the browser session for the next prompt — the serial path
    // does this after stateGraph.execute; handoff tasks must do the same or the
    // session is invisible to follow-up prompts.
    try { _persistBrowserSession?.(finalState); } catch (_) {}

    // Pure-interaction plans (open/focus/click steps) often leave
    // finalState.answer empty — the step outputs ("Notes already open and
    // focused") live in skillResults[].stdout. Fall back to the same
    // "Step outputs:" summary logConversation writes so the completion
    // payload isn't a blank answer.
    let answer = finalState.answer || '';
    if (!answer && Array.isArray(finalState.skillResults)) {
      // A synthesize step's output is the real answer — surface it directly
      // rather than burying it in the Step outputs debug blob.
      const _synth = [...finalState.skillResults].reverse().find(r =>
        r && r.skill === 'synthesize' && r.ok !== false &&
        String(r.stdout || r.result || '').trim());
      if (_synth) answer = String(_synth.stdout || _synth.result).trim();
    }
    if (!answer && Array.isArray(finalState.skillResults)) {
      const outs = finalState.skillResults
        .filter(r => r && r.ok !== false && typeof r.stdout === 'string' && r.stdout.trim())
        .map(r => `[${r.description || r.skill || 'step'}]:\n${r.stdout.trim().slice(0, 500)}`);
      if (outs.length) answer = `Done.\n\nStep outputs:\n${outs.join('\n\n')}`;
      else if (finalState.skillResults.some(r => r && r.ok !== false)) answer = 'Done.';
    }
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
      // web_search results land in contextDocs (not skillResults) — map them
      // into items so they render as cards too. Use _allContextDocs (the union
      // accumulated across multi-intent queue steps) so a mid-pipeline search
      // still produces cards after a later screen_display step wiped
      // contextDocs. Link-only docs (no thumbnail) become title/snippet/favicon
      // cards — WebResultCard renders that shape fine.
      ...(Array.isArray(finalState._allContextDocs || finalState.contextDocs)
        ? (finalState._allContextDocs || finalState.contextDocs)
            .filter(d => d && (d.imageUrl || (d.url && d.url.startsWith('http'))))
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
        _deterministicPlan: finalState._deterministicPlan || null,
        _deterministicTemplate: finalState._deterministicTemplate || null,
        _deterministicLowRisk: finalState._deterministicLowRisk ?? null,
        _deterministicExternal: finalState._deterministicExternal || null,
        _deterministicServiceAgent: finalState._deterministicServiceAgent || null,
        // Multi-intent queue — a mid-pipeline step that pauses for plan
        // approval must restore the remaining queue on resume or later
        // sub-intents are silently dropped (observed: [journal_stats,
        // screen_display] — the det gather resumed as a 1-step plan and the
        // screen_display step never ran).
        isMultiIntent: finalState.isMultiIntent || false,
        intentQueue: finalState.intentQueue || [],
        intentResults: finalState.intentResults || [],
        dataContext: finalState.dataContext || {},
      });
      console.log(`[HandoffRunner] Task ${taskId} awaiting plan approval — planFile=${planFileFromState}`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'awaiting-approval', '', null, finalState.resolvedSessionId || sessionId, planFileFromState, null, _artifactSnapshot(taskId));
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
          sessionId: finalState.resolvedSessionId || sessionId || null,
          artifacts: _artifactSnapshot(taskId),
        });
      }
      return { ok: true, status: 'awaiting-approval', planFile: planFileFromState };

    } else if (finalState.planError && finalState.preflightAuthRequired) {
      // Preflight auth required — resumable warning state, NOT a terminal failure.
      // The user needs to sign in; the task will resume after auth succeeds.
      console.log(`[HandoffRunner] Task ${taskId} auth required: ${finalState.planError}`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'auth-required', finalState.planError, null, finalState.resolvedSessionId || sessionId, null, null, _artifactSnapshot(taskId));
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
          sessionId: finalState.resolvedSessionId || sessionId || null,
          artifacts: _artifactSnapshot(taskId),
        });
      }
      // Populate the per-task pending map so the preflight:auth_continue
      // handler in main.js can resume this task after sign-in.
      if (typeof _setPendingPreflightPrompt === 'function') {
        _setPendingPreflightPrompt(taskId, {
          // Carry taskId — the resume must reuse it so the follow-up
          // completion overwrites this auth-required status on the same
          // task the caller is tracking. Without it the resumed run mints a
          // new taskId and the original stays 'auth-required' forever.
          taskId,
          prompt,
          agentId: agentId || null,
          source: source || 'text',
          originalPrompt: originalPrompt || null,
          sessionId: finalState.resolvedSessionId || sessionId || null,
          // Mid-run auth decisions the user already made — carried into the
          // resume so bypassed agents aren't re-prompted for sign-in. Plus
          // the agents that just failed auth — "proceed" must bypass THEM,
          // not merely replay the (possibly empty) prior bypass list.
          queuedBypasses: [...new Set([
            ...(Array.isArray(finalState.preflightAuthBypass) ? finalState.preflightAuthBypass : []),
            ...(Array.isArray(finalState.preflightAuthAgents) ? finalState.preflightAuthAgents : []),
          ])],
          queuedContinues: Array.isArray(finalState._authContinueQueued) ? [...finalState._authContinueQueued] : [],
        });
      }
      return { ok: false, status: 'auth-required', error: finalState.planError };

    } else if (finalState.planError) {
      // Preflight or plan generation failed
      console.error(`[HandoffRunner] Task ${taskId} plan error: ${finalState.planError}`);
      // Emit pipeline:done so AutomationProgress clears any planning spinner
      progressCallback({ type: 'pipeline:done', contract: finalState._contract });
      _notifyComplete(taskId, agentId, 'failed', finalState.planError, null, finalState.resolvedSessionId || sessionId, null, null, _artifactSnapshot(taskId));
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
          sessionId: finalState.resolvedSessionId || sessionId || null,
          artifacts: _artifactSnapshot(taskId),
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
      _notifyComplete(taskId, agentId, 'waiting-for-input', '', null, finalState.resolvedSessionId || sessionId, null, null, _artifactSnapshot(taskId));
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
          sessionId: finalState.resolvedSessionId || sessionId || null,
          artifacts: _artifactSnapshot(taskId),
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
      // Per-node timing trace — slim {node,duration} only (input/output
      // snapshots are huge). Lets the e2e driver report per-node latency.
      const _trace = Array.isArray(finalState.trace)
        ? finalState.trace.map(t => ({ node: t.node, duration: t.duration }))
        : null;
      _notifyComplete(taskId, agentId, 'done', answer, items, finalState.resolvedSessionId || sessionId, null, _trace, _artifactSnapshot(taskId));
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
          sessionId: finalState.resolvedSessionId || sessionId || null,
          artifacts: _artifactSnapshot(taskId),
        });
      }
      return { ok: true, status: 'done', answer, thinking, intent };
    }

  } catch (err) {
    console.error(`[HandoffRunner] Task ${taskId} failed:`, err.message);

    const status = (abortController.signal.aborted && !err._stalled) ? 'cancelled' : 'failed';
    // Partial trace survives failures — state.trace accumulated on the live
    // initialState object (_runEntry.state) before the throw.
    const _failTrace = Array.isArray(_runEntry?.state?.trace)
      ? _runEntry.state.trace.map(t => ({ node: t.node, duration: t.duration }))
      : null;
    _notifyComplete(taskId, agentId, status, err.message, null, sessionId, null, _failTrace, _artifactSnapshot(taskId));

    if (_ipcBroadcast) {
      _ipcBroadcast('task:complete', {
        taskId,
        prompt: originalPrompt || prompt,
        answer: '',
        error: err.message,
        status,
        agentId,
        source,
        sessionId: sessionId || null,
        artifacts: _artifactSnapshot(taskId),
      });
    }

    return { ok: false, status, error: err.message };

  } finally {
    clearTimeout(_activeRuns.get(taskId)?.stallTimer);
    _activeRuns.delete(taskId);
    _runArtifacts.delete(taskId);
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

  console.log(`[HandoffRunner] Resuming task ${taskId} with plan ${planFile} det=${ctx._deterministicTemplate || 'none'} ext=${ctx._deterministicExternal || false}`);
  return execute({
    taskId,
    prompt: ctx.prompt,
    agentId: ctx.agentId,
    source: ctx.source,
    originalPrompt: ctx.originalPrompt,
    sessionId: ctx.sessionId,
    planFile,
    _deterministicPlan: ctx._deterministicPlan,
    _deterministicTemplate: ctx._deterministicTemplate,
    _deterministicLowRisk: ctx._deterministicLowRisk,
    _deterministicExternal: ctx._deterministicExternal,
    _deterministicServiceAgent: ctx._deterministicServiceAgent,
    _resumeMultiIntent: ctx.isMultiIntent,
    _resumeIntentQueue: ctx.intentQueue,
    _resumeIntentResults: ctx.intentResults,
    _resumeDataContext: ctx.dataContext,
  });
}

// ── Pending plan approvals ────────────────────────────────────────────────────
/**
 * Returns tasks currently paused at the plan-approval gate.
 * Used by the free-form confirmation intercept in main.js so a spoken/typed
 * "yes send it" can approve instead of spawning a duplicate task.
 * @returns {Array<{taskId: string, planFile: string|null, prompt: string}>}
 */
function getPendingPlanApprovals() {
  return Array.from(_pendingPlanContexts.entries()).map(([taskId, ctx]) => ({
    taskId,
    planFile: ctx.planFile || null,
    prompt: ctx.originalPrompt || ctx.prompt || '',
  }));
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
  // Recover the skill that actually ran before defaulting — a missing skill ref
  // must not silently become a browser.agent run on resume.
  const _resumeSkill = pq.skill
    || paused.skillPlan?.[_stepIdx]?.skill
    || paused.skillResults?.find(r => r && r.skill && (r.step === _stepIdx + 1 || r.stepIndex === _stepIdx))?.skill
    || paused.skillResults?.slice().reverse().find(r => r && r.skill)?.skill
    || 'browser.agent';
  const _originalTask = (pq.originalTask || paused.skillPlan?.[_stepIdx]?.args?.task || ctx.prompt || '')
    .replace(/\s*\[Resume context:[\s\S]*?\]\s*$/g, '').trim();
  const _description = paused.skillPlan?.[_stepIdx]?.description || _originalTask;
  const _remainingSteps = Array.isArray(paused.skillPlan)
    ? paused.skillPlan.slice(Math.max(paused.skillCursor || 0, _stepIdx + 1))
    : [];

  const _broadcastDone = (status) => {
    _notifyComplete(taskId, ctx.agentId, status, '', null, ctx.sessionId, null, null, _artifactSnapshot(taskId));
    if (_ipcBroadcast) {
      _ipcBroadcast('task:complete', {
        taskId, prompt: ctx.originalPrompt || ctx.prompt, answer: '',
        status, agentId: ctx.agentId, source: ctx.source,
        sessionId: ctx.sessionId || null,
        artifacts: _artifactSnapshot(taskId),
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
    // The paused run already persisted the user turn when it routed through
    // logConversation — without this flag every ask_user resume writes another
    // identical user row (history shows the prompt once per pause).
    _skipUserLog: true,
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
    // app.agent is an ACTION skill (navigate_url/scan_page/print_page/…), not a
    // goal-driven agent — 'run' doesn't exist there. Reuse the original args.
    if (_resumeSkill === 'app.agent' && _origStep.args?.action) {
      return { skill: _resumeSkill, args: _origStep.args, description: _description };
    }
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
    // Deliver the answer through _gatheredVars[varName] so {{_var}} tokens in
    // later steps resolve (mirrors the serial flow's gatherCredentialCallback
    // write in executeCommand.js). Also patch the paused ask_user's skillResults
    // stdout — otherwise it keeps "[Waiting for user input: …]" and any
    // {{PREV_OUTPUT}} consumer injects that placeholder text.
    const _gv = pq.varName
      ? { ...(paused._gatheredVars || {}), [pq.varName]: chosen }
      : paused._gatheredVars;
    const _patchedResults = (paused.skillResults || []).map(r =>
      r && r.skill === 'ask_user' && r.step === _stepIdx + 1 ? { ...r, stdout: chosen } : r);
    return _reExecute({
      ..._baseResume,
      message: chosen,
      resolvedMessage: chosen,
      _gatheredVars: _gv,
      skillResults: _patchedResults,
    });
  }

  // ── Free text on a verbatim deterministic step — treat as a new instruction ──
  // shell.run/fs.* steps carry fixed cmd/argv args — the answer can't be
  // injected (only `goal`-based steps absorb text), so the old path replayed
  // the identical failing command in a loop. Route the answer through normal
  // classification instead: "goto gmail in browser" re-plans as url_open.
  const _origStepArgs = paused.skillPlan?.[_stepIdx]?.args || {};
  if (!_AGENT_SKILLS.has(_resumeSkill) && (_origStepArgs.cmd || _origStepArgs.argv) && !_origStepArgs.goal) {
    _emitResuming();
    return _reExecute({
      ..._baseResume,
      message: chosen,
      resolvedMessage: chosen,
      _skillPlan: null,
      _skillPlanIsResume: false,
      skillPlan: null, skillCursor: 0,
      skillResults: paused.skillResults || [],
      _deterministicPlan: null, _deterministicTemplate: null,
      _deterministicLowRisk: null, _deterministicExternal: null,
      _deterministicServiceAgent: null,
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
  // Also drop a pending plan-approval context — a task paused at the approval
  // gate has no active run to abort, but cancelling it must prevent a later
  // resume() from re-executing it.
  const hadPendingPlan = _pendingPlanContexts.delete(taskId);
  const run = _activeRuns.get(taskId);
  if (!run) {
    if (hadPendingPlan) console.log(`[HandoffRunner] Cancelled task ${taskId} (pending plan approval)`);
    return hadPendingPlan;
  }
  run.abortController.abort();
  // Parity with the serial path's automation:cancel — closing the task must not
  // leak its Playwright window.
  try { _closeBrowserSessions?.('handoff cancel'); } catch (_) {}
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

// ── Get the progressCallback for a running task ────────────────────────────────
// Used by main.js /agent-turn to route command-service progress events
// (tab_flow:*, tab_map:*, agent:turn, …) to the correct queue card — the
// callback tags each event with its taskId before broadcasting.
function getProgressCallback(taskId) {
  return _activeRuns.get(taskId)?.progressCallback || null;
}

// ── Get the live run entry for a running task ─────────────────────────────────
// Used by main.js auth handlers to push mid-run decisions ("Proceed without",
// "I've already signed in") into the shared state object — the preflight node
// re-reads state.preflightAuthBypass / state._authContinueQueued live.
function getLiveRun(taskId) {
  return _activeRuns.get(taskId) || null;
}

module.exports = { init, execute, resume, answerQuestion, hasPendingQuestion, getPendingPlanApprovals, cancel, getActiveCount, getActiveTaskIds, getProgressCallback, getLiveRun, setGatherAnswerCallback };
