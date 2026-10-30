'use strict';
/**
 * dispatchable-skills-drift.test.cjs — keep the skill inventory honest
 *
 * DISPATCHABLE_SKILLS is the single source of truth for "what
 * command.automate can run" — served via /service.health and POST
 * /skill.list, consulted by stategraph's preflight to tell dispatchable
 * *.agent SKILLS from registry AGENTS. If the executeAutomation switch
 * gains a case and the list isn't updated, preflight will spuriously
 * escalate needs_plan again (the 40min stuck-queue incident).
 *
 * This test parses the source — no running service needed — and asserts:
 *   1. every `case 'x'` in the switch is in DISPATCHABLE_SKILLS
 *   2. every DISPATCHABLE_SKILLS id has a switch case (no phantom entries)
 *   3. /health + /skill.list both serve the shared list (not literals)
 *   4. skillIds.js contract fallback (CONTRACTS) ⊆ DISPATCHABLE_SKILLS —
 *      the offline fallback must never name a skill the service can't run
 *
 * Run: node shared/dispatchable-skills-drift.test.cjs
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', 'mcp-services', 'command-service', 'src', 'server.cjs');
const src = fs.readFileSync(SERVER, 'utf8');

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── Extract the executeAutomation switch case ids ──────────────────────────
const swStart = src.indexOf('switch (skill) {');
check('executeAutomation switch found', swStart > 0);
const swEnd = src.indexOf('default:', swStart);
const cases = [...src.slice(swStart, swEnd).matchAll(/case '([^']+)'/g)].map(m => m[1]);
check('switch has cases', cases.length > 30, `found ${cases.length}`);

// ── Extract DISPATCHABLE_SKILLS literal ────────────────────────────────────
const listStart = src.indexOf('const DISPATCHABLE_SKILLS = [');
check('DISPATCHABLE_SKILLS const found', listStart > 0);
const listEnd = src.indexOf('];', listStart);
const list = [...src.slice(listStart, listEnd).matchAll(/'([^']+)'/g)].map(m => m[1]);
check('DISPATCHABLE_SKILLS non-empty', list.length > 30, `found ${list.length}`);

// ── 1+2: bidirectional drift ────────────────────────────────────────────────
const missing = cases.filter(c => !list.includes(c));
check('every switch case is listed (no unlisted dispatch)', missing.length === 0, missing.join(', '));
const phantom = list.filter(l => !cases.includes(l));
check('no phantom list entries (all listed ids dispatch)', phantom.length === 0, phantom.join(', '));
const dupes = list.filter((l, i) => list.indexOf(l) !== i);
check('no duplicate list entries', dupes.length === 0, dupes.join(', '));

// ── 3: endpoints serve the shared list ──────────────────────────────────────
check('/health serves DISPATCHABLE_SKILLS (not a literal)', /skills:\s*DISPATCHABLE_SKILLS/.test(src));
const skillListBlock = src.slice(src.indexOf("'/skill.list'"), src.indexOf("'/skill.list'") + 400);
check('/skill.list serves DISPATCHABLE_SKILLS', /skills:\s*DISPATCHABLE_SKILLS/.test(skillListBlock));
check('no second hardcoded skill array in health routes',
  !/skills:\s*\[\s*'shell\.run'/.test(src), 'found skills:[...literal] in health section');

// ── 4: contract fallback — dispatch-shaped contract ids ⊆ dispatch table ────
// CONTRACTS is the planner's vocabulary; most ids map 1:1 to command-service
// dispatch. But a small set is graph-INTERNAL (executed by stategraph's
// executeCommand, never POSTed to command.automate): synthesize, schedule,
// ask_user, needs_skill, api_suggest. Those correctly stay OFF the list —
// assert only that non-internal contract ids are dispatchable.
const { CONTRACTS } = require('./skill-contracts.cjs');
const GRAPH_INTERNAL = new Set(['synthesize', 'schedule', 'ask_user', 'needs_skill', 'api_suggest']);
const contractIds = Object.keys(CONTRACTS);
const notDispatchable = contractIds.filter(id => !GRAPH_INTERNAL.has(id) && !list.includes(id));
check('non-internal contract skills are all dispatchable', notDispatchable.length === 0, notDispatchable.join(', '));
const leakedInternal = contractIds.filter(id => GRAPH_INTERNAL.has(id) && list.includes(id));
check('graph-internal contract skills stay off the dispatch list', leakedInternal.length === 0, leakedInternal.join(', '));

// ── The incident id itself ──────────────────────────────────────────────────
check('edit.agent is dispatchable (the incident skill)', list.includes('edit.agent'));

console.log(`\n${passed}/${tests} passed`);
process.exit(passed === tests ? 0 : 1);
