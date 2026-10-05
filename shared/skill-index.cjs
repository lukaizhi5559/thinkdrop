'use strict';

/**
 * skill-index.cjs — dependency-free index of command-service skill files.
 *
 * One directory scan answers two questions that used to need hand-maintained
 * lists:
 *
 *   skillExists(name)     — `X.cjs`/`X.agent.cjs` present in skills/ → a generic
 *                           execution surface (local or open-web). planPreflight
 *                           treats these as `none-required` for auth — there is
 *                           no account to sign into. Registry service agents
 *                           (google.agent, amazon.agent) have no skill files.
 *
 *   isSessionBound(name)  — the skill's source pulls in browserCore/session
 *                           (withSessionMutex) → it consumes `args.agentId` as
 *                           a browser lane. Steps using session-bound skills
 *                           must share the task's canonical agent or they act
 *                           on different windows/profiles.
 *
 * Cached with dir mtime — rescans automatically when skills are added.
 * Degrades to an empty index when the dir is missing (packaged installs).
 */

const fs = require('fs');
const path = require('path');

function _skillsDir() {
  return process.env.THINKDROP_SKILLS_DIR
    || path.join(__dirname, '..', 'mcp-services', 'command-service', 'src', 'skills');
}

const _SESSION_RE = /browserCore[\\/]session|withSessionMutex/;

let _cache = null; // { dir, mtime, skills: Set<string>, sessionBound: Set<string> }

function _scan() {
  const dir = _skillsDir();
  let mtime = 0;
  try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
  if (_cache && _cache.dir === dir && _cache.mtime === mtime) return _cache;

  const skills = new Set();
  const sessionBound = new Set();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(cjs|js)$/.test(file) || /\.test\.(cjs|js)$/.test(file)) continue;
      const name = file.replace(/\.(cjs|js)$/, '');
      skills.add(name);
      try {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        if (_SESSION_RE.test(src)) sessionBound.add(name);
      } catch (_) {}
    }
  } catch (_) {}

  _cache = { dir, mtime, skills, sessionBound };
  return _cache;
}

/**
 * @param {string} name - skill/agent name, e.g. 'browser.agent', 'web.crawl', 'shell.run'
 * @returns {boolean} true when a matching skill file exists
 */
function skillExists(name) {
  if (!name) return false;
  const n = String(name).trim().toLowerCase();
  const idx = _scan();
  if (idx.skills.has(n)) return true;
  // 'Browser Agent' / 'browser_agent' style drift → browser.agent
  const norm = n.replace(/[\s_]+/g, '.');
  if (idx.skills.has(norm)) return true;
  // registry id without suffix (e.g. 'web' → 'web.agent'? only when unambiguous)
  return false;
}

/**
 * @param {string} name - skill name
 * @returns {boolean} true when the skill consumes a browser session via
 *   args.agentId (requires browserCore/session in its source)
 */
function isSessionBound(name) {
  if (!name) return false;
  const n = String(name).trim().toLowerCase();
  const idx = _scan();
  return idx.sessionBound.has(n) || idx.sessionBound.has(n.replace(/[\s_]+/g, '.'));
}

module.exports = { skillExists, isSessionBound, _skillsDir };
