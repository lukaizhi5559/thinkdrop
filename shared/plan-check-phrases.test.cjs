'use strict';

// plan-check-phrases — the deterministic exit backstop. Anchored exits must
// still match; inline exits cover mid-sentence "get out of plan mode";
// negation vetoes bind only exit verbs ("don't you" ≠ "don't exit"); and
// false-positive guards keep "plan a party" / "stop planning the wedding"
// from touching the lane.

const { PLANNING_EXIT_RE, PLANNING_EXIT_INLINE_RE, PLANNING_EXIT_NEG_RE } = require('./plan-check-phrases.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const exits = (t) => (PLANNING_EXIT_RE.test(t) || PLANNING_EXIT_INLINE_RE.test(t)) && !PLANNING_EXIT_NEG_RE.test(t);

// ── Anchored exits (unchanged contract) ────────────────────────────────────
for (const s of ['stop planning', 'exit plan mode', 'leave planning mode', 'cancel planning', 'planning mode off', 'turn off plan mode', '/exit planning', 'get out of planning mode', 'done with planning', 'no more planning']) {
  check(`anchored exit: "${s}"`, PLANNING_EXIT_RE.test(s) && exits(s));
}

// ── Inline exits (the voice-realtime gap) ──────────────────────────────────
for (const s of [
  "why don't you just get out of plan mode",
  'can you exit plan mode please',
  'step out of planning mode',
  'could you stop plan mode',
  'hey, quit plan mode',
]) {
  check(`inline exit: "${s}"`, PLANNING_EXIT_INLINE_RE.test(s) && exits(s));
}

// ── Negation vetoes ────────────────────────────────────────────────────────
for (const s of [
  "don't exit plan mode",
  'do not leave planning mode',
  'keep planning',
  'stay in plan mode',
  'never stop planning',
]) {
  check(`veto: "${s}"`, !exits(s));
}
check('"why don\'t you" is NOT vetoed (rhetorical = do it)', exits("why don't you just get out of plan mode"));

// ── False positives ─────────────────────────────────────────────────────────
for (const s of [
  'plan a party',
  'run the plan',
  'explain the plan mode',
  'stop planning the wedding for me',
  "let's talk about exiting plan mode later",
  'the plan mode feature is nice',
  'planning ahead is smart',
]) {
  check(`no exit: "${s}"`, !exits(s));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('failures:', failures.join('; ')); process.exit(1); }
