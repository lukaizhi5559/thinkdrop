require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require('electron');
const screenshot = require('screenshot-desktop');
const path = require('path');
const WebSocket = require('ws');

// StateGraph integration
const { StateGraphBuilder, RealMCPAdapter, VSCodeLLMBackend } = require('@thinkdrop/stategraph');
const ThinkDropMCPClient = require('./ThinkDropMCPClient');

// Singleton StateGraph instance (created once on app ready)
let stateGraph = null;
let mcpClient = null;
let mcpAdapter = null;
let llmBackend = null;

function initStateGraph() {
  try {
    mcpClient = new ThinkDropMCPClient({ logger: console });
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

// Clipboard monitoring and interaction
let clipboardMonitorActive = false;
let lastClipboardContent = '';
let clipboardCheckInterval = null;
let sentHighlights = new Set();

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
    promptCaptureWindow.webContents.openDevTools({ mode: 'detach' });
    console.log('[PROMPT_CAPTURE] isDestroyed:', promptCaptureWindow.isDestroyed());
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
  });

  resultsWindow.on('closed', () => {
    console.log('Results Window closed.');
    resultsWindow = null;
  });

  return resultsWindow;
}

// Clipboard monitoring functionality
function startClipboardMonitoring(checkInitial = false) {
  if (clipboardMonitorActive) return;
  clipboardMonitorActive = true;
  lastClipboardContent = clipboard.readText();

  // Initial clipboard check on activation to capture any existing content
  // if (checkInitial && lastClipboardContent && lastClipboardContent.length > 0 && !sentHighlights.has(lastClipboardContent)) {
  //   console.log(`[Clipboard Monitor] Initial clipboard content detected: ${lastClipboardContent.substring(0, 100)}...`);
  //   if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
  //     promptCaptureWindow.webContents.send('prompt-capture:add-highlight', lastClipboardContent);
  //     sentHighlights.add(lastClipboardContent);
  //   }
  // }

  console.log('[Clipboard Monitor] Started monitoring for auto-capture highlights.');

  clipboardCheckInterval = setInterval(() => {
    if (!clipboardMonitorActive) {
      clearInterval(clipboardCheckInterval);
      return;
    }

    if (!promptCaptureWindow || !promptCaptureWindow.isVisible()) {
      stopClipboardMonitoring();
      return;
    }

    const currentClipboard = clipboard.readText();
    if (currentClipboard && currentClipboard !== lastClipboardContent && !sentHighlights.has(currentClipboard)) {
      if (!sentHighlights.has(currentClipboard)) {
        console.log(`[Clipboard Monitor] New clipboard content detected: ${currentClipboard.substring(0, 100)}...`);
        promptCaptureWindow.webContents.send('prompt-capture:add-highlight', currentClipboard);
        sentHighlights.add(currentClipboard);
      }
      lastClipboardContent = currentClipboard;
    }

  }, 300);
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

app.whenReady().then(() => {
  createPromptCaptureWindow();
  createResultsWindow();

  // Initialize StateGraph pipeline
  initStateGraph();

  // Connect to VS Code extension (kept for legacy/fallback)
  setTimeout(() => connectToSocket(), 1000);

  // ─── StateGraph: Process prompt through full pipeline ────────────────────
  ipcMain.on('stategraph:process', async (event, { prompt, selectedText = '', sessionId = null, userId = 'default_user' }) => {
    console.log('🧠 [StateGraph] Processing prompt:', prompt.substring(0, 80));

    if (!stateGraph) {
      console.error('❌ [StateGraph] Not initialized');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:error', 'StateGraph not initialized');
      }
      return;
    }

    // Show ResultsWindow and set prompt display
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('results-window:set-prompt', prompt);
    }

    // Stream callback: forward each token to ResultsWindow as it arrives
    const streamCallback = (token) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:message', {
          type: 'chunk',
          text: token
        });
      }
    };

    try {
      const finalState = await stateGraph.execute({
        message: prompt,
        selectedText,
        streamCallback,
        context: {
          sessionId,
          userId,
          source: 'thinkdrop_electron'
        }
      });

      // Signal stream end
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('ws-bridge:message', { type: 'done' });
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

          resultsWindow.show();
          resultsWindow.focus();
          // Notify renderer to re-measure and resize based on current content
          resultsWindow.webContents.send('results-window:show', { position: { x, y } });
          console.log('[Results Window] Shown alongside Prompt Capture Window.');
        }

        startClipboardMonitoring(true);
        console.log('[Prompt Capture] Activated via global shortcut.');
      }
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
      promptCaptureWindow.setSize(width, height);
    }
  });

  ipcMain.on('prompt-capture:move', (event, { x, y }) => {
    if (promptCaptureWindow) {
      promptCaptureWindow.setPosition(x, y);
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
      console.log(` [RESULTS_WINDOW] Resizing window to ${clampedWidth}x${clampedHeight}`);
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
      console.log(` [RESULTS_WINDOW] Window resized to ${clampedWidth}x${clampedHeight}, growing upward from fixed bottom`);
      
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
          resultsWindow.show();
          resultsWindow.focus();
        });
      } else {
        console.log('[Results Window] Content already loaded, showing window immediately.');
        resultsWindow.focus();
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
