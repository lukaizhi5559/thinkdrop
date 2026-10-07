'use strict';

/**
 * system-map.cjs — ThinkDrop's knowledge of its own filesystem.
 *
 * Single source of truth for what lives in ~/.thinkdrop/ and the project
 * logs/, plus small read helpers so lanes/agents can answer "I thought we
 * had X", "find the nylas plan", or "why did the last run fail" from real
 * data instead of guessing.
 *
 * Consumed by:
 *   - comms-graph/src/nodes/planning.cjs  (plan.find / plan.open / system.map / logs.tail tools)
 *   - comms-graph/src/nodes/statusCheck.cjs (plan probe)
 *   - mcp-services/command-service/src/skills/cli.agent.cjs (## ThinkDrop Environment block)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const THINKDROP_HOME = path.join(os.homedir(), '.thinkdrop');
const PLANS_DIR = path.join(THINKDROP_HOME, 'plans');

// ── ~/.thinkdrop layout ──────────────────────────────────────────────────────
// What each entry is for — the map an agent needs before it goes digging.
const LAYOUT = [
  ['plans/',              'saved task plans — plan_*.md files; frontmatter has status (drafting|ready|running|done|failed|cancelled), name, original_prompt; "## Task N" sections hold steps+status'],
  ['agents/',             'built service agents — one dir per agent (e.g. nylas.agent) with descriptor JSON + learned capabilities'],
  ['browser-profiles/',   'persistent per-service browser profiles — OAuth/login sessions live here; deleting one signs that service out'],
  ['browser-configs/',    'per-service browser automation config'],
  ['app-knowledge/',      'crawled docs/setup knowledge per app/service'],
  ['app-playbooks/',      'learned automation recipes per app'],
  ['domain-maps/',        'learned URL → action mappings from past browsing'],
  ['flows/',              'user-recorded/curated automation flows'],
  ['skills/',             'user-taught skills'],
  ['projects/',           'saved projects (builder output)'],
  ['brain/',              'proactive-brain state — thoughts, schedules, crons'],
  ['tokens/',             'auth tokens/credentials captured during setup'],
  ['data/',               'runtime data stores'],
  ['pipeline/',           'StateGraph pipeline artifacts'],
  ['copies/',             'files copied into ThinkDrop by the user (drag-drop/import)'],
  ['clipboard/',          'clipboard auto-capture history'],
  ['logs/',               'app-side logs (distinct from the dev logs/ in the repo)'],
  ['agent-profile/',      'browser-agent user profile dir'],
  ['print-profile/',      'print/PDF agent profile'],
  ['image-cache/',        'cached images served via thinkdrop-image://'],
  ['edits/',              'edit.agent working area'],
  ['extensions/',         'browser extensions loaded into agent browsers'],
  ['tmp/',                'scratch space'],
  ['cli.config.json',     'cli.agent configuration'],
  ['allowed-commands.json','shell command allowlist'],
  ['app-history.json',    'recent app/prompt history'],
  ['classify-cache.json', 'intent-classifier cache'],
  ['bridge.md',           'VS Code bridge file — read by the editor extension'],
  ['.crypto-bridge.json', 'crypto bridge config (port + key)'],
];

const SERVICE_PORTS = [
  ['3001', 'user-memory (facts, rules, profile)'],
  ['3002', 'web-search'],
  ['3004', 'conversation'],
  ['3005', 'coreference'],
  ['3006', 'voice-service'],
  ['3007', 'command-service (skills: shell.run, cli.agent, browser.agent, …)'],
  ['3008', 'screen-intelligence'],
  ['3009', 'phi4 (local LLM)'],
  ['3010', 'Electron overlay control (/comms.handoff lives here)'],
  ['3012', 'personality-service'],
  ['3015', 'comms-graph (planning, routing, task journal)'],
  ['5173', 'Vite dev server (renderer UI)'],
];

// ── Project root / logs ──────────────────────────────────────────────────────
let _projectRoot = null;
function projectRoot() {
  if (_projectRoot) return _projectRoot;
  if (process.env.THINKDROP_PROJECT_ROOT) {
    _projectRoot = process.env.THINKDROP_PROJECT_ROOT;
    return _projectRoot;
  }
  let dir = __dirname; // shared/ → repo root is one up
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'logs')) && fs.existsSync(path.join(dir, 'package.json'))) {
      _projectRoot = dir;
      return _projectRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _projectRoot = path.resolve(__dirname, '..'); // best guess
  return _projectRoot;
}

function logsDir() { return path.join(projectRoot(), 'logs'); }

function listLogs() {
  try {
    return fs.readdirSync(logsDir())
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const st = fs.statSync(path.join(logsDir(), f));
        return { file: f, sizeKb: Math.round(st.size / 1024), mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}

function tailLog(name, n = 80) {
  const safe = String(name || '').replace(/\.log$/i, '').replace(/[^\w-]/g, '');
  if (!safe) return '(no log name given — try: ' + listLogs().slice(0, 6).map(l => l.file).join(', ') + ')';
  const file = path.join(logsDir(), safe + '.log');
  if (!fs.existsSync(file)) {
    const avail = listLogs().map(l => l.file).join(', ') || '(none)';
    return `(no log "${safe}.log" — available: ${avail})`;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const tail = lines.slice(-Math.max(1, Math.min(n, 500)));
  return tail.length ? tail.join('\n') : `(${safe}.log is empty)`;
}

// ── Rendered blocks for prompts ──────────────────────────────────────────────
function renderLayout() {
  const rows = LAYOUT.map(([p, m]) => `  ${THINKDROP_HOME}/${p}${' '.repeat(Math.max(1, 24 - p.length))}— ${m}`);
  return `ThinkDrop data layout (~/.thinkdrop):\n${rows.join('\n')}\n\nService ports:\n`
    + SERVICE_PORTS.map(([p, s]) => `  ${p}  ${s}`).join('\n');
}

// Shorter block for the cli.agent agentic loop — diagnosis-oriented.
function renderEnvironment() {
  return [
    '## ThinkDrop Environment',
    `Project root: ${projectRoot()}`,
    `Service logs: ${logsDir()}/ — main.log (Electron main), comms-graph.log (planning/routing/handoffs), command.log (this service), plus per-service <name>.log files. When a step fails for non-CLI reasons (dispatch, planning, an agent that never ran), pty_exec "tail -n 100 ${logsDir()}/<name>.log" BEFORE concluding — the real error is usually there.`,
    `User data: ${THINKDROP_HOME}/ — plans/ (plan_*.md task plans with status frontmatter), agents/ (built agent descriptors), browser-profiles/ (OAuth sessions — a fresh profile means signed out), tokens/ (captured credentials).`,
    'Do not modify files under ~/.thinkdrop or logs/ — read-only diagnosis.',
  ].join('\n');
}

// ── Plan search ──────────────────────────────────────────────────────────────
const planFormat = require('./plan-format.cjs');

const _STOP = new Set(['the', 'a', 'an', 'plan', 'my', 'our', 'that', 'this', 'continue', 'resume', 'open', 'for', 'to']);
function _tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !_STOP.has(t));
}
function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function _planMeta(planId, filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = planFormat.parseFrontmatter(content) || {};
    const titleMatch = content.match(/^# Plan:\s*(.+)$/m);
    const tasks = planFormat.parseTasks(content);
    const doneCount = tasks.filter(t => /done/.test(String(t.status || ''))).length;
    return {
      planId,
      filePath,
      name: fm.name || null,
      title: titleMatch ? titleMatch[1].trim() : null,
      originalPrompt: fm.original_prompt || '',
      status: fm.status || 'drafting',
      totalTasks: tasks.length,
      pendingCount: tasks.length - doneCount,
      taskTitles: tasks.map(t => t.title || '').filter(Boolean),
    };
  } catch (_) { return null; }
}

/**
 * Search saved plans by name/title/prompt/task titles. Terminal-status plans
 * included — the point is finding what exists, not just what's open.
 * @param {string} query
 * @returns {Array} matches sorted by score desc, then mtime desc
 */
function findPlans(query) {
  const q = String(query || '').trim();
  if (!q || !fs.existsSync(PLANS_DIR)) return [];
  const qNorm = _norm(q);
  const qTokens = _tokens(q);
  const out = [];
  for (const f of fs.readdirSync(PLANS_DIR)) {
    if (!f.endsWith('.md') || !f.startsWith('plan')) continue;
    const filePath = path.join(PLANS_DIR, f);
    const planId = f.replace(/\.md$/, '');
    if (planId === q || planId === qNorm) {
      const meta = _planMeta(planId, filePath);
      if (meta) out.push({ ...meta, score: 100, mtime: fs.statSync(filePath).mtimeMs });
      continue;
    }
    const meta = _planMeta(planId, filePath);
    if (!meta) continue;
    const hay = _norm(`${meta.name || ''} ${meta.title || ''} ${meta.originalPrompt} ${meta.taskTitles.join(' ')}`);
    const hayTokens = _tokens(`${meta.name || ''} ${meta.title || ''} ${meta.originalPrompt} ${meta.taskTitles.join(' ')}`);
    const haySet = new Set(hayTokens);
    let score = 0;
    if (qNorm && hay.includes(qNorm)) score += 10;
    for (const t of qTokens) {
      if (haySet.has(t)) score += 3;
      else if (hay.includes(t)) score += 1; // substring (typos like nlyas still catch 'nylas' inside task text)
    }
    if (score > 0) out.push({ ...meta, score, mtime: fs.statSync(filePath).mtimeMs });
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return out;
}

/**
 * Plans the user could plausibly resume: not done/cancelled, and at least one
 * task not done. Failed plans qualify — reopening resets failed/skipped tasks.
 */
function resumablePlans() {
  if (!fs.existsSync(PLANS_DIR)) return [];
  const files = fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.md') && f.startsWith('plan'))
    .map(f => ({ f, mtime: fs.statSync(path.join(PLANS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { f, mtime } of files) {
    const meta = _planMeta(f.replace(/\.md$/, ''), path.join(PLANS_DIR, f));
    if (!meta) continue;
    if (/^(done|cancelled)$/i.test(meta.status)) continue;
    if (meta.pendingCount < 1) continue;
    out.push({ ...meta, mtime });
  }
  return out;
}

module.exports = {
  THINKDROP_HOME, PLANS_DIR,
  LAYOUT, SERVICE_PORTS,
  projectRoot, logsDir, listLogs, tailLog,
  renderLayout, renderEnvironment,
  findPlans, resumablePlans,
};
