'use strict';
/**
 * plan-steps-binding.test.cjs — unbound session-bound steps get repaired
 *
 * Regression: a "read the job application form" turn.loop.agent step emitted
 * with no sessionId (task had no lane agent) fell back to phantom
 * 'ext:default_agent' → "no live tab" while the page sat open in the user's
 * Chrome. Repair: read/scan goals → app.agent scan_page (OS path, no session
 * mint); interactive goals + live ext tabs → sessionId 'ext:default'.
 */
const assert = require('assert');
const { normalizeTaskStepsAsync } = require('./plan-steps.cjs');

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

const EXT = [{ sessionId: 'ext:default' }];

(async () => {
  console.log('\nplan-steps binding-repair tests');

  // Interactive goal, unbound → binds to the live extension tab
  let r = await normalizeTaskStepsAsync({ prompt: 'fill the form', steps: [
    { skill: 'turn.loop.agent', args: { goal: 'fill the form fields' }, description: 'Fill the form' },
  ] }, { extSessions: EXT });
  check('interactive step gains sessionId ext:default', r.steps[0].args.sessionId === 'ext:default');
  check('no phantom ext:default_agent', r.steps[0].args.sessionId !== 'ext:default_agent'
    && r.steps[0].args.agentId !== 'ext:default_agent');

  // Read goal, unbound → rewritten to the OS-path page scan
  r = await normalizeTaskStepsAsync({ prompt: 'read the questions', steps: [
    { skill: 'turn.loop.agent', args: { goal: 'read the application questions' }, description: 'Read the form' },
  ] }, { extSessions: EXT });
  check('read-goal rewritten to app.agent', r.steps[0].skill === 'app.agent');
  check('action is scan_page', r.steps[0].args.action === 'scan_page');
  check('scan_page uses preferOs', r.steps[0].args.preferOs === true);
  check('goal arg dropped (fresh args)', !r.steps[0].args.goal);

  // url.first.agent is not read-capable — an unbound one binds the live tab
  r = await normalizeTaskStepsAsync({ prompt: 'x', steps: [
    { skill: 'url.first.agent', args: { task: 'open the page' } },
  ] }, { extSessions: EXT });
  check('url.first.agent binds ext:default', r.steps[0].args.sessionId === 'ext:default');
  check('url.first.agent keeps its skill', r.steps[0].skill === 'url.first.agent');

  // Already-bound steps untouched
  r = await normalizeTaskStepsAsync({ prompt: 'x', steps: [
    { skill: 'turn.loop.agent', args: { goal: 'read it', sessionId: 'session_real_123' } },
  ] }, { extSessions: EXT });
  check('bound sessionId preserved', r.steps[0].args.sessionId === 'session_real_123');
  check('bound step keeps skill', r.steps[0].skill === 'turn.loop.agent');

  // No live tabs → no bind invented; read-goal still degrades to OS scan
  r = await normalizeTaskStepsAsync({ prompt: 'x', steps: [
    { skill: 'turn.loop.agent', args: { goal: 'click the button' }, description: 'Click it' },
  ] }, { extSessions: [] });
  check('no sessions → no fabricated bind', !r.steps[0].args.sessionId);

  // A declared task agent still wins (pass-2 lane assignment, pre-repair)
  r = await normalizeTaskStepsAsync({ prompt: 'x', agents: ['browser.agent'], steps: [
    { skill: 'turn.loop.agent', args: { goal: 'click it' } },
  ] }, { extSessions: EXT });
  check('declared agent still assigned', r.steps[0].args.agentId === 'browser.agent');

  console.log(`\n${passed}/${tests} passed\n`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
