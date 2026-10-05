'use strict';

/**
 * plan-check.cjs — deterministic "Running Planning Check" checklist.
 *
 * Computes per-task readiness rows from the plan file + agent registry +
 * the preflight auth ledger — no live probes, no LLM. Each row is either a
 * pass, a pending state (steps still generating), or an actionable issue:
 *
 *   signin         — registered browser service agent needs auth
 *   cli-key        — cli/api/mcp agent declares `secrets:` that aren't stored
 *   cli-login      — non-browser agent w/o secrets that may need a login run
 *   unknown-agent  — name matches no registry agent (suggested? attached)
 *   missing-steps  — task steps still generating (pending, not an issue)
 *
 * Items are what PlanCheckCard renders; actions resolve through
 * plan:check:action IPC. allClear === false blocks plan start.
 */

const serviceMap = require('./service-map.cjs');
const { resolveAgentSecrets } = require('./secret-resolve.cjs');
const skillIndex = require('./skill-index.cjs');

function _preflight() {
  return require('../comms-graph/src/planPreflight.cjs');
}

const LOCAL = new Set(['shell', 'none', 'general_knowledge', 'synthesize']);

function _taskStepsReady(task) {
  // plan-steps steps are [{skill,...}] after generation; a task with
  // stepsStatus 'pending'/'generating' or no parsed steps isn't ready.
  const status = String(task.stepsStatus || '').toLowerCase();
  if (status === 'pending' || status === 'generating') return false;
  return Array.isArray(task.steps) && task.steps.length > 0;
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

    // Steps row — pending while step-gen is still running.
    const stepsReady = _taskStepsReady(task);
    items.push({
      id: `t${n}-steps`,
      taskNum: n,
      label: `Task ${n} — steps ready`,
      detail: title,
      status: stepsReady ? 'pass' : 'pending',
      kind: stepsReady ? undefined : 'missing-steps',
    });

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

  const allClear = items.every(i => i.status === 'pass');
  return { items, allClear };
}

module.exports = { computePlanCheck };
