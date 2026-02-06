const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require('electron');
const path = require('path');

let promptCaptureWindow = null;
let resultsWindow = null;

// Clipboard monitoring and interaction
let clipboardMonitorActive = false;
let lastClipboardContent = '';
let clipboardCheckInterval = null;
let sentHighlights = new Set();

let testOverlayWindow = null;

function createTestOverlay() {
  if (testOverlayWindow && !testOverlayWindow.isDestroyed()) {
    testOverlayWindow.show();
    testOverlayWindow.focus();
    return testOverlayWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  testOverlayWindow = new BrowserWindow({
    width: 600,
    height: 400,
    x: Math.floor(width / 2 - 300),
    y: Math.floor(height / 2 - 200),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const isDev = process.env.NODE_ENV === 'development';

  // Load the app
  if (isDev) {
    testOverlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=testoverlay`);
  } else {
    testOverlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { mode: 'testoverlay' }
    });
  }

  testOverlayWindow.once('ready-to-show', () => {
    console.log('✅ [TEST_OVERLAY] Window ready to show');
    testOverlayWindow?.show();
    testOverlayWindow?.focus();
  });

  testOverlayWindow.on('closed', () => {
    console.log('🔌 [TEST_OVERLAY] Window closed');
    testOverlayWindow = null;
  });

  console.log('🎨 [TEST_OVERLAY] Window created');
  return testOverlayWindow;
}

function showTestOverlay() {
  if (testOverlayWindow && !testOverlayWindow.isDestroyed()) {
    testOverlayWindow.show();
    testOverlayWindow.focus();
  } else {
    createTestOverlay();
  }
}

function hideTestOverlay() {
  if (testOverlayWindow && !testOverlayWindow.isDestroyed()) {
    testOverlayWindow.hide();
  }
}

function getTestOverlayWindow() {
  return testOverlayWindow;
}

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
    promptCaptureWindow.setAlwaysOnTop(true, 'floating', 4);
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    promptCaptureWindow.loadURL('http://localhost:5173/index.html?mode=promptcapture');
  } else {
    promptCaptureWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'),
  { query: { mode: 'promptcapture' } });
  }

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
  const margin = 20;

  const initialX = screenWidth - windowMinWidth - margin;
  const initialY = screenHeight - windowMinHeight - margin;
  
  resultsWindow = new BrowserWindow({
    x: initialX,
    y: initialY,
    width: windowMinWidth,
    height: windowMinHeight,
    minWidth: windowMinWidth,
    maxWidth: 600,
    minHeight: windowMinHeight,
    maxHeight: windowMaxHeight,
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
    resultsWindow.setWindowButtonVisibility(false);
    resultsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    resultsWindow.setAlwaysOnTop(true, 'floating', 5);
    console.log('[Results Window] Configured for macOS with floating level 5');
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    console.log('Loading Results Window in development mode.');
    resultsWindow.loadURL('http://localhost:5173/index.html?mode=results');
  } else {
    resultsWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'),
    { query: { mode: 'results' } });
  }

  resultsWindow.webContents.on('did-finish-load', () => {
    console.log('Results Window finished loading.');
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

  if (checkInitial && lastClipboardContent && lastClipboardContent.length > 0 && !sentHighlights.has(lastClipboardContent)) {
    console.log(`[Clipboard Monitor] Initial clipboard content detected: ${lastClipboardContent.substring(0, 100)}...`);
    if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
      promptCaptureWindow.webContents.send('prompt-capture:add-highlight', lastClipboardContent);
      sentHighlights.add(lastClipboardContent);
    }
  }

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

  // Test shortcut - Cmd+Shift+T
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    console.log('🔑 [MAIN] Test overlay shortcut triggered');
    showTestOverlay();
  });

  // Add IPC handlers for the test overlay
  ipcMain.on('test-overlay:show', () => {
    console.log('📥 [MAIN] Received test-overlay:show');
    showTestOverlay();
  });

  ipcMain.on('test-overlay:hide', () => {
    console.log('📥 [MAIN] Received test-overlay:hide');
    hideTestOverlay();
  });

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (promptCaptureWindow) {
      if (promptCaptureWindow.isVisible()) {
        promptCaptureWindow.hide();
        if (resultsWindow) resultsWindow.hide();
        stopClipboardMonitoring();
      } else {
        const { x, y } = screen.getCursorScreenPoint();
        promptCaptureWindow.setPosition(x - 250, y - 60);
        promptCaptureWindow.show();
        promptCaptureWindow.focus();
        promptCaptureWindow.webContents.send('prompt-capture:show', { position: { x, y } });

        if (resultsWindow && !resultsWindow.isDestroyed()) {
          const primaryDisplay = screen.getPrimaryDisplay();
          const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
          const windowWidth = 500;
          const windowHeight = 400; 
          const margin = 20;

          resultsWindow.setPosition(screenWidth - windowWidth - margin, screenHeight - windowHeight - margin);
          resultsWindow.setSize(windowWidth, windowHeight);
          resultsWindow.focus();
          resultsWindow.show();
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
    }
  });

  ipcMain.on('results-window:close', () => {
    if (resultsWindow) resultsWindow.hide();
  });

  ipcMain.on('results-window:resize', (event, { width, height }) => {
    if (resultsWindow) {
      resultsWindow.setSize(width, height);
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
      const windowWidth = 500; // Assuming a default width, adjust as needed
      const windowHeight = 400; // Assuming a default height, adjust as needed
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

  // Commented out screenshot functionality for future use
  // ipcMain.handle('capture-screenshot', async () => {
  //   const screenshot = require('screenshot-desktop');
  //   try {
  //     const imgBuffer = await screenshot({ format: 'png' });
  //     return imgBuffer.toString('base64');
  //   } catch (error) {
  //     console.error('Screenshot capture failed:', error);
  //     throw error;
  //   }
  // });
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
  }
});
