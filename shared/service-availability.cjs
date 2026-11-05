'use strict';

/**
 * service-availability.cjs — is a ThinkDrop service enabled right now?
 *
 * Reads ~/.thinkdrop/service-modes.json (written by scripts/service-gate.mjs
 * and src/main/serviceManager.js) with an mtime-cached read — <1ms after the
 * first call, zero network. This is the cheap "is X off?" check for callers
 * about to hit a service port: off → skip to the caller's unavailable path
 * instead of paying a timeout.
 *
 * FAIL-OPEN by design: missing/corrupt file, unknown service → 'warm'
 * (available). A control-plane bug must never take the data plane down.
 *
 *   const { isServiceOff, serviceMode } = require('./service-availability.cjs');
 *   if (isServiceOff('web-search')) → serve unavailable guidance
 *
 * Modes: 'warm' (running/pinned), 'auto' (gate cold-spawns on demand),
 * 'off' (disabled — gate 503s, callers should not bother).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES_FILE = process.env.THINKDROP_SERVICE_MODES
  || path.join(os.homedir(), '.thinkdrop', 'service-modes.json');

let _cache = { mtime: 0, modes: {} };

function _readModes() {
  try {
    const mtime = fs.statSync(MODES_FILE).mtimeMs;
    if (mtime === _cache.mtime) return _cache.modes;
    _cache = { mtime, modes: JSON.parse(fs.readFileSync(MODES_FILE, 'utf8')) || {} };
  } catch (_) {
    _cache = { mtime: -1, modes: {} };
  }
  return _cache.modes;
}

function serviceMode(id) {
  const m = _readModes()[id];
  return (m === 'off' || m === 'auto' || m === 'warm') ? m : 'warm';
}

function isServiceOff(id) {
  return serviceMode(id) === 'off';
}

module.exports = { serviceMode, isServiceOff, MODES_FILE };
