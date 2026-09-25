'use strict';
/**
 * main-stub.cjs — headless replacement for the Electron main process (:3010)
 * during e2e sweeps.
 *
 * Replicates main.js's overlay-control server endpoints exactly, wired to the
 * REAL handoffRunner → real StateGraphBuilder.full() → real MCP services +
 * the real ws:4000 LLM backend. Only the Electron surface (windows, IPC,
 * GhostLayer painting) is stubbed — every IPC event and /screen payload is
 * recorded so the driver can assert on them.
 *
 * Endpoints:
 *   POST /comms.handoff          comms-graph task dispatch → handoffRunner.execute
 *   POST /comms.signal           cancel/pause/resume → handoffRunner.cancel
 *   POST /comms.process-internal proxy to comms-graph :3015 /comms.process
 *   POST /screen/display         record GhostLayer payload → { ok:true, id }
 *   POST /screen/clear           record clear → { ok:true }
 *   GET  /screen/state           { displays:[...] } snapshot
 *   POST /thought.event          sink (recorded)
 *   POST /agent-turn             command-service progress → task progressCallback
 *
 * Harness control:
 *   GET  /harness/events?since=N recorded ipc/progress events
 *   GET  /harness/screens        recorded /screen payloads
 *   POST /harness/next-answers   { answers: [string|{match,answer}] } consumed
 *                                by the NEXT /comms.handoff task
 *   POST /harness/question       { taskId, answer } → handoffRunner.answerQuestion
 *   POST /harness/approve        { taskId } → handoffRunner.resume
 *   POST /harness/auth           { taskId, mode:'proceed'|'signed_in'|'bypass' }
 *   POST /harness/reset          clear event/screen logs
 *   GET  /health
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env from repo root (WEBSOCKET_URL, WEBSOCKET_API_KEY, BASE_API_KEY…)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch (_) { /* dotenv optional — env may be set externally */ }

const PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
const COMMS_PORT = parseInt(process.env.COMMS_GRAPH_PORT || '3015', 10);
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const RUN_LOG = path.join(RESULTS_DIR, `harness-${Date.now()}.log`);
const _logStream = fs.createWriteStream(RUN_LOG, { flags: 'a' });

// Tee console → results log so every node trace lands in a per-run file.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    try { _logStream.write(`[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); } catch (_) {}
    orig(...args);
  };
}
console.log(`[Harness] node trace → ${RUN_LOG}`);

const { RealMCPAdapter, ThinkDropLLMBackend } = require('@thinkdrop/stategraph');
const ThinkDropMCPClient = require('../../src/main/ThinkDropMCPClient');
const handoffRunner = require('../../src/main/handoffRunner');

// ── Recorded surfaces ─────────────────────────────────────────────────────────
const events = [];        // ipcBroadcast events: task:created, task:complete, automation:progress, plan:generated…
const screens = [];       // /screen/display + /screen/clear payloads
const displays = [];      // currently-active displays (cleared by /screen/clear)
const thoughtEvents = []; // /thought.event payloads
let displaySeq = 0;

// ── Scripted answers ──────────────────────────────────────────────────────────
// nextAnswers: FIFO — assigned to the NEXT /comms.handoff task that arrives.
// pendingQuestions let the driver see what the graph asked (for debugging).
let nextAnswers = null;
const taskAnswers = new Map(); // taskId → answers array
const askedQuestions = [];     // { taskId|null, question|batch, at }

function _answersFor(taskId) { return taskAnswers.get(taskId) || null; }

function _pickScripted(answers, questionText) {
  if (!Array.isArray(answers) || !answers.length) return null;
  // Entries may be a string or {match: /re/ or 'substr', answer}
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    if (typeof a === 'string') { answers.splice(i, 1); return a; }
    if (a && typeof a === 'object') {
      const q = String(questionText || '');
      const ok = a.match instanceof RegExp ? a.match.test(q)
        : a.match ? q.toLowerCase().includes(String(a.match).toLowerCase())
        : false;
      if (ok) { answers.splice(i, 1); return a.answer; }
    }
  }
  return null;
}

// gatherAnswerCallback — same contract as main.js:5499:
//   legacy: (questionString) → Promise<string|null>
//   batch:  ({batch:true, batchId, questions[], routeConfirmation}) → Promise<{[id]:value}>
function gatherAnswerCallback(questionOrBatch) {
  if (questionOrBatch && typeof questionOrBatch === 'object' && questionOrBatch.batch) {
    const { batchId, questions } = questionOrBatch;
    askedQuestions.push({ at: Date.now(), batchId, questions });
    console.log(`[Harness] gather batch ${batchId}: ${(questions || []).length} question(s)`);
    const out = {};
    // Scripted answers are usually staged under a wildcard task key '*' because
    // gatherAnswerCallback doesn't know the taskId — the driver sets them via
    // /harness/answers-global or they ride on nextAnswers for the current task.
    const staged = _answersFor('*') || [];
    for (const q of questions || []) {
      const qid = q.id;
      const qtext = q.question || q.text || '';
      const scripted = _pickScripted(staged, qtext);
      if (scripted != null) { out[qid] = scripted; continue; }
      // Default: primary option value, else first option, else freeText 'yes'
      const opts = Array.isArray(q.options) ? q.options : [];
      const primary = opts.find(o => o.primary) || opts[0];
      out[qid] = primary ? (primary.value ?? primary.label) : 'yes';
      console.log(`[Harness] gather ${qid} "${qtext.slice(0, 60)}" → default "${out[qid]}"`);
    }
    return Promise.resolve(out);
  }
  const question = String(questionOrBatch || '');
  askedQuestions.push({ at: Date.now(), question });
  const staged = _answersFor('*') || [];
  const scripted = _pickScripted(staged, question);
  const answer = scripted != null ? scripted : 'yes';
  console.log(`[Harness] gather legacy "${question.slice(0, 60)}" → "${answer}"`);
  return Promise.resolve(answer);
}

// ── Wiring (mirrors main.js initStateGraph + handoffRunner.init) ───────────────
const mcpClient = new ThinkDropMCPClient({ logger: console, timeoutMs: 600000 });
const mcpAdapter = new RealMCPAdapter(mcpClient, { logger: console });
const llmBackend = new ThinkDropLLMBackend({
  wsUrl:            process.env.WEBSOCKET_URL     || 'ws://localhost:4000/ws/stream',
  apiKey:           process.env.BASE_API_KEY  || process.env.WEBSOCKET_API_KEY || '',
  userId:           'thinkdrop_electron',
  connectTimeoutMs: 5000,
  responseTimeoutMs: 60000,
});

const pendingPreflightPrompts = new Map(); // taskId → ctx (auth-required resume)

function ipcBroadcast(channel, data) {
  events.push({ at: Date.now(), channel, data });
  if (channel === 'task:complete' || channel === 'task:created') {
    console.log(`[Harness:IPC] ${channel} ${data?.taskId || ''} status=${data?.status || 'n/a'}`);
  }
}

handoffRunner.init({
  mcpClient,
  mcpAdapter,
  llmBackend,
  ipcBroadcast,
  setPendingPreflightPrompt: (taskId, ctx) => pendingPreflightPrompts.set(taskId, ctx),
  gatherAnswerCallback,
});
console.log('✅ [Harness] handoffRunner initialized (real stategraph + real MCPs + ws LLM)');

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function _json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}
function _readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}
function _postJson(port, urlPath, bodyObj, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj || {});
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch (_) { resolve({ status: res.statusCode, raw }); } });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(body); req.end();
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathName = url.pathname;

  // ── Harness control ────────────────────────────────────────────────────────
  if (pathName === '/health') return _json(res, 200, { ok: true, service: 'e2e-main-stub', port: PORT });

  if (pathName === '/harness/events') {
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    return _json(res, 200, { events: events.slice(since), total: events.length });
  }
  if (pathName === '/harness/screens') return _json(res, 200, { screens, displays });
  if (pathName === '/harness/thoughts') return _json(res, 200, { thoughtEvents });
  if (pathName === '/harness/questions') return _json(res, 200, { askedQuestions });
  if (pathName === '/harness/reset' && req.method === 'POST') {
    events.length = 0; screens.length = 0; thoughtEvents.length = 0; askedQuestions.length = 0;
    return _json(res, 200, { ok: true });
  }
  if (pathName === '/harness/next-answers' && req.method === 'POST') {
    const raw = await _readBody(req);
    const b = JSON.parse(raw || '{}');
    // RegExp revival: {match:'re:pattern', answer} → /pattern/i
    nextAnswers = (b.answers || []).map(a => (a && typeof a === 'object' && typeof a.match === 'string' && a.match.startsWith('re:'))
      ? { match: new RegExp(a.match.slice(3), 'i'), answer: a.answer }
      : a);
    return _json(res, 200, { ok: true, staged: nextAnswers.length });
  }
  if (pathName === '/harness/answers-global' && req.method === 'POST') {
    const raw = await _readBody(req);
    const b = JSON.parse(raw || '{}');
    taskAnswers.set('*', (b.answers || []).map(a => (a && typeof a === 'object' && typeof a.match === 'string' && a.match.startsWith('re:'))
      ? { match: new RegExp(a.match.slice(3), 'i'), answer: a.answer }
      : a));
    return _json(res, 200, { ok: true });
  }
  if (pathName === '/harness/question' && req.method === 'POST') {
    const raw = await _readBody(req);
    const b = JSON.parse(raw || '{}');
    const r = await handoffRunner.answerQuestion(b.taskId, String(b.answer || ''));
    return _json(res, 200, r || { ok: false });
  }
  if (pathName === '/harness/approve' && req.method === 'POST') {
    const raw = await _readBody(req);
    const b = JSON.parse(raw || '{}');
    const pend = handoffRunner.getPendingPlanApprovals().find(p => p.taskId === b.taskId);
    if (!pend) return _json(res, 404, { ok: false, error: 'no pending plan approval' });
    handoffRunner.resume(b.taskId, pend.planFile).catch(e => console.error('[Harness] resume failed:', e.message));
    return _json(res, 200, { ok: true, planFile: pend.planFile });
  }
  if (pathName === '/harness/auth' && req.method === 'POST') {
    const raw = await _readBody(req);
    const b = JSON.parse(raw || '{}');
    const ctx = pendingPreflightPrompts.get(b.taskId);
    if (!ctx) return _json(res, 404, { ok: false, error: 'no pending preflight ctx' });
    pendingPreflightPrompts.delete(b.taskId);
    // "proceed" → bypass all unauthed agents for this run only
    const bypass = [...(ctx.queuedBypasses || []), ...(ctx.queuedContinues || [])];
    handoffRunner.execute({ ...ctx, preflightAuthBypass: bypass, userApproved: true })
      .catch(e => console.error('[Harness] auth-resume failed:', e.message));
    return _json(res, 200, { ok: true, bypassed: bypass });
  }

  // ── Production endpoints ───────────────────────────────────────────────────

  // comms-graph → handoff dispatch (mirrors main.js:834)
  if (pathName === '/comms.handoff' && req.method === 'POST') {
    const raw = await _readBody(req);
    try {
      const { taskId, prompt, agentId, source, originalPrompt, guessedIntent, sessionId, userApproved, thoughtContext } = JSON.parse(raw || '{}');
      console.log(`[CommsGraph] Handoff received — task=${taskId} agent=${agentId || 'auto'} source=${source} guessedIntent=${guessedIntent || 'null'} session=${sessionId || 'none'}${thoughtContext?.id ? ` thought=${thoughtContext.id}` : ''}`);
      if (nextAnswers) { taskAnswers.set(taskId, nextAnswers); taskAnswers.set('*', nextAnswers); nextAnswers = null; }
      events.push({ at: Date.now(), channel: 'task:created', data: { taskId, prompt: originalPrompt || prompt, agentId: agentId || null, source: source || 'text', guessedIntent: guessedIntent ?? null } });
      handoffRunner.execute({
        taskId,
        prompt,
        agentId: agentId || null,
        source: source || 'text',
        originalPrompt: originalPrompt || null,
        sessionId: sessionId || null,
        userApproved: userApproved === true,
        thoughtContext: thoughtContext || null,
      }).catch(err => console.error(`[CommsGraph] Handoff ${taskId} error:`, err.message));
      return _json(res, 200, { ok: true, taskId });
    } catch (err) {
      console.error('[CommsGraph] Handoff error:', err.message);
      return _json(res, 500, { error: err.message });
    }
  }

  if (pathName === '/comms.signal' && req.method === 'POST') {
    const raw = await _readBody(req);
    try {
      const { signalType, taskId } = JSON.parse(raw || '{}');
      console.log(`[CommsGraph] Signal received — ${signalType} task=${taskId || 'n/a'}`);
      if (signalType === 'cancel' && taskId) {
        return _json(res, 200, { ok: true, cancelled: handoffRunner.cancel(taskId) });
      }
      return _json(res, 200, { ok: true });
    } catch (err) { return _json(res, 400, { error: err.message }); }
  }

  // Proxy used by the renderer in production — lets the driver optionally route
  // through :3010 exactly like the frontend does.
  if (pathName === '/comms.process-internal' && req.method === 'POST') {
    const raw = await _readBody(req);
    const upstream = await _postJson(COMMS_PORT, '/comms.process', JSON.parse(raw || '{}'), 30000);
    return _json(res, upstream.status || 200, upstream.json || upstream);
  }

  if (pathName === '/thought.event' && req.method === 'POST') {
    const raw = await _readBody(req);
    try { thoughtEvents.push({ at: Date.now(), evt: JSON.parse(raw || '{}') }); } catch (_) {}
    return _json(res, 200, { ok: true });
  }

  // command-service → per-agent progress events (mirrors main.js /agent-turn)
  if (pathName === '/agent-turn' && req.method === 'POST') {
    const raw = await _readBody(req);
    const taskId = url.searchParams.get('taskId');
    try {
      const evt = JSON.parse(raw || '{}');
      const cb = taskId && handoffRunner.getProgressCallback ? handoffRunner.getProgressCallback(taskId) : null;
      if (cb) cb({ ...evt, taskId });
      events.push({ at: Date.now(), channel: 'agent-turn', data: { taskId, ...evt } });
    } catch (_) {}
    return _json(res, 200, { ok: true });
  }

  // ── GhostLayer screen output (recorded, not rendered) ──────────────────────
  if (pathName === '/screen/display' && req.method === 'POST') {
    const raw = await _readBody(req);
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch (_) {}
    const id = `so_stub_${(++displaySeq).toString(36)}`;
    const rec = { at: Date.now(), id, ...payload };
    screens.push(rec);
    displays.push({ id, kind: payload.kind || 'text', blocking: !!payload.blocking });
    console.log(`[Harness:Screen] display id=${id} kind=${payload.kind || 'text'} text="${String(payload.text || payload.title || '').slice(0, 80)}"`);
    return _json(res, 200, { ok: true, id });
  }
  if (pathName === '/screen/clear' && req.method === 'POST') {
    const raw = await _readBody(req);
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch (_) {}
    screens.push({ at: Date.now(), cleared: true, ...payload });
    if (payload.id) {
      const i = displays.findIndex(d => d.id === payload.id);
      if (i >= 0) displays.splice(i, 1);
    } else displays.length = 0;
    console.log('[Harness:Screen] clear');
    return _json(res, 200, { ok: true });
  }
  if (pathName === '/screen/state' && req.method === 'GET') {
    return _json(res, 200, { ok: true, displays });
  }

  return _json(res, 404, { error: 'Not found', url: req.url, method: req.method });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Harness] e2e main-stub listening on http://127.0.0.1:${PORT} (comms=${COMMS_PORT})`);
});

process.on('SIGTERM', () => { _logStream.end(); process.exit(0); });
process.on('SIGINT', () => { _logStream.end(); process.exit(0); });
