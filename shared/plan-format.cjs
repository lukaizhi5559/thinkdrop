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
 *   refs: [{"type":"file|folder|plan","path":"…"}]   (JSON — context references
 *   carried downstream to every task dispatch; the .md is the durable carrier)
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

// ── Context refs (frontmatter `refs:` JSON array) ────────────────────────────

/**
 * Parse the frontmatter `refs:` array.
 * @returns {Array<{type:string,path:string,note?:string}>}
 */
function parseRefs(content) {
  const fm = parseFrontmatter(content);
  if (!fm || !fm.refs) return [];
  try {
    const parsed = JSON.parse(fm.refs);
    return Array.isArray(parsed) ? parsed.filter(r => r && typeof r.path === 'string') : [];
  } catch (_) {
    return [];
  }
}

/**
 * Merge new refs into the frontmatter `refs:` array (dedupe by path).
 */
function upsertRefs(content, refs) {
  const merged = parseRefs(content);
  const seen = new Set(merged.map(r => r.path));
  for (const r of (refs || [])) {
    if (!r || typeof r.path !== 'string' || seen.has(r.path)) continue;
    seen.add(r.path);
    merged.push(r);
  }
  return setFrontmatterField(content, 'refs', JSON.stringify(merged));
}

// ── Task section parser ───────────────────────────────────────────────────────

const _TASK_BLOCK_RE = /## Task (\d+)\s*[—\-–:]*\s*([^\n]*)\n([\s\S]*?)(?=## Task \d+|## |\n#[^#]|$)/g;
const _FIELD_RE = /- \*\*([^*]+)\*\*:\s*(.+)/g;

/**
 * Blank out the CONTENT of ``` fenced blocks, keeping the fence markers and
 * every newline — output is the same length as input so match offsets line up
 * with the original string. Structural regexes (task boundaries, `- **Field**:`
 * lines) must run against the masked copy: step JSON routinely contains
 * markdown-looking text (`## ` headings, `- **Status**:` lines) that would
 * otherwise truncate a task body mid-fence or spoof a field write.
 */
function _maskCodeFences(text) {
  return String(text).replace(/```([\s\S]*?)(```|$)/g,
    (m, inner, close) => '```' + inner.replace(/[^\n]/g, ' ') + close);
}

/**
 * Locate `## Task N`'s body span — N is digit-boundaried (Task 1 ≠ Task 12)
 * and the body boundary is computed on the fence-masked copy so `## ` inside
 * step JSON can't end the task early, and the span can never run into the
 * next task's body.
 */
function _taskSpan(content, taskNum) {
  const text = String(content || '');
  const masked = _maskCodeFences(text);
  const re = new RegExp(
    `## Task ${taskNum}(?![0-9])[^\\n]*\\n([\\s\\S]*?)(?=## Task \\d+|## |\\n#[^#]|$)`);
  const m = re.exec(masked);
  if (!m) return null;
  const bodyEnd = m.index + m[0].length;
  return {
    bodyStart: bodyEnd - m[1].length,
    bodyEnd,
    body: text.slice(bodyEnd - m[1].length, bodyEnd),
  };
}

/** Run `fn(body)` inside `## Task N`'s body and splice the result back. */
function _rewriteTaskBody(content, taskNum, fn) {
  const text = String(content || '');
  const span = _taskSpan(text, taskNum);
  if (!span) return text;
  const nextBody = fn(span.body, _maskCodeFences(span.body));
  if (nextBody === span.body) return text;
  return text.slice(0, span.bodyStart) + nextBody + text.slice(span.bodyEnd);
}

/** Replace the whole `- **Field**: …` line inside a task body (masked-located). */
function _setFieldLine(body, field, value) {
  const masked = _maskCodeFences(body);
  const re = new RegExp(`- \\*\\*${field}\\*\\*: ?[^\\n]*`);
  const m = re.exec(masked);
  if (!m) return body;
  return body.slice(0, m.index) + `- **${field}**: ${value}` + body.slice(m.index + m[0].length);
}

/** Remove the `- **Field**: …` line (with its newline) inside a task body. */
function _dropFieldLine(body, field) {
  const masked = _maskCodeFences(body);
  const re = new RegExp(`- \\*\\*${field}\\*\\*: ?[^\\n]*\\n?`);
  const m = re.exec(masked);
  if (!m) return body;
  return body.slice(0, m.index) + body.slice(m.index + m[0].length);
}

/** Insert `line` before `- **Field**:` inside a task body (masked-located). */
function _insertBeforeField(body, field, line) {
  const masked = _maskCodeFences(body);
  const re = new RegExp(`- \\*\\*${field}\\*\\*: `);
  const m = re.exec(masked);
  if (!m) return body;
  return body.slice(0, m.index) + line + body.slice(m.index);
}

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
  // Task/field boundaries are matched on the fence-masked copy — markdown
  // inside a steps JSON block (## headings, - **Field**: lines) is invisible
  // there, so it can't truncate the body or spoof a field.
  const masked = _maskCodeFences(text);
  _TASK_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = _TASK_BLOCK_RE.exec(masked)) !== null) {
    const num = parseInt(m[1], 10);
    const title = (m[2] || '').trim() || `Task ${num}`;
    const maskedBody = m[3] || '';
    const bodyEnd = m.index + m[0].length;
    const body = text.slice(bodyEnd - maskedBody.length, bodyEnd);
    const fields = {};
    _FIELD_RE.lastIndex = 0;
    let fm;
    while ((fm = _FIELD_RE.exec(maskedBody)) !== null) {
      // Field value comes from the ORIGINAL line (masked slice is identical
      // outside fences, but a value may itself contain backticks).
      const line = body.slice(fm.index, fm.index + fm[0].length);
      const v = line.match(/- \*\*[^*]+\*\*:\s*(.+)/);
      fields[fm[1].trim().toLowerCase()] = (v ? v[1] : '').trim();
    }
    tasks.push({
      num,
      title,
      prompt:    (fields.prompt || '').trim(),
      steps:     _parseStepsBlock(body),
      agents:    _parseAgents(fields.agents),
      dependsOn: _parseDependsOn(fields['depends on']),
      mode:      VALID_TASK_MODES.has((fields.mode || '').toLowerCase())
                   ? fields.mode.toLowerCase() : 'sequential',
      auth:      (fields.auth || 'unknown').trim(),
      refs:      _parseAgents(fields.refs).map(p => ({ type: 'path', path: p })),
      stepsStatus: (fields['steps status'] || '').trim() || null,
      approval:  (fields.approval || '').trim().toLowerCase() === 'required' ? 'required' : null,
      doneWhen:  (fields['done when'] || '').trim() || null,
      status:    (fields.status || TASK_STATUS.PENDING).trim(),
      result:    (fields.result || '').replace(/^—$/, '').trim(),
      body,
    });
  }
  return tasks;
}

/**
 * Parse the `**Steps**` fenced JSON block inside a task body.
 * Shape: `- **Steps**:` then a ```json [{skill,args,description},…] ``` fence.
 * @returns {Array|null} parsed steps, or null when absent/malformed.
 */
function _parseStepsBlock(body) {
  const m = String(body || '').match(/- \*\*Steps\*\*:[^\n]*\n\s*```(?:json)?\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch (_) {
    return null;
  }
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
  if (Array.isArray(task.refs) && task.refs.length) {
    lines.push(`- **Refs**: ${task.refs.map(r => (typeof r === 'string' ? r : r.path)).filter(Boolean).join(' | ')}`);
  }
  if (Array.isArray(task.steps) && task.steps.length) {
    lines.push('- **Steps**:');
    lines.push('```json');
    lines.push(JSON.stringify(task.steps));
    lines.push('```');
  }
  if (task.stepsStatus) lines.push(`- **Steps Status**: ${task.stepsStatus}`);
  if (task.approval === 'required') lines.push('- **Approval**: required');
  lines.push(`- **Status**: ${task.status || TASK_STATUS.PENDING}`);
  lines.push(`- **Result**: ${task.result || '—'}`);
  return lines.join('\n');
}

/**
 * Build a fresh v2 plan document.
 * @param {Object} o - { id, title, description, originalPrompt, sessionId, tasks[], refs[] }
 */
function newPlanContent({ id, title, description, originalPrompt, sessionId, tasks, refs }) {
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
    `refs: ${JSON.stringify(Array.isArray(refs) ? refs : [])}`,
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
  return _rewriteTaskBody(content, taskNum, (body) => {
    let next = _setFieldLine(body, 'Status', status);
    if (result !== undefined && result !== null) {
      const snippet = String(result).slice(0, 300).replace(/\n/g, ' ');
      next = _setFieldLine(next, 'Result', snippet || '(no result)');
    }
    return next;
  });
}

/**
 * Insert or replace the `**Steps**` fenced block on `## Task N` in place.
 * Keeps user edits to other fields intact; replaces only the steps block.
 */
function updateTaskSteps(content, taskNum, steps) {
  const block = `- **Steps**:\n\`\`\`json\n${JSON.stringify(steps)}\n\`\`\`\n`;
  return _rewriteTaskBody(content, taskNum, (body, maskedBody) => {
    // Locate the existing steps block in the MASKED body (fence content is
    // blank there, so a `## ` inside step JSON can't hide the fence) — then
    // splice the replacement into the original by offset.
    const m = /- \*\*Steps\*\*:[^\n]*\n\s*```(?:[^\n])*?\n[\s\S]*?```\n?/.exec(maskedBody);
    if (m) return body.slice(0, m.index) + block + body.slice(m.index + m[0].length);
    // No steps block yet — insert before the **Status** line.
    const next = _insertBeforeField(body, 'Status', block);
    if (next !== body) return next;
    return body + (body.endsWith('\n') ? '' : '\n') + block;
  });
}

function updateTaskAgents(content, taskNum, agents) {
  const value = (agents && agents.length ? agents.join(' | ') : '—');
  return _rewriteTaskBody(content, taskNum, (body) => _setFieldLine(body, 'Agents', value));
}

/**
 * Insert or clear the `- **Steps Status**:` field on `## Task N`.
 * `status=null` removes the line entirely.
 */
function updateTaskStepsStatus(content, taskNum, status) {
  return _rewriteTaskBody(content, taskNum, (body) => {
    let next = _dropFieldLine(body, 'Steps Status');
    if (status) next = _insertBeforeField(next, 'Status', `- **Steps Status**: ${status}\n`);
    return next;
  });
}

/**
 * Insert or clear the `- **Approval**:` field on `## Task N`.
 * `value=null` removes the line entirely.
 */
function updateTaskApproval(content, taskNum, value) {
  return _rewriteTaskBody(content, taskNum, (body) => {
    let next = _dropFieldLine(body, 'Approval');
    if (value) next = _insertBeforeField(next, 'Status', `- **Approval**: ${value}\n`);
    return next;
  });
}

function updateTaskAuth(content, taskNum, auth) {
  return _rewriteTaskBody(content, taskNum, (body) => _setFieldLine(body, 'Auth', auth));
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
    if (/- \*\*Steps\*\*:/.test(t.body)) {
      if (!Array.isArray(t.steps)) warnings.push(`Task ${t.num}: **Steps** block is not valid JSON`);
      else for (const s of t.steps) {
        if (!s || typeof s.skill !== 'string' || !s.skill) {
          warnings.push(`Task ${t.num}: step missing "skill"`); break;
        }
      }
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
  parseRefs,
  upsertRefs,
  parseTasks,
  isTaskPlan,
  serializeTask,
  newPlanContent,
  updateTaskStatus,
  updateTaskAuth,
  updateTaskSteps,
  updateTaskStepsStatus,
  updateTaskApproval,
  updateTaskAgents,
  validateTaskPlan,
  isValidDotName,
  deriveDotName,
  extractDotNameFromPrompt,
};
