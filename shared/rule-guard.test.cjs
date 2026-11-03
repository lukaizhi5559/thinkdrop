'use strict';
/**
 * rule-guard.test.cjs — routing/command prescriptions must never persist
 *
 * Regression: saved rules like "use browser.act to read the page" and
 * "do NOT use cli.agent" got canonized as context_rules and fought the
 * deterministic gates downstream. Facts persist; prescriptions never.
 */
const assert = require('assert');
const { rulePrescribesRouting, ROUTING_RX } = require('./rule-guard.cjs');

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

console.log('\nrule-guard tests');

// ── prescriptions (rejected) ──────────────────────────────────────────────
for (const [name, text] of [
  ['skill prescription',        'use browser.act to read the page'],
  ['skill prohibition',         'do NOT use cli.agent for this site'],
  ['turn.loop.agent routing',   'route browser work through turn.loop.agent'],
  ['agentId mention',           'url.first.agent is the right agentId here'],
  ['scan_page action',          'scan_page handles this read'],
  ['navigate_url action',       'always navigate_url first'],
  ['shell command',             'run open https://example.com to start'],
  ['npm install',               'npm install -g @nylas/cli then retry'],
  ['brew install',              'brew install the missing cli'],
  ['pip install',               'pip install playwright'],
  ['apt install',               'apt-get install xvfb'],
  ['build_agent onboarding',    'call build_agent for this service'],
  ['waitForStableText',         'use waitForStableText before clicking'],
]) {
  check(`rejects: ${name}`, rulePrescribesRouting(text) === true);
}

// ── facts (persist) ───────────────────────────────────────────────────────
for (const [name, text] of [
  ['oauth fact',            'this service requires OAuth login before any reads'],
  ['paywall fact',          'the article is behind a paywall'],
  ['session fact',          'the user is already logged in to LinkedIn in Chrome'],
  ['content fact',          'the page lists 12 open positions under Engineering'],
  ['empty-ish guard',       'the form has no required fields'],
]) {
  check(`allows: ${name}`, rulePrescribesRouting(text) === false);
}

check('null-safe', rulePrescribesRouting(null) === false);
check('exports the RX for callers that need it', ROUTING_RX instanceof RegExp);

console.log(`\n${passed}/${tests} passed\n`);
process.exit(passed === tests ? 0 : 1);
