'use strict';

/**
 * plan-steps.cjs — one step-normalization rule, two call sites:
 *   - comms-graph planning.cjs (write-back at generation time)
 *   - main.js planRunner (dispatch time — heals plans generated before fixes)
 *
 * Rules:
 *   1. Steps carrying args.url resolve through service-map: a registry-owned
 *      domain → the service's canonical agent (docs.new → google.agent), so
 *      auth'd services run on their signed-in profile instead of a generic
 *      browser lane.
 *   2. Other session-bound steps (they consume args.agentId browser lanes —
 *      dom.act, tab.map.agent, turn.loop.agent, …) get the task's canonical
 *      agent — one task = one browser window.
 *   3. Task agents are canonicalized and service agents moved to the front —
 *      they own the lockable session.
 *
 * @returns {{steps:Array, agents:string[], services:string[]}}
 */

const { canonicalAgent } = require('./agent-canonical.cjs');
const skillIndex = require('./skill-index.cjs');
const serviceMap = require('./service-map.cjs');

async function normalizeTaskStepsAsync(task) {
  // Resolve every step URL (with live discovery) up-front, then apply the same
  // pass-1/pass-2 logic as the sync version.
  const raw = Array.isArray(task.steps) ? task.steps : [];
  const urls = raw.map(s => s && s.args && typeof s.args.url === 'string' ? s.args.url : null);
  const svcs = await Promise.all(urls.map(u => u ? serviceMap.serviceForUrlAsync(u) : null));
  const resFor = (i) => svcs[i] || null;
  return _applyNormalization(task, resFor);
}

function normalizeTaskSteps(task) {
  const raw = Array.isArray(task.steps) ? task.steps : [];
  const resFor = (i) => {
    const url = raw[i] && raw[i].args && typeof raw[i].args.url === 'string' ? raw[i].args.url : null;
    return url ? serviceMap.serviceForUrl(url) : null;
  };
  return _applyNormalization(task, resFor);
}

function _applyNormalization(task, resFor) {
  const declared = (task.agents || []).map(a => canonicalAgent(a) || a).filter(Boolean);
  const taskAgent = declared[0] || null;
  const services = new Set();

  // Pass 1 — collect the services that own URL steps first so the primary
  // lane is known before assigning session-bound steps.
  const raw = Array.isArray(task.steps) ? task.steps : [];
  raw.forEach((s, i) => {
    const svc = resFor(i);
    if (svc) services.add(svc.canonicalAgent);
  });
  const laneAgent = services.size ? [...services][0] : taskAgent;

  // Pass 2 — assign agentIds.
  const steps = raw.map((s, i) => {
    if (!s || typeof s !== 'object') return s;
    const out = { ...s, args: { ...(s.args || {}) } };
    const svc = resFor(i);
    if (svc && typeof out.args.url === 'string') {
      out.args.agentId = svc.canonicalAgent;
      return out;
    }
    // Session-bound steps ride one window: the service lane when the task
    // touches a service, else the task's declared agent.
    if (skillIndex.isSessionBound(out.skill) && laneAgent) {
      out.args.agentId = laneAgent;
    }
    return out;
  });

  // Agents: service agents first (they own the session the lock must cover),
  // then the declared ones.
  const agents = [...new Set([...services, ...declared])];
  return { steps, agents, services: [...services] };
}

module.exports = { normalizeTaskSteps, normalizeTaskStepsAsync };
