'use strict';

/**
 * plan-format.cjs — Canonical ThinkDrop plan.md (v2 "Tasks") format helpers.
 *
 * Single source of truth for the multi-Task plan document shape shared by:
 *   - comms-graph planning lane (nodes/planning.cjs writes/updates drafts)
 *   - comms-graph planPreflight.cjs (reads Task agents/auth fields)
 *   - src/main/planRunner.js (reads Tasks, writes status back on completion)
 *   - stategraph-module (utils/planFormat.cjs shim → here)
 *
 * Plan file shape:
 *   ---
 *   id: plan_…        created: ISO      status: drafting|ready|running|done|failed|cancelled
 *   name: dot.syntax  plan_session_id:…  original_prompt: "…"   auth_bypass: []
 *   ---
 *   # Plan: <title>
 *   <description>
 *   ## Task N — <title>
 *   - **Prompt**: <self-contained task prompt handed to a stategraph run>
 *   - **Agents**: agent.id | other.agent
 *   - **Depends on**: — | Task 1, Task 3
 *   - **Mode**: sequential | parallel
 *   - **Auth**: authed | needs sign-in | bypassed | none-required | unknown
 *   - **Done when**: <optional checkable success criterion>
 *   - **Status**: ⬜ pending | 🔄 running | ✅ done | ❌ failed | ⏭ skipped
 *   - **Result**: —
 *   ## Risks
 *   - …
 *
 * Plans WITHOUT `## Task` sections are v1 single-pass plans (## Steps) —
 * isTaskPlan() distinguishes them; planExecutor keeps owning those.
 */

// ── Status vocabulary ─────────────────────────────────────────────────────────

const TASK_STATUS = {
  PENDING: '⬜ pending',
  RUNNING: '🔄 running',
  DONE:    '✅ done',
  FAILED:  '❌ failed',
  SKIPPED: '⏭ skipped',
};

const PLAN_STATUSES = new Set(['drafting', 'ready', 'running', 'done', 'failed', 'cancelled']);

const VALID_TASK_MODES = new Set(['sequential', 'parallel']);

const VALID_TASK_AUTH = new Set(['authed', 'needs sign-in', 'bypassed', 'none-required', 'unknown']);

// ── Frontmatter ───────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

function updateFrontmatterStatus(content, status) {
  return String(content || '').replace(/^(status:\s*)[^\n]+/m, `$1${status}`);
}

function setFrontmatterField(content, key, value) {
  const text = String(content || '');
  const re = new RegExp(`^(${key}:\\s*)[^\\n]+`, 'm');
  if (re.test(text)) return text.replace(re, `$1${value}`);
  // Insert before the closing --- of the frontmatter block
  return text.replace(/^(---\n[\s\S]*?)(\n---)/, `$1\n${key}: ${value}$2`);
}

// ── Task section parser ───────────────────────────────────────────────────────

const _TASK_BLOCK_RE = /## Task (\d+)\s*[—\-–:]*\s*([^\n]*)\n([\s\S]*?)(?=## Task \d+|## |\n#[^#]|$)/g;
const _FIELD_RE = /- \*\*([^*]+)\*\*:\s*(.+)/g;

function _parseDependsOn(raw) {
  const out = [];
  const nums = String(raw || '').match(/\bTask\s+(\d+)/gi) || [];
  for (const d of nums) {
    const n = parseInt(d.replace(/\D/g, ''), 10);
    if (!isNaN(n)) out.push(n);
  }
  return out;
}

function _parseAgents(raw) {
  return String(raw || '')
    .split(/[|,]/)
    .map(s => s.trim())
    .filter(s => s && s !== '—' && s !== 'none');
}

/**
 * Parse `## Task N` sections from plan content.
 * @returns {Array<{num,title,prompt,agents,dependsOn,mode,auth,doneWhen,status,result,body}>}
 */
function parseTasks(content) {
  const tasks = [];
  const text = String(content || '');
  _TASK_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = _TASK_BLOCK_RE.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    const title = (m[2] || '').trim() || `Task ${num}`;
    const body = m[3] || '';
    const fields = {};
    _FIELD_RE.lastIndex = 0;
    let fm;
    while ((fm = _FIELD_RE.exec(body)) !== null) {
      fields[fm[1].trim().toLowerCase()] = fm[2].trim();
    }
    tasks.push({
      num,
      title,
      prompt:    (fields.prompt || '').trim(),
      agents:    _parseAgents(fields.agents),
      dependsOn: _parseDependsOn(fields['depends on']),
      mode:      VALID_TASK_MODES.has((fields.mode || '').toLowerCase())
                   ? fields.mode.toLowerCase() : 'sequential',
      auth:      (fields.auth || 'unknown').trim(),
      doneWhen:  (fields['done when'] || '').trim() || null,
      status:    (fields.status || TASK_STATUS.PENDING).trim(),
      result:    (fields.result || '').replace(/^—$/, '').trim(),
      body,
    });
  }
  return tasks;
}

/** True when plan content uses the v2 `## Task` layout (vs v1 `## Steps`). */
function isTaskPlan(content) {
  return /## Task \d+/.test(String(content || ''));
}

// ── Task serializer ───────────────────────────────────────────────────────────

function serializeTask(task) {
  const lines = [];
  lines.push(`## Task ${task.num} — ${task.title}`);
  lines.push(`- **Prompt**: ${task.prompt}`);
  lines.push(`- **Agents**: ${(task.agents && task.agents.length ? task.agents.join(' | ') : '—')}`);
  lines.push(`- **Depends on**: ${(task.dependsOn && task.dependsOn.length ? task.dependsOn.map(n => `Task ${n}`).join(', ') : '—')}`);
  lines.push(`- **Mode**: ${task.mode || 'sequential'}`);
  lines.push(`- **Auth**: ${task.auth || 'unknown'}`);
  if (task.doneWhen) lines.push(`- **Done when**: ${task.doneWhen}`);
  lines.push(`- **Status**: ${task.status || TASK_STATUS.PENDING}`);
  lines.push(`- **Result**: ${task.result || '—'}`);
  return lines.join('\n');
}

/**
 * Build a fresh v2 plan document.
 * @param {Object} o - { id, title, description, originalPrompt, sessionId, tasks[] }
 */
function newPlanContent({ id, title, description, originalPrompt, sessionId, tasks }) {
  const now = new Date().toISOString();
  const safePrompt = String(originalPrompt || '').replace(/"/g, '\\"').slice(0, 300);
  const lines = [
    '---',
    `id: ${id}`,
    `created: ${now}`,
    'kind: task_plan',
    'status: drafting',
    `original_prompt: "${safePrompt}"`,
    `plan_session_id: ${sessionId || 'unknown'}`,
    'auth_bypass: []',
    '---',
    '',
    `# Plan: ${title}`,
    '',
    description || '',
    '',
    '## Tasks',
    '',
  ];
  for (const t of (tasks || [])) {
    lines.push(serializeTask(t), '');
  }
  lines.push('## Risks', '');
  return lines.join('\n');
}

// ── Status write-back ─────────────────────────────────────────────────────────

/**
 * Update the **Status** (and optionally **Result**) of `## Task N` in place.
 * Mirrors planScanner.updateStepStatus semantics for the Task layout.
 */
function updateTaskStatus(content, taskNum, status, result) {
  let updated = String(content || '');
  const statusRe = new RegExp(
    `(## Task ${taskNum}[^\\n]*\\n[\\s\\S]*?)(- \\*\\*Status\\*\\*: )[^\\n]+(\\n)`, 'g');
  updated = updated.replace(statusRe, (m, before, label, nl) => before + label + status + nl);
  if (result !== undefined && result !== null) {
    const resultRe = new RegExp(
      `(## Task ${taskNum}[^\\n]*\\n[\\s\\S]*?)(- \\*\\*Result\\*\\*: )[^\\n]+(\\n)`, 'g');
    const snippet = String(result).slice(0, 300).replace(/\n/g, ' ');
    updated = updated.replace(resultRe, (m, before, label, nl) =>
      before + label + (snippet || '(no result)') + nl);
  }
  return updated;
}

function updateTaskAuth(content, taskNum, auth) {
  return String(content || '').replace(
    new RegExp(`(## Task ${taskNum}[^\\n]*\\n[\\s\\S]*?)(- \\*\\*Auth\\*\\*: )[^\\n]+(\\n)`, 'g'),
    (m, before, label, nl) => before + label + auth + nl);
}

// ── Dot-syntax plan names (canonical home — planCacheHelpers re-exports) ───────

const DOT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const MAX_DOT_SEGMENTS = 5;

function isValidDotName(name) {
  if (!name || typeof name !== 'string') return false;
  if (!DOT_NAME_RE.test(name)) return false;
  const segments = name.split('.');
  return segments.length >= 2 && segments.length <= MAX_DOT_SEGMENTS;
}

function deriveDotName(title) {
  const stopWords = new Set(['a','an','the','for','to','in','on','at','of','and','or','with','from','by','check','find','get','run','go']);
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))
    .slice(0, 5);
  if (words.length < 2) return '';
  const candidate = words.join('.');
  return isValidDotName(candidate) ? candidate : '';
}

function extractDotNameFromPrompt(prompt) {
  const match = String(prompt || '').match(/\b([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,4})\b/);
  if (match && isValidDotName(match[1])) return match[1];
  return null;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateTaskPlan(content) {
  const errors = [];
  const warnings = [];
  const text = String(content || '');
  if (!text.trim()) return { valid: false, errors: ['Plan content is empty'], warnings };

  const fm = parseFrontmatter(text);
  if (!fm) errors.push('Missing frontmatter block');
  else {
    if (!fm.id) warnings.push('Frontmatter missing "id"');
    if (!fm.status) warnings.push('Frontmatter missing "status"');
  }
  if (!/^# Plan:/m.test(text)) errors.push('Missing "# Plan:" title heading');

  const tasks = parseTasks(text);
  if (tasks.length === 0) errors.push('No "## Task N" sections found');
  const nums = new Set();
  for (const t of tasks) {
    if (nums.has(t.num)) errors.push(`Duplicate Task number ${t.num}`);
    nums.add(t.num);
    if (!t.prompt) errors.push(`Task ${t.num}: missing **Prompt** field`);
    for (const dep of t.dependsOn) {
      if (dep >= t.num) warnings.push(`Task ${t.num}: depends on Task ${dep} which does not precede it`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

module.exports = {
  TASK_STATUS,
  PLAN_STATUSES,
  parseFrontmatter,
  updateFrontmatterStatus,
  setFrontmatterField,
  parseTasks,
  isTaskPlan,
  serializeTask,
  newPlanContent,
  updateTaskStatus,
  updateTaskAuth,
  validateTaskPlan,
  isValidDotName,
  deriveDotName,
  extractDotNameFromPrompt,
};
