/**
 * cryptoBridge.js  — Main-process side
 *
 * Starts a local HTTP server that exposes encrypt/decrypt endpoints backed by
 * Electron's `safeStorage` API.  safeStorage uses the OS-level credential
 * store (macOS: Keychain Access, Windows: DPAPI, Linux: libsecret) with a
 * single app-level encryption key the user approves ONCE, rather than one
 * OS prompt per credential.
 *
 * The bridge configuration (URL + bearer token) is written to
 *   ~/.thinkdrop/.crypto-bridge.json   (chmod 0600)
 * so the user-memory service can discover and call it without hard-coded ports.
 *
 * API:
 *   POST /encrypt   { plaintext: string }  → { ciphertext: string }  (base64)
 *   POST /decrypt   { ciphertext: string } → { plaintext: string }
 *   GET  /health                           → { ok: true }
 *
 * Authentication: Bearer token in Authorization header.
 * All endpoints are bound to 127.0.0.1 only — not accessible from the network.
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.thinkdrop', '.crypto-bridge.json');

let _server = null;
let _token  = null;

/**
 * Start the crypto bridge server.
 * Must be called after app.whenReady() so safeStorage is available.
 *
 * @param {import('electron').safeStorage} safeStorage - Electron safeStorage module
 * @returns {Promise<{ url: string, token: string }>}
 */
function startCryptoBridge(safeStorage) {
  return new Promise((resolve, reject) => {
    if (_server) {
      // Already running
      return resolve({ url: _getConfig()?.url, token: _token });
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return reject(new Error('[CryptoBridge] safeStorage encryption not available on this system'));
    }

    // Generate a random bearer token for this session
    _token = crypto.randomBytes(32).toString('hex');

    const server = http.createServer((req, res) => {
      // Only accept loopback connections
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }

      // Auth
      const authHeader = req.headers['authorization'] || '';
      if (authHeader !== `Bearer ${_token}`) {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      res.setHeader('Content-Type', 'application/json');

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        return;
      }

      // Read body
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);

          if (req.method === 'POST' && req.url === '/encrypt') {
            if (typeof payload.plaintext !== 'string') {
              res.writeHead(400).end(JSON.stringify({ error: 'plaintext must be a string' }));
              return;
            }
            const encrypted = safeStorage.encryptString(payload.plaintext);
            res.writeHead(200).end(JSON.stringify({ ciphertext: encrypted.toString('base64') }));
            return;
          }

          if (req.method === 'POST' && req.url === '/decrypt') {
            if (typeof payload.ciphertext !== 'string') {
              res.writeHead(400).end(JSON.stringify({ error: 'ciphertext must be a string' }));
              return;
            }
            const buf = Buffer.from(payload.ciphertext, 'base64');
            const plaintext = safeStorage.decryptString(buf);
            res.writeHead(200).end(JSON.stringify({ plaintext }));
            return;
          }

          res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          res.writeHead(500).end(JSON.stringify({ error: err.message }));
        }
      });
    });

    // Bind to a random available loopback port
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url      = `http://127.0.0.1:${port}`;
      _server = server;

      // Write config for user-memory service to discover
      const config = { url, token: _token };
      try {
        const dir = path.dirname(CONFIG_PATH);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600, encoding: 'utf8' });
        console.log(`[CryptoBridge] Started at ${url} — config written to ${CONFIG_PATH}`);
      } catch (writeErr) {
        console.warn('[CryptoBridge] Failed to write bridge config:', writeErr.message);
      }

      resolve({ url, token: _token });
    });

    server.on('error', (err) => {
      reject(new Error(`[CryptoBridge] Server error: ${err.message}`));
    });
  });
}

/**
 * Stop the crypto bridge server and delete the config file.
 */
function stopCryptoBridge() {
  if (_server) {
    _server.close();
    _server = null;
  }
  try { fs.unlinkSync(CONFIG_PATH); } catch (_) {}
  _token = null;
}

/**
 * Read an existing bridge config from disk.
 * @returns {{ url: string, token: string } | null}
 */
function _getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

module.exports = { startCryptoBridge, stopCryptoBridge };
