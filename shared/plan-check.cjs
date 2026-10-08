'use strict';

/**
 * plan-check.cjs — deterministic "Running Planning Check" checklist.
 *
 * Computes per-task readiness rows from the plan file + agent registry +
 * the preflight auth ledger — no live probes, no LLM. Each row is either a
 * pass, a pending state (steps still generating), or an actionable issue:
 *
 *   signin             — registered browser service agent needs auth
 *   cli-key            — cli/api/mcp agent declares `secrets:` that aren't stored
 *   cli-login          — non-browser agent w/o secrets that may need a login run
 *   unknown-agent      — name matches no registry agent (suggested? attached)
 *   missing-steps      — task steps still generating (pending, not an issue)
 *   steps-failed       — step generation failed (warn — executor replans at runtime)
 *   approval-required  — task pauses mid-run for user review (info row)
 *
 * Items are what PlanCheckCard renders; actions resolve through
 * plan:check:action IPC. Only status 'issue' rows block plan start —
 * 'warn' and 'pending' are advisory.
 */

const serviceMap = require('./service-map.cjs');
const { resolveAgentSecrets } = require('./secret-resolve.cjs');
const skillIndex = require('./skill-index.cjs');

function _preflight() {
  return require('../comms-graph/src/planPreflight.cjs');
}

const LOCAL = new Set(['shell', 'none', 'general_knowledge', 'synthesize']);

function _taskStepsState(task) {
  // 'failed' → issue; pending/generating/no steps → pending; else pass.
  const status = String(task.stepsStatus || '').toLowerCase();
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'generating') return 'pending';
  return (Array.isArray(task.steps) && task.steps.length > 0) ? 'pass' : 'pending';
}

/**
 * @param {Array} tasks - plan-format tasks ({num, prompt, agents, auth, steps, stepsStatus})
 * @param {object} [opts]
 * @param {Set<string>} [opts.bypassed]
 * @returns {Promise<{items: Array, allClear: boolean}>}
 */
async function computePlanCheck(tasks, opts = {}) {
  const bypassed = opts.bypassed || new Set();
  const { assessTasks } = _preflight();
  const { byTask } = assessTasks(tasks, bypassed);
  const items = [];

  for (const task of tasks || []) {
    const n = task.num;
    const title = String(task.prompt || task.title || `Task ${n}`).slice(0, 60);
    const assessment = byTask.get(n) || { auth: 'unknown', agents: [] };

    // Steps row — pending while step-gen is still running, issue when it failed.
    const stepsState = _taskStepsState(task);
    items.push({
      id: `t${n}-steps`,
      taskNum: n,
      label: stepsState === 'failed'
        ? `Task ${n} — step generation failed (will replan at run)`
        : (stepsState === 'pass' ? `Task ${n} — steps ready` : `Task ${n} — generating steps…`),
      detail: title,
      status: stepsState === 'pass' ? 'pass' : (stepsState === 'failed' ? 'warn' : 'pending'),
      kind: stepsState === 'pass' ? undefined : (stepsState === 'failed' ? 'steps-failed' : 'missing-steps'),
    });

    // Commit tasks pause mid-run for review — surface as an info row so the
    // user knows the run will stop and ask before booking/sending.
    if (task.approval === 'required') {
      items.push({
        id: `t${n}-approval`,
        taskNum: n,
        label: `Task ${n} — will pause for your review`,
        detail: title,
        status: 'pass',
        kind: 'approval-required',
      });
    }

    const agents = (task.agents || []).map(a => String(a).trim()).filter(Boolean);
    const realAgents = agents.filter(a => {
      const name = a.replace(/\.agent$/, '').toLowerCase();
      return !LOCAL.has(name) && !LOCAL.has(a.toLowerCase()) && !skillIndex.skillExists(a);
    });

    for (const agent of realAgents) {
      const canon = agent.endsWith('.agent') ? agent : `${agent}.agent`;
      const desc = serviceMap.describeAgent(agent) || serviceMap.describeAgent(canon);
      const authRow = (assessment.agents || []).find(x =>
        x.agent === canon || x.agent === agent || x.agent === agent.toLowerCase());
      const authState = authRow ? authRow.auth : 'unknown';

      // ── Unregistered / phantom name ──────────────────────────────────
      if (!desc) {
        items.push({
          id: `t${n}-${canon}`,
          taskNum: n, agentId: canon,
          label: `${canon} — not a registered agent`,
          status: 'issue',
          kind: 'unknown-agent',
          suggested: serviceMap.suggestAgent(agent) || null,
        });
        continue;
      }

      // ── Non-browser (cli / api / mcp) agents ────────────────────────
      if (desc.type && desc.type !== 'browser') {
        // Draft descriptor — selected via capability.select but not built/
        // installed yet. Actionable setup row instead of a dead unknown-agent.
        if (desc.status === 'draft' || desc.status === 'pending') {
          items.push({
            id: `t${n}-${desc.agentId}`,
            taskNum: n, agentId: desc.agentId,
            label: `${desc.agentId} — needs setup`,
            detail: desc.cliTool
              ? `will build the ${desc.cliTool} agent (install + connect)`
              : (desc.mcpServer ? `will install the ${desc.mcpServer} MCP server` : 'will be set up before run'),
            status: 'issue',
            kind: 'cli-setup',
            envNames: desc.secrets || [],
            serviceType: desc.type,
            cliTool: desc.cliTool || null,
            mcpServer: desc.mcpServer || null,
            bypassed: authState === 'bypassed',
          });
          continue;
        }
        if (Array.isArray(desc.secrets) && desc.secrets.length) {
          let missing = desc.secrets;
          try {
            const r = await resolveAgentSecrets(desc.agentId, desc.secrets);
            missing = r.missing;
          } catch (_) {}
          items.push({
            id: `t${n}-${desc.agentId}`,
            taskNum: n, agentId: desc.agentId,
            label: `${desc.agentId} — ${desc.type} credentials`,
            status: missing.length ? 'issue' : 'pass',
            kind: missing.length ? 'cli-key' : undefined,
            envNames: missing.length ? missing : desc.secrets,
            serviceType: desc.type,
            bypassed: authState === 'bypassed',
          });
        } else {
          const needs = authState === 'needs sign-in';
          items.push({
            id: `t${n}-${desc.agentId}`,
            taskNum: n, agentId: desc.agentId,
            label: `${desc.agentId} — ${desc.type} ready`,
            status: needs ? 'issue' : 'pass',
            kind: needs ? 'cli-login' : undefined,
            serviceType: desc.type,
            bypassed: authState === 'bypassed',
          });
        }
        continue;
      }

      // ── Browser service agents ──────────────────────────────────────
      const ok = authState === 'authed' || authState === 'bypassed';
      items.push({
        id: `t${n}-${desc.agentId}`,
        taskNum: n, agentId: desc.agentId,
        label: `${desc.agentId} — ${authState}`,
        status: ok ? 'pass' : 'issue',
        kind: ok ? undefined : 'signin',
        authState,
        bypassed: authState === 'bypassed',
      });
    }
  }

  // 'warn' is advisory (executor replans at runtime); only 'issue' blocks.
  const allClear = !items.some(i => i.status === 'issue' || i.status === 'pending');
  return { items, allClear };
}

module.exports = { computePlanCheck };
