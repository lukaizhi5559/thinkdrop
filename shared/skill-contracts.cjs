'use strict';

/**
 * skill-contracts.cjs — machine-checkable arg contracts for the skill catalog.
 *
 * The prompt-side documentation of this vocabulary lives in
 * stategraph-module/src/prompts/plan-skills-core.md (the `skill|args:{…}|desc`
 * table). This file is the SAME contract made executable: comms-graph's
 * stepgen injects a compact vocabulary block, and the save/dispatch gate
 * validates emitted steps against it — so a malformed plan is rejected at
 * author time / save time, never discovered mid-run.
 *
 * Shape per skill:
 *   { desc, args: { name: 'type' | '?type' }, required: [names],
 *     sessionBound: bool, mutates: bool }
 *
 *   args entry — '?type' marks optional. Types: string, string[], number,
 *   boolean, object.
 *   required    — arg names that MUST be present.
 *   sessionBound— step drives a live browser/app session (needs agentId or a
 *                 resolved service; a plan replaying without one is unsafe).
 *   mutates     — step writes state (filesystem, repo, remote service, DOM).
 *                 Mutating steps in authored plans MUST carry literal args
 *                 resolved at compile time (shell.run cmd+argv, dom.act task
 *                 strings allowed since the DOM executor is the interpreter);
 *                 goal-mode shell.run and cli.agent task strings are the
 *                 LLM-wildcard forms the deterministic replay contract exists
 *                 to avoid.
 */

const CONTRACTS = {
  'synthesize': {
    desc: 'LLM summarize/answer/generate — always the final step for user-facing answers',
    args: { prompt: 'string', saveToFile: '?string', outputSchema: '?object' },
    required: [],
  },
  'fs.read': {
    desc: 'read local files / directory trees / code search (<=100KB)',
    args: { action: 'string', path: '?string', paths: '?string[]', maxFileSize: '?number', encoding: '?string' },
    required: [],
  },
  'shell.run': {
    desc: 'local shell command — goal-mode for fuzzy file ops OR literal cmd+argv for deterministic execution (never both)',
    args: { goal: '?string', cmd: '?string', argv: '?string[]', cwd: '?string', timeoutMs: '?number' },
    required: [],
    mutates: true,
  },
  'doc.read': {
    desc: 'extract text from documents (pdf/docx/xlsx/pptx/rtf/odt/html)',
    args: { path: 'string', maxChars: '?number' },
    required: ['path'],
  },
  'media.transcribe': {
    desc: 'transcribe a LOCAL audio/video file to text (Whisper)',
    args: { path: 'string', language: '?string', model: '?string' },
    required: ['path'],
  },
  'edit.agent': {
    desc: 'edit local files safely — semantic edits, targeted ops, draft/apply modes',
    args: { goal: 'string', filePath: 'string', mode: '?string', draftPath: '?string', agentContext: '?string' },
    required: ['goal', 'filePath'],
    mutates: true,
  },
  'url.first.agent': {
    desc: 'navigate the shared browser session to a service URL (deep-link + auth-wall aware) — the ONLY navigation skill for browser tasks',
    args: { agentId: '?string', service: '?string', task: '?string', url: '?string', sessionId: '?string' },
    required: [],
    sessionBound: true,
  },
  'dom.act': {
    desc: 'ONE on-page action (click/type/submit/select/scroll/keypress) on the CURRENT page — router picks the executor from live DOM state',
    args: { task: 'string', goal: '?string', agentId: '?string', agentHint: '?string', pageCategory: '?string', sessionId: '?string' },
    required: [],
    sessionBound: true,
    mutates: true,
  },
  'form.fill.agent': {
    desc: 'fill a multi-field web form deterministically (profile/memory values, asks only for missing required) — NEVER submits',
    args: { task: 'string', agentId: '?string', sessionId: '?string', fields: '?object', only: '?string[]', overwrite: '?boolean' },
    required: [],
    sessionBound: true,
    mutates: true,
  },
  'turn.loop.agent': {
    desc: 'multi-step interactive browsing; mode:verify observes without mutating',
    args: { goal: 'string', mode: '?string', sessionId: '?string' },
    required: [],
    sessionBound: true,
    mutates: true,
  },
  'browser.agent': {
    desc: 'browser AGENT MANAGEMENT only (build_agent/extract_items/list/resolve_deep_link) — not navigation or research',
    args: { action: 'string', agentId: '?string', task: '?string', service: '?string' },
    required: ['action'],
  },
  'cli.agent': {
    desc: 'CLI-backed services (gh/aws/heroku) and known CLI tools — agentic loop, prefer literal shell.run argv for deterministic mutations',
    args: { action: 'string', agentId: '?string', task: '?string', service: '?string' },
    required: ['action'],
  },
  'terminal.agent': {
    desc: 'real PTY terminal sessions for interactive tools (installers, wizards, REPLs, ssh)',
    args: { action: 'string', sessionId: '?string', cmd: '?string', text: '?string', ctrl: '?string', match: '?string', timeoutMs: '?number', cwd: '?string', env: '?object', label: '?string' },
    required: ['action'],
    mutates: true,
  },
  'mcp.agent': {
    desc: 'external MCP servers (JSON-RPC) — call only INSTALLED server names',
    args: { action: 'string', server: '?string', tool: '?string', args: '?object', name: '?string', command: '?string', url: '?string', env: '?object' },
    required: ['action'],
  },
  'app.agent': {
    desc: 'native macOS app automation via shortcuts + OCR; run_agent drives an app\'s built-in AI assistant',
    args: { action: 'string', appName: '?string', goal: '?string', searchText: '?string', filePath: '?string', prompt: '?string' },
    required: ['action'],
    mutates: true,
  },
  'web.agent': {
    desc: 'public web research — search/site_search/research_domain/get_tutorial_steps/find_download (no session/auth)',
    args: { action: 'string', query: '?string', domain: '?string', preferDomain: '?string', fileExt: '?string' },
    required: ['action'],
  },
  'web.crawl': {
    desc: 'fetch readable text/items/media from a public URL (headless, no auth/interaction)',
    args: { url: 'string', maxChars: '?number', timeoutMs: '?number', extractLinks: '?boolean', extractItems: '?boolean', extractMedia: '?boolean' },
    required: ['url'],
  },
  'video.agent': {
    desc: 'watch/transcribe video — always wins over ytdlp for watch/transcribe verbs',
    args: { action: 'string', videoUrl: '?string', platform: '?string', query: '?string', goal: 'string' },
    required: [],
  },
  'provider.discovery': {
    desc: 'LLM provider/model management (list/switch/discover/add/remove/health)',
    args: { action: 'string', provider: '?string', modelId: '?string', taskType: '?string', query: '?string', name: '?string', baseURL: '?string', envKey: '?string' },
    required: ['action'],
  },
  'schedule': {
    desc: 'wait until clock time or delay, then continue the plan',
    args: { time: '?string', delayMs: '?number', label: '?string' },
    required: [],
  },
  'user.agent': {
    desc: 'resolve user personal data (name/phone/email/address) from profile+memory',
    args: { action: 'string', fields: '?string[]', contact: '?string', topic: '?string' },
    required: ['action'],
  },
  'screen.display': {
    desc: 'render a scene/chart/deck on the GhostLayer overlay',
    args: { kind: 'string', scene: '?object', blocking: '?boolean' },
    required: ['kind'],
  },
};

const ARG_TYPE_RE = {
  string:  v => typeof v === 'string',
  'string[]': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
  number:  v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  object:  v => v !== null && typeof v === 'object' && !Array.isArray(v),
};

function _checkType(value, spec) {
  const t = spec.replace(/^\?/, '');
  const fn = ARG_TYPE_RE[t];
  return fn ? fn(value) : true; // unknown type tags don't block
}

/**
 * Validate a step list against the contracts.
 * @returns {{ ok:boolean, violations:Array<{step:number, skill:string, field:string, msg:string}> }}
 *
 * Rules:
 *  - skill must exist in the catalog
 *  - required args present and non-empty
 *  - arg types match when the arg is present
 *  - unknown args are flagged (typo-catching; tolerated but reported)
 *  - shell.run steps must not carry BOTH goal and cmd (the xor contract)
 *  - mutating steps emitted as cli.agent task-strings or shell.run goal-strings
 *    are flagged 'wildcard' — the compiler resolved nothing; a deterministic
 *    replay has nothing to execute. Warned, not blocked (agentic lanes still
 *    legitimately emit these — only authored-plan saves should hard-gate).
 */
function validatePlanSteps(steps, { strict = false } = {}) {
  const violations = [];
  if (!Array.isArray(steps)) return { ok: false, violations: [{ step: -1, skill: '', field: 'steps', msg: 'steps is not an array' }] };
  steps.forEach((step, i) => {
    const skill = step && step.skill;
    const c = skill && CONTRACTS[skill];
    if (!c) {
      violations.push({ step: i, skill: String(skill || ''), field: 'skill', msg: `unknown skill "${skill}"` });
      return;
    }
    const args = (step.args && typeof step.args === 'object') ? step.args : {};
    for (const req of c.required) {
      const v = args[req];
      if (v === undefined || v === null || v === '') {
        violations.push({ step: i, skill, field: req, msg: `required arg "${req}" missing` });
      }
    }
    for (const [name, spec] of Object.entries(c.args)) {
      const v = args[name];
      if (v === undefined) continue;
      if (!_checkType(v, spec)) {
        violations.push({ step: i, skill, field: name, msg: `arg "${name}" expected ${spec.replace(/^\?/, '')}, got ${Array.isArray(v) ? 'array' : typeof v}` });
      }
    }
    for (const name of Object.keys(args)) {
      if (!(name in c.args)) {
        violations.push({ step: i, skill, field: name, msg: `unknown arg "${name}" for ${skill}` });
      }
    }
    if (skill === 'shell.run' && args.goal && args.cmd) {
      violations.push({ step: i, skill, field: 'goal', msg: 'shell.run takes goal XOR cmd+argv — never both' });
    }
    // Wildcard check — a mutating step with nothing compiled: cli.agent's
    // natural-language task or shell.run's goal-mode re-decide the command at
    // replay time. Flagged so save gates can refuse uncompiled procedures.
    if (skill === 'cli.agent' && typeof args.task === 'string' && args.task) {
      violations.push({ step: i, skill, field: 'task', msg: 'wildcard: cli.agent task string re-plans at replay — compile to literal argv or a real service agent step' });
    }
    if (skill === 'shell.run' && args.goal && !args.cmd) {
      violations.push({ step: i, skill, field: 'goal', msg: 'wildcard: shell.run goal-mode re-plans at replay — prefer literal cmd+argv for mutations' });
    }
    if (c.sessionBound && !args.agentId && !args.service && !args.sessionId && !args.url) {
      violations.push({ step: i, skill, field: 'agentId', msg: `session-bound step ${skill} names no agentId/service/sessionId — replay cannot reattach` });
    }
  });
  const blocking = strict ? violations : violations.filter(v => v.msg.startsWith('wildcard:') === false);
  return { ok: blocking.length === 0, violations };
}

/** Contract for one skill (or null). */
function contractFor(skill) { return CONTRACTS[skill] || null; }

/** All catalog skill names. */
function listSkills() { return Object.keys(CONTRACTS); }

/**
 * Compact vocabulary block for stepgen prompts — the contract table in the
 * same `name{args} — what it does` form the core canon already teaches.
 */
function contractsVocabularyBlock() {
  const lines = ['## Skill contracts (authoritative arg schemas)'];
  for (const [name, c] of Object.entries(CONTRACTS)) {
    const argBits = Object.entries(c.args).map(([k, v]) => `${k}${v.startsWith('?') ? '?' : ''}`).join(', ');
    lines.push(`- ${name}{${argBits}} — ${c.desc}`);
  }
  lines.push(
    '',
    'Mutation discipline (compile-time vs run-time): a step that changes state MUST carry literal args resolved NOW — shell.run {cmd, argv:[…]}, dom.act/app.agent/turn.loop.agent goal strings (their executor is the interpreter), edit.agent {goal,filePath}. NEVER emit cli.agent task-strings or shell.run goal-strings for a mutating step: those are re-planned at replay and have pushed commands into the wrong repository. For per-run dynamic content (commit messages, summaries), compose: a synthesize step produces the text and {{PREV_OUTPUT}} / {{synthesisAnswer}} pipes it into a literal-argv step.'
  );
  return lines.join('\n');
}

module.exports = { CONTRACTS, validatePlanSteps, contractFor, listSkills, contractsVocabularyBlock };
