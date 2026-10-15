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

// ── Doc-extract rewrite ─────────────────────────────────────────────────────
// Plans that route document text extraction through generic CLIs (pandoc —
// which cannot read PDFs — pdftotext, textutil, soffice, …) get rewritten to
// doc.read, the maintained skill backed by pdf_extract.py / docx_ops.py /
// xlsx_ops.py / pptx_extract.py with dep-check + pdftotext/textutil fallback.
// Running at normalize time heals both fresh plans (planning.cjs write-back)
// and saved plans (planRunner dispatch-time re-normalization).
const _DOC_EXTRACT_TOOL_RE = /\b(pandoc|pdftotext|pdf2txt|mutool|textutil|soffice|libreoffice|antiword|docx2txt|unoconv|in2csv)\b/i;
const _DOC_PATH_RE = /[^\s"',;&|`$()]+\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub)(?![\w.])/i;
const _CLI_SKILLS = new Set(['shell.run', 'cli.agent']);

function _docExtractPath(step) {
  const vals = [];
  for (const v of Object.values(step.args || {})) {
    if (typeof v === 'string') vals.push(v);
    else if (Array.isArray(v)) vals.push(...v.filter(x => typeof x === 'string'));
  }
  const blob = vals.join(' ');
  if (!_DOC_EXTRACT_TOOL_RE.test(blob)) return null;
  const m = blob.match(_DOC_PATH_RE);
  return m ? m[0] : null;
}

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
    let out = { ...s, args: { ...(s.args || {}) } };
    // Doc-extract rewrite — CLI conversion steps on document paths become
    // doc.read { path } (pandoc cannot read PDFs; the skill owns the chain).
    if (_CLI_SKILLS.has(out.skill)) {
      const docPath = _docExtractPath(out);
      if (docPath) {
        out = {
          ...out,
          skill: 'doc.read',
          args: { path: docPath },
          description: out.description || `Extract text from ${docPath.split('/').pop()}`,
        };
      }
    }
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

// Browser-family steps bound to a non-browser agent can't execute — observed:
// nylas.agent (type:'cli') handed url.first.agent + dom.act steps. Shared by
// planRunner (stored steps → drop to live planning) and planSkillsV2 (live
// plan → deterministic repair). Returns a reason string or null.
const AGENT_FAMILY_MISMATCH_SKILLS = new Set(['url.first.agent', 'dom.act', 'tab.map.agent', 'turn.loop.agent', 'browser.agent']);
function agentFamilyMismatch(steps) {
  for (const s of steps || []) {
    const agentId = s && s.args && s.args.agentId;
    if (!agentId || !AGENT_FAMILY_MISMATCH_SKILLS.has(s.skill)) continue;
    const desc = serviceMap.describeAgent(agentId)
      || serviceMap.describeAgent(String(agentId).replace(/\.agent$/, ''));
    if (desc && desc.type && desc.type !== 'browser') {
      return `${s.skill} step bound to ${desc.type} agent ${agentId}`;
    }
  }
  return null;
}

module.exports = { normalizeTaskSteps, normalizeTaskStepsAsync, agentFamilyMismatch, AGENT_FAMILY_MISMATCH_SKILLS };
