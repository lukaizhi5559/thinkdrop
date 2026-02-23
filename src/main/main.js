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

// Singleton StateGraph instance (created once on app ready)
let stateGraph = null;
let mcpClient = null;
let mcpAdapter = null;
let llmBackend = null;
let currentSessionId = null; // Persists across prompts for conversation continuity

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

  // Paused automation state — set when recoverSkill returns ASK_USER, cleared on resume or abort
  let pausedAutomationState = null;

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
          initialState = { message: prompt, selectedText, streamCallback, progressCallback, confirmInstallCallback, context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' } };
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
          const wantsAbort = /\b(abort|cancel|stop)\b/i.test(chosenOption) || /^no$/i.test(chosenOption.trim());
          const wantsSkip = /skip/i.test(chosenOption);
          // "Done, I clicked it" — user confirmed a manual step; advance cursor like skip
          const wantsDone = /\b(done|clicked|confirmed|complete|finished)\b/i.test(chosenOption);
          if (wantsAbort) {
            // User wants to abort — clear state and let it fall through as a fresh prompt
            console.log('[StateGraph] ASK_USER resume: user chose abort — clearing paused state');
            initialState = { message: prompt, selectedText, streamCallback, progressCallback, confirmInstallCallback, context: { sessionId: sessionId || currentSessionId, userId, source: 'thinkdrop_electron' } };
          } else if (wantsSkip || wantsDone) {
            // Skip the failed step / user confirmed manual action — advance cursor and resume plan
            console.log('[StateGraph] ASK_USER resume: user chose skip/done — advancing cursor and resuming plan');
            initialState = {
              ...paused,
              message: paused.message,
              streamCallback,
              progressCallback,
              confirmInstallCallback,
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
        }
      } else {
        initialState = {
          message: prompt,
          selectedText,
          streamCallback,
          progressCallback,
          confirmInstallCallback,
          context: {
            sessionId: sessionId || currentSessionId,
            userId,
            source: 'thinkdrop_electron'
          }
        };
      }

      const finalState = await stateGraph.execute(initialState);

      // Persist resolved session for next prompt
      if (finalState.resolvedSessionId) {
        currentSessionId = finalState.resolvedSessionId;
      }

      // For command_automate, AutomationProgress handles the display via automation:progress events.
      // Only forward pendingQuestion (recoverSkill ASK_USER) since that requires user interaction.
      const intentType = finalState.intent?.type;
      if (intentType === 'command_automate') {
        if (finalState.pendingQuestion?.question) {
          // Persist the full state so the next user reply can resume the paused plan
          pausedAutomationState = finalState;
          console.log('[StateGraph] ASK_USER: pausing automation — next prompt will resume the plan');
          const q = finalState.pendingQuestion;
          // Send a structured ask_user event so the UI can render clickable option buttons
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            resultsWindow.webContents.send('automation:progress', {
              type: 'ask_user',
              question: q.question,
              options: q.options || []
            });
          }
        }
        // Plan error not caught by progressCallback (e.g. no skillPlan at all)
        else if (finalState.planError && !finalState.skillPlan) {
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
      // Always clean up the install:confirm listener to prevent accumulation across runs
      ipcMain.removeListener('install:confirm', handleInstallConfirm);
      pendingInstallResolve = null;
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
    console.log(`[Shell] Opening path: ${filePath}`);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        shell.showItemInFolder(filePath);
      } else {
        const err = await shell.openPath(filePath);
        if (err) {
          console.warn(`[Shell] openPath failed (${err}), falling back to showItemInFolder`);
          shell.showItemInFolder(filePath);
        }
      }
    } catch (e) {
      console.warn(`[Shell] Path not found: ${filePath}`);
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createPromptCaptureWindow();
    createResultsWindow();
    if (resultsWindow) resultsWindow.hide();
  }
});
