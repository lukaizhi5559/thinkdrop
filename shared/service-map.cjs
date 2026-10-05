'use strict';

/**
 * service-map.cjs — domain → service-agent resolution, dependency-free.
 *
 * Source of truth: the agent registry at ~/.thinkdrop/agents/<name>.agent.md —
 * each file carries `id:`, `service:`, `start_url:` frontmatter. We build
 * hostname → agentId so a step URL like https://docs.new resolves to the
 * canonical service agent (google_docs.agent → google.agent) instead of a
 * generic unauthed browser lane.
 *
 * `X.new` shortcut domains (docs.new, sheets.new, meet.new) never appear as
 * start_urls — resolved by a first-label heuristic: the shortcut's first label
 * matches the service host's first label (docs.new → docs.google.com), with a
 * small alias table for mismatches (x.new → twitter.com, notion.new → notion.so).
 *
 * Public hosts (wikipedia.org, github.com/issues/…) return null — a generic
 * browser lane is correct for those.
 *
 * Cached with dir mtime — rescans when agents are added/edited.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalAgent } = require('./agent-canonical.cjs');

function _agentsDir() {
  return process.env.THINKDROP_AGENTS_DIR
    || path.join(os.homedir(), '.thinkdrop', 'agents');
}

// *.new shortcuts whose first label doesn't match the service host's first
// label (x.new → twitter.com, not "x.com").
const _SHORTCUT_ALIASES = {
  'x.new': 'twitter.com',
  'notion.new': 'notion.so',
  'canva.new': 'canva.com',
  'figma.new': 'figma.com',
  'github.new': 'github.com',
  'linear.new': 'linear.app',
  'spotify.new': 'spotify.com',
};

// URL shorteners / vanity domains that appear in NO registry file — resolved
// to their canonical service host before lookup. Everything else the registry
// already documents: every https://host inside each .agent.md body is indexed.
const _SHORTENER_MAP = {
  'x.com': 'twitter.com',
  'youtu.be': 'youtube.com',
  'amzn.to': 'amazon.com',
  't.co': 'twitter.com',
  'fb.me': 'facebook.com',
  'instagr.am': 'instagram.com',
};

const _URL_HOST_RE = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

let _cache = null; // { dir, mtime, byHost: Map<host, {agentId, service}> }

function _scan() {
  const dir = _agentsDir();
  let mtime = 0;
  try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
  if (_cache && _cache.dir === dir && _cache.mtime === mtime) return _cache;

  const byHost = new Map();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.agent.md')) continue;
      let src;
      try { src = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { continue; }
      const idM = src.match(/^id:\s*(\S+)\s*$/m);
      const svcM = src.match(/^service:\s*(\S+)\s*$/m);
      const urlM = src.match(/^start_url:\s*(https?:\/\/\S+)\s*$/m);
      const signM = src.match(/^sign_in_url:\s*(https?:\/\/\S+)\s*$/m);
      const agentId = idM ? idM[1].trim() : file.replace(/\.agent\.md$/, '.agent');
      const service = svcM ? svcM[1].trim() : agentId.replace(/\.agent$/, '');
      for (const m of [urlM, signM]) {
        if (!m) continue;
        try {
          const host = new URL(m[1]).hostname.replace(/^www\./, '');
          if (host && !byHost.has(host)) byHost.set(host, { agentId, service });
        } catch (_) {}
      }
      // Body URLs document alternate domains (x.com in twitter.agent.md,
      // app.notion.com, mail.yahoo.com) — claim any host not already owned
      // by frontmatter. Same-service collisions canonicalize together anyway.
      _URL_HOST_RE.lastIndex = 0;
      let hm;
      while ((hm = _URL_HOST_RE.exec(src)) !== null) {
        const h = hm[1].replace(/^www\./, '').toLowerCase();
        if (h && !byHost.has(h) && !_SHORTENER_MAP[h]) {
          byHost.set(h, { agentId, service });
        }
      }
    }
  } catch (_) {}

  _cache = { dir, mtime, byHost };
  return _cache;
}

/**
 * Resolve a URL to the registry service agent that owns its domain.
 * @param {string} url
 * @returns {{agentId:string, canonicalAgent:string, service:string, host:string}|null}
 *   null when the host belongs to no registered service (public web).
 */
function serviceForUrl(url) {
  if (!url) return null;
  let host;
  try { host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
  if (!host) return null;

  const { byHost } = _scan();

  // Shorteners/vanity domains resolve to their canonical service host first
  // (youtu.be → youtube.com), so the registry lookup sees the real domain.
  const mappedHost = _SHORTENER_MAP[host] || host;

  // *.new shortcuts redirect to the canonical service — map BEFORE exact match.
  if (/^[a-z0-9-]+\.new$/i.test(host)) {
    const alias = _SHORTCUT_ALIASES[host];
    const firstLabel = host.split('.')[0];
    let target = alias ? byHost.get(alias) : null;
    if (!target) {
      for (const [h, svc] of byHost) {
        if (h.split('.')[0] === firstLabel) { target = svc; break; }
      }
    }
    if (!target) return null;
    return {
      agentId: target.agentId,
      canonicalAgent: canonicalAgent(target.agentId) || target.agentId,
      service: target.service,
      host,
    };
  }

  // Exact or parent-domain match (docs.google.com covers docs.google.com/x).
  let hit = byHost.get(host);
  if (!hit) {
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      if (byHost.has(parent)) { hit = byHost.get(parent); break; }
    }
  }
  if (!hit) return null;
  return {
    agentId: hit.agentId,
    canonicalAgent: canonicalAgent(hit.agentId) || hit.agentId,
    service: hit.service,
    host,
  };
}

/** True when an agentId is a registered service agent (has a .agent.md file). */
function isServiceAgent(agentId) {
  if (!agentId) return false;
  const idx = _scan();
  for (const svc of idx.byHost.values()) {
    if (svc.agentId === agentId) return true;
  }
  // Also accept agents whose files exist but carry no URLs.
  try {
    return fs.existsSync(path.join(idx.dir, `${agentId}.md`))
        || fs.existsSync(path.join(idx.dir, `${agentId}.agent.md`));
  } catch (_) { return false; }
}

module.exports = { serviceForUrl, isServiceAgent, _agentsDir };
