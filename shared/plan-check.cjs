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
 *   steps-mcp-missing  — a generated step calls an MCP server that isn't installed
 *   approval-required  — task pauses mid-run for user review (info row)
 *
 * Items are what PlanCheckCard renders; actions resolve through
 * plan:check:action IPC. Only status 'issue' rows block plan start —
 * 'warn' and 'pending' are advisory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const serviceMap = require('./service-map.cjs');
const { resolveAgentSecrets } = require('./secret-resolve.cjs');
const skillIndex = require('./skill-index.cjs');

const _MCP_SERVERS_PATH = path.join(os.homedir(), '.thinkdrop', 'mcp-servers.json');

/** Names of installed MCP servers — read fresh each call (installs change it). */
function _installedMcpServers() {
  try {
    const cfg = JSON.parse(fs.readFileSync(_MCP_SERVERS_PATH, 'utf8'));
    return new Set(Object.keys(cfg.mcpServers || cfg || {}));
  } catch (_) { return new Set(); }
}

function _preflight() {
  return require('../comms-graph/src/planPreflight.cjs');
}

const LOCAL = new Set(['shell', 'none', 'general_knowledge', 'synthesize']);

// Draft MCP servers that duplicate a built-in local lane — the readiness row
// can offer the lane as a one-click alternative to installing a server for
// work the runtime already does (e.g. filesystem reads → shell/fs.read).
const LOCAL_LANE_EQUIVALENTS = { filesystem: 'shell' };

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

    // Steps that call an MCP server which isn't installed — readiness only
    // inspects the Agents line, so an invented `mcp.agent {server}` step would
    // look clear then fail at run. Regenerate routes through 'retry-steps'.
    if (Array.isArray(task.steps)) {
      const installed = _installedMcpServers();
      const missing = [...new Set(task.steps
        .filter(s => s && s.skill === 'mcp.agent')
        .map(s => String(s?.args?.server || '').trim())
        .filter(sv => sv && !installed.has(sv)))];
      if (missing.length) {
        items.push({
          id: `t${n}-mcp-steps`,
          taskNum: n,
          label: `Task ${n} — steps call uninstalled MCP server${missing.length > 1 ? 's' : ''} (${missing.join(', ')})`,
          detail: 'regenerate the steps to use installed tools',
          status: 'issue',
          kind: 'steps-mcp-missing',
        });
      }
    }

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
            // Local-lane escape hatch — "don't install anything, use shell".
            suggested: LOCAL_LANE_EQUIVALENTS[desc.mcpServer || desc.service] || null,
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
          // Credential-typed agents (api_key/bearer/basic) at 'unknown' have
          // no stored-secret evidence — flag them so the card agrees with the
          // run gate instead of reporting "ready" while the gate blocks.
          const needs = authState === 'needs sign-in'
            || (authState === 'unknown' && ['api_key', 'bearer', 'basic'].includes(desc.type));
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

  // ── Step corroboration ────────────────────────────────────────────────
  // An agent readiness issue only blocks when a generated step actually
  // invokes it. Tool pins and stale agent lists that no step references are
  // metadata noise (observed: "commit messages" in a task prompt pinned
  // messages.app.agent while the steps were shell.run + synthesize) — they
  // surface as warn rows instead of holding the plan hostage for setup the
  // run will never use. Steps not yet generated keep the issue — the pending
  // steps row already blocks the card anyway.
  const _stepsBlobByTask = new Map();
  for (const t of tasks || []) {
    if (Array.isArray(t.steps) && t.steps.length) {
      _stepsBlobByTask.set(t.num, JSON.stringify(t.steps).toLowerCase());
    }
  }
  for (const it of items) {
    if (it.status !== 'issue' || !it.agentId || it.taskNum == null) continue;
    const blob = _stepsBlobByTask.get(it.taskNum);
    if (!blob) continue;
    const id   = String(it.agentId).toLowerCase();
    const stem = id.replace(/\.agent$/, '');
    const _d2  = serviceMap.describeAgent(it.agentId);
    const svc  = String(_d2?.service || '').toLowerCase();
    const tool = String(_d2?.cliTool || it.cliTool || '').toLowerCase();
    const invoked = blob.includes(id)
      || (stem.length >= 4 && blob.includes(stem))
      || (svc.length >= 4 && blob.includes(`"${svc}"`))
      || (tool.length >= 4 && blob.includes(tool));
    if (!invoked) {
      it.status = 'warn';
      it.detail = [it.detail, 'not invoked by any Task step — possible wrong agent pick'].filter(Boolean).join(' · ');
    }
  }

  // 'warn' is advisory (executor replans at runtime); only 'issue' blocks.
  const allClear = !items.some(i => i.status === 'issue' || i.status === 'pending');
  return { items, allClear };
}

module.exports = { computePlanCheck };
