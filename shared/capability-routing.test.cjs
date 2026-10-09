'use strict';

// capability-routing regression matrix — the three live failures that drove
// the semantic-selection architecture, plus the mechanical layers around it:
//
//   1. Retrieval: registered agents reach the pool even at score 0.
//   2. Selection: a stubbed LLM picks / returns none / fails — and only a
//      pick from the retrieved pool can ever bind (invalid ids rejected).
//   3. Decision: decideGate maps fit+verified facts → pin / needs_setup /
//      clarify / none / fallback. Selector failure NEVER pins.
//   4. Deliverables: artifact phrasing routes to the GhostLayer detector.
//   5. Auto-answer: safe setup prompts answer; secrets/2FA/destructive never.

process.env.THINKDROP_AGENTS_DIR = '/tmp/td-routing-test-agents';
const fs = require('fs');
const path = require('path');
const { searchCapabilities, selectBestCapability, decideGate, selectCapability } = require('./capability-index.cjs');
const { detectScreenOutput } = require('../stategraph-module/src/utils/classifyTask.js');
const { classifyPromptLine, answerFor } = require('../mcp-services/command-service/src/terminal/auto-answer.cjs');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
function section(t) { console.log(`\n— ${t}`); }

const CLI = { id: 'nylas.agent', kind: 'cli', service: 'nylas', registered: true, installed: true, friction: 0, capabilities: ['email', 'calendar'], setupSummary: 'ready' };
const MSG = { id: 'messages.app.agent', kind: 'local', service: 'messages', registered: false, installed: true, friction: 0, capabilities: ['send_text', 'imessage'], setupSummary: 'none' };
const BR  = { id: 'gmail.agent', kind: 'browser', service: 'gmail', registered: true, installed: true, friction: 0, capabilities: ['email', 'browser'], setupSummary: 'ready' };
const UNREADY = { id: 'twilio.agent', kind: 'cli', service: 'twilio', registered: false, installed: false, friction: 4, capabilities: ['sms'], setupSummary: 'api key + signup' };

(async () => {

section('selection — stubbed LLM, real decision semantics');

// Church-site public scrape → selector must return none (not nylas).
{
  const sel = await selectBestCapability('summary of calendar events on valley forge baptist church site', {
    candidates: [CLI, MSG, BR],
    llmCaller: async () => '{"pick":null,"fit":"none","reason":"public website events are not the user calendar"}',
  });
  check('church site → pick none', sel.ok && sel.pick === null && sel.fit === 'none');
  check('church site → decision none', decideGate(sel) === 'none');
}

// Text my wife → messages.app.agent over nylas.
{
  const sel = await selectBestCapability('text my wife i will be late', {
    candidates: [CLI, MSG],
    llmCaller: async () => '{"pick":"messages.app.agent","fit":"exact","reason":"local iMessage send"}',
  });
  check('text wife → messages.app.agent', sel.pick?.id === 'messages.app.agent' && sel.fit === 'exact');
  check('text wife → decision pin', decideGate(sel) === 'pin');
}

// Gmail inbox → Nylas CLI beats the Gmail browser agent (CLI-first).
{
  const sel = await selectBestCapability('check my gmail inbox', {
    candidates: [BR, CLI],
    llmCaller: async () => '{"pick":"nylas.agent","fit":"exact","reason":"gmail is the service; nylas cli is the surface"}',
  });
  check('gmail → nylas.agent over gmail.agent', sel.pick?.id === 'nylas.agent');
  check('gmail → decision pin (cli ready)', decideGate(sel) === 'pin');
}

// Unready exact pick → needs_setup, never pin.
{
  const sel = await selectBestCapability('text my wife i will be late', {
    candidates: [UNREADY],
    llmCaller: async () => '{"pick":"twilio.agent","fit":"exact","reason":"only sms route"}',
  });
  check('unready pick → decision needs_setup', decideGate(sel) === 'needs_setup');
}

// Partial fit → clarify.
{
  const sel = await selectBestCapability('connect my calendar', {
    candidates: [CLI],
    llmCaller: async () => '{"pick":"nylas.agent","fit":"partial","reason":"connector verb"}',
  });
  check('partial fit → clarify', decideGate(sel) === 'clarify');
}

section('selection — fail-safe robustness (never a lexical pin)');

check('llmCaller throws → ok:false → fallback', decideGate(await selectBestCapability('x', {
  candidates: [CLI], llmCaller: async () => { throw new Error('boom'); },
})) === 'fallback');

check('llmCaller missing → ok:false → fallback', decideGate(await selectBestCapability('x', {
  candidates: [CLI],
})) === 'fallback');

check('non-JSON verdict → ok:false → fallback', decideGate(await selectBestCapability('x', {
  candidates: [CLI], llmCaller: async () => 'sorry I cannot help with that',
})) === 'fallback');

check('pick outside pool → treated as none (phantom ids never bind)',
  decideGate(await selectBestCapability('x', {
    candidates: [CLI], llmCaller: async () => '{"pick":"evil.agent","fit":"exact"}',
  })) === 'none');

check('exact fit but pick null → none', decideGate(await selectBestCapability('x', {
  candidates: [CLI], llmCaller: async () => '{"pick":null,"fit":"exact"}',
})) === 'none');

section('decideGate — pure mapping');
check('browser sole route, ready → pin', decideGate({ ok: true, fit: 'exact', pick: BR }) === 'pin');
check('browser unready → needs_setup', decideGate({ ok: true, fit: 'exact', pick: { ...BR, friction: 6 } }) === 'needs_setup');
check('selection null → fallback', decideGate(null) === 'fallback');
check('selection ok:false → fallback', decideGate({ ok: false }) === 'fallback');

section('deliverable detection — GhostLayer routing');
for (const [m, want] of [
  ['create a chart of Q3 sales', 'show'],
  ['put together a slideshow for my pitch', 'show'],
  ['draft an essay about renewable energy', 'show'],
  ['make a 3d model of a plane', 'show'],
  ['make an animation of the solar system', 'show'],
  ['text my wife i will be late', null],
  ['check my gmail inbox', null],
  ['what is this site about', null],
  ['summary of calendar events on valley forge baptist church site', null],
  ['clear the screen', 'clear'],
]) check(`detectScreenOutput "${m.slice(0, 50)}" → ${want}`, detectScreenOutput(m) === want);

section('terminal auto-answer — safe vs never');
const screen = (l) => `setup output\n${l}`;
check('[Y/n] confirm → y', answerFor(classifyPromptLine('Proceed? [Y/n]', screen('Proceed? [Y/n]')), { enable: true, confirm: 'y' }) === 'y');
check('menu → default (Enter)', answerFor(classifyPromptLine('› production', screen('Select env\n› production\n  staging')), { enable: true, select: 'default' }) === '\r');
check('password → never', classifyPromptLine('Password:', screen('Password:')).kind === 'never');
check('api key → never', classifyPromptLine('API Key:', screen('API Key:')).kind === 'never');
check('2fa → never', classifyPromptLine('Enter your verification code:', screen('Enter your verification code:')).kind === 'never');
check('destructive → never', classifyPromptLine('Delete all data? (y/n)', screen('This cannot be undone. Delete all data? (y/n)')).kind === 'never');
check('password → no answer even enabled', answerFor(classifyPromptLine('Password:', screen('Password:')), { enable: true, confirm: 'y' }) === null);
check('confirm → no answer when disabled', answerFor(classifyPromptLine('Continue? [Y/n]', screen('Continue? [Y/n]')), { enable: false }) === null);
check('free-text input → only queued values', answerFor(classifyPromptLine('Project name:', screen('Project name:')), { enable: true, confirm: 'y' }) === null);

section('materialization — selectCapability writes a draft descriptor');
{
  fs.rmSync(process.env.THINKDROP_AGENTS_DIR, { recursive: true, force: true });
  const r = await selectCapability('messages.app.agent');
  const f = path.join(process.env.THINKDROP_AGENTS_DIR, 'messages.app.agent.md');
  check('materialize ok', r.ok === true && !!r.agentId);
  check('draft file written', fs.existsSync(f));
  const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  check('descriptor carries capabilities', /capabilities/i.test(src) || /send_text/i.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
