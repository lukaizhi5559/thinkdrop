'use strict';

/**
 * browser-automation.cjs — the browser-driving kill switch.
 *
 * Chrome/Playwright navigation is the highest-flake, highest-blast-radius
 * surface (sign-in walls, wrong-tab adoption, real publishes on draft asks).
 * `browserAutomation: false` in ~/.thinkdrop/settings.json disables the
 * UI-driving skills below; THINKDROP_BROWSER_AUTOMATION=off overrides for
 * tests/isolated processes.
 *
 * Bare-minimum disable set (per user direction): extension-bound atomics that
 * work in practice — form.fill, tab.map, just.type, meta.find,
 * shortcut.keys, app.agent (scan_page) — stay enabled. Navigation moves to
 * `shell.run open <url>` + `app.agent scan_page` (see planSkillsV2 rewrites).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BROWSER_DRIVING_SKILLS = new Set([
  'browser.act', 'browser.agent', 'playwright.agent', 'url.first.agent',
  'turn.loop.agent', 'dom.act', 'gesture.agent', 'arrow.grid.agent',
]);

const SETTINGS_FILE = path.join(os.homedir(), '.thinkdrop', 'settings.json');

function isBrowserAutomationEnabled() {
  const env = process.env.THINKDROP_BROWSER_AUTOMATION;
  if (env != null && env !== '') return !/^(0|off|false|no)$/i.test(env);
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s.browserAutomation === false || s.browserAutomation === 'off') return false;
  } catch (_) {}
  return true;
}

module.exports = { BROWSER_DRIVING_SKILLS, isBrowserAutomationEnabled, SETTINGS_FILE };
