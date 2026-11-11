'use strict';

/**
 * frontmost-app.cjs — live frontmost-app NAME, cross-platform, no permissions.
 *
 * Exists because `get-windows` couples the app name to window metadata that
 * requires TCC grants (macOS Screen Recording for titles, Accessibility for
 * URLs) — its binary stalls on a buried consent modal when denied, and the
 * name it DID detect gets thrown away with the missing bounds. Consumers that
 * only need to know WHICH app is frontmost (focus verification before
 * synthetic keystrokes, browser-tier selection in read_screen) need a probe
 * that can't be gated by capture permissions.
 *
 * Per-platform probe:
 *   darwin  — System Events `frontmost` (no Accessibility/Screen Recording;
 *             Automation TCC does not apply to System Events itself)
 *   win32   — user32 GetForegroundWindow → GetWindowThreadProcessId → process name
 *   linux   — xprop _NET_ACTIVE_WINDOW → WM_CLASS (X11; Wayland has no
 *             standard equivalent — returns null there)
 *
 * Results are micro-cached (~300ms) so focus-retry loops don't spawn a
 * process per iteration. Fail-soft: null on any error, unsupported platform,
 * or missing tools — callers layer their own fallbacks.
 */

const { execFile } = require('child_process');

const EXEC_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 300;

let _cache = { name: undefined, ts: 0 };

function _exec(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout || '').trim();
      resolve(out || null);
    });
  });
}

async function _darwinName() {
  return _exec('osascript', [
    '-e',
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
}

async function _windowsName() {
  // Single PowerShell invocation: foreground HWND → owning PID → process name.
  // `powershell` (5.1) ships inbox; `pwsh` is not assumed.
  const ps = [
    'Add-Type -TypeDefinition \'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class FG {',
    '  [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);',
    '}\' -ErrorAction SilentlyContinue;',
    '$h = [FG]::GetForegroundWindow();',
    'if ($h -eq [System.IntPtr]::Zero) { exit 1 };',
    '$p = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$p);',
    'if ($p -eq 0) { exit 1 };',
    '(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName',
  ].join(' ');
  return _exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
}

async function _linuxName() {
  // _NET_ACTIVE_WINDOW gives the window id; WM_CLASS's second quoted field is
  // the app class ("Google-chrome", "Org.gnome.Nautilus"). Requires X11 +
  // xprop — absent on Wayland/minimal installs → null.
  const root = await _exec('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
  const winId = root && (root.match(/0x[0-9a-fA-F]+/) || [])[0];
  if (!winId || winId === '0x0') return null;
  const cls = await _exec('xprop', ['-id', winId, 'WM_CLASS']);
  const fields = cls ? [...cls.matchAll(/"([^"]*)"/g)].map(m => m[1]) : [];
  return fields[1] || fields[0] || null;
}

/**
 * @returns {Promise<string|null>} frontmost application name, or null when it
 *   cannot be determined without permissions this probe deliberately avoids.
 */
async function getFrontmostAppName() {
  const now = Date.now();
  if (_cache.name !== undefined && now - _cache.ts < CACHE_TTL_MS) return _cache.name;

  let name = null;
  try {
    if (process.platform === 'darwin') name = await _darwinName();
    else if (process.platform === 'win32') name = await _windowsName();
    else if (process.platform === 'linux') name = await _linuxName();
  } catch (_) {
    name = null;
  }

  _cache = { name, ts: now };
  return name;
}

module.exports = { getFrontmostAppName };
