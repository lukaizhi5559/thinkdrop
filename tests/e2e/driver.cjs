'use strict';
/**
 * driver.cjs — e2e prompt driver
 *
 * Pushes prompts through the production ingress (comms-graph :3015
 * /comms.process) against the headless main-stub (:3010). For handoff tasks
 * it polls the comms-graph journal (GET /tasks) to terminal status, driving
 * plan approvals / ask_user answers / auth resumes through the stub.
 *
 * Usage:
 *   node tests/e2e/driver.cjs tests/e2e/prompts/stage1-comms.json [options]
 *     --runs N            run the file N times (flake detection; default 1)
 *     --timeout ms        default per-prompt timeout (default 240000)
 *     --only id1,id2      run only these prompt ids
 *     --session NAME      override all sessionIds with NAME (still unique per run)
 *     --stop-on-fail      halt the file on first failure
 *     --verbose           print per-prompt detail as it happens
 *
 * Prompt file format (JSON array):
 *   { "id": "gq-hello", "prompt": "hey",
 *     "sessionId": "e2e_s1",            // shared within a multi-turn sequence
 *     "thoughtContext": {…},            // attached proactive card (optional)
 *     "answers": ["…", {match, answer}],// staged scripted answers (clarify/ask_user)
 *     "approve": true|false,            // default true — resume() at the plan gate
 *     "authMode": "proceed"|"none",     // default "proceed" — bypass unauthed agents
 *     "timeoutMs": 240000,
 *     "expect": {
 *       "commsIntent": "handoff"|"general_quick"|"memory_quick"|"status_check"|"control_signal"|"memory_store",
 *       "status": "done"|"awaiting-approval"|"waiting-for-input"|"failed"|"cancelled",
 *       "graphIntent": "web_search" …,  // last intent-classifier.log entry for this text
 *       "mustContain": ["substr"|"re:regex"],       // on task.result / data.text
 *       "mustNotContain": [ … ],
 *       "screenKind": "effect",         // last /screen/display payload kind
 *       "screenMustContain": ["…"],     // on last display payload JSON
 *       "maxMs": 15000
 *     } }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const COMMS = 'http://127.0.0.1:3015';
const STUB = 'http://127.0.0.1:3010';
// The stategraph writes the intent log under process.cwd()/logs/ — which dir
// that is depends on how the stub was launched (repo root vs tests/e2e).
// Probe both candidates each read; newest file wins. INTENT_LOG_PATH overrides.
const _INTENT_LOG_CANDIDATES = process.env.INTENT_LOG_PATH
  ? [process.env.INTENT_LOG_PATH]
  : [path.join(__dirname, 'logs', 'intent-classifier.log'),
     path.join(__dirname, '..', '..', 'logs', 'intent-classifier.log')];
function _intentLogPath() {
  let best = _INTENT_LOG_CANDIDATES[0], bestM = -1;
  for (const p of _INTENT_LOG_CANDIDATES) {
    try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { best = p; bestM = m; } } catch (_) {}
  }
  return best;
}
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── tiny http helpers ─────────────────────────────────────────────────────────
function _req(method, base, urlPath, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const u = new URL(base + urlPath);
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch (_) { resolve({ status: res.statusCode, raw }); } });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: `timeout ${timeoutMs}ms` }); });
    if (payload) req.write(payload);
    req.end();
  });
}
const _post = (base, p, b, t) => _req('POST', base, p, b, t);
const _get = (base, p, t) => _req('GET', base, p, null, t || 10000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── journal polling ───────────────────────────────────────────────────────────
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const INTERACTIVE = new Set(['awaiting-approval', 'waiting-for-input', 'auth-required']);

async function _getTask(taskId) {
  const r = await _get(COMMS, '/tasks');
  if (!r.json || !Array.isArray(r.json.tasks)) return null;
  return r.json.tasks.find(t => t.id === taskId) || null;
}

// Find the intent-classifier.log entry for a prompt text (newest match ≥ t0).
// Comparison is case-insensitive — comms-graph's translate step normalizes
// casing even for en→en input ("search" → "Search").
function _graphIntentFor(promptText, t0) {
  try {
    const lines = fs.readFileSync(_intentLogPath(), 'utf8').trim().split('\n');
    const probe = String(promptText || '').slice(0, 120).toLowerCase();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch (_) { continue; }
      if (!row.ts || new Date(row.ts).getTime() < t0 - 60000) break; // only recent
      // The logged message may carry an appended "[Additional context: …]"
      // block (follow-up hints) — compare on the user-text prefix only.
      const rowMsg = typeof row.message === 'string'
        ? row.message.split('\n[Additional context')[0].slice(0, 120).toLowerCase()
        : '';
      if (rowMsg && rowMsg === probe) {
        return { intent: row.intent, parser: row.parser, subPrompts: row.subPrompts?.length, subIntents: (row.subPrompts || []).map(s => s.estimatedIntent) };
      }
    }
  } catch (_) {}
  return null;
}

function _matchOne(haystack, rule) {
  const hay = String(haystack ?? '');
  if (rule.startsWith('re:')) return new RegExp(rule.slice(3), 'is').test(hay);
  return hay.toLowerCase().includes(rule.toLowerCase());
}

function _checkExpect(entry, outcome) {
  const failures = [];
  const ex = entry.expect || {};
  if (ex.commsIntent && outcome.commsIntent !== ex.commsIntent) {
    failures.push(`commsIntent: expected "${ex.commsIntent}", got "${outcome.commsIntent}"`);
  }
  if (ex.status) {
    const allowed = Array.isArray(ex.status) ? ex.status : [ex.status];
    if (!allowed.includes(outcome.status)) {
      failures.push(`status: expected "${allowed.join('|')}", got "${outcome.status}"`);
    }
  }
  if (ex.graphIntent) {
    const got = outcome.graphIntent?.intent;
    const subs = outcome.graphIntent?.subIntents || [];
    const allowed = Array.isArray(ex.graphIntent) ? ex.graphIntent : [ex.graphIntent];
    if (!allowed.includes(got) && !subs.some(s => allowed.includes(s))) {
      failures.push(`graphIntent: expected "${allowed.join('|')}", got "${got}" (subs: ${subs.join(',') || 'none'})`);
    }
  }
  const text = outcome.resultText || '';
  for (const m of ex.mustContain || []) {
    if (!_matchOne(text, m)) failures.push(`mustContain "${m}" not found in result (${text.length} chars)`);
  }
  for (const m of ex.mustNotContain || []) {
    if (_matchOne(text, m)) failures.push(`mustNotContain "${m}" present in result`);
  }
  if (ex.screenKind) {
    const lastShow = [...outcome.screens].reverse().find(s => !s.cleared);
    if (!lastShow) failures.push('screenKind: no /screen/display recorded');
    else if (lastShow.kind !== ex.screenKind) failures.push(`screenKind: expected "${ex.screenKind}", got "${lastShow.kind}"`);
  }
  for (const m of ex.screenMustContain || []) {
    const lastShow = [...outcome.screens].reverse().find(s => !s.cleared);
    if (!lastShow) { failures.push('screenMustContain: no /screen/display recorded'); break; }
    if (!_matchOne(JSON.stringify(lastShow), m)) failures.push(`screenMustContain "${m}" missing in display payload`);
  }
  if (ex.maxMs && outcome.totalMs > ex.maxMs) {
    failures.push(`latency: ${outcome.totalMs}ms > budget ${ex.maxMs}ms`);
  }
  // Universal hygiene checks — always on
  // Match the full error-answer shape ("[Error generating answer: … Intent: x]")
  // rather than a bare substring — screen_intelligence answers legitimately
  // quote these strings when the plan doc showing them is on-screen.
  if (/\[Error generating answer: [^\]]*Intent:/i.test(text)) {
    failures.push('error answer marker "[Error generating answer: … Intent:]" present in result');
  }
  // Raw JS-crash text only ever surfaces as the whole answer — a long
  // OCR/summary answer containing the words is quoted content, not a crash.
  for (const bad of ['Assignment to constant variable', 'undefined is not']) {
    if (text.includes(bad) && text.length < 300) {
      failures.push(`error marker "${bad}" present in result`);
    }
  }
  if (outcome.status === 'done' && !text.trim()) failures.push('done but empty result');
  return failures;
}

async function runPrompt(entry, opts) {
  const t0 = Date.now();
  const outcome = {
    id: entry.id, prompt: entry.prompt, at: new Date(t0).toISOString(),
    commsIntent: null, commsLatencyMs: null, taskId: null, status: null,
    resultText: '', graphIntent: null, screens: [], events: 0,
    approvals: 0, questions: 0, authResumes: 0, totalMs: 0, error: null,
  };

  // Stage scripted answers for the next task (consumed by the stub on handoff)
  if (Array.isArray(entry.answers) && entry.answers.length) {
    await _post(STUB, '/harness/next-answers', { answers: entry.answers });
    await _post(STUB, '/harness/answers-global', { answers: entry.answers.map(a => typeof a === 'string' ? a : a) });
  }

  const screensBefore = (await _get(STUB, '/harness/screens')).json?.screens?.length || 0;
  const eventsBefore = (await _get(STUB, '/harness/events')).json?.total || 0;

  const proc = await _post(COMMS, '/comms.process', {
    text: entry.prompt,
    source: entry.source || 'text',
    language: entry.language || 'auto',
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.thoughtContext ? { thoughtContext: entry.thoughtContext } : {}),
    ...(entry.speakerProfile ? { speakerProfile: entry.speakerProfile } : {}),
  }, Math.min(entry.timeoutMs || 240000, 90000));

  if (proc.status !== 200 || !proc.json?.ok) {
    outcome.status = 'comms-error';
    outcome.error = `comms.process HTTP ${proc.status}: ${proc.error || JSON.stringify(proc.json || proc.raw || '').slice(0, 200)}`;
    outcome.totalMs = Date.now() - t0;
    return outcome;
  }
  const data = proc.json.data || {};
  outcome.commsIntent = data.intentName;
  outcome.commsLatencyMs = data.metadata?.latencyMs ?? null;
  outcome.taskId = data.metadata?.taskId || null;
  outcome.status = outcome.taskId ? 'dispatched' : 'done';
  outcome.resultText = data.fullText || data.text || '';

  // Quick intents complete synchronously — no task to poll.
  if (!outcome.taskId) {
    outcome.totalMs = Date.now() - t0;
    outcome.graphIntent = _graphIntentFor(entry.prompt, t0);
    return outcome;
  }

  // ── Handoff: poll journal until terminal / interactive state ──────────────
  const deadline = t0 + (entry.timeoutMs || 240000);
  const approve = entry.approve !== false;
  const authMode = entry.authMode || 'proceed';
  const scriptedAnswers = Array.isArray(entry.answers) ? [...entry.answers] : [];
  const handledAt = { approval: 0, question: 0, auth: 0 }; // cooldowns — don't re-fire while journal lags

  while (Date.now() < deadline) {
    await sleep(1500);
    const task = await _getTask(outcome.taskId);
    if (!task) continue;
    outcome.status = task.status;

    if (TERMINAL.has(task.status)) {
      outcome.resultText = task.result || '';
      outcome.trace = Array.isArray(task.trace) ? task.trace : null;
      break;
    }
    if (task.status === 'awaiting-approval') {
      if (!approve) break;
      if (Date.now() - handledAt.approval < 4000) continue;
      handledAt.approval = Date.now();
      outcome.approvals++;
      if (opts.verbose) console.log(`      → auto-approving plan for ${outcome.taskId}`);
      await _post(STUB, '/harness/approve', { taskId: outcome.taskId });
      continue;
    }
    if (task.status === 'waiting-for-input') {
      if (Date.now() - handledAt.question < 4000 || outcome.questions >= 8) continue;
      handledAt.question = Date.now();
      outcome.questions++;
      // Scripted entries are {match,answer} objects (consumed by matcher rules
      // at handoff time); for a pending question we just need the answer text.
      const _rawAns = scriptedAnswers.length ? scriptedAnswers.shift() : 'yes';
      const ans = (_rawAns && typeof _rawAns === 'object') ? (_rawAns.answer ?? 'yes') : _rawAns;
      if (opts.verbose) console.log(`      → answering pending question for ${outcome.taskId}: "${ans}"`);
      await _post(STUB, '/harness/question', { taskId: outcome.taskId, answer: ans });
      continue;
    }
    if (task.status === 'auth-required') {
      if (authMode === 'none') break;
      if (outcome.authResumes >= 4) break; // resume failed to bypass — don't loop to deadline
      // A successful resume re-runs the whole graph (~30-60s) before the
      // journal status flips — long cooldown so we don't exhaust the resume
      // budget while a good resume is still in flight.
      if (Date.now() - handledAt.auth < 45000) continue;
      handledAt.auth = Date.now();
      outcome.authResumes++;
      if (opts.verbose) console.log(`      → auth resume (proceed) for ${outcome.taskId}`);
      await _post(STUB, '/harness/auth', { taskId: outcome.taskId, mode: 'proceed' });
      continue;
    }
  }

  if (!TERMINAL.has(outcome.status) && outcome.status !== 'awaiting-approval' && !INTERACTIVE.has(outcome.status)) {
    // fall-through: still running at deadline
  }
  if (Date.now() >= deadline && !TERMINAL.has(outcome.status)) {
    // Grace check — under heavy load our own poll timers can be starved past
    // the deadline while the task already reached a terminal state. Timeout
    // means "the task didn't finish in time", not "we didn't notice in time".
    const last = await _getTask(outcome.taskId);
    if (last && TERMINAL.has(last.status)) {
      outcome.status = last.status;
      outcome.resultText = last.result || '';
      outcome.trace = Array.isArray(last.trace) ? last.trace : null;
    } else {
      if (last) outcome.status = last.status;
      outcome.status = outcome.status === 'dispatched' ? 'timeout' : outcome.status + '+timeout';
      outcome.error = `timed out after ${entry.timeoutMs || 240000}ms (last status: ${outcome.status})`;
      await _post(STUB, '/comms.signal', { signalType: 'cancel', taskId: outcome.taskId });
    }
  }

  const scr = await _get(STUB, '/harness/screens');
  outcome.screens = (scr.json?.screens || []).slice(screensBefore);
  const ev = await _get(STUB, `/harness/events?since=${eventsBefore}`);
  outcome.events = ev.json?.total ?? 0;
  outcome.graphIntent = _graphIntentFor(entry.prompt, t0);
  outcome.totalMs = Date.now() - t0;
  return outcome;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file) { console.error('usage: driver.cjs <prompts.json> [--runs N] [--timeout ms] [--only ids] [--session NAME] [--stop-on-fail] [--verbose]'); process.exit(2); }
  const flag = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
  const has = (name) => argv.includes('--' + name);
  const runs = parseInt(flag('runs', '1'), 10);
  const defaultTimeout = parseInt(flag('timeout', '240000'), 10);
  const only = flag('only', null) ? flag('only').split(',') : null;
  const sessionOverride = flag('session', null);
  const stopOnFail = has('stop-on-fail');
  const verbose = has('verbose');

  const prompts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stageName = path.basename(file).replace(/\.json$/, '');

  // Sanity: stub + comms must both be up
  const h1 = await _get(STUB, '/health', 3000);
  const h2 = await _get(COMMS, '/health', 3000);
  if (!h1.json?.ok) { console.error('✖ main-stub not reachable on :3010 — start: node tests/e2e/main-stub.cjs'); process.exit(2); }
  if (!h2.json?.ok) { console.error('✖ comms-graph not reachable on :3015 — start services: yarn start:services'); process.exit(2); }

  const allRuns = [];
  for (let run = 0; run < runs; run++) {
    const runTag = `${stageName}-run${run + 1}`;
    const results = [];
    const sessionSuffix = runs > 1 ? `_r${run + 1}` : '';
    console.log(`\n${'═'.repeat(72)}\n  ${stageName} — run ${run + 1}/${runs} (${prompts.length} prompts)\n${'═'.repeat(72)}`);

    // Drop stale comms tasks — a persisted 'queued' entry replays via the
    // agent-lock release path when a same-agent task completes, double-running
    // prompts and polluting the intent log between runs.
    await _post(COMMS, '/tasks/reset', {}, 5000).catch(() => {});

    for (const entry of prompts) {
      if (only && !only.includes(entry.id)) continue;
      const e = { ...entry };
      e.timeoutMs = e.timeoutMs || defaultTimeout;
      if (sessionOverride) e.sessionId = `${sessionOverride}${sessionSuffix}`;
      else if (e.sessionId) e.sessionId = `${e.sessionId}${sessionSuffix}`;
      if (e.sessionId) e.sessionId = `${e.sessionId}_${process.pid}`;

      const t = Date.now();
      process.stdout.write(`  ${e.id}  "${String(e.prompt).slice(0, 60)}${e.prompt.length > 60 ? '…' : ''}" `);
      const outcome = await runPrompt(e, { verbose });
      const failures = _checkExpect(e, outcome);
      outcome.failures = failures;
      outcome.pass = failures.length === 0;
      results.push(outcome);

      const mark = outcome.pass ? '✅' : '❌';
      const meta = `intent=${outcome.commsIntent || '?'}→${outcome.graphIntent?.intent || '-'} status=${outcome.status} ${outcome.totalMs}ms`;
      console.log(`${mark} ${meta}`);
      if (!outcome.pass || verbose) {
        failures.forEach(f => console.log(`        ${f}`));
        if (outcome.error) console.log(`        error: ${outcome.error}`);
        if (verbose || !outcome.pass) {
          const prev = (outcome.resultText || '').slice(0, 140).replace(/\n/g, ' ⏎ ');
          console.log(`        result: ${prev}${(outcome.resultText || '').length > 140 ? '…' : ''}`);
        }
      }
      if (!outcome.pass && stopOnFail) { console.log('\n  ⏹ stop-on-fail'); break; }
    }

    const passN = results.filter(r => r.pass).length;
    console.log(`\n  ${stageName} run ${run + 1}: ${passN}/${results.length} passed`);
    allRuns.push({ run: run + 1, results });
    const outFile = path.join(RESULTS_DIR, `${runTag}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ file, run: run + 1, at: new Date().toISOString(), results }, null, 2));
    console.log(`  results → ${outFile}`);
  }

  // Summary across runs
  const last = allRuns[allRuns.length - 1].results;
  const failed = last.filter(r => !r.pass);
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  SUMMARY ${stageName}: ${last.length - failed.length}/${last.length} passed (latest run)`);
  if (failed.length) failed.forEach(r => console.log(`    ❌ ${r.id}: ${r.failures[0] || r.error || 'failed'}`));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('driver failed:', e); process.exit(2); });
