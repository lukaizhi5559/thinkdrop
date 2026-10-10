'use strict';

/**
 * capability-index.cjs — unified capability search + read-only probing.
 *
 * One entry point answering "what can accomplish X?" across every execution
 * surface ThinkDrop has:
 *
 *   - registered service agents (service-map scan: type, cliTool, secrets)
 *   - cli-registry.json capability/provider entries
 *   - external MCP servers (seed registry + ~/.thinkdrop/mcp-servers.json)
 *   - zero-install platform affordances (darwin: osascript, say, crontab…)
 *
 * Each candidate carries a FRICTION score (lower = easier setup, matching
 * the "easiest to setup first" rule of thumb) and a canned setupSummary
 * phrase (voice-ready), so planning can rank and speak options without
 * inventing either.
 *
 *   0  installed & no-auth
 *   1  installed & env-key stored
 *   2  install needed, no auth
 *   3  env-key needed (paste once)
 *   4  oauth device-flow
 *   5  oauth browser
 *   6  paid/signup-heavy
 *
 * capabilityProbe() is the planning lane's read-only eyeball: verb-gated,
 * spawn-without-shell execution (no `;|>` chains possible), bounded, and
 * never injects resolved secrets. Denied probes are logged for audit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const serviceMap = require('./service-map.cjs');
const { resolveAgentSecrets } = require('./secret-resolve.cjs');

const DEFAULT_CLI_REGISTRY = path.join(__dirname, '..', 'mcp-services', 'command-service', 'src', 'cli-registry.json');
const MCP_SERVERS_PATH = path.join(os.homedir(), '.thinkdrop', 'mcp-servers.json');
const MCP_SEED_PATH = path.join(__dirname, 'mcp-registry-seed.json');
const PROBE_LOG = path.join(os.homedir(), '.thinkdrop', 'logs', 'capability-probes.log');
const PREFLIGHT_CACHE = path.join(os.homedir(), '.thinkdrop', 'preflight-auth-cache.json');

const SETUP_SUMMARIES = {
  0: 'no setup needed',
  1: 'already set up',
  2: 'one quick install',
  3: 'needs an API key (paste once)',
  4: 'needs a quick sign-in code',
  5: 'needs sign-in through your browser',
  6: 'needs a paid account',
};

// Voice/UI-ready effort estimate per friction tier — the "what you're getting
// into" line. Written in second person where the user must act.
const SETUP_ETA = {
  0: 'ready now',
  1: 'ready now',
  2: '~1 min — I handle the install',
  3: '~2 min — you paste a key once',
  4: '~2 min — you enter a short code',
  5: '~5 min — a browser window opens and you sign in',
  6: '~10+ min — you create an account/app in their console',
};

function _eta(friction) { return SETUP_ETA[friction] ?? 'setup required'; }

// ── Zero-install platform affordances ──────────────────────────────────────
// macOS built-ins reachable via allowlisted binaries — often the lowest-
// friction answer to a user goal ("text my wife" → Messages via osascript).
const PLATFORM_AFFORDANCES = {
  darwin: [
    {
      id: 'messages.app.agent', label: 'Messages (iMessage/SMS via this Mac)',
      kind: 'local', tool: 'osascript', service: 'messages', platforms: ['darwin'],
      capabilities: ['send_text', 'send_imessage', 'send_sms', 'message_contact'],
      keywords: ['sms', 'text', 'text message', 'imessage', 'message my', 'send a text', 'send text'],
      authType: 'none', friction: 0,
      detail: 'osascript drives Messages.app — works if the Mac is signed into iMessage.',
    },
    {
      id: 'reminders.app.agent', label: 'Apple Reminders',
      kind: 'local', tool: 'osascript', service: 'reminders', platforms: ['darwin'],
      capabilities: ['create_reminder', 'list_reminders', 'complete_reminder'],
      keywords: ['reminder', 'remind me', 'todo', 'to-do', 'take out the trash'],
      authType: 'none', friction: 0,
      detail: 'osascript creates native Reminders entries — no account needed.',
    },
    {
      id: 'notify.app.agent', label: 'macOS Notification',
      kind: 'local', tool: 'osascript', service: 'notify', platforms: ['darwin'],
      capabilities: ['send_notification', 'alert_user'],
      keywords: ['notification', 'notify me', 'alert me', 'ding'],
      authType: 'none', friction: 0,
      detail: 'osascript display notification — instant, no setup.',
    },
    {
      id: 'cron.agent', label: 'Scheduled job (crontab)',
      kind: 'local', tool: 'crontab', service: 'cron', platforms: ['darwin', 'linux'],
      capabilities: ['schedule_job', 'schedule_cron', 'recurring_task'],
      keywords: ['every week', 'every day', 'weekly', 'daily', 'recurring', 'schedule', 'cron'],
      authType: 'none', friction: 0,
      detail: 'crontab entry — runs on a schedule with zero accounts.',
    },
    {
      id: 'say.agent', label: 'Text-to-speech (say)',
      kind: 'local', tool: 'say', service: 'say', platforms: ['darwin'],
      capabilities: ['text_to_speech', 'speak_text', 'synthesize_audio'],
      keywords: ['generate a sound', 'text to speech', 'speak', 'say it', 'voice note', 'audio file'],
      authType: 'none', friction: 0,
      detail: 'say -o file.aiff — synthesized audio, no setup.',
    },
    {
      id: 'afplay.agent', label: 'Audio playback (afplay)',
      kind: 'local', tool: 'afplay', service: 'afplay', platforms: ['darwin'],
      capabilities: ['play_audio', 'play_sound'],
      keywords: ['play a sound', 'play audio', 'play music file', 'chime'],
      authType: 'none', friction: 0,
      detail: 'afplay plays audio files locally.',
    },
  ],
  win32: [],
  linux: [
    {
      id: 'notify-send.agent', label: 'Desktop notification (notify-send)',
      kind: 'local', tool: 'notify-send', service: 'notify-send', platforms: ['linux'],
      capabilities: ['send_notification', 'alert_user'],
      keywords: ['notification', 'notify me', 'alert me'],
      authType: 'none', friction: 0,
      detail: 'notify-send posts a desktop notification.',
    },
  ],
};

// ── Friction helpers ───────────────────────────────────────────────────────

const _whichCache = new Map();
function whichCli(tool) {
  if (!tool) return null;
  if (_whichCache.has(tool)) return _whichCache.get(tool);
  let found = null;
  try {
    const r = spawnSync('which', [tool], { timeout: 2000 });
    if (r.status === 0) found = String(r.stdout).trim().split('\n')[0] || null;
  } catch (_) {}
  _whichCache.set(tool, found);
  return found;
}

function _preflightAuthState(serviceOrAgent) {
  try {
    const cache = JSON.parse(fs.readFileSync(PREFLIGHT_CACHE, 'utf8'));
    const rows = cache?.agents || cache?.services || cache;
    const key = String(serviceOrAgent || '').toLowerCase().replace(/\.agent$/, '');
    if (Array.isArray(rows)) {
      const row = rows.find(r => String(r.agent || r.service || '').toLowerCase().replace(/\.agent$/, '') === key);
      return row?.auth || row?.state || 'unknown';
    }
    if (rows && typeof rows === 'object') return rows[key]?.auth || rows[key]?.state || 'unknown';
  } catch (_) {}
  return 'unknown';
}

function _summary(friction) { return SETUP_SUMMARIES[friction] ?? 'setup required'; }

function _candidate(base) {
  const friction = base.friction ?? 6;
  return { platforms: ['darwin', 'win32', 'linux'], ...base, friction, setupSummary: base.setupSummary || _summary(friction), eta: base.eta || _eta(friction) };
}

// ── Source scanners ────────────────────────────────────────────────────────

async function _scanRegisteredAgents() {
  const out = [];
  for (const a of serviceMap.listAgentNames()) {
    const kind = a.type === 'browser' ? 'browser' : (a.type || 'cli');
    if (kind === 'browser') {
      const auth = _preflightAuthState(a.agentId);
      out.push(_candidate({
        id: a.agentId, label: `${a.service} (browser)`, kind,
        service: a.service,
        keywords: [a.service, a.agentId],
        authType: 'browser-session',
        installed: true, registered: true,
        friction: auth === 'authed' ? 1 : (auth === 'needs sign-in' ? 5 : 4),
        setupSummary: auth === 'authed' ? _summary(1) : `browser sign-in ${auth === 'needs sign-in' ? 'needed' : 'may be needed'}`,
        detail: `Registered browser agent (${auth}).`,
      }));
      continue;
    }
    // cli / api / mcp agents
    const installed = a.cliTool ? Boolean(whichCli(a.cliTool)) : true;
    let missingSecrets = [];
    if (Array.isArray(a.secrets) && a.secrets.length) {
      try { missingSecrets = (await resolveAgentSecrets(a.agentId, a.secrets)).missing || []; } catch (_) { missingSecrets = a.secrets; }
    }
    const hasSecrets = Array.isArray(a.secrets) && a.secrets.length > 0;
    let friction;
    if (installed && !hasSecrets) friction = 0;
    else if (installed && !missingSecrets.length) friction = 1;
    else if (!installed && !hasSecrets) friction = 2;
    else friction = 3;
    out.push(_candidate({
      id: a.agentId, label: `${a.service} (${a.cliTool || kind})`, kind,
      service: a.service, tool: a.cliTool,
      capabilities: a.capabilities || [],
      verified: a.verified === true,
      keywords: [a.service, a.agentId, a.cliTool, ...(a.capabilities || []), ...(a.keywords || [])].filter(Boolean),
      authType: hasSecrets ? 'env' : 'none',
      installed, missingSecrets, registered: true,
      friction,
      detail: installed ? 'Registered agent, CLI present.' : 'Registered agent — needs install/setup.',
    }));
  }
  return out;
}

function _scanCliRegistry(registryPath) {
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(registryPath || DEFAULT_CLI_REGISTRY, 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const [capKey, cap] of Object.entries(registry)) {
    const providers = cap.providers || {};
    for (const [provName, prov] of Object.entries(providers)) {
      const tool = prov.tool || null;
      const installed = tool ? Boolean(whichCli(tool)) : false;
      const authType = prov.authType || 'none';
      const needsKeys = authType === 'env' && Array.isArray(prov.authEnv) && prov.authEnv.length;
      let friction;
      if (installed && !needsKeys && authType === 'none') friction = 0;
      else if (installed && authType === 'env') friction = 3; // may already have env — cheap check unknown
      else if (authType === 'none') friction = 2;
      else if (authType === 'env') friction = 3;
      else if (authType === 'oauth') friction = /token|device/i.test(prov.tokenCmd || '') ? 4 : 5;
      else friction = 5;
      if (/paid|subscription|billing|console\.twilio|signup/i.test((prov.links || []).map(l => l.url).join(' '))) friction = Math.max(friction, 3);
      out.push(_candidate({
        id: `${capKey}.${provName}`, label: `${provName} (${tool || capKey})`,
        kind: 'cli', capability: capKey, service: provName, tool,
        keywords: [...(cap.keywords || []), provName, tool].filter(Boolean),
        authType, installed,
        authEnv: prov.authEnv || [],
        installCmd: prov.installCmd || null,
        links: prov.links || [],
        friction,
        detail: `cli-registry ${capKey} provider.`,
      }));
    }
  }
  return out;
}

function _scanMcp() {
  const out = [];
  // installed servers
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_SERVERS_PATH, 'utf8'));
    for (const [name, def] of Object.entries(cfg.mcpServers || cfg || {})) {
      out.push(_candidate({
        id: `mcp.${name}.agent`, label: `${name} (MCP server)`, kind: 'mcp',
        service: name, keywords: [name, 'mcp'],
        authType: def.env ? 'env' : 'none', installed: true,
        friction: def.env && Object.keys(def.env).length ? 1 : 0,
        detail: 'Installed MCP server.',
      }));
    }
  } catch (_) {}
  // seed registry (known-good external servers)
  try {
    const seed = JSON.parse(fs.readFileSync(MCP_SEED_PATH, 'utf8'));
    for (const s of seed.servers || []) {
      out.push(_candidate({
        id: `mcp.${s.name}.agent`, label: `${s.name} (MCP server)`, kind: 'mcp',
        service: s.name, keywords: [...(s.keywords || []), s.name, 'mcp'],
        authType: s.authType || 'none', installed: false,
        installCmd: [s.command, ...(s.args || [])].join(' '),
        friction: s.authType === 'env' ? 3 : 2,
        detail: s.description || 'Registry MCP server — needs install.',
      }));
    }
  } catch (_) {}
  return out;
}

function _scanAffordances() {
  return (PLATFORM_AFFORDANCES[process.platform] || []).map(a =>
    _candidate({ ...a, installed: Boolean(whichCli(a.tool)) }));
}

// ── Search ─────────────────────────────────────────────────────────────────

function _tokens(query) {
  return String(query || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

function _matchScore(candidate, tokens) {
  const hay = [candidate.id, candidate.label, candidate.service, candidate.tool, candidate.capability,
    ...(candidate.keywords || [])].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  for (const t of tokens) if (hay.includes(t)) score += t.length > 5 ? 2 : 1;
  return score;
}

/**
 * Search all capability sources for `query`.
 * @returns {Promise<Array>} candidates sorted by friction asc, then match score desc.
 */
// name → seed keywords, so installed/registered MCP candidates inherit the
// seed's discoverability terms (a registered `mcp.memory.agent` descriptor
// only carries its service name otherwise).
function _seedKeywordMap() {
  const map = new Map();
  try {
    const seed = JSON.parse(fs.readFileSync(MCP_SEED_PATH, 'utf8'));
    for (const s of seed.servers || []) map.set(s.name, s.keywords || []);
  } catch (_) {}
  return map;
}

async function searchCapabilities(query, opts = {}) {
  const platform = process.platform;
  const tokens = _tokens(query);
  const seedKw = _seedKeywordMap();
  const pools = [
    ...(await _scanRegisteredAgents()),
    ..._scanCliRegistry(opts.cliRegistryPath),
    ..._scanMcp(),
    ..._scanAffordances(),
  ];
  const seen = new Set();
  const scored = [];
  const unmatchedRegistered = [];
  for (const c of pools) {
    if (!c.platforms.includes(platform)) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const m = c.id.match(/^mcp\.([^.]+)\.agent$/);
    if (m && seedKw.has(m[1])) c.keywords = [...new Set([...(c.keywords || []), ...seedKw.get(m[1])])];
    const match = _matchScore(c, tokens);
    if (match <= 0) {
      // Registered agents are the user's own capability set — the selector's
      // job is semantic pick over facts, and it can't pick what retrieval
      // dropped. Keep them available as pool context (never standalone
      // evidence — callers still require a scored hit to invoke selection).
      if (opts.includeUnmatchedRegistered && c.registered) {
        unmatchedRegistered.push({ ...c, matchScore: 0 });
      }
      continue;
    }
    scored.push({ ...c, matchScore: match });
  }
  scored.sort((a, b) => (a.friction - b.friction) || (b.matchScore - a.matchScore));
  const out = scored.slice(0, opts.limit || 8);
  if (opts.includeUnmatchedRegistered && out.length) {
    // Append unmatched registered agents only when a scored hit exists —
    // otherwise the pool is just "everything the user owns", which is not
    // evidence the prompt is a capability task at all.
    out.push(...unmatchedRegistered
      .sort((a, b) => a.friction - b.friction)
      .slice(0, opts.maxRegistered ?? 15));
  }
  return out;
}

// ── capability.probe — read-only verb-gated inspection ─────────────────────

// verb → optional second-token constraint set. Code-resident only — never
// load this from prompts/config/registry; nothing user-influenced may widen it.
const PROBE_VERBS = new Map([
  ['help',        null],
  ['--help',      null],
  ['-h',          null],
  ['version',     null],
  ['--version',   null],
  ['-V',          null],
  ['whoami',      null],
  ['status',      null],
  ['list',        null],
  ['ls',          null],
  ['info',        null],
  ['show',        null],
  ['describe',    null],
  ['doctor',      null],
  ['check',       null],
  ['scan',        null],
  ['auth',        new Set(['status', 'list'])],
  ['config',      new Set(['list', 'get', '--list'])],
  ['profiles',    new Set(['list'])],
  ['accounts',    new Set(['list'])],
]);

const PROBE_DENY_RE = /^(exec|run|eval|init|login|logout|install|uninstall|set|unset|add|remove|delete|create|write|edit|open|update|upgrade|push|pull|send|publish|deploy|apply|--exec|-c|--output|-o|--config|--write|--eval|--command)$/i;

const PROBE_TIMEOUT_MS = 15000;
const PROBE_MAX_OUT = 4096;

function _logProbe(entry) {
  try {
    fs.mkdirSync(path.dirname(PROBE_LOG), { recursive: true });
    fs.appendFileSync(PROBE_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (_) {}
}

/**
 * Read-only probe of a CLI: `capabilityProbe('gh', ['auth','status'])`.
 * - tool must resolve via which()
 * - argv[0] must be a whitelisted verb (with second-token constraints)
 * - every argv token must pass the denylist (no exec/run/set/output…)
 * - spawn WITHOUT a shell — `;|>` can never chain
 * - 15s timeout, 4KB output cap, stdin closed (prompts die fast)
 * - no secret env injection
 */
async function capabilityProbe(tool, argv = []) {
  const toolName = String(tool || '').trim();
  const args = (argv || []).map(a => String(a));

  const deny = (reason) => {
    _logProbe({ tool: toolName, argv: args, denied: reason });
    return { ok: false, denied: reason };
  };

  if (!toolName || !/^[a-zA-Z0-9_.-]+$/.test(toolName)) return deny('bad-tool-name');
  const bin = whichCli(toolName);
  if (!bin) return { ok: false, installed: false, tool: toolName, error: 'not-installed' };

  const verb = args[0] || '--help'; // bare invocation → probe its default help
  const constraint = PROBE_VERBS.get(verb);
  if (constraint === undefined) return deny(`verb-not-allowed:${verb}`);
  if (constraint && !constraint.has(args[1])) return deny(`second-token-not-allowed:${verb} ${args[1] || ''}`);

  for (const tok of args) {
    if (PROBE_DENY_RE.test(tok)) return deny(`token-denied:${tok}`);
  }

  const effectiveArgv = args.length ? args : ['--help'];
  const t0 = Date.now();
  const result = await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let proc;
    try {
      // spawn argv directly — no shell, so metacharacters can't chain
      proc = spawn(bin, effectiveArgv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ ok: false, error: err.message });
    }
    const onData = (c) => { if (out.length < PROBE_MAX_OUT) out += c.toString().slice(0, PROBE_MAX_OUT - out.length); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish({ ok: false, error: 'timeout', output: out }); }, PROBE_TIMEOUT_MS);
    proc.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, exitCode: code ?? -1, output: out }); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  });

  _logProbe({ tool: toolName, argv: effectiveArgv, ok: result.ok, ms: Date.now() - t0 });
  return {
    ok: Boolean(result.ok),
    installed: true,
    tool: toolName,
    verb,
    exitCode: result.exitCode ?? -1,
    output: (result.output || '').slice(0, PROBE_MAX_OUT),
    error: result.error,
  };
}

// ── capability.select — commit a chosen option as a draft agent ────────────
// After the user picks an option that isn't a registered agent, the planner
// calls this to write a stub .agent.md (status: draft). The draft carries the
// metadata plan-check needs to render a cli-setup row (tool, secrets, type);
// actual install/auth still runs later via /agent.cli-build — the file is
// metadata only, same class as writing the plan.md itself.

function _agentsDir() {
  return process.env.THINKDROP_AGENTS_DIR || path.join(os.homedir(), '.thinkdrop', 'agents');
}

async function selectCapability(name, opts = {}) {
  const target = String(name || '').trim().toLowerCase().replace(/\.agent$/, '');
  if (!target || !/^[a-z0-9_.-]+$/.test(target)) return { ok: false, error: 'bad-name' };

  // Already registered? Just confirm.
  const existing = serviceMap.describeAgent(target);
  if (existing) return { ok: true, agentId: existing.agentId, alreadyRegistered: true, status: existing.status };

  // Find the candidate across all sources (search by the name itself).
  const candidates = [
    ..._scanCliRegistry(opts.cliRegistryPath),
    ..._scanMcp(),
    ..._scanAffordances(),
  ];
  const cand = candidates.find(c =>
    c.id.toLowerCase() === target ||
    c.id.toLowerCase() === `${target}.agent` ||
    String(c.service || '').toLowerCase() === target ||
    String(c.tool || '').toLowerCase() === target ||
    c.id.toLowerCase() === `mcp.${target}.agent` ||
    c.id.toLowerCase().endsWith(`.${target}`));

  const isMcp = cand?.kind === 'mcp';
  const isApi = cand?.kind === 'api';
  const tool = cand?.tool || (isMcp || isApi ? null : target);
  const service = cand?.service || target;
  const secrets = cand?.authEnv || (cand?.authType === 'env' ? [] : []);
  // Prefer the candidate's own id when it's already agent-shaped — an
  // affordance like 'messages.app.agent' must keep its id, not be
  // re-derived into 'messages_app.agent'.
  const agentId = (cand?.id || '').endsWith('.agent')
    ? cand.id
    : `${service.replace(/[^a-z0-9]/g, '_')}.agent`;

  const fm = [
    '---',
    `id: ${agentId}`,
    `service: ${service}`,
    `type: ${isMcp ? 'mcp' : isApi ? 'api' : 'cli'}`,
    tool ? `cli_tool: ${tool}` : null,
    isMcp ? `mcp_server: ${service}` : null,
    cand?.setupUrl ? `setupUrl: ${cand.setupUrl}` : null,
    'status: draft',
    cand?.installCmd ? `install_cmd: ${cand.installCmd}` : null,
    (cand?.capabilities || []).length ? `capabilities: [${cand.capabilities.join(', ')}]` : null,
    (cand?.keywords || []).length ? `keywords: [${[...new Set([service, ...(cand.keywords || [])])].join(', ')}]` : null,
    secrets.length ? 'secrets:' : null,
    ...secrets.map(s => `  - ${s}`),
    '---',
    '',
    `# ${service}`,
    '',
    `Draft descriptor — selected via capability.select, pending build/install.`,
    cand?.detail ? `\n${cand.detail}` : '',
  ].filter(l => l !== null).join('\n') + '\n';

  try {
    const dir = _agentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${agentId.replace(/\.agent$/, '')}.agent.md`);
    fs.writeFileSync(filePath, fm, 'utf8');
    return { ok: true, agentId, path: filePath, status: 'draft', secrets };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── capability.infer — LLM proposes, code verifies ─────────────────────────
// Deterministic search is vocabulary-bound: "mirror my overlay" misses catt
// because 'mirror' isn't in its keywords. Rather than grow keyword lists by
// hand, on a search miss we ask the LLM to name candidate tools, then VERIFY
// each mechanically (which / npm view / brew info / seed match / --version
// probe). Hallucinated names die at verification; only verified candidates
// are returned, friction-ranked like search results.
//
// inferCapabilities(goal, { llmCaller }) — llmCaller is injected by the
// caller (command-service wraps skill-llm askWithMessages); without it the
// function returns an empty verified set rather than guessing itself.

const INFER_MAX_CANDIDATES = 6;
const INFER_VERIFY_TIMEOUT_MS = 8000;

const INFER_PROMPT = `You name real, existing tools that could accomplish a user's goal. Respond with ONLY a JSON array of up to 6 objects:
[{"name":"binary-or-server-name","kind":"cli|npm|mcp|api","package":"npm-or-brew-package-if-different","why":"one short phrase","authEnv":["ENV_VAR_NAMES"],"setupUrl":"https://docs-or-console-url"}]

"authEnv" and "setupUrl" are OPTIONAL — include them only when you are confident (e.g. TWILIO_ACCOUNT_SID, OPENAI_API_KEY). Never invent plausible-looking names.

Rules:
- Only name tools you are confident actually exist (real binaries, npm packages, brew formulae, or MCP servers).
- Prefer in this order: zero-install/local affordances (osascript, curl, platform tools) → already-installed CLIs → installable CLIs → API-keyed services.
- Prefer the simplest/least-setup option first.
- If a service name was given (e.g. "slack", "twilio"), include its official CLI/SDK package if one exists.
- If nothing plausible exists, return [].

Goal: `;

function _verifyCmd(cmd, args) {
  try {
    const r = spawnSync(cmd, args, {
      timeout: INFER_VERIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: r.status === 0, out: `${r.stdout || ''}\n${r.stderr || ''}`.slice(0, 2048) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Verify one LLM-proposed candidate. Returns { verified, evidence, installed }.
// All checks are read-only lookups — nothing here installs or mutates.
function _verifyCandidate(cand) {
  const name = String(cand.name || '').trim();
  const pkg = String(cand.package || name).trim();
  if (!/^[a-zA-Z0-9_./@-]+$/.test(name)) return { verified: false, evidence: 'bad-name' };

  // Already on PATH? Strongest signal — also confirms "no install needed".
  const bin = whichCli(name) || (pkg !== name ? whichCli(pkg) : null);
  if (bin) {
    return { verified: true, evidence: `installed:${bin}`, installed: true, bin: name };
  }
  // MCP seed registry match.
  try {
    const seed = JSON.parse(fs.readFileSync(MCP_SEED_PATH, 'utf8'));
    const s = (seed.servers || []).find(x => x.name === name || x.name === pkg || x.package === pkg);
    if (s) return { verified: true, evidence: 'mcp-seed', installed: false, seed: s };
  } catch (_) {}
  // npm registry existence — kills hallucinated package names.
  const npm = _verifyCmd('npm', ['view', pkg, 'name', '--json']);
  if (npm.ok && npm.out.trim()) return { verified: true, evidence: 'npm', installed: false };
  // brew — only if brew itself exists.
  if (whichCli('brew')) {
    const brew = _verifyCmd('brew', ['info', pkg]);
    if (brew.ok) return { verified: true, evidence: 'brew', installed: false };
  }
  return { verified: false, evidence: 'unverifiable', installed: false };
}

function _installCmdFor(cand, verification) {
  if (verification.seed) return [verification.seed.command, ...(verification.seed.args || [])].join(' ');
  const pkg = cand.package || cand.name;
  if (verification.evidence === 'npm') return `npm install -g ${pkg}`;
  if (verification.evidence === 'brew') return `brew install ${pkg}`;
  return null;
}

// LLM-proposed auth metadata — sanitized, never trusted. Env names must be
// UPPER_SNAKE; setupUrl must be https. Presence/absence of the vars adjusts
// friction mechanically (stored key = 1, missing key = 3+).
function _inferAuthFields(p, baseFriction) {
  const authEnv = (Array.isArray(p?.authEnv) ? p.authEnv : [])
    .map(k => String(k || '').trim()).filter(k => /^[A-Z][A-Z0-9_]{2,}$/.test(k));
  const setupUrl = /^https:\/\/\S+$/.test(String(p?.setupUrl || '')) ? String(p.setupUrl).slice(0, 300) : null;
  if (!authEnv.length) return { authEnv: [], setupUrl, friction: baseFriction };
  const missing = authEnv.filter(k => !process.env[k]);
  return { authEnv, setupUrl, friction: missing.length ? Math.max(baseFriction, 3) : Math.min(baseFriction, 1) };
}

/**
 * Semantic fallback for searchCapabilities. On a keyword miss, the LLM
 * proposes candidate tools; every proposal is mechanically verified before
 * it can reach the user or a plan. Returns { ok, candidates, rejected } —
 * candidates carry { verified:true, evidence } and are friction-sorted.
 */
async function inferCapabilities(goal, opts = {}) {
  const llmCaller = opts.llmCaller;
  if (typeof llmCaller !== 'function') return { ok: false, error: 'no-llm-caller', candidates: [] };

  let proposals = [];
  try {
    const raw = await llmCaller(INFER_PROMPT + JSON.stringify(String(goal || '').slice(0, 500)));
    const m = String(raw || '').match(/\[[\s\S]*\]/);
    proposals = m ? JSON.parse(m[0]) : [];
  } catch (e) {
    return { ok: false, error: `llm-parse:${e.message}`, candidates: [] };
  }
  if (!Array.isArray(proposals)) proposals = [];

  const candidates = [];
  const rejected = [];
  const seen = new Set();
  for (const p of proposals.slice(0, INFER_MAX_CANDIDATES)) {
    const name = String(p?.name || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const v = _verifyCandidate(p);
    if (!v.verified) { rejected.push({ name, why: v.evidence }); continue; }

    const _auth = _inferAuthFields(p, v.installed ? 0 : (v.seed ? (v.seed.authType === 'env' ? 3 : 2) : 2));
    if (v.installed) {
      // Smoke check: binary answers --version (probe is verb-gated, read-only).
      const pv = await capabilityProbe(v.bin, ['--version']);
      candidates.push(_candidate({
        id: `${name}.agent`, label: `${name} (installed)`, kind: p.kind === 'mcp' ? 'mcp' : (p.kind === 'api' ? 'api' : 'cli'),
        service: name, tool: v.bin, keywords: [name],
        authType: _auth.authEnv.length ? 'env' : 'none', installed: true, verified: Boolean(pv.ok),
        authEnv: _auth.authEnv, setupUrl: _auth.setupUrl,
        friction: _auth.friction, detail: `Inferred for "${goal}" — ${p.why || 'verified installed'}.`,
        evidence: v.evidence,
      }));
    } else if (v.seed) {
      candidates.push(_candidate({
        id: `mcp.${v.seed.name}.agent`, label: `${v.seed.name} (MCP server)`, kind: 'mcp',
        service: v.seed.name, keywords: [...(v.seed.keywords || []), v.seed.name, 'mcp'],
        authType: v.seed.authType || 'none', installed: false,
        installCmd: _installCmdFor(p, v), friction: v.seed.authType === 'env' ? 3 : 2,
        detail: v.seed.description || p.why, evidence: v.evidence,
      }));
    } else {
      candidates.push(_candidate({
        id: `${name}.agent`, label: `${name} (${v.evidence} package)`, kind: p.kind === 'api' ? 'api' : 'cli',
        service: name, tool: name, keywords: [name],
        authType: _auth.authEnv.length ? 'env' : 'none', installed: false,
        authEnv: _auth.authEnv, setupUrl: _auth.setupUrl,
        installCmd: _installCmdFor(p, v), friction: _auth.friction,
        detail: `Inferred for "${goal}" — ${p.why || 'verified package'}.`,
        evidence: v.evidence,
      }));
    }
  }
  candidates.sort((a, b) => a.friction - b.friction);
  return { ok: true, candidates, rejected };
}

// ── Verb-fit — does the asked action match what the candidate can do? ──────
// "connect to my chromecast" is a connector verb — it says WHICH tool, not
// WHAT to do with it. Such prompts route to planning to clarify intent. An
// action verb that maps to the candidate's capabilities ("cast video.mp4")
// pins directly.

const CONNECTOR_VERBS = new Set([
  'connect', 'use', 'setup', 'set', 'link', 'pair', 'integrate', 'sync',
  'talk', 'communicate', 'work', 'hook', 'attach', 'access', 'control',
]);

// Generic English/config verbs that appear inside capability slugs
// (set_volume, get_device_info…) but never prove the user asked for this
// tool — "send email and set calendar event" must not pin a media caster
// just because its descriptor contains set_*. Only a NON-generic token
// match (cast, play, scan, download, send…) counts as capability-fit.
const GENERIC_VERB_TOKENS = new Set([
  'set', 'get', 'add', 'remove', 'delete', 'clear', 'save', 'update',
  'show', 'list', 'check', 'describe', 'info', 'view', 'load', 'help',
  'use', 'do', 'make', 'put', 'take', 'give', 'find', 'work', 'turn',
]);

/**
 * @param {string} prompt  the user prompt
 * @param {object} candidate  a searchCapabilities/inferCapabilities result
 * @returns {'pin'|'clarify'} pin = action verb maps to a capability; clarify =
 *   prompt only names the target (connector verbs / unknown intent).
 */
// Plural↔singular tolerance: capability slugs are usually plural (list_emails)
// while users say "the email". Strip a trailing 's' only when the stem stays
// >2 chars and the word doesn't end in ss/us/is — so 'status', 'address',
// 'analysis' never collapse. Scoped to verbFit; _tokens/_matchScore untouched.
function _sing(t) {
  return t.length > 3 && /[^s]s$/.test(t) && !/(ss|us|is)$/.test(t)
    ? t.slice(0, -1)
    : t;
}

function verbFit(prompt, candidate) {
  const capTokens = new Set();
  for (const cap of candidate.capabilities || []) {
    for (const t of _tokens(cap)) capTokens.add(t);
  }
  const capStems = new Set([...capTokens].map(_sing));
  // Identity tokens (service/tool/agent id) name the TARGET, not the action —
  // exclude them so "connect to chromecast" can't pin on 'chromecast' alone.
  // Keywords stay IN scope: a keyword can be the action verb itself ("cast").
  const targetTokens = new Set(_tokens(
    [candidate.service, candidate.tool, candidate.id].filter(Boolean).join(' ')));
  const leftovers = _tokens(prompt).filter(t => !targetTokens.has(t));
  // No declared capabilities — fit can't be confirmed, so clarify rather
  // than pin a tool we can't prove does the asked thing.
  if (!capTokens.size) return 'clarify';
  return leftovers.some(t => capStems.has(_sing(t)) && !GENERIC_VERB_TOKENS.has(t)) ? 'pin' : 'clarify';
}

// ── capability.select-best — semantic selection over retrieved candidates ──
// Three-layer routing:
//   1. searchCapabilities — mechanical retrieval (generous recall; its job is
//      "don't miss candidates", never the decision itself).
//   2. selectBestCapability — ONE bounded temp-0 LLM call picks the best
//      surface from the verified fact table, or "none". Replaces token-fit
//      decisions (verbFit) for routing — a substring match can no longer
//      become a pin.
//   3. decideGate — pure function; verified facts alone decide what the
//      pick means (pin / needs_setup / clarify / none). The LLM can't fake
//      facts — an uninstalled tool can never become "ready".
//
// llmCaller is injected (command-service wraps skill-llm askWithMessages).
// Without it the function returns ok:false — callers must degrade to
// ASKING (clarify/needs_setup), never to a lexical pin.

const SELECT_MAX_CANDIDATES = 20; // 8 scored hits + unmatched registered agents

const SELECT_PROMPT = `You pick the single best execution surface for a user goal from verified candidates, or none.

Rules:
- Prefer deterministic surfaces — local affordances, CLI/API/MCP agents — over browser agents ALWAYS, even when a browser agent is signed in. A named service (gmail, jira, n8n, slack) identifies the data, not the surface.
- fit "exact" only when the candidate can clearly perform the asked action (check kind + capabilities). If the goal's real target is an entity the candidate doesn't own — e.g. events on a public website, a file on disk — answer "none", not the nearest lookalike service.
- fit "none" when the goal is a public-page read/scrape/summary, a local file or screen question, a device/OS action, or ordinary conversation — those use generic tools, not these candidates.
- fit "partial" when a candidate probably applies but intent is ambiguous (connector verbs: "connect X", "use X", "set up X").
- Browser agents are the last resort: pick only when no deterministic surface can do the task.
- Respond ONLY JSON: {"pick":"<candidate id or null>","fit":"exact|partial|none","reason":"<short>","alternatives":["<id>",...]}

Goal: `;

function _candidateFacts(c) {
  return `${c.id} | kind:${c.kind} | service:${c.service || '?'} | caps:[${(c.capabilities || []).join(',')}]`
    + ` | ${c.installed ? 'installed' : 'NOT installed'} | friction:${c.friction} (${c.setupSummary || 'setup unknown'})`
    + ` | ${c.detail || ''}`;
}

/**
 * Semantic pick over retrieved candidates.
 * @param {string} query
 * @param {object} [opts] { llmCaller, candidates, limit }
 * @returns {Promise<{ok:boolean, pick:?object, fit:'exact'|'partial'|'none', reason:string, alternatives:Array, candidates:Array, error?:string}>}
 */
async function selectBestCapability(query, opts = {}) {
  // Caller-supplied candidates are already the vetted pool — no matchScore
  // filter. When WE retrieve, the pool is scored hits + unmatched registered.
  const callerSupplied = Array.isArray(opts.candidates) && opts.candidates.length;
  const candidates = callerSupplied ? opts.candidates : await searchCapabilities(query, {
    limit: opts.limit || 8,
    includeUnmatchedRegistered: true,
    maxRegistered: opts.maxRegistered,
  });
  if (!candidates.length) {
    return { ok: true, pick: null, fit: 'none', reason: 'no candidates', alternatives: [], candidates };
  }
  // Fact table: scored hits first (most likely relevant), then unmatched
  // registered agents (the user's own capability set — reachable even when
  // vocabulary doesn't overlap, e.g. "gmail" → nylas email CLI).
  const pool = candidates.slice(0, SELECT_MAX_CANDIDATES);
  const llmCaller = opts.llmCaller;
  if (typeof llmCaller !== 'function') return { ok: false, error: 'no-llm-caller', candidates };

  const table = pool.map((c, i) => `${i + 1}. ${_candidateFacts(c)}`).join('\n');
  let verdict = null;
  try {
    const raw = await llmCaller(`${SELECT_PROMPT}${JSON.stringify(String(query || '').slice(0, 400))}\n\nCANDIDATES:\n${table}`);
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    verdict = m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return { ok: false, error: `llm:${e.message}`, candidates };
  }
  if (!verdict || typeof verdict !== 'object') return { ok: false, error: 'bad-verdict', candidates };

  const byId = new Map(pool.map(c => [String(c.id).toLowerCase(), c]));
  // LLMs paraphrase ids ("messages", "Messages.app", "imessage") — resolve
  // the pick against the pool through a bounded set of normalizations. This
  // is id normalization, not intent guessing: the pick must still land on a
  // retrieved candidate.
  function _resolvePick(raw) {
    if (raw == null || raw === '') return null;
    // Numeric answer — the model echoed the table's row number ("4").
    if (/^\d+$/.test(String(raw).trim())) {
      const i = parseInt(String(raw).trim(), 10) - 1;
      return pool[i] || null;
    }
    const p = String(raw).toLowerCase().replace(/[^a-z0-9._-]+/g, '');
    if (!p) return null;
    if (byId.has(p)) return byId.get(p);
    for (const v of [`${p}.agent`, `${p}.app.agent`]) if (byId.has(v)) return byId.get(v);
    for (const c of pool) {
      if (String(c.service || '').toLowerCase() === p) return c;
      if (String(c.label || '').toLowerCase() === String(raw).toLowerCase()) return c;
    }
    // Prefix/contains match — 'messages.app' → 'messages.app.agent'.
    const contains = pool.filter(c => String(c.id).toLowerCase().startsWith(p) || String(c.id).toLowerCase().includes(`.${p}.`));
    return contains.length === 1 ? contains[0] : null;
  }
  const pick = _resolvePick(verdict.pick);
  // A pick naming an unknown id is a malformed verdict — treat as none,
  // never honor an id outside the retrieved pool.
  if (verdict.pick && !pick) {
    console.warn(`[capability-index] invalid pick "${verdict.pick}" — not in candidate pool`);
    return { ok: true, pick: null, fit: 'none', reason: `invalid-pick:${String(verdict.pick).slice(0, 60)}`, alternatives: [], candidates };
  }
  let fit = ['exact', 'partial', 'none'].includes(verdict.fit) ? verdict.fit : 'none';
  if (!pick) fit = 'none';
  const alternatives = (Array.isArray(verdict.alternatives) ? verdict.alternatives : [])
    .map(a => byId.get(String(a).toLowerCase()))
    .filter(c => c && c !== pick);
  return { ok: true, pick, fit, reason: String(verdict.reason || '').slice(0, 240), alternatives, candidates };
}

/**
 * Pure decision mapping — what a semantic pick MEANS, from verified facts only.
 * @returns {'pin'|'needs_setup'|'clarify'|'none'|'fallback'}
 *   'fallback' = selector failed — caller degrades to asking, never pinning.
 */
function decideGate(selection) {
  if (!selection || selection.ok !== true) return 'fallback';
  const { pick, fit } = selection;
  if (fit === 'none' || !pick) return 'none';
  if (fit === 'partial') return 'clarify';
  // fit === 'exact'
  if (pick.kind === 'browser') {
    // Sole deterministic route absent — browser IS the route; the preflight
    // sign-in wall handles auth downstream, so a planning detour for an
    // unambiguous named-service action is pure friction.
    return (pick.installed && pick.friction <= 5) ? 'pin' : 'needs_setup';
  }
  return (pick.installed && pick.friction <= 1) ? 'pin' : 'needs_setup';
}

// ── stampDescriptor — write verified/status fields into agent frontmatter ──
// Post-install smoke results and mcp handshake results land here so the
// index and plan-check can rank verified agents above unverified ones.

function stampDescriptor(agentId, patch = {}) {
  const id = String(agentId || '').replace(/\.agent$/, '');
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) return { ok: false, error: 'bad-agent-id' };
  const file = path.join(_agentsDir(), `${id}.agent.md`);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: e.message }; }
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { ok: false, error: 'no-frontmatter' };
  let fm = m[1];
  for (const [k, v] of Object.entries(patch)) {
    const line = `${k}: ${v}`;
    if (new RegExp(`^${k}:.*$`, 'm').test(fm)) fm = fm.replace(new RegExp(`^${k}:.*$`, 'm'), line);
    else fm += `\n${line}`;
  }
  fs.writeFileSync(file, src.replace(m[0], `---\n${fm}\n---`), 'utf8');
  return { ok: true, file };
}

// ── Route options merge ──────────────────────────────────────────────────
// Merge retrieved candidates (ready/registered) with inferred external
// options (verified CLI/API/MCP packages) into one ordered options list —
// the "which route should I use" card in planning. Ready routes first
// (selector's pick leads = recommended), then needs-setup, friction-sorted.
function mergeRouteOptions(results, inferred, pick) {
  const out = [];
  const seen = new Set();
  const seenTools = new Set();
  const slug = (o) => String(o?.service || o?.tool || o?.id || o?.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const push = (o, ready) => {
    const s = slug(o);
    if (!s || seen.has(s) || (o?.tool && seenTools.has(slug({ tool: o.tool })))) return;
    seen.add(s);
    if (o?.tool) seenTools.add(slug({ tool: o.tool }));
    out.push({ ...o, ready, needsSetup: !ready });
  };
  const pickId = pick?.id ? String(pick.id) : null;
  const ready = (results || []).filter(r => r && r.installed !== false && (r.friction ?? 9) <= 2);
  const pickFirst = ready.slice().sort((a, b) =>
    (b.id === pickId) - (a.id === pickId) || (a.friction ?? 9) - (b.friction ?? 9));
  for (const r of pickFirst) push(r, true);
  // Registered-but-unready candidates still belong on the list (needs auth).
  for (const r of (results || [])) if (r && !seen.has(slug(r))) push(r, false);
  // External verified options.
  for (const c of (inferred || [])) push(c, !!c.installed && (c.friction ?? 9) <= 1);
  return out.slice(0, 8);
}

module.exports = { searchCapabilities, capabilityProbe, selectCapability, inferCapabilities, selectBestCapability, decideGate, verbFit, stampDescriptor, whichCli, SETUP_SUMMARIES, SETUP_ETA, PLATFORM_AFFORDANCES, mergeRouteOptions };
