#!/usr/bin/env node
/* screen-prompts-driver.cjs — prompt-driven GhostLayer E2E (Stage 9).
 *
 * The REAL pipeline end-to-end: submit a prompt through the renderer's
 * `prompt-queue:submit` IPC → comms classify → handoffRunner → stategraph
 * (decompose → fetch step → screen_display → /screen/display) → then assert
 * the rendered DOM inside the live ghostlayer window over CDP.
 *
 * Differs from stage8-driver (which verifies task status/result) by also
 * verifying WHAT LANDED ON SCREEN — canvas, webgl context, slide counters,
 * blocking scrims, text content.
 *
 * Requires the app running:  yarn dev  (+ --remote-debugging-port=9222)
 * Usage: NODE_PATH=$(npm root -g) node tests/e2e/screen-prompts-driver.cjs [prompts.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const COMMS = 'http://127.0.0.1:3015';
const OVERLAY = 'http://127.0.0.1:3010';
const CDP = 'http://127.0.0.1:9222';
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const INTENT_LOG_CANDIDATES = [
  path.join(__dirname, 'logs', 'intent-classifier.log'),
  path.join(__dirname, '..', '..', 'logs', 'intent-classifier.log'),
];
function intentLogPath() {
  let best = INTENT_LOG_CANDIDATES[0], m = -1;
  for (const p of INTENT_LOG_CANDIDATES) {
    try { const t = fs.statSync(p).mtimeMs; if (t > m) { best = p; m = t; } } catch (_) {}
  }
  return best;
}

function _req(port, method, urlPath, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch (_) { resolve({ status: res.statusCode, raw }); } });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}
const _getTasks = () => _req(3015, 'GET', '/tasks');
const _clearScreen = () => _req(3010, 'POST', '/screen/clear', {});

// Quick-tier prompts (general_quick etc.) never mint a task — they're answered
// inside comms. comms.log has structured lines but no single line carries both
// the prompt text and the outcome, so correlate: find `[Process] Start` with
// the prompt's textPreview, then the next `[Process] Complete` carries
// intentName + latencyMs. Text is verified via a /comms.process re-call only
// when the entry actually asserts on it.
async function _commsQuickOutcome(promptText, t0, needText) {
  const probe = String(promptText).slice(0, 60);
  let intent = null, responded = false, latencyMs = null;
  try {
    const lines = fs.readFileSync('/tmp/comms.log', 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ts = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      if (!ts || new Date(ts[1]).getTime() < t0 - 3000) continue;
      if (!/\[Process\] (Start|Translated)/.test(line) || !line.includes(probe)) continue;
      for (let j = i; j < Math.min(i + 40, lines.length); j++) {
        const m = lines[j].match(/\[Process\] Complete \{.*"intentName":"([^"]+)".*"latencyMs":(\d+)/);
        if (m) { intent = m[1]; latencyMs = Number(m[2]); responded = true; break; }
        const v = lines[j].match(/"intentName":"([^"]+)"/);
        if (v) intent = v[1];
      }
      break;
    }
  } catch (_) {}
  let resultText = '';
  if (responded && needText) {
    const r = await _req(3015, 'POST', '/comms.process', { text: promptText, source: 'intent-probe' }, 60000);
    const d = r.json?.data || r.json || {};
    resultText = d.text || d.fullText || d.response || d.message || '';
  }
  return { intent, responded, resultText, latencyMs };
}

function _matchOne(haystack, rule) {
  const hay = String(haystack ?? '');
  if (rule.startsWith('re:')) return new RegExp(rule.slice(3), 'is').test(hay);
  return hay.toLowerCase().includes(rule.toLowerCase());
}

function _graphIntentFor(promptText, t0) {
  try {
    const lines = fs.readFileSync(intentLogPath(), 'utf8').trim().split('\n');
    const probe = String(promptText || '').slice(0, 120).toLowerCase();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch (_) { continue; }
      if (!row.ts || new Date(row.ts).getTime() < t0 - 60000) break;
      const rowMsg = typeof row.message === 'string'
        ? row.message.split('\n[Additional context')[0].slice(0, 120).toLowerCase() : '';
      if (rowMsg === probe) {
        return { intent: row.intent, parser: row.parser, subIntents: (row.subPrompts || []).map(s => s.estimatedIntent) };
      }
    }
  } catch (_) {}
  return null;
}

// ── GhostLayer DOM probes (same vocabulary as screen-driver.cjs) ─────────────
const probes = {
  hasText: (needle) => document.body.innerText.toLowerCase().includes(String(needle).toLowerCase()),
  hasCanvas: () => !!document.querySelector('canvas'),
  webgl: () => [...document.querySelectorAll('canvas')].some(c => {
    try { return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (_) { return false; }
  }),
  counter: () => (document.body.innerText.match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1, 3).map(Number),
  scrollAnimating: () => [...document.querySelectorAll('div')].some(d => (d.getAnimations?.() || []).some(a => a.playState === 'running')),
  blockingOverlay: () => [...document.querySelectorAll('div')].some(d => {
    const s = getComputedStyle(d);
    return (s.position === 'fixed' || s.position === 'absolute') && s.pointerEvents === 'auto'
      && d.offsetWidth >= innerWidth * 0.9 && d.offsetHeight >= innerHeight * 0.9;
  }),
  stageEmpty: () => ![...document.querySelectorAll('div')].some(d => {
    const s = getComputedStyle(d);
    return s.position === 'fixed' && parseInt(s.zIndex) === 99997 && d.children.length > 0;
  }),
  navClick: (side) => {
    const zones = [...document.querySelectorAll('div')].filter(d =>
      getComputedStyle(d).pointerEvents === 'auto' && (d.textContent === '›' || d.textContent === '‹'));
    const z = zones.find(d => side === 'right' ? d.textContent === '›' : d.textContent === '‹');
    if (z) { z.click(); return true; }
    return false;
  },
  // image kind — a <img> that actually decoded (naturalWidth catches 404s)
  hasImg: () => [...document.querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0),
  imgCount: () => [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length,
  // scene kind — sandboxed iframe + postMessage render heartbeat recorded as
  // data-scene-status by SceneScreen (canvas inside the opaque iframe is not
  // reachable from page probes)
  sceneIframe: () => [...document.querySelectorAll('iframe')].some(f => (f.getAttribute('sandbox') || '').includes('allow-scripts')),
  sceneStatus: () => document.querySelector('[data-scene-status]')?.getAttribute('data-scene-status') || null,
};
async function probe(page, name, arg) {
  try { return await page.evaluate(`(${probes[name].toString()})(${JSON.stringify(arg ?? '')})`); }
  catch (_) { return null; }
}

async function _findTask(promptText, t0) {
  const r = await _getTasks();
  if (!r.json || !Array.isArray(r.json.tasks)) return null;
  const probe = String(promptText).slice(0, 55);
  const matches = r.json.tasks.filter(t => (t.prompt || '').startsWith(probe.slice(0, 40)) && (t.createdAt || 0) >= t0 - 5000);
  return matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}
async function _getTask(taskId) {
  const r = await _getTasks();
  if (!r.json || !Array.isArray(r.json.tasks)) return null;
  return r.json.tasks.find(t => t.id === taskId) || null;
}

function _checkExpect(entry, outcome) {
  const failures = [];
  const ex = entry.expect || {};
  if (ex.commsIntent && outcome.commsIntent !== ex.commsIntent) {
    failures.push(`commsIntent: expected "${ex.commsIntent}", got "${outcome.commsIntent}"`);
  }
  // commsIntentIn — ambiguous phrasings may legitimately route to either tier
  // (e.g. "is Vim better than Emacs" → action_veto → handoff is acceptable).
  if (ex.commsIntentIn && !ex.commsIntentIn.includes(outcome.commsIntent)) {
    failures.push(`commsIntent: expected one of [${ex.commsIntentIn.join('|')}], got "${outcome.commsIntent}"`);
  }
  if (ex.status) {
    const allowed = Array.isArray(ex.status) ? ex.status : [ex.status];
    if (!allowed.includes(outcome.status)) failures.push(`status: expected "${allowed.join('|')}", got "${outcome.status}"`);
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
  if (ex.mustContainAny && !ex.mustContainAny.some(m => _matchOne(text, m))) {
    failures.push(`mustContainAny: none of [${ex.mustContainAny.join(' | ')}] found in result (${text.length} chars)`);
  }
  // resultNotMatch — the task's final narrative must never contain these
  // (e.g. "wasn't able"/"[object Object]" apologies after a successful
  // display — the mario incident).
  for (const m of ex.resultNotMatch || []) {
    const re = m instanceof RegExp ? m : new RegExp(m, 'i');
    if (re.test(text)) failures.push(`resultNotMatch "${m}" found in result`);
  }
  for (const m of ex.mustNotContain || []) {
    if (_matchOne(text, m)) failures.push(`mustNotContain "${m}" present in result`);
  }
  if (ex.fileExists && !fs.existsSync(ex.fileExists)) {
    failures.push(`fileExists: ${ex.fileExists} not found`);
  }
  if (ex.hasItems && !(outcome.itemCount > 0)) {
    failures.push('expected task.items (WebResultCard feed) — got none');
  }
  if (ex.minItems && outcome.itemCount < ex.minItems) {
    failures.push(`expected ≥${ex.minItems} feed items, got ${outcome.itemCount}`);
  }
  if (ex.maxMs && outcome.totalMs > ex.maxMs) {
    failures.push(`latency: ${outcome.totalMs}ms > budget ${ex.maxMs}ms`);
  }
  return failures;
}

/** Positive probes retry — the first chart/three display lazy-loads a large
 *  bundle (antv ~10s, three ~5s) so a single probe right after 'done' races
 *  the paint. Poll up to 16s; negative asserts (screenEmpty) probe once. */
async function _probePoll(ghost, name, arg, budgetMs = 16000) {
  const t0 = Date.now();
  for (;;) {
    const v = await probe(ghost, name, arg);
    if (v) return v;
    if (Date.now() - t0 > budgetMs) return v;
    await sleep(1200);
  }
}

/** Post-task ghostlayer assertions — runs after status resolves. */
async function _checkScreen(entry, ghost) {
  const ex = entry.expect || {};
  const failures = [];
  if (ex.screenText && !(await _probePoll(ghost, 'hasText', ex.screenText)))
    failures.push(`screenText "${String(ex.screenText).slice(0, 40)}" not in ghostlayer DOM`);
  if (ex.screenCanvas && !(await _probePoll(ghost, 'hasCanvas')))
    failures.push('no <canvas> on screen');
  if (ex.screenWebgl && !(await _probePoll(ghost, 'webgl')))
    failures.push('no canvas with a live WebGL/WebGL2 context');
  if (ex.screenImg && !(await _probePoll(ghost, 'hasImg')))
    failures.push('no loaded <img> on screen');
  if (ex.screenImgs && (await probe(ghost, 'imgCount')) < ex.screenImgs)
    failures.push(`expected ≥${ex.screenImgs} loaded imgs, got ${await probe(ghost, 'imgCount')}`);
  if (ex.screenScene) {
    if (!(await _probePoll(ghost, 'sceneIframe'))) failures.push('no sandboxed scene iframe on screen');
    else {
      let st = null;
      for (let i = 0; i < 20 && st !== 'rendered'; i++) { await sleep(800); st = await probe(ghost, 'sceneStatus'); }
      if (st !== 'rendered') failures.push(`scene never reported rendered (status=${st})`);
    }
  }
  if (ex.screenBlocking && !(await probe(ghost, 'blockingOverlay')))
    failures.push('no blocking overlay on screen');
  if (ex.screenCounter) {
    const c = await _probePoll(ghost, 'counter');
    if (!c || !c[1]) failures.push(`no slide counter on screen (got ${JSON.stringify(c)})`);
  }
  if (ex.screenShown) {
    const t0 = Date.now();
    while ((await probe(ghost, 'stageEmpty')) && Date.now() - t0 < 16000) await sleep(1200);
    if (await probe(ghost, 'stageEmpty')) failures.push('expected content on screen — stage is empty');
  }
  if (ex.navRight) {
    if (!(await _probePoll(ghost, 'navClick', 'right'))) failures.push('no right nav zone to click');
    else {
      await sleep(700);
      if (!(await probe(ghost, 'hasText', ex.navRight))) failures.push(`nav click did not reach "${ex.navRight}"`);
    }
  }
  if (ex.screenEmpty && !(await probe(ghost, 'stageEmpty')))
    failures.push('expected empty stage — content is on screen');
  return failures;
}

async function main() {
  const file = process.argv[2] || path.join(__dirname, 'prompts', 'stage9-screen.json');
  const prompts = JSON.parse(fs.readFileSync(file, 'utf8'));

  let browser = await chromium.connectOverCDP(CDP);
  let page = null, ghost = null;
  // Page handles go stale when a window reloads (vite HMR, guarded navigation).
  // Re-scan CDP targets instead of dying mid-corpus; if the session's target
  // tracking went stale entirely, reconnect over CDP.
  async function rediscover() {
    for (let attempt = 0; attempt < 2; attempt++) {
      page = null;
      for (const c of browser.contexts()) {
        for (const p of c.pages()) {
          try {
            if (p.isClosed()) continue;
            if (p.url().includes('mode=ghostlayer')) { ghost = p; continue; }
            const has = await p.evaluate(() => !!(window.electron && window.electron.ipcRenderer));
            if (has) page = p;
          } catch (_) {}
        }
      }
      if (page) return true;
      try { browser = await chromium.connectOverCDP(CDP); } catch (_) {}
      await sleep(1000);
    }
    return false;
  }
  await rediscover();
  if (!page) { console.error('no renderer page with window.electron found'); process.exit(2); }
  if (!ghost) { console.error('no ghostlayer page found'); process.exit(2); }
  console.log(`CDP attached — prompt page: ${page.url()}\n                ghostlayer: ${ghost.url()}`);

  // ipcRenderer.send is fire-and-forget: if evaluate throws mid-send the prompt
  // may still have reached comms — resubmitting would double-process it (seen:
  // "good morning" answered by general_quick AND minted a handoff task).
  function _commsSawPrompt(promptText, t0) {
    const probe = String(promptText).slice(0, 60);
    try {
      for (const line of fs.readFileSync('/tmp/comms.log', 'utf8').split('\n')) {
        const ts = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
        if (ts && new Date(ts[1]).getTime() >= t0 - 3000
            && /\[Process\] (Start|Translated)/.test(line) && line.includes(probe)) return true;
      }
    } catch (_) {}
    return false;
  }
  const evalOnPage = async (fn, arg) => {
    try { return await page.evaluate(fn, arg); }
    catch (_) {
      await sleep(1000);
      if (!(await rediscover())) throw new Error('renderer page lost and not recoverable');
      return await page.evaluate(fn, arg);
    }
  };
  const submit = async (payload) => {
    const t0 = Date.now();
    try { await page.evaluate((pl) => window.electron.ipcRenderer.send('prompt-queue:submit', pl), payload); }
    catch (e) {
      await sleep(800);
      if (_commsSawPrompt(payload.prompt, t0)) return; // send succeeded; evaluate died on the wrapper
      await sleep(1000);
      if (!(await rediscover())) throw new Error('renderer page lost and not recoverable');
      await page.evaluate((pl) => window.electron.ipcRenderer.send('prompt-queue:submit', pl), payload);
    }
  };
  const approve = (taskId, planFile) => evalOnPage((a) => window.electron.ipcRenderer.send('plan:approve', a), { taskId, planFile });
  const cancel = (taskId) => evalOnPage((id) => window.electron.ipcRenderer.send('task:cancel', { taskId: id }), taskId);

  const stageName = path.basename(file, '.json');
  const results = [];

  for (const entry of prompts) {
    const t0 = Date.now();
    process.stdout.write(`  ${entry.id}  "${String(entry.prompt).slice(0, 58)}" `);
    const outcome = { id: entry.id, prompt: entry.prompt, status: 'dispatch-failed', totalMs: 0, resultText: '', failures: [], pass: false };
    const deadline = Date.now() + (entry.expect?.maxMs || 240000);

    await _clearScreen();
    await sleep(400);
    await submit({ prompt: entry.prompt, sessionId: entry.sessionId || entry.session || `s9_${process.pid}` });

    let task = null;
    // Quick-tier prompts never mint a task — 12s is enough to detect that;
    // handoffs need up to 30s for the comms task to appear.
    const taskWaitMs = entry.expect?.commsIntent ? 12000 : 30000;
    while (Date.now() - t0 < taskWaitMs && !task) {
      await sleep(1000);
      task = await _findTask(entry.prompt, t0);
    }
    if (task) outcome.taskId = task.id;
    // A minted task proves comms handed off — commsIntent checks should see
    // 'handoff' rather than undefined on this path.
    if (task) outcome.commsIntent = 'handoff';

    // Quick-tier fallback — verify comms intent + answer via comms.log /
    // /comms.process instead of the task journal.
    const _wantsComms = entry.expect?.commsIntent || entry.expect?.commsIntentIn;
    if (!task && _wantsComms) {
      const needText = !!(entry.expect.mustContain?.length || entry.expect.mustContainAny?.length || entry.expect.mustNotContain?.length);
      let q = { intent: null, responded: false, resultText: '', latencyMs: null };
      // Poll comms.log — classify+answer can lag the 12s task-wait window.
      for (let i = 0; i < 10 && !q.responded; i++) {
        q = await _commsQuickOutcome(entry.prompt, t0, false);
        if (!q.responded) await sleep(3000);
      }
      if (q.responded && needText) {
        const qt = await _commsQuickOutcome(entry.prompt, t0, true);
        q.resultText = qt.resultText;
      }
      outcome.status = q.responded ? 'done' : 'dispatch-failed';
      outcome.commsIntent = q.intent;
      outcome.resultText = q.resultText;
      // Gate on the pipeline's own latencyMs — wall-clock includes our 12s
      // task-mint polling window and measures nothing about comms speed.
      outcome.wallMs = Date.now() - t0;
      outcome.totalMs = q.latencyMs ?? outcome.wallMs;
      outcome.graphIntent = _graphIntentFor(entry.prompt, t0);
      outcome.failures = _checkExpect(entry, outcome);
      outcome.pass = outcome.failures.length === 0;
      results.push(outcome);
      console.log(`${outcome.pass ? '✅' : '❌'} status=${outcome.status} ${outcome.totalMs}ms comms=${outcome.commsIntent}`);
      outcome.failures.forEach(f => console.log(`        ${f}`));
      if (!outcome.pass) console.log(`        result: ${(outcome.resultText || '').slice(0, 120).replace(/\n/g, ' ⏎ ')}`);
      continue;
    }

    let approved = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      task = task ? await _getTask(task.id) : await _findTask(entry.prompt, t0);
      if (task) outcome.taskId = task.id;
      if (!task) continue;
      outcome.status = task.status;

      if (task.status === 'awaiting-approval' && !approved) {
        approved = true;
        if (entry.approve === false) {
          // Canary check — reaching plan approval IS the expectation. Cancel
          // before execution so risky intents (messaging, purchases) never run.
          await cancel(task.id);
          outcome.resultText = task.result || '';
          break;
        }
        await approve(task.id, task.planFile);
        continue;
      }
      if (task.status === 'waiting-for-input' && entry.answers?.length) {
        const q = (task.question || '').toLowerCase();
        const ans = entry.answers.find(a => new RegExp(a.match, 'i').test(q)) || entry.answers[0];
        await submit({ prompt: ans.answer ?? ans, isAskUserAnswer: true, taskId: task.id });
        continue;
      }
      if (task.status === 'auth-required') { await cancel(task.id); break; }
      if (['done', 'failed', 'cancelled'].includes(task.status)) break;
    }
    outcome.totalMs = Date.now() - t0;
    outcome.status = task?.status || outcome.status;
    outcome.resultText = task?.result || '';
    outcome.itemCount = Array.isArray(task?.items) ? task.items.length : 0;
    outcome.graphIntent = _graphIntentFor(entry.prompt, t0);
    outcome.failures = _checkExpect(entry, outcome);

    // screen assertions — let the display settle, then probe ghostlayer
    await sleep(2500);
    const screenFailures = await _checkScreen(entry, ghost);
    outcome.failures.push(...screenFailures);

    outcome.pass = outcome.failures.length === 0;
    results.push(outcome);
    console.log(`${outcome.pass ? '✅' : '❌'} status=${outcome.status} ${outcome.totalMs}ms`);
    outcome.failures.forEach(f => console.log(`        ${f}`));
    if (!outcome.pass) console.log(`        result: ${(outcome.resultText || '').slice(0, 120).replace(/\n/g, ' ⏎ ')}`);

    await _clearScreen();
    await sleep(800);
  }

  const passN = results.filter(r => r.pass).length;
  const outFile = path.join(RESULTS_DIR, `${stageName}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ file, at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${'─'.repeat(72)}\n  SUMMARY ${stageName}: ${passN}/${results.length} passed\n${'─'.repeat(72)}`);
  results.filter(r => !r.pass).forEach(r => console.log(`    ❌ ${r.id}: ${r.failures[0]}`));
  process.exit(results.length - passN ? 1 : 0);
}

main().catch(e => { console.error('driver failed:', e); process.exit(2); });
