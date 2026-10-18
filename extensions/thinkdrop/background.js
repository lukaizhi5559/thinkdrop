/**
 * ThinkDrop Bridge — background service worker (MV3)
 *
 * Click the toolbar icon to connect/disconnect the user's real Chrome to the
 * ThinkDrop command-service (ws://127.0.0.1:3007/ext). While connected, the
 * service sends { type:'cmd', id, sessionId, action, args } commands which this
 * worker executes against tabs via chrome.debugger (real CDP — same protocol
 * Playwright uses) and chrome.tabs.
 *
 * Session → tab resolution (resolveTab):
 *   ext:default      → the currently active tab (last focused normal window)
 *   ext:bg:<name>    → adopt-or-create, never focused (cron/background work)
 *   ext:open:<name>  → adopt-open: newest host-matching tab in any window
 *                      (never focused); else create a background tab
 *   ext:<name>       → front-or-new: registry hit → reuse; else the ACTIVE
 *                      tab if its host matches → bind; else a new tab
 *                      (active only when the caller passes activate:true).
 * The `open:` prefix is a resolution hint only — registry keys strip it so
 * ext:open:amazon and ext:amazon share one binding.
 * sessionTabs persists in chrome.storage.session — MV3 worker restarts keep
 * bindings instead of orphaning into duplicate about:blank tabs.
 */

const WS_URL = 'ws://127.0.0.1:3007/ext';
const KEEPALIVE_ALARM = 'td-keepalive';
const RECONNECT_ALARM = 'td-reconnect';

let ws = null;
let enabled = false;            // user toggle (persisted)
let reconnectDelay = 1000;

const sessionTabs = new Map();  // canonical sessionId → tabId (persisted)
const attachedTabs = new Set(); // tabIds with chrome.debugger attached
const pendingNavs = new Map();  // tabId → {resolve, timer}

// ---------------------------------------------------------------------------
// Registry persistence — chrome.storage.session survives service-worker restarts
// for the life of the browser session (unlike storage.local: cleared on update).
// Without this, an SW restart loses bindings and resolveTab re-creates tabs for
// already-bound sessions → duplicate about:blank tabs that fail page probes.
// ---------------------------------------------------------------------------
let _hydratedResolve;
const registryHydrated = new Promise(r => { _hydratedResolve = r; });
(async () => {
  try {
    const r = await chrome.storage.session.get(['tdSessionTabs']);
    const obj = r.tdSessionTabs || {};
    for (const [k, tid] of Object.entries(obj)) {
      if (await getTab(tid)) sessionTabs.set(k, tid); // prune dead tabIds
    }
  } catch (_) {}
  // Debugger attachments outlive the worker — rebuild so we don't re-attach.
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null) attachedTabs.add(t.tabId);
    }
  } catch (_) {}
  _hydratedResolve();
})();

function persistRegistry() {
  try { return chrome.storage.session.set({ tdSessionTabs: Object.fromEntries(sessionTabs) }); }
  catch (_) { return Promise.resolve(); }
}
// Awaited before resolveTab returns — the binding must be durable before the
// gateway sees the tab, or a worker suspend in the gap orphans it (the exact
// adopt→duplicate-create failure observed in command.log).
async function bindSession(key, tabId) {
  // One session per tab — a navigate issued under the wrong session must not
  // leave two sessions claiming the same tab (the loser then drives a page it
  // never opened).
  for (const [k, tid] of sessionTabs) if (k !== key && tid === tabId) sessionTabs.delete(k);
  sessionTabs.set(key, tabId);
  await persistRegistry();
}
async function unbindSession(key) { sessionTabs.delete(key); await persistRegistry(); }

// ---------------------------------------------------------------------------
// Persistent enabled flag (survives service-worker restarts)
// ---------------------------------------------------------------------------
chrome.storage.local.get(['tdEnabled']).then(r => {
  enabled = !!r.tdEnabled;
  if (enabled) {
    armWatchdog();
    connect();
  }
});

// Periodic watchdog — armed for the whole enabled period, survives worker death.
function armWatchdog() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

async function setEnabled(v) {
  enabled = v;
  await chrome.storage.local.set({ tdEnabled: v });
  updateBadge();
  if (v) { armWatchdog(); connect(); } else disconnect();
}

function updateBadge() {
  const on = enabled && ws && ws.readyState === WebSocket.OPEN;
  chrome.action.setBadgeText({ text: on ? 'ON' : enabled ? '…' : '' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#0aa25f' : '#c77d02' });
}

chrome.action.onClicked.addListener(() => setEnabled(!enabled));

// Keep the MV3 service worker alive while connected (Chrome kills it ~30s idle).
// The keepalive alarm is armed for the ENTIRE enabled period — not only while
// the WS is open — because it doubles as the reconnect watchdog: periodic
// alarms persist across service-worker death and will wake the worker within
// ~30s to reconnect. (A one-shot alarm scheduled inside ws.onclose can race
// the worker unload when the server restart kills socket+worker together.)
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE_ALARM) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    } else {
      // Disconnected — storage is the source of truth on a fresh worker wake
      // (in-memory `enabled` may not have resolved yet).
      chrome.storage.local.get(['tdEnabled']).then(r => {
        enabled = !!r.tdEnabled;
        if (enabled) connect(); else updateBadge();
      });
    }
    updateBadge();
  }
  if (a.name === RECONNECT_ALARM) {
    chrome.storage.local.get(['tdEnabled']).then(r => {
      enabled = !!r.tdEnabled;
      if (enabled) connect();
    });
  }
});

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------
function connect() {
  if (!enabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try { ws = new WebSocket(WS_URL); } catch (_) { scheduleReconnect(); return; }
  updateBadge();

  ws.onopen = () => {
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'hello', ua: navigator.userAgent, version: chrome.runtime.getManifest().version }));
    updateBadge();
  };

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'cmd') { handleCmd(msg); }
    else if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {} }
  };

  ws.onclose = () => { ws = null; updateBadge(); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function disconnect() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  chrome.alarms.clear(RECONNECT_ALARM);
  try { if (ws) ws.close(); } catch (_) {}
  ws = null;
  detachAllDebuggers();
  updateBadge();
}

function scheduleReconnect() {
  if (!enabled) return;
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: Math.max(0.016, reconnectDelay / 60000) });
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

// Wake-trigger reconnect — Chrome defers alarms on occluded/idle windows, so
// tab activity (any user browsing wakes this SW) doubles as a reconnect check.
// Cheap: no-op while the socket is OPEN or CONNECTING.
function reconnectIfNeeded() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  chrome.storage.local.get(['tdEnabled']).then(r => {
    enabled = !!r.tdEnabled;
    if (enabled) connect();
  });
}

// Keepalive ports from content scripts (keepalive.js on every page). A held
// port keeps this SW alive while any web page is open, so ws.onclose fires the
// moment the command service restarts and the ~1s reconnect alarm lands on a
// live worker — not a deferred-alarm dead one. The connect itself also woke
// this worker if it was dead, so check the socket on every new port.
const keepalivePorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'td-keepalive') return;
  keepalivePorts.add(port);
  port.onDisconnect.addListener(() => keepalivePorts.delete(port));
  reconnectIfNeeded();
});

function sendResult(id, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'result', id, ...payload })); } catch (_) {}
  }
}

function sendEvent(event, extra = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'event', event, ...extra })); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Tab registry — sessionId ↔ tabId
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(reconnectIfNeeded);

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sid, tid] of sessionTabs) {
    if (tid === tabId) { unbindSession(sid); sendEvent('tabClosed', { sessionId: sid, tabId }); }
  }
  attachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener((target, reason) => {
  const tabId = target.tabId;
  attachedTabs.delete(tabId);
  for (const [sid, tid] of sessionTabs) {
    if (tid === tabId) sendEvent('debuggerDetached', { sessionId: sid, tabId, reason });
  }
});

// Navigation completion tracking + bound-tab URL reporting — the gateway
// caches session→{url,title} for /ext.sessions (live-page referents like
// "goto exodus 4 here" resolve against the bound tab, not the frontmost app).
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  reconnectIfNeeded();
  if (info.status === 'complete' && pendingNavs.has(tabId)) {
    const p = pendingNavs.get(tabId);
    clearTimeout(p.timer);
    pendingNavs.delete(tabId);
    p.resolve(true);
  }
  if (!(info.url || info.title || info.status === 'complete')) return;
  (async () => {
    await registryHydrated;
    for (const [sid, tid] of sessionTabs) {
      if (tid === tabId) {
        sendEvent('tabNavigated', { sessionId: sid, tabId, url: tab?.url, title: tab?.title });
        break;
      }
    }
  })();
});

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Host matching — url host (authoritative) else session-name aliases + fuzzy
// ---------------------------------------------------------------------------
const HOST_ALIASES = {
  gmail: ['mail.google.com', 'gmail.'], googlemail: ['mail.google.com'],
  google: ['google.com'], youtube: ['youtube.'], amazon: ['amazon.'],
  drive: ['drive.google.com'], docs: ['docs.google.com'],
  sheets: ['sheets.google.com'], slides: ['slides.google.com'],
  calendar: ['calendar.google.com'], maps: ['maps.google.'],
  photos: ['photos.google.com'], meet: ['meet.google.com'],
  x: ['x.com', 'twitter.com'], twitter: ['x.com', 'twitter.com'],
  github: ['github.com'], gitlab: ['gitlab.'], stackoverflow: ['stackoverflow.com'],
  netflix: ['netflix.com'], facebook: ['facebook.'], fb: ['facebook.'],
  instagram: ['instagram.'], linkedin: ['linkedin.'], reddit: ['reddit.'],
  pinterest: ['pinterest.'], tiktok: ['tiktok.'], twitch: ['twitch.'],
  ebay: ['ebay.'], walmart: ['walmart.'], target: ['target.'], etsy: ['etsy.com'],
  costco: ['costco.com'], airbnb: ['airbnb.'], instacart: ['instacart.com'],
  slack: ['slack.com', 'app.slack.com'], discord: ['discord.com'],
  whatsapp: ['web.whatsapp.com'], telegram: ['web.telegram.org'],
  messenger: ['messenger.com'], notion: ['notion.'], figma: ['figma.com'],
  canva: ['canva.'], dropbox: ['dropbox.'], outlook: ['outlook.'],
  office: ['office.com', 'microsoft365.com'], icloud: ['icloud.com'],
  jira: ['atlassian.net', 'jira.'], confluence: ['atlassian.net'],
  trello: ['trello.com'], asana: ['app.asana.com'], linear: ['linear.app'],
  vercel: ['vercel.com'], netlify: ['netlify.com'], zoom: ['zoom.'],
  chatgpt: ['chatgpt.com', 'chat.openai.com'], openai: ['openai.com'],
  claude: ['claude.ai'], gemini: ['gemini.google.com'],
  perplexity: ['perplexity.ai'], substack: ['substack.com'],
  medium: ['medium.com'], spotify: ['spotify.com'], paypal: ['paypal.com'],
  stripe: ['stripe.com'], wikipedia: ['wikipedia.org'],
};

function canonicalName(key) {
  return String(key || '')
    .replace(/^bg:/, '')
    .replace(/_agent$/i, '')
    .replace(/\.agent$/i, '')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase();
}

function hostHintsFor(url, key) {
  const hosts = [];
  if (url) {
    try { hosts.push(new URL(url).hostname.replace(/^www\./, '')); } catch (_) {}
  }
  const name = canonicalName(key);
  const aliases = HOST_ALIASES[name.replace(/\s+/g, '')] || [];
  return { hosts: [...hosts, ...aliases], name };
}

function tabMatches(tab, hints, strict = false) {
  if (!tab.url || tab.incognito) return false;
  let host = '', path = '';
  try {
    const u = new URL(tab.url);
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname || '';
  } catch (_) { return false; }
  for (const hint of hints.hosts) {
    if (!hint) continue;
    if (hint.includes('/')) {
      if ((host + path).includes(hint)) return true;
      continue;
    }
    if (strict) {
      // Navigate mode: the url's host is authoritative — adopt only tabs on
      // that exact host or a subdomain of it. Loose name/domain matching here
      // stole mail.google.com for a calendar.google.com task (observed:
      // ext:google_agent hijacked the user's gmail tab).
      if (host === hint || host.endsWith('.' + hint)) return true;
      continue;
    }
    if (host === hint || host.endsWith('.' + hint) || hint.endsWith('.' + host) || host.includes(hint)) return true;
  }
  if (strict) return false;
  const n = (hints.name || '').replace(/\s+/g, '');
  if (n.length >= 4) {
    if (host.includes(n)) return true;
    if ((tab.title || '').toLowerCase().includes(hints.name)) return true;
  }
  return false;
}

/**
 * Session prefixes: ext:default | ext:bg:<name> | ext:open:<name> | ext:<name>
 * `open:` is a resolution hint (adopt an already-open tab) — it is stripped
 * from the registry key so open/plain spellings share one binding.
 */
function parseSession(sessionId) {
  if (sessionId === 'ext:default') return { kind: 'default', key: 'default' };
  let s = String(sessionId || '');
  if (s.startsWith('ext:')) s = s.slice(4);
  if (s.startsWith('bg:')) return { kind: 'bg', key: 'bg:' + s.slice(3) };
  if (s.startsWith('open:')) return { kind: 'open', key: s.slice(5) };
  return { kind: 'plain', key: s };
}

/**
 * Resolve a sessionId to a live tabId. May bind the active tab, adopt an
 * existing matching tab, or create a new one — per the session's policy.
 * opts: { activate, tabPolicy } — forwarded from the command args.
 */
async function resolveTab(sessionId, url, opts = {}) {
  await registryHydrated;

  if (sessionId === 'ext:default') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (!tab) throw new Error('no active tab in a normal window');
    return tab.id;
  }

  const { kind, key } = parseSession(sessionId);
  const policy = opts.tabPolicy || kind; // explicit arg overrides the prefix

  // Bound registry entry that is still alive → reuse (session continuity)
  const bound = sessionTabs.get(key);
  if (bound != null) {
    const t = await getTab(bound);
    if (t) return t.id;
    await unbindSession(key);
  }

  const hints = hostHintsFor(url, key);
  // Strict when navigating: an explicit url makes its host authoritative —
  // loose name/domain fuzzy-matching must not adopt a sibling-service tab
  // (mail.google.com is not a valid adopt target for a calendar.google.com nav).
  const strict = !!url;

  // Last-resort: a live tab already bound to another ext session. Worker
  // death/suspension can drop this session's own binding — a follow-up probe
  // must land on the task's real working tab, not a minted about:blank.
  // When strict (navigate), only a host-matching tab may be adopted — a
  // non-matching bound tab belongs to another session's site and must not be
  // commandeered (observed: google_agent navigating the user's gmail tab).
  async function fallbackBoundTab() {
    const boundIds = [...sessionTabs.values()];
    const live = (await Promise.all(boundIds.map(id => getTab(id)))).filter(Boolean);
    if (!live.length) return null;
    const hinted = live.filter(t => tabMatches(t, hints, strict));
    if (hinted.length === 1) return hinted[0];
    if (strict) return hinted.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
    if (live.length === 1) return live[0]; // only one working tab exists
    return hinted.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  }

  if (policy === 'open' || policy === 'bg') {
    // Adopt the newest matching tab in any window — never steal focus.
    const tabs = await chrome.tabs.query({});
    const match = tabs
      .filter(t => tabMatches(t, hints, strict))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (match) {
      await bindSession(key, match.id);
      sendEvent('tabAdopted', { sessionId, tabId: match.id, url: match.url, title: match.title, via: 'adopt', policy });
      return match.id;
    }
    const fb = await fallbackBoundTab();
    if (fb) { await bindSession(key, fb.id); sendEvent('tabAdopted', { sessionId, tabId: fb.id, url: fb.url, title: fb.title, via: 'fallback', policy }); return fb.id; }
    return createBoundTab(key, sessionId, url, false);
  }

  // plain → front-or-new: only the ACTIVE tab may be adopted.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (active && tabMatches(active, hints, strict)) {
    await bindSession(key, active.id);
    sendEvent('tabAdopted', { sessionId, tabId: active.id, url: active.url, title: active.title, via: 'active-match', policy });
    return active.id;
  }
  const fb = await fallbackBoundTab();
  if (fb) { await bindSession(key, fb.id); sendEvent('tabAdopted', { sessionId, tabId: fb.id, url: fb.url, title: fb.title, via: 'fallback', policy }); return fb.id; }
  return createBoundTab(key, sessionId, url, !!opts.activate);
}

async function createBoundTab(key, sessionId, url, active) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active });
  await bindSession(key, tab.id);
  sendEvent('tabCreated', { sessionId, tabId: tab.id, url: url || 'about:blank', title: tab.title, active });
  return tab.id;
}

// ---------------------------------------------------------------------------
// chrome.debugger management — real CDP, same protocol Playwright uses.
// Attached lazily per tab; shows Chrome's "debugging this browser" infobar.
// ---------------------------------------------------------------------------
async function ensureDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
}

async function sendDebugger(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function detachAllDebuggers() {
  for (const tabId of [...attachedTabs]) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    attachedTabs.delete(tabId);
  }
}

// Runtime.evaluate wrapper — returns {value} or throws with exception text
async function evaluate(tabId, expression) {
  const res = await sendDebugger(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails;
    const desc = ex.exception?.description || ex.text || 'evaluation failed';
    throw new Error(desc.slice(0, 500));
  }
  return res.result ? res.result.value : undefined;
}

// ---------------------------------------------------------------------------
// Key press — Input.dispatchKeyEvent (trusted input, same as Playwright)
// ---------------------------------------------------------------------------
const MODS = { Alt: 1, AltLeft: 1, Option: 1, Control: 2, Ctrl: 2, ControlLeft: 2, Meta: 4, Command: 4, Cmd: 4, MetaLeft: 4, Shift: 8, ShiftLeft: 8 };

const NAMED_KEYS = {
  Enter:     { key: 'Enter',     code: 'Enter',     keyCode: 13, text: '\r' },
  Tab:       { key: 'Tab',       code: 'Tab',       keyCode: 9 },
  Escape:    { key: 'Escape',    code: 'Escape',    keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete:    { key: 'Delete',    code: 'Delete',    keyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp:   { key: 'ArrowUp',   code: 'ArrowUp',   keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight:{ key: 'ArrowRight',code: 'ArrowRight',keyCode: 39 },
  Home:      { key: 'Home',      code: 'Home',      keyCode: 36 },
  End:       { key: 'End',       code: 'End',       keyCode: 35 },
  PageUp:    { key: 'PageUp',    code: 'PageUp',    keyCode: 33 },
  PageDown:  { key: 'PageDown',  code: 'PageDown',  keyCode: 34 },
  ' ':       { key: ' ',         code: 'Space',     keyCode: 32, text: ' ' },
  Space:     { key: ' ',         code: 'Space',     keyCode: 32, text: ' ' },
};

// Playwright-style combo strings: 'Meta+a', 'Shift+Tab', 'Control+Enter', 'c'
function parseKeyCombo(combo) {
  const parts = String(combo || '').split('+');
  const key = parts.pop();
  let modifiers = 0;
  for (const m of parts) modifiers |= MODS[m] || 0;
  return { key, modifiers };
}

// macOS editing commands that need the `commands` param for reliability
function editingCommands(keyName, modifiers) {
  const meta = (modifiers & 4) !== 0;
  if (!meta) return undefined;
  const k = keyName.toLowerCase();
  if (k === 'a') return ['selectAll'];
  if (k === 'c') return ['copy'];
  if (k === 'x') return ['cut'];
  if (k === 'v') return ['paste'];
  if (k === 'z') return ['undo'];
  return undefined;
}

async function pressKey(tabId, combo) {
  const { key, modifiers } = parseKeyCombo(combo);
  const named = NAMED_KEYS[key] || NAMED_KEYS[key?.toLowerCase?.() === 'esc' ? 'Escape' : key];

  if (named) {
    const params = {
      modifiers,
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      nativeVirtualKeyCode: named.keyCode,
    };
    const commands = editingCommands(named.key, modifiers);
    if (commands) params.commands = commands;
    if (named.text) {
      // keyDown + char for text-producing keys (Enter, Space)
      await sendDebugger(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown', text: named.text, unmodifiedText: named.text });
    } else {
      await sendDebugger(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' });
    }
    await sendDebugger(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    return { pressed: named.key, modifiers };
  }

  // Single printable char — keyDown with text inserts it, honoring modifiers
  const ch = String(key || '');
  if (ch.length === 1) {
    const code = /^[a-z]$/i.test(ch) ? 'Key' + ch.toUpperCase() : '';
    const keyCode = ch.length === 1 ? ch.toUpperCase().charCodeAt(0) : 0;
    const params = {
      modifiers,
      key: ch,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
    const commands = editingCommands(ch, modifiers);
    if (commands) params.commands = commands;
    const noText = modifiers & ~8; // modifiers other than Shift suppress text insert
    if (noText) {
      await sendDebugger(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' });
    } else {
      await sendDebugger(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown', text: ch, unmodifiedText: ch });
    }
    await sendDebugger(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    return { pressed: ch, modifiers };
  }

  throw new Error(`unknown key: ${combo}`);
}

// Virtual-Tab fallback: if a real Tab press didn't move focus (background tab
// throttling, focus traps), compute the next focusable element in-page and
// focus it directly. Verified by activeElement change.
async function virtualTab(tabId, shift) {
  return evaluate(tabId, `(() => {
    const FOCUSABLE = 'a[href], button, input:not([type="hidden"]):not([disabled]), textarea, select, [contenteditable], [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="menuitem"]';
    const els = [...document.querySelectorAll(FOCUSABLE)].filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (!els.length) return { moved: false, reason: 'no-focusables' };
    const cur = document.activeElement;
    let idx = els.indexOf(cur);
    let next;
    if (idx === -1) next = els[0];
    else {
      const ni = (idx + ${shift ? -1 : 1} + els.length) % els.length;
      next = els[ni];
    }
    try { next.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', code:'Tab', bubbles:true})); } catch(_){}
    next.focus({ preventScroll: false });
    try { next.dispatchEvent(new KeyboardEvent('keyup', {key:'Tab', code:'Tab', bubbles:true})); } catch(_){}
    const moved = document.activeElement === next;
    return { moved, tag: next.tagName, ref: next.getAttribute('data-td-ref') || null, label: (next.getAttribute('aria-label') || next.getAttribute('placeholder') || next.textContent || '').trim().slice(0, 80) };
  })()`);
}

// ---------------------------------------------------------------------------
// Click — resolve element (td-ref or CSS), scroll into view, real mouse click
// ---------------------------------------------------------------------------
async function getElementRect(tabId, selector) {
  const code = `(() => {
    const sel = ${JSON.stringify(selector)};
    let el = null;
    if (/^(td|e)\\d+$/i.test(sel)) el = document.querySelector('[data-td-ref="' + sel + '"]');
    if (!el) el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, tag: el.tagName, ref: el.getAttribute('data-td-ref') };
  })()`;
  return evaluate(tabId, code);
}

async function mouseClick(tabId, x, y, clickCount = 1) {
  const base = { x, y, button: 'left' };
  await sendDebugger(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount });
  await sendDebugger(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount });
}

// ---------------------------------------------------------------------------
// Navigation wait — resolve when tabs.onUpdated fires status='complete'
// ---------------------------------------------------------------------------
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingNavs.delete(tabId); resolve(false); }, timeoutMs);
    pendingNavs.set(tabId, { resolve, timer });
  });
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
async function handleCmd(msg) {
  const { id, sessionId, action, args = {} } = msg;
  const timeoutMs = args.timeoutMs || 20000;
  try {
    const result = await dispatch(sessionId, action, args, timeoutMs);
    sendResult(id, result);
  } catch (e) {
    sendResult(id, { ok: false, error: e.message });
  }
}

async function dispatch(sessionId, action, args, timeoutMs) {
  switch (action) {
    case 'navigate':
    case 'goto': {
      // Resolve adopts an existing tab for the URL's host when available
      const tabId = await resolveTab(sessionId, args.url, args);
      const tab = await getTab(tabId);
      if (tab && tab.url === args.url) return { ok: true, tabId, url: tab.url, reused: true };
      const done = waitForTabComplete(tabId, timeoutMs || 30000);
      await chrome.tabs.update(tabId, { url: args.url });
      await done;
      const t = await getTab(tabId);
      return { ok: true, tabId, url: t?.url || args.url };
    }

    case 'evaluate': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const value = await evaluate(tabId, args.expression || args.text || '');
      return { ok: true, tabId, result: value };
    }

    case 'run-code': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const value = await evaluate(tabId, `(async () => { ${args.code || args.text || ''} })()`);
      return { ok: true, tabId, result: value };
    }

    case 'snapshot': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const raw = await evaluate(tabId, args.scannerScript || args.text || 'null');
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { ok: true, tabId, result: parsed };
    }

    case 'press':
    case 'keyboard':
    case 'key': {
      const tabId = await resolveTab(sessionId, args.url, args);
      // Pre-read focus for Tab verification / virtual-tab fallback
      const isTab = /^(Shift\+)?Tab$/i.test(args.key || '');
      const before = isTab ? await evaluate(tabId, 'document.activeElement && document.activeElement.outerHTML ? document.activeElement.outerHTML.slice(0,200) : null').catch(() => null) : null;
      const pressed = await pressKey(tabId, args.key || 'Enter');
      if (isTab) {
        const after = await evaluate(tabId, 'document.activeElement && document.activeElement.outerHTML ? document.activeElement.outerHTML.slice(0,200) : null').catch(() => null);
        if (before === after) {
          const vt = await virtualTab(tabId, /shift/i.test(args.key || ''));
          return { ok: true, tabId, pressed, virtualTab: vt };
        }
      }
      return { ok: true, tabId, pressed };
    }

    case 'type': {
      const tabId = await resolveTab(sessionId, args.url, args);
      await sendDebugger(tabId, 'Input.insertText', { text: args.text || '' });
      return { ok: true, tabId };
    }

    case 'insertText': {
      const tabId = await resolveTab(sessionId, args.url, args);
      await sendDebugger(tabId, 'Input.insertText', { text: args.text || '' });
      return { ok: true, tabId };
    }

    case 'fill': {
      const tabId = await resolveTab(sessionId, args.url, args);
      // Focus the element, clear it (native setter keeps React in sync), then
      // trusted insertText — same approach as reactFill on the engine path.
      const focusCode = `(() => {
        const sel = ${JSON.stringify(args.selector || args.ref || '')};
        let el = null;
        if (/^(td|e)\\d+$/i.test(sel)) el = document.querySelector('[data-td-ref="' + sel + '"]');
        if (!el) el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        const proto = el.isContentEditable ? HTMLElement.prototype : Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
                     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
        if (el.isContentEditable) el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { tag: el.tagName, ref: el.getAttribute('data-td-ref') };
      })()`;
      const focused = await evaluate(tabId, focusCode);
      if (!focused) return { ok: false, tabId, error: `fill: element not found: ${args.selector || args.ref}` };
      await sendDebugger(tabId, 'Input.insertText', { text: args.text || args.value || '' });
      return { ok: true, tabId, focused };
    }

    case 'click':
    case 'clickSelector': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const rect = await getElementRect(tabId, args.selector || args.ref || '');
      if (!rect) return { ok: false, tabId, error: `element not found: ${args.selector || args.ref}` };
      await mouseClick(tabId, rect.x, rect.y);
      return { ok: true, tabId, clicked: rect };
    }

    case 'dblclick': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const rect = await getElementRect(tabId, args.selector || args.ref || '');
      if (!rect) return { ok: false, tabId, error: 'element not found' };
      await mouseClick(tabId, rect.x, rect.y, 2);
      return { ok: true, tabId };
    }

    case 'clickAt': {
      const tabId = await resolveTab(sessionId, args.url, args);
      await mouseClick(tabId, Number(args.x), Number(args.y));
      return { ok: true, tabId };
    }

    case 'clickByText': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const rect = await evaluate(tabId, `(() => {
        const needle = ${JSON.stringify(String(args.text || '').trim().toLowerCase())};
        if (!needle) return null;
        const CAND = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], [onclick], summary, li';
        const vis = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        };
        const label = el => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().toLowerCase();
        const els = [...document.querySelectorAll(CAND)].filter(vis);
        const hit = els.find(el => label(el) === needle)
          || els.find(el => label(el).includes(needle))
          || els.find(el => needle.includes(label(el)) && label(el).length > 2);
        if (!hit) return null;
        hit.scrollIntoView({ block: 'center', inline: 'center' });
        const r = hit.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, tag: hit.tagName, ref: hit.getAttribute('data-td-ref'), matched: label(hit).slice(0, 80) };
      })()`);
      if (!rect) return { ok: false, tabId, error: `clickByText: not found: ${args.text}` };
      await mouseClick(tabId, rect.x, rect.y);
      return { ok: true, tabId, clicked: rect };
    }

    case 'scroll': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const val = await evaluate(tabId, `window.scrollBy(${Number(args.dx) || 0}, ${Number(args.dy) || 0}); JSON.stringify({x: scrollX, y: scrollY})`);
      return { ok: true, tabId, result: val };
    }

    case 'screenshot': {
      const tabId = await resolveTab(sessionId, args.url, args);
      // fromSurface:false renders the page offscreen — required for background
      // tabs. Some Chrome versions only support the default surface path, so
      // fall back with a bounded race if the first attempt hangs.
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), ms))]);
      let res;
      try {
        res = await withTimeout(sendDebugger(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: false }), 8000);
      } catch (_) {
        res = await withTimeout(sendDebugger(tabId, 'Page.captureScreenshot', { format: 'png' }), 8000);
      }
      return { ok: true, tabId, data: res.data }; // base64 — server writes file
    }

    case 'getText':
    case 'getPageText': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const sel = args.selector;
      const code = sel
        ? `(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`
        : `(document.body?.innerText || '')`;
      const value = await evaluate(tabId, code);
      return { ok: true, tabId, result: value };
    }

    case 'waitForSelector': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const sel = args.selector || '';
      const deadline = Date.now() + (timeoutMs || 10000);
      while (Date.now() < deadline) {
        const found = await evaluate(tabId, `!!document.querySelector(${JSON.stringify(sel)})`).catch(() => false);
        if (found) return { ok: true, tabId };
        await new Promise(r => setTimeout(r, 250));
      }
      return { ok: false, tabId, error: `waitForSelector timeout: ${sel}` };
    }

    case 'waitForStableText':
    case 'waitForContent': {
      const tabId = await resolveTab(sessionId, args.url, args);
      const deadline = Date.now() + (timeoutMs || 8000);
      let last = '';
      let stableCount = 0;
      while (Date.now() < deadline) {
        const cur = await evaluate(tabId, `(document.body?.innerText || '').length + ':' + (document.body?.innerText || '').slice(0, 500)`).catch(() => '');
        if (cur === last) { if (++stableCount >= 3) return { ok: true, tabId }; }
        else { stableCount = 0; last = cur; }
        await new Promise(r => setTimeout(r, 300));
      }
      return { ok: true, tabId, timedOut: true };
    }

    case 'back':    { const t = await resolveTab(sessionId); await evaluate(t, 'history.back()'); return { ok: true, tabId: t }; }
    case 'forward': { const t = await resolveTab(sessionId); await evaluate(t, 'history.forward()'); return { ok: true, tabId: t }; }
    case 'reload':  { const t = await resolveTab(sessionId); await chrome.tabs.reload(t); return { ok: true, tabId: t }; }

    case 'close': {
      await registryHydrated;
      const { key } = parseSession(sessionId);
      const tabId = sessionTabs.get(key) != null ? sessionTabs.get(key) : await resolveTab(sessionId).catch(() => null);
      if (tabId != null) {
        await unbindSession(key);
        try { await chrome.tabs.remove(tabId); } catch (_) {}
      }
      return { ok: true };
    }

    case 'tab-list': {
      const tabs = await chrome.tabs.query({});
      return { ok: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) };
    }
    case 'listSessions': {
      // Live session→tab report — hydration emits no events, so the
      // gateway's event-fed cache can be empty while bindings exist;
      // this is the authoritative answer for /ext.sessions.
      await registryHydrated;
      const out = [];
      for (const [key, tid] of sessionTabs) {
        const t = await getTab(tid);
        out.push({
          sessionId: `ext:${key}`, tabId: tid,
          url: t?.url || null, title: t?.title || null,
          active: !!t?.active, windowId: t?.windowId,
          alive: !!t,
        });
      }
      return { ok: true, sessions: out };
    }
    case 'tab-new': {
      const tab = await chrome.tabs.create({ url: args.url || 'about:blank', active: !!args.active });
      return { ok: true, tabId: tab.id };
    }
    case 'tab-close': { try { await chrome.tabs.remove(args.tabId); } catch (_) {} return { ok: true }; }
    case 'tab-select': { await chrome.tabs.update(args.tabId, { active: true }); return { ok: true }; }

    case 'cookies': {
      const cookies = await chrome.cookies.getAll(args.domain ? { domain: args.domain } : (args.url ? { url: args.url } : {}));
      return { ok: true, cookies };
    }

    case 'resize': return { ok: true, note: 'resize not supported on real browser tabs' };

    default:
      return { ok: false, error: `unsupported ext action: ${action}` };
  }
}
