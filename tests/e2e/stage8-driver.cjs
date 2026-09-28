#!/usr/bin/env node
/* stage8-driver.cjs — real-Electron verification driver.
 *
 * Drives the REAL app end-to-end: submits prompts through the renderer's
 * `prompt-queue:submit` IPC (same path the text box uses), approves plans via
 * `plan:approve`, answers questions via `prompt-queue:submit isAskUserAnswer`,
 * and cancels auth-gated externals once they reach awaiting-approval (we do
 * NOT really post tweets/emails — reaching the approval card is the check).
 *
 * Requires the app launched with CDP:
 *   yarn dev:renderer &
 *   electron src/main/main.js --remote-debugging-port=9222
 *
 * Usage: NODE_PATH=$(npm root -g) node stage8-driver.cjs prompts/stage8-real.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const COMMS = 'http://127.0.0.1:3015';
const CDP = 'http://127.0.0.1:9222';
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

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

function _req(method, urlPath, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: 3015, path: urlPath, method,
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// Quick-tier prompts (general_quick etc.) never mint a task — they're answered
// inside comms. Verify them via comms.log and pull the answer text with a
// direct /comms.process call (the IPC submit is fire-and-forget).
async function _commsQuickOutcome(promptText, t0) {
  const probe = String(promptText).slice(0, 60);
  let intent = null, responded = false;
  try {
    const lines = fs.readFileSync('/tmp/comms.log', 'utf8').split('\n');
    for (const line of lines) {
      const ts = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      if (!ts || new Date(ts[1]).getTime() < t0 - 3000) continue;
      if (!line.includes(probe)) continue;
      const m = line.match(/"intentName":"([^"]+)"/);
      if (m) intent = m[1];
      if (/\[(GeneralQuick|MemoryStore|MemoryRecall|ChatQuick|Refusal)\w*\] Response/.test(line)) responded = true;
    }
  } catch (_) {}
  let resultText = '';
  if (responded) {
    const r = await _req('POST', '/comms.process', { text: promptText, source: 'stage8-probe' }, 60000);
    const d = r.json?.data || r.json || {};
    resultText = d.text || d.fullText || d.response || d.message || '';
  }
  return { intent, responded, resultText };
}

function _checkExpect(entry, outcome) {
  const failures = [];
  const ex = entry.expect || {};
  if (ex.commsIntent && outcome.commsIntent !== ex.commsIntent) {
    failures.push(`commsIntent: expected "${ex.commsIntent}", got "${outcome.commsIntent}"`);
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
  if (ex.maxMs && outcome.totalMs > ex.maxMs) failures.push(`latency: ${outcome.totalMs}ms > budget ${ex.maxMs}ms`);
  return failures;
}

async function _getTask(taskId) {
  const r = await _req('GET', '/tasks');
  if (!r.json || !Array.isArray(r.json.tasks)) return null;
  return r.json.tasks.find(t => t.id === taskId) || null;
}

async function _findTask(promptText, t0) {
  const r = await _req('GET', '/tasks');
  if (!r.json || !Array.isArray(r.json.tasks)) return null;
  const probe = String(promptText).slice(0, 55); // journal stores truncated prompt
  const matches = r.json.tasks.filter(t => (t.prompt || '').startsWith(probe.slice(0, 40)) && (t.createdAt || 0) >= t0 - 5000);
  return matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

async function main() {
  const file = process.argv[2];
  const prompts = JSON.parse(fs.readFileSync(file, 'utf8'));

  const browser = await chromium.connectOverCDP(CDP);
  const ctxs = browser.contexts();
  let page = null;
  for (const c of ctxs) {
    for (const p of c.pages()) {
      try {
        const has = await p.evaluate(() => !!(window.electron && window.electron.ipcRenderer));
        if (has) { page = p; break; }
      } catch (_) {}
    }
    if (page) break;
  }
  if (!page) { console.error('no renderer page with window.electron found'); process.exit(2); }
  console.log(`CDP attached — driving via page: ${page.url()}`);

  const submit = (payload) => page.evaluate((pl) => window.electron.ipcRenderer.send('prompt-queue:submit', pl), payload);
  const approve = (taskId, planFile) => page.evaluate((a) => window.electron.ipcRenderer.send('plan:approve', a), { taskId, planFile });
  const cancel = (taskId) => page.evaluate((id) => window.electron.ipcRenderer.send('task:cancel', { taskId: id }), taskId);

  const stageName = path.basename(file, '.json');
  const results = [];

  for (const entry of prompts) {
    const t0 = Date.now();
    process.stdout.write(`  ${entry.id}  "${String(entry.prompt).slice(0, 60)}" `);
    const outcome = { id: entry.id, prompt: entry.prompt, status: 'dispatch-failed', totalMs: 0, resultText: '', failures: [], pass: false };
    const deadline = Date.now() + (entry.expect?.maxMs || 240000);

    await submit({ prompt: entry.prompt, sessionId: entry.session ? `${entry.session}_${process.pid}` : undefined });

    // wait for comms to mint the task
    let task = null;
    const taskWaitMs = entry.expect?.commsIntent ? 12000 : 30000;
    while (Date.now() - t0 < taskWaitMs && !task) {
      await sleep(1000);
      task = await _findTask(entry.prompt, t0);
    }
    if (task) outcome.taskId = task.id;

    // quick-tier prompts never create a task — verify via comms.log instead
    if (!task && entry.expect?.commsIntent) {
      const q = await _commsQuickOutcome(entry.prompt, t0);
      outcome.status = q.responded ? 'done' : 'dispatch-failed';
      outcome.commsIntent = q.intent;
      outcome.resultText = q.resultText;
      outcome.totalMs = Date.now() - t0;
      outcome.graphIntent = _graphIntentFor(entry.prompt, t0);
      outcome.failures = _checkExpect(entry, outcome);
      outcome.pass = outcome.failures.length === 0;
      results.push(outcome);
      console.log(`${outcome.pass ? '✅' : '❌'} status=${outcome.status} ${outcome.totalMs}ms comms=${outcome.commsIntent}`);
      outcome.failures.forEach(f => console.log(`        ${f}`));
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
          await cancel(task.id);
          outcome.resultText = task.result || '';
          break; // approval card reached — expectation met, cancel execution
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
    outcome.graphIntent = _graphIntentFor(entry.prompt, t0);
    outcome.failures = _checkExpect(entry, outcome);
    outcome.pass = outcome.failures.length === 0;
    results.push(outcome);

    console.log(`${outcome.pass ? '✅' : '❌'} status=${outcome.status} ${outcome.totalMs}ms`);
    outcome.failures.forEach(f => console.log(`        ${f}`));
    if (!outcome.pass) console.log(`        result: ${(outcome.resultText || '').slice(0, 140).replace(/\n/g, ' ⏎ ')}`);
  }

  const passN = results.filter(r => r.pass).length;
  const outFile = path.join(RESULTS_DIR, `${stageName}-real.json`);
  fs.writeFileSync(outFile, JSON.stringify({ file, at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${'─'.repeat(72)}\n  SUMMARY ${stageName}: ${passN}/${results.length} passed\n${'─'.repeat(72)}`);
  results.filter(r => !r.pass).forEach(r => console.log(`    ❌ ${r.id}: ${r.failures[0]}`));
  process.exit(results.length - passN ? 1 : 0);
}

main().catch(e => { console.error('driver failed:', e); process.exit(2); });
