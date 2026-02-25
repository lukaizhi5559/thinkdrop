// Entry point — ThinkDrop managed
require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require('electron');
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
    if (req.method !== 'POST') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    const hide = req.url === '/overlay/hide';
    const show = req.url === '/overlay/show';

    if (!hide && !show) {
      res.writeHead(404).end('Not Found');
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
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
      apiKey:           process.env.BIBSCRIP_API_KEY  || process.env.WEBSOCKET_API_KEY || '',
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
  wsUrl.searchParams.set('apiKey', process.env.BIBSCRIP_API_KEY || '');
  wsUrl.searchParams.set('userId', 'thinkdrop_electron');
  wsUrl.searchParams.set('clientId', `thinkdrop_${Date.now()}`);

  console.log(`Connecting to ${wsUrl.toString()}`);
  bridgeWs = new WebSocket(wsUrl.toString());

  bridgeWs.on('open', () => {
    console.log('✅ [VS Code Bridge] Connected');
    vscodeConnected = true;
    reconnectAttempts = 0;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('ws-bridge:connected');
    }
  });

  bridgeWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[VS Code Bridge] Message received:', message.type);
      
      // Forward all messages to ResultsWindow
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:message', message);
      }
    } catch (error) {
      console.error('[VS Code Bridge] Failed to parse message:', error);
    }
  });

  bridgeWs.on('error', (error) => {
    console.error('[VS Code Bridge] Error:', error.message);
    vscodeConnected = false;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('ws-bridge:error', error.message);
    }
  });

  bridgeWs.on('close', () => {
    console.log('[VS Code Bridge] Disconnected');
    vscodeConnected = false;
    bridgeWs = null;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('ws-bridge:disconnected');
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
    maxWidth: 600,
    minHeight: 100,
    maxHeight: 600,
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

  promptCaptureWindow.webContents.on('did-finish-load', () => {
    console.log('[PROMPT_CAPTURE] Content finished loading.');
    console.log('[PROMPT_CAPTURE] isVisible:', promptCaptureWindow.isVisible());
    
    // Open DevTools for debugging
    // promptCaptureWindow.webContents.openDevTools({ mode: 'detach' });
    console.log('[PROMPT_CAPTURE] isDestroyed:', promptCaptureWindow.isDestroyed());
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
    
    // Open DevTools for debugging
    // resultsWindow.webContents.openDevTools({ mode: 'detach' });
    console.log('[RESULTS_WINDOW] isDestroyed:', resultsWindow.isDestroyed());
    
    // Ensure the window is hidden after loading to prevent it from showing at the initial off-screen position
    setTimeout(() => resultsWindow.hide(), 50); 
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

app.whenReady().then(async () => {
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
          resultsWindow.webContents.send('results-window:set-prompt', pending.prompt || pending.label);
          resultsWindow.showInactive();
          resultsWindow.moveTop();
        }
        const progressCallback = (event) => {
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            resultsWindow.webContents.send('automation:progress', event);
          }
          if (event.type === 'all_done' && promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
            promptCaptureWindow.webContents.send('automation:progress', event);
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
          resultsWindow.webContents.send('schedule:pending', {
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

  // Paused automation state — set when recoverSkill returns ASK_USER, cleared on resume or abort
  let pausedAutomationState = null;
  let activeAbortController = null; // AbortController for the currently running stateGraph.execute

  // ─── Automation: Cancel active run ───────────────────────────────────────
  ipcMain.on('automation:cancel', () => {
    console.log('🛑 [Automation] Cancel requested by user');
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('automation:progress', { type: 'all_done', cancelled: true, completedCount: 0, totalCount: 0 });
    }
    if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
      promptCaptureWindow.webContents.send('automation:progress', { type: 'all_done', cancelled: true, completedCount: 0, totalCount: 0 });
    }
  });

  // ─── StateGraph: Process prompt through full pipeline ────────────────────
  ipcMain.on('stategraph:process', async (event, { prompt, selectedText = '', sessionId = null, userId = 'default_user' }) => {
    console.log('🧠 [StateGraph] Processing prompt:', prompt.substring(0, 80));

    // Track this prompt so clipboard monitor won't re-capture it as a highlight
    recentlySubmittedPrompts.add(prompt.trim());
    setTimeout(() => recentlySubmittedPrompts.delete(prompt.trim()), 60000);

    if (!stateGraph) {
      console.error('❌ [StateGraph] Not initialized');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:error', 'StateGraph not initialized');
      }
      return;
    }

    // Show ResultsWindow and set prompt display (without stealing focus from active app)
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('results-window:set-prompt', prompt);
      resultsWindow.showInactive();
      resultsWindow.moveTop();
    }

    // Stream callback: forward each token to ResultsWindow as it arrives
    let streamingUsed = false;
    const streamCallback = (token) => {
      streamingUsed = true;
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:message', {
          type: 'chunk',
          text: token
        });
      }
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
        resultsWindow.webContents.send('automation:progress', event);
      } else {
        console.warn('[ProgressCallback] resultsWindow not available for event:', event.type);
      }
      // Forward all_done to promptCaptureWindow so its glow clears
      if (event.type === 'all_done' && promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        promptCaptureWindow.webContents.send('automation:progress', event);
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
      // Unblock waitForTrigger and clear all overlays from the page.
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
          if (wantsAbort) {
            // User wants to abort — clear state and let it fall through as a fresh prompt
            console.log('[StateGraph] ASK_USER resume: user chose abort — clearing paused state');
            initialState = { message: prompt, selectedText, streamCallback, progressCallback, confirmInstallCallback, confirmGuideCallback, isGuideCancelled, activeBrowserSessionId: currentBrowserSessionId || null, activeBrowserUrl: currentBrowserUrl || null, context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' } };
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
          context: {
            sessionId: sessionId || currentSessionId,
            userId,
            source: 'thinkdrop_electron'
          }
        };
      }

      activeAbortController = new AbortController();
      const finalState = await stateGraph.execute(initialState, null, activeAbortController.signal);
      activeAbortController = null;

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
        // Persist the full state so the next user reply can resume / re-enter
        pausedAutomationState = finalState;
        console.log(`[StateGraph] ASK_USER (${intentType}): pausing — next prompt will resume`);
        const q = finalState.pendingQuestion;
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          resultsWindow.webContents.send('automation:progress', {
            type: 'ask_user',
            question: q.question,
            options: q.options || []
          });
        }
      }
      if (intentType === 'command_automate') {
        // Plan error not caught by progressCallback (e.g. no skillPlan at all)
        if (finalState.planError && !finalState.skillPlan && !finalState.pendingQuestion) {
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            resultsWindow.webContents.send('automation:progress', { type: 'plan_error', error: finalState.planError });
          }
        }
        // Do NOT send ws-bridge:message for normal completion — AutomationProgress shows it
      }

      // For non-streaming intents (e.g. memory_store), the answer node is skipped so
      // streamCallback is never called. Send the answer as a single chunk so the UI
      // shows it instead of the "Waiting for response..." placeholder.
      if (intentType !== 'command_automate' && finalState.answer && !streamingUsed) {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          resultsWindow.webContents.send('ws-bridge:message', { type: 'chunk', text: finalState.answer });
        }
      }

      // Signal stream end (stops thinking spinner + clears prompt glow)
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:message', { type: 'done' });
      }
      if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        promptCaptureWindow.webContents.send('ws-bridge:message', { type: 'done' });
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
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:error', err.message);
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
        promptCaptureWindow.webContents.send('prompt-capture:show', { position: { x, y } });

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
          resultsWindow.webContents.send('results-window:show', { position: { x, y } });
          console.log('[Results Window] Shown alongside Prompt Capture Window.');
        }

        startClipboardMonitoring(true);
        console.log('[Prompt Capture] Activated via global shortcut.');
      }
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
        promptCaptureWindow.webContents.send('prompt-capture:show', { position: { x, y } });

        if (resultsWindow && !resultsWindow.isDestroyed()) {
          const margin = 20;
          const currentBounds = resultsWindow.getBounds();
          const windowWidth = currentBounds.width || 400;
          const windowHeight = currentBounds.height || 300;
          resultsWindow.setBounds({ x: screenWidth - windowWidth - margin, y: screenHeight - windowHeight - margin, width: windowWidth, height: windowHeight });
          resultsWindow.showInactive();
        }
      }
      promptCaptureWindow.webContents.send('prompt-capture:add-highlight', tagContent);
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
          promptCaptureWindow.webContents.send('prompt-capture:add-highlight', `[File: ${fp}]`);
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
      resultsWindow.webContents.send('results-window:set-prompt', text);
      
  
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
          resultsWindow.webContents.send('results-window:set-prompt', text);
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
      resultsWindow.webContents.send('results-window:display-error', errorMessage);
      resultsWindow.show();
    }
  });

  ipcMain.on('prompt-capture:add-highlight', (event, text) => {
    if (promptCaptureWindow) {
      promptCaptureWindow.webContents.send('prompt-capture:add-highlight', text);
    }
  });

  ipcMain.on('prompt-capture:capture-screenshot', async () => {
    try {
      resultsWindow.hide();
      promptCaptureWindow.hide();
      // Take screenshot and get image buffer
      const imgBuffer = await screenshot({ format: 'png' });
      
      console.log('📸 [MAIN] Screenshot captured, size:', imgBuffer.length, 'bytes');

      promptCaptureWindow.webContents.send('prompt-capture:screenshot-result', {
        imageBase64: imgBuffer.toString('base64'),
      });
    } catch (error) {
      console.error('Screenshot capture failed:', error);
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:error', event.returnValue.error);
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
        resultsWindow.webContents.send('ws-bridge:error', 'Not connected to VS Code extension');
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
        resultsWindow.webContents.send('ws-bridge:error', error.message);
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
                resultsWindow.webContents.send('bridge:status', { state: 'executing', blockId: block.id, summary: block.body.split('\n')[0].slice(0, 80), bridgeFile: BRIDGE_FILE });
              }

              // Fire stategraph exactly like a user submission via the IPC handler
              if (stateGraph) {
                // Show prompt in results window
                if (resultsWindow && !resultsWindow.isDestroyed()) {
                  resultsWindow.webContents.send('results-window:set-prompt', `[Bridge] ${block.body.split('\n')[0].slice(0, 80)}`);
                }

                const bridgeProgressCallback = (evt) => {
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    resultsWindow.webContents.send('automation:progress', evt);
                  }
                };
                const bridgeStreamCallback = (token) => {
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    resultsWindow.webContents.send('ws-bridge:message', { type: 'chunk', text: token });
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
                    resultsWindow.webContents.send('bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
                  }
                }).catch(err => {
                  console.error(`❌ [Bridge Listener] Error executing block ${block.id}:`, err.message);
                  markBridgeBlockDone(block.id, 'error');
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    resultsWindow.webContents.send('bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
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
        resultsWindow.webContents.send('bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
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
              resultsWindow.webContents.send('bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE });
            }
          } else {
            console.log(`🌉 [Bridge Listener] ${startupPending.length} pending block(s) found at startup — executing`);
          }
          for (const block of startupPending) {
            bridgeSeenIds.add(block.id);
            console.log(`🌉 [Bridge Listener] Startup: executing ${block.prefix}:${block.type} [${block.id}]`);
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              resultsWindow.show();
              resultsWindow.webContents.send('bridge:status', { state: 'executing', blockId: block.id, summary: block.body.split('\n')[0].slice(0, 80), bridgeFile: BRIDGE_FILE });
              resultsWindow.webContents.send('results-window:set-prompt', `[Bridge] ${block.body.split('\n')[0].slice(0, 80)}`);
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
                streamCallback: (token) => { if (resultsWindow && !resultsWindow.isDestroyed()) resultsWindow.webContents.send('ws-bridge:message', { type: 'chunk', text: token }); },
                progressCallback: (evt) => { if (resultsWindow && !resultsWindow.isDestroyed()) resultsWindow.webContents.send('automation:progress', evt); },
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
