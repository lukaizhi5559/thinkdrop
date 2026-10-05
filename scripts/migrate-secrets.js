#!/usr/bin/env node
/**
 * migrate-secrets.js — one-time keytar → safeStorage-profile migration.
 *
 * Reads every credential under the legacy keytar service 'thinkdrop',
 * re-stores each through user-memory `profile.store_secret` (SAFE:<cipher>
 * via the Electron crypto bridge), verifies the read-back, then deletes the
 * keytar entry only after the new write verifies.
 *
 * Prereqs:
 *   - ThinkDrop app running (crypto bridge is hosted in Electron main)
 *   - user-memory service on :3001
 *   - keytar installed: run from repo root (uses the app's dep)
 *
 * Usage: node scripts/migrate-secrets.js [--dry-run] [--no-delete]
 */
'use strict';

const DRY_RUN = process.argv.includes('--dry-run');
const NO_DELETE = process.argv.includes('--no-delete');
const SERVICES = ['thinkdrop'];

const { storeSecret, getSecret } = require('../shared/secret-resolve.cjs');

async function main() {
  const keytar = require('keytar'); // legacy dep — still present pre-cleanup

  // Probe the profile service is up (write + read-back of a throwaway key)
  try {
    const test = await storeSecret('__migration_probe__', 'ok');
    if (!test) throw new Error('store_secret returned not-ok');
    const back = await getSecret('__migration_probe__');
    if (back !== 'ok') throw new Error('probe read-back mismatch (bridge down?)');
  } catch (e) {
    console.error(`[migrate] user-memory service not reachable or store failing on :${process.env.USER_MEMORY_PORT || 3001} — start ThinkDrop first.`);
    process.exit(1);
  }

  const creds = [];
  for (const service of SERVICES) {
    const found = await keytar.findCredentials(service).catch(() => []);
    for (const c of found) creds.push({ service, account: c.account, value: c.password });
  }
  console.log(`[migrate] Found ${creds.length} keytar credential(s)${DRY_RUN ? ' (dry run)' : ''}`);

  let migrated = 0, skipped = 0, failed = 0, deleted = 0;
  for (const c of creds) {
    const key = c.account.toLowerCase();
    if (DRY_RUN) { console.log(`  [dry] would migrate ${key}`); migrated++; continue; }
    try {
      const existing = await getSecret(key);
      if (existing) {
        console.log(`  [skip] ${key} already in profile store`);
        skipped++;
      } else {
        const ok = await storeSecret(key, c.value);
        if (!ok) { console.log(`  [fail] ${key} — store_secret returned not-ok`); failed++; continue; }
        const back = await getSecret(key);
        if (back !== c.value) {
          console.log(`  [fail] ${key} — stored but read-back mismatch; keeping keytar entry`);
          failed++;
          continue;
        }
        migrated++;
        console.log(`  [ok] ${key} migrated`);
      }
      if (!NO_DELETE) {
        const del = await keytar.deletePassword(c.service, c.account).catch(() => false);
        if (del) deleted++;
        else console.log(`  [warn] could not delete keytar entry ${key}`);
      }
    } catch (err) {
      failed++;
      console.log(`  [fail] ${key}: ${err.message}`);
    }
  }

  console.log(`\n[migrate] done — migrated:${migrated} skipped:${skipped} failed:${failed} keytar-deleted:${deleted}`);
  if (failed) console.log('[migrate] Re-run after fixing failures; keytar entries were preserved for failed keys.');
}

main().catch(err => { console.error('[migrate] fatal:', err.message); process.exit(1); });
