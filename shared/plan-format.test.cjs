/**
 * plan-format.test.cjs — task-block parsing/writing regression coverage.
 *
 * The task-body boundary and `- **Field**:` updaters must be fence-aware:
 * step JSON routinely carries markdown-looking text (`## ` headings,
 * `- **Status**:` lines) which used to truncate bodies mid-fence, spoof
 * field writes into the JSON, bleed across task boundaries, and collide
 * `Task 1` with `Task 12`.
 *
 * Run: node shared/plan-format.test.cjs
 */

const pf = require('./plan-format.cjs');

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

const PLAN = `---
id: plan_test
status: ready
---
# Plan: test

## Tasks

## Task 1 — gather
- **Prompt**: Read the files
- **Agents**: shell
- **Mode**: sequential
- **Auth**: none-required
- **Steps**:
\`\`\`json
[{"skill":"fs.read","args":{"path":"/a"},"description":"read a"}]
\`\`\`
- **Status**: ⬜ pending
- **Result**: —

## Task 2 — compile (steps JSON contains '## ' and '- **Status**:' inside strings)
- **Prompt**: Write the doc
- **Agents**: edit.agent
- **Mode**: sequential
- **Auth**: none-required
- **Steps**:
\`\`\`json
[{"skill":"synthesize","args":{"prompt":"Structure it with:\\n\\n# Master Notes\\n\\nFor each file create a section with:\\n- ## [Filename]\\n- **Summary:** x\\n- **Status**: done"},"description":"compose"},{"skill":"synthesize","args":{"prompt":"confirm"},"description":"confirm"}]
\`\`\`
- **Status**: ⬜ pending
- **Result**: —

## Task 12 — later task (prefix-collision guard)
- **Prompt**: Another task
- **Agents**: shell
- **Mode**: sequential
- **Auth**: none-required
- **Status**: ⬜ pending
- **Result**: —

## Risks
- none
`;

// ── Parsing ──────────────────────────────────────────────────────────────────
{
  const tasks = pf.parseTasks(PLAN);
  t('3 tasks parsed', tasks.length === 3);
  const t2 = tasks.find(x => x.num === 2);
  t('task2 body not truncated by ## inside JSON', t2 && Array.isArray(t2.steps) && t2.steps.length === 2);
  t('task2 prompt intact', t2 && t2.prompt === 'Write the doc');
  t('task2 status parsed from real field, not JSON', t2 && /pending/.test(t2.status));
  t('task12 parsed separately', tasks.some(x => x.num === 12));
}

// ── updateTaskSteps — re-gen on poisoned body must replace, not no-op ─────────
{
  const next = pf.updateTaskSteps(PLAN, 2, [{ skill: 'fs.read', args: { path: '/x' }, description: 'new' }]);
  const t2 = pf.parseTasks(next).find(x => x.num === 2);
  t('regen replaces steps containing ## ', t2 && t2.steps.length === 1 && t2.steps[0].skill === 'fs.read');
  const t1 = pf.parseTasks(next).find(x => x.num === 1);
  t('task1 steps untouched', t1 && t1.steps.length === 1);
  const t12 = pf.parseTasks(next).find(x => x.num === 12);
  t('task12 untouched', t12 && !Array.isArray(t12.steps));
}

// ── updateTaskSteps — insert when absent ──────────────────────────────────────
{
  const next = pf.updateTaskSteps(PLAN, 12, [{ skill: 'shell.run', args: { command: 'ls' }, description: 'x' }]);
  const t12 = pf.parseTasks(next).find(x => x.num === 12);
  t('insert adds steps to step-less task', t12 && t12.steps.length === 1);
}

// ── updateTaskStatus — real field only; no task bleed; no prefix collision ────
{
  const next = pf.updateTaskStatus(PLAN, 1, 'done', 'all good');
  const tasks = pf.parseTasks(next);
  t('task1 status updated', /done/.test(tasks.find(x => x.num === 1).status));
  t('task1 result updated', tasks.find(x => x.num === 1).result === 'all good');
  t('task2 status NOT patched (task 1 had its own line)', /pending/.test(tasks.find(x => x.num === 2).status));
  t('task12 status NOT patched by Task-1 prefix', /pending/.test(tasks.find(x => x.num === 12).status));
  // JSON inside task 2 must be byte-intact
  const t2 = pf.parseTasks(next).find(x => x.num === 2);
  t('task2 JSON survives status write', t2 && t2.steps.length === 2);
}

// ── updateTaskStatus on a task whose body lacks the field → no bleed ─────────
{
  // Task 12 has a Status line, so drop-test uses Steps Status instead:
  // task 2 has none — clearing it must NOT remove task 12's… build a variant.
  const variant = PLAN.replace('## Task 12 — later task (prefix-collision guard)\n- **Prompt**: Another task',
    '## Task 12 — later task (prefix-collision guard)\n- **Prompt**: Another task')
    .replace('- **Status**: ⬜ pending\n- **Result**: —\n\n## Risks',
             '- **Steps Status**: pending\n- **Status**: ⬜ pending\n- **Result**: —\n\n## Risks');
  const cleared = pf.updateTaskStepsStatus(variant, 2, null); // task 2 has no Steps Status
  const tasks = pf.parseTasks(cleared);
  t('clearing missing Steps Status does not eat task 12\'s', tasks.find(x => x.num === 12).stepsStatus === 'pending');
}

// ── updateTaskStepsStatus set/clear round-trip ────────────────────────────────
{
  const set = pf.updateTaskStepsStatus(PLAN, 2, 'pending');
  t('stepsStatus set', pf.parseTasks(set).find(x => x.num === 2).stepsStatus === 'pending');
  const cleared = pf.updateTaskStepsStatus(set, 2, null);
  t('stepsStatus cleared', pf.parseTasks(cleared).find(x => x.num === 2).stepsStatus === null);
  t('task2 steps still parse after status churn', pf.parseTasks(cleared).find(x => x.num === 2).steps.length === 2);
}

// ── updateTaskAgents / updateTaskAuth / updateTaskApproval ────────────────────
{
  const a = pf.updateTaskAgents(PLAN, 2, ['shell']);
  const t2 = pf.parseTasks(a).find(x => x.num === 2);
  t('agents updated', t2 && t2.agents.join('|') === 'shell');
  const au = pf.updateTaskAuth(PLAN, 2, 'needs sign-in');
  t('auth updated', pf.parseTasks(au).find(x => x.num === 2).auth === 'needs sign-in');
  const ap = pf.updateTaskApproval(PLAN, 2, 'required');
  t('approval set', pf.parseTasks(ap).find(x => x.num === 2).approval === 'required');
  const ap2 = pf.updateTaskApproval(ap, 2, null);
  t('approval cleared', pf.parseTasks(ap2).find(x => x.num === 2).approval === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
