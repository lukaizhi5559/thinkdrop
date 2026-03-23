// Entry point — ThinkDrop managed
require('dotenv').config();
// Also load command-service .env as a fallback for OAuth credentials and service config.
// Values already set by the root .env take precedence (override: false).
require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', 'mcp-services', 'command-service', '.env'),
  override: false,
});
const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require('electron');

// Enable webkitSpeechRecognition network access — must be called before app is ready.
// Without these flags Electron blocks the connection to Google's speech API,
// causing a 'network' error immediately on recognition.start().
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'http://localhost:5173');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

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

// SSE clients connected to GET /voice/companion/events (Chrome companion windows)
const companionSseClients = new Set();

function broadcastCompanionEvent(eventName, data = {}) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of companionSseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

function startOverlayControlServer() {
  const server = http.createServer((req, res) => {
    // ── CORS — allow Chrome companion window (localhost:5173) to call us ─────
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    // ── GET /voice/companion/events — SSE stream for Chrome companion close signal ──
    if (req.method === 'GET' && req.url === '/voice/companion/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': 'http://localhost:5173',
      });
      res.write(':ok\n\n'); // initial comment to confirm connection
      companionSseClients.add(res);
      req.on('close', () => {
        companionSseClients.delete(res);
        // When the last Chrome tab disconnects (user closed it manually),
        // notify the renderer so VoiceButton can reset its companion state.
        if (companionSseClients.size === 0) {
          if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
            safeSend(promptCaptureWindow, 'voice:companion-closed');
          }
        }
      });
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    // ── GET /voice/status — voice-service reads StateGraph journal status ──────
    if (req.method === 'GET' && req.url === '/voice/status') {
      const state = (() => { try { return voiceJournal.read(); } catch (_) { return {}; } })();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, stategraph: state.stategraph || {}, voice: state.voice || {} }));
      return;
    }

    // ── GET /activity — SkillScheduler checks before firing bridge tasks ───────
    // Returns whether the user is currently active so bridge-type scheduled skills
    // can defer execution rather than interrupting mid-session work.
    if (req.method === 'GET' && req.url === '/activity') {
      const { powerMonitor } = require('electron');
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const stategraphRunning = activeAbortController !== null;
      const active = stategraphRunning || idleSeconds < 30;
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, active, idleSeconds, stategraphRunning }));
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
          const { message, sessionId, source, responseLanguage: injectResponseLanguage = null, voiceOnly = false } = JSON.parse(body || '{}');
          if (!message) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'message is required' }));
            return;
          }
          console.log(`[VoiceInject] Received: "${message.substring(0, 80)}" (source: ${source || 'voice'}, voiceOnly: ${voiceOnly})`);

          // Track voice-inject tasks in the Queue tab so they show as 'running'.
          // We only track voiceOnly=true (background escalations) — non-voiceOnly
          // tasks are visible in the Results window already.
          const _pqId = voiceOnly ? promptQueue.trackExternal(message, { responseLanguage: injectResponseLanguage }) : null;

          if (!stateGraph) {
            if (_pqId) promptQueue.markDone(_pqId, { error: 'StateGraph not initialized' });
            res.writeHead(503);
            res.end(JSON.stringify({ ok: false, error: 'StateGraph not initialized' }));
            return;
          }

          // voiceOnly=true: background escalation from fast lane voice response.
          // Do NOT touch the ResultsWindow — it may be showing something else.
          // Only notify promptCaptureWindow for IPC plumbing (session routing etc).
          if (!voiceOnly) {
            if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
              safeSend(promptCaptureWindow, 'voice:inject-prompt', { message, sessionId, source: source || 'voice' });
            }
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              safeSend(resultsWindow, 'results-window:set-prompt', message);
            }
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
            if (!voiceOnly && resultsWindow && !resultsWindow.isDestroyed()) {
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

          // Mark Queue tab item done
          if (_pqId) promptQueue.markDone(_pqId);

          // Signal stream end to renderer (not for voice-only background escalations)
          if (!voiceOnly && resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
          }

          res.writeHead(200);
          res.end(JSON.stringify({
            ok: true,
            answer,
            intent,
            hadLiveStream: tokens.length > 0,
            commandOutput: finalState.commandOutput || '',
            skillResults: (finalState.skillResults || []).map(r => ({ skill: r.skill, ok: r.ok, stdout: r.stdout, result: r.result, args: r.args, description: r.description })),
          }));
        } catch (err) {
          console.error('[VoiceInject] Error:', err.message);
          voiceJournal.graphError({ intent: 'unknown', error: err.message });
          if (_pqId) promptQueue.markDone(_pqId, { error: err.message });
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
              audioFormat: data.audioFormat || 'wav',
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

    // ── POST /skill.schedule — skillCreator registers a cron entry for a scheduled skill
    if (req.url === '/skill.schedule') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { skillName, schedule, trigger } = JSON.parse(body || '{}');
          const _skipSched = ['on_demand', 'null', 'none', 'false', ''];
          if (skillName && schedule && !_skipSched.includes(schedule)) {
            const cronId = `skill_${skillName.replace(/\./g, '_')}`;
            if (!queueManager.getCron().find(i => i.id === cronId)) {
              queueManager.registerCron({
                id: cronId,
                label: trigger || skillName,
                schedule,
                plistLabel: `com.thinkdrop.skill.${skillName}`,
              });
              console.log(`[Skills] Registered cron via /skill.schedule: ${skillName} @ ${schedule}`);
            }
          }
          res.writeHead(200).end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400).end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── POST /reminder/fire — command-service scheduler fires a one-shot reminder ──
    if (req.url === '/reminder/fire') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, label, triggerIntent, triggerPrompt, pendingSteps, firedAt } = JSON.parse(body || '{}');
          console.log(`🔔 [Reminder] Fired: "${label}" (intent=${triggerIntent}, id=${id})`);

          const reminderText = triggerPrompt || label || 'Reminder';

          if (triggerIntent === 'execute_steps' && pendingSteps) {
            // Execute remaining plan steps directly via command-service — no stategraph re-run.
            // Re-running the original prompt would cause an infinite loop for time-delay reminders.
            try {
              const steps = JSON.parse(pendingSteps);
              const http = require('http');
              steps.forEach(step => {
                const stepPayload = JSON.stringify({ payload: { skill: step.skill, args: step.args || {} } });
                const stepReq = http.request({
                  hostname: '127.0.0.1', port: 3007, path: '/command.automate', method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(stepPayload) },
                  timeout: 30000,
                }, (stepRes) => {
                  let raw = ''; stepRes.on('data', c => { raw += c; });
                  stepRes.on('end', () => console.log(`🔔 [Reminder] pendingStep ${step.skill} → ${stepRes.statusCode}`));
                });
                stepReq.on('error', (e) => console.warn(`🔔 [Reminder] pendingStep execute failed: ${e.message}`));
                stepReq.write(stepPayload);
                stepReq.end();
              });
            } catch (e) {
              console.warn(`🔔 [Reminder] pendingSteps parse/execute error: ${e.message}`);
            }
          }

          // 1. Show a modal dialog popup with ThinkDrop logo
          const { dialog, app, nativeImage } = require('electron');
          const path = require('path');
          const logoPath = path.join(__dirname, '..', 'renderer', 'assets', 'logo.jpg');
          let logoIcon;
          try { logoIcon = nativeImage.createFromPath(logoPath); } catch (_) {}
          dialog.showMessageBox({
            type: 'info',
            title: '⏰ ThinkDrop Reminder',
            message: reminderText,
            buttons: ['OK'],
            defaultId: 0,
            icon: logoIcon || undefined,
          }).catch(() => {});

          // 2. Play the ThinkDrop sound (afplay is reliable even when window is hidden)
          try {
            const { exec } = require('child_process');
            const soundPath = path.join(__dirname, '..', 'renderer', 'assets', 'water-drip.mp3');
            exec(`afplay "${soundPath}"`);
          } catch (_) {}
          // Also try via renderer IPC (may fail if AudioContext is suspended)
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'reminder:play-sound', {});
          }

          // 3. Bring ResultsWindow to front and show reminder
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            if (!resultsWindow.isVisible()) {
              resultsWindow.showInactive();
            }
            resultsWindow.moveTop();
            safeSend(resultsWindow, 'automation:progress', {
              type: 'reminder_fired',
              label,
              triggerIntent,
              triggerPrompt: reminderText,
              firedAt,
              id,
            });
          }

          // 4. Also show macOS notification with logo
          try {
            const { Notification } = require('electron');
            if (Notification.isSupported()) {
              new Notification({
                title: '⏰ ThinkDrop Reminder',
                body: reminderText,
                silent: false,
                icon: logoPath,
              }).show();
            }
          } catch (_) {}

          // 5. Bounce dock icon to grab attention
          try { app.dock?.bounce?.('critical'); } catch (_) {}

          // Refresh Cron tab to remove the fired reminder
          ipcMain.emit('cron:list');

          res.writeHead(200).end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error('[Reminder] Fire handler error:', err.message);
          res.writeHead(500).end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── POST /bridge/confirm — ask user whether to run a deferred bridge skill now ──
    // Called by command-service when a bridge skill fires but user is active.
    // Shows a native Electron dialog: "Run now" vs "Later".
    // "Run now" → forces /skill.fire immediately bypassing activity check.
    // "Later"   → command-service retries again in 10 minutes (up to 3 times).
    if (req.url === '/bridge/confirm') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { skillName, instruction, retryCount } = JSON.parse(body || '{}');
          const label = (instruction || skillName || 'scheduled task').split(' ').slice(0, 8).join(' ');
          const { dialog, nativeImage } = require('electron');
          const path = require('path');
          const logoPath = path.join(__dirname, '..', 'renderer', 'assets', 'logo.jpg');
          let logoIcon;
          try { logoIcon = nativeImage.createFromPath(logoPath); } catch (_) {}
          const attemptsLeft = 3 - (retryCount || 0);
          const deferNote = attemptsLeft > 0 ? `(auto-runs in ~${attemptsLeft * 10} min if you choose Later)` : '(last chance — will run now regardless)';
          const { response } = await dialog.showMessageBox({
            type: 'question',
            title: 'ThinkDrop — Scheduled Task Ready',
            message: `"${label}" is ready to run.`,
            detail: `Run it now, or defer until you're free? ${deferNote}`,
            buttons: ['Run Now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            icon: logoIcon || undefined,
          });
          if (response === 0) {
            // "Run Now" — force-fire via /skill.fire (bypasses activity check)
            const http = require('http');
            const cmdPort = parseInt(process.env.SERVICE_PORT || process.env.COMMAND_SERVICE_PORT || '3007', 10);
            const fireBody = JSON.stringify({ skillName, forced: true });
            const fireReq = http.request({
              hostname: '127.0.0.1', port: cmdPort,
              path: '/skill.fire', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fireBody) },
              timeout: 60000,
            }, (r) => { r.resume(); });
            fireReq.on('error', (e) => console.warn('[BridgeConfirm] force-fire error:', e.message));
            fireReq.write(fireBody);
            fireReq.end();
            console.log(`[BridgeConfirm] User chose Run Now → force-firing ${skillName}`);
            res.writeHead(200).end(JSON.stringify({ ok: true, action: 'run_now' }));
          } else {
            console.log(`[BridgeConfirm] User chose Later → ${skillName} retrying in 10min`);
            res.writeHead(200).end(JSON.stringify({ ok: true, action: 'defer' }));
          }
        } catch (err) {
          console.error('[BridgeConfirm] handler error:', err.message);
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
const promptQueue = require('./promptQueue');

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
let currentLastOpenedFilePath = null; // Persists last opened file path so "close it" knows the target

// Module-level gather:answer resolver — set per-question, cleared on answer.
// Registered ONCE (not per stategraph:process run) to avoid listener accumulation.
let pendingGatherResolve = null;

// Active schedule countdown — set when a schedule step is running, cleared when done/cancelled
// Used to warn the user before closing the app mid-countdown
let activeScheduleCountdown = null; // { id, targetTime, label }

// App control mode — persistent fast-dispatch state (bypasses StateGraph when active)
// { active: bool, app: string|null, enteredAt: ISO }
let appControlMode = { active: false, app: null, enteredAt: null };

// AbortController for the currently running stateGraph.execute — null when idle.
// Hoisted to module scope so GET /activity (startOverlayControlServer) can read it.
let activeAbortController = null;

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
  // Note: setPermissionRequestHandler fires repeatedly as webkitSpeechRecognition
  // restarts its session — intentionally not logging here to avoid log spam.
  promptCaptureWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audiocapture' || permission === 'speech') {
      callback(true);
    } else {
      callback(false);
    }
  });
  promptCaptureWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audiocapture' || permission === 'speech') return true;
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

  // ── Scheduled skill cron registration on startup ─────────────────────────
  // Fetch all installed skills from user-memory MCP and register any with a
  // non-on_demand schedule into the cron tab so they appear in the UI.
  // Runs 10 seconds after app ready (after queueManager.init has been called).
  setTimeout(async () => {
    try {
      const http = require('http');
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);

      const _memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
      function _mcpPost(apiPath, action, payload) {
        return new Promise((resolve) => {
          const b = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action, payload, requestId: 'boot-' + Date.now() });
          const req = http.request({
            hostname: '127.0.0.1', port: memPort, path: apiPath, method: 'POST',
            headers: {
              'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b),
              ...(_memApiKey ? { 'Authorization': `Bearer ${_memApiKey}` } : {}),
            },
            timeout: 6000,
          }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(_) { resolve(null); } });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.write(b); req.end();
        });
      }

      const listRes = await _mcpPost('/skill.list', 'skill.list', {});
      const listRows = listRes?.data?.results || listRes?.result?.results || [];

      for (const row of (listRows || [])) {
        const skillName = row.name || '';
        if (!skillName) continue;
        // Fetch full skill to get contract_md
        const getRes = await _mcpPost('/skill.get', 'skill.get', { name: skillName });
        const full = getRes?.data || null;
        const cm = full?.contractMd || '';
        const fmMatch = cm.match(/^---\s*\n([\s\S]*?)\n---/);
        const fm = fmMatch ? fmMatch[1] : '';
        const scheduleMatch = fm.match(/^schedule\s*:\s*(.+)$/m);
        const triggerMatch  = fm.match(/^trigger\s*:\s*(.+)$/m);
        const rawSched = scheduleMatch ? scheduleMatch[1].trim() : 'on_demand';
        // Skip any falsy or placeholder schedule — 'null'/'false'/'none'/'on_demand' all mean no cron
        const SKIP_SCHEDULES = ['on_demand', 'null', 'none', 'false', ''];
        if (!rawSched || SKIP_SCHEDULES.includes(rawSched)) continue;
        const schedule = rawSched;
        const cronId = `skill_${skillName.replace(/\./g, '_')}`;
        if (queueManager.getCron().find(i => i.id === cronId)) continue;
        const trigger = triggerMatch ? triggerMatch[1].trim() : skillName;
        queueManager.registerCron({ id: cronId, label: trigger, schedule, plistLabel: `com.thinkdrop.skill.${skillName}` });
        console.log(`[SkillCron] Registered cron for: ${skillName} @ ${schedule}`);
      }
    } catch (err) {
      console.warn(`[SkillCron] Startup cron registration failed: ${err.message}`);
    }
  }, 10000);

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

  // ─── Prompt Queue: init (serial stategraph runner) ────────────────────────
  promptQueue.init({
    broadcast: (items) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'prompt-queue:update', items);
      }
    },
    runPrompt: (item) => {
      // Called by promptQueue when it's time to execute an item.
      // Delegates to the shared stategraph runner below.
      runPromptThroughStateGraph(item.prompt, {
        selectedText: item.selectedText || '',
        responseLanguage: item.responseLanguage || null,
        promptQueueId: item.id,
      });
    },
    alertRestart: (items, countdownMs) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'prompt-queue:restart-alert', { items, countdownMs });
      }
    },
  });

  // ─── Prompt Queue IPC handlers ────────────────────────────────────────────

  ipcMain.on('prompt-queue:submit', (_event, { prompt, selectedText = '', responseLanguage = null } = {}) => {
    if (!prompt?.trim()) return;
    const id = promptQueue.enqueue(prompt.trim(), { selectedText, responseLanguage });
    console.log(`[PromptQueue] IPC prompt-queue:submit → enqueued id=${id}`);
  });

  ipcMain.on('prompt-queue:cancel', (_event, { id } = {}) => {
    if (!id) return;
    promptQueue.cancel(id);
  });

  ipcMain.on('prompt-queue:dismiss-alert', () => {
    promptQueue.dismissRestartAlert();
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'prompt-queue:restart-cancel', {});
    }
  });

  // ─── Queue IPC handlers ───────────────────────────────────────────────────

  ipcMain.on('queue:submit', (_event, { prompt, name } = {}) => {
    if (!prompt?.trim()) return;
    console.log(`[Queue] submit: "${prompt.slice(0, 80)}"`);
    queueManager.submitToCreator(prompt, { name }).catch((err) => {
      console.error('[Queue] submitToCreator error:', err.message);
    });
  });

  ipcMain.on('queue:rerun', (_event, { id }) => {
    console.log(`[Queue] Rerun requested: ${id}`);
    const item = queueManager.getQueue().find(i => i.id === id);
    if (!item) return;
    queueManager.removeQueueItem(id);
    queueManager.submitToCreator(item.prompt, { name: item.projectName }).catch((err) => {
      console.error('[Queue] rerun submitToCreator error:', err.message);
    });
  });

  ipcMain.on('queue:cancel', (_event, { id }) => {
    console.log(`[Queue] Cancel requested: ${id}`);
    queueManager.cancelCreator(id);
  });

  // ─── Cron IPC handlers ────────────────────────────────────────────────────
  ipcMain.on('cron:toggle', async (_event, { id }) => {
    console.log(`[Cron] Toggle: ${id}`);
    // Toggle local pause state (id === skillName from cron:list)
    const wasPaused = _pausedCrons.has(id);
    if (wasPaused) { _pausedCrons.delete(id); } else { _pausedCrons.add(id); }
    const newStatus = wasPaused ? 'active' : 'paused';
    const action    = wasPaused ? 'resume' : 'pause';
    // Push updated status to renderer immediately — no need to re-fetch full list
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      ipcMain.emit('cron:list');
    }
    // Tell command-service scheduler to pause/resume
    const cmdPort = parseInt(process.env.SERVICE_PORT || process.env.COMMAND_SERVICE_PORT || '3007', 10);
    const body = JSON.stringify({ skillName: id, action });
    const req = require('http').request({
      hostname: '127.0.0.1', port: cmdPort,
      path: '/skill.schedule/toggle', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, res => { res.resume(); });
    req.on('error', () => {}); // non-fatal
    req.write(body); req.end();
    console.log(`[Cron] ${id} → ${newStatus}`);
  });

  ipcMain.on('cron:delete', (_event, { id }) => {
    console.log(`[Cron] Delete: ${id}`);
    queueManager.removeCron(id);
  });

  // cron:run-now handled below (real HTTP dispatch to command-service)

  // ─── Skill schedule registration (called by skillCreator after writing skill) ──
  // Accepts HTTP POST from command-service: { skillName, schedule, trigger }
  // schedule is a cron expression like "0 21 * * *"
  ipcMain.on('skill:schedule-register', (_event, { skillName, schedule, trigger } = {}) => {
    const _SKIP = ['on_demand', 'null', 'none', 'false', ''];
    if (!skillName || !schedule || _SKIP.includes(schedule)) return;
    const cronId = `skill_${skillName.replace(/\./g, '_')}`;
    // Avoid duplicate registration
    if (queueManager.getCron().find(i => i.id === cronId)) return;
    const label = `${trigger || skillName} (daily)`;
    queueManager.registerCron({ id: cronId, label, schedule, plistLabel: `com.thinkdrop.skill.${skillName}` });
    console.log(`[Skills] Registered cron for skill: ${skillName} @ ${schedule}`);
  });

  // Paused automation state — set when recoverSkill returns ASK_USER, cleared on resume or abort
  let pausedAutomationState = null;
  let pausedSkillBuildState = null; // set when installSkill pauses for ASK_USER (secrets)
  // activeAbortController is declared at module scope (above startOverlayControlServer)
  // so GET /activity can read it to detect an in-progress stategraph run.

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

  // voice:companion-open — open Chrome companion window
  ipcMain.on('voice:companion-open', () => {
    console.log('🎙️ [Companion] Opening Chrome companion window');
    const { shell } = require('electron');
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    const companionUrl = isDev
      ? 'http://localhost:5173?mode=voice-companion'
      : `file://${path.join(__dirname, '../../dist-renderer/index.html')}?mode=voice-companion`;
    shell.openExternal(companionUrl).catch(err => console.warn('[Companion] openExternal failed:', err));
  });

  // voice:companion-close — send SSE close event so Chrome tab closes itself
  ipcMain.on('voice:companion-close', () => {
    console.log('🎙️ [Companion] Broadcasting close to companion windows');
    broadcastCompanionEvent('close');
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

      // KWS wake-word detected — open session in renderer, skip full pipeline
      if (result.wakeActivated) {
        console.log(`🎙️ [Voice] Wake activated (${result.keyword}) — signalling renderer to open session`);
        safeSend(promptCaptureWindow, 'voice:wake-activated', { keyword: result.keyword });
        voiceJournal.setVoiceStatus('idle');
        _voiceChunkActive = Math.max(0, _voiceChunkActive - 1);
        return;
      }

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
            audioFormat: result.audioFormat || 'wav',
            language: result.detectedLanguage,
            lane: result.lane,
            durationEstimateMs: result.durationEstimateMs || null,
            triggered: !!(result.triggered),
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
          skipTTS: false,   // renderer handles TTS via speechSynthesis — skip Cartesia
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
            audioFormat: result.audioFormat || 'wav',
            language: result.detectedLanguage,
            lane: result.lane,
            durationEstimateMs: result.durationEstimateMs || null,
            triggered: !!(result.triggered),
          });
      } else if ((result.responseFinal || result.responseEnglish) && !result.skipped) {
        // Text-only (skipTTS) — send without audio so renderer uses speechSynthesis
        safeSend(promptCaptureWindow, 'voice:response', {
            text: result.responseFinal || result.responseEnglish || '',
            fullAnswer: result.fullAnswer || '',
            audioBase64: '',
            audioFormat: '',
            language: result.detectedLanguage,
            lane: result.lane || 'fast',
            durationEstimateMs: null,
            triggered: !!(result.triggered),
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

  // ─── gather:answer — registered ONCE (not per stategraph:process run) ────
  ipcMain.on('gather:answer', (_event, { answer }) => {
    console.log(`[GatherContext] IPC received: gather:answer — "${(answer || '').slice(0, 60)}"`);
    if (pendingGatherResolve) {
      const resolve = pendingGatherResolve;
      pendingGatherResolve = null;
      if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'gather:pending', { active: false });
      }
      resolve(answer || '');
    } else {
      console.warn('[GatherContext] Received gather:answer but no pending resolve — ignoring');
    }
  });

  // ─── StateGraph: Route prompt through the serial prompt queue ────────────
  // All stategraph:process calls now go through the prompt queue so prompts
  // are serialized (printer-queue model). The queue calls runPromptThroughStateGraph
  // when a slot opens up.
  ipcMain.on('stategraph:process', (_event, { prompt, selectedText = '', sessionId = null, responseLanguage = null } = {}) => {
    if (!prompt?.trim()) return;
    console.log('🧠 [StateGraph] Enqueuing prompt via prompt-queue:', prompt.substring(0, 80));
    promptQueue.enqueue(prompt.trim(), { selectedText: selectedText || '', responseLanguage: responseLanguage || null });
  });

  // ─── StateGraph: Core execution — called by promptQueue serially ─────────
  async function runPromptThroughStateGraph(prompt, { selectedText = '', sessionId = null, userId = 'default_user', responseLanguage = null, promptQueueId = null } = {}) {
    console.log('🧠 [StateGraph] Processing prompt:', prompt.substring(0, 80), responseLanguage ? `(responseLanguage: ${responseLanguage})` : '');

    // Track this prompt so clipboard monitor won't re-capture it as a highlight
    recentlySubmittedPrompts.add(prompt.trim());
    setTimeout(() => recentlySubmittedPrompts.delete(prompt.trim()), 60000);

    // ── App Control Mode fast-dispatch (pre-StateGraph) ──────────────────────
    // When control mode is active, route short commands directly to nut-js
    // without going through the full StateGraph pipeline.
    if (appControlMode.active) {
      const handled = await _dispatchControlCommand(prompt.trim(), { responseLanguage, promptQueueId });
      if (handled) return;
      // If not a recognized control command, fall through to normal StateGraph
    }

    if (!stateGraph) {
      console.error('❌ [StateGraph] Not initialized');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'ws-bridge:error', 'StateGraph not initialized');
      }
      if (promptQueueId) promptQueue.markDone(promptQueueId, { error: 'StateGraph not initialized' });
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

    // Per-invocation flag: fire queue:started + queue:enqueued only once per stategraph run
    let _queueNotifiedOnce = false;

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
      // Forward all automation:progress events (including 'planning') to ResultsWindow.
      // Results tab owns inline automation display — do NOT auto-switch to Queue tab.
      if (event.type === 'planning' && !_queueNotifiedOnce) {
        _queueNotifiedOnce = true;
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'queue:started', {});
        }
      }
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', event);
      } else if (!resultsWindow || resultsWindow.isDestroyed()) {
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

    // ── gatherContext callbacks ────────────────────────────────────────────────
    // gatherAnswerCallback: waits for user to type/speak an answer in StandalonePromptCapture.
    // NOTE: the actual ipcMain.on('gather:answer') listener is registered ONCE at module level
    // (see below) — NOT here per-run, to avoid MaxListenersExceeded accumulation.
    const gatherAnswerCallback = () => {
      return new Promise((resolve) => {
        pendingGatherResolve = resolve;
        console.log('[GatherContext] Waiting for user answer…');
        // Tell prompt bar to intercept next submit as gather:answer
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'gather:pending', { active: true });
        }
        // 10-minute timeout
        setTimeout(() => {
          if (pendingGatherResolve === resolve) {
            console.warn('[GatherContext] Timed out waiting for answer — skipping question');
            pendingGatherResolve = null;
            if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
              safeSend(promptCaptureWindow, 'gather:pending', { active: false });
            }
            resolve(null);
          }
        }, 10 * 60 * 1000);
      });
    };

    // gatherCredentialCallback: prompts the user for a sensitive value, stores it in keytar,
    // and resolves with { stored: true }. The actual secret never touches state.
    const gatherCredentialCallback = (credentialKey) => {
      return new Promise((resolve) => {
        // Emit credential prompt to Queue tab via progressCallback
        // The UI shows a CLI-style masked input — user submits via gather:credential IPC
        let pendingCredResolve = resolve;
        const handleCredSubmit = async (_event, { key, value }) => {
          if (key !== credentialKey) return; // not our credential
          ipcMain.off('gather:credential', handleCredSubmit);
          if (!value) { pendingCredResolve({ stored: false }); return; }
          try {
            const keytar = require('keytar');
            await keytar.setPassword('thinkdrop', credentialKey, value);
            console.log(`[GatherContext] Stored credential: ${credentialKey}`);
            pendingCredResolve({ stored: true });
          } catch (e) {
            console.error(`[GatherContext] keytar store failed for ${credentialKey}:`, e.message);
            pendingCredResolve({ stored: false, error: e.message });
          }
        };
        ipcMain.on('gather:credential', handleCredSubmit);
        // 10-minute timeout
        setTimeout(() => {
          ipcMain.off('gather:credential', handleCredSubmit);
          if (pendingCredResolve) {
            pendingCredResolve({ stored: false });
            pendingCredResolve = null;
          }
        }, 10 * 60 * 1000);
      });
    };

    // keytarCheckCallback: checks if a credential already exists in keytar
    const keytarCheckCallback = async (credentialKey) => {
      try {
        const keytar = require('keytar');
        const value = await keytar.getPassword('thinkdrop', credentialKey);
        return { found: !!value };
      } catch (_) {
        return { found: false };
      }
    };

    // gatherOAuthCallback: triggered by gather_oauth progress event in Queue tab.
    // The UI sends gather:oauth_connect IPC → this callback delegates to the same
    // OAuth flow used by the Skills tab Connect button (skills:oauth-connect).
    // Resolves with { connected: true } when keytar has the token, or { connected: false }
    // if skipped or timed out.
    const gatherOAuthCallback = (provider, tokenKey) => {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          ipcMain.off('gather:oauth_connect', handleConnect);
          ipcMain.off('gather:oauth_skip',    handleSkip);
          resolve(result);
        };

        const handleConnect = async (_event, { provider: p, tokenKey: tk, scopes, skillName }) => {
          if (p !== provider) return; // not our provider
          console.log(`[GatherOAuth] OAuth connect requested for ${p}, delegating to skills:oauth-connect`);
          // Delegate to the existing OAuth flow — it handles everything including keytar storage
          ipcMain.emit('skills:oauth-connect', null, { skillName: skillName || p, provider: p, tokenKey: tk, scopes });
          // Poll keytar until the token appears (the OAuth flow stores it asynchronously)
          const kt = (() => { try { return require('keytar'); } catch(_) { return null; } })();
          if (!kt) { settle({ connected: false }); return; }
          let attempts = 0;
          const poll = setInterval(async () => {
            attempts++;
            try {
              const val = await kt.getPassword('thinkdrop', tk);
              if (val) {
                clearInterval(poll);
                console.log(`[GatherOAuth] Token stored for ${p} at ${tk}`);
                // Emit the connected event back to the UI via progressCallback
                progressCallback({ type: 'gather_oauth_connected', provider: p, tokenKey: tk });
                settle({ connected: true });
              }
            } catch (_) {}
            if (attempts >= 120) { // 2 min max poll (120 × 1000ms)
              clearInterval(poll);
              settle({ connected: false });
            }
          }, 1000);
        };

        const handleSkip = (_event, { provider: p }) => {
          if (p !== provider) return;
          settle({ connected: false });
        };

        ipcMain.on('gather:oauth_connect', handleConnect);
        ipcMain.on('gather:oauth_skip',    handleSkip);

        // 10-minute hard timeout
        setTimeout(() => settle({ connected: false }), 10 * 60 * 1000);
      });
    };

    try {
      // If there's a paused automation waiting for user input, resume it
      let initialState;
      if (pausedAutomationState) {
        const paused = pausedAutomationState;
        const userReply = prompt.trim().toLowerCase();

        // ── Part A: TTL expiry ────────────────────────────────────────────────
        // If the paused state is older than 90 seconds the user has clearly moved on.
        // Skip any semantic check — it's always a fresh task.
        const PAUSED_TTL_MS = 90_000;
        const pausedAge = paused._pausedAt ? (Date.now() - paused._pausedAt) : Infinity;
        const isExpired = pausedAge > PAUSED_TTL_MS;

        // ── Part C: Semantic check via voice-service embedding classifier ─────
        // Compare new prompt against the paused question text using cosine similarity.
        // Falls back to regex heuristic if voice-service is unavailable.
        let isFreshPrompt = isExpired;
        if (!isFreshPrompt) {
          try {
            const http = require('http');
            const classifyResult = await new Promise((resolve, reject) => {
              const body = JSON.stringify({
                payload: {
                  prompt: prompt.trim(),
                  pausedQuestion: paused.pendingQuestion?.question || paused.message || ''
                }
              });
              const req = http.request(
                { hostname: '127.0.0.1', port: 3006, path: '/voice.classify', method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
                (res) => {
                  let data = '';
                  res.on('data', d => { data += d; });
                  res.on('end', () => {
                    try { resolve(JSON.parse(data)?.data || {}); } catch (_) { resolve({}); }
                  });
                }
              );
              req.on('error', reject);
              req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')); });
              req.write(body);
              req.end();
            });
            if (typeof classifyResult.isFreshTask === 'boolean') {
              isFreshPrompt = classifyResult.isFreshTask;
              console.log(`[StateGraph] ASK_USER resume: semantic check → isFreshTask=${isFreshPrompt} similarity=${classifyResult.similarity?.toFixed(3)} isAction=${classifyResult.isActionCommand} age=${Math.round(pausedAge/1000)}s`);
            } else {
              throw new Error('no isFreshTask in response');
            }
          } catch (classifyErr) {
            // Voice-service unavailable — fall back to regex heuristic
            console.log(`[StateGraph] ASK_USER resume: semantic check unavailable (${classifyErr.message}), using regex fallback`);
            isFreshPrompt = (
              /\b(what have i been|what did i|what was i|summarize|recap|history|last hour|last \d+ min)\b/i.test(prompt) ||
              /^(send|open|search|find|create|delete|move|copy|download|install|run|start|stop|quit|close|show|list|check|get|set|go to|goto|navigate|nav|book|buy|schedule|remind|pull up|look up|browse|visit|take me|switch to|jump to)\b/i.test(prompt.trim())
            );
          }
        }

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
              // For "walk me through" use guide prefix so LLM knows to use guide.step.
              // For "do it / together / automate" send the original task only — no prefix —
              // so the LLM plans skill.bootstrap autonomously without seeing "guide me".
              const wantsManualGuide = /walk me through/i.test(chosenOption);
              const guideMessage = wantsManualGuide ? `Walk me through step by step: ${originalMsg}` : originalMsg;
              console.log(`[StateGraph] Guide offer accepted: "${chosenOption}" (${wantsManualGuide ? 'manual guide' : 'autonomous'}) — re-entering as command_automate for: "${originalMsg}"`);
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
          // "Install [X] skill" / "Create and install [X] skill" — user asked to install or
          // build a missing skill. Inject a targeted skill.install plan WITHOUT replanning
          // the full original task. Extract the skill name from the pending question context
          // (failedStep) or from the reply itself.
          const installSkillMatch = /(?:create\s+and\s+install|install(?:ing)?)\s+(?:the\s+)?['"]?([a-z0-9._-]+)['"]?\s+skill/i.exec(chosenOption)
            || /^install\s+skill$/i.exec(chosenOption)
            || /install\s+texting\s+tool/i.exec(chosenOption)
            || /^create\s+and\s+install\s+this\s+skill$/i.exec(chosenOption);
          const wantsInstallSkill = !!installSkillMatch
            || /^install\s+(skill|texting|sms|text)/i.test(chosenOption.trim())
            || /^create\s+and\s+install/i.test(chosenOption.trim());
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
          } else if (paused.pendingQuestion?._isScoutSelect) {
            // ── Scout provider select: user picked a CLI/API provider from the Scout card ──
            // Re-enter at gatherContext with forceSkillBuild=true and gatheredContext pre-set
            // so creatorPlanning fast-path picks it up immediately (no Q&A loop needed).
            const scoutMatches = paused.pendingQuestion?.context?.scoutMatches || paused.scoutMatches || [];
            const scoutCapability = paused.pendingQuestion?.context?.capability || paused.scoutCapability || '';

            // Map user reply to the chosen match (either "provider (type)" format or index)
            let chosenMatch = scoutMatches[0]; // default: first match
            const replyLower = chosenOption.toLowerCase().replace(/\s*\([^)]+\)/, '').trim();
            const byName = scoutMatches.find(m => m.provider.toLowerCase() === replyLower);
            const byIdx = parseInt(userReply, 10) - 1;
            if (byName) chosenMatch = byName;
            else if (!isNaN(byIdx) && byIdx >= 0 && byIdx < scoutMatches.length) chosenMatch = scoutMatches[byIdx];

            console.log(`[StateGraph] Scout select: "${chosenOption}" → provider "${chosenMatch?.provider}" (${chosenMatch?.type}) for "${scoutCapability}"`);

            const isCli = chosenMatch?.type === 'cli';
            const gatheredContext = {
              services: [chosenMatch?.provider || scoutCapability],
              timezone: null,
              schedule: null,
              knownSecrets: [],
              links: chosenMatch?.config?.links || [],
              resolvedAnswers: {},
              cliMatch: isCli ? { capability: chosenMatch.capability, provider: chosenMatch.provider, config: chosenMatch.config } : null,
              apiMatch: !isCli ? { capability: chosenMatch.capability, provider: chosenMatch.provider, config: chosenMatch.config } : null,
            };

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
              scoutPending: false,
              // Inject gathered context so creatorPlanning uses the chosen provider
              gatheredContext,
              forceSkillBuild: true,
              gatherContextSkipped: false,
              skillPlan: null,
              skillCursor: 0,
              stepRetryCount: 0,
              commandExecuted: false,
              context: { ...paused.context, sessionId: sessionId || currentSessionId }
            };
          } else if (wantsInstallSkill) {
            // User chose to install a missing skill — inject a targeted skill.install plan
            // WITHOUT replanning the full original task. After install, resume from the
            // failed external.skill step so the original plan continues automatically.
            const failedSkillName = paused.failedStep?.skill === 'external.skill'
              ? (paused.failedStep?.args?.name || paused.pendingQuestion?.context?.args?.name || null)
              : null;
            // For needs_skill steps: derive dot-notation skill name from capability arg
            const needsSkillCapability = paused.failedStep?.skill === 'needs_skill'
              ? (paused.failedStep?.args?.name || paused.failedStep?.args?.capability || null)
              : null;
            const needsSkillDotName = needsSkillCapability
              ? needsSkillCapability.toLowerCase().trim()
                  .replace(/[^a-z0-9\s]/g, '')      // strip non-alphanum
                  .replace(/\s+/g, '.')             // spaces → dots
                  .replace(/\.{2,}/g, '.')          // collapse double-dots
                  .replace(/^\.|\.$/, '')            // trim leading/trailing dots
                  .split('.').slice(0, 3).join('.')  // max 3 parts
              : null;
            // Try to extract skill name from the reply text (e.g. "Install 'send.text' skill")
            // but skip generic captures like 'this', 'a', 'the', 'my'
            const rawReplyMatch = installSkillMatch?.[1] || null;
            const GENERIC_WORDS = ['this', 'a', 'the', 'my', 'new', 'it', 'that'];
            const replySkillName = (rawReplyMatch && !GENERIC_WORDS.includes(rawReplyMatch.toLowerCase())) ? rawReplyMatch : null;
            const targetSkillName = failedSkillName || replySkillName || needsSkillDotName || 'unknown.skill';
            console.log(`[StateGraph] ASK_USER resume: install skill "${targetSkillName}" — injecting skill.install plan`);
            const installPlan = [{
              skill: 'skill.install',
              args: {
                skillPath: `${require('os').homedir()}/.thinkdrop/skills/${targetSkillName}/skill.md`,
                name: targetSkillName,
                description: `${targetSkillName} skill`,
              },
              description: `Install skill: ${targetSkillName}`,
            }];
            // Store original plan so executeCommand can splice it back in after install
            const originalPlan = Array.isArray(paused.skillPlan) ? paused.skillPlan : [];
            const originalCursor = paused.skillCursor || 0;
            // Build combined plan: [skill.install, ...remaining original steps from cursor onwards]
            const remainingOriginalSteps = originalPlan.slice(originalCursor);
            const combinedPlan = [...installPlan, ...remainingOriginalSteps];
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
              recoveryContext: null,
              answer: undefined,
              commandExecuted: false,
              // Combined plan: install first, then resume remaining original steps
              skillPlan: combinedPlan,
              skillCursor: 0,
              stepRetryCount: 0,
              // resumeFromLogin=true tells planSkills to skip LLM replanning and use the injected plan
              resumeFromLogin: true,
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
            // (isFreshPrompt already handled the "new task typed as reply" case above)
            // Use chosenOption (the user's explicit instruction) as the new message so that
            // parseIntent classifies the USER'S instruction, not the original failed task.
            // This prevents "Open Spotify" → browser automation override → same failed plan loop.
            console.log('[StateGraph] ASK_USER resume: user provided answer — replanning with context');
            initialState = {
              ...paused,
              message: chosenOption,
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
        // ── queueBridge: drives Queue tab phase transitions from creatorPlanning ──
        // Only create a real queueManager entry when the prompt is NOT already tracked
        // by promptQueue (promptQueueId set) — otherwise we get a double Queue tab entry.
        let queueBridge;
        if (promptQueueId) {
          // Prompt already visible in Queue tab via PromptQueueSection — use no-op bridge
          queueBridge = { setPhase: () => {} };
        } else {
          const _queueItemId = queueManager.enqueue(prompt);
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'queue:update', queueManager.getQueue());
          }
          queueBridge = {
            setPhase: (_id, status, extra = {}) => {
              queueManager.setQueueStatus(_queueItemId, status, extra);
            },
          };
        }

        initialState = {
          message: prompt,
          selectedText,
          streamCallback,
          progressCallback,
          confirmInstallCallback,
          confirmGuideCallback,
          isGuideCancelled,
          gatherAnswerCallback,
          gatherCredentialCallback,
          keytarCheckCallback,
          gatherOAuthCallback,
          queueBridge,
          activeBrowserSessionId: currentBrowserSessionId || null,
          activeBrowserUrl: currentBrowserUrl || null,
          lastOpenedFilePath: currentLastOpenedFilePath || null,
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

      // Persist last opened file path so "close it" / "close the file" always targets the right file.
      if (finalState.lastOpenedFilePath) {
        currentLastOpenedFilePath = finalState.lastOpenedFilePath;
        console.log(`[StateGraph] Persisted lastOpenedFilePath: ${currentLastOpenedFilePath}`);
      }

      // Sync app control mode — appControl node writes finalState.appControlMode
      if (finalState.appControlMode !== undefined) {
        const prev = appControlMode.active;
        appControlMode = finalState.appControlMode;
        if (appControlMode.active && !prev) {
          console.log(`[AppControl] Entered control mode${appControlMode.app ? ` for "${appControlMode.app}"` : ''}`);
          safeSend(promptCaptureWindow, 'app-control:mode-change', { active: true, app: appControlMode.app });
          safeSend(resultsWindow, 'app-control:mode-change', { active: true, app: appControlMode.app });
        } else if (!appControlMode.active && prev) {
          console.log('[AppControl] Exited control mode');
          safeSend(promptCaptureWindow, 'app-control:mode-change', { active: false, app: null });
          safeSend(resultsWindow, 'app-control:mode-change', { active: false, app: null });
        }
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
          pausedAutomationState = { ...finalState, _pausedAt: Date.now() };
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
          pausedAutomationState = { ...finalState, _pausedAt: Date.now() };
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
          // Auto-refresh Skills + Cron tabs whenever a creator skill was just built
          if (finalState.creatorSkillName) {
            ipcMain.emit('skills:list');
            ipcMain.emit('cron:list');
          }
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
      // Mark prompt queue item done so the next pending prompt can start
      if (promptQueueId) {
        promptQueue.markDone(promptQueueId);
      }
    }
  }

  // ─── App Control Mode: heuristic fast-dispatch ───────────────────────────
  // Called BEFORE StateGraph when appControlMode.active is true.
  // Returns true if the command was handled (don't run StateGraph).
  // Returns false if the command should fall through to normal processing.
  async function _dispatchControlCommand(text, { responseLanguage, promptQueueId } = {}) {
    const lower = text.toLowerCase().trim();

    // Exit phrases — deactivate control mode immediately
    const EXIT_RE = /^(stop|exit|quit|done controlling|end control|leave control|control mode off|deactivate|disable control)\b/i;
    if (EXIT_RE.test(lower)) {
      const prevApp = appControlMode.app;
      appControlMode = { active: false, app: null, enteredAt: null };
      console.log('[AppControl] Fast-exit control mode');
      safeSend(promptCaptureWindow, 'app-control:mode-change', { active: false, app: null });
      safeSend(resultsWindow, 'app-control:mode-change', { active: false, app: null });
      const msg = `Control mode deactivated${prevApp ? ` (was: ${prevApp})` : ''}.`;
      safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: msg });
      safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
      if (promptQueueId) promptQueue.markDone(promptQueueId);
      return true;
    }

    // Scroll commands — also catches bare "scroll" (= down), "up", "down" in control mode context
    const BARE_SCROLL = /^(scroll|up|down)$/i;
    const SCROLL_RE = /\b(scroll\s+down|scroll\s+up|page\s+down|page\s+up|scroll\s+to\s+top|scroll\s+to\s+bottom)\b/i;
    const scrollMatch = BARE_SCROLL.exec(lower) || lower.match(SCROLL_RE);
    if (scrollMatch) {
      try {
        const { keyboard, Key } = require('@nut-tree-fork/nut-js');
        const cmd = scrollMatch[0].trim().toLowerCase();
        if (cmd === 'scroll down' || cmd === 'page down' || cmd === 'down' || cmd === 'scroll') {
          await keyboard.pressKey(Key.PageDown);
          await keyboard.releaseKey(Key.PageDown);
        } else if (cmd === 'scroll up' || cmd === 'page up' || cmd === 'up') {
          await keyboard.pressKey(Key.PageUp);
          await keyboard.releaseKey(Key.PageUp);
        } else if (cmd === 'scroll to top') {
          await keyboard.pressKey(Key.LeftSuper, Key.Up);
          await keyboard.releaseKey(Key.LeftSuper, Key.Up);
        } else if (cmd === 'scroll to bottom') {
          await keyboard.pressKey(Key.LeftSuper, Key.Down);
          await keyboard.releaseKey(Key.LeftSuper, Key.Down);
        }
        console.log(`[AppControl] Dispatched scroll: ${cmd}`);
        safeSend(resultsWindow, 'app-control:command-ack', { command: cmd });
        if (promptQueueId) promptQueue.markDone(promptQueueId);
        return true;
      } catch (e) {
        console.error('[AppControl] nut-js scroll error:', e.message);
        return false;
      }
    }

    // Type text commands: "type hello", "type 'hello world'"
    const TYPE_RE = /^type\s+(?:["'](.+?)["']|(.+))$/i;
    const typeMatch = lower.match(TYPE_RE);
    if (typeMatch) {
      try {
        const { keyboard } = require('@nut-tree-fork/nut-js');
        const toType = typeMatch[1] || typeMatch[2];
        await keyboard.type(toType);
        console.log(`[AppControl] Dispatched type: "${toType}"`);
        safeSend(resultsWindow, 'app-control:command-ack', { command: `type: "${toType}"` });
        if (promptQueueId) promptQueue.markDone(promptQueueId);
        return true;
      } catch (e) {
        console.error('[AppControl] nut-js type error:', e.message);
        return false;
      }
    }

    // Press key commands: "press enter", "press cmd+c", "press escape"
    const PRESS_RE = /^press\s+(.+)$/i;
    const pressMatch = text.match(PRESS_RE);
    if (pressMatch) {
      try {
        const { keyboard, Key } = require('@nut-tree-fork/nut-js');
        const keyStr = pressMatch[1].trim();
        const KEY_MAP = {
          enter: Key.Enter, return: Key.Enter, escape: Key.Escape, esc: Key.Escape,
          tab: Key.Tab, space: Key.Space, backspace: Key.Backspace, delete: Key.Delete,
          up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
          'cmd+c': [Key.LeftSuper, Key.C], 'cmd+v': [Key.LeftSuper, Key.V],
          'cmd+z': [Key.LeftSuper, Key.Z], 'cmd+a': [Key.LeftSuper, Key.A],
          'cmd+s': [Key.LeftSuper, Key.S], 'cmd+w': [Key.LeftSuper, Key.W],
          'ctrl+c': [Key.LeftControl, Key.C], 'ctrl+v': [Key.LeftControl, Key.V],
        };
        const mapped = KEY_MAP[keyStr.toLowerCase()];
        if (mapped) {
          if (Array.isArray(mapped)) {
            await keyboard.pressKey(...mapped);
            await keyboard.releaseKey(...mapped);
          } else {
            await keyboard.pressKey(mapped);
            await keyboard.releaseKey(mapped);
          }
          console.log(`[AppControl] Dispatched key: ${keyStr}`);
          safeSend(resultsWindow, 'app-control:command-ack', { command: `press: ${keyStr}` });
          if (promptQueueId) promptQueue.markDone(promptQueueId);
          return true;
        }
      } catch (e) {
        console.error('[AppControl] nut-js key error:', e.message);
        return false;
      }
    }

    // ── Catch-all: control mode is active but command is unrecognized ─────────
    // Do NOT fall through to StateGraph — that causes planSkills/project_build.
    // Instead: reply with an in-mode help nudge and swallow the prompt.
    console.log(`[AppControl] Unrecognized control command (swallowed): "${text}"`);
    const helpMsg = `⚠ Unknown control command: "${text}"\nTry: scroll up/down, type <text>, press <key>, or say **stop** to exit.`;
    safeSend(resultsWindow, 'ws-bridge:message', { type: 'chunk', text: helpMsg });
    safeSend(resultsWindow, 'ws-bridge:message', { type: 'done' });
    if (promptQueueId) promptQueue.markDone(promptQueueId);
    return true;
  }

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (promptCaptureWindow) {
      if (promptCaptureWindow.isVisible()) {
        promptCaptureWindow.hide();
        if (resultsWindow) resultsWindow.hide();
        stopClipboardMonitoring();
      } else {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        
        // Position prompt capture at center-bottom of screen
        const pcBounds = promptCaptureWindow.getBounds();
        const pcWidth = pcBounds.width || 500;
        const pcX = Math.round((screenWidth - pcWidth) / 2);
        const pcY = screenHeight - 140;
        promptCaptureWindow.setPosition(pcX, pcY);
        promptCaptureWindow.show();
        promptCaptureWindow.focus();
        safeSend(promptCaptureWindow, 'prompt-capture:show', { position: { x: pcX, y: pcY } });

        // Position results window in bottom-right corner
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          const margin = 20;
          let newX;
          let newY;
          
          // If we have a tracked content height, reuse it; otherwise default to 300
          if (resultsWindowInitialHeight && resultsWindowInitialHeight > 0) {
            // Preserve existing content-based size, just re-show at correct position
            const currentBounds = resultsWindow.getBounds();
            const windowWidth = currentBounds.width || 400;
            const windowHeight = currentBounds.height || 300;
            newX = screenWidth - windowWidth - margin;
            newY = screenHeight - windowHeight - margin;
            console.log(`📐 [Results Window] Re-showing with existing size ${windowWidth}x${windowHeight} at (${newX}, ${newY})`);
            resultsWindow.setBounds({ x: newX, y: newY, width: windowWidth, height: windowHeight });
          } else {
            // First time or no content yet — use default size
            const windowWidth = 400;
            const windowHeight = 300;
            newX = screenWidth - windowWidth - margin;
            newY = screenHeight - windowHeight - margin;
            console.log(`📐 [Results Window] Initial show ${windowWidth}x${windowHeight} at (${newX}, ${newY})`);
            resultsWindow.setBounds({ x: newX, y: newY, width: windowWidth, height: windowHeight });
          }

          resultsWindow.showInactive();
          // Notify renderer to re-measure and resize based on current content
          safeSend(resultsWindow, 'results-window:show', { position: { x: newX, y: newY } });
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
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        // Position prompt capture at center-bottom of screen
        const pcBounds2 = promptCaptureWindow.getBounds();
        const pcWidth2 = pcBounds2.width || 500;
        const pcX2 = Math.round((screenWidth - pcWidth2) / 2);
        const pcY2 = screenHeight - 140;
        promptCaptureWindow.setPosition(pcX2, pcY2);
        promptCaptureWindow.show();
        promptCaptureWindow.focus();
        safeSend(promptCaptureWindow, 'prompt-capture:show', { position: { x: pcX2, y: pcY2 } });

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

  // ─── Skills: list / save-secret / open-code ───────────────────────────────
  ipcMain.on('skills:list', async () => {
    try {
      const http = require('http');
      const fsMod = require('fs');
      const osMod = require('os');
      const pathMod = require('path');
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
      const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
      const authHeaders = memApiKey ? { 'Authorization': `Bearer ${memApiKey}` } : {};

      const body = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.list', payload: {}, requestId: 'skills-list-' + Date.now() });
      const listRows = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: memPort,
          path: '/skill.list', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...authHeaders },
          timeout: 6000,
        }, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              const list = parsed?.data?.results || parsed?.result?.results || parsed?.data || [];
              resolve(Array.isArray(list) ? list : []);
            } catch(_) { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.write(body); req.end();
      });

      // Fetch full contract_md per skill via skill.get (list omits contract_md for perf)
      function skillGet(name) {
        return new Promise((resolve) => {
          const gb = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.get', payload: { name }, requestId: 'sg-' + Date.now() });
          const req = http.request({
            hostname: '127.0.0.1', port: memPort,
            path: '/skill.get', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(gb), ...authHeaders },
            timeout: 4000,
          }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
              try { resolve(JSON.parse(raw)?.data || null); } catch(_) { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.write(gb); req.end();
        });
      }

      // Fallback: scan ~/.thinkdrop/skills/ for creator-built skills not yet in user-memory
      function scanLocalSkills() {
        const skillsDir = pathMod.join(osMod.homedir(), '.thinkdrop', 'skills');
        if (!fsMod.existsSync(skillsDir)) return [];
        const dirs = fsMod.readdirSync(skillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory());
        return dirs.map(d => {
          const skillDir = pathMod.join(skillsDir, d.name);
          const cjsPath  = pathMod.join(skillDir, 'index.cjs');
          const cliJson  = pathMod.join(skillDir, 'cli.json');
          const apiJson  = pathMod.join(skillDir, 'api.json');
          const skillMd  = pathMod.join(skillDir, 'skill.md');

          if (fsMod.existsSync(cjsPath)) {
            // Standard code-gen skill
            return { name: d.name, execPath: cjsPath, source: 'local' };
          } else if (fsMod.existsSync(skillMd) && (fsMod.existsSync(cliJson) || fsMod.existsSync(apiJson))) {
            // CLI/API Scout skill — has skill.md + cli.json/api.json but no index.cjs yet
            let description = '';
            let secretKeys = [];
            let schedule = 'on_demand';
            try {
              const md = fsMod.readFileSync(skillMd, 'utf8');
              const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
              const fm = fmMatch ? fmMatch[1] : '';
              const schedM = fm.match(/^schedule\s*:\s*(.+)$/m);
              if (schedM) schedule = schedM[1].trim();
              // Parse secrets block (YAML list)
              const secretsBlockMatch = fm.match(/^secrets\s*:\s*\n((?:\s+-\s+\S+\s*\n?)+)/m);
              if (secretsBlockMatch) {
                secretKeys = secretsBlockMatch[1].split('\n')
                  .map(l => l.replace(/^\s*-\s*/, '').trim())
                  .filter(Boolean);
              }
              // Inline secrets: secrets: KEY1, KEY2  or  secrets: [KEY1, KEY2]
              const secretsInlineMatch = fm.match(/^secrets\s*:\s*([^\n]+)$/m);
              if (secretsInlineMatch && !secretsBlockMatch) {
                const raw = secretsInlineMatch[1].replace(/^\[|\]$/g, ''); // strip YAML brackets
                secretKeys = raw.split(/[\s,]+/).map(s => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
              }
              // Description from first body line after frontmatter
              const body = md.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
              const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
              if (firstLine) description = firstLine.trim().slice(0, 200);
            } catch(_) {}
            const descriptorPath = fsMod.existsSync(cliJson) ? cliJson : apiJson;
            return { name: d.name, execPath: descriptorPath, source: 'local_scout', description, secretKeys, schedule };
          }
          return null;
        }).filter(Boolean);
      }

      const keytar = (() => { try { return require('keytar'); } catch(_) { return null; } })();

      // Merge user-memory rows with local fallback (local wins if name not in memory)
      const memNames = new Set((listRows || []).map(r => r.name));
      const localRows = scanLocalSkills().filter(r => !memNames.has(r.name));
      const allRows = [...(listRows || []), ...localRows];

      const items = await Promise.all(allRows.map(async (row) => {
        const isScout = row.source === 'local_scout';
        const full = (row.source === 'local' || isScout) ? null : await skillGet(row.name);
        const cm = full?.contractMd || '';
        const fmMatch = cm.match(/^---\s*\n([\s\S]*?)\n---/);
        const fm = fmMatch ? fmMatch[1] : '';
        const triggerMatch  = fm.match(/^trigger\s*:\s*(.+)$/m);
        const scheduleMatch = fm.match(/^schedule\s*:\s*(.+)$/m);
        const oauthMatch       = fm.match(/^oauth\s*:\s*(.+)$/m);
        const oauthScopesMatch = fm.match(/^oauth_scopes\s*:\s*(.+)$/m);
        const trigger  = triggerMatch  ? triggerMatch[1].trim()  : (row.name || '');
        // Scout skills have pre-parsed schedule/secrets from skill.md
        const rawSchedule = isScout ? (row.schedule || 'on_demand')
                       : scheduleMatch ? scheduleMatch[1].trim() : 'on_demand';
        // Normalize: null/false/empty → on_demand (no schedule)
        const schedule = (!rawSchedule || rawSchedule === 'null' || rawSchedule === 'false' || rawSchedule === 'none') ? 'on_demand' : rawSchedule;
        let secretKeys = isScout ? (row.secretKeys || []) : [];
        if (!isScout) {
          // Block list format:  secrets:\n  - KEY1\n  - KEY2
          const secretsBlockMatch = fm.match(/^secrets\s*:\s*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/m);
          if (secretsBlockMatch) {
            secretKeys = secretsBlockMatch[1].split('\n')
              .map(l => l.replace(/^[ \t]+-[ \t]+/, '').trim())
              .filter(Boolean);
          } else {
            // Inline format:  secrets: KEY1, KEY2  or  secrets: [KEY1, KEY2]
            const secretsInlineMatch = fm.match(/^secrets\s*:\s*([^\n]+)$/m);
            if (secretsInlineMatch) {
              const raw = secretsInlineMatch[1].replace(/^\[|\]$/g, ''); // strip YAML brackets
              secretKeys = raw.split(/[\s,]+/).map(s => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
            }
          }
        }
        // Parse oauth: field — comma-separated providers e.g. "google" or "google, github"
        let oauthProviders = [];
        if (oauthMatch) {
          oauthProviders = oauthMatch[1].split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        }
        // Parse oauth_scopes: field — JSON object or "provider:scope1 scope2, provider2:scope3"
        // e.g.  oauth_scopes: google=https://www.googleapis.com/auth/calendar, slack=chat:write
        const skillOauthScopes = {};
        if (oauthScopesMatch) {
          for (const part of oauthScopesMatch[1].split(',')) {
            const eq = part.indexOf('=');
            if (eq !== -1) {
              const p = part.slice(0, eq).trim().toLowerCase();
              const s = part.slice(eq + 1).trim();
              if (p && s) skillOauthScopes[p] = s;
            }
          }
        }

        // Extract description from contractMd body (after frontmatter) or row.description
        let description = full?.description || row.description || '';
        if (!description && cm) {
          const bodyAfterFm = cm.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
          const firstLine = bodyAfterFm.split('\n').find(l => l.trim() && !l.startsWith('#'));
          if (firstLine) description = firstLine.trim().slice(0, 200);
        }

        // Filter out OAuth client credentials — those come from .env, not user input
        // Also filter secrets covered by an OAuth provider already declared in the contract:
        //   github  → GH_TOKEN, GITHUB_TOKEN, GITHUB_ACCESS_TOKEN
        //   microsoft/outlook → OUTLOOK_*, MICROSOFT_TOKEN, MS_TOKEN, MSGRAPH_TOKEN
        //   google  → GOOGLE_TOKEN, GCLOUD_TOKEN
        //   slack   → SLACK_TOKEN, SLACK_BOT_TOKEN
        //   notion  → NOTION_TOKEN
        const OAUTH_SECRET_PATTERNS = {
          github:    /^(GH_TOKEN|GITHUB_TOKEN|GITHUB_ACCESS_TOKEN|GITHUB_PAT)$/i,
          microsoft: /^(OUTLOOK_|MICROSOFT_TOKEN|MS_TOKEN|MSGRAPH_TOKEN)/i,
          google:    /^(GOOGLE_TOKEN|GCLOUD_TOKEN|GOOGLE_ACCESS_TOKEN)/i,
          slack:     /^(SLACK_TOKEN|SLACK_BOT_TOKEN|SLACK_ACCESS_TOKEN)/i,
          notion:    /^(NOTION_TOKEN|NOTION_ACCESS_TOKEN)/i,
        };
        const USER_SECRET_KEYS = secretKeys.filter(k => {
          if (/(CLIENT_ID|CLIENT_SECRET|REDIRECT_URI)$/i.test(k)) return false;
          // Suppress secrets covered by a declared OAuth provider
          for (const [provider, pattern] of Object.entries(OAUTH_SECRET_PATTERNS)) {
            if (oauthProviders.includes(provider) && pattern.test(k)) return false;
          }
          return true;
        });

        // Pre-pass: auto-populate skill secrets from global OAuth token
        if (keytar && oauthProviders.length > 0) {
          for (const prov of oauthProviders) {
            const gRaw = await keytar.getPassword('thinkdrop', `oauth:${prov}`).catch(() => null);
            if (!gRaw) continue;
            let gTok; try { gTok = JSON.parse(gRaw); } catch(_) { continue; }
            const provUpper = prov.toUpperCase();
            for (const sec of secretKeys) {
              const sKey = `skill:${row.name}:${sec}`;
              if (await keytar.getPassword('thinkdrop', sKey).catch(() => null)) continue;
              const sl = sec.toLowerCase();
              let av = null;
              if (sl === 'refresh_token' && gTok.refresh_token) av = gTok.refresh_token;
              else if (sl === 'access_token' && gTok.access_token) av = gTok.access_token;
              else if (sl === 'client_id') av = process.env[`${provUpper}_CLIENT_ID`] || (prov === 'google' ? process.env.GOOGLE_CLOUD_CLIENT_ID : null);
              else if (sl === 'client_secret') av = process.env[`${provUpper}_CLIENT_SECRET`] || (prov === 'google' ? process.env.GOOGLE_CLOUD_CLIENT_SECRET : null);
              if (av) { await keytar.setPassword('thinkdrop', sKey, av); console.log(`[Skills] Auto-populated ${sKey} from global oauth:${prov}`); }
            }
          }
        }

        const secrets = await Promise.all(USER_SECRET_KEYS.map(async (key) => {
          let stored = false;
          let preview = undefined;
          if (keytar) {
            try {
              const prefixedKey = `skill:${row.name}:${key}`;
              let val = await keytar.getPassword('thinkdrop', prefixedKey);
              if (!val) {
                // Check bare key fallback — auto-migrate to prefixed if found
                const bareVal = await keytar.getPassword('thinkdrop', key);
                if (bareVal) {
                  await keytar.setPassword('thinkdrop', prefixedKey, bareVal);
                  console.log(`[Skills] Auto-migrated bare key "${key}" → "${prefixedKey}"`);
                  val = bareVal;
                }
              }
              stored = !!val;
              if (val && val.length >= 4) preview = val.slice(0, 8);
            } catch(_) {}
          }
          return { key, stored, preview };
        }));

        // Check OAuth token status per provider
        // Broad identity-level defaults — NOT scope-restricted to any single product.
        // Skills that need specific scopes should declare oauth_scopes: in their contract frontmatter.
        // e.g.  oauth_scopes: google=https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar
        const OAUTH_SCOPE_DEFAULTS = {
          google:     'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
          github:     'read:user user:email',
          microsoft:  'openid profile email offline_access',
          facebook:   'email public_profile',
          twitter:    'tweet.read users.read offline.access',
          linkedin:   'openid profile email',
          slack:      'openid profile email',
          notion:     '',
          spotify:    'user-read-email user-read-private',
          dropbox:    'account_info.read',
          discord:    'identify email',
          zoom:       'user:read',
          atlassian:  'read:me offline_access',
          salesforce: 'openid profile email',
          hubspot:    'crm.objects.contacts.read',
        };
        const oauthConnections = await Promise.all(oauthProviders.map(async (provider) => {
          const perSkillKey = `oauth:${provider}:${row.name}`;
          const globalKey   = `oauth:${provider}`;
          let connected = false;
          let accountHint;
          let usedGlobal = false;
          let tokenData = null;
          if (keytar) {
            try {
              // Check per-skill token first, then fall back to global Connections token
              let raw = await keytar.getPassword('thinkdrop', perSkillKey);
              if (!raw) {
                raw = await keytar.getPassword('thinkdrop', globalKey);
                if (raw) usedGlobal = true;
              }
              if (raw) {
                connected = true;
                try {
                  tokenData = JSON.parse(raw);
                  accountHint = tokenData.email || tokenData.account || undefined;
                } catch(_) {}
              }
            } catch(_) {}

            // Auto-populate already handled in pre-pass above
          }
          const tokenKey = usedGlobal ? globalKey : perSkillKey;
          // Use skill-declared scopes if present, otherwise broad identity defaults
          const scopes = skillOauthScopes[provider] || OAUTH_SCOPE_DEFAULTS[provider] || '';
          return { provider, connected, tokenKey, scopes, accountHint, usedGlobal };
        }));

        const missingCount = secrets.filter(s => !s.stored).length;
        const unconnectedOAuth = oauthConnections.filter(c => !c.connected).length;
        // Differentiate: missing API secrets vs OAuth not yet connected
        const status = missingCount > 0 ? 'missing_secrets'
                     : unconnectedOAuth > 0 ? 'needs_auth'
                     : 'ok';
        return {
          name:             row.name || '',
          filePath:         row.execPath || full?.execPath || '',
          trigger,
          schedule,
          description:      description || undefined,
          secrets,
          oauthConnections: oauthConnections.length > 0 ? oauthConnections : undefined,
          status,
        };
      }));
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skills:update', items);
    } catch (e) {
      console.error('[Skills] skills:list failed:', e.message);
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skills:update', []);
    }
  });

  ipcMain.on('skills:refresh', () => {
    ipcMain.emit('skills:list');
  });

  ipcMain.on('skills:save-secret', async (_event, { skillName, key, value }) => {
    try {
      const keytar = require('keytar');
      // Always store under skill:<name>:<key> so external.skill can find it
      const keytarKey = `skill:${skillName}:${key}`;
      await keytar.setPassword('thinkdrop', keytarKey, value);
      console.log(`[Skills] Stored secret ${keytarKey}`);
      // Refresh skills list so stored badges update
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        ipcMain.emit('skills:list');
      }
    } catch (e) {
      console.error('[Skills] skills:save-secret failed:', e.message);
    }
  });

  ipcMain.on('skills:reveal-secret', async (event, { skillName, key }) => {
    try {
      const keytar = require('keytar');
      const val = (await keytar.getPassword('thinkdrop', `skill:${skillName}:${key}`)) ||
                  (await keytar.getPassword('thinkdrop', key));
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'skills:secret-revealed', { skillName, key, value: val || '' });
      }
    } catch (e) {
      console.error('[Skills] skills:reveal-secret failed:', e.message);
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'skills:secret-revealed', { skillName, key, value: '' });
      }
    }
  });

  ipcMain.on('skills:delete', async (_event, { skillName }) => {
    try {
      const fsMod   = require('fs');
      const pathMod = require('path');
      const osMod   = require('os');
      const http    = require('http');
      let keytar; try { keytar = require('keytar'); } catch(_) {}

      // 1. Delete skill file from ~/.thinkdrop/skills/<name>/
      const skillDir = pathMod.join(osMod.homedir(), '.thinkdrop', 'skills', skillName);
      if (fsMod.existsSync(skillDir)) {
        fsMod.rmSync(skillDir, { recursive: true, force: true });
        console.log(`[Skills] Deleted skill dir: ${skillDir}`);
      }

      // 2. Remove from user-memory MCP (route: POST /skill.remove)
      const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || 'k7F9qLp3XzR2vH8sT1mN4bC0yW6uJ5eQG4tY9bH2wQ6nM1vS8xR3cL5pZ0kF7uDe';
      const delBody = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.remove', payload: { name: skillName }, requestId: 'delete-' + Date.now() });
      await new Promise(resolve => {
        const req = http.request({
          hostname: '127.0.0.1', port: parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10),
          path: '/skill.remove', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memApiKey}`, 'Content-Length': Buffer.byteLength(delBody) },
        }, res => {
          let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => {
            try { const r = JSON.parse(raw); if (!r?.data?.deleted) console.warn(`[Skills] skill.remove unexpected response: ${raw.slice(0, 200)}`); } catch (_) {}
            resolve();
          });
        });
        req.on('error', (e) => { console.error(`[Skills] skill.remove HTTP error: ${e.message}`); resolve(); });
        req.write(delBody); req.end();
      });
      console.log(`[Skills] Removed skill from user-memory: ${skillName}`);

      // 3. Remove from cron — both queueManager (UI) and command-service scheduler
      const cronId = `skill_${skillName.replace(/\./g, '_')}`;
      queueManager.removeCron(cronId);
      // Tell command-service's skill-scheduler to stop the node-cron job immediately (awaited)
      const cmdPort = parseInt(process.env.SERVICE_PORT || process.env.COMMAND_SERVICE_PORT || '3007', 10);
      const unschedBody = JSON.stringify({ skillName });
      await new Promise(resolve => {
        const unschedReq = require('http').request({
          hostname: '127.0.0.1', port: cmdPort,
          path: '/skill.unschedule', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(unschedBody) },
          timeout: 5000,
        }, res => { res.resume(); resolve(); });
        unschedReq.on('error', () => resolve());
        unschedReq.on('timeout', () => { unschedReq.destroy(); resolve(); });
        unschedReq.write(unschedBody);
        unschedReq.end();
      });

      // 4. Clean up keytar secrets for this skill
      try {
        const kt = require('keytar');
        const allCreds = await kt.findCredentials('thinkdrop');
        const prefix = `skill:${skillName}:`;
        await Promise.all(allCreds
          .filter(c => c.account.startsWith(prefix) || c.account.startsWith(`oauth:`) && c.account.endsWith(`:${skillName}`))
          .map(c => kt.deletePassword('thinkdrop', c.account).catch(() => {})));
      } catch (_) {}

      // 5. Remove any pending bridge.md blocks for this skill (prevents re-firing on restart)
      try {
        const bridgeFilePath = require('path').join(require('os').homedir(), '.thinkdrop', 'bridge.md');
        if (require('fs').existsSync(bridgeFilePath)) {
          let bridgeContent = require('fs').readFileSync(bridgeFilePath, 'utf8');
          // Block IDs are: sched_<skillName_dots_replaced_with_underscores>_<timestamp>
          const idPrefix = `sched_${skillName.replace(/\./g, '_')}_`;
          const safePrefix = idPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const blockRe = new RegExp(
            `\\n?<!--\\s*[A-Z][A-Z0-9_]*:[\\w]+ id=["']?${safePrefix}[\\d]+["']?[^>]*-->[\\s\\S]*?<!--\\s*[A-Z][A-Z0-9_]*:END\\s*-->\\n?`,
            'g'
          );
          const cleaned = bridgeContent.replace(blockRe, '');
          if (cleaned !== bridgeContent) {
            require('fs').writeFileSync(bridgeFilePath, cleaned, 'utf8');
            console.log(`[Skills] Removed bridge.md blocks for skill: ${skillName}`);
          }
        }
      } catch (bridgeErr) {
        console.error(`[Skills] Failed to clean bridge.md for ${skillName}:`, bridgeErr.message);
      }

      console.log(`[Skills] Deleted skill: ${skillName}`);
      // Refresh both tabs
      ipcMain.emit('skills:list');
      ipcMain.emit('cron:list');
    } catch (e) {
      console.error('[Skills] skills:delete failed:', e.message);
    }
  });

  ipcMain.on('skills:open-code', (_event, { filePath }) => {
    const { shell } = require('electron');
    shell.openPath(filePath).catch(e => console.error('[Skills] open-code failed:', e.message));
  });

  // ─── Skills: OAuth connect flow ───────────────────────────────────────────
  // Opens a BrowserWindow to the provider auth URL, captures the redirect code,
  // exchanges it for tokens, stores the token JSON in keytar under tokenKey.
  ipcMain.on('skills:oauth-connect', async (_event, { skillName, provider, tokenKey, scopes }) => {
    const { BrowserWindow: OWin } = require('electron');
    const https = require('https');
    const http  = require('http');
    const crypto = require('crypto');
    const keytar = (() => { try { return require('keytar'); } catch(_) { return null; } })();

    // ── Per-provider OAuth config ──────────────────────────────────────────
    // redirectPort range: 9742-9759 (one unique port per provider)
    const OAUTH_CONFIG = {
      google: {
        authBase:     'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl:     'https://oauth2.googleapis.com/token',
        defaultScope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
        redirectPort: 9742,
        clientIdKey:  `skill:${skillName}:GOOGLE_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:GOOGLE_CLIENT_SECRET`,
      },
      github: {
        authBase:     'https://github.com/login/oauth/authorize',
        tokenUrl:     'https://github.com/login/oauth/access_token',
        defaultScope: 'repo user',
        redirectPort: 9743,
        clientIdKey:  `skill:${skillName}:GITHUB_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:GITHUB_CLIENT_SECRET`,
      },
      microsoft: {
        authBase:     'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl:     'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        defaultScope: 'Mail.Read offline_access',
        redirectPort: 9744,
        clientIdKey:  `skill:${skillName}:MICROSOFT_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:MICROSOFT_CLIENT_SECRET`,
      },
      facebook: {
        authBase:     'https://www.facebook.com/v19.0/dialog/oauth',
        tokenUrl:     'https://graph.facebook.com/v19.0/oauth/access_token',
        defaultScope: 'email public_profile',
        redirectPort: 9745,
        clientIdKey:  `skill:${skillName}:FACEBOOK_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:FACEBOOK_CLIENT_SECRET`,
      },
      twitter: {
        authBase:     'https://twitter.com/i/oauth2/authorize',
        tokenUrl:     'https://api.twitter.com/2/oauth2/token',
        defaultScope: 'tweet.read users.read offline.access',
        redirectPort: 9746,
        clientIdKey:  `skill:${skillName}:TWITTER_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:TWITTER_CLIENT_SECRET`,
        pkce: true, // Twitter OAuth2 requires PKCE
      },
      linkedin: {
        authBase:     'https://www.linkedin.com/oauth/v2/authorization',
        tokenUrl:     'https://www.linkedin.com/oauth/v2/accessToken',
        defaultScope: 'openid profile email',
        redirectPort: 9747,
        clientIdKey:  `skill:${skillName}:LINKEDIN_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:LINKEDIN_CLIENT_SECRET`,
      },
      slack: {
        authBase:     'https://slack.com/oauth/v2/authorize',
        tokenUrl:     'https://slack.com/api/oauth.v2.access',
        defaultScope: 'channels:read chat:write users:read',
        redirectPort: 9748,
        clientIdKey:  `skill:${skillName}:SLACK_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:SLACK_CLIENT_SECRET`,
      },
      notion: {
        authBase:     'https://api.notion.com/v1/oauth/authorize',
        tokenUrl:     'https://api.notion.com/v1/oauth/token',
        defaultScope: '',
        redirectPort: 9749,
        clientIdKey:  `skill:${skillName}:NOTION_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:NOTION_CLIENT_SECRET`,
        basicAuth: true, // Notion token exchange uses HTTP Basic auth
      },
      spotify: {
        authBase:     'https://accounts.spotify.com/authorize',
        tokenUrl:     'https://accounts.spotify.com/api/token',
        defaultScope: 'user-read-email user-read-private playlist-read-private',
        redirectPort: 9750,
        clientIdKey:  `skill:${skillName}:SPOTIFY_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:SPOTIFY_CLIENT_SECRET`,
      },
      dropbox: {
        authBase:     'https://www.dropbox.com/oauth2/authorize',
        tokenUrl:     'https://api.dropboxapi.com/oauth2/token',
        defaultScope: 'account_info.read files.content.read',
        redirectPort: 9751,
        clientIdKey:  `skill:${skillName}:DROPBOX_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:DROPBOX_CLIENT_SECRET`,
      },
      discord: {
        authBase:     'https://discord.com/api/oauth2/authorize',
        tokenUrl:     'https://discord.com/api/oauth2/token',
        defaultScope: 'identify email guilds',
        redirectPort: 9752,
        clientIdKey:  `skill:${skillName}:DISCORD_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:DISCORD_CLIENT_SECRET`,
      },
      zoom: {
        authBase:     'https://zoom.us/oauth/authorize',
        tokenUrl:     'https://zoom.us/oauth/token',
        defaultScope: 'meeting:read user:read',
        redirectPort: 9753,
        clientIdKey:  `skill:${skillName}:ZOOM_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:ZOOM_CLIENT_SECRET`,
        basicAuth: true, // Zoom token exchange uses HTTP Basic auth
      },
      atlassian: {
        authBase:     'https://auth.atlassian.com/authorize',
        tokenUrl:     'https://auth.atlassian.com/oauth/token',
        defaultScope: 'read:jira-work write:jira-work read:jira-user offline_access',
        redirectPort: 9754,
        clientIdKey:  `skill:${skillName}:ATLASSIAN_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:ATLASSIAN_CLIENT_SECRET`,
      },
      salesforce: {
        authBase:     'https://login.salesforce.com/services/oauth2/authorize',
        tokenUrl:     'https://login.salesforce.com/services/oauth2/token',
        defaultScope: 'api refresh_token',
        redirectPort: 9755,
        clientIdKey:  `skill:${skillName}:SALESFORCE_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:SALESFORCE_CLIENT_SECRET`,
      },
      hubspot: {
        authBase:     'https://app.hubspot.com/oauth/authorize',
        tokenUrl:     'https://api.hubapi.com/oauth/v1/token',
        defaultScope: 'crm.objects.contacts.read crm.objects.contacts.write',
        redirectPort: 9756,
        clientIdKey:  `skill:${skillName}:HUBSPOT_CLIENT_ID`,
        clientSecretKey: `skill:${skillName}:HUBSPOT_CLIENT_SECRET`,
      },
    };

    const cfg = OAUTH_CONFIG[provider];
    if (!cfg) {
      console.error(`[OAuth] Unknown provider: ${provider}`);
      return;
    }

    // Read client_id + client_secret from process.env (set by ThinkDrop in .env)
    // Supports both naming conventions:
    //   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  (root .env)
    //   GOOGLE_CLOUD_CLIENT_ID / GOOGLE_CLOUD_CLIENT_SECRET  (command-service .env)
    const providerUpper = provider.toUpperCase();
    let clientId     = process.env[`${providerUpper}_CLIENT_ID`]
                    || (provider === 'google' ? process.env.GOOGLE_CLOUD_CLIENT_ID : undefined);
    let clientSecret = process.env[`${providerUpper}_CLIENT_SECRET`]
                    || (provider === 'google' ? process.env.GOOGLE_CLOUD_CLIENT_SECRET : undefined);

    // Fallback: check keytar in case user stored them manually earlier
    if ((!clientId || !clientSecret) && keytar) {
      clientId     = clientId     || await keytar.getPassword('thinkdrop', cfg.clientIdKey).catch(() => null);
      clientSecret = clientSecret || await keytar.getPassword('thinkdrop', cfg.clientSecretKey).catch(() => null);
    }

    if (!clientId || !clientSecret) {
      const { dialog, shell } = require('electron');
      const CONSOLE_URLS = {
        github:    'https://github.com/settings/developers',
        google:    'https://console.cloud.google.com/apis/credentials',
        microsoft: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        facebook:  'https://developers.facebook.com/apps/',
        twitter:   'https://developer.twitter.com/en/portal/dashboard',
        linkedin:  'https://www.linkedin.com/developers/apps',
        slack:     'https://api.slack.com/apps',
        notion:    'https://www.notion.so/my-integrations',
        spotify:   'https://developer.spotify.com/dashboard',
        dropbox:   'https://www.dropbox.com/developers/apps',
        discord:   'https://discord.com/developers/applications',
        zoom:      'https://marketplace.zoom.us/develop/create',
        atlassian: 'https://developer.atlassian.com/console/myapps/',
        salesforce:'https://login.salesforce.com/setup/secur/RemoteAccessList.apexp',
        hubspot:   'https://app.hubspot.com/developer/apps',
      };
      const redirectUriPreview = `http://localhost:${cfg.redirectPort}/oauth/callback`;
      const consoleUrl = CONSOLE_URLS[provider];
      const { response } = await dialog.showMessageBox(resultsWindow, {
        type: 'info',
        title: `${provider} OAuth Setup`,
        message: `To enable ${provider} OAuth, add these to your ThinkDrop .env file:\n\n  ${providerUpper}_CLIENT_ID=your_client_id\n  ${providerUpper}_CLIENT_SECRET=your_client_secret\n\nIn your ${provider} app settings, add this redirect URI:\n  ${redirectUriPreview}\n\nThen restart ThinkDrop.`,
        buttons: consoleUrl ? ['Open Developer Console', 'Close'] : ['OK'],
      });
      if (consoleUrl && response === 0) {
        shell.openExternal(consoleUrl);
      }
      return;
    }

    const redirectPort = cfg.redirectPort;
    // Google Desktop/installed app clients use http://localhost:PORT (no path)
    // Web app clients use http://localhost:PORT/oauth/callback
    // We detect installed vs web by checking GOOGLE_OAUTH_TYPE env or defaulting to installed
    const isGoogleInstalled = provider === 'google' && process.env.GOOGLE_OAUTH_TYPE !== 'web';
    const redirectUri  = isGoogleInstalled
      ? `http://localhost:${redirectPort}`
      : `http://localhost:${redirectPort}/oauth/callback`;
    const state        = crypto.randomBytes(16).toString('hex');
    const scopeStr     = scopes || cfg.defaultScope;

    // PKCE support (required for Twitter/X OAuth2)
    let codeVerifier, codeChallenge;
    if (cfg.pkce) {
      codeVerifier  = crypto.randomBytes(32).toString('base64url');
      codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    }

    // Build auth URL — only add Google-specific params for google
    const authParams = {
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      state,
    };
    if (scopeStr) authParams.scope = scopeStr;
    if (provider === 'google') {
      authParams.access_type = 'offline';
      authParams.prompt      = 'consent';
    }
    if (cfg.pkce) {
      authParams.code_challenge        = codeChallenge;
      authParams.code_challenge_method = 'S256';
    }
    const authUrl = `${cfg.authBase}?${new URLSearchParams(authParams).toString()}`;

    // Start local redirect-catcher server
    const codePromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, `http://localhost:${redirectPort}`);
          const code  = url.searchParams.get('code');
          const rState = url.searchParams.get('state');
          if (code && rState === state) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body style="font-family:sans-serif;background:#111;color:#4ade80;padding:40px"><h2>✓ Connected!</h2><p>You can close this window.</p></body></html>');
            server.close();
            resolve(code);
          } else {
            res.writeHead(400); res.end('Bad request');
          }
        } catch(e) {
          res.writeHead(500); res.end('Error');
          reject(e);
        }
      });
      server.listen(redirectPort, '127.0.0.1', () => {
        console.log(`[OAuth] Redirect listener on port ${redirectPort}`);
      });
      server.on('error', reject);
      setTimeout(() => { server.close(); reject(new Error('OAuth timeout')); }, 300000);
    });

    // Open OAuth window
    const authWin = new OWin({
      width: 520, height: 700,
      title: `Connect ${provider}`,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    authWin.loadURL(authUrl);
    authWin.show();

    let code;
    try {
      code = await codePromise;
    } catch(e) {
      console.error(`[OAuth] Failed to get code: ${e.message}`);
      if (!authWin.isDestroyed()) authWin.close();
      return;
    }
    if (!authWin.isDestroyed()) authWin.close();

    // Exchange code for tokens
    try {
      const tokenParams = {
        code,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      };
      // basicAuth providers (Notion, Zoom) send credentials in Authorization header
      // pkce providers (Twitter) send code_verifier instead of client_secret in body
      if (!cfg.basicAuth) {
        tokenParams.client_id     = clientId;
        tokenParams.client_secret = clientSecret;
      }
      if (cfg.pkce && codeVerifier) {
        tokenParams.code_verifier = codeVerifier;
        tokenParams.client_id     = clientId; // Twitter still needs client_id in body
      }
      const tokenBody = new URLSearchParams(tokenParams).toString();

      const tokenHeaders = {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(tokenBody),
      };
      if (cfg.basicAuth) {
        tokenHeaders['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      }

      console.log(`[OAuth] Token exchange → ${cfg.tokenUrl} | client_id=${clientId?.slice(0,12)}… | redirect_uri=${redirectUri}`);
      const tokenData = await new Promise((resolve, reject) => {
        const tokenUrlObj = new URL(cfg.tokenUrl);
        const isHttps = tokenUrlObj.protocol === 'https:';
        const lib = isHttps ? https : http;
        const req = lib.request({
          hostname: tokenUrlObj.hostname,
          path:     tokenUrlObj.pathname + tokenUrlObj.search,
          method:   'POST',
          headers:  tokenHeaders,
        }, (res) => {
          let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
            console.log(`[OAuth] Token response (${res.statusCode}):`, d.slice(0, 500));
            try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(tokenBody); req.end();
      });

      if (tokenData.error) {
        // invalid_client almost always means redirect URI not whitelisted in provider console
        if ((tokenData.error === 'invalid_client' || tokenData.error === 'redirect_uri_mismatch') && provider === 'google') {
          const { dialog } = require('electron');
          dialog.showMessageBox(resultsWindow, {
            type: 'warning',
            title: 'Google OAuth Setup Required',
            message: `Google rejected the OAuth connection.\n\nTo fix this, add the following URI to your Google Cloud Console:\n\n  ${redirectUri}\n\nSteps:\n1. Open console.cloud.google.com\n2. APIs & Services → Credentials\n3. Click your OAuth 2.0 Client ID\n4. Under "Authorized redirect URIs" → Add URI:\n   ${redirectUri}\n5. Save, then try connecting again.\n\nRaw error: ${tokenData.error_description || tokenData.error}`,
            buttons: ['Open Google Console', 'Close'],
          }).then(({ response }) => {
            if (response === 0) {
              require('electron').shell.openExternal('https://console.cloud.google.com/apis/credentials');
            }
          });
          return;
        }
        throw new Error(`${tokenData.error}: ${tokenData.error_description || ''}`.trim());
      }

      // Try to fetch account hint (email/username) for display in Skills tab
      let email;
      const USERINFO_ENDPOINTS = {
        google:    { host: 'www.googleapis.com',      path: '/oauth2/v2/userinfo',      field: 'email' },
        github:    { host: 'api.github.com',           path: '/user',                    field: 'login', headers: { 'User-Agent': 'ThinkDrop' } },
        microsoft: { host: 'graph.microsoft.com',      path: '/v1.0/me',                field: 'mail' },
        spotify:   { host: 'api.spotify.com',          path: '/v1/me',                  field: 'email' },
        discord:   { host: 'discord.com',              path: '/api/users/@me',           field: 'email' },
        slack:     { host: 'slack.com',                path: '/api/users.identity',      field: null }, // Slack returns nested object
        linkedin:  { host: 'api.linkedin.com',         path: '/v2/emailAddress?q=members&projection=(elements*(handle~))', field: null },
        twitter:   { host: 'api.twitter.com',          path: '/2/users/me',             field: null }, // returns data.username
        zoom:      { host: 'api.zoom.us',              path: '/v2/users/me',            field: 'email' },
        hubspot:   { host: 'api.hubapi.com',           path: '/oauth/v1/access-tokens/' + tokenData.access_token, field: 'user' },
      };
      if (tokenData.access_token && USERINFO_ENDPOINTS[provider]) {
        try {
          const ep = USERINFO_ENDPOINTS[provider];
          const info = await new Promise((resolve) => {
            const req = https.request({
              hostname: ep.host,
              path: ep.path,
              headers: { 'Authorization': `Bearer ${tokenData.access_token}`, ...(ep.headers || {}) },
            }, (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(_) { resolve({}); } }); });
            req.on('error', () => resolve({})); req.end();
          });
          if (ep.field) {
            email = info[ep.field];
          } else if (provider === 'twitter') {
            email = info.data?.username ? '@' + info.data.username : undefined;
          } else if (provider === 'slack') {
            email = info.user?.email;
          } else if (provider === 'linkedin') {
            email = info.elements?.[0]?.['handle~']?.emailAddress;
          }
        } catch(_) {}
      }

      // Store token in keytar
      const tokenJson = JSON.stringify({ ...tokenData, email, storedAt: new Date().toISOString() });
      if (keytar) await keytar.setPassword('thinkdrop', tokenKey, tokenJson);
      console.log(`[OAuth] Stored ${provider} token for skill ${skillName} → ${tokenKey}${email ? ' (' + email + ')' : ''}`);

      // Also store in the format external.skill expects for googleapis (token path or env)
      if (provider === 'google') {
        const fsMod = require('fs'); const pathMod = require('path'); const osMod = require('os');
        const tokDir = pathMod.join(osMod.homedir(), '.thinkdrop', 'tokens');
        if (!fsMod.existsSync(tokDir)) fsMod.mkdirSync(tokDir, { recursive: true });
        const safeName = skillName.replace(/[^a-z0-9.-]/g, '-');
        fsMod.writeFileSync(pathMod.join(tokDir, `${safeName}.json`), JSON.stringify(tokenData, null, 2), 'utf8');
        console.log(`[OAuth] Wrote Google token file: ~/.thinkdrop/tokens/${safeName}.json`);
      }

      // Refresh Skills tab
      ipcMain.emit('skills:list');
    } catch(e) {
      console.error(`[OAuth] Token exchange failed: ${e.message}`);
    }
  });

  // ─── Connections: global OAuth provider list / connect / disconnect ──────────
  // These handlers manage global tokens stored as oauth:<provider> in keytar.
  // One connected provider covers all skills that need it — no per-skill tokens.

  const ALL_PROVIDERS = [
    { provider: 'github',     label: 'GitHub',     color: '#e5e7eb', scopes: 'read:user user:email repo',                                                              redirectPort: 9742 },
    { provider: 'google',     label: 'Google',     color: '#4285f4', scopes: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar', redirectPort: 9743 },
    { provider: 'microsoft',  label: 'Microsoft',  color: '#00a4ef', scopes: 'openid profile email offline_access Calendars.ReadWrite Mail.Read',                      redirectPort: 9744 },
    { provider: 'slack',      label: 'Slack',      color: '#4a154b', scopes: 'openid profile email channels:read chat:write',                                          redirectPort: 9745 },
    { provider: 'notion',     label: 'Notion',     color: '#ffffff', scopes: '',                                                                                       redirectPort: 9746 },
    { provider: 'spotify',    label: 'Spotify',    color: '#1db954', scopes: 'user-read-email user-read-private user-library-read',                                    redirectPort: 9747 },
    { provider: 'dropbox',    label: 'Dropbox',    color: '#0061ff', scopes: 'account_info.read files.content.read',                                                   redirectPort: 9748 },
    { provider: 'discord',    label: 'Discord',    color: '#5865f2', scopes: 'identify email',                                                                         redirectPort: 9749 },
    { provider: 'linkedin',   label: 'LinkedIn',   color: '#0a66c2', scopes: 'openid profile email',                                                                   redirectPort: 9750 },
    { provider: 'zoom',       label: 'Zoom',       color: '#2d8cff', scopes: 'user:read meeting:write',                                                                redirectPort: 9751 },
    { provider: 'atlassian',  label: 'Atlassian',  color: '#0052cc', scopes: 'read:me offline_access',                                                                 redirectPort: 9752 },
    { provider: 'salesforce', label: 'Salesforce', color: '#00a1e0', scopes: 'openid profile email',                                                                   redirectPort: 9753 },
    { provider: 'hubspot',    label: 'HubSpot',    color: '#ff7a59', scopes: 'crm.objects.contacts.read oauth',                                                        redirectPort: 9754 },
    { provider: 'facebook',   label: 'Facebook',   color: '#1877f2', scopes: 'email public_profile',                                                                   redirectPort: 9755 },
    { provider: 'twitter',    label: 'Twitter/X',  color: '#1da1f2', scopes: 'tweet.read users.read offline.access',                                                   redirectPort: 9756 },
  ];

  const sendConnectionsUpdate = async () => {
    const keytar = (() => { try { return require('keytar'); } catch(_) { return null; } })();
    const items = await Promise.all(ALL_PROVIDERS.map(async (p) => {
      const tokenKey = `oauth:${p.provider}`;
      let connected = false;
      let accountHint;
      if (keytar) {
        try {
          const raw = await keytar.getPassword('thinkdrop', tokenKey);
          if (raw) {
            connected = true;
            try {
              const parsed = JSON.parse(raw);
              accountHint = parsed.email || parsed.login || undefined;
            } catch(_) {}
          }
        } catch(_) {}
      }
      return { provider: p.provider, label: p.label, color: p.color, scopes: p.scopes, tokenKey, connected, accountHint };
    }));
    safeSend(resultsWindow, 'connections:update', items);
  };

  ipcMain.on('connections:list', async () => {
    await sendConnectionsUpdate();
  });

  ipcMain.on('connections:connect', async (_event, { provider, tokenKey, scopes }) => {
    // Delegate to skills:oauth-connect using the global tokenKey (oauth:<provider>)
    ipcMain.emit('skills:oauth-connect', null, {
      skillName: provider,
      provider,
      tokenKey: tokenKey || `oauth:${provider}`,
      scopes,
    });
    // Watch keytar for the token to land, then push an update
    const keytar = (() => { try { return require('keytar'); } catch(_) { return null; } })();
    if (!keytar) return;
    const tk = tokenKey || `oauth:${provider}`;
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const val = await keytar.getPassword('thinkdrop', tk);
        if (val) {
          clearInterval(poll);
          await sendConnectionsUpdate();
        }
      } catch(_) {}
      if (attempts >= 120) clearInterval(poll);
    }, 1000);
  });

  ipcMain.on('connections:disconnect', async (_event, { provider, tokenKey }) => {
    const keytar = (() => { try { return require('keytar'); } catch(_) { return null; } })();
    if (!keytar) return;
    const tk = tokenKey || `oauth:${provider}`;
    try {
      await keytar.deletePassword('thinkdrop', tk);
      console.log(`[Connections] Disconnected ${provider} (deleted ${tk})`);
    } catch(e) {
      console.warn(`[Connections] Failed to delete ${tk}: ${e.message}`);
    }
    await sendConnectionsUpdate();
    // Also refresh Skills tab so OAuth status updates there too
    ipcMain.emit('skills:list');
  });

  // ─── Skills: update oauth_scopes for a provider in the contract frontmatter ─
  ipcMain.on('skills:update-oauth-scopes', async (_event, { skillName, provider, scopes }) => {
    try {
      const http = require('http');
      const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || 'default_key';
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);

      // Fetch current contractMd
      const current = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.get', payload: { name: skillName }, requestId: 'scope-get-' + Date.now() });
        const req = http.request({
          hostname: '127.0.0.1', port: memPort, path: '/skill.get', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memApiKey}`, 'Content-Length': Buffer.byteLength(body) },
        }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
        req.on('error', reject); req.write(body); req.end();
      });

      const contractMd = current?.result?.contractMd || current?.contractMd || '';
      if (!contractMd) {
        console.warn(`[Skills] skills:update-oauth-scopes — no contractMd found for ${skillName}`);
        return;
      }

      // Parse existing oauth_scopes map from frontmatter
      const fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
      const fm = fmMatch ? fmMatch[1] : '';
      const existingScopesMatch = fm.match(/^oauth_scopes\s*:\s*(.+)$/m);
      const scopesMap = {};
      if (existingScopesMatch) {
        for (const part of existingScopesMatch[1].split(',')) {
          const eq = part.indexOf('=');
          if (eq !== -1) {
            const p = part.slice(0, eq).trim().toLowerCase();
            const s = part.slice(eq + 1).trim();
            if (p) scopesMap[p] = s;
          }
        }
      }

      // Update the specific provider's scopes
      if (scopes && scopes.trim()) {
        scopesMap[provider] = scopes.trim();
      } else {
        delete scopesMap[provider]; // empty = revert to defaults
      }

      const newScopeLine = Object.keys(scopesMap).length > 0
        ? 'oauth_scopes: ' + Object.entries(scopesMap).map(([p, s]) => `${p}=${s}`).join(', ')
        : null;

      // Rewrite frontmatter
      let updatedMd;
      if (existingScopesMatch) {
        // Replace existing oauth_scopes line
        updatedMd = newScopeLine
          ? contractMd.replace(/^oauth_scopes\s*:.*$/m, newScopeLine)
          : contractMd.replace(/^oauth_scopes\s*:.*\n?/m, '');
      } else if (newScopeLine) {
        // Insert after oauth: line if present, otherwise before closing ---
        if (/^oauth\s*:/m.test(fm)) {
          updatedMd = contractMd.replace(/^(oauth\s*:.+)$/m, `$1\n${newScopeLine}`);
        } else {
          updatedMd = contractMd.replace(/\n---/, `\n${newScopeLine}\n---`);
        }
      } else {
        updatedMd = contractMd; // no change
      }

      // Persist updated contract
      const upsertBody = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.upsert', payload: { name: skillName, contractMd: updatedMd }, requestId: 'scope-upsert-' + Date.now() });
      await new Promise(resolve => {
        const req = http.request({
          hostname: '127.0.0.1', port: memPort, path: '/skill.upsert', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memApiKey}`, 'Content-Length': Buffer.byteLength(upsertBody) },
        }, res => { res.resume(); resolve(); });
        req.on('error', () => resolve()); req.write(upsertBody); req.end();
      });

      console.log(`[Skills] Updated oauth_scopes for ${provider} on ${skillName}: ${scopes || '(cleared)'}`);
      ipcMain.emit('skills:list');
    } catch (e) {
      console.error('[Skills] skills:update-oauth-scopes failed:', e.message);
    }
  });

  // ─── Skills: upload a skill directory into ~/.thinkdrop/skills/ ───────────
  ipcMain.on('skills:upload', async () => {
    try {
      const { dialog } = require('electron');
      const fsMod = require('fs');
      const osMod = require('os');
      const pathMod = require('path');

      const { canceled, filePaths } = await dialog.showOpenDialog(resultsWindow || undefined, {
        title: 'Select Skill Directory',
        properties: ['openDirectory'],
        buttonLabel: 'Upload Skill',
      });
      if (canceled || !filePaths.length) return;

      const srcDir = filePaths[0];
      const dirName = pathMod.basename(srcDir);
      const skillsBase = pathMod.join(osMod.homedir(), '.thinkdrop', 'skills');
      const destDir = pathMod.join(skillsBase, dirName);

      // Copy directory recursively
      fsMod.mkdirSync(destDir, { recursive: true });
      function copyDir(src, dest) {
        for (const entry of fsMod.readdirSync(src, { withFileTypes: true })) {
          const s = pathMod.join(src, entry.name);
          const d = pathMod.join(dest, entry.name);
          if (entry.name === 'node_modules') continue; // skip node_modules
          if (entry.isDirectory()) { fsMod.mkdirSync(d, { recursive: true }); copyDir(s, d); }
          else { fsMod.copyFileSync(s, d); }
        }
      }
      copyDir(srcDir, destDir);

      // Derive skill name from directory name (hyphens or underscores → dots)
      const skillName = dirName.replace(/[-_]+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/, '').toLowerCase();
      const execPath = pathMod.join(destDir, 'index.cjs');
      if (!fsMod.existsSync(execPath)) {
        console.error('[Skills] skills:upload — no index.cjs found in uploaded directory');
        return;
      }

      // Register in user-memory
      const http = require('http');
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
      const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
      const regBody = JSON.stringify({
        version: 'mcp.v1', service: 'user-memory', action: 'skill.upsert',
        payload: { name: skillName, execPath, execType: 'node', enabled: true, description: `Uploaded from ${dirName}` },
        requestId: 'upload-' + Date.now(),
      });
      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: memPort, path: '/skill.upsert', method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(regBody),
            ...(memApiKey ? { 'Authorization': `Bearer ${memApiKey}` } : {}),
          },
          timeout: 6000,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(regBody); req.end();
      });

      console.log(`[Skills] Uploaded skill: ${skillName} → ${destDir}`);
      // Refresh skills tab
      ipcMain.emit('skills:list');
    } catch (e) {
      console.error('[Skills] skills:upload failed:', e.message);
    }
  });

  // ─── Cron: local pause state (keyed by skillName from scheduler) ───────────
  const _pausedCrons = new Set();

  // ─── Cron: list scheduled skills from skill-scheduler ─────────────────────
  ipcMain.on('cron:list', async () => {
    try {
      const http = require('http');
      const cmdPort = parseInt(process.env.SERVICE_PORT || process.env.COMMAND_SERVICE_PORT || '3007', 10);

      // Trigger immediate re-sync from user-memory so list is always fresh
      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: cmdPort,
          path: '/skill.schedule/sync', method: 'POST',
          headers: { 'Content-Length': '0' },
          timeout: 3000,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      });

      // Brief wait for sync to complete before reading the list
      await new Promise(r => setTimeout(r, 1500));

      const jobs = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: cmdPort,
          path: '/skill.schedule/list', method: 'GET',
          timeout: 4000,
        }, (res) => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw)?.jobs || []); } catch (_) { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
      });

      // Also fetch pending one-shot reminders
      const reminders = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: cmdPort,
          path: '/reminder.list', method: 'GET',
          timeout: 3000,
        }, (res) => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw)?.reminders || []); } catch (_) { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
      });

      const jobItems = jobs.map(j => ({
        id:       j.skillName,
        label:    j.skillName,
        schedule: j.schedule,
        status:   _pausedCrons.has(j.skillName) ? 'paused' : 'active',
        type:     j.type || 'cron',
      }));
      const reminderItems = reminders.map(r => ({
        id:       r.id,
        label:    `⏰ ${r.label}`,
        schedule: `fires at ${new Date(r.targetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        status:   'active',
        type:     'reminder',
        remainingMs: r.remainingMs,
        triggerIntent: r.triggerIntent,
      }));
      const items = [...reminderItems, ...jobItems];
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'cron:update', items);
    } catch (e) {
      console.error('[Cron] cron:list failed:', e.message);
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'cron:update', []);
    }
  });

  ipcMain.on('cron:run-now', async (_event, { id }) => {
    console.log(`[Cron] Run now: ${id}`);
    const skillName = id;
    // Helper to broadcast updated cron list with an error status for the affected skill
    const broadcastCronError = (errMsg) => {
      try {
        const items = queueManager.getCron().map(j => ({
          id:       j.skillName,
          label:    j.skillName,
          schedule: j.schedule,
          nextRun:  j.nextRun ? new Date(j.nextRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined,
          lastRun:  j.lastRun ? new Date(j.lastRun).toLocaleString() : undefined,
          status:   j.skillName === skillName ? 'error' : (_pausedCrons.has(j.skillName) ? 'paused' : 'active'),
          lastError: j.skillName === skillName ? errMsg : undefined,
        }));
        if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'cron:update', items);
      } catch (_) {}
    };
    try {
      const http = require('http');
      const cmdPort = parseInt(process.env.SERVICE_PORT || process.env.COMMAND_SERVICE_PORT || '3007', 10);
      // Use /skill.fire so the scheduler dispatches via the correct tier
      // (bridge → WS:INSTRUCTION, notify → osascript, script → external.skill).
      // The old /command.automate + external.skill path fails for contract-based
      // skills whose exec_path is a .md file, not an index.cjs.
      const body = JSON.stringify({ skillName });
      const req = http.request({
        hostname: '127.0.0.1', port: cmdPort,
        path: '/skill.fire', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          console.log(`[Cron] Run now result for ${skillName} (HTTP ${res.statusCode}):`, data.slice(0, 300));
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok && parsed.error) {
              console.warn(`[Cron] ${skillName} run failed: ${parsed.error}`);
              broadcastCronError(parsed.error);
              return;
            }
          } catch (_) {}
          queueManager.recordCronRun(skillName);
        });
      });
      req.on('error', (e) => {
        console.error(`[Cron] cron:run-now HTTP error for ${skillName}:`, e.message);
        broadcastCronError(e.message);
      });
      req.write(body);
      req.end();
    } catch (e) {
      console.error('[Cron] cron:run-now failed:', e.message);
      broadcastCronError(e.message);
    }
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
        // Strip surrounding quotes from attribute values (e.g. status="pending" → pending)
        while ((am = attrRe.exec(attrsStr)) !== null) attrs[am[1]] = am[2].replace(/^["']|["']$/g, '');
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

                const autoPrompt = block.body;

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
              const autoPrompt = block.body;
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

    function markBridgeBlockDone(blockId) {
      try {
        if (!fs.existsSync(BRIDGE_FILE)) return;
        let content = fs.readFileSync(BRIDGE_FILE, 'utf8');
        // Remove the entire block from bridge.md — prevents re-firing on restart
        // Block format uses quoted attrs: id="..." status="pending"
        const safeId = blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const blockRe = new RegExp(
          `\\n?<!--\\s*[A-Z][A-Z0-9_]*:[\\w]+ id=["']?${safeId}["']?[^>]*-->[\\s\\S]*?<!--\\s*[A-Z][A-Z0-9_]*:END\\s*-->\\n?`
        );
        const updated = content.replace(blockRe, '');
        if (updated !== content) {
          fs.writeFileSync(BRIDGE_FILE, updated, 'utf8');
          console.log(`🌉 [Bridge Listener] Removed block ${blockId} from bridge file`);
        } else {
          console.warn(`🌉 [Bridge Listener] Block ${blockId} not found in bridge file for removal`);
        }
      } catch (err) {
        console.error(`[Bridge Listener] Failed to remove block ${blockId}:`, err.message);
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
