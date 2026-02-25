/**
 * scheduler.js — Persistent task scheduler for ThinkDrop
 *
 * When a `schedule` step fires, this module:
 *  1. Writes ~/.thinkdrop/pending-schedule.json with the full skillPlan
 *  2. Creates a launchd plist at ~/Library/LaunchAgents/com.thinkdrop.schedule.<id>.plist
 *  3. Loads it via `launchctl load` so macOS launches ThinkDrop at the target time
 *
 * On app startup, main.js calls checkPendingSchedule() which reads the JSON and
 * sends a 'schedule:pending' IPC event to ResultsWindow for user confirmation.
 *
 * After confirmation (or cancellation) the JSON and plist are cleaned up.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const THINKDROP_DIR    = path.join(os.homedir(), '.thinkdrop');
const PENDING_FILE     = path.join(THINKDROP_DIR, 'pending-schedule.json');
const LAUNCH_AGENTS    = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PREFIX     = 'com.thinkdrop.schedule';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function plistPath(id) {
  return path.join(LAUNCH_AGENTS, `${PLIST_PREFIX}.${id}.plist`);
}

/** Return the absolute path to the Electron app binary, or null in dev mode. */
function getAppPath() {
  // In dev mode the execPath is the raw Electron binary — launchd can't
  // reliably target it, so we skip plist creation and rely on the pending
  // JSON file fallback (re-run on next app open).
  if (process.env.NODE_ENV === 'development') return null;

  // In production: if running inside a .app bundle, use open -a <app> so
  // launchd launches the full packaged app rather than the raw binary.
  const execPath = process.execPath;
  const appBundleMatch = execPath.match(/^(.+\.app)\/Contents\/MacOS\/.+$/);
  if (appBundleMatch) return appBundleMatch[1]; // e.g. /Applications/ThinkDrop.app
  return execPath;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a pending scheduled task.
 *
 * @param {object} opts
 * @param {string}  opts.id          Unique ID for this schedule (e.g. "sched_1234")
 * @param {number}  opts.targetMs    Unix timestamp (ms) when the task should fire
 * @param {string}  opts.label       Human-readable description
 * @param {string}  opts.prompt      Original user prompt to re-run
 * @param {Array}   opts.skillPlan   Full skill plan array (steps after the schedule step)
 */
function registerSchedule({ id, targetMs, label, prompt, skillPlan }) {
  ensureDir(THINKDROP_DIR);

  const record = { id, targetMs, label, prompt, skillPlan, registeredAt: Date.now() };
  fs.writeFileSync(PENDING_FILE, JSON.stringify(record, null, 2), 'utf8');
  console.log(`[Scheduler] Wrote pending-schedule.json for "${label}" at ${new Date(targetMs).toLocaleTimeString()}`);

  const appPath = getAppPath();

  if (!appPath) {
    // Dev mode — launchd skipped. If app is closed before countdown ends,
    // re-opening the app will auto-run the task via pending-schedule.json fallback.
    console.log(`[Scheduler] Dev mode — launchd skipped. Pending JSON written as fallback.`);
    return record;
  }

  ensureDir(LAUNCH_AGENTS);

  // launchd StartCalendarInterval uses local time — parse targetMs into components
  const d      = new Date(targetMs);
  const hour   = d.getHours();
  const minute = d.getMinutes();

  // Use 'open -a App.app --args flag' for .app bundles, direct binary otherwise
  const isAppBundle = appPath.endsWith('.app');
  const programArgs = isAppBundle
    ? `    <string>/usr/bin/open</string>\n    <string>-a</string>\n    <string>${appPath}</string>\n    <string>--args</string>\n    <string>--scheduled-task=${id}</string>`
    : `    <string>${appPath}</string>\n    <string>--scheduled-task=${id}</string>`;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_PREFIX}.${id}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${THINKDROP_DIR}/schedule-${id}.log</string>
  <key>StandardErrorPath</key>
  <string>${THINKDROP_DIR}/schedule-${id}-err.log</string>
</dict>
</plist>`;

  const pp = plistPath(id);
  fs.writeFileSync(pp, plist, 'utf8');
  console.log(`[Scheduler] Wrote launchd plist: ${pp}`);

  // Load the plist so launchd picks it up immediately
  try {
    execSync(`launchctl load "${pp}"`, { stdio: 'ignore' });
    console.log(`[Scheduler] launchctl load OK — will fire at ${hour}:${String(minute).padStart(2, '0')}`);
  } catch (err) {
    console.warn(`[Scheduler] launchctl load failed (non-fatal): ${err.message}`);
  }

  return record;
}

/**
 * Read the pending-schedule.json file.
 * Returns the record if valid and the target time is still in the future (or within 10min past),
 * otherwise returns null.
 */
function readPendingSchedule() {
  if (!fs.existsSync(PENDING_FILE)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    if (!record || !record.id || !record.targetMs) return null;
    // Accept if fired within the last 10 minutes (launchd may have a slight delay)
    const now = Date.now();
    if (record.targetMs < now - 10 * 60 * 1000) {
      console.log('[Scheduler] Pending schedule is stale (>10min past target) — discarding');
      clearPendingSchedule(record.id);
      return null;
    }
    return record;
  } catch (err) {
    console.warn('[Scheduler] Failed to read pending-schedule.json:', err.message);
    return null;
  }
}

/**
 * Remove the pending-schedule.json and unload/delete the launchd plist.
 */
function clearPendingSchedule(id) {
  // Remove JSON
  if (fs.existsSync(PENDING_FILE)) {
    try { fs.unlinkSync(PENDING_FILE); } catch (_) {}
  }

  if (!id) return;

  // Unload + delete plist
  const pp = plistPath(id);
  if (fs.existsSync(pp)) {
    try { execSync(`launchctl unload "${pp}"`, { stdio: 'ignore' }); } catch (_) {}
    try { fs.unlinkSync(pp); } catch (_) {}
    console.log(`[Scheduler] Cleared launchd plist: ${pp}`);
  }
}

/**
 * Returns the schedule ID from process args if app was launched by launchd for a scheduled task.
 * e.g. process.argv includes "--scheduled-task=sched_1234"
 */
function getLaunchedScheduleId() {
  const flag = process.argv.find(a => a.startsWith('--scheduled-task='));
  return flag ? flag.replace('--scheduled-task=', '') : null;
}

module.exports = { registerSchedule, readPendingSchedule, clearPendingSchedule, getLaunchedScheduleId };
