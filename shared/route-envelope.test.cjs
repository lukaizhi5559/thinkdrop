'use strict';
/**
 * route-envelope.test.cjs — skillEnvelope / nonSkillEnvelope truth table.
 *
 * The compile-hoist gate (comms-graph handoff.cjs) and the receive-side
 * _skillPlan veto (src/main/handoffRunner.js) both consume skillEnvelope:
 * compile is opt-IN — the envelope must affirmatively describe executable
 * work. task_534944fc regression: taskType=query + suggestedIntent=null on
 * "list details about the videos what they said" compiled to mdfind
 * shell.run — abstention is not task evidence.
 *
 * Run: node shared/route-envelope.test.cjs
 */
const { nonSkillEnvelope, skillEnvelope } = require('./route-envelope.cjs');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// ── skillEnvelope — affirmative task evidence required ─────────────────────
check('query + null intent → not skill (abstain)', !skillEnvelope({ taskType: 'query', suggestedIntent: null }));
check('query + no intent field → not skill', !skillEnvelope({ taskType: 'query' }));
check('query + command_automate → skill', skillEnvelope({ taskType: 'query', suggestedIntent: 'command_automate' }));
check('local_file + null intent → skill (task-shaped type)', skillEnvelope({ taskType: 'local_file', suggestedIntent: null }));
check('local_system → skill', skillEnvelope({ taskType: 'local_system' }));
check('messaging → skill', skillEnvelope({ taskType: 'messaging' }));
check('browser + null → skill', skillEnvelope({ taskType: 'browser' }));
check('unknown taskType + null → not skill', !skillEnvelope({ taskType: 'unknown_future_type', suggestedIntent: null }));
check('null envelope → not skill (safe degradation)', !skillEnvelope(null));
check('undefined → not skill', !skillEnvelope(undefined));

// flags veto trumps task shape / suggestedIntent
check('browser + declined_ack → not skill', !skillEnvelope({ taskType: 'browser', resolution: 'declined_ack' }));
check('local_system + needsFreshScreen → not skill', !skillEnvelope({ taskType: 'local_system', needsFreshScreen: true }));
check('command_automate + isActivityQuery → not skill (flags veto)', !skillEnvelope({ taskType: 'query', suggestedIntent: 'command_automate', isActivityQuery: true }));
check('browser + memory_retrieve suggestion → not skill', !skillEnvelope({ taskType: 'browser', suggestedIntent: 'memory_retrieve' }));

// ── nonSkillEnvelope unchanged ──────────────────────────────────────────────
check('nonSkill: memory_retrieve', nonSkillEnvelope({ suggestedIntent: 'memory_retrieve' }));
check('nonSkill: isActivityQuery', nonSkillEnvelope({ isActivityQuery: true }));
check('nonSkill: needs_clarification', nonSkillEnvelope({ resolution: 'needs_clarification' }));
check('not nonSkill: command_automate', !nonSkillEnvelope({ suggestedIntent: 'command_automate' }));
check('not nonSkill: null', !nonSkillEnvelope(null));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
