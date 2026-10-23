/**
 * plan-check-local-lane.test.cjs — draft-agent readiness rows.
 *
 * A task pinned on a draft MCP descriptor that duplicates a built-in local
 * lane (filesystem → shell) must produce a cli-setup row carrying the local
 * lane as `suggested` — the card renders a "Use shell" escape hatch instead
 * of forcing an install for work the runtime already does.
 *
 * Deps are stubbed through require.cache so the test needs no real agent
 * descriptors or services on disk.
 *
 * Run: node shared/plan-check-local-lane.test.cjs
 */

// ── Stubs must land in require.cache BEFORE plan-check loads its imports ─────
function _stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require(resolved); // ensure the cache entry exists
  require.cache[resolved].exports = exports;
}

_stub('./service-map.cjs', {
  describeAgent: (id) => {
    if (id === 'mcp.filesystem.agent') {
      return {
        agentId: 'mcp.filesystem.agent', type: 'mcp', status: 'draft',
        mcpServer: 'filesystem', service: 'filesystem', secrets: [],
      };
    }
    if (id === 'phantom.agent') return null;
    return null;
  },
  suggestAgent: (name) => (String(name).replace(/\.agent$/, '') === 'phantom' ? 'shell' : null),
});
_stub('./secret-resolve.cjs', { resolveAgentSecrets: () => ({ missing: [], present: [] }) });
// fs.read/doc.read/shell.run are skills, not agents — the checker skips them.
_stub('./skill-index.cjs', { skillExists: (n) => ['fs.read', 'doc.read', 'shell.run'].includes(n) });
_stub('../comms-graph/src/planPreflight.cjs', {
  assessTasks: (tasks) => ({
    byTask: new Map((tasks || []).map(t => [t.num, { auth: 'none-required', agents: [] }])),
  }),
});

const { computePlanCheck } = require('./plan-check.cjs');

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

(async () => {
  // ── Draft filesystem MCP → cli-setup + local-lane escape hatch ────────────
  {
    const r = await computePlanCheck([{
      num: 1, prompt: 'Read the files in ~/Desktop/misc',
      agents: ['mcp.filesystem.agent'], steps: [{ skill: 'fs.read' }],
    }]);
    const row = r.items.find(i => i.kind === 'cli-setup');
    t('draft filesystem → cli-setup row', !!row);
    t('cli-setup is an issue (blocks run)', row && row.status === 'issue');
    t('cli-setup suggests shell lane', row && row.suggested === 'shell');
    t('cli-setup carries mcpServer name', row && row.mcpServer === 'filesystem');
    t('allClear false while setup needed', r.allClear === false);
  }

  // ── Local-lane agents are never readiness gaps ─────────────────────────────
  {
    const r = await computePlanCheck([{
      num: 1, prompt: 'Read the files in ~/Desktop/misc',
      agents: ['shell', 'fs.read'], steps: [{ skill: 'fs.read' }],
    }]);
    t('shell/fs.read → no cli-setup row', !r.items.some(i => i.kind === 'cli-setup'));
    t('shell/fs.read → no unknown-agent row', !r.items.some(i => i.kind === 'unknown-agent'));
    t('shell/fs.read → allClear', r.allClear === true);
  }

  // ── Unknown agent → unknown-agent row with suggestion ─────────────────────
  {
    const r = await computePlanCheck([{
      num: 1, prompt: 'Do a thing', agents: ['phantom.agent'], steps: [{ skill: 'x' }],
    }]);
    const row = r.items.find(i => i.kind === 'unknown-agent');
    t('phantom → unknown-agent row', !!row);
    t('phantom → suggested shell', row && row.suggested === 'shell');
  }

  // ── Steps states ───────────────────────────────────────────────────────────
  {
    const r = await computePlanCheck([
      { num: 1, prompt: 'a', agents: ['shell'], steps: [], stepsStatus: 'pending' },
      { num: 2, prompt: 'b', agents: ['shell'], steps: [], stepsStatus: 'failed' },
      { num: 3, prompt: 'c', agents: ['shell'], steps: [{ skill: 'x' }] },
    ]);
    const s1 = r.items.find(i => i.id === 't1-steps');
    const s2 = r.items.find(i => i.id === 't2-steps');
    const s3 = r.items.find(i => i.id === 't3-steps');
    t('pending steps → pending row', s1 && s1.status === 'pending' && s1.kind === 'missing-steps');
    t('failed steps → warn row (replan at runtime)', s2 && s2.status === 'warn' && s2.kind === 'steps-failed');
    t('ready steps → pass', s3 && s3.status === 'pass');
    t('pending blocks allClear', r.allClear === false);
  }

  // ── Approval-required task → info row, not a blocker ───────────────────────
  {
    const r = await computePlanCheck([{
      num: 1, prompt: 'Send the email', agents: ['shell'],
      steps: [{ skill: 'x' }], approval: 'required',
    }]);
    const row = r.items.find(i => i.kind === 'approval-required');
    t('approval row present', !!row);
    t('approval row does not block', r.allClear === true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
