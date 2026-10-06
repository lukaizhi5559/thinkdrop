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

// ── Zero-install platform affordances ──────────────────────────────────────
// macOS built-ins reachable via allowlisted binaries — often the lowest-
// friction answer to a user goal ("text my wife" → Messages via osascript).
const PLATFORM_AFFORDANCES = {
  darwin: [
    {
      id: 'messages.app.agent', label: 'Messages (iMessage/SMS via this Mac)',
      kind: 'local', tool: 'osascript', platforms: ['darwin'],
      keywords: ['sms', 'text', 'text message', 'imessage', 'message my', 'send a text', 'send text'],
      authType: 'none', friction: 0,
      detail: 'osascript drives Messages.app — works if the Mac is signed into iMessage.',
    },
    {
      id: 'reminders.app.agent', label: 'Apple Reminders',
      kind: 'local', tool: 'osascript', platforms: ['darwin'],
      keywords: ['reminder', 'remind me', 'todo', 'to-do', 'take out the trash'],
      authType: 'none', friction: 0,
      detail: 'osascript creates native Reminders entries — no account needed.',
    },
    {
      id: 'notify.app.agent', label: 'macOS Notification',
      kind: 'local', tool: 'osascript', platforms: ['darwin'],
      keywords: ['notification', 'notify me', 'alert me', 'ding'],
      authType: 'none', friction: 0,
      detail: 'osascript display notification — instant, no setup.',
    },
    {
      id: 'cron.agent', label: 'Scheduled job (crontab)',
      kind: 'local', tool: 'crontab', platforms: ['darwin', 'linux'],
      keywords: ['every week', 'every day', 'weekly', 'daily', 'recurring', 'schedule', 'cron'],
      authType: 'none', friction: 0,
      detail: 'crontab entry — runs on a schedule with zero accounts.',
    },
    {
      id: 'say.agent', label: 'Text-to-speech (say)',
      kind: 'local', tool: 'say', platforms: ['darwin'],
      keywords: ['generate a sound', 'text to speech', 'speak', 'say it', 'voice note', 'audio file'],
      authType: 'none', friction: 0,
      detail: 'say -o file.aiff — synthesized audio, no setup.',
    },
    {
      id: 'afplay.agent', label: 'Audio playback (afplay)',
      kind: 'local', tool: 'afplay', platforms: ['darwin'],
      keywords: ['play a sound', 'play audio', 'play music file', 'chime'],
      authType: 'none', friction: 0,
      detail: 'afplay plays audio files locally.',
    },
  ],
  win32: [],
  linux: [
    {
      id: 'notify-send.agent', label: 'Desktop notification (notify-send)',
      kind: 'local', tool: 'notify-send', platforms: ['linux'],
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
  return { platforms: ['darwin', 'win32', 'linux'], ...base, friction, setupSummary: base.setupSummary || _summary(friction) };
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
        installed: true,
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
      installed, missingSecrets,
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
  for (const c of pools) {
    if (!c.platforms.includes(platform)) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const m = c.id.match(/^mcp\.([^.]+)\.agent$/);
    if (m && seedKw.has(m[1])) c.keywords = [...new Set([...(c.keywords || []), ...seedKw.get(m[1])])];
    const match = _matchScore(c, tokens);
    if (match <= 0) continue;
    scored.push({ ...c, matchScore: match });
  }
  scored.sort((a, b) => (a.friction - b.friction) || (b.matchScore - a.matchScore));
  return scored.slice(0, opts.limit || 8);
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
    String(c.service || '').toLowerCase() === target ||
    String(c.tool || '').toLowerCase() === target ||
    c.id.toLowerCase() === `mcp.${target}.agent` ||
    c.id.toLowerCase().endsWith(`.${target}`));

  const isMcp = cand?.kind === 'mcp';
  const tool = cand?.tool || (isMcp ? null : target);
  const service = cand?.service || target;
  const secrets = cand?.authEnv || (cand?.authType === 'env' ? [] : []);
  const agentId = `${service.replace(/[^a-z0-9]/g, '_')}.agent`;

  const fm = [
    '---',
    `id: ${agentId}`,
    `service: ${service}`,
    `type: ${isMcp ? 'mcp' : 'cli'}`,
    tool ? `cli_tool: ${tool}` : null,
    isMcp ? `mcp_server: ${service}` : null,
    'status: draft',
    cand?.installCmd ? `install_cmd: ${cand.installCmd}` : null,
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
[{"name":"binary-or-server-name","kind":"cli|npm|mcp|api","package":"npm-or-brew-package-if-different","why":"one short phrase"}]

Rules:
- Only name tools you are confident actually exist (real binaries, npm packages, brew formulae, or MCP servers).
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

    if (v.installed) {
      // Smoke check: binary answers --version (probe is verb-gated, read-only).
      const pv = await capabilityProbe(v.bin, ['--version']);
      candidates.push(_candidate({
        id: `${name}.agent`, label: `${name} (installed)`, kind: p.kind === 'mcp' ? 'mcp' : 'cli',
        service: name, tool: v.bin, keywords: [name],
        authType: 'none', installed: true, verified: Boolean(pv.ok),
        friction: 0, detail: `Inferred for "${goal}" — ${p.why || 'verified installed'}.`,
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
        id: `${name}.agent`, label: `${name} (${v.evidence} package)`, kind: 'cli',
        service: name, tool: name, keywords: [name],
        authType: 'none', installed: false,
        installCmd: _installCmdFor(p, v), friction: 2,
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
function verbFit(prompt, candidate) {
  const capTokens = new Set();
  for (const cap of candidate.capabilities || []) {
    for (const t of _tokens(cap)) capTokens.add(t);
  }
  // Identity tokens (service/tool/agent id) name the TARGET, not the action —
  // exclude them so "connect to chromecast" can't pin on 'chromecast' alone.
  // Keywords stay IN scope: a keyword can be the action verb itself ("cast").
  const targetTokens = new Set(_tokens(
    [candidate.service, candidate.tool, candidate.id].filter(Boolean).join(' ')));
  const leftovers = _tokens(prompt).filter(t => !targetTokens.has(t));
  // No declared capabilities — fit can't be confirmed, so clarify rather
  // than pin a tool we can't prove does the asked thing.
  if (!capTokens.size) return 'clarify';
  return leftovers.some(t => capTokens.has(t) && !GENERIC_VERB_TOKENS.has(t)) ? 'pin' : 'clarify';
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

module.exports = { searchCapabilities, capabilityProbe, selectCapability, inferCapabilities, verbFit, stampDescriptor, whichCli, SETUP_SUMMARIES, PLATFORM_AFFORDANCES };
