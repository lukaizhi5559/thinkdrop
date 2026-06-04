const path = require('path');
const os = require('os');
const fs = require('fs');

const AGENTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');
const AGENTS_DIR = path.join(os.homedir(), '.thinkdrop', 'agents');

// Simple logger that works outside of command-service
const logger = {
  debug: (msg) => process.env.DEBUG && console.log(`[agents-db:debug] ${msg}`),
  info: (msg) => console.log(`[agents-db] ${msg}`),
  warn: (msg) => console.warn(`[agents-db:warn] ${msg}`),
  error: (msg) => console.error(`[agents-db:error] ${msg}`),
};

// Promise-chain mutex: serializes all withDb calls within this process.
// DuckDB only allows one exclusive writer lock per file — if two callers
// (e.g. creator.agent at startup + browser.agent during a run) open the DB
// concurrently in the same Node.js process, the second gets an IO lock error.
// This mutex ensures they queue and execute one at a time.
let _mutex = Promise.resolve();

/**
 * Execute a callback with a fresh DuckDB connection.
 * Connection is opened before callback and closed after, following DuckDB best practices.
 * Calls are serialized via a promise-chain mutex to prevent concurrent lock conflicts.
 * @param {Function} callback - Async function receiving (db) parameter
 * @returns {Promise<any>} - Result of the callback
 */
async function withDb(callback) {
  const token = _mutex.then(() => _withDbImpl(callback));
  _mutex = token.catch(() => {}); // keep mutex chain alive even when callers reject
  return token;
}

async function _withDbImpl(callback) {
  // Ensure directories exist
  fs.mkdirSync(path.dirname(AGENTS_DB_PATH), { recursive: true });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });

  let db = null;
  try {
    // Try duckdb-async first
    try {
      const duckdbAsync = require('duckdb-async');
      db = await duckdbAsync.Database.create(AGENTS_DB_PATH);
      logger.debug('Connected via duckdb-async');
    } catch (e1) {
      // Fall back to native duckdb
      const { Database } = require('duckdb');
      const raw = await new Promise((resolve, reject) => {
        const d = new Database(AGENTS_DB_PATH, (err) => {
          if (err) reject(err);
          else resolve(d);
        });
      });
      db = {
        run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
        all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
        get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
        close: () => new Promise((res) => raw.close(() => res())),
      };
      logger.debug('Connected via duckdb native');
    }

    // Initialize tables
    await db.run(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'cli', service TEXT NOT NULL,
      cli_tool TEXT, capabilities TEXT, descriptor TEXT, last_validated TIMESTAMP,
      failure_log TEXT, status TEXT NOT NULL DEFAULT 'healthy', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS browser_meta_cache (
      service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS cli_meta_cache (
      service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Execute callback
    return await callback(db);
  } finally {
    // Always close connection to release lock
    if (db) {
      try {
        // Force close the underlying connection if available
        if (db.close) {
          await db.close();
        } else if (db._db && db._db.close) {
          // Fallback for native duckdb wrapper
          await new Promise((resolve, reject) => {
            db._db.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
        logger.debug('Connection closed');
        // Small delay to ensure filesystem lock is fully released
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (e) {
        logger.warn(`Error closing connection: ${e.message}`);
      }
    }
  }
}

/**
 * Legacy no-op for backward compatibility.
 * With the new pattern, connections are always fresh, so no cache to reset.
 */
function resetDbCache() {
  // No-op - withDb creates fresh connections each time
}

module.exports = {
  withDb,
  resetDbCache,
  AGENTS_DB_PATH,
  AGENTS_DIR,
};
