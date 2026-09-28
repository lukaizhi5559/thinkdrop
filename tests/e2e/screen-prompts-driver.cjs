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
  if (ex.fileExists && !fs.existsSync(ex.fileExists)) {
    failures.push(`fileExists: ${ex.fileExists} not found`);
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

  const browser = await chromium.connectOverCDP(CDP);
  let page = null, ghost = null;
  for (const c of browser.contexts()) {
    for (const p of c.pages()) {
      if (p.url().includes('mode=ghostlayer')) { ghost = p; continue; }
      try {
        const has = await p.evaluate(() => !!(window.electron && window.electron.ipcRenderer));
        if (has && !page) page = p;
      } catch (_) {}
    }
  }
  if (!page) { console.error('no renderer page with window.electron found'); process.exit(2); }
  if (!ghost) { console.error('no ghostlayer page found'); process.exit(2); }
  console.log(`CDP attached — prompt page: ${page.url()}\n                ghostlayer: ${ghost.url()}`);

  const submit = (payload) => page.evaluate((pl) => window.electron.ipcRenderer.send('prompt-queue:submit', pl), payload);
  const approve = (taskId, planFile) => page.evaluate((a) => window.electron.ipcRenderer.send('plan:approve', a), { taskId, planFile });
  const cancel = (taskId) => page.evaluate((id) => window.electron.ipcRenderer.send('task:cancel', { taskId: id }), taskId);

  const stageName = path.basename(file, '.json');
  const results = [];

  for (const entry of prompts) {
    const t0 = Date.now();
    process.stdout.write(`  ${entry.id}  "${String(entry.prompt).slice(0, 58)}" `);
    const outcome = { id: entry.id, prompt: entry.prompt, status: 'dispatch-failed', totalMs: 0, resultText: '', failures: [], pass: false };
    const deadline = Date.now() + (entry.expect?.maxMs || 240000);

    await _clearScreen();
    await sleep(400);
    await submit({ prompt: entry.prompt, sessionId: `s9_${process.pid}` });

    let task = null;
    const taskWaitMs = 30000;
    while (Date.now() - t0 < taskWaitMs && !task) {
      await sleep(1000);
      task = await _findTask(entry.prompt, t0);
    }
    if (task) outcome.taskId = task.id;

    let approved = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      task = task ? await _getTask(task.id) : await _findTask(entry.prompt, t0);
      if (task) outcome.taskId = task.id;
      if (!task) continue;
      outcome.status = task.status;

      if (task.status === 'awaiting-approval' && !approved) {
        approved = true;
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
