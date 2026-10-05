'use strict';

/**
 * secret-resolve.cjs — canonical secret resolution for agent runs.
 *
 * Store: user-memory profile (thinkdrop-user-memory-service :3001).
 *   profile.store_secret writes SAFE:<ciphertext> (Electron safeStorage via
 *   crypto bridge) or KEYTAR:<key> fallback refs — never plaintext at rest.
 *   profile.get transparently decrypts both ref kinds.
 *
 * Key shapes probed per env var (all lowercased by the profile service):
 *   credential:<agentId>:<ENV>     — agent-scoped credentials (canonical)
 *   <agentId>_<env>                — legacy cli-agents:store-credential writes
 *   skill:<skillName>:<env>        — migrated skill secrets
 *   process.env[ENV]               — already in the environment
 *
 * Plaintext only exists in-process for env injection — never logged/persisted.
 */

const http = require('http');

const MEM_PORT = parseInt(process.env.USER_MEMORY_PORT || '3001', 10);

function _memKey() {
  return process.env.MCP_USER_MEMORY_API_KEY
    || process.env.USER_MEMORY_API_KEY
    || process.env.MCP_API_KEY
    || '';
}

function _post(action, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'user-memory', action,
      payload, requestId: `secres_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    const req = http.request({
      hostname: '127.0.0.1', port: MEM_PORT, path: `/${action}`, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(_memKey() ? { 'Authorization': `Bearer ${_memKey()}` } : {}),
      },
      timeout: 5000,
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

/** profile.get → plaintext value or null (SAFE:/KEYTAR: decrypt is transparent).
 *  store_secret rows live under `<key>_ref`; plain profile.set rows under `<key>`. */
async function _profileGet(key) {
  const k = key.toLowerCase();
  for (const probe of [k, `${k}_ref`]) {
    const res = await _post('profile.get', { key: probe });
    const row = res?.data;
    if (!row) continue;
    const v = row.valueRef ?? row.value_ref ?? null;
    // An undecrypted SAFE:/KEYTAR: ref means the backing store couldn't resolve —
    // treat as missing rather than leaking the ref string into a process env.
    if (typeof v === 'string' && (v.startsWith('SAFE:') || v.startsWith('KEYTAR:'))) continue;
    if (typeof v === 'string' && v.length) return v;
  }
  return null;
}

/**
 * Resolve declared env-var names for an agent into actual values.
 * @param {string} agentId   e.g. 'justscrape.agent' (suffix optional)
 * @param {string[]} envNames e.g. ['SGAI_API_KEY', 'API_TOKEN']
 * @param {string} [skillName] optional skill name for skill:<name>:<env> keys
 * @returns {Promise<{found: Record<string,string>, missing: string[]}>}
 */
async function resolveAgentSecrets(agentId, envNames, skillName) {
  const found = {};
  const missing = [];
  const agent = String(agentId || '').replace(/\.agent$/, '').toLowerCase();
  for (const raw of envNames || []) {
    const env = String(raw).trim();
    if (!env) continue;
    try {
      const v = (agent && await _profileGet(`credential:${agent}:${env}`))
        || (agent && await _profileGet(`${agent}_${env}`))
        || (skillName && await _profileGet(`skill:${skillName}:${env}`))
        || (process.env[env] || null);
      if (v) found[env] = v; else missing.push(env);
    } catch (_) { missing.push(env); }
  }
  return { found, missing };
}

/** Store one credential under the canonical agent-scoped key. */
async function storeAgentSecret(agentId, envName, value, service) {
  const agent = String(agentId || '').replace(/\.agent$/, '').toLowerCase();
  return storeSecret(`credential:${agent}:${envName}`, value, {
    service: service || agent,
    label: `Credential for ${agentId} (${envName})`,
  });
}

/** Store any secret under an explicit profile key (encrypted SAFE:/KEYTAR: ref). */
async function storeSecret(key, value, { service = 'thinkdrop', label } = {}) {
  const res = await _post('profile.store_secret', {
    keytarKey: String(key).toLowerCase(),
    value: String(value),
    service,
    label: label || `Secret ${key}`,
  });
  return res?.status === 'ok' || res?.data?.stored === true || res?.stored === true;
}

/** Single-key plaintext read — profile.get decrypts SAFE:/KEYTAR: transparently. */
async function getSecret(key) {
  return _profileGet(String(key));
}

/** Delete both the plain row and its `_ref` twin via profile.delete. */
async function deleteSecret(key) {
  try {
    const k = String(key).toLowerCase();
    const a = await _post('profile.delete', { key: k });
    const b = await _post('profile.delete', { key: `${k}_ref` });
    return a?.status === 'ok' || b?.status === 'ok';
  } catch (_) { return false; }
}

/** profile.list keys — accounts enumeration for prefix scans. */
async function findSecrets(prefix) {
  const res = await _post('profile.list', {});
  const entries = res?.data?.entries || [];
  return entries
    .map(e => e.key)
    .filter(k => typeof k === 'string' && (!prefix || k.startsWith(String(prefix).toLowerCase())))
    .map(account => ({ account }));
}

/**
 * keytar-compatible adapter — drop-in for `keytar.getPassword/setPassword/…`
 * sites so existing call shapes keep working against the encrypted store.
 * `service` arg is ignored (profile keys are already namespaced).
 */
function secretStoreAdapter() {
  return {
    getPassword: async (_service, key) => getSecret(key),
    setPassword: async (_service, key, value) => { await storeSecret(key, value); },
    deletePassword: async (_service, key) => { await deleteSecret(key); },
    findCredentials: async (_service) => findSecrets(''),
  };
}

module.exports = { resolveAgentSecrets, storeAgentSecret, storeSecret, getSecret, deleteSecret, findSecrets, secretStoreAdapter };
