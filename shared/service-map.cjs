'use strict';

/**
 * service-map.cjs — domain → service-agent resolution, dependency-free.
 *
 * Source of truth: the agent registry at ~/.thinkdrop/agents/<name>.agent.md —
 * each file carries `id:`, `service:`, `start_url:` frontmatter plus URL
 * references in its body (authSuccessUrl, navigation patterns, alternate
 * domains like x.com inside twitter.agent.md).
 *
 * Resolution tiers (sync — zero network):
 *   1. shortener/vanity map          (youtu.be → youtube.com)
 *   2. exact / parent-domain match   (docs.google.com covers subpaths/subs)
 *   3. X.new shortcut → alias table → first-label host match → byName stem
 *   4. learned_domains               (live discoveries, persisted)
 *   miss → null → generic browser lane (honest — no phantom agents)
 *
 * Discovery tier (async — bounded, once per host ever):
 *   serviceForUrlAsync(): sync lookup → HEAD redirect-follow (≤3 hops, 3s,
 *   opt out via THINKDROP_SERVICE_MAP_DISCOVERY=0) → re-lookup resolved host
 *   → conservative web.search fallback (accepts only registry-known hosts)
 *   → persist host→host into learned_domains in the user alias file.
 *
 * Alias data lives in shared/service-aliases.json merged with a user
 * override at ~/.thinkdrop/service-aliases.json (user keys win).
 *
 * Cached with dir mtime — rescans when agents or alias files change.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { canonicalAgent } = require('./agent-canonical.cjs');

function _agentsDir() {
  return process.env.THINKDROP_AGENTS_DIR
    || path.join(os.homedir(), '.thinkdrop', 'agents');
}

function _userAliasesFile() {
  return process.env.THINKDROP_SERVICE_ALIASES
    || path.join(os.homedir(), '.thinkdrop', 'service-aliases.json');
}

const _URL_HOST_RE = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

let _cache = null; // { key, byHost, byName, shortcuts, shorteners, learned }

function _loadJson(file) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), mtime };
  } catch (_) { return { data: null, mtime: 0 }; }
}

function _scan() {
  const dir = _agentsDir();
  const aliasesFile = path.join(__dirname, 'service-aliases.json');
  const userFile = _userAliasesFile();
  const a = _loadJson(aliasesFile);
  const u = _loadJson(userFile);
  let dirMtime = 0;
  try { dirMtime = fs.statSync(dir).mtimeMs; } catch (_) {}

  const key = `${dir}:${dirMtime}:${aliasesFile}:${a.mtime}:${userFile}:${u.mtime}`;
  if (_cache && _cache.key === key) return _cache;

  const shortcut = { ...(a.data?.shortcut_domains || {}), ...(u.data?.shortcut_domains || {}) };
  const shorteners = { ...(a.data?.shorteners || {}), ...(u.data?.shorteners || {}) };
  const learned = { ...(a.data?.learned_domains || {}), ...(u.data?.learned_domains || {}) };

  const byHost = new Map();
  const byName = new Map();
  const files = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.agent.md')) continue;
      let src;
      try { src = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { continue; }
      const idM = src.match(/^id:\s*(\S+)\s*$/m);
      const svcM = src.match(/^service:\s*(\S+)\s*$/m);
      const typeM = src.match(/^type:\s*(\S+)\s*$/m);
      const cliM = src.match(/^cli_tool:\s*(\S+)\s*$/m);
      const secM = src.match(/^secrets:\s*\n((?:\s+-\s*\S+\s*\n?)*)/m)
        || src.match(/^secrets:\s*\[([^\]]*)\]/m);
      const secrets = secM
        ? (secM[1].includes('\n')
            ? secM[1].split('\n').map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean)
            : secM[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean))
        : [];
      const stem = file.replace(/\.agent\.md$/, '');
      const entry = {
        src,
        agentId: idM ? idM[1].trim() : `${stem}.agent`,
        service: svcM ? svcM[1].trim() : stem,
        type: typeM ? typeM[1].trim() : 'browser',
        cliTool: cliM ? cliM[1].trim() : null,
        secrets,
        urlM: src.match(/^start_url:\s*(https?:\/\/\S+)\s*$/m),
        signM: src.match(/^sign_in_url:\s*(https?:\/\/\S+)\s*$/m),
      };
      files.push(entry);
      byName.set(stem, entry);
      byName.set(entry.service, entry);
    }
  } catch (_) {}

  // Pass 1 — frontmatter hosts (start_url/sign_in_url) are authoritative.
  for (const f of files) {
    for (const m of [f.urlM, f.signM]) {
      if (!m) continue;
      try {
        const host = new URL(m[1]).hostname.replace(/^www\./, '');
        if (host && !byHost.has(host)) byHost.set(host, { agentId: f.agentId, service: f.service });
      } catch (_) {}
    }
  }
  // Pass 2 — body URLs document alternate domains (x.com in twitter.agent.md,
  // app.notion.com, mail.yahoo.com) — fill hosts no frontmatter claimed.
  for (const f of files) {
    _URL_HOST_RE.lastIndex = 0;
    let hm;
    while ((hm = _URL_HOST_RE.exec(f.src)) !== null) {
      const h = hm[1].replace(/^www\./, '').toLowerCase();
      if (h && !byHost.has(h) && !shorteners[h]) {
        byHost.set(h, { agentId: f.agentId, service: f.service });
      }
    }
  }

  _cache = { key, byHost, byName, shortcut, shorteners, learned };
  return _cache;
}

function _hit(entry, host) {
  if (!entry) return null;
  return {
    agentId: entry.agentId,
    canonicalAgent: canonicalAgent(entry.agentId) || entry.agentId,
    service: entry.service,
    host,
  };
}

function _lookupHost(host) {
  const idx = _scan();
  // shorteners / learned domains → canonical host first
  const mapped = idx.shorteners[host] || idx.learned[host] || host;
  if (mapped !== host) {
    const m = _lookupHostOnce(idx, mapped);
    if (m) return { ...m, host };
    return null;
  }
  return _lookupHostOnce(idx, host);
}

function _lookupHostOnce(idx, host) {
  // *.new shortcuts: alias → first-label → file-stem/service name.
  if (/^[a-z0-9-]+\.new$/i.test(host)) {
    const alias = idx.shortcut[host];
    if (alias) {
      const t = idx.byHost.get(alias) || _parentLookup(idx, alias);
      if (t) return t;
    }
    const firstLabel = host.split('.')[0];
    for (const [h, svc] of idx.byHost) {
      if (h.split('.')[0] === firstLabel) return svc;
    }
    return byNameEntry(idx, firstLabel);
  }
  return idx.byHost.get(host) || _parentLookup(idx, host);
}

function _parentLookup(idx, host) {
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (idx.byHost.has(parent)) return idx.byHost.get(parent);
  }
  return null;
}

function byNameEntry(idx, name) {
  return idx.byName.get(name) || null;
}

/**
 * Resolve a URL to the registry service agent that owns its domain.
 * Sync, zero network — returns null for unresolvable/public hosts.
 * @returns {{agentId:string, canonicalAgent:string, service:string, host:string}|null}
 */
function serviceForUrl(url) {
  if (!url) return null;
  let host;
  try { host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
  if (!host) return null;
  return _hit(_lookupHost(host), host);
}

/** True when an agentId is a registered service agent (has a .agent.md file). */
function isServiceAgent(agentId) {
  if (!agentId) return false;
  const idx = _scan();
  const name = String(agentId).replace(/\.agent$/, '');
  return idx.byName.has(name);
}

/**
 * All registered agent ids (canonical `.agent` form) with metadata —
 * the catalog injected into the planning directive so the LLM only
 * names agents that actually exist.
 * @returns {Array<{agentId:string, service:string, type:string, cliTool:string|null, secrets:string[]}>}
 */
function listAgentNames() {
  const idx = _scan();
  const seen = new Set();
  const out = [];
  for (const [stem, entry] of idx.byName) {
    if (seen.has(entry.agentId)) continue;
    seen.add(entry.agentId);
    out.push({
      agentId: entry.agentId,
      service: entry.service,
      type: entry.type || 'browser',
      cliTool: entry.cliTool || null,
      secrets: entry.secrets || [],
    });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Suggest the registered agent an unregistered name probably meant —
 * exact stem/service match first, then a UNIQUE substring match
 * ('doc' → 'google_docs'). Returns null when ambiguous or no match.
 */
function suggestAgent(name) {
  if (!name) return null;
  const idx = _scan();
  const clean = String(name).replace(/\.agent$/, '').toLowerCase();
  const exact = idx.byName.get(clean);
  if (exact) return exact.agentId;
  const hits = [];
  const seen = new Set();
  for (const [stem, entry] of idx.byName) {
    if (seen.has(entry.agentId)) continue;
    if (stem.includes(clean) || clean.includes(stem)) {
      seen.add(entry.agentId);
      hits.push(entry.agentId);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Frontmatter metadata for one registered agent, or null if unregistered. */
function describeAgent(agentId) {
  if (!agentId) return null;
  const idx = _scan();
  const entry = idx.byName.get(String(agentId).replace(/\.agent$/, ''));
  return entry
    ? { agentId: entry.agentId, service: entry.service, type: entry.type || 'browser', cliTool: entry.cliTool || null, secrets: entry.secrets || [] }
    : null;
}

// ── Async discovery ──────────────────────────────────────────────────────────

function _discoveryEnabled() {
  return process.env.THINKDROP_SERVICE_MAP_DISCOVERY !== '0';
}

const _inflight = new Map(); // host → Promise

/** Follow redirects (≤3 hops, 3s each) and return the final host. */
function _resolveRedirectHost(url) {
  return new Promise((resolve) => {
    let hops = 0;
    const next = (target) => {
      let u;
      try { u = new URL(target); } catch (_) { return resolve(null); }
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request({
        method: 'HEAD', hostname: u.hostname, path: (u.pathname || '/') + (u.search || ''),
        timeout: 3000, headers: { 'User-Agent': 'ThinkDrop/1.0' },
      }, (res) => {
        res.resume();
        const loc = res.headers.location;
        if (loc && res.statusCode >= 300 && res.statusCode < 400 && ++hops <= 3) {
          return next(new URL(loc, target).href);
        }
        resolve(u.hostname.replace(/^www\./, '').toLowerCase());
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    };
    next(url);
  });
}

/** Persist a learned host→host mapping into the user alias file. */
function _learnDomain(fromHost, toHost) {
  try {
    const file = _userAliasesFile();
    const existing = _loadJson(file).data || {};
    existing.learned_domains = existing.learned_domains || {};
    if (existing.learned_domains[fromHost] === toHost) return;
    existing.learned_domains[fromHost] = toHost;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8');
  } catch (_) {}
}

/** Last-resort semantic fallback — accepts only registry-known hosts. */
async function _searchHostForHost(host) {
  try {
    const port = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'web-search', action: 'web.search',
      payload: { query: `"${host}" website`, maxResults: 3 },
      requestId: 'svcmap_' + Date.now(), context: { userId: 'local_user' },
    });
    const res = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/web.search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 4000,
      }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(body);
    });
    const parsed = res ? JSON.parse(res) : null;
    const results = (parsed?.data?.results || parsed?.data?.organic || []).slice(0, 3);
    const idx = _scan();
    for (const r of results) {
      const link = r.link || r.url || '';
      let h;
      try { h = new URL(link).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { continue; }
      if (h && (idx.byHost.has(h) || _parentLookup(idx, h))) {
        return h;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Async resolver — sync lookup, then bounded discovery for misses.
 * @returns {Promise<{agentId:string, canonicalAgent:string, service:string, host:string}|null>}
 */
async function serviceForUrlAsync(url) {
  const hit = serviceForUrl(url);
  if (hit || !_discoveryEnabled() || !url) return hit;

  let host;
  try { host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
  if (!host || !/^https?:/i.test(String(url))) return null;

  if (_inflight.has(host)) return _inflight.get(host);
  const p = (async () => {
    try {
      // Redirect-follow resolves any .new/shortener/vanity deterministically.
      const resolved = await _resolveRedirectHost(String(url));
      if (resolved && resolved !== host) {
        const r = serviceForUrl(`https://${resolved}`);
        if (r) { _learnDomain(host, resolved); return { ...r, host }; }
      }
      // Semantic fallback — only accepts registry-known hosts.
      const found = await _searchHostForHost(host);
      if (found && found !== host) {
        const r = serviceForUrl(`https://${found}`);
        if (r) { _learnDomain(host, found); return { ...r, host }; }
      }
      return null;
    } finally {
      _inflight.delete(host);
    }
  })();
  _inflight.set(host, p);
  return p;
}

module.exports = { serviceForUrl, serviceForUrlAsync, isServiceAgent, listAgentNames, suggestAgent, describeAgent, _agentsDir };
