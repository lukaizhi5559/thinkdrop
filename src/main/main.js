const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require('electron');
const screenshot = require('screenshot-desktop');
const path = require('path');
const WebSocket = require('ws');

let promptCaptureWindow = null;
let resultsWindow = null;

// VS Code Bridge WebSocket
let vscodeWs = null;
let vscodeConnected = false;

function connectToVSCode() {
  if (vscodeWs && vscodeWs.readyState === WebSocket.OPEN) {
    console.log('[VS Code Bridge] Already connected');
    return;
  }

  console.log('[VS Code Bridge] Connecting to ws://127.0.0.1:17373');
  vscodeWs = new WebSocket('ws://127.0.0.1:17373');

  vscodeWs.on('open', () => {
    console.log('✅ [VS Code Bridge] Connected');
    vscodeConnected = true;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('vscode-bridge:connected');
    }
  });

  vscodeWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[VS Code Bridge] Message received:', message.type);
      
      // Forward all messages to ResultsWindow
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('vscode-bridge:message', message);
      }
    } catch (error) {
      console.error('[VS Code Bridge] Failed to parse message:', error);
    }
  });

  vscodeWs.on('error', (error) => {
    console.error('[VS Code Bridge] Error:', error.message);
    vscodeConnected = false;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('vscode-bridge:error', error.message);
    }
  });

  vscodeWs.on('close', () => {
    console.log('[VS Code Bridge] Disconnected');
    vscodeConnected = false;
    vscodeWs = null;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      resultsWindow.webContents.send('vscode-bridge:disconnected');
    }
    
    // Attempt reconnect after delay
    setTimeout(() => {
      console.log('[VS Code Bridge] Attempting to reconnect...');
      connectToVSCode();
    }, 2000);
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

  // Connect to VS Code extension
  setTimeout(() => connectToVSCode(), 1000);

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

      // If this is a minimal height (100-150px), it's likely a new search - reposition to bottom-right
      // if (clampedHeight <= 150 && (!resultsWindowInitialHeight || resultsWindowInitialHeight > 150)) {
      //   console.log(' [RESULTS_WINDOW] New search detected - repositioning to bottom-right');
      //   const newY = screenHeight - clampedHeight - margin;
      //   const newX = screenWidth - clampedWidth - margin;
      //   resultsWindow.setBounds({
      //   x: newX,
      //   y: newY,
      //   width: clampedWidth,
      //   height: clampedHeight
      //   }, true);
      //   resultsWindowInitialHeight = clampedHeight;
      // } 
      // else {
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
      // }
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
          resultsWindow.show();
          resultsWindow.focus();
        });
      } else {
        console.log('[Results Window] Content already loaded, showing window immediately.');
        resultsWindow.webContents.send('results-window:set-prompt', text);
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
        resultsWindow.webContents.send('vscode-bridge:error', event.returnValue.error);
      }
    }
  });

  // VS Code Bridge IPC handlers
  ipcMain.on('vscode-bridge:send-message', (event, { prompt, selectedText = '' }) => {
    console.log('📥 [MAIN] Received vscode-bridge:send-message IPC event');
    console.log('[VS Code Bridge] Sending message:', prompt.substring(0, 50));
    
    if (!vscodeWs || vscodeWs.readyState !== WebSocket.OPEN) {
      console.error('[VS Code Bridge] Not connected');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('vscode-bridge:error', 'Not connected to VS Code extension');
      }
      // Try to reconnect
      connectToVSCode();
      return;
    }

    const id = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const payload = {
      type: 'ask',
      id,
      prompt,
      selectedText,
      mode: 'general',
    };

    try {
      vscodeWs.send(JSON.stringify(payload));
      console.log('[VS Code Bridge] Message sent with id:', id);
    } catch (error) {
      console.error('[VS Code Bridge] Failed to send message:', error);
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        resultsWindow.webContents.send('vscode-bridge:error', error.message);
      }
    }
  });

  ipcMain.on('vscode-bridge:connect', () => {
    console.log('[VS Code Bridge] Connect requested');
    connectToVSCode();
  });

  ipcMain.handle('vscode-bridge:is-connected', () => {
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
