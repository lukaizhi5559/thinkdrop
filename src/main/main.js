// Entry point — ThinkDrop managed
require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require('electron');

// Safe IPC send — guards against "Render frame was disposed" crash that occurs when
// a window reloads between the isDestroyed() check and the actual send call.
function safeSend(win, channel, ...args) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send(channel, ...args); } catch (_) {}
}
const screenshot = require('screenshot-desktop');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

// ---------------------------------------------------------------------------
// Overlay control HTTP server (port 3010)
// Skills in command-service call POST /overlay/hide before screenshotting
// and POST /overlay/show after, so the Electron windows don't appear in
// OmniParser / vision LLM screenshots.
// ---------------------------------------------------------------------------
const OVERLAY_CONTROL_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);

function startOverlayControlServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // ── GET /voice/status — voice-service reads StateGraph journal status ──────
    if (req.method === 'GET' && req.url === '/voice/status') {
      const state = (() => { try { return voiceJournal.read(); } catch (_) { return {}; } })();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, stategraph: state.stategraph || {}, voice: state.voice || {} }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    // ── POST /voice/inject — voice-service injects a command, waits for answer ──
    if (req.url === '/voice/inject') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { message, sessionId, source, responseLanguage: injectResponseLanguage = null } = JSON.parse(body || '{}');
          if (!message) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'message is required' }));
            return;
          }
          console.log(`[VoiceInject] Received: "${message.substring(0, 80)}" (source: ${source || 'voice'})`);

          if (!stateGraph) {
            res.writeHead(503);
            res.end(JSON.stringify({ ok: false, error: 'StateGraph not initialized' }));
            return;
          }

          // Notify renderer so it can show the prompt in the UI
          if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
            safeSend(promptCaptureWindow, 'voice:inject-prompt', { message, sessionId, source: source || 'voice' });
          }
          // Reset Results window state for the new voice prompt
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'results-window:set-prompt', message);
          }

          // Flush stale cancel/pause signals before starting so previous-session
          // signals don't abort this fresh execution.
          const _voiceStaleSignals = voiceJournal.readPendingSignals();
          for (const sig of _voiceStaleSignals) {
            if (sig.type === 'cancel' || sig.type === 'pause') {
              voiceJournal.acknowledgeSignal(sig.id);
            }
          }

          // Run StateGraph synchronously so voice-service gets the answer to TTS
          const voiceAbort = new AbortController();

          const tokens = [];
          const streamCallback = (token) => {
            tokens.push(token);
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: token });
            }
          };

          // Forward automation progress events to Results window (AutomationProgress component)
          const progressCallback = (evt) => {
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              safeSend(resultsWindow, 'automation:progress', evt);
            }
            if (evt.type === 'all_done' && promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
              safeSend(promptCaptureWindow, 'automation:progress', evt);
            }
          };

          // Install confirmation: show card in Results window, wait for user reply
          let pendingVoiceInstallResolve = null;
          const confirmInstallCallback = () => new Promise((resolve) => {
            pendingVoiceInstallResolve = resolve;
          });
          const handleVoiceInstallConfirm = (_e, { confirmed }) => {
            if (pendingVoiceInstallResolve) {
              const r = pendingVoiceInstallResolve;
              pendingVoiceInstallResolve = null;
              r(confirmed === true);
            }
          };
          ipcMain.on('install:confirm', handleVoiceInstallConfirm);

          const initialState = {
            message,
            selectedText: '',
            streamCallback,
            progressCallback,
            confirmInstallCallback,
            confirmGuideCallback: () => Promise.resolve(false),
            isGuideCancelled: () => false,
            responseLanguage: (injectResponseLanguage && injectResponseLanguage !== 'en') ? injectResponseLanguage : null,
            context: {
              sessionId: sessionId || currentSessionId,
              userId: 'voice_inject',
              source: source || 'voice',
            },
          };

          voiceJournal.graphStarted({
            intent: 'unknown',
            sessionId: sessionId || currentSessionId,
          });

          let _nodeIdx = 0;
          const onProgress = async (nodeName, _s, durationMs, phase) => {
            // Activate AutomationProgress in Results window when planning starts
            if (nodeName === 'planSkills' && phase === 'started') {
              progressCallback({ type: 'planning' });
            }
            if (phase !== 'completed') return;
            _nodeIdx++;
            voiceJournal.graphNodeDone({ node: nodeName, durationMs, nodeIndex: _nodeIdx, totalNodes: 0 });
          };

          const finalState = await stateGraph.execute(initialState, onProgress, voiceAbort.signal);
          ipcMain.removeListener('install:confirm', handleVoiceInstallConfirm);

          // Persist session
          if (finalState.resolvedSessionId) currentSessionId = finalState.resolvedSessionId;

          const answer = finalState.answer || tokens.join('') || '';
          const intent = finalState?.intent?.type || 'unknown';

          voiceJournal.graphDone({
            intent,
            summary: answer.substring(0, 120),
          });

          // Signal stream end to renderer
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
          }

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, answer, intent, hadLiveStream: tokens.length > 0 }));
        } catch (err) {
          console.error('[VoiceInject] Error:', err.message);
          voiceJournal.graphError({ intent: 'unknown', error: err.message });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, error: err.message, answer: '' }));
        }
      });
      return;
    }

    // ── POST /voice/result — voice-service sends escalated stategraph TTS back ──
    if (req.url === '/voice/result') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          console.log(`🎙️ [Voice] Escalation result received — forwarding voice:response (lane=${data.lane})`);
          if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
            safeSend(promptCaptureWindow, 'voice:response', {
              text: data.text || '',
              fullAnswer: data.fullAnswer || '',
              audioBase64: data.audioBase64 || '',
              audioFormat: data.audioFormat || 'mp3',
              language: data.language || 'en',
              lane: data.lane || 'stategraph',
              durationEstimateMs: data.durationEstimateMs || null,
            });
          }
          if (resultsWindow && !resultsWindow.isDestroyed() && data.fullAnswer) {
            safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: data.fullAnswer, lane: data.lane || 'stategraph' });
            safeSend(resultsWindow, 'ws-bridge:message', { type: 'done', lane: data.lane || 'stategraph' });
          }
          res.writeHead(200).end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error('[VoiceResult] Error:', err.message);
          res.writeHead(500).end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const hide = req.url === '/overlay/hide';
    const show = req.url === '/overlay/show';

    if (!hide && !show) {
      res.writeHead(404).end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const windows = [promptCaptureWindow, resultsWindow];

    if (hide) {
      // Save visibility state BEFORE hiding
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        win._overlayWasVisible = win.isVisible();
        win.hide();
      }
    } else {
      // Restore windows that were visible before hide
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        if (win._overlayWasVisible) win.showInactive();
      }
    }

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, action: hide ? 'hidden' : 'shown' }));
  });

  server.listen(OVERLAY_CONTROL_PORT, '127.0.0.1', () => {
    console.log(`[Overlay Control] HTTP server listening on http://127.0.0.1:${OVERLAY_CONTROL_PORT}`);
  });

  server.on('error', (err) => {
    console.error('[Overlay Control] Server error:', err.message);
  });
}

// StateGraph integration
const { StateGraphBuilder, RealMCPAdapter, VSCodeLLMBackend } = require('@thinkdrop/stategraph');
const ThinkDropMCPClient = require('./ThinkDropMCPClient');
const scheduler = require('./scheduler');
const queueManager = require('./queueManager');

// Voice Journal — shared state file with voice-service
const voiceJournal = (() => {
  try {
    return require('../../mcp-services/voice-service/src/voice-journal.cjs');
  } catch (_) {
    // voice-service not installed yet — no-op shim
    return {
      journalStart: () => {}, journalNodeDone: () => {}, journalDone: () => {},
      journalError: () => {}, checkSignals: () => [], acknowledgeSignal: () => {},
      journalReset: () => {},
    };
  }
})();

// Singleton StateGraph instance (created once on app ready)
let stateGraph = null;
let mcpClient = null;
let mcpAdapter = null;
let llmBackend = null;
let currentSessionId = null; // Persists across prompts for conversation continuity
let currentBrowserSessionId = null; // Persists active Playwright session across prompts
let currentBrowserUrl = null;        // Last known URL in the active Playwright session

// Active schedule countdown — set when a schedule step is running, cleared when done/cancelled
// Used to warn the user before closing the app mid-countdown
let activeScheduleCountdown = null; // { id, targetTime, label }

function initStateGraph() {
  try {
    mcpClient = new ThinkDropMCPClient({ logger: console, timeoutMs: 60000 });
    mcpAdapter = new RealMCPAdapter(mcpClient, { logger: console });

    llmBackend = new VSCodeLLMBackend({
      wsUrl:            process.env.WEBSOCKET_URL     || 'ws://localhost:4000/ws/stream',
      apiKey:           process.env.BASE_API_KEY  || process.env.WEBSOCKET_API_KEY || '',
      userId:           'thinkdrop_electron',
      connectTimeoutMs: 5000,
      responseTimeoutMs: 60000,
    });

    stateGraph = StateGraphBuilder.full({
      mcpAdapter,
      llmBackend,
      debug: process.env.NODE_ENV === 'development',
      logger: console,
    });

    console.log('✅ [StateGraph] Initialized with full graph (all nodes)');
  } catch (err) {
    console.error('❌ [StateGraph] Failed to initialize:', err.message);
    stateGraph = null;
  }
}

let promptCaptureWindow = null;
let resultsWindow = null;

// VS Code Bridge WebSocket
let bridgeWs = null;
let vscodeConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 2000;

function connectToSocket() {
  if (bridgeWs && (bridgeWs.readyState === WebSocket.OPEN || bridgeWs.readyState === WebSocket.CONNECTING)) {
    console.log('[VS Code Bridge] Already connected or connecting');
    return;
  }

  // Clean up any stale socket before creating a new one
  if (bridgeWs) {
    bridgeWs.removeAllListeners();
    bridgeWs.terminate();
    bridgeWs = null;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[VS Code Bridge] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    return;
  }

  const wsUrl = new URL(process.env.WEBSOCKET_URL);
  wsUrl.searchParams.set('apiKey', process.env.BASE_URL || '');
  wsUrl.searchParams.set('userId', 'thinkdrop_electron');
  wsUrl.searchParams.set('clientId', `thinkdrop_${Date.now()}`);

  console.log(`Connecting to ${wsUrl.toString()}`);
  bridgeWs = new WebSocket(wsUrl.toString());

  bridgeWs.on('open', () => {
    console.log('✅ [VS Code Bridge] Connected');
    vscodeConnected = true;
    reconnectAttempts = 0;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'ws-bridge:connected');
    }
  });

  bridgeWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[VS Code Bridge] Message received:', message.type);
      
      // Forward all messages to ResultsWindow
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:message', message);
      }
    } catch (error) {
      console.error('[VS Code Bridge] Failed to parse message:', error);
    }
  });

  bridgeWs.on('error', (error) => {
    console.error('[VS Code Bridge] Error:', error.message);
    vscodeConnected = false;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'ws-bridge:error', error.message);
    }
  });

  bridgeWs.on('close', () => {
    console.log('[VS Code Bridge] Disconnected');
    vscodeConnected = false;
    bridgeWs = null;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'ws-bridge:disconnected');
    }

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1);
      console.log(`[VS Code Bridge] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);
      setTimeout(() => connectToSocket(), delay);
    } else {
      console.warn('[VS Code Bridge] Max reconnect attempts reached. Server may be unavailable.');
    }
  });
}

// Clipboard tagging — explicit Shift+Cmd+C shortcut (no polling)
// User presses Shift+Cmd+C after selecting/copying text or a file to tag it as context
let clipboardMonitorActive = false;
let lastClipboardContent = '';
let clipboardCheckInterval = null;
let sentHighlights = new Set();
let recentlySubmittedPrompts = new Set(); // Track prompts sent via stategraph:process to avoid clipboard re-capture

function createPromptCaptureWindow() {
  const windowWidth = 500;
  const windowHeight = 120;
  
  promptCaptureWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 400,
    maxWidth: 720,
    minHeight: 100,
    maxHeight: 760,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    hasShadow: true,
    show: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // keep AudioContext alive when window is hidden/unfocused
    },
  });

  if (process.platform === 'darwin') {
    promptCaptureWindow.setWindowButtonVisibility(false);
    promptCaptureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    promptCaptureWindow.setAlwaysOnTop(true, 'floating', 5);
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    promptCaptureWindow.loadURL('http://localhost:5173/index.html?mode=promptcapture&cacheBust=' + Date.now());
  } else {
    promptCaptureWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'),
  { query: { mode: 'promptcapture' } });
  }

  promptCaptureWindow.once('ready-to-show', () => {
    console.log('✅ [PROMPT_CAPTURE] Window ready to show');
  });

  // Grant microphone access for webkitSpeechRecognition (PTT Web Speech API)
  promptCaptureWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      console.log(`[PROMPT_CAPTURE] Granting permission: ${permission}`);
      callback(true);
    } else {
      callback(false);
    }
  });
  promptCaptureWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone') return true;
    return false;
  });

  promptCaptureWindow.webContents.on('did-finish-load', () => {
    console.log('[PROMPT_CAPTURE] Content finished loading.');
    console.log('[PROMPT_CAPTURE] isVisible:', promptCaptureWindow.isVisible());
    promptCaptureWindow.webContents.setAudioMuted(false);
    console.log('[PROMPT_CAPTURE] isDestroyed:', promptCaptureWindow.isDestroyed());
  });

  // Block Vite HMR full-page reloads on promptCaptureWindow — same render frame disposal issue.
  let promptCaptureWindowLoaded = false;
  promptCaptureWindow.webContents.once('did-finish-load', () => { promptCaptureWindowLoaded = true; });
  promptCaptureWindow.webContents.on('will-navigate', (event, url) => {
    if (promptCaptureWindowLoaded) {
      console.log('[PROMPT_CAPTURE] Blocking navigation to prevent render frame disposal:', url);
      event.preventDefault();
    }
  });

  promptCaptureWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Prompt Capture Window failed to load: [${errorCode}] ${errorDescription}`);
    if (errorCode === -102 || errorCode === -6) {
      setTimeout(() => {
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          console.log('[Prompt Capture] Retrying load...');
          promptCaptureWindow.loadURL('http://localhost:5173/index.html?mode=promptcapture&cacheBust=' + Date.now());
        }
      }, 500);
    }
  });

  promptCaptureWindow.on('closed', () => {
    promptCaptureWindow = null;
  });

  return promptCaptureWindow;
}

function createResultsWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const windowMinWidth = 400;
  const windowMinHeight = 300;
  const windowMaxHeight = 800;
  const margin = 0;

  const initialX = (screenWidth - windowMinWidth) - margin;
  const initialY = screenHeight + 2040;
  console.log(`[Results Window] Initial position: (${screenWidth}, ${initialY})`);
  
  resultsWindow = new BrowserWindow({
    x: initialX,
    y: initialY,
    width: windowMinWidth,
    height: windowMinHeight,
    minWidth: windowMinWidth,
    maxWidth: 600,
    minHeight: windowMinHeight,
    maxHeight: windowMaxHeight,
    transparent: true, // DISABLED for debugging
    frame: false, // ENABLED for debugging
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    hasShadow: true,
    show: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'darwin') {
    resultsWindow.setWindowButtonVisibility(false);
    resultsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    resultsWindow.setAlwaysOnTop(true, 'floating', 4);
    console.log('[Results Window] Configured for macOS with floating level 5');
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    console.log('Loading Results Window in development mode.');
    resultsWindow.loadURL('http://localhost:5173/index.html?mode=results&cacheBust=' + Date.now());
  } else {
    resultsWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'),
    { query: { mode: 'results' } });
  }

  resultsWindow.once('ready-to-show', () => {
    console.log('✅ [RESULTS_WINDOW] Window ready to show');
    const bounds = resultsWindow.getBounds();
    console.log('[RESULTS_WINDOW] Position:', bounds);
  });

  resultsWindow.webContents.on('did-finish-load', () => {
    console.log('[RESULTS_WINDOW] Content finished loading.');
    console.log('[RESULTS_WINDOW] isVisible:', resultsWindow.isVisible());
    console.log('[RESULTS_WINDOW] isDestroyed:', resultsWindow.isDestroyed());
    setTimeout(() => resultsWindow.hide(), 50);
    // Push initial queue + cron snapshots so tab badges are accurate immediately
    setTimeout(() => {
      safeSend(resultsWindow, 'queue:update', queueManager.getQueue());
      safeSend(resultsWindow, 'cron:update', queueManager.getCron());
    }, 300);
  });

  // Block Vite HMR full-page reloads — they dispose the render frame mid-stream causing
  // "Render frame was disposed" errors. HMR hot updates arrive via WebSocket, not navigation.
  let resultsWindowLoaded = false;
  resultsWindow.webContents.once('did-finish-load', () => { resultsWindowLoaded = true; });
  resultsWindow.webContents.on('will-navigate', (event, url) => {
    if (resultsWindowLoaded) {
      console.log('[RESULTS_WINDOW] Blocking navigation to prevent render frame disposal:', url);
      event.preventDefault();
    }
  });

  resultsWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Results Window failed to load: [${errorCode}] ${errorDescription}`);
    if (errorCode === -102 || errorCode === -6) {
      // ERR_CONNECTION_REFUSED / ERR_CONNECTION_RESET — Vite not ready yet, retry
      setTimeout(() => {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          console.log('[Results Window] Retrying load...');
          resultsWindow.loadURL('http://localhost:5173/index.html?mode=results&cacheBust=' + Date.now());
        }
      }, 500);
    }
  });

  resultsWindow.on('closed', () => {
    console.log('Results Window closed.');
    resultsWindow = null;
  });

  return resultsWindow;
}

// Clipboard monitoring functionality
function startClipboardMonitoring(checkInitial = false) {
  // Polling disabled — tagging is now explicit via Shift+Cmd+C shortcut
  clipboardMonitorActive = true;
  lastClipboardContent = clipboard.readText();
  console.log('[Clipboard Monitor] Started monitoring for auto-capture highlights.');
}

function stopClipboardMonitoring() {
  if (!clipboardMonitorActive) return;
  clipboardMonitorActive = false;

  if (clipboardCheckInterval) {
    clearInterval(clipboardCheckInterval);
    clipboardCheckInterval = null;
  }

  sentHighlights.clear();
  console.log('[Clipboard Monitor] Stopped monitoring.');
}

// Poll Vite dev server until it responds, then resolve
function waitForVite(url = 'http://localhost:5173', maxWaitMs = 30000) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() - start > maxWaitMs) {
          reject(new Error('Vite dev server did not start in time'));
          return;
        }
        setTimeout(check, 300);
      });
    };
    check();
  });
}

// ── Node.js runtime check ─────────────────────────────────────────────────────
// ThinkDrop uses Node.js to run user skills. Without it, skill building and
// execution will silently fail. Detect early and guide the user to install it.

function checkNodeJs() {
  const { execFileSync } = require('child_process');
  try {
    const version = execFileSync('node', ['--version'], { timeout: 5000, encoding: 'utf8' }).trim();
    console.log(`[App] Node.js detected: ${version}`);
    return { ok: true, version };
  } catch (_) {
    return { ok: false };
  }
}

app.whenReady().then(async () => {
  // ── Check Node.js is installed ───────────────────────────────────────────────
  const nodeCheck = checkNodeJs();
  if (!nodeCheck.ok) {
    const { dialog, shell } = require('electron');
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'Node.js Required',
      message: 'Node.js is not installed',
      detail: 'ThinkDrop requires Node.js (v18 or later) to build and run skills.\n\nWithout it, skill installation and execution will not work.\n\nClick "Install Node.js" to open the download page, then restart ThinkDrop after installing.',
      buttons: ['Install Node.js', 'Continue Anyway', 'Quit'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 0) {
      shell.openExternal('https://nodejs.org/en/download/');
      app.quit();
      return;
    }
    if (choice.response === 2) {
      app.quit();
      return;
    }
    // Continue anyway — user acknowledged the warning
    console.warn('[App] Continuing without Node.js — skill features will not work');
  }

  // In dev mode, wait for Vite before creating windows to avoid ERR_CONNECTION_REFUSED
  if (process.env.NODE_ENV === 'development') {
    console.log('[App] Waiting for Vite dev server...');
    try {
      await waitForVite();
      console.log('[App] Vite ready — creating windows');
    } catch (err) {
      console.warn('[App] Vite wait timed out, proceeding anyway:', err.message);
    }
  }

  createPromptCaptureWindow();
  createResultsWindow();

  // Start overlay control HTTP server so command-service skills can hide/show windows before screenshotting
  startOverlayControlServer();

  // Initialize StateGraph pipeline
  initStateGraph();

  // Connect to VS Code extension (kept for legacy/fallback)
  setTimeout(() => connectToSocket(), 1000);

  // ── Skill daemon re-registration on startup ───────────────────────────────
  // Scan ~/.thinkdrop/skills/ for any installed skills that registered a launchd
  // plist. Re-load any plists that exist on disk but are not currently active in
  // launchd. This survives app reinstalls, OS upgrades, and launchd resets.
  // Runs 8 seconds after app ready to avoid blocking startup.
  setTimeout(() => {
    try {
      const fs   = require('fs');
      const path = require('path');
      const os   = require('os');
      const { execSync } = require('child_process');

      const skillsBase   = path.join(os.homedir(), '.thinkdrop', 'skills');
      const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');

      if (!fs.existsSync(skillsBase)) return;

      const skillDirs = fs.readdirSync(skillsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      let loaded = 0;
      for (const skillName of skillDirs) {
        const label     = `com.thinkdrop.skill.${skillName}`;
        const plistPath = path.join(launchAgents, `${label}.plist`);
        if (!fs.existsSync(plistPath)) continue;

        // Check if already loaded
        try {
          execSync(`launchctl list ${label}`, { stdio: 'ignore' });
          // Already loaded — skip
        } catch {
          // Not loaded — re-register
          try {
            execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
            loaded++;
            console.log(`[SkillDaemon] Re-registered: ${label}`);
          } catch (loadErr) {
            console.warn(`[SkillDaemon] Failed to re-register ${label}: ${loadErr.message}`);
          }
        }
      }

      if (loaded > 0) {
        console.log(`[SkillDaemon] Re-registered ${loaded} skill daemon(s) with launchd`);
      }
    } catch (err) {
      console.warn(`[SkillDaemon] Startup re-registration failed: ${err.message}`);
    }
  }, 8000);

  // ── Nightly agent validation: runs at 3am, validates all registered agents ──
  // Calls validate_agent for every cli.agent and browser.agent in DuckDB.
  // LLM-powered diagnosis auto-patches broken descriptors and updates status.
  // Runs silently in the background — no UI unless an agent needs attention.
  //
  // Dev/testing: set THINKDROP_VALIDATE_ON_STARTUP=1 in env to fire immediately.
  // IPC: send 'agent:validate-now' to trigger on demand at any time.
  (() => {
    const VALIDATE_HOUR = 3; // 3am local time
    const COMMAND_SERVICE_URL = 'http://127.0.0.1:3007/command.automate';

    async function runAgentValidation() {
      console.log('[AgentCron] Starting nightly agent validation...');
      try {
        const http = require('http');
        const callCmd = (skill, args, timeoutMs = 30000) => new Promise((resolve) => {
          const body = JSON.stringify({ payload: { skill, args } });
          const req = http.request({
            hostname: '127.0.0.1', port: 3007, path: '/command.automate',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: timeoutMs,
          }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { try { resolve(JSON.parse(raw)?.data || {}); } catch { resolve({}); } });
          });
          req.on('timeout', () => { req.destroy(); resolve({}); });
          req.on('error', () => resolve({}));
          req.write(body); req.end();
        });

        // List all registered agents
        const listResult = await callCmd('cli.agent', { action: 'list_agents' }, 8000);
        const agents = listResult?.agents || [];
        if (agents.length === 0) {
          console.log('[AgentCron] No registered agents to validate.');
          return;
        }

        console.log(`[AgentCron] Validating ${agents.length} agent(s)...`);
        const results = [];

        for (const agent of agents) {
          try {
            const skillName = agent.type === 'browser' ? 'browser.agent' : 'cli.agent';
            const result = await callCmd(skillName, { action: 'validate_agent', id: agent.id }, 60000);
            const status = result?.verdict || (result?.healthy ? 'healthy' : 'unknown');
            results.push({ id: agent.id, type: agent.type, status, summary: result?.summary || '' });
            console.log(`[AgentCron] ${agent.id} → ${status}${result?.summary ? ': ' + result.summary : ''}`);
            if (result?.descriptorPatched) {
              console.log(`[AgentCron] ${agent.id} — descriptor auto-patched`);
            }
          } catch (err) {
            console.warn(`[AgentCron] validate_agent failed for ${agent.id}: ${err.message}`);
            results.push({ id: agent.id, type: agent.type, status: 'error', summary: err.message });
          }
        }

        const degraded = results.filter(r => r.status !== 'healthy');
        if (degraded.length > 0) {
          console.warn(`[AgentCron] ${degraded.length} agent(s) need attention: ${degraded.map(r => r.id).join(', ')}`);
        } else {
          console.log(`[AgentCron] All ${agents.length} agent(s) healthy.`);
        }
      } catch (err) {
        console.warn(`[AgentCron] Nightly validation failed: ${err.message}`);
      }
    }

    async function runSkillHealthCheck() {
      console.log('[SkillCron] Starting nightly skill health check...');
      try {
        const fs   = require('fs');
        const path = require('path');
        const os   = require('os');
        const http = require('http');

        const skillsBase = path.join(os.homedir(), '.thinkdrop', 'skills');
        if (!fs.existsSync(skillsBase)) return;

        const skillDirs = fs.readdirSync(skillsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        const USER_MEMORY_URL = process.env.USER_MEMORY_URL || 'http://127.0.0.1:3001';
        const USER_MEMORY_KEY = process.env.USER_MEMORY_KEY || '';

        const updateSkillHealth = (name, status, errorLog) => new Promise(resolve => {
          const body = JSON.stringify({
            version: 'mcp.v1', service: 'user-memory', action: 'skill.upsert',
            payload: { name, status, last_run: new Date().toISOString(), error_log: errorLog || null },
            context: {}, requestId: `health-${name}-${Date.now()}`,
          });
          const req = http.request({
            hostname: '127.0.0.1', port: parseInt(new URL(USER_MEMORY_URL).port) || 3001,
            path: '/skill.upsert', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${USER_MEMORY_KEY}` },
            timeout: 5000,
          }, res => { res.resume(); resolve(); });
          req.on('error', () => resolve());
          req.on('timeout', () => { req.destroy(); resolve(); });
          req.write(body); req.end();
        });

        for (const skillName of skillDirs) {
          const skillFile = path.join(skillsBase, skillName, 'index.cjs');
          if (!fs.existsSync(skillFile)) continue;

          const logFile = path.join(skillsBase, skillName, 'skill.log');
          try {
            // Check if recently errored by reading last line of skill.log
            let lastError = null;
            if (fs.existsSync(logFile)) {
              const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
              const lastLine = lines[lines.length - 1];
              if (lastLine) {
                try {
                  const entry = JSON.parse(lastLine);
                  if (entry.event === 'error' || entry.error || entry.requiresReauth) {
                    lastError = entry.error || entry.event || 'unknown_error';
                  }
                } catch {}
              }
            }

            // Light smoke test: require the skill and call with probe args
            // Wrapped in a child_process to avoid polluting main process memory
            const { execFileSync } = require('child_process');
            const probeScript = `
              try {
                const skill = require(${JSON.stringify(skillFile)});
                skill({ _healthCheck: true }).then(r => {
                  if (r && r.requiresReauth) process.exit(2);
                  if (r && r.ok === false && r.error) { process.stderr.write(r.error); process.exit(1); }
                  process.exit(0);
                }).catch(e => { process.stderr.write(e.message); process.exit(1); });
              } catch(e) { process.stderr.write(e.message); process.exit(1); }
            `;
            try {
              execFileSync(process.execPath, ['-e', probeScript], { timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] });
              await updateSkillHealth(skillName, 'healthy', null);
              console.log(`[SkillCron] ${skillName} → healthy`);
            } catch (probeErr) {
              const exitCode = probeErr.status;
              const stderr   = (probeErr.stderr || Buffer.alloc(0)).toString().trim();
              const status   = exitCode === 2 ? 'token_expired' : 'error';
              const errorMsg = stderr || lastError || `exit code ${exitCode}`;
              await updateSkillHealth(skillName, status, errorMsg);
              console.warn(`[SkillCron] ${skillName} → ${status}: ${errorMsg}`);
            }
          } catch (err) {
            console.warn(`[SkillCron] health check failed for ${skillName}: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`[SkillCron] Nightly skill health check failed: ${err.message}`);
      }
    }

    async function runFullValidationCycle() {
      await runAgentValidation();
      await runSkillHealthCheck();
      // Also review seed map for staleness (brew pkg renames, new CLIs, deprecated tools)
      try {
        const http = require('http');
        const callCmd = (skill, args, timeoutMs = 30000) => new Promise((resolve) => {
          const body = JSON.stringify({ payload: { skill, args } });
          const req = http.request({
            hostname: '127.0.0.1', port: 3007, path: '/command.automate',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: timeoutMs,
          }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { try { resolve(JSON.parse(raw)?.data || {}); } catch { resolve({}); } });
          });
          req.on('timeout', () => { req.destroy(); resolve({}); });
          req.on('error', () => resolve({}));
          req.write(body); req.end();
        });
        const seedResult = await callCmd('cli.agent', { action: 'review_seed_map' }, 45000);
        if (seedResult?.staleEntries?.length > 0) {
          console.warn(`[AgentCron] Seed map: ${seedResult.staleEntries.length} stale entries — ${seedResult.summary || ''}`);
          seedResult.staleEntries.forEach(e => console.warn(`  [SeedMap] ${e.service}: ${e.issue}`));
        }
        if (seedResult?.missingClis?.length > 0) {
          console.log(`[AgentCron] Seed map: ${seedResult.missingClis.length} missing CLI(s) suggested`);
          seedResult.missingClis.forEach(e => console.log(`  [SeedMap] ${e.service}: try ${e.suggestedCli} — ${e.reason}`));
        }
      } catch (err) {
        console.warn(`[AgentCron] Seed map review failed: ${err.message}`);
      }
    }

    function scheduleNextValidation() {
      const now = new Date();
      const next = new Date(now);
      next.setHours(VALIDATE_HOUR, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1); // already past 3am today
      const msUntilNext = next.getTime() - now.getTime();
      console.log(`[AgentCron] Next agent validation scheduled at ${next.toLocaleTimeString()} (in ${Math.round(msUntilNext / 60000)} min)`);
      setTimeout(async () => {
        await runFullValidationCycle();
        setInterval(async () => { await runFullValidationCycle(); }, 24 * 60 * 60 * 1000);
      }, msUntilNext);
    }

    // ── On-demand IPC trigger: ipcMain 'agent:validate-now' ─────────────────
    // Send from renderer or dev tools: ipcRenderer.send('agent:validate-now')
    // Returns results via 'agent:validate-results' reply event.
    const { ipcMain } = require('electron');
    ipcMain.on('agent:validate-now', async (event) => {
      console.log('[AgentCron] On-demand validation triggered via IPC');
      try {
        await runFullValidationCycle();
        event.reply('agent:validate-results', { ok: true, ts: new Date().toISOString() });
      } catch (err) {
        event.reply('agent:validate-results', { ok: false, error: err.message });
      }
    });

    // Delay start until MCP services are likely up (10s after app ready)
    // THINKDROP_VALIDATE_ON_STARTUP=1 → fire immediately after 15s (dev/testing)
    // Default → wait until 3am
    if (process.env.THINKDROP_VALIDATE_ON_STARTUP === '1') {
      console.log('[AgentCron] THINKDROP_VALIDATE_ON_STARTUP=1 — running full validation in 15s');
      setTimeout(async () => {
        await runFullValidationCycle();
      }, 15000);
    }

    setTimeout(scheduleNextValidation, 10000);
  })();

  // ── Persistent schedule: check on startup ──────────────────────────────────
  // Case 1: App was launched BY launchd for a scheduled task.
  //         Run the skill plan immediately — no user confirmation needed.
  // Case 2: App was already open (normal launch) and a pending schedule exists.
  //         Show a non-blocking notification banner in ResultsWindow.
  const launchedScheduleId = scheduler.getLaunchedScheduleId();
  if (launchedScheduleId) {
    console.log(`[Scheduler] App launched by launchd for schedule: ${launchedScheduleId}`);
    const pending = scheduler.readPendingSchedule();
    if (pending && pending.id === launchedScheduleId && Array.isArray(pending.skillPlan) && pending.skillPlan.length > 0) {
      console.log(`[Scheduler] Auto-running scheduled task: "${pending.label}"`);
      scheduler.clearPendingSchedule(pending.id);
      // Wait for windows + stategraph to be ready, then fire the plan directly
      setTimeout(() => {
        if (!stateGraph) { console.warn('[Scheduler] StateGraph not ready for scheduled task'); return; }
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'results-window:set-prompt', pending.prompt || pending.label);
          resultsWindow.showInactive();
          resultsWindow.moveTop();
        }
        const progressCallback = (event) => {
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'automation:progress', event);
          }
          if (event.type === 'all_done' && promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
            safeSend(promptCaptureWindow, 'automation:progress', event);
          }
        };
        // Inject plan directly into stategraph as command_automate with pre-built skillPlan
        stateGraph.invoke({
          message: pending.prompt || pending.label,
          intent: { type: 'command_automate' },
          skillPlan: pending.skillPlan,
          skillCursor: 0,
          skillResults: [],
          progressCallback,
          mcpAdapter,
          activeBrowserSessionId: null,
          activeBrowserUrl: null,
          context: { userId: 'default_user', source: 'scheduled_task' },
        }).catch(err => console.error('[Scheduler] Auto-run failed:', err.message));
      }, 3000); // wait 3s for stategraph + MCP services to be ready
    } else {
      console.warn('[Scheduler] Launched for schedule but no matching pending record found — starting normally');
      scheduler.clearPendingSchedule(launchedScheduleId);
    }
  } else {
    // Normal launch — check if a pending schedule was registered while app was closed
    const pending = scheduler.readPendingSchedule();
    if (pending) {
      const targetStr = new Date(pending.targetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      console.log(`[Scheduler] Pending schedule found: "${pending.label}" at ${targetStr}`);
      // Send notification to ResultsWindow once it's loaded
      const notifyPending = () => {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'schedule:pending', {
            id: pending.id,
            label: pending.label,
            targetTime: targetStr,
            prompt: pending.prompt,
          });
        }
      };
      // Delay until ResultsWindow content is loaded
      if (resultsWindow) {
        resultsWindow.webContents.once('did-finish-load', () => setTimeout(notifyPending, 500));
      }
    }
  }

  // Track active schedule countdown state via progress events (for close warning)
  // Intercept progressCallback globally by monkey-patching at IPC level
  ipcMain.on('schedule:activity', (_event, data) => {
    if (data.type === 'schedule_start') {
      activeScheduleCountdown = { id: data.scheduleId || 'unknown', targetTime: data.targetTime, label: data.label };
    } else if (data.type === 'schedule_done' || data.type === 'schedule_cancel') {
      activeScheduleCountdown = null;
    }
  });

  // Dismiss a pending schedule notification (user saw it, task will still run via launchd)
  ipcMain.on('schedule:dismiss', (_event, { id }) => {
    console.log(`[Scheduler] User dismissed pending schedule notification: ${id}`);
    // Don't clear the launchd plist — launchd will still fire at the right time
    // Just remove the notification JSON so it doesn't show again on next normal launch
    scheduler.clearPendingSchedule(id);
  });

  // ─── Queue + Cron: init broadcast callbacks ───────────────────────────────
  queueManager.init({
    queue: (items) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'queue:update', items);
      }
    },
    cron: (items) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'cron:update', items);
      }
    },
  });

  // ─── Queue IPC handlers ───────────────────────────────────────────────────
  ipcMain.on('queue:rerun', (_event, { id }) => {
    console.log(`[Queue] Rerun requested: ${id}`);
    const item = queueManager.getQueue().find(i => i.id === id);
    if (!item) return;
    queueManager.setQueueStatus(id, 'waiting');
  });

  ipcMain.on('queue:cancel', (_event, { id }) => {
    console.log(`[Queue] Cancel requested: ${id}`);
    queueManager.setQueueStatus(id, 'error', { error: 'Cancelled by user' });
  });

  // ─── Cron IPC handlers ────────────────────────────────────────────────────
  ipcMain.on('cron:toggle', (_event, { id }) => {
    console.log(`[Cron] Toggle: ${id}`);
    queueManager.toggleCron(id);
  });

  ipcMain.on('cron:delete', (_event, { id }) => {
    console.log(`[Cron] Delete: ${id}`);
    queueManager.removeCron(id);
  });

  ipcMain.on('cron:run-now', (_event, { id }) => {
    console.log(`[Cron] Run now: ${id}`);
    const item = queueManager.getCron().find(i => i.id === id);
    if (!item) return;
    // Enqueue as a one-shot run — future: re-trigger stategraph with item's stored prompt
    queueManager.recordCronRun(id);
  });

  // Paused automation state — set when recoverSkill returns ASK_USER, cleared on resume or abort
  let pausedAutomationState = null;
  let pausedSkillBuildState = null; // set when installSkill pauses for ASK_USER (secrets)
  let activeAbortController = null; // AbortController for the currently running stateGraph.execute

  // ─── Automation: Cancel active run ───────────────────────────────────────
  ipcMain.on('automation:cancel', () => {
    console.log('🛑 [Automation] Cancel requested by user');
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'automation:progress', { type: 'all_done', cancelled: true, completedCount: 0, totalCount: 0 });
    }
    if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
      safeSend(promptCaptureWindow, 'automation:progress', { type: 'all_done', cancelled: true, completedCount: 0, totalCount: 0 });
    }
  });

  // ─── Voice: IPC handlers for voice service integration ───────────────────
  const VOICE_SERVICE_URL = process.env.VOICE_SERVICE_URL || 'http://127.0.0.1:3006';

  // voice:start — activate voice listening (wake-word mode)
  ipcMain.on('voice:start', () => {
    console.log('🎙️ [Voice] Activated');
    voiceJournal.setVoiceStatus('listening');
    const wins = [promptCaptureWindow, resultsWindow];
    for (const win of wins) {
      safeSend(win, 'voice:status', { status: 'listening' });
    }
  });

  // voice:stop — deactivate voice
  ipcMain.on('voice:stop', () => {
    console.log('🎙️ [Voice] Deactivated');
    voiceJournal.setVoiceStatus('idle');
    const wins = [promptCaptureWindow, resultsWindow];
    for (const win of wins) {
      safeSend(win, 'voice:status', { status: 'idle' });
    }
  });

  // voice:push-to-talk-start — renderer signals PTT button pressed
  ipcMain.on('voice:push-to-talk-start', () => {
    console.log('🎙️ [Voice] Push-to-talk: start');
    voiceJournal.setVoiceStatus('listening');
    const wins = [promptCaptureWindow, resultsWindow];
    for (const win of wins) {
      safeSend(win, 'voice:listening', { active: true });
    }
  });

  // voice:push-to-talk-end — renderer signals PTT button released (audio chunk ready)
  ipcMain.on('voice:push-to-talk-end', () => {
    console.log('🎙️ [Voice] Push-to-talk: end — awaiting audio');
    voiceJournal.setVoiceStatus('processing');
  });

  // voice:audio-chunk — renderer sends base64 audio for processing
  let _voiceChunkActive = 0; // count of concurrent voice chunk processings
  ipcMain.on('voice:audio-chunk', async (event, { audioBase64, format = 'webm', pushToTalk = true, skipWakeWordCheck: rendererSkipWWC = null, sessionId = null, pttTextOnly = false }) => {
    console.log(`🎙️ [Voice] Audio chunk received (${format}, ${audioBase64?.length || 0} b64 chars, pttTextOnly=${pttTextOnly})`);
    // For PTT: drop duplicates (shouldn't overlap). For wake word: allow up to 2 concurrent.
    const maxConcurrent = pushToTalk ? 1 : 2;
    if (_voiceChunkActive >= maxConcurrent) {
      console.log(`🎙️ [Voice] Skipping chunk — ${_voiceChunkActive} already in flight`);
      return;
    }
    _voiceChunkActive++;

    const wins = [promptCaptureWindow, resultsWindow];

    try {
      voiceJournal.setVoiceStatus('processing');

      const response = await new Promise((resolve, reject) => {
        const http_module = require('http');
        const body = JSON.stringify({
          audioBase64,
          format,
          pushToTalk,
          skipWakeWordCheck: rendererSkipWWC !== null ? rendererSkipWWC : pushToTalk,
          skipInject: pttTextOnly,
          sessionId: sessionId || currentSessionId,
        });

        const url = new URL('/voice.process', VOICE_SERVICE_URL);
        const req = http_module.request({
          hostname: url.hostname,
          port: parseInt(url.port || '3006', 10),
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          const chunks = [];
          res.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
          res.on('end', () => {
            try {
              const respBody = Buffer.concat(chunks).toString('utf8');
              const parsed = JSON.parse(respBody);
              console.log(`🎙️ [Voice] Raw response keys: ${Object.keys(parsed).join(',')}, dataKeys: ${parsed.data ? Object.keys(parsed.data).join(',') : 'no-data'}, bodyLen: ${respBody.length}`);
              resolve(parsed);
            } catch (e) {
              console.error('🎙️ [Voice] JSON parse error:', e.message);
              resolve({});
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(180000, () => req.destroy(new Error('Voice process timeout')));
        req.write(body);
        req.end();
      });

      const result = response.data || response;
      console.log(`🎙️ [Voice] Pipeline result: lane=${result.lane}, hasAudio=${!!result.audioBase64}, skipped=${result.skipped}, reason=${result.reason || ''}, transcript=${result.transcript?.substring(0,40) || ''}`);

      // PTT text-only mode: just return the transcript to the renderer, skip LLM/TTS
      if (pttTextOnly) {
        const transcript = result.transcript || '';
        // Use englishText for StateGraph injection when translation occurred (e.g. Chinese → English).
        // The renderer's submitPTTRef sends this to stategraph:process — must be English.
        const promptText = (result.wasTranslated && result.englishText) ? result.englishText : transcript;
        console.log(`🎙️ [PTT] Text-only — transcript: "${transcript}"${result.wasTranslated ? ` → englishText: "${promptText}"` : ''}`);
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'ptt:transcript', {
            transcript: promptText,
            detectedLanguage: result.detectedLanguage || 'en',
            wasTranslated: result.wasTranslated || false,
          });
        }
        _voiceChunkActive--;
        voiceJournal.setVoiceStatus('idle');
        return;
      }

      // Only show transcript in UI when actually processed (not noise-filtered/skipped)
      if (result.transcript && !result.skipped) {
        for (const win of wins) {
          if (win && !win.isDestroyed()) {
            safeSend(win, 'voice:transcript', { text: result.transcript, language: result.detectedLanguage });
          }
        }
      }

      // Forward responses to Results window:
      // - stategraph: full answer (if not already streamed live during execution)
      // - fast: response text (butler reply — show so user can read what was spoken)
      if (result.lane === 'stategraph' && result.fullAnswer && !result._hadLiveStream) {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          if (result.transcript) safeSend(resultsWindow, 'results-window:set-prompt', result.transcript);
          resultsWindow.showInactive();
          resultsWindow.moveTop();
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: result.fullAnswer, lane: 'stategraph' });
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'done', lane: 'stategraph' });
        }
      } else if (result.lane === 'fast' && result.responseEnglish && !result.skipped) {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          if (result.transcript) safeSend(resultsWindow, 'results-window:set-prompt', result.transcript);
          resultsWindow.showInactive();
          resultsWindow.moveTop();
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: result.responseEnglish, lane: 'fast' });
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'done', lane: 'fast' });
        }
      }

      if (result.audioBase64) {
        console.log(`🎙️ [Voice] Sending voice:response (${result.audioBase64.length} b64, format=${result.audioFormat})`);
        // Send ONLY to promptCaptureWindow — VoiceButton lives there and handles TTS playback.
        // Sending to both windows causes duplicate audio playback.
        safeSend(promptCaptureWindow, 'voice:response', {
            text: result.responseFinal || result.responseEnglish || '',
            fullAnswer: result.fullAnswer || '',
            audioBase64: result.audioBase64,
            audioFormat: result.audioFormat || 'mp3',
            language: result.detectedLanguage,
            lane: result.lane,
            durationEstimateMs: result.durationEstimateMs || null,
          });
      } else {
        console.log('🎙️ [Voice] No audioBase64 in result — no TTS to play');
      }

      voiceJournal.setVoiceStatus('idle');
    } catch (err) {
      console.error('❌ [Voice] Audio processing error:', err.message);
      voiceJournal.setVoiceStatus('idle');
      for (const win of wins) {
        safeSend(win, 'voice:error', { error: err.message });
      }
    } finally {
      _voiceChunkActive = Math.max(0, _voiceChunkActive - 1);
    }
  });

  // voice:transcript-direct — renderer pre-transcribed via Web Speech API, skip STT
  ipcMain.on('voice:transcript-direct', async (event, { transcript, pushToTalk = true, sessionId = null }) => {
    console.log(`🎙️ [Voice] Transcript direct: "${transcript?.substring(0, 60)}" (pushToTalk=${pushToTalk})`);
    const wins = [promptCaptureWindow, resultsWindow];
    try {
      voiceJournal.setVoiceStatus('processing');
      const response = await new Promise((resolve, reject) => {
        const http_module = require('http');
        const body = JSON.stringify({
          transcript,
          skipSTT: true,
          pushToTalk,
          skipWakeWordCheck: pushToTalk,
          sessionId: sessionId || currentSessionId,
        });
        const url = new URL('/voice.process', VOICE_SERVICE_URL);
        const req = http_module.request({
          hostname: url.hostname,
          port: parseInt(url.port || '3006', 10),
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { resolve({}); }
          });
        });
        req.on('error', reject);
        req.setTimeout(180000, () => req.destroy(new Error('Voice process timeout')));
        req.write(body);
        req.end();
      });

      const result = response.data || response;
      console.log(`🎙️ [Voice] Direct transcript result: lane=${result.lane}, hasAudio=${!!result.audioBase64}, skipped=${result.skipped}`);

      if (result.transcript && !result.skipped) {
        for (const win of wins) {
          safeSend(win, 'voice:transcript', { text: result.transcript, language: result.detectedLanguage });
        }
      }
      if (result.lane === 'stategraph' && result.fullAnswer && !result._hadLiveStream) {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          if (result.transcript) safeSend(resultsWindow, 'results-window:set-prompt', result.transcript);
          resultsWindow.showInactive(); resultsWindow.moveTop();
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: result.fullAnswer, lane: 'stategraph' });
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'done', lane: 'stategraph' });
        }
      } else if (result.lane === 'fast' && result.responseEnglish && !result.skipped) {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          if (result.transcript) safeSend(resultsWindow, 'results-window:set-prompt', result.transcript);
          resultsWindow.showInactive(); resultsWindow.moveTop();
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: result.responseEnglish, lane: 'fast' });
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'done', lane: 'fast' });
        }
      }
      if (result.audioBase64) {
        // Send ONLY to promptCaptureWindow to avoid duplicate TTS
        safeSend(promptCaptureWindow, 'voice:response', {
            text: result.responseFinal || result.responseEnglish || '',
            fullAnswer: result.fullAnswer || '',
            audioBase64: result.audioBase64,
            audioFormat: result.audioFormat || 'mp3',
            language: result.detectedLanguage,
            lane: result.lane,
            durationEstimateMs: result.durationEstimateMs || null,
          });
      }
      voiceJournal.setVoiceStatus('idle');
    } catch (err) {
      console.error('❌ [Voice] Direct transcript error:', err.message);
      voiceJournal.setVoiceStatus('idle');
      for (const win of wins) {
        if (win && !win.isDestroyed()) safeSend(win, 'voice:error', { error: err.message });
      }
    }
  });

  // ─── StateGraph: Process prompt through full pipeline ────────────────────
  ipcMain.on('stategraph:process', async (event, { prompt, selectedText = '', sessionId = null, userId = 'default_user', responseLanguage = null }) => {
    console.log('🧠 [StateGraph] Processing prompt:', prompt.substring(0, 80), responseLanguage ? `(responseLanguage: ${responseLanguage})` : '');

    // Track this prompt so clipboard monitor won't re-capture it as a highlight
    recentlySubmittedPrompts.add(prompt.trim());
    setTimeout(() => recentlySubmittedPrompts.delete(prompt.trim()), 60000);

    if (!stateGraph) {
      console.error('❌ [StateGraph] Not initialized');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:error', 'StateGraph not initialized');
      }
      return;
    }

    // Show ResultsWindow and set prompt display (without stealing focus from active app)
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'results-window:set-prompt', prompt);
      resultsWindow.showInactive();
      resultsWindow.moveTop();
    }

    // Snapshot webContents at handler start — if the window reloads mid-stream the
    // reference becomes stale and safeSend would spam "Render frame was disposed" errors.
    const targetContents = (resultsWindow && !resultsWindow.isDestroyed()) ? resultsWindow.webContents : null;

    // Stream callback: forward each token to ResultsWindow as it arrives.
    let streamingUsed = false;
    const streamCallback = (token) => {
      streamingUsed = true;
      if (!targetContents || targetContents.isDestroyed()) return;
      try { targetContents.send('ws-bridge:message', { type: 'chunk', text: token }); } catch (_) {}
    };

    // Progress callback: forward automation progress events to ResultsWindow (and prompt window for glow)
    const progressCallback = (event) => {
      const logStr = event.type === 'all_done'
        ? JSON.stringify({ type: event.type, completedCount: event.completedCount, totalCount: event.totalCount, savedFilePaths: event.savedFilePaths })
        : JSON.stringify(event).substring(0, 120);
      console.log(`[ProgressCallback] Event: ${event.type}`, logStr);
      // Track active schedule countdown for close warning
      if (event.type === 'schedule_start') {
        activeScheduleCountdown = { id: event.scheduleId || 'unknown', targetTime: event.targetTime, label: event.label };
      } else if (event.type === 'step_done' && event.skill === 'schedule') {
        activeScheduleCountdown = null;
      } else if (event.type === 'all_done') {
        activeScheduleCountdown = null;
      }
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', event);
      } else {
        console.warn('[ProgressCallback] resultsWindow not available for event:', event.type);
      }
      // Forward all_done to promptCaptureWindow so its glow clears
      if (event.type === 'all_done' && promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'automation:progress', event);
      }
      // needs_skill gap — notify resultsWindow so AutomationProgress shows the capability gap card
      // Do NOT auto-open Skill Store in promptCaptureWindow; user clicks the card button to open it
      if (event.type === 'skill_store_trigger') {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'skill:store-trigger', { capability: event.capability, suggestion: event.suggestion });
        }
      }
    };

    // Install confirmation callback: pauses the plan until the user clicks Install or Skip
    // in ResultsWindow. Returns a Promise<boolean> resolved by the IPC reply.
    // Uses ipcMain.on + manual cleanup (not .once) to avoid cross-run listener consumption.
    let pendingInstallResolve = null;
    const handleInstallConfirm = (_event, { confirmed }) => {
      console.log(`[ConfirmInstall] IPC received: install:confirm confirmed=${confirmed}`);
      if (pendingInstallResolve) {
        const resolve = pendingInstallResolve;
        pendingInstallResolve = null;
        resolve(confirmed === true);
      } else {
        console.warn('[ConfirmInstall] Received install:confirm but no pending resolve — ignoring');
      }
    };
    ipcMain.on('install:confirm', handleInstallConfirm);

    const confirmInstallCallback = (tool) => {
      return new Promise((resolve) => {
        pendingInstallResolve = resolve;
        console.log(`[ConfirmInstall] Waiting for user confirmation for: ${tool}`);
        // 5-minute timeout — auto-skip if user never responds
        setTimeout(() => {
          if (pendingInstallResolve === resolve) {
            console.warn(`[ConfirmInstall] Timed out waiting for confirmation of: ${tool} — auto-skipping`);
            pendingInstallResolve = null;
            resolve(false);
          }
        }, 5 * 60 * 1000);
      });
    };

    // Guide continue/cancel callbacks: pauses the plan until the user clicks
    // "Continue" or "Stop Guide" in the guide step card.
    let pendingGuideResolve = null;
    let guideCancelled = false;
    const handleGuideContinue = (_event) => {
      console.log('[GuideStep] IPC received: guide:continue');
      if (pendingGuideResolve) {
        const resolve = pendingGuideResolve;
        pendingGuideResolve = null;
        resolve(true);
      } else {
        console.warn('[GuideStep] Received guide:continue but no pending resolve — ignoring');
      }
    };
    const handleGuideCancel = (_event) => {
      console.log('[GuideStep] IPC received: guide:cancel — aborting current guide');
      guideCancelled = true;
      if (pendingGuideResolve) {
        const resolve = pendingGuideResolve;
        pendingGuideResolve = null;
        resolve(false);
      }
      // Abort the entire stateGraph run immediately — this unblocks any pending MCP call
      // including guide.step's long-poll regardless of whether a browser session is open.
      if (activeAbortController) {
        console.log('[GuideStep] Aborting active stateGraph run via AbortController');
        activeAbortController.abort();
        activeAbortController = null;
      }
      // Also try to unblock browser-based guide triggers if a session is open
      if (currentBrowserSessionId) {
        const cancelUrl = `http://127.0.0.1:3007/command.automate`;
        // 1. Call __tdTrigger to unblock the Promise
        fetch(cancelUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill: 'browser.act', args: { action: 'evaluate', sessionId: currentBrowserSessionId, expression: 'if (typeof window.__tdTrigger === "function") window.__tdTrigger(); true' } })
        }).catch(() => {});
        // 2. Clear all ThinkDrop overlays from the page
        fetch(cancelUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill: 'browser.act', args: { action: 'highlight', sessionId: currentBrowserSessionId, clear: true } })
        }).catch(() => {});
      }
      // Notify UI that automation was cancelled
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', { type: 'all_done', cancelled: true, completedCount: 0, totalCount: 0 });
      }
    };
    ipcMain.on('guide:continue', handleGuideContinue);
    ipcMain.on('guide:cancel', handleGuideCancel);

    const isGuideCancelled = () => guideCancelled;

    const confirmGuideCallback = () => {
      return new Promise((resolve) => {
        if (guideCancelled) { resolve(false); return; }
        pendingGuideResolve = resolve;
        console.log('[GuideStep] Waiting for user to click Continue...');
        // 5-minute timeout — auto-continue if user never responds
        setTimeout(() => {
          if (pendingGuideResolve === resolve) {
            console.warn('[GuideStep] Timed out waiting for Continue — auto-continuing');
            pendingGuideResolve = null;
            resolve(true);
          }
        }, 5 * 60 * 1000);
      });
    };

    try {
      // If there's a paused automation waiting for user input, resume it
      let initialState;
      if (pausedAutomationState) {
        const paused = pausedAutomationState;
        const userReply = prompt.trim().toLowerCase();

        // Detect if the new prompt is clearly a fresh/unrelated request rather than
        // an answer to the paused question. Fresh prompts typically:
        // - Ask a question about the past ("what have I been doing", "what did I do")
        // - Start a completely new task ("send email to...", "open Slack", "search for...")
        // - Are clearly not one of the offered options
        const isFreshPrompt = (
          /\b(what have i been|what did i|what was i|summarize|recap|history|last hour|last \d+ min)\b/i.test(prompt) ||
          /^(send|open|search|find|create|delete|move|copy|download|install|run|start|stop|quit|close|show|list|check|get|set|go to|navigate|book|buy|schedule|remind)\b/i.test(prompt.trim())
        );

        if (isFreshPrompt) {
          console.log('[StateGraph] ASK_USER resume: new prompt looks like a fresh request — clearing paused state and processing fresh');
          pausedAutomationState = null;
          initialState = { message: prompt, selectedText, streamCallback, progressCallback, confirmInstallCallback, confirmGuideCallback, isGuideCancelled, activeBrowserSessionId: currentBrowserSessionId || null, activeBrowserUrl: currentBrowserUrl || null, context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' } };
        } else if (paused.enrichmentNeeded?.length > 0 && !paused.pendingQuestion) {
          // Enrichment gap resume — user answered an entity question (e.g. "who is your cousin?")
          // enrichIntent MODE B detects [ENTITY_QUESTION marker in conversation history,
          // stores the answer, restores the original command, and retries.
          // Just re-enter fresh with the user's answer — enrichIntent handles the rest.
          pausedAutomationState = null;
          console.log(`[StateGraph] Enrichment gap resume: user answered entity question — re-entering enrichIntent MODE B`);
          initialState = {
            message: prompt,
            selectedText,
            streamCallback,
            progressCallback,
            confirmInstallCallback,
            confirmGuideCallback,
            isGuideCancelled,
            activeBrowserSessionId: currentBrowserSessionId || null,
            activeBrowserUrl: currentBrowserUrl || null,
            context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' },
          };
        } else {
          pausedAutomationState = null;
          const q = paused.pendingQuestion;
          // Map numeric reply ("1", "2", "3") to option text
          let chosenOption = prompt.trim();
          if (q?.options?.length) {
            const idx = parseInt(userReply, 10) - 1;
            if (!isNaN(idx) && idx >= 0 && idx < q.options.length) {
              chosenOption = q.options[idx];
            }
          }

          // ── Guide offer re-entry ─────────────────────────────────────────────
          // When the answer node surfaced a guide offer (_isGuideOffer) and the
          // user picked one of the first two options (walk-through or together),
          // re-enter the graph as command_automate with carriedIntent so parseIntent
          // is bypassed and planSkills generates a guide.step / api_suggest plan.
          if (q?._isGuideOffer) {
            const wantsGuide = !/no thanks/i.test(chosenOption) && !/enough/i.test(chosenOption);
            if (wantsGuide) {
              const originalMsg = q._guideContext || paused.message || prompt;
              // Prefix the chosen option so the LLM knows the user's preference
              const guideMessage = `${chosenOption}: ${originalMsg}`;
              console.log(`[StateGraph] Guide offer accepted: "${chosenOption}" — re-entering as command_automate for: "${originalMsg}"`);
              initialState = {
                message: guideMessage,
                selectedText,
                streamCallback,
                progressCallback,
                confirmInstallCallback,
                confirmGuideCallback,
                carriedIntent: 'command_automate',
                activeBrowserSessionId: currentBrowserSessionId || null,
                activeBrowserUrl: currentBrowserUrl || null,
                context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' }
              };
            } else {
              // User declined — treat as fresh prompt
              console.log('[StateGraph] Guide offer declined — clearing paused state');
              initialState = { message: prompt, selectedText, streamCallback, progressCallback, confirmInstallCallback, confirmGuideCallback, isGuideCancelled, activeBrowserSessionId: currentBrowserSessionId || null, activeBrowserUrl: currentBrowserUrl || null, context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' } };
            }
            // Skip the rest of the resume logic
            // (fall through to stateGraph.execute below)
          } else {

          const wantsAbort = /\b(abort|cancel|stop)\b/i.test(chosenOption) || /^no$/i.test(chosenOption.trim());
          const wantsSkip = /skip/i.test(chosenOption);
          // "Done, I clicked it" — user confirmed a manual step; advance cursor like skip
          const wantsDone = /\b(done|clicked|confirmed|complete|finished)\b/i.test(chosenOption);
          // "I'm logged in" — user completed login; resume plan from current skillCursor (no replan)
          const wantsLoginContinue = /logged.?in|signed.?in|i.?m in/i.test(chosenOption) || chosenOption === "I'm logged in — continue";
          if (wantsAbort) {
            // User wants to abort — notify and return immediately, do NOT re-run the graph
            console.log('[StateGraph] ASK_USER resume: user chose abort — stopping, not replanning');
            if (typeof streamCallback === 'function') {
              streamCallback('Operation cancelled.');
            } else if (typeof progressCallback === 'function') {
              progressCallback({ type: 'step_done', skill: 'cancel', description: 'Operation cancelled.' });
            }
            return { success: true, aborted: true };
          } else if (wantsLoginContinue) {
            // User confirmed login — resume plan from current skillCursor (page is now authenticated).
            // Set resumeFromLogin=true so planSkills skips the LLM replan and returns existing plan.
            console.log('[StateGraph] ASK_USER resume: user logged in — resuming plan from skillCursor', paused.skillCursor);
            initialState = {
              ...paused,
              message: paused.message,
              streamCallback,
              progressCallback,
              confirmInstallCallback,
              confirmGuideCallback,
              isGuideCancelled,
              failedStep: null,
              pendingQuestion: null,
              recoveryAction: null,
              answer: undefined,
              commandExecuted: false,
              resumeFromLogin: true,
              skillCursor: paused.skillCursor || 0,  // resume from where login was detected
              stepRetryCount: 0,
              activeBrowserSessionId: paused.activeBrowserSessionId || currentBrowserSessionId || null,
              activeBrowserUrl: paused.activeBrowserUrl || currentBrowserUrl || null,
              context: { ...paused.context, sessionId: sessionId || currentSessionId }
            };
          } else if (wantsSkip || wantsDone) {
            // Skip the failed step / user confirmed manual action — advance cursor and resume plan
            console.log('[StateGraph] ASK_USER resume: user chose skip/done — advancing cursor and resuming plan');
            initialState = {
              ...paused,
              message: paused.message,
              streamCallback,
              progressCallback,
              confirmInstallCallback,
              confirmGuideCallback,
              isGuideCancelled,
              failedStep: null,
              pendingQuestion: null,
              recoveryAction: null,
              answer: undefined,
              commandExecuted: false,
              skillCursor: (paused.skillCursor || 0) + 1,  // skip the failed step
              stepRetryCount: 0,
              context: { ...paused.context, sessionId: sessionId || currentSessionId }
            };
          } else {
            // User provided a custom answer — inject it as recoveryContext and replan
            console.log('[StateGraph] ASK_USER resume: user provided answer — replanning with context');
            initialState = {
              ...paused,
              message: paused.message,
              streamCallback,
              progressCallback,
              confirmInstallCallback,
              confirmGuideCallback,
              isGuideCancelled,
              failedStep: null,
              pendingQuestion: null,
              recoveryAction: 'replan',
              recoveryContext: {
                failedSkill: paused.failedStep?.skill || 'browser.act',
                failedStep: paused.failedStep?.step || paused.skillCursor,
                failureReason: paused.failedStep?.error || 'user requested change',
                suggestion: `User replied: "${prompt}". Adjust the plan accordingly.`,
                constraint: null
              },
              answer: undefined,
              commandExecuted: false,
              skillPlan: null,
              skillCursor: 0,
              stepRetryCount: 0,
              context: { ...paused.context, sessionId: sessionId || currentSessionId }
            };
          }
          } // end non-guide-offer branch
        }
      } else {
        initialState = {
          message: prompt,
          selectedText,
          streamCallback,
          progressCallback,
          confirmInstallCallback,
          confirmGuideCallback,
          isGuideCancelled,
          activeBrowserSessionId: currentBrowserSessionId || null,
          activeBrowserUrl: currentBrowserUrl || null,
          responseLanguage: responseLanguage || null,
          context: {
            sessionId: sessionId || currentSessionId,
            userId,
            source: 'thinkdrop_electron'
          }
        };
      }

      activeAbortController = new AbortController();

      // Flush any stale cancel/pause signals before starting — a cancel from a
      // previous run should never abort a fresh execution.
      const _staleSignals = voiceJournal.readPendingSignals();
      for (const sig of _staleSignals) {
        if (sig.type === 'cancel' || sig.type === 'pause') {
          voiceJournal.acknowledgeSignal(sig.id);
        }
      }

      // ── Voice Journal: report start + per-node progress ──────────────────────
      const _runStartedAt = Date.now(); // signals older than this are from a previous context
      voiceJournal.graphStarted({
        intent: initialState?.intent?.type || initialState?.intent || 'unknown',
        sessionId: initialState?.context?.sessionId || initialState?.sessionId || null,
      });
      let _journalNodeIndex = 0;

      const _journalOnProgress = async (nodeName, _nodeState, durationMs, phase) => {
        if (phase !== 'completed') return;
        _journalNodeIndex++;
        voiceJournal.graphNodeDone({ node: nodeName, durationMs, nodeIndex: _journalNodeIndex, totalNodes: 0 });

        // Check for pending voice signals (cancel/pause/inject)
        // Only honor signals written AFTER this run started — prevents concurrent VAD
        // audio chunks from cancelling a stategraph run with background noise signals.
        const signals = voiceJournal.readPendingSignals();
        for (const sig of signals) {
          const sigAge = Date.now() - new Date(sig.ts).getTime();
          const sigWrittenAfterRunStart = new Date(sig.ts).getTime() >= _runStartedAt;
          if (sig.type === 'cancel') {
            if (!sigWrittenAfterRunStart) {
              console.log('[VoiceJournal] Ignoring stale cancel signal (predates this run)', { sigAge });
              voiceJournal.acknowledgeSignal(sig.id);
              continue;
            }
            console.log('[VoiceJournal] Cancel signal received — aborting StateGraph');
            activeAbortController && activeAbortController.abort();
            voiceJournal.acknowledgeSignal(sig.id);
          } else if (sig.type === 'pause') {
            console.log('[VoiceJournal] Pause signal received (acknowledged, pause handled at next node boundary)');
            voiceJournal.acknowledgeSignal(sig.id);
          } else if (sig.type === 'resume' || sig.type === 'inject') {
            voiceJournal.acknowledgeSignal(sig.id);
          }
        }
      };

      const finalState = await stateGraph.execute(initialState, _journalOnProgress, activeAbortController.signal);
      activeAbortController = null;

      // Voice Journal: report completion
      voiceJournal.graphDone({
        intent: finalState?.intent?.type || finalState?.intent || 'unknown',
        summary: finalState?.answer ? finalState.answer.substring(0, 120) : '',
      });

      // Persist resolved session for next prompt
      if (finalState.resolvedSessionId) {
        currentSessionId = finalState.resolvedSessionId;
      }

      // Persist active browser session so follow-up prompts reuse the same Playwright tab.
      // If recoverSkill cleared it (browser was closed), reset so next prompt starts fresh.
      if (finalState.activeBrowserSessionId) {
        currentBrowserSessionId = finalState.activeBrowserSessionId;
        currentBrowserUrl = finalState.activeBrowserUrl || currentBrowserUrl;
        console.log(`[StateGraph] Persisted browser session: ${currentBrowserSessionId} @ ${currentBrowserUrl}`);
      } else if ('activeBrowserSessionId' in finalState && finalState.activeBrowserSessionId === null) {
        console.log(`[StateGraph] Browser session cleared (was: ${currentBrowserSessionId}) — next prompt will open a new tab`);
        currentBrowserSessionId = null;
        currentBrowserUrl = null;
      }

      // For command_automate, AutomationProgress handles the display via automation:progress events.
      // Also forward pendingQuestion for web_search/general_knowledge/screen_intelligence when
      // the answer node appended a guide offer (_isGuideOffer).
      const intentType = finalState.intent?.type;
      if (finalState.pendingQuestion?.question) {
        const q = finalState.pendingQuestion;

        // ── On-demand skill build paused for a secret ──────────────────────────
        // installSkill set skillBuildPhase='asking' inside an on-demand build run.
        // Store in pausedSkillBuildState so skill:build-answer can resume it, and
        // send skill:build-asking so SkillBuildProgress shows the setup card.
        if (finalState.skillBuildPhase === 'asking') {
          pausedSkillBuildState = finalState;
          console.log(`[StateGraph] On-demand skill build ASK_USER: pausing for secret "${finalState.skillBuildCurrentSecretKey}"`);
          const askingPayload = {
            name: finalState.skillBuildRequest?.name || '',
            question: q.question,
            keyLabel: q.keyLabel || null,
            serviceContext: q.serviceContext || null,
            options: q.options || [],
            scannedFields: q.scannedFields || null,
          };
          safeSend(promptCaptureWindow, 'skill:build-asking', askingPayload);
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'skill:build-asking', askingPayload);
          }
        } else {
          // Persist the full state so the next user reply can resume / re-enter
          pausedAutomationState = finalState;
          console.log(`[StateGraph] ASK_USER (${intentType}): pausing — next prompt will resume`);
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'automation:progress', {
              type: 'ask_user',
              question: q.question,
              options: q.options || []
            });
          }
        }
      }
      if (intentType === 'command_automate') {
        // Enrichment gap question — entity or profile info missing, asking user before proceeding.
        // Send the question as a visible message and pause state so next reply resumes the command.
        if (finalState.enrichmentNeeded?.length > 0 && finalState.answer && !finalState.pendingQuestion) {
          pausedAutomationState = finalState;
          console.log(`[StateGraph] Enrichment gap (${intentType}): pausing for entity info — next prompt will resume`);
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            // Strip internal routing markers before showing to user
            const cleanAnswer = finalState.answer.replace(/^\[.*?\]\s*/s, '').trim();
            safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: cleanAnswer });
          }
        }
        // Plan error not caught by progressCallback (e.g. no skillPlan at all)
        if (finalState.planError && !finalState.skillPlan && !finalState.pendingQuestion) {
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'automation:progress', { type: 'plan_error', error: finalState.planError });
          }
        }
        // Send all_done for normal completion so AutomationProgress clears evaluating/retrying phases.
        // Skip if paused for ASK_USER — that case sends ask_user above and waits for user reply.
        if (!finalState.pendingQuestion && !finalState.planError && resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'automation:progress', {
            type: 'all_done',
            completedCount: (finalState.skillResults || []).length,
            totalCount: (finalState.skillPlan || []).length,
            skillResults: finalState.skillResults || [],
            savedFilePaths: finalState.savedFilePaths || [],
            answer: finalState.answer || '',
          });
        }
        // Do NOT send ws-bridge:message for normal completion — AutomationProgress shows it
      }

      // For non-streaming intents (e.g. memory_store), the answer node is skipped so
      // streamCallback is never called. Send the answer as a single chunk so the UI
      // shows it instead of the "Waiting for response..." placeholder.
      if (intentType !== 'command_automate' && finalState.answer && !streamingUsed) {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: finalState.answer });
        }
      }

      // Signal stream end (stops thinking spinner + clears prompt glow)
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
      }
      if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'ws-bridge:message', { type: 'done' });
      }

      // Print full trace to console
      const traceLines = (finalState.trace || []).map((t, i) => {
        const status = t.success ? '✅' : '❌';
        const err = t.error ? ` — ${t.error}` : '';
        return `  ${i + 1}. ${status} [${t.node}] ${t.duration}ms${err}`;
      }).join('\n');
      console.log(
        `✅ [StateGraph] Done in ${finalState.elapsedMs}ms | Intent: ${finalState.intent?.type} (${finalState.intent?.confidence?.toFixed(2)})\n` +
        `📍 Trace (${finalState.trace?.length} nodes):\n${traceLines}`
      );

    } catch (err) {
      console.error('❌ [StateGraph] Execution error:', err.message);
      voiceJournal.graphError({
        intent: (initialState || {})?.intent?.type || (initialState || {})?.intent || 'unknown',
        error: err?.message || String(err),
      });
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:error', err.message);
      }
    } finally {
      // Always clean up the install:confirm and guide:continue/cancel listeners to prevent accumulation across runs
      ipcMain.removeListener('install:confirm', handleInstallConfirm);
      ipcMain.removeListener('guide:continue', handleGuideContinue);
      ipcMain.removeListener('guide:cancel', handleGuideCancel);
      pendingInstallResolve = null;
      pendingGuideResolve = null;
      guideCancelled = false;
    }
  });

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (promptCaptureWindow) {
      if (promptCaptureWindow.isVisible()) {
        promptCaptureWindow.hide();
        if (resultsWindow) resultsWindow.hide();
        stopClipboardMonitoring();
      } else {
        // Get cursor position and screen dimensions nut-tree-fork/nut-js
        const { mouse, Button } = require('@nut-tree-fork/nut-js');

        const { x, y } = screen.getCursorScreenPoint();
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        
        // Position prompt capture at cursor
        promptCaptureWindow.setPosition(x - 250, y - 60);
        promptCaptureWindow.show();
        promptCaptureWindow.focus();
        safeSend(promptCaptureWindow, 'prompt-capture:show', { position: { x, y } });

        const bounds = promptCaptureWindow.getBounds();
        const centerX = bounds.x + Math.floor(bounds.width / 2);
        const centerY = bounds.y + Math.floor(bounds.height / 2);

        mouse.setPosition({ x: centerX, y: centerY });
        mouse.click(Button.LEFT);

        // Position results window in bottom-right corner
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          const margin = 20;

          // If we have a tracked content height, reuse it; otherwise default to 300
          if (resultsWindowInitialHeight && resultsWindowInitialHeight > 0) {
            // Preserve existing content-based size, just re-show at correct position
            const currentBounds = resultsWindow.getBounds();
            const windowWidth = currentBounds.width || 400;
            const windowHeight = currentBounds.height || 300;
            const newX = screenWidth - windowWidth - margin;
            const newY = screenHeight - windowHeight - margin;
            console.log(`📐 [Results Window] Re-showing with existing size ${windowWidth}x${windowHeight} at (${newX}, ${newY})`);
            resultsWindow.setBounds({ x: newX, y: newY, width: windowWidth, height: windowHeight });
          } else {
            // First time or no content yet — use default size
            const windowWidth = 400;
            const windowHeight = 300;
            const newX = screenWidth - windowWidth - margin;
            const newY = screenHeight - windowHeight - margin;
            console.log(`📐 [Results Window] Initial show ${windowWidth}x${windowHeight} at (${newX}, ${newY})`);
            resultsWindow.setBounds({ x: newX, y: newY, width: windowWidth, height: windowHeight });
          }

          resultsWindow.showInactive();
          // Notify renderer to re-measure and resize based on current content
          safeSend(resultsWindow, 'results-window:show', { position: { x, y } });
          console.log('[Results Window] Shown alongside Prompt Capture Window.');
        }

        startClipboardMonitoring(true);
        console.log('[Prompt Capture] Activated via global shortcut.');
      }
    }
  });

  // Backtick PTT — toggle mode: press once to start, press again to stop.
  let pttGlobalActive = false;
  const safeSendToWins = (channel) => {
    [promptCaptureWindow, resultsWindow].forEach(w => {
      if (!w || w.isDestroyed()) return;
      try { w.webContents.send(channel); } catch (_) {}
    });
  };

  globalShortcut.register('`', () => {
    if (!pttGlobalActive) {
      pttGlobalActive = true;
      console.log('🎙️ [PTT] backtick — start');
      safeSendToWins('voice:ptt-start');
    } else {
      pttGlobalActive = false;
      console.log('🎙️ [PTT] backtick — stop');
      safeSendToWins('voice:ptt-stop');
    }
  });

  // Shift+Cmd+C — tag current clipboard content as context, then restore original clipboard.
  // Workflow: user selects text or a file and copies (Cmd+C), then presses Shift+Cmd+C to tag it.
  // The clipboard is read, tagged, then restored to its prior value so nothing is lost.
  // Works on Mac and Windows — no AppleScript or platform-specific APIs needed.
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    // Save the current clipboard value before we do anything
    const previousClipboard = clipboard.readText();
    const tagged = previousClipboard;

    if (!tagged || !tagged.trim()) {
      console.log('[Tag Shortcut] Clipboard is empty — nothing to tag.');
      return;
    }
    if (recentlySubmittedPrompts.has(tagged.trim())) {
      console.log('[Tag Shortcut] Skipping recently submitted prompt.');
      return;
    }

    // Detect if the clipboard content looks like a file path (tagged as file context)
    const looksLikeFilePath = /^(\/[^\n]+|[A-Z]:\\[^\n]+)$/.test(tagged.trim());
    let resolvedTagPath = tagged.trim();
    if (looksLikeFilePath) {
      // macOS screenshot filenames use U+202F NARROW NO-BREAK SPACE before AM/PM.
      // The clipboard delivers a regular space, so we try normalization candidates
      // to find the actual path that exists on disk before storing the tag.
      const fs = require('fs');
      const withNarrowSpace = resolvedTagPath.replace(/ (AM|PM)\./g, '\u202F$1.');
      const candidates = [
        resolvedTagPath,
        withNarrowSpace,
        resolvedTagPath.normalize('NFC'),
        resolvedTagPath.normalize('NFD'),
        withNarrowSpace.normalize('NFC'),
        withNarrowSpace.normalize('NFD'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) { resolvedTagPath = c; break; }
      }
    }
    const tagContent = looksLikeFilePath
      ? `[File: ${resolvedTagPath}]`
      : resolvedTagPath;

    console.log(`[Tag Shortcut] Tagging: ${tagContent.substring(0, 120)}`);

    if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
      if (!promptCaptureWindow.isVisible()) {
        const { x, y } = screen.getCursorScreenPoint();
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        promptCaptureWindow.setPosition(x - 250, y - 60);
        promptCaptureWindow.show();
        promptCaptureWindow.focus();
        safeSend(promptCaptureWindow, 'prompt-capture:show', { position: { x, y } });

        if (resultsWindow && !resultsWindow.isDestroyed()) {
          const margin = 20;
          const currentBounds = resultsWindow.getBounds();
          const windowWidth = currentBounds.width || 400;
          const windowHeight = currentBounds.height || 300;
          resultsWindow.setBounds({ x: screenWidth - windowWidth - margin, y: screenHeight - windowHeight - margin, width: windowWidth, height: windowHeight });
          resultsWindow.showInactive();
        }
      }
      safeSend(promptCaptureWindow, 'prompt-capture:add-highlight', tagContent);
      sentHighlights.add(tagContent);
    }

    // Restore the original clipboard after a short delay so the tag send completes first
    setTimeout(() => {
      clipboard.writeText(previousClipboard);
      console.log('[Tag Shortcut] Clipboard restored.');
    }, 500);
  });

  // Native file picker — opens dialog and sends selected paths back to renderer
  ipcMain.on('prompt-capture:pick-file', async (event) => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(promptCaptureWindow, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      title: 'Select file or folder to tag as context',
    });
    if (!result.canceled && result.filePaths.length > 0) {
      result.filePaths.forEach(fp => {
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'prompt-capture:add-highlight', `[File: ${fp}]`);
        }
      });
    }
  });

  // Open a file path in its default app, or reveal in Finder if it's a directory
  ipcMain.on('shell:open-path', async (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') return;
    const { shell } = require('electron');
    const fs = require('fs');
    const os = require('os');
    // Expand ~/path → absolute (Node.js fs and Electron shell do not expand ~)
    const resolvedPath = filePath.startsWith('~/') ? filePath.replace('~', os.homedir()) : filePath;
    console.log(`[Shell] Opening path: ${resolvedPath}`);
    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        shell.showItemInFolder(resolvedPath);
      } else {
        const err = await shell.openPath(resolvedPath);
        if (err) {
          console.warn(`[Shell] openPath failed (${err}), falling back to showItemInFolder`);
          shell.showItemInFolder(resolvedPath);
        }
      }
    } catch (e) {
      console.warn(`[Shell] Path not found: ${resolvedPath}`);
    }
  });

  ipcMain.on('shell:open-url', (_event, url) => {
    if (!url || typeof url !== 'string') return;
    const { shell } = require('electron');
    console.log(`[Shell] Opening URL in default browser: ${url}`);
    shell.openExternal(url).catch(err => console.warn(`[Shell] openExternal failed: ${err}`));
  });

  // ─── Skills Manager: list installed skills ────────────────────────────────
  ipcMain.on('skill:list', (event) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const skillsDir = path.join(os.homedir(), '.thinkdrop', 'skills');
    try {
      if (!fs.existsSync(skillsDir)) {
        event.sender.send('skill:list-response', { skills: [] });
        return;
      }
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const skills = entries
        .filter(e => e.isDirectory())
        .map(e => {
          const skillPath = path.join(skillsDir, e.name);
          const mdPath = path.join(skillPath, 'skill.md');
          let description = '';
          try {
            const md = fs.readFileSync(mdPath, 'utf8');
            const descMatch = md.match(/^description:\s*(.+)$/m);
            description = descMatch ? descMatch[1].trim() : '';
          } catch (_) {}
          return { name: e.name, description, path: skillPath };
        });
      event.sender.send('skill:list-response', { skills });
    } catch (err) {
      console.error('[skill:list] Error:', err.message);
      event.sender.send('skill:list-response', { skills: [], error: err.message });
    }
  });

  // ─── Skills Manager: delete a skill by name (moves to Trash) ────────────
  ipcMain.on('skill:delete', async (event, { name }) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { shell } = require('electron');
    if (!name || typeof name !== 'string' || name.includes('..') || name.includes('/')) {
      event.sender.send('skill:delete-response', { ok: false, error: 'Invalid skill name' });
      return;
    }
    const skillDir = path.join(os.homedir(), '.thinkdrop', 'skills', name);
    try {
      if (!fs.existsSync(skillDir)) {
        event.sender.send('skill:delete-response', { ok: false, error: `Skill "${name}" not found` });
        return;
      }
      // Move to Trash so the user can recover if needed
      const trashResult = await shell.trashItem(skillDir);
      console.log(`[skill:delete] Moved to Trash: ${skillDir}`);
      event.sender.send('skill:delete-response', { ok: true, name });
    } catch (err) {
      console.error('[skill:delete] Error:', err.message);
      event.sender.send('skill:delete-response', { ok: false, error: err.message });
    }
  });

  // ─── Skill Store: open from capability gap card (results window → prompt capture) ──
  ipcMain.on('skill:store-open', (_event, { capability, suggestion } = {}) => {
    console.log(`[SkillStore] Opening Skill Store for capability: "${capability}"`);
    safeSend(promptCaptureWindow, 'skill:store-trigger', { capability: capability || '', suggestion: suggestion || '' });
  });

  // ─── Skill Store: kick off the skill build pipeline ─────────────────────
  ipcMain.on('skill:build-start', async (event, skillEntry) => {
    const { name, displayName, description, category, ocUrl, rawUrl } = skillEntry || {};
    if (!name) {
      safeSend(promptCaptureWindow, 'skill:build-done', { name: '', ok: false, error: 'Missing skill name' });
      return;
    }
    console.log(`[SkillBuild] Starting build pipeline for "${displayName || name}" (${category})`);

    if (!stateGraph) {
      safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: false, error: 'StateGraph not initialized' });
      return;
    }

    // Show results window for build progress
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'results-window:set-prompt', `Building skill: ${displayName || name}`);
      resultsWindow.showInactive();
      resultsWindow.moveTop();
    }

    const progressCallback = (evt) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', evt);
      }
      if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'automation:progress', evt);
      }
      // Forward done event back to SkillStore
      if (evt.type === 'skill_build_done') {
        safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: evt.ok, installedPath: evt.installedPath });
      }
    };

    const initialState = {
      message: `Build ThinkDrop skill: ${displayName || name}`,
      intent: { type: 'skill_build', confidence: 1.0 },
      skillBuildRequest: { name, displayName, description, category, ocUrl, rawUrl },
      skillBuildRound: 1,
      skillBuildRounds: [],
      skillBuildPhase: 'fetching',
      progressCallback,
      streamCallback: (token) => {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          try { resultsWindow.webContents.send('ws-bridge:message', { type: 'chunk', text: token }); } catch (_) {}
        }
      },
      confirmInstallCallback: () => Promise.resolve(true),
      confirmGuideCallback: () => Promise.resolve(false),
      isGuideCancelled: () => false,
      context: { sessionId: currentSessionId, userId: 'default_user', source: 'skill_store' },
    };

    try {
      const abortCtrl = new AbortController();
      const finalState = await stateGraph.execute(initialState, null, abortCtrl.signal);

      if (finalState.skillBuildPhase === 'asking' && finalState.pendingQuestion) {
        // Paused for user secret input — store state for resume
        pausedSkillBuildState = finalState;
        const askingPayload = {
          name,
          question: finalState.pendingQuestion.question,
          keyLabel: finalState.pendingQuestion.keyLabel || null,
          serviceContext: finalState.pendingQuestion.serviceContext || null,
          options: finalState.pendingQuestion.options || [],
          scannedFields: finalState.pendingQuestion.scannedFields || null,
        };
        safeSend(promptCaptureWindow, 'skill:build-asking', askingPayload);
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'skill:build-asking', askingPayload);
        }
      } else if (finalState.skillBuildPhase === 'done') {
        safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: true, installedPath: finalState.skillBuildInstalledPath });
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
        }
      } else if (finalState.skillBuildPhase === 'error') {
        safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: false, error: finalState.skillBuildError });
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
        }
      }
    } catch (err) {
      console.error(`[SkillBuild] Pipeline error for "${name}":`, err.message);
      safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: false, error: err.message });
    }
  });


  // ─── Skill Store: resume build after user answers a secret prompt ─────────
  ipcMain.on('skill:build-answer', async (event, { name, answer }) => {
    if (!pausedSkillBuildState) {
      console.warn('[SkillBuild] No paused skill build to resume');
      return;
    }

    const paused = pausedSkillBuildState;

    // ── Special: Developer mode — user edited the code directly ──────────────
    if (typeof answer === 'string' && answer.startsWith('__edit_skill__:')) {
      const editedCode = answer.slice('__edit_skill__:'.length).trim();
      console.log(`[SkillBuild] Developer edit received — ${editedCode.length} chars. Re-validating...`);
      pausedSkillBuildState = null;

      // Replace draft and re-run from installSkill — developer owns the code, skip re-validation
      const editResumeState = {
        ...paused,
        skillBuildDraft: editedCode,
        skillBuildAskQueue: undefined,   // force re-detect secrets from new code
        skillBuildSecrets: {},
        pendingQuestion: null,
        skillBuildPhase: 'installing',
      };

      try {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'automation:progress', { type: 'skill_build_phase', phase: 'installing', skillName: name });
        }
        const abortCtrl = new AbortController();
        const finalState = await stateGraph.execute(editResumeState, null, abortCtrl.signal);
        if (finalState.skillBuildPhase === 'asking' && finalState.pendingQuestion) {
          pausedSkillBuildState = finalState;
          const nextAsk = {
            name,
            question: finalState.pendingQuestion.question,
            keyLabel: finalState.pendingQuestion.keyLabel || null,
            serviceContext: finalState.pendingQuestion.serviceContext || null,
            options: finalState.pendingQuestion.options || [],
            scannedFields: finalState.pendingQuestion.scannedFields || null,
          };
          safeSend(promptCaptureWindow, 'skill:build-asking', nextAsk);
          if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-asking', nextAsk);
        } else if (finalState.skillBuildPhase === 'done') {
          const donePayload = { name, ok: true, installedPath: finalState.skillBuildInstalledPath };
          safeSend(promptCaptureWindow, 'skill:build-done', donePayload);
          if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-done', donePayload);
        } else {
          const errPayload = { name, ok: false, error: finalState.skillBuildError || 'Validation failed after edit' };
          safeSend(promptCaptureWindow, 'skill:build-done', errPayload);
          if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-done', errPayload);
        }
      } catch (err) {
        console.error(`[SkillBuild] Edit-resume error:`, err.message);
        safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: false, error: err.message });
      }
      return;
    }

    // ── Special: Auto-setup — launch browser.agent OAuth flow, then resume ──────
    // "Do it for me" — calls browser.agent scan_page (headless, ~5s) to discover
    // the actual credential fields for the service, then immediately surfaces them
    // as a guided form. No browser launch, no waitForAuth, no OAuth attempt.
    // Self-healing: if browser.agent run ever fails, validate_agent fires automatically.
    if (answer === '__auto_setup__') {
      const serviceContext = paused.pendingQuestion?.serviceContext || '';
      const secretKey      = paused.skillBuildCurrentSecretKey || '';
      const service        = serviceContext.toLowerCase().replace(/[^a-z0-9]/g, '');

      console.log(`[SkillBuild] Auto-setup: scan_page for service="${service}" secret="${secretKey}"`);

      // "Do it for me" no longer attempts OAuth/browser automation — that always
      // times out for services like Gmail which require a Google Cloud Console app.
      // Instead: call scan_page immediately (headless, ~5s), get the real credential
      // fields, and surface them as a guided form so the user can paste their values.
      // This is fast, reliable, and works for every service type.
      const http = require('http');
      const callBrowserAgent = (args, timeoutMs) => new Promise((resolve) => {
        const body = JSON.stringify({ payload: { skill: 'browser.agent', args } });
        const req = http.request({
          hostname: '127.0.0.1', port: 3007, path: '/command.automate',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: timeoutMs,
        }, res => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => { try { resolve(JSON.parse(raw)?.data || {}); } catch { resolve({}); } });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.write(body); req.end();
      });

      // Keep paused state so guided form submit can resume the build
      pausedSkillBuildState = paused;

      (async () => {
        try {
          const scanResult = await callBrowserAgent({
            action: 'scan_page',
            service: serviceContext || service,
            secretKey,
          }, 25000);

          const scannedFields = scanResult?.ok && scanResult.fields?.length
            ? scanResult.fields
            : null;

          console.log(`[SkillBuild] Auto-setup: scan_page got ${scannedFields?.length ?? 0} field(s) for ${service}`);

          // Immediately show guided form with discovered fields
          const guidedPayload = {
            name,
            question: paused.pendingQuestion?.question || `Enter your ${serviceContext || service} credentials`,
            keyLabel: paused.pendingQuestion?.keyLabel || null,
            serviceContext: paused.pendingQuestion?.serviceContext || null,
            options: [],
            scannedFields,
            autoSetupFailed: true, // switch UI to guided mode
          };
          safeSend(promptCaptureWindow, 'skill:build-asking', guidedPayload);
          if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-asking', guidedPayload);
        } catch (scanErr) {
          console.error('[SkillBuild] Auto-setup scan_page error:', scanErr.message);
          // Fallback: show plain guided prompt with whatever we already had
          const fallbackPayload = {
            name,
            question: paused.pendingQuestion?.question || '',
            keyLabel: paused.pendingQuestion?.keyLabel || null,
            serviceContext: paused.pendingQuestion?.serviceContext || null,
            options: paused.pendingQuestion?.options || [],
            scannedFields: paused.pendingQuestion?.scannedFields || null,
            autoSetupFailed: true,
          };
          safeSend(promptCaptureWindow, 'skill:build-asking', fallbackPayload);
          if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-asking', fallbackPayload);
        }
      })();

      return;
    }

    // ── Normal path: user submitted secret(s) ──────────────────────────────────
    pausedSkillBuildState = null;

    const secretKey = paused.skillBuildCurrentSecretKey;

    // __fields__: prefix means the UI submitted multiple scanned fields at once.
    // Unpack the JSON map and merge every field value into skillBuildSecrets.
    let updatedSecrets = { ...(paused.skillBuildSecrets || {}) };
    if (typeof answer === 'string' && answer.startsWith('__fields__:')) {
      try {
        const fieldMap = JSON.parse(answer.slice('__fields__:'.length));
        for (const [fKey, fVal] of Object.entries(fieldMap)) {
          if (fVal) updatedSecrets[fKey] = fVal;
        }
        // Also store under the primary secret key if not already captured
        if (secretKey && !updatedSecrets[secretKey]) {
          const firstVal = Object.values(fieldMap).find(v => v);
          if (firstVal) updatedSecrets[secretKey] = firstVal;
        }
        console.log(`[SkillBuild] __fields__: stored ${Object.keys(fieldMap).length} field(s) from multi-field form`);
      } catch (parseErr) {
        console.warn('[SkillBuild] __fields__: JSON parse error:', parseErr.message);
        if (secretKey) updatedSecrets[secretKey] = answer;
      }
    } else {
      if (secretKey) updatedSecrets[secretKey] = answer;
    }

    const resumeState = {
      ...paused,
      skillBuildSecrets: updatedSecrets,
      pendingQuestion: null,
      skillBuildPhase: 'installing',
    };

    try {
      const abortCtrl = new AbortController();
      const finalState = await stateGraph.execute(resumeState, null, abortCtrl.signal);

      if (finalState.skillBuildPhase === 'asking' && finalState.pendingQuestion) {
        pausedSkillBuildState = finalState;
        const nextAsk = {
          name,
          question: finalState.pendingQuestion.question,
          keyLabel: finalState.pendingQuestion.keyLabel || null,
          serviceContext: finalState.pendingQuestion.serviceContext || null,
          options: finalState.pendingQuestion.options || [],
          scannedFields: finalState.pendingQuestion.scannedFields || null,
        };
        safeSend(promptCaptureWindow, 'skill:build-asking', nextAsk);
        if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-asking', nextAsk);
      } else if (finalState.skillBuildPhase === 'done') {
        const donePayload = { name, ok: true, installedPath: finalState.skillBuildInstalledPath };
        safeSend(promptCaptureWindow, 'skill:build-done', donePayload);
        if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-done', donePayload);
      } else {
        const errPayload = { name, ok: false, error: finalState.skillBuildError || 'Build failed' };
        safeSend(promptCaptureWindow, 'skill:build-done', errPayload);
        if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-done', errPayload);
      }
    } catch (err) {
      console.error(`[SkillBuild] Resume error for "${name}":`, err.message);
      const errPayload = { name, ok: false, error: err.message };
      safeSend(promptCaptureWindow, 'skill:build-done', errPayload);
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skill:build-done', errPayload);
    }
  });

  ipcMain.on('prompt-capture:hide', () => {
    if (promptCaptureWindow) {
      promptCaptureWindow.hide();
      stopClipboardMonitoring();
    }
  });

  ipcMain.on('prompt-capture:resize', (event, { width, height }) => {
    if (promptCaptureWindow) {
      const w = Math.round(width);
      const h = Math.round(height);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        promptCaptureWindow.setSize(w, h);
      }
    }
  });

  ipcMain.on('prompt-capture:move', (event, { x, y }) => {
    if (promptCaptureWindow) {
      const px = Math.round(x);
      const py = Math.round(y);
      if (Number.isFinite(px) && Number.isFinite(py)) {
        promptCaptureWindow.setPosition(px, py);
      }
    }
  });

  ipcMain.on('results-window:show', () => {
    if (resultsWindow) {
      resultsWindow.show();
      if (!promptCaptureWindow.isVisible()) {
        promptCaptureWindow.show();
      }
    }
  });

  ipcMain.on('results-window:close', () => {
    if (resultsWindow) resultsWindow.hide();
  });

  // ipcMain.on('results-window:resize', (event, { width, height }) => {
  //   if (resultsWindow) {
  //     resultsWindow.setSize(width, height);
  //   }
  // });

  let resultsWindowInitialHeight = null;
  ipcMain.on('results-window:resize', (event, { width, height }) => {
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      const clampedWidth = Math.min(Math.max(width, 400), 600);
      const clampedHeight = Math.min(Math.max(height, 300), 800);
      const currentBounds = resultsWindow.getBounds();
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
      const margin  = 20;
     
      // Content is growing - resize from bottom up (keep fixed margin from bottom)
      const newY = screenHeight - clampedHeight - margin;
      resultsWindow.setBounds({
        x: currentBounds.x,
        y: newY, // Maintain fixed distance from bottom
        width: clampedWidth,
        height: clampedHeight
      }, true);
      resultsWindowInitialHeight = clampedHeight  
    }
  });

  ipcMain.on('results-window:move', (event, { x, y }) => {
    if (resultsWindow) {
      resultsWindow.setPosition(x, y);
    }
  });

  ipcMain.on('results-window:set-prompt', (event, text) => {
    console.log('[Results Window] Received set-prompt request.');
    console.log(`[Results Window] Prompt text length: ${text.length} characters.`);

    if (resultsWindow && !resultsWindow.isDestroyed()) {
      console.log(`[Results Window] Setting prompt text and showing window. ${text.substring(0, 100)}...`);
      safeSend(resultsWindow, 'results-window:set-prompt', text);
      
  
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
      const windowWidth = 400; // Assuming a default width, adjust as needed
      const windowHeight = 300; // Assuming a default height, adjust as needed
      const margin = 20;
      
      resultsWindow.setPosition(screenWidth - windowWidth - margin, screenHeight - windowHeight - margin);
      resultsWindow.setSize(windowWidth, windowHeight);
      
      
      if (resultsWindow.webContents.isLoading()) {
        console.log('[Results Window] Still loading content, waiting to show.');
        resultsWindow.webContents.once('did-finish-load', () => {
          console.log('[Results Window] Finished loading, now showing window.');
          safeSend(resultsWindow, 'results-window:set-prompt', text);
          resultsWindow.showInactive(); // show without stealing focus
        });
      } else {
        console.log('[Results Window] Content already loaded, showing window immediately.');
        resultsWindow.showInactive(); // show without stealing focus from active app
        resultsWindow.moveTop();
        console.log('[Results Window] Prompt text set and window shown.');
      }   
    } else {
      console.error('[Results Window] Cannot set prompt, window is not available.');
      if (!resultsWindow) {
        console.log('[Results Window] Recreating results window.');
        createResultsWindow();
      }
    }
  });

  ipcMain.on('results-window:show-error', (event, errorMessage) => {
    if (resultsWindow) {
      safeSend(resultsWindow, 'results-window:display-error', errorMessage);
      resultsWindow.show();
    }
  });

  ipcMain.on('prompt-capture:add-highlight', (event, text) => {
    if (promptCaptureWindow) {
      safeSend(promptCaptureWindow, 'prompt-capture:add-highlight', text);
    }
  });

  ipcMain.on('prompt-capture:capture-screenshot', async () => {
    try {
      resultsWindow.hide();
      promptCaptureWindow.hide();
      // Take screenshot and get image buffer
      const imgBuffer = await screenshot({ format: 'png' });
      
      console.log('📸 [MAIN] Screenshot captured, size:', imgBuffer.length, 'bytes');

      safeSend(promptCaptureWindow, 'prompt-capture:screenshot-result', {
        imageBase64: imgBuffer.toString('base64'),
      });
    } catch (error) {
      console.error('Screenshot capture failed:', error);
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:error', event.returnValue.error);
      }
    }
  });

  // VS Code Bridge IPC handlers
  ipcMain.on('ws-bridge:send-message', (event, { prompt, selectedText = '' }) => {
    console.log(' [MAIN] Received ws-bridge:send-message IPC event');
    console.log('[VS Code Bridge] Sending message:', prompt.substring(0, 50));
    
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      console.error('[VS Code Bridge] Not connected');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:error', 'Not connected to VS Code extension');
      }
      // Try to reconnect
      connectToSocket();
      return;
    }

    const id = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const payload = {
      type: 'llm_request',
      id,
      payload: {
        prompt,
        provider: 'openai',
        options: { temperature: 0.7, stream: true, taskType: 'ask' },
        context: { selectedText }
      },
      timestamp: Date.now(),
      metadata: { source: 'thinkdrop_electron' }
    };

    try {
      bridgeWs.send(JSON.stringify(payload));
      console.log('[VS Code Bridge] Message sent with id:', id);
    } catch (error) {
      console.error('[VS Code Bridge] Failed to send message:', error);
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:error', error.message);
      }
    }
  });

  ipcMain.on('ws-bridge:connect', () => {
    console.log('[VS Code Bridge] Connect requested');
    reconnectAttempts = 0;
    connectToSocket();
  });

  ipcMain.handle('ws-bridge:is-connected', () => {
    return vscodeConnected;
  });

  // ─── Bridge Auto-Listener ─────────────────────────────────────────────────
  // Watches ~/.thinkdrop/bridge.md for new WS:INSTRUCTION blocks and
  // auto-fires stategraph:process — ThinkDrop acts without any user input.
  // Start: say "file.bridge listen start"   Stop: "file.bridge listen stop"
  // Also starts automatically when ThinkDrop launches.
  {
    const fs = require('fs');
    const crypto = require('crypto');
    const BRIDGE_FILE = require('path').join(require('os').homedir(), '.thinkdrop', 'bridge.md');
    const BRIDGE_DEBOUNCE_MS = 800;

    function parseBridgeBlocks(content) {
      const blocks = [];
      const re = /<!--\s*([A-Z][A-Z0-9_]*):([\w]+)\s+(.*?)-->([\s\S]*?)<!--\s*\1:END\s*-->/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        const [, prefix, type, attrsStr, body] = m;
        if (type === 'END') continue;
        const attrs = {};
        const attrRe = /(\w+)=([^\s>]+)/g;
        let am;
        while ((am = attrRe.exec(attrsStr)) !== null) attrs[am[1]] = am[2];
        blocks.push({ id: attrs.id || `${prefix}_${type}_unknown`, prefix, type, status: attrs.status || 'unknown', body: body.trim() });
      }
      return blocks;
    }

    function hashIds(blocks) {
      return crypto.createHash('md5').update(blocks.map(b => b.id).join(',')).digest('hex');
    }

    let bridgeListenerActive = false;
    let bridgeWatcher = null;
    let bridgeDebounce = null;
    let bridgeKnownHash = '';

    function startBridgeListener() {
      if (bridgeListenerActive) return;
      if (!fs.existsSync(BRIDGE_FILE)) {
        fs.mkdirSync(require('path').dirname(BRIDGE_FILE), { recursive: true });
        fs.writeFileSync(BRIDGE_FILE, '# ThinkDrop Bridge\n\n', 'utf8');
      }

      // Snapshot current blocks so we only react to NEW ones
      const initial = fs.readFileSync(BRIDGE_FILE, 'utf8');
      bridgeKnownHash = hashIds(parseBridgeBlocks(initial));
      bridgeListenerActive = true;

      bridgeWatcher = fs.watch(BRIDGE_FILE, { persistent: true }, () => {
        if (bridgeDebounce) clearTimeout(bridgeDebounce);
        bridgeDebounce = setTimeout(() => {
          try {
            if (!fs.existsSync(BRIDGE_FILE)) return;
            const content = fs.readFileSync(BRIDGE_FILE, 'utf8');
            const blocks = parseBridgeBlocks(content);
            const newHash = hashIds(blocks);
            if (newHash === bridgeKnownHash) return;

            // Find new WS: blocks that are pending (Windsurf/Cursor wrote an instruction)
            // bridgeSeenIds tracks every block ID we've already acted on — filter to truly new ones
            const newPendingWS = blocks.filter(b =>
              b.prefix !== 'TD' && b.status === 'pending' && !bridgeSeenIds.has(b.id)
            );

            bridgeKnownHash = newHash;

            for (const block of newPendingWS) {
              bridgeSeenIds.add(block.id);
              console.log(`🌉 [Bridge Listener] New ${block.prefix}:${block.type} [${block.id}] — auto-executing`);

              // Show results window + emit executing status
              if (resultsWindow && !resultsWindow.isDestroyed()) {
                resultsWindow.show();
                safeSend(resultsWindow, 'bridge:status', { state: 'executing', blockId: block.id, summary: block.body.split('\n')[0].slice(0, 80), bridgeFile: BRIDGE_FILE });
              }

              // Fire stategraph exactly like a user submission via the IPC handler
              if (stateGraph) {
                // Show prompt in results window
                if (resultsWindow && !resultsWindow.isDestroyed()) {
                  safeSend(resultsWindow, 'results-window:set-prompt', `[Bridge] ${block.body.split('\n')[0].slice(0, 80)}`);
                }

                const bridgeProgressCallback = (evt) => {
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    safeSend(resultsWindow, 'automation:progress', evt);
                  }
                };
                const bridgeStreamCallback = (token) => {
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: token });
                  }
                };

                // Build a prompt that routes to command_automate via skill-name invocation
                // and instructs planSkills to act on this specific block body + write back
                const autoPrompt = [
                  `file.bridge act`,
                  ``,
                  `Execute this pending bridge instruction (block id: ${block.id}) and write a TD:RESULT block back to the bridge when done:`,
                  ``,
                  block.body,
                ].join('\n');

                const initialState = {
                  message: autoPrompt,
                  selectedText: '',
                  streamCallback: bridgeStreamCallback,
                  progressCallback: bridgeProgressCallback,
                  confirmInstallCallback: () => Promise.resolve(false),
                  confirmGuideCallback: () => Promise.resolve(false),
                  isGuideCancelled: () => false,
                  activeBrowserSessionId: null,
                  activeBrowserUrl: null,
                  context: { sessionId: null, userId: 'bridge_auto', source: 'bridge_listener', blockId: block.id },
                };

                stateGraph.execute(initialState).then(() => {
                  console.log(`✅ [Bridge Listener] Done executing block ${block.id}`);
                  markBridgeBlockDone(block.id);
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    safeSend(resultsWindow, 'bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
                  }
                }).catch(err => {
                  console.error(`❌ [Bridge Listener] Error executing block ${block.id}:`, err.message);
                  markBridgeBlockDone(block.id, 'error');
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    safeSend(resultsWindow, 'bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
                  }
                });
              }
            }
          } catch (err) {
            console.error('[Bridge Listener] Watch error:', err.message);
          }
        }, BRIDGE_DEBOUNCE_MS);
      });

      bridgeWatcher.on('error', (err) => console.error('[Bridge Listener] fs.watch error:', err.message));
      console.log(`🌉 [Bridge Listener] Active — watching ${BRIDGE_FILE}`);
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
      }

      // Execute any pending WS: blocks that were already in the bridge at startup
      // (fs.watch only fires on changes, so startup-pending blocks need a manual kick)
      setTimeout(() => {
        try {
          if (!fs.existsSync(BRIDGE_FILE)) return;
          const content = fs.readFileSync(BRIDGE_FILE, 'utf8');
          const startupPending = parseBridgeBlocks(content).filter(b =>
            b.prefix !== 'TD' && b.status === 'pending' && !bridgeSeenIds.has(b.id)
          );
          if (startupPending.length === 0) {
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              safeSend(resultsWindow, 'bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
            }
          } else {
            console.log(`🌉 [Bridge Listener] ${startupPending.length} pending block(s) found at startup — executing`);
          }
          for (const block of startupPending) {
            bridgeSeenIds.add(block.id);
            console.log(`🌉 [Bridge Listener] Startup: executing ${block.prefix}:${block.type} [${block.id}]`);
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              resultsWindow.show();
              safeSend(resultsWindow, 'bridge:status', { state: 'executing', blockId: block.id, summary: block.body.split('\n')[0].slice(0, 80), bridgeFile: BRIDGE_FILE });
              safeSend(resultsWindow, 'results-window:set-prompt', `[Bridge] ${block.body.split('\n')[0].slice(0, 80)}`);
            }
            if (stateGraph) {
              const autoPrompt = [
                `file.bridge act`,
                ``,
                `Execute this pending bridge instruction (block id: ${block.id}) and write a TD:RESULT block back to the bridge when done:`,
                ``,
                block.body,
              ].join('\n');
              stateGraph.execute({
                message: autoPrompt,
                selectedText: '',
                streamCallback: (token) => { if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: token }); },
                progressCallback: (evt) => { if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'automation:progress', evt); },
                confirmInstallCallback: () => Promise.resolve(false),
                confirmGuideCallback: () => Promise.resolve(false),
                isGuideCancelled: () => false,
                activeBrowserSessionId: null,
                activeBrowserUrl: null,
                context: { sessionId: null, userId: 'bridge_auto', source: 'bridge_startup', blockId: block.id },
              }).then(() => {
                console.log(`✅ [Bridge Listener] Startup: done with block ${block.id}`);
                markBridgeBlockDone(block.id);
              }).catch(err => {
                console.error(`❌ [Bridge Listener] Startup: error on block ${block.id}:`, err.message);
                markBridgeBlockDone(block.id, 'error');
              });
            }
          }
        } catch (err) {
          console.error('[Bridge Listener] Startup scan error:', err.message);
        }
      }, 2000); // 2s delay — wait for stateGraph and windows to be fully ready
    }

    function markBridgeBlockDone(blockId, finalStatus = 'done') {
      try {
        if (!fs.existsSync(BRIDGE_FILE)) return;
        let content = fs.readFileSync(BRIDGE_FILE, 'utf8');
        // Replace status=pending with status=<finalStatus> for this specific block ID
        const updated = content.replace(
          new RegExp(`(<!--\\s*(?:WS|TD):[A-Z]+ id=${blockId}[^>]*?)status=pending`),
          `$1status=${finalStatus}`
        );
        if (updated !== content) {
          fs.writeFileSync(BRIDGE_FILE, updated, 'utf8');
          console.log(`🌉 [Bridge Listener] Marked block ${blockId} as ${finalStatus} in bridge file`);
        }
      } catch (err) {
        console.error(`[Bridge Listener] Failed to mark block ${blockId} done:`, err.message);
      }
    }

    function stopBridgeListener() {
      if (!bridgeListenerActive) return;
      if (bridgeWatcher) { bridgeWatcher.close(); bridgeWatcher = null; }
      if (bridgeDebounce) { clearTimeout(bridgeDebounce); bridgeDebounce = null; }
      bridgeListenerActive = false;
      console.log('🌉 [Bridge Listener] Stopped.');
    }

    // Track which block IDs we have already acted on (persists across file changes)
    const bridgeSeenIds = new Set();
    // Seed with already-completed blocks so we don't replay them, but leave pending WS: blocks
    // unseeded so they auto-execute on startup (handles the case where ThinkDrop restarts with
    // unprocessed instructions in the bridge).
    try {
      if (fs.existsSync(BRIDGE_FILE)) {
        parseBridgeBlocks(fs.readFileSync(BRIDGE_FILE, 'utf8')).forEach(b => {
          // Skip pending non-TD blocks — they need to be executed
          if (b.prefix !== 'TD' && b.status === 'pending') return;
          bridgeSeenIds.add(b.id);
        });
      }
    } catch (_) {}

    // IPC controls — "file.bridge listen start/stop/status" from renderer or skill
    ipcMain.on('bridge:listener:start', () => startBridgeListener());
    ipcMain.on('bridge:listener:stop', () => stopBridgeListener());
    ipcMain.handle('bridge:listener:status', () => ({ active: bridgeListenerActive, bridgeFile: BRIDGE_FILE }));

    // Auto-start on launch
    startBridgeListener();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ── Schedule: warn before close if countdown is active ───────────────────────
app.on('before-quit', (e) => {
  if (!activeScheduleCountdown) return;
  // Only warn if NOT launched by launchd (i.e. user is interacting)
  const launchedScheduleId = scheduler.getLaunchedScheduleId();
  if (launchedScheduleId) return; // silent auto-run — let it quit normally
  e.preventDefault();
  const { dialog } = require('electron');
  dialog.showMessageBox({
    type: 'warning',
    title: 'Scheduled task is pending',
    message: `"${activeScheduleCountdown.label}" is scheduled to run at ${activeScheduleCountdown.targetTime}.\n\nThinkDrop will relaunch automatically at that time via macOS launchd — you can close safely.`,
    buttons: ['Close anyway', 'Keep open'],
    defaultId: 1,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      activeScheduleCountdown = null;
      app.quit();
    }
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createPromptCaptureWindow();
    createResultsWindow();
    if (resultsWindow) resultsWindow.hide();
  }
});
