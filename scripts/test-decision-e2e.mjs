#!/usr/bin/env node
/**
 * test-decision-e2e.mjs — Phase 4 (P4-4): 20-prompt routing/decision suite.
 *
 * Injects prompts through comms-graph (the real entry path), then correlates
 * each prompt's window of log lines across comms-graph.log / main.log /
 * command.log to report: classified lane, targetService, session used,
 * shadow agreement, local latency, and the tab-hijack regressions (F2/F5/F6).
 *
 * Usage:
 *   node scripts/test-decision-e2e.mjs [--browser-only] [--no-browser] [--fast]
 *
 * Requires: comms-graph (:3015) + backend (:4000) running. Browser prompts
 * additionally need the Chrome extension connected — run the app first.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const COMMS = process.env.COMMS_URL || 'http://127.0.0.1:3015';
const LOGS = {
  comms: join(ROOT, 'logs/comms-graph.log'),
  main: join(ROOT, 'logs/main.log'),
  command: join(ROOT, 'logs/command.log'),
};

// ── Prompt suite ─────────────────────────────────────────────────────────────
// kind: 'pure' (no browser needed) | 'browser' (extension required)
// expect: assertions we check in logs (loose — report, don't hard-fail)
const PROMPTS = [
  // pure query lane (no browser work expected)
  { id: 'q1', text: "what's 2+2", kind: 'pure', expect: { taskType: 'query' } },
  { id: 'q2', text: 'who wrote the book dune', kind: 'pure', expect: { taskType: 'query' } },
  { id: 'q3', text: 'what is the capital of japan', kind: 'pure', expect: { taskType: 'query' } },
  // conversation recall — must NOT become follow-up
  { id: 'r1', text: 'what did I just ask you', kind: 'pure', expect: { recall: true } },
  { id: 'r2', text: 'summarize our conversation so far', kind: 'pure', expect: { recall: true } },
  // system/shell lane
  { id: 's1', text: 'how much disk space do I have left', kind: 'pure', expect: {} },
  { id: 's2', text: 'list the files in my downloads folder', kind: 'pure', expect: {} },
  // named-service nav — F2 hijack regressions
  { id: 'n1', text: 'go to youtube', kind: 'browser', expect: { service: 'youtube' } },
  { id: 'n2', text: 'check my gmail', kind: 'browser', expect: { service: 'gmail', session: 'gmail' } },
  { id: 'n3', text: 'open chatgpt', kind: 'browser', expect: { service: 'chatgpt', session: 'chatgpt' } },
  { id: 'n4', text: 'check my gmail', kind: 'browser', expect: { service: 'gmail', session: 'gmail' }, note: 'retry — lint rewrite fired twice before' },
  // service switch — bound gmail must survive, amazon opens its own
  { id: 'n5', text: 'now go to amazon', kind: 'browser', expect: { service: 'amazon', session: 'amazon' } },
  // in-page follow-ups on the bound service page — F5 bound-page-missing
  { id: 'f1', text: 'search for baby mittens', kind: 'browser', expect: { session: 'amazon' } },
  { id: 'f2', text: 'click the first result', kind: 'browser', expect: { session: 'amazon' } },
  { id: 'f3', text: 'scroll down', kind: 'browser', expect: { session: 'amazon' } },
  // interactive browser (generative inner loop → local decisions)
  { id: 'b1', text: 'go to chatgpt and type how are you doing in the message box', kind: 'browser', expect: { service: 'chatgpt' } },
  // back to gmail — different service while chatgpt bound
  { id: 'n6', text: 'check my gmail again', kind: 'browser', expect: { service: 'gmail', session: 'gmail' } },
  // memory/activity lane
  { id: 'm1', text: 'what have I been working on today', kind: 'pure', expect: {} },
  // screen observation lane
  { id: 'sc1', text: 'what is on my screen right now', kind: 'pure', expect: {} },
  // ambiguous follow-up safety — remote referent path
  { id: 'fu1', text: 'tell me more about it', kind: 'pure', expect: { followUp: true } },
];

const args = process.argv.slice(2);
const browserOnly = args.includes('--browser-only');
const noBrowser = args.includes('--no-browser');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fileLen(p) { try { return statSync(p).size; } catch { return 0; } }
function tailSince(p, offset) {
  try { return readFileSync(p, 'utf8').slice(offset); } catch { return ''; }
}

async function send(text) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${COMMS}/comms.process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: 'text' }),
    });
    const body = await res.json().catch(() => null);
    const taskId = body?.data?.taskId || body?.data?.metadata?.taskId || body?.data?.task?.id || null;
    return { ok: res.ok && body?.ok !== false, ms: Date.now() - t0, body, taskId };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

// Poll the task journal until our task reaches a terminal state, so each
// prompt's log window closes only after its work actually finished (browser
// tasks run 30–90s; a fixed sleep closed windows before sessions persisted).
async function taskStatus(taskId) {
  try {
    const res = await fetch(`${COMMS}/tasks`);
    const list = await res.json().catch(() => null);
    const tasks = Array.isArray(list) ? list : (list?.tasks || list?.data || []);
    return tasks.find(t => t.id === taskId) || null;
  } catch { return null; }
}

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'error', 'completed']);
async function waitForTask(taskId, capMs, promptText) {
  // Some lanes (general_quick, recall) don't hand off — no task exists. For
  // those, match the newest task by prompt text so queued-then-run tasks are
  // still tracked; pure no-task lanes return 'no-task' quickly.
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < capMs) {
    const task = taskId ? await taskStatus(taskId) : null;
    const t = task || (promptText ? await (async () => {
      try {
        const res = await fetch(`${COMMS}/tasks`);
        const list = await res.json().catch(() => null);
        const tasks = Array.isArray(list) ? list : (list?.tasks || list?.data || []);
        return tasks.filter(x => (x.prompt || '').trim().toLowerCase() === promptText.trim().toLowerCase())
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
      } catch { return null; }
    })() : null);
    last = t;
    if (!t) {
      // no task after 8s → this lane never hands off; done waiting
      if (Date.now() - t0 > 8000) return { status: 'no-task', waited: Date.now() - t0 };
      await sleep(1500); continue;
    }
    if (TERMINAL.has(String(t.status))) return { status: String(t.status), waited: Date.now() - t0, task: t };
    await sleep(2000);
  }
  return { status: last?.status ? `stuck:${last.status}` : 'timeout', waited: Date.now() - t0, task: last };
}

const suite = PROMPTS.filter(p =>
  browserOnly ? p.kind === 'browser' : noBrowser ? p.kind !== 'browser' : true);

console.log(`══ decision-e2e: ${suite.length} prompts → ${COMMS} ══\n`);

const results = [];
for (const p of suite) {
  const off = { comms: fileLen(LOGS.comms), main: fileLen(LOGS.main), command: fileLen(LOGS.command) };
  const r = await send(p.text);
  // wait for the task to actually finish, not a fixed sleep — browser tasks
  // take 30–90s and previously the window closed before sessions persisted
  const cap = args.includes('--fast') ? 20000 : (p.kind === 'browser' ? 120000 : 45000);
  const wt = await waitForTask(r.taskId, cap, p.text);
  r.taskStatus = wt.status;
  await sleep(1500); // flush trailing async log lines

  const win = {
    comms: tailSince(LOGS.comms, off.comms),
    main: tailSince(LOGS.main, off.main),
    command: tailSince(LOGS.command, off.command),
  };
  const all = win.comms + win.main + win.command;

  const shadows = [...all.matchAll(/\[DecisionShadow\] site=(\S+) agree=(\S+?) local=(\S+?) remote=(\S+?) localMs=(\S+)/g)]
    .map(m => ({ site: m[1], agree: m[2], local: m[3], remote: m[4], ms: +m[5] }));
  // session: only real bindings — persisted sessions and tab adoptions,
  // not incidental `session=` mentions in unrelated async lines
  const session = [...all.matchAll(/(?:Persisted|tabAdopted|bound-session|Enforced active session)[^\n]*?(ext:[\w.-]+|[a-z_]+_agent)/g)].map(m => m[1]).slice(-3);
  const planSteps = [...win.main.matchAll(/Step \d+:\s*([^\n]+)/g)].map(m => m[1].trim());
  const svcAll = [...all.matchAll(/targetService['":= ]+["']?(\w+)/g)];
  const svcM = svcAll.at(-1);
  const typeAll = [...all.matchAll(/taskType['":= ]+["']?(\w+)/g)];
  const typeM = typeAll.at(-1);
  const bad = {
    foreignRewrite: /foreign-host→bound-tab-select/.test(all),
    boundMissing: /bound-page-missing/.test(all),
    browserSteal: /tabAdopted session=ext:browser/.test(all),
    engineSpawn: /no engine page|Launching (Playwright|browser engine)|engine launch/i.test(all),
    circuit: /Circuit OPEN/.test(all),
    timeout: /Request timeout|DECISION_TIMEOUT|AbortError/i.test(all),
    stuck: /^stuck:|timeout$/.test(r.taskStatus || ''),
    webSearchDetour: /web_search|web\.agent/.test(all) && p.expect.session,
  };

  results.push({ p, r, shadows, session, planSteps, svc: svcM?.[1], type: typeM?.[1], bad });
  const flag = Object.values(bad).some(Boolean) ? ' ⚠' : '';
  console.log(`${r.ok ? '✓' : '✗'} ${p.id} "${p.text.slice(0, 60)}" — ${r.ms}ms task=${r.taskStatus || '?'} svc=${svcM?.[1] || '-'} type=${typeM?.[1] || '-'} sess=${session.at(-1) || '-'} shadow=${shadows.map(s => `${s.site}:${s.agree}`).join(',') || 'none'}${flag}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('\n══ ASSERTIONS ══');
let pass = 0, fail = 0;
for (const { p, r, shadows, session, svc, bad } of results) {
  const notes = [];
  if (!r.ok) notes.push('request failed');
  if (p.expect.service && svc && svc !== p.expect.service) notes.push(`service ${svc}≠${p.expect.service}`);
  if (p.expect.session && !session.some(s => s.includes(p.expect.session))) notes.push(`no ${p.expect.session} session (saw ${session.join('/') || 'none'})`);
  for (const [k, v] of Object.entries(bad)) if (v) notes.push(k);
  const disagree = shadows.filter(s => s.agree === 'false');
  if (disagree.length) notes.push(`shadow-disagree:${disagree.map(s => s.site).join(',')}`);
  const ok = notes.length === 0 || (notes.every(n => n.startsWith('shadow-disagree')) && p.kind === 'pure');
  if (ok) pass++; else fail++;
  console.log(` ${ok ? 'PASS' : 'FAIL'} ${p.id}${p.note ? ` (${p.note})` : ''}${notes.length ? ' — ' + notes.join('; ') : ''}`);
}

const agree = results.flatMap(x => x.shadows).filter(s => s.agree === 'true').length;
const total = results.flatMap(x => x.shadows).length;
const lats = results.flatMap(x => x.shadows).map(s => s.ms).filter(Number.isFinite);
console.log(`\n══ TOTALS ══`);
console.log(`prompts: ${pass}/${results.length} pass`);
console.log(`shadow: ${agree}/${total} agree (${total ? Math.round(100 * agree / total) : 0}%)`);
if (lats.length) console.log(`localMs: median=${lats.sort((a, b) => a - b)[~~(lats.length / 2)]} max=${Math.max(...lats)}`);
console.log(`\nTip: grep '\\[DecisionShadow\\]' logs/comms-graph.log logs/main.log for the raw agreement stream.`);
process.exit(fail > Math.ceil(results.length * 0.1) ? 1 : 0);
