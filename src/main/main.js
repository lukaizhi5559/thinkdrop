// Entry point — ThinkDrop managed
require('dotenv').config();
// Also load command-service .env as a fallback for OAuth credentials and service config.
// Values already set by the root .env take precedence (override: false).
require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', 'mcp-services', 'command-service', '.env'),
  override: false,
});
const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard, safeStorage } = require('electron');

// Enable webkitSpeechRecognition network access — must be called before app is ready.
// Without these flags Electron blocks the connection to Google's speech API,
// causing a 'network' error immediately on recognition.start().
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'http://localhost:5173');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

const { startCryptoBridge, stopCryptoBridge } = require('./cryptoBridge');

// Safe IPC send — guards against "Render frame was disposed" crash that occurs when
// a window reloads between the isDestroyed() check and the actual send call.
function safeSend(win, channel, ...args) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send(channel, ...args); } catch (_) {}
}

// Unified window IPC send — sends to unifiedWindow if available, otherwise falls back to old windows
function safeSendUnified(channel, ...args) {
  // Trace the exact ordering of stream-related messages so doubling can be diagnosed.
  if (channel === 'ws-bridge:message' || channel === 'unified:set-prompt') {
    const msg = args[0];
    const textPreview = msg?.text ? `"${String(msg.text).substring(0, 30).replace(/\n/g, '\\n')}${msg.text.length > 30 ? '...' : ''}"` : '';
    console.log(`[SEND→UNIFIED] ch=${channel} type=${msg?.type || 'n/a'} textLen=${msg?.text?.length ?? 0} lane=${msg?.lane || ''} ${textPreview}`);
  }
  if (unifiedWindow && !unifiedWindow.isDestroyed()) {
    try { unifiedWindow.webContents.send(channel, ...args); } catch (_) {}
  }
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

// Active progressCallback for the currently running stategraph execution.
// Set whenever an execution starts, cleared when it ends. Used by the overlay
// server /agent-turn endpoint to forward real-time agent turn events from the
// command-service (separate process) back to the renderer via IPC.
let activeProgressCallback = null;
// Dedicated callback for cron/bridge jobs running on cronStateGraph so agent
// thoughts and turn events reach the Cron tab independently of user prompts.
let activeCronProgressCallback = null;

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
            safeSendUnified('unified:set-prompt', message);
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
            if (!voiceOnly) {
              safeSendUnified('ws-bridge:message', { type: 'chunk', text: token });
            }
          };

          // Forward automation progress events to Unified window (AutomationProgress component)
          const progressCallback = (evt) => {
            safeSendUnified('automation:progress', evt);
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
            safeSendUnified('ws-bridge:message', { type: 'done' });
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
          safeSendUnified('voice:response', {
            text: data.text || '',
            fullAnswer: data.fullAnswer || '',
            audioBase64: data.audioBase64 || '',
            audioFormat: data.audioFormat || 'wav',
            language: data.language || 'en',
            lane: data.lane || 'stategraph',
            durationEstimateMs: data.durationEstimateMs || null,
          });
          if (data.fullAnswer) {
            safeSendUnified('ws-bridge:message', { type: 'chunk', text: data.fullAnswer, lane: data.lane || 'stategraph' });
            safeSendUnified('ws-bridge:message', { type: 'done', lane: data.lane || 'stategraph' });
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
            const cronId = skillName;
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
          const { skillName, instruction, retryCount, schedule } = JSON.parse(body || '{}');
          const label = (instruction || skillName || 'scheduled task').split(' ').slice(0, 8).join(' ');
          const { dialog, nativeImage } = require('electron');
          const path = require('path');
          const logoPath = path.join(__dirname, '..', 'renderer', 'assets', 'logo.jpg');
          let logoIcon;
          try { logoIcon = nativeImage.createFromPath(logoPath); } catch (_) {}
          const attemptsLeft = 3 - (retryCount || 0);
          // Convert cron expression to a human-readable label for the dialog
          const _cronToHuman = (expr) => {
            if (!expr) return null;
            const m = expr.match(/^(\*|\d+) \*\/(\d+) \* \* \*$/);
            if (m) return `every ${m[2]}h`;
            const m2 = expr.match(/^\*\/(\d+) \* \* \* \*$/);
            if (m2) return `every ${m2[1]}min`;
            const m3 = expr.match(/^0 (\d+) \* \* \*$/);
            if (m3) return `daily at ${m3[1]}:00`;
            const m4 = expr.match(/^0 0 \* \* (\d+)$/);
            if (m4) { const d=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; return `weekly on ${d[m4[1]]||m4[1]}`; }
            return expr;
          };
          const scheduleLabel = _cronToHuman(schedule);
          const scheduleNote = scheduleLabel ? ` — scheduled ${scheduleLabel}` : '';
          const deferNote = attemptsLeft > 0 ? `(force-runs after ~${attemptsLeft * 10} min of deferral${scheduleNote})` : '(last chance — will run now regardless)';
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

    // ── POST /agent-turn — command-service streams per-turn progress back to the renderer ──
    // cli.agent.cjs POSTs here after each agentic turn so the UI shows the live turn count
    // before the full response arrives. Forwarded via the active progressCallback.
    if (req.url === '/agent-turn') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const evt = JSON.parse(body || '{}');
          if (activeProgressCallback && ['agent:turn_live', 'agent:turn', 'agent:complete', 'agent:thought', 'needs_login'].includes(evt.type)) {
            activeProgressCallback(evt);
          }
          if (activeCronProgressCallback && ['agent:turn_live', 'agent:turn', 'agent:complete', 'agent:thought', 'needs_login'].includes(evt.type)) {
            activeCronProgressCallback(evt);
          }
          res.writeHead(200).end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400).end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── POST /scan.progress — maintenance scan events from explore.agent ────
    if (req.url === '/scan.progress') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          res.writeHead(200).end(JSON.stringify({ ok: true }));

          // Forward to renderer windows
          const wins = [resultsWindow, promptCaptureWindow].filter(w => w && !w.isDestroyed());
          for (const win of wins) safeSend(win, 'scan:progress', data);

          // macOS notification on idle/scheduled completion only
          if (data.type === 'maintenance_scan_complete' && (data.trigger === 'idle' || data.trigger === 'scheduled')) {
            try {
              const { Notification } = require('electron');
              const n = new Notification({
                title: 'ThinkDrop Maintenance Complete',
                body: `${data.total || 0} agent${data.total !== 1 ? 's' : ''} updated${data.trigger === 'idle' ? ' while you were away' : ''}`,
                silent: true,
              });
              n.show();
            } catch (_) {}
          }

          // Forward discovery suggestions separately so renderer can show the suggestions card
          if (data.type === 'maintenance_scan_discovery' && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
            for (const win of wins) safeSend(win, 'scan:discovery', { suggestions: data.suggestions });
          }
        } catch (err) {
          res.writeHead(400).end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── POST /learn.progress — learn mode events from learn.agent ─────────────
    if (req.url === '/learn.progress') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          res.writeHead(200).end(JSON.stringify({ ok: true }));

          // Forward to unified window
          if (unifiedWindow && !unifiedWindow.isDestroyed()) {
            safeSend(unifiedWindow, 'agents:learn-progress', data);
          }
        } catch (err) {
          res.writeHead(400).end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── POST /training.progress — training mode events from trainer.agent ───────
    if (req.url === '/training.progress') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          res.writeHead(200).end(JSON.stringify({ ok: true }));

          // Forward to unified window
          if (unifiedWindow && !unifiedWindow.isDestroyed()) {
            safeSend(unifiedWindow, 'agents:train-progress', data);
          }
        } catch (err) {
          res.writeHead(400).end(JSON.stringify({ error: err.message }));
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
// Second StateGraph instance dedicated to bridge/cron execution — never shares the user's queue
let cronStateGraph = null;
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

// Tracks whether the user has manually dragged the unified panel.
// When true, resize handlers preserve the current Y position instead of reanchoring to screen bottom.
let _userHasMovedPanel = false;

// Tracks whether a learn session is active so the overlay can resist macOS panel auto-hide.
let _learnSessionActive = false;

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

    cronStateGraph = StateGraphBuilder.full({
      mcpAdapter,
      llmBackend,
      debug: process.env.NODE_ENV === 'development',
      logger: console,
    });

    console.log('✅ [StateGraph] Initialized with full graph (all nodes)');
    console.log('✅ [CronStateGraph] Initialized (dedicated bridge/cron instance)');
  } catch (err) {
    console.error('❌ [StateGraph] Failed to initialize:', err.message);
    stateGraph = null;
    cronStateGraph = null;
  }
}

let promptCaptureWindow = null;  // TODO: Migrate to unifiedWindow
let resultsWindow = null;  // TODO: Migrate to unifiedWindow
let unifiedWindow = null;

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
  });

  bridgeWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[VS Code Bridge] Message received:', message.type);
      
      // Forward all messages to unifiedWindow (and legacy windows)
      safeSendUnified('ws-bridge:message', message);
      
      // Ensure unifiedWindow is visible for incoming bridge messages
      if (unifiedWindow && !unifiedWindow.isDestroyed() && !unifiedWindow.isVisible()) {
        unifiedWindow.showInactive();
      }
    } catch (error) {
      console.error('[VS Code Bridge] Failed to parse message:', error);
    }
  });

  bridgeWs.on('error', (error) => {
    console.error('[VS Code Bridge] Error:', error.message);
    vscodeConnected = false;
  });

  bridgeWs.on('close', () => {
    console.log('[VS Code Bridge] Disconnected');
    vscodeConnected = false;
    bridgeWs = null;

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
    // Pre-populate skill:*:ACCESS_TOKEN so OAuth skills work even before the user
    // opens the Skills tab for the first time (avoids silent 401s at automation time).
    setTimeout(() => ipcMain.emit('skills:list'), 3000);
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

// Unified Overlay Window - combines prompt capture and results
function createUnifiedWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const windowMinWidth = 400;
  const windowMinHeight = 300;
  const windowMaxHeight = 800;
  const margin = 20;

  // Position at bottom-right like the old ResultsWindow
  const initialX = (screenWidth - windowMinWidth) - margin;
  const initialY = screenHeight; // Off-screen initially

  unifiedWindow = new BrowserWindow({
    x: initialX,
    y: initialY,
    width: windowMinWidth,
    height: windowMinHeight,
    minWidth: windowMinWidth,
    maxWidth: 800,
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
    // 'panel' type suppresses the macOS native OS focus ring on transparent frameless windows
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'darwin') {
    unifiedWindow.setWindowButtonVisibility(false);
    unifiedWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    unifiedWindow.setAlwaysOnTop(true, 'floating', 5);
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    unifiedWindow.loadURL('http://localhost:5173/index.html?mode=unified&cacheBust=' + Date.now());
  } else {
    unifiedWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'),
      { query: { mode: 'unified' } });
  }

  // Grant microphone access for voice input
  unifiedWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audiocapture' || permission === 'speech') {
      callback(true);
    } else {
      callback(false);
    }
  });
  unifiedWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audiocapture' || permission === 'speech') return true;
    return false;
  });

  unifiedWindow.webContents.on('did-finish-load', () => {
    console.log('[Unified Window] Content finished loading.');
    unifiedWindow.webContents.setAudioMuted(false);
  });

  // Block navigation to prevent render frame disposal
  let unifiedWindowLoaded = false;
  unifiedWindow.webContents.once('did-finish-load', () => { unifiedWindowLoaded = true; });
  unifiedWindow.webContents.on('will-navigate', (event, url) => {
    if (unifiedWindowLoaded) {
      console.log('[Unified Window] Blocking navigation to prevent render frame disposal:', url);
      event.preventDefault();
    }
  });

  unifiedWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Unified Window failed to load: [${errorCode}] ${errorDescription}`);
    if (errorCode === -102 || errorCode === -6) {
      setTimeout(() => {
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          console.log('[Unified Window] Retrying load...');
          unifiedWindow.loadURL('http://localhost:5173/index.html?mode=unified&cacheBust=' + Date.now());
        }
      }, 500);
    }
  });

  unifiedWindow.on('closed', () => {
    console.log('Unified Window closed.');
    unifiedWindow = null;
  });

  // macOS NSPanel auto-hides when another app takes focus. During an active learn session
  // (headed Chromium opens for auth) we must keep the overlay visible — re-show it immediately
  // without stealing focus from the browser the user needs to interact with.
  unifiedWindow.on('hide', () => {
    if (_learnSessionActive && unifiedWindow && !unifiedWindow.isDestroyed()) {
      unifiedWindow.showInactive();
    }
  });

  return unifiedWindow;
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

  // Create unified window (combines prompt capture and results)
  createUnifiedWindow();

  // Start overlay control HTTP server so command-service skills can hide/show windows before screenshotting
  startOverlayControlServer();

  // Start crypto bridge — Electron safeStorage-based credential encryption
  // for the user-memory service. One OS approval, no repeated prompts.
  startCryptoBridge(safeStorage).catch((err) => {
    console.warn('[App] Crypto bridge failed to start (credential encryption unavailable):', err.message);
  });

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
        const cronId = skillName;
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
        safeSendUnified('unified:set-prompt', pending.prompt || pending.label);
        if (unifiedWindow && !unifiedWindow.isDestroyed()) { unifiedWindow.showInactive(); unifiedWindow.moveTop(); }
        const progressCallback = (event) => {
          safeSendUnified('automation:progress', event);
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
        // Plan execution fields (set when plan:approve re-enqueues)
        _planFile: item._planFile || null,
        _forceNewPlan: item._forceNewPlan || false,
        _skillPlan: item._skillPlan || null,
        _skillPlanFile: item._skillPlanFile || null,
        _planCorrectionMode: item._planCorrectionMode || false,
        _planCorrectionText: item._planCorrectionText || null,
        _basePlanFile: item._basePlanFile || null,
        _skillPlanJson: item._skillPlanJson || null,
        _planCorrectionSourcePrompt: item._planCorrectionSourcePrompt || null,
        sessionId: item.sessionId || null,
        userId: item.userId || 'default_user',
      });
    },
    alertRestart: (items, countdownMs) => {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'prompt-queue:restart-alert', { items, countdownMs });
      }
    },
  });

  // ─── Prompt Queue IPC handlers ────────────────────────────────────────────

  const PLAN_MODE_CANCEL_RE = /^(?:\/)?(?:cancel|cancel\s+plan|exit\s+plan\s+mode|leave\s+plan\s+mode)\b/i;

  ipcMain.on('prompt-queue:submit', (_event, { prompt, selectedText = '', responseLanguage = null } = {}) => {
    const trimmedPrompt = prompt?.trim();
    if (!trimmedPrompt) return;

    if (pendingPlanContext && PLAN_MODE_CANCEL_RE.test(trimmedPrompt)) {
      console.log('[Plan] Plan mode cancelled by prompt text');
      pendingPlanContext = null;
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'prompt' });
        safeSend(resultsWindow, 'plan:cancelled', { planFile: null });
      }
      if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'prompt' });
      }
      return;
    }

    const enqueueOpts = { selectedText, responseLanguage, sessionId: currentSessionId };
    if (pendingPlanContext) {
      enqueueOpts._planCorrectionMode = true;
      enqueueOpts._planCorrectionText = trimmedPrompt;
      enqueueOpts._basePlanFile = pendingPlanContext.planFile || null;
      enqueueOpts._skillPlanJson = pendingPlanContext.skillPlanJson || null;
      enqueueOpts._planCorrectionSourcePrompt = pendingPlanContext.prompt || null;
      console.log(`[Plan] Plan correction mode enqueue: basePlan=${pendingPlanContext.planFile || 'none'}`);
      // Prevent stacking corrections onto stale context while this replan runs.
      pendingPlanContext = null;
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'replan-start' });
      }
      if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'replan-start' });
      }
    }

    const id = promptQueue.enqueue(trimmedPrompt, enqueueOpts);
    console.log(`[PromptQueue] IPC prompt-queue:submit → enqueued id=${id}`);
    safeSendUnified('queue:enqueued', { id });
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

  ipcMain.on('prompt-queue:resume-pending', () => {
    promptQueue.resumePendingPrompts();
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
    _savePausedCrons(); // persist so pause state survives restarts
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
    const cronId = skillName;
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

  // ─── Plan IPC bridge ──────────────────────────────────────────────────────
  // Stores the context from the most recently generated plan so plan:approve
  // can re-run the stategraph with _planFile set.
  let pendingPlanContext = null; // { planFile, sessionId, userId, selectedText }

  // plan:generated — emitted by planGenerator via progressCallback
  // Stored at module scope so plan:approve can pick it up via IPC.
  // (The progressCallback already forwarded the full event to the renderer;
  //  here we just capture context for the re-run.)

  // plan:approve — user clicked "Run Plan" in PlanPanel
  ipcMain.on('plan:approve', async (_event, { planFile, scanBeforeRun = true } = {}) => {
    const resolvedPlanFile = planFile || pendingPlanContext?.planFile;
    if (!resolvedPlanFile) {
      console.warn('[Plan] plan:approve received but no planFile available');
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'plan:error', { message: 'No plan file to execute. Please generate a plan first.' });
      }
      return;
    }

    console.log(`[Plan:DEBUG] plan:approve received — planFile from IPC: ${planFile} | pendingContext.planFile: ${pendingPlanContext?.planFile}`);
    console.log(`[Plan:DEBUG] Resolved planFile: ${resolvedPlanFile}`);

    // Optional: re-scan for sensitive data before executing
    if (scanBeforeRun) {
      try {
        const fs = require('fs');
        const planContent = fs.readFileSync(resolvedPlanFile, 'utf8');
        const planScanner = require('../../stategraph-module/src/utils/planScanner');
        const { sanitized, secrets } = planScanner.scan(planContent);

        // If new sensitive data was added during editing, store secrets and rewrite
        if (secrets.size > 0) {
          console.log(`[Plan] Detected ${secrets.size} new sensitive value(s) — storing and sanitizing`);
          try {
            await planScanner.storeSecrets(secrets, {
              keytarSet: async (svc, key, val) => {
                // Prefer safeStorage through the crypto bridge; fall back to keytar if unavailable
                if (safeStorage.isEncryptionAvailable()) {
                  const encrypted = safeStorage.encryptString(String(val));
                  // Store encrypted blob in profile via mcpAdapter
                  await mcpAdapter.callService('user-memory', 'profile.set', {
                    key: `credential:${key.toLowerCase()}`,
                    valueRef: `SAFE:${encrypted.toString('base64')}`,
                  }, { timeoutMs: 4000 }).catch(() => {});
                } else {
                  // Fallback: macOS keychain
                  const { spawnSync } = require('child_process');
                  spawnSync('security', ['add-generic-password', '-s', svc, '-a', key, '-w', String(val), '-U'], { encoding: 'utf8' });
                }
              },
              mcpAdapter,
              userId: pendingPlanContext?.userId || 'default_user',
              logger: console,
            });
          } catch (ksErr) {
            console.warn('[Plan] storeSecrets failed:', ksErr.message);
          }
          fs.writeFileSync(resolvedPlanFile, sanitized, 'utf8');
          // Forward re-scan result to renderer
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'plan:rescanned', { planFile: resolvedPlanFile });
          }
        }
      } catch (scanErr) {
        console.warn('[Plan] Pre-run scan failed:', scanErr.message);
      }
    }

    // Re-run StateGraph — two paths depending on how the plan was generated:
    // 1. planSkills approval gate (new): re-enqueue original prompt with _skillPlan array
    // 2. planGenerator (legacy): re-enqueue as [plan_execute:...] with _planFile
    const ctx = pendingPlanContext || {};
    if (ctx.skillPlanJson) {
      let _skillPlan = null;
      try {
        _skillPlan = JSON.parse(Buffer.from(ctx.skillPlanJson, 'base64').toString('utf8'));
      } catch (_decodeErr) {
        console.warn('[Plan] Failed to decode skillPlanJson:', _decodeErr.message);
      }
      if (_skillPlan) {
        promptQueue.enqueue(
          ctx.prompt,
          {
            _skillPlan,
            _skillPlanFile: ctx.planFile,
            selectedText:   ctx.selectedText || '',
            sessionId:      ctx.sessionId || currentSessionId,
            userId:         ctx.userId || 'default_user',
          }
        );
        console.log(`[Plan:DEBUG] Enqueued _skillPlan re-run for: "${ctx.prompt?.slice(0, 60)}"`);
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'plan:approved', { planFile: resolvedPlanFile });
        }
        return;
      }
    }
    // Legacy path: _planFile re-run via parseIntent plan_execute flow
    promptQueue.enqueue(
      `[plan_execute:${require('path').basename(resolvedPlanFile)}]`,
      {
        _planFile: resolvedPlanFile,
        selectedText: ctx.selectedText || '',
        sessionId: ctx.sessionId || currentSessionId,
        userId: ctx.userId || 'default_user',
        _forceDirectExecute: false,
      }
    );
    console.log(`[Plan:DEBUG] Enqueued plan_execute with _planFile: ${resolvedPlanFile}`);

    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'plan:approved', { planFile: resolvedPlanFile });
    }
  });

  // plan:new — user rejected existing plan and wants a freshly generated one
  ipcMain.on('plan:new', (_event) => {
    const ctx = pendingPlanContext;
    if (!ctx?.prompt) {
      console.warn('[Plan] plan:new received but no pending prompt context');
      return;
    }
    console.log(`[Plan] Forcing new plan for: "${ctx.prompt.slice(0, 60)}"`);
    promptQueue.enqueue(
      ctx.prompt,
      {
        selectedText:    ctx.selectedText || '',
        sessionId:       ctx.sessionId || currentSessionId,
        userId:          ctx.userId || 'default_user',
        _forceNewPlan:   true,
      }
    );
    pendingPlanContext = null;
  });

  // plan:cancel — user dismissed the plan
  ipcMain.on('plan:cancel', (_event, { planFile } = {}) => {
    console.log('[Plan] Plan cancelled by user');
    pendingPlanContext = null;
    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'cancel' });
      safeSend(resultsWindow, 'plan:cancelled', { planFile });
    }
    if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
      safeSend(promptCaptureWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'cancel' });
    }
  });

  // plan:open-editor — open plan.md in default system editor
  ipcMain.on('plan:open-editor', (_event, { planFile } = {}) => {
    const file = planFile || pendingPlanContext?.planFile;
    if (!file) return;
    const { shell } = require('electron');
    console.log(`[Plan] Opening plan in editor: ${file}`);
    shell.openPath(file)
      .then((err) => { if (err) console.warn('[Plan] shell.openPath error:', err); })
      .catch((e) => console.warn('[Plan] shell.openPath threw:', e.message));
  });

  // plan:rescan — re-validate a plan after the user edited it
  ipcMain.on('plan:rescan', async (_event, { planFile, content } = {}) => {
    const planScanner = require('../../stategraph-module/src/utils/planScanner');
    const fs = require('fs');
    const fileToScan = planFile || pendingPlanContext?.planFile;

    let planContent = content;
    if (!planContent && fileToScan) {
      try { planContent = fs.readFileSync(fileToScan, 'utf8'); } catch (_) {}
    }
    if (!planContent) {
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'plan:rescan-result', { errors: ['Could not read plan file'], warnings: [] });
      }
      return;
    }

    // Save updated content if provided inline
    if (content && fileToScan) {
      try { fs.writeFileSync(fileToScan, content, 'utf8'); } catch (e) {
        console.warn('[Plan] plan:rescan could not save file:', e.message);
      }
    }

    const validation = planScanner.validate(planContent);
    const { sanitized, secrets } = planScanner.scan(planContent);

    // Store any newly typed sensitive values
    if (secrets.size > 0) {
      try {
        await planScanner.storeSecrets(secrets, {
          keytarSet: async (svc, key, val) => {
            if (safeStorage.isEncryptionAvailable()) {
              const encrypted = safeStorage.encryptString(String(val));
              await mcpAdapter.callService('user-memory', 'profile.set', {
                key: `credential:${key.toLowerCase()}`,
                valueRef: `SAFE:${encrypted.toString('base64')}`,
              }, { timeoutMs: 4000 }).catch(() => {});
            } else {
              const { spawnSync } = require('child_process');
              spawnSync('security', ['add-generic-password', '-s', svc, '-a', key, '-w', String(val), '-U'], { encoding: 'utf8' });
            }
          },
          mcpAdapter,
          userId: pendingPlanContext?.userId || 'default_user',
          logger: console,
        });
        if (fileToScan) fs.writeFileSync(fileToScan, sanitized, 'utf8');
      } catch (e) {
        console.warn('[Plan] plan:rescan storeSecrets failed:', e.message);
      }
    }

    if (resultsWindow && !resultsWindow.isDestroyed()) {
      safeSend(resultsWindow, 'plan:rescan-result', {
        errors: validation.errors,
        warnings: validation.warnings,
        secretsFound: secrets.size,
        sanitized: secrets.size > 0 ? sanitized : null,
      });
    }
  });

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

  // ─── Maintenance Scan: IPC handlers ──────────────────────────────────────
  const COMMAND_SERVICE_URL = process.env.COMMAND_SERVICE_URL || 'http://127.0.0.1:3007';

  function _scanHttpPost(urlPath, body = {}) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const payload = JSON.stringify(body);
      const parsed = new URL(COMMAND_SERVICE_URL);
      const req = http.request({
        hostname: parsed.hostname,
        port: Number(parsed.port) || 3007,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({}); } });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function _scanHttpGet(urlPath) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const parsed = new URL(COMMAND_SERVICE_URL);
      const req = http.request({
        hostname: parsed.hostname,
        port: Number(parsed.port) || 3007,
        path: urlPath,
        method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({}); } });
      });
      req.on('error', reject);
      req.end();
    });
  }

  ipcMain.on('scan:run', async () => {
    console.log('[MaintenanceScan] User triggered scan');
    try {
      await _scanHttpPost('/scan.run', { trigger: 'user' });
    } catch (err) {
      console.warn('[MaintenanceScan] scan:run failed', err.message);
    }
  });

  ipcMain.on('scan:cancel', async () => {
    console.log('[MaintenanceScan] Cancel requested');
    try {
      await _scanHttpPost('/scan.cancel', {});
    } catch (err) {
      console.warn('[MaintenanceScan] scan:cancel failed', err.message);
    }
  });

  ipcMain.on('scan:schedule', async (_event, { cron, enabled } = {}) => {
    console.log(`[MaintenanceScan] Schedule update: cron=${cron} enabled=${enabled}`);
    try {
      await _scanHttpPost('/scan.schedule', { cron, enabled });
    } catch (err) {
      console.warn('[MaintenanceScan] scan:schedule failed', err.message);
    }
  });

  ipcMain.handle('scan:status', async () => {
    try {
      return await _scanHttpGet('/scan.status');
    } catch (err) {
      console.warn('[MaintenanceScan] scan:status failed', err.message);
      return { ok: false, error: err.message };
    }
  });

  // ─── Auto-scan setting IPC handlers ────────────────────────────────────────
  const osMod = require('os');
  const AUTO_SCAN_SETTINGS_FILE = path.join(osMod.homedir(), '.thinkdrop', 'settings.json');

  function _loadAutoScanSetting() {
    try {
      const fs = require('fs');
      if (fs.existsSync(AUTO_SCAN_SETTINGS_FILE)) {
        const data = JSON.parse(fs.readFileSync(AUTO_SCAN_SETTINGS_FILE, 'utf8'));
        return !!data.autoScanEnabled;
      }
    } catch (_) {}
    return false; // Default: disabled
  }

  function _saveAutoScanSetting(enabled) {
    try {
      const fs = require('fs');
      let data = {};
      if (fs.existsSync(AUTO_SCAN_SETTINGS_FILE)) {
        data = JSON.parse(fs.readFileSync(AUTO_SCAN_SETTINGS_FILE, 'utf8'));
      }
      data.autoScanEnabled = enabled;
      fs.mkdirSync(path.dirname(AUTO_SCAN_SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(AUTO_SCAN_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[AutoScan] Failed to save setting:', err);
    }
  }

  // Get current auto-scan setting (returns { enabled: boolean })
  ipcMain.handle('agents:auto-scan-get', async () => {
    return { enabled: _loadAutoScanSetting() };
  });

  // Set auto-scan enabled/disabled and notify command-service
  ipcMain.on('agents:auto-scan-set', async (_event, { enabled } = {}) => {
    console.log(`[AutoScan] Setting auto-scan enabled=${enabled}`);
    _saveAutoScanSetting(!!enabled);
    // Notify command-service to start/stop idle watcher
    try {
      await _scanHttpPost('/scan.idle-watcher', { enabled: !!enabled });
    } catch (err) {
      console.warn('[AutoScan] Failed to notify command-service:', err.message);
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

      // Forward responses to unifiedWindow:
      // - stategraph: full answer (always send full answer to ensure display)
      // - fast: response text (butler reply — show so user can read what was spoken)
      if (result.lane === 'stategraph' && result.fullAnswer) {
        // Send ws-bridge messages to unifiedWindow (outside resultsWindow guard)
        // Note: removed !result._hadLiveStream check to ensure answer always displays
        console.log(`[MAIN] Sending chunk to unifiedWindow, text length: ${result.fullAnswer?.length || 0}`);
        safeSendUnified('ws-bridge:message', { type: 'chunk', text: result.fullAnswer, lane: 'stategraph' });
        safeSendUnified('ws-bridge:message', { type: 'done', lane: 'stategraph' });
        console.log('[MAIN] Sent chunk and done to unifiedWindow');
        // Show unifiedWindow for results
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          unifiedWindow.showInactive();
          unifiedWindow.moveTop();
        }
        if (result.transcript) safeSendUnified('unified:set-prompt', result.transcript);
      } else if (result.lane === 'fast' && result.responseEnglish && !result.skipped) {
        // Send ws-bridge messages to unifiedWindow (outside resultsWindow guard)
        safeSendUnified('ws-bridge:message', { type: 'chunk', text: result.responseEnglish, lane: 'fast' });
        safeSendUnified('ws-bridge:message', { type: 'done', lane: 'fast' });
        // Show unifiedWindow for results
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          unifiedWindow.showInactive();
          unifiedWindow.moveTop();
        }
        if (result.transcript) safeSendUnified('unified:set-prompt', result.transcript);
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
      if (result.lane === 'stategraph' && result.fullAnswer) {
        // Send ws-bridge messages to unifiedWindow (outside resultsWindow guard)
        // Note: removed !result._hadLiveStream check to ensure answer always displays
        console.log(`[MAIN] Sending chunk to unifiedWindow, text length: ${result.fullAnswer?.length || 0}`);
        safeSendUnified('ws-bridge:message', { type: 'chunk', text: result.fullAnswer, lane: 'stategraph' });
        safeSendUnified('ws-bridge:message', { type: 'done', lane: 'stategraph' });
        console.log('[MAIN] Sent chunk and done to unifiedWindow');
        // Show unifiedWindow for results
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          unifiedWindow.showInactive();
          unifiedWindow.moveTop();
        }
        if (result.transcript) safeSendUnified('unified:set-prompt', result.transcript);
      } else if (result.lane === 'fast' && result.responseEnglish && !result.skipped) {
        // Send ws-bridge messages to unifiedWindow (outside resultsWindow guard)
        safeSendUnified('ws-bridge:message', { type: 'chunk', text: result.responseEnglish, lane: 'fast' });
        safeSendUnified('ws-bridge:message', { type: 'done', lane: 'fast' });
        // Show unifiedWindow for results
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          unifiedWindow.showInactive();
          unifiedWindow.moveTop();
        }
        if (result.transcript) safeSendUnified('unified:set-prompt', result.transcript);
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
        safeSend(promptCaptureWindow, 'gather:pending', { active: false, question: null });
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
    promptQueue.enqueue(prompt.trim(), { selectedText: selectedText || '', responseLanguage: responseLanguage || null, sessionId: sessionId || currentSessionId });
  });

  // ─── StateGraph: Core execution — called by promptQueue serially ─────────
  async function runPromptThroughStateGraph(prompt, { selectedText = '', sessionId = null, userId = 'default_user', responseLanguage = null, promptQueueId = null, _planFile = null, _forceNewPlan = false, _skillPlan = null, _skillPlanFile = null, _planCorrectionMode = false, _planCorrectionText = null, _basePlanFile = null, _skillPlanJson = null, _planCorrectionSourcePrompt = null } = {}) {
    const isPlanExecute = !!_planFile;
    console.log('🧠 [StateGraph] Processing prompt:', prompt.substring(0, 80), responseLanguage ? `(responseLanguage: ${responseLanguage})` : '', isPlanExecute ? `[plan:${require('path').basename(_planFile)}]` : '');

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

    // Send unified:set-prompt so streamingResponse reset arrives at unifiedWindow BEFORE the first token.
    // Skip for skill-plan re-runs — PlanPanel already shows the plan in executing state.
    if (!_skillPlan) safeSendUnified('unified:set-prompt', prompt);

    // Snapshot webContents at handler start — if the window reloads mid-stream the
    // reference becomes stale and safeSend would spam "Render frame was disposed" errors.
    const targetContents = (resultsWindow && !resultsWindow.isDestroyed()) ? resultsWindow.webContents : null;

    // Stream callback: forward each token to unifiedWindow as it arrives.
    let streamingUsed = false;
    const streamCallback = (token) => {
      streamingUsed = true;
      console.log(`[MAIN] streamCallback sending token, length: ${token?.length || 0}`);
      safeSendUnified('ws-bridge:message', { type: 'chunk', text: token });
    };

    // Per-invocation flag: fire queue:started + queue:enqueued only once per stategraph run
    let _queueNotifiedOnce = false;

    // Progress callback: forward automation progress events to ResultsWindow (and prompt window for glow)
    const progressCallback = (event) => {
      const logStr = event.type === 'all_done'
        ? JSON.stringify({ type: event.type, completedCount: event.completedCount, totalCount: event.totalCount, savedFilePaths: event.savedFilePaths })
        : JSON.stringify(event).substring(0, 120);
      console.log(`[ProgressCallback] Event: ${event.type}`, logStr);
      // Plan step debug: log detail for plan step events
      if (event.type === 'plan:step_start') {
        console.log(`[Plan:DEBUG] plan:step_start — stepNum: ${event.stepNum}, totalSteps: ${event.totalSteps}, intent: ${event.intent}, title: ${event.title}`);
      }
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
      // Always forward to unifiedWindow (primary)
      safeSendUnified('automation:progress', event);
      // Legacy: also forward to resultsWindow if it still exists
      if (resultsWindow && !resultsWindow.isDestroyed()) {
        safeSend(resultsWindow, 'automation:progress', event);
      }
      // Forward all_done to promptCaptureWindow so its glow clears
      if (event.type === 'all_done' && promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
        safeSend(promptCaptureWindow, 'automation:progress', event);
      }
      // Plan generated — store pending context for plan:approve re-run
      if (event.type === 'plan:generated') {
        pendingPlanContext = {
          planFile:      event.planFile,
          prompt:        prompt,
          sessionId:     currentSessionId,
          userId:        'default_user',
          selectedText:  selectedText || '',
          skillPlanJson: event.skillPlanJson || null,
        };
        console.log(`[Plan] plan:generated context stored: ${event.planFile}`);
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'automation:progress', { type: 'plan:mode:active', planFile: event.planFile });
        }
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'automation:progress', { type: 'plan:mode:active', planFile: event.planFile });
        }
        // Store pending secrets from planGenerator if any (passed via event via _pendingPlanSecrets)
        // These are already sanitized in the .md file; we just need to persist the values
        // Note: secrets with values are passed only if planGenerator couldn't call keytar directly
      }

      // Existing plan found — store pending context so plan:new can re-run with _forceNewPlan
      if (event.type === 'plan:found_existing') {
        pendingPlanContext = {
          planFile:      event.planFile,
          prompt:        prompt,
          sessionId:     currentSessionId,
          userId:        'default_user',
          selectedText:  selectedText || '',
          skillPlanJson: event.skillPlanJson || null,
        };
        console.log(`[Plan] plan:found_existing context stored: ${event.planFile}`);
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'automation:progress', { type: 'plan:mode:active', planFile: event.planFile });
        }
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'automation:progress', { type: 'plan:mode:active', planFile: event.planFile });
        }
      }

      if (event.type === 'plan:complete') {
        pendingPlanContext = null;
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'complete' });
        }
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'automation:progress', { type: 'plan:mode:cleared', source: 'complete' });
        }
      }

      // _skillPlan approval-gate path never emits plan:complete (only planExecutor.js does).
      // Clear pendingPlanContext on all_done so the next prompt isn't routed as _planCorrectionMode.
      if (event.type === 'all_done') {
        pendingPlanContext = null;
      }

      // needs_skill gap — notify resultsWindow so AutomationProgress shows the capability gap card
      // Do NOT auto-open Skill Store in promptCaptureWindow; user clicks the card button to open it
      if (event.type === 'skill_store_trigger') {
        if (resultsWindow && !resultsWindow.isDestroyed()) {
          safeSend(resultsWindow, 'skill:store-trigger', { capability: event.capability, suggestion: event.suggestion });
        }
      }
      // Phase 3: Long-running task completed — fetch planContext from DuckDB and re-inject
      if (event.type === 'long_task_resume') {
        const _resumeTaskId = event.taskId;
        const _resumeResult = event.result || '';
        const _memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
        const _memKey  = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || '';
        const _envelope = JSON.stringify({
          version: 'mcp.v1', service: 'user-memory',
          action: 'pending_tasks.list', payload: { id: _resumeTaskId },
          requestId: 'resume_' + Date.now(),
        });
        const _req = http.request(
          { hostname: '127.0.0.1', port: _memPort, path: '/pending_tasks.list', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_envelope),
              ...(  _memKey ? { 'Authorization': 'Bearer ' + _memKey } : {}) } },
          (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(raw);
                const task   = parsed.data && parsed.data.tasks && parsed.data.tasks[0];
                if (!task) {
                  console.warn('[LongTaskResume] Task record not found in DuckDB for id:', _resumeTaskId);
                  return;
                }
                const ctx = JSON.parse(task.plan_context || '{}');
                // Inject completed step result into dataContext
                ctx.dataContext  = { ...(ctx.dataContext || {}), [task.step_order]: _resumeResult };
                ctx.intentResults = [
                  ...(ctx.intentResults || []),
                  { step: task.step_order, intent: task.intent, subPrompt: task.sub_prompt, result: _resumeResult },
                ];
                const resumeMessage = (ctx.intentQueue && ctx.intentQueue[0] && ctx.intentQueue[0].text)
                  || task.original_prompt;
                console.log(`[LongTaskResume] Resuming queue after task ${_resumeTaskId} — next: "${resumeMessage.slice(0, 60)}"`);
                if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
                  safeSend(promptCaptureWindow, 'voice:inject-prompt', {
                    message:        resumeMessage,
                    sessionId:      task.session_id || null,
                    source:         'task_resume',
                    _resumeContext: ctx,
                  });
                }
                if (resultsWindow && !resultsWindow.isDestroyed()) {
                  safeSend(resultsWindow, 'automation:progress', {
                    type:    'long_task_resumed',
                    taskId:  _resumeTaskId,
                    step:    task.step_order,
                    intent:  task.intent,
                  });
                }
              } catch (parseErr) {
                console.error('[LongTaskResume] Failed to parse task record:', parseErr.message);
              }
            });
          }
        );
        _req.on('error', (err) => { console.error('[LongTaskResume] HTTP error fetching task:', err.message); });
        _req.write(_envelope);
        _req.end();
        return;
      }
    };
    // Expose for /agent-turn overlay endpoint (real-time sub-agent turn updates)
    activeProgressCallback = progressCallback;

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
    const gatherAnswerCallback = (question) => {
      return new Promise((resolve) => {
        pendingGatherResolve = resolve;
        console.log('[GatherContext] Waiting for user answer…');
        // Tell prompt bar to intercept next submit as gather:answer
        if (promptCaptureWindow && !promptCaptureWindow.isDestroyed()) {
          safeSend(promptCaptureWindow, 'gather:pending', { active: true, question: question || null });
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
    // and resolves with { stored: true, value }.
    // value is returned so callers (e.g. ask_user handler) can propagate it to _gatheredVars
    // for the following profile.store_secret step.  It must NOT be logged or persisted to disk.
    const gatherCredentialCallback = (credentialKey, _opts = {}) => {
      return new Promise((resolve) => {
        // Emit credential prompt to Queue tab via progressCallback
        // The UI shows a CLI-style masked input — user submits via gather:credential IPC
        let pendingCredResolve = resolve;
        const handleCredSubmit = async (_event, { key, value }) => {
          if (key !== credentialKey) return; // not our credential
          ipcMain.off('gather:credential', handleCredSubmit);
          if (!value) { pendingCredResolve({ stored: false, value: null }); return; }
          try {
            if (safeStorage.isEncryptionAvailable()) {
              const encrypted = safeStorage.encryptString(String(value));
              await mcpAdapter.callService('user-memory', 'profile.set', {
                key: `credential:${credentialKey.toLowerCase()}`,
                valueRef: `SAFE:${encrypted.toString('base64')}`,
              }, { timeoutMs: 4000 }).catch(() => {});
            } else {
              const { spawnSync } = require('child_process');
              spawnSync('security', ['add-generic-password', '-s', 'thinkdrop', '-a', credentialKey, '-w', String(value), '-U'], { encoding: 'utf8' });
            }
            console.log(`[GatherContext] Stored credential: ${credentialKey}`);
            pendingCredResolve({ stored: true, value });
          } catch (e) {
            console.error(`[GatherContext] credential store failed for ${credentialKey}:`, e.message);
            pendingCredResolve({ stored: false, value: null, error: e.message });
          }
        };
        ipcMain.on('gather:credential', handleCredSubmit);
        // 10-minute timeout
        setTimeout(() => {
          ipcMain.off('gather:credential', handleCredSubmit);
          if (pendingCredResolve) {
            pendingCredResolve({ stored: false, value: null });
            pendingCredResolve = null;
          }
        }, 10 * 60 * 1000);
      });
    };

    // keytarCheckCallback: checks if a credential already exists in the store
    const keytarCheckCallback = async (credentialKey) => {
      try {
        // Check user_profile table first (new SAFE: entries)
        const profileResult = await mcpAdapter.callService('user-memory', 'profile.get', {
          key: `credential:${credentialKey.toLowerCase()}`,
        }, { timeoutMs: 3000 }).catch(() => null);
        if (profileResult?.data?.valueRef) return { found: true };
        // Fallback: legacy keychain check
        const { spawnSync } = require('child_process');
        const proc = spawnSync('security', ['find-generic-password', '-s', 'thinkdrop', '-a', credentialKey, '-w'], { encoding: 'utf8' });
        return { found: proc.status === 0 && !!proc.stdout?.trim() };
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
        // Scout select responses (provider names like "openai") must never be reclassified
        // as fresh tasks — skip the semantic check entirely for _isScoutSelect pauses.
        let isFreshPrompt = isExpired;

        // ── Part B: Offered-option exact match ──────────────────────────────────
        // When the paused question presented discrete choices and the user's reply
        // matches one of them verbatim, it is ALWAYS a resume answer — never a fresh task.
        // Skips the voice-service semantic check entirely to avoid false-positive fresh classification.
        // e.g. recoverSkill offered ["Set up access via browser", "Install Google API client"]
        // and user replies "Install Google API client" — must be treated as a resume, not new command.
        const _pausedOpts = paused.pendingQuestion?.options;
        const _isOfferedOptionMatch = !isFreshPrompt &&
          Array.isArray(_pausedOpts) && _pausedOpts.length > 0 &&
          _pausedOpts.some(opt => typeof opt === 'string' && opt.trim().toLowerCase() === prompt.trim().toLowerCase());
        if (_isOfferedOptionMatch) {
          console.log(`[StateGraph] ASK_USER resume: prompt exactly matches offered option "${prompt.trim()}" — resuming (skipping semantic check)`);
        }

        if (!isFreshPrompt && !_isOfferedOptionMatch && !paused.pendingQuestion?._isScoutSelect) {
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
          const allowCommandMatch = /^allow\s+"?([a-z0-9._-]+)"?\s+and\s+retry$/i.exec(chosenOption.trim());
          const allowCommandName = (allowCommandMatch?.[1]
            || paused.pendingQuestion?.context?.commandName
            || paused.failedStep?.commandName
            || '').trim();
          const wantsAllowCommand = (!!allowCommandMatch || /^allow\b/i.test(chosenOption.trim()))
            && !!allowCommandName
            && !!(paused.pendingQuestion?.context?.userAllowlistHint || paused.failedStep?.userAllowlistHint);
          if (wantsAllowCommand) {
            try {
              const _fs = require('fs');
              const _path = require('path');
              const allowPath = _path.join(require('os').homedir(), '.thinkdrop', 'allowed-commands.json');
              const allowDir = _path.dirname(allowPath);
              if (!_fs.existsSync(allowDir)) _fs.mkdirSync(allowDir, { recursive: true });

              let existing = [];
              if (_fs.existsSync(allowPath)) {
                const rawAllow = JSON.parse(_fs.readFileSync(allowPath, 'utf8'));
                existing = Array.isArray(rawAllow)
                  ? rawAllow
                  : (Array.isArray(rawAllow?.commands) ? rawAllow.commands : []);
              }

              const normalized = [...new Set(
                [...existing, allowCommandName]
                  .filter((v) => typeof v === 'string')
                  .map((v) => require('path').basename(v.trim()))
                  .filter(Boolean)
              )].sort();
              _fs.writeFileSync(allowPath, JSON.stringify({ commands: normalized }, null, 2), 'utf8');

              console.log(`[StateGraph] ASK_USER resume: allowlisted command "${allowCommandName}" in ${allowPath} — retrying step`);
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
                skillCursor: paused.skillCursor || 0,
                stepRetryCount: 0,
                context: { ...paused.context, sessionId: sessionId || currentSessionId }
              };
            } catch (allowErr) {
              console.error(`[StateGraph] ASK_USER resume: failed to update command allowlist: ${allowErr.message}`);
              if (typeof streamCallback === 'function') {
                streamCallback(`I could not update your command allowlist: ${allowErr.message}`);
              }
              return { success: true, aborted: true };
            }
          } else if (wantsAbort) {
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
            const scoutMatches = paused.pendingQuestion?.context?.scoutMatches || paused.scoutMatches || [];
            const scoutCapability = paused.pendingQuestion?.context?.capability || paused.scoutCapability || '';

            // ── Bare-digits normalization ──────────────────────────────────────
            // If the user typed a raw phone number (e.g. "2676996631") instead of
            // clicking the formatted __sms_gateway__:PHONE button, auto-wrap it so
            // the gateway path activates correctly. Applies when the option contains
            // 10+ digits and has no non-phone characters beyond spaces/dashes/parens.
            if (!chosenOption.startsWith('__sms_gateway__')) {
              const _rawDigits = chosenOption.replace(/[\s\-().+]/g, '').replace(/\D/g, '');
              if (_rawDigits.length >= 10) {
                chosenOption = `__sms_gateway__:${_rawDigits}`;
              }
            }

            if (chosenOption.startsWith('__sms_gateway__:')) {
              // ── Free email-to-SMS gateway path ─────────────────────────────────
              // Format: __sms_gateway__:PHONE or __sms_gateway__:PHONE:CARRIER (manual fallback)
              const parts = chosenOption.split(':');
              const phone = parts[1] || '';
              const carrierHint = parts.slice(2).join(':') || null; // rejoin in case of colons in carrier
              let smsGatewayTarget = null;
              try {
                const { lookupCarrier, getGatewayEmail } = require(
                  require('path').join(__dirname, '../../stategraph-module/src/utils/carrierGateways')
                );
                // Use manual carrier if provided (fallback path), otherwise auto-detect via Numverify
                let carrier = carrierHint || null;
                if (!carrier) {
                  carrier = await lookupCarrier(phone);
                  if (!carrier) console.warn(`[StateGraph] SMS gateway: Numverify returned null for phone=${phone}`);
                }
                if (carrier) {
                  const gatewayEmail = getGatewayEmail(phone, carrier);
                  smsGatewayTarget = { name: 'self', phone, carrier, email: gatewayEmail };
                  console.log(`[StateGraph] SMS gateway selected: phone=${phone} carrier=${carrier} email=${gatewayEmail}`);

                  // ── Persist phone + carrier to user profile so future runs auto-resolve ──
                  // Without this, resolveUserContext never finds the phone on subsequent SMS
                  // tasks and the scout card keeps re-appearing every time.
                  const _UMURL = process.env.USER_MEMORY_URL || 'http://127.0.0.1:3001';
                  const _UMKEY = process.env.USER_MEMORY_API_KEY || '';
                  const _profileSave = (key, value) => fetch(`${_UMURL}/profile.set`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(_UMKEY && { Authorization: `Bearer ${_UMKEY}` }) },
                    body: JSON.stringify({ payload: { key, valueRef: value, service: 'sms_gateway', label: key === 'self:phone' ? 'My phone number' : 'My carrier' }, requestId: `profile-${Date.now()}` }),
                  }).catch(e => console.warn(`[StateGraph] profile.set(${key}) failed:`, e.message));
                  await Promise.all([
                    _profileSave('self:phone', phone),
                    _profileSave('self:phone_carrier', carrier),
                  ]);
                }
              } catch (err) {
                console.error(`[StateGraph] SMS gateway: carrier lookup failed for phone=${phone}:`, err.message);
              }

              if (!smsGatewayTarget) {
                // Re-emit scout_match with error hint + carrier dropdown so user can retry manually
                progressCallback({
                  type: 'scout_match',
                  capability: scoutCapability,
                  suggestion: '',
                  matches: scoutMatches,
                  errorHint: `Could not auto-detect carrier for ${phone}. Please select your carrier manually.`,
                  showCarrierDropdown: true,
                  prefillPhone: phone,
                });
                return { success: true };
              }

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
                smsGatewayTarget,
                forceSkillBuild: false,
                gatherContextSkipped: true,
                skillPlan: null,
                skillCursor: 0,
                stepRetryCount: 0,
                commandExecuted: false,
                context: { ...paused.context, sessionId: sessionId || currentSessionId }
              };
            } else {
              // ── Paid provider select: user picked Twilio, ClickSend, etc. ──────
              // Re-enter at gatherContext with forceSkillBuild=true and gatheredContext pre-set
              // so creatorPlanning fast-path picks it up immediately (no Q&A loop needed).

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
            }
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
          } else if (/^Yes,?\s*build\s+the\s+skill\s+for:\s*/i.test(chosenOption.trim())) {
            // User clicked "Yes, build the skill for: [capability]" from a needs_skill card.
            // Re-submitting that text as a new message would cause planSkills to return
            // needs_skill again → infinite loop.  Instead, restore the ORIGINAL task
            // message and set forceBrowserFallback=true so planSkills converts any
            // remaining needs_skill step to browser.act (attempt via web browser).
            const originalTask = paused.message || chosenOption.replace(/^Yes,?\s*build\s+the\s+skill\s+for:\s*/i, '').trim();
            console.log(`[StateGraph] ASK_USER resume: needs_skill accepted — browser fallback for "${originalTask}"`);
            initialState = {
              ...paused,
              message: originalTask,
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
              skillPlan: null,
              skillCursor: 0,
              stepRetryCount: 0,
              scoutPending: false,
              forceBrowserFallback: true,
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
          } else if (paused.pendingQuestion?._isAgentAskUser && /^yes[,.]?\s+run:\s+/i.test(chosenOption.trim())) {
            // cli.agent embedded an exact command in the option text (e.g. "Yes, run: gh api --method PUT /user/starred/microsoft/vscode").
            // Bypass planSkills entirely via _skillPlan injection — planSkills LLM would
            // semantically re-interpret the literal command back into the original task
            // (e.g. "gh api --method PUT ..." → "star the repo") causing a loop restart.
            const agentCmd = chosenOption.replace(/^yes[,.]?\s+run:\s+/i, '').trim();
            const agentId = paused.pendingQuestion?.agentId
              || paused.skillPlan?.[paused.skillCursor || 0]?.args?.agentId
              || null;
            console.log(`[StateGraph] ASK_USER resume: _isAgentAskUser command confirmed — injecting plan: ${agentId} task="${agentCmd}"`);
            // Reset AutomationProgress for the second run — planSkills _skillPlan fast-path
            // will emit plan_ready to re-init steps, but set-prompt must fire first so
            // handleNewPrompt clears the stale first-run step list and stepOffsetRef.
            safeSendUnified('unified:set-prompt', agentCmd);
            initialState = {
              ...paused,
              message: agentCmd,
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
              // _skillPlan bypasses planSkills LLM (see planSkills.js L255) — used as-is
              _skillPlan: [{
                skill: 'cli.agent',
                args: { action: 'run', agentId, task: agentCmd },
                description: agentCmd,
              }],
              skillPlan: null,
              skillCursor: 0,
              skillResults: [],  // reset — don't carry stale failed steps into reviewExecution
              stepRetryCount: 0,
              context: { ...paused.context, sessionId: sessionId || currentSessionId }
            };
          } else if (paused.pendingQuestion?._isAgentAskUser) {
            // cli.agent (or browser.agent) paused with ask_user and is waiting for the user's
            // decision. Re-run the SAME agent step with the user's answer injected as context.
            //
            // IMPORTANT: Do NOT fall through to the generic replan handler below.
            // That handler sends `message: chosenOption` as a NEW task through service detection —
            // so "Yes, enable the API and retry" → planSkills → detects no known agent for "enable/retry"
            // → builds a wrong agent (e.g. aws.agent) and passes the answer text as its task.
            const _agentId = paused.pendingQuestion?.agentId
              || paused.skillPlan?.[paused.skillCursor || 0]?.args?.agentId
              || null;
            const _stepIdx = paused.skillCursor || 0;
            // Use the original skill that was running (browser.agent stays browser.agent,
            // cli.agent stays cli.agent) — not hardcoded to 'cli.agent'.
            const _resumeSkill = paused.skillPlan?.[_stepIdx]?.skill || 'browser.agent';
            const _originalTask = paused.skillPlan?.[_stepIdx]?.args?.task || paused.message;
            const _priorQuestion = paused.pendingQuestion?.question || '';
            // Inject the Q&A context into the task string so the agent loop resumes with
            // full awareness of what was asked and what the user decided.
            const _taskWithAnswer = `${_originalTask}\n\n[Resume context: You previously asked "${_priorQuestion}". The user answered: "${chosenOption}". Continue from this point based on the user's answer.]`;
            console.log(`[StateGraph] ASK_USER resume: _isAgentAskUser answer "${chosenOption}" — re-running ${_resumeSkill}/${_agentId} with injected context`);
            safeSendUnified('unified:set-prompt', chosenOption);
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
              _skillPlan: [{
                skill: _resumeSkill,
                args: { action: 'run', agentId: _agentId, task: _taskWithAnswer },
                description: paused.skillPlan?.[_stepIdx]?.description || _originalTask,
              }],
              skillPlan: null,
              skillCursor: 0,
              skillResults: [],
              stepRetryCount: 0,
              context: { ...paused.context, sessionId: sessionId || currentSessionId }
            };
          } else if (q?._isGatherPlanQuestion) {
            // ── gatherPlanContext clarification: user answered a pre-planning question ──
            // Merge the answer into planGatheringAnswers and re-enter the graph.
            // The full paused state is preserved so gatherPlanContext resumes in context.
            const _priorAnswers = Array.isArray(paused.planGatheringAnswers) ? paused.planGatheringAnswers : [];
            console.log(`[StateGraph] ASK_USER resume: gatherPlanContext answer "${chosenOption.slice(0, 80)}" — re-entering (round ${paused.planGatheringRound || 1})`);
            initialState = {
              ...paused,
              message: paused.message,
              streamCallback,
              progressCallback,
              confirmInstallCallback,
              confirmGuideCallback,
              isGuideCancelled,
              pendingQuestion: null,
              answer: undefined,
              planGatheringAnswers: [..._priorAnswers, { question: q.question, answer: chosenOption }],
              planGatheringComplete: false,
              // Preserve gather resume flags for parseIntent to detect
              _gatherQuestionPending: paused._gatherQuestionPending,
              _pendingIntent: paused._pendingIntent,
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
          // Plan execution: set when plan:approve re-enqueues with _planFile or _skillPlan
          _planFile: _planFile || null,
          _forceNewPlan: _forceNewPlan || false,
          _skillPlan: _skillPlan || null,
          _skillPlanFile: _skillPlanFile || null,
          _planCorrectionMode: _planCorrectionMode || false,
          _planCorrectionText: _planCorrectionText || null,
          _basePlanFile: _basePlanFile || null,
          _skillPlanJson: _skillPlanJson || null,
          _planCorrectionSourcePrompt: _planCorrectionSourcePrompt || null,
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
      activeProgressCallback = null;

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

      // Auto-trigger OAuth scope repair when a skill fails due to missing/wrong token.
      // recoverSkill sets triggerOAuthRepair: { skillName } — fire the IPC handler which
      // re-scans index.cjs, patches contractMd, and refreshes the Skills tab.
      if (finalState.triggerOAuthRepair?.skillName) {
        const _repairSkill = finalState.triggerOAuthRepair.skillName;
        console.log(`🔧 [OAuth Auto-Repair] Triggering repair for "${_repairSkill}" after OAuth failure`);
        ipcMain.emit('skills:repair-oauth', null, { skillName: _repairSkill });
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
        } else if (q._isOAuthGuidance) {
          // OAuth guidance is informational — no resume state needed.
          // triggerOAuthRepair fires separately; user goes to Skills tab then retries fresh.
          console.log(`[StateGraph] ASK_USER (${intentType}): OAuth guidance — showing message without pausing`);
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'automation:progress', {
              type: 'ask_user',
              question: q.question,
              options: [],
            });
            safeSend(resultsWindow, 'automation:progress', {
              type: 'all_done',
              completedCount: (finalState.skillResults || []).length,
              totalCount: (finalState.skillPlan || []).length,
              skillResults: finalState.skillResults || [],
              savedFilePaths: [],
              answer: '',
            });
          }
        } else {
          // Persist the full state so the next user reply can resume / re-enter
          pausedAutomationState = { ...finalState, _pausedAt: Date.now() };
          console.log(`[StateGraph] ASK_USER (${intentType}): pausing — next prompt will resume`);
          // Skip emitting ask_user for scout provider selections — the ScoutMatchCard in
          // AutomationProgress (rendered from the scout_match progress event) is the correct
          // UI for this. Emitting ask_user here would show a duplicate options card.
          if (resultsWindow && !resultsWindow.isDestroyed() && !q._isScoutSelect) {
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
          // Strip internal routing markers before showing to user
          const cleanAnswer = finalState.answer.replace(/^\[.*?\]\s*/s, '').trim();
          safeSendUnified('ws-bridge:message', { type: 'chunk', text: cleanAnswer });
        }
        // Plan error not caught by progressCallback (e.g. no skillPlan at all)
        if (finalState.planError && !finalState.skillPlan && !finalState.pendingQuestion) {
          if (resultsWindow && !resultsWindow.isDestroyed()) {
            safeSend(resultsWindow, 'automation:progress', { type: 'plan_error', error: finalState.planError });
          }
        }
        // Send all_done for normal completion so AutomationProgress clears evaluating/retrying phases.
        // Skip if paused for ASK_USER — that case sends ask_user above and waits for user reply.
        // Skip if awaiting plan approval — plan:generated is showing the review UI; all_done would override it.
        if (!finalState.pendingQuestion && !finalState.planError && !finalState.awaitingPlanApproval && resultsWindow && !resultsWindow.isDestroyed()) {
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

      // Signal stream end (stops thinking spinner + clears prompt glow)
      safeSendUnified('ws-bridge:message', { type: 'done' });
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
      safeSendUnified('ws-bridge:message', { type: 'chunk', text: msg });
      safeSendUnified('ws-bridge:message', { type: 'done' });
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
    safeSendUnified('ws-bridge:message', { type: 'chunk', text: helpMsg });
    safeSendUnified('ws-bridge:message', { type: 'done' });
    if (promptQueueId) promptQueue.markDone(promptQueueId);
    return true;
  }

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (unifiedWindow) {
      if (unifiedWindow.isVisible()) {
        unifiedWindow.hide();
        stopClipboardMonitoring();
      } else {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        
        // Position unified window at bottom-right of screen (like old ResultsWindow)
        const bounds = unifiedWindow.getBounds();
        const windowWidth = bounds.width || 400;
        const windowHeight = bounds.height || 300;
        const margin = 20;
        const x = screenWidth - windowWidth - margin;
        const y = screenHeight - windowHeight - margin;
        
        console.log(`[Unified Window] Positioning at (${x}, ${y}) - screen: ${screenWidth}x${screenHeight}, window: ${windowWidth}x${windowHeight}`);
        _userHasMovedPanel = false; // Reset on shortcut-show so resize reanchors to bottom-right
        unifiedWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
        unifiedWindow.show();
        unifiedWindow.focus();

        startClipboardMonitoring(true);
        console.log('[Unified Window] Activated via global shortcut.');
      }
    }
  });

  // Backtick PTT — toggle mode: press once to start, press again to stop.
  let pttGlobalActive = false;
  const safeSendToWins = (channel) => {
    if (unifiedWindow && !unifiedWindow.isDestroyed()) {
      try { unifiedWindow.webContents.send(channel); } catch (_) {}
    }
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
      safeSend(unifiedWindow, 'highlights:update', [{ type: 'text', content: tagContent }]);
      sentHighlights.add(tagContent);
    }

    // Restore the original clipboard after a short delay so the tag send completes first
    setTimeout(() => {
      clipboard.writeText(previousClipboard);
      console.log('[Tag Shortcut] Clipboard restored.');
    }, 500);
  });

  // File drop handler — receives files from drag-and-drop in renderer
  ipcMain.on('file-drop', (_event, data) => {
    console.log('[IPC] file-drop received:', data);
    if (data.files && data.files.length > 0) {
      const highlights = data.files.map((f) => {
        const isDir = f.type === '' || f.name.endsWith('/');
        return {
          type: isDir ? 'folder' : 'file',
          content: f.name,
          fullPath: f.path || f.name,
        };
      });
      console.log('[IPC] Sending file-drop:result with highlights:', highlights);
      safeSend(unifiedWindow, 'file-drop:result', { highlights });
    }
  });

  // Native file picker — opens dialog and sends selected paths back to renderer
  ipcMain.on('dialog:open-file', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(unifiedWindow, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      title: 'Select file or folder to tag as context',
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const highlights = result.filePaths.map(fp => ({
        type: 'file',
        content: fp.split('/').pop() || fp,
        fullPath: fp,
      }));
      safeSend(unifiedWindow, 'file-drop:result', { highlights });
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

    safeSendUnified('unified:set-prompt', `Building skill: ${displayName || name}`);
    if (unifiedWindow && !unifiedWindow.isDestroyed()) { unifiedWindow.showInactive(); unifiedWindow.moveTop(); }

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
        safeSendUnified('ws-bridge:message', { type: 'done' });
      } else if (finalState.skillBuildPhase === 'error') {
        safeSend(promptCaptureWindow, 'skill:build-done', { name, ok: false, error: finalState.skillBuildError });
        safeSendUnified('ws-bridge:message', { type: 'done' });
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

  ipcMain.on('window:hide', () => {
    if (unifiedWindow) {
      unifiedWindow.hide();
    }
  });

  ipcMain.on('window:resize', (_e, { width }) => {
    console.log(`[IPC] window:resize called with width: ${width}`);
    console.log(`[DEBUG] window:resize called with width: ${width}`);
    if (unifiedWindow && !unifiedWindow.isDestroyed()) {
      const bounds = unifiedWindow.getBounds();
      console.log(`[IPC] Current bounds:`, bounds);
      console.log(`[DEBUG] Current bounds:`, bounds);
      unifiedWindow.setBounds({ ...bounds, width });
      console.log(`[IPC] Resized to width: ${width}`);
      console.log(`[DEBUG] Resized to width: ${width}`);
    } else {
      console.log('[IPC] unifiedWindow not available');
      console.log('[DEBUG] unifiedWindow not available');
    }
  });

  // Smart resize with position awareness - expands toward center of screen
  ipcMain.on('window:smart-resize', (_e, { width, height, animate = true, keepPosition = false }) => {
    if (!unifiedWindow || unifiedWindow.isDestroyed()) return;
    
    const bounds = unifiedWindow.getBounds();
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const margin = 20;
    let newHeight = Math.min(height || 900, 900);
    // If the user has manually dragged the panel, always keep its position
    const effectiveKeepPosition = keepPosition || _userHasMovedPanel;

    let newX, newY;
    if (effectiveKeepPosition) {
      // Keep current position — only nudge x left if panel would clip off the right screen edge
      newY = Math.min(bounds.y, screenHeight - height - margin);
      newY = Math.max(margin, newY);
      newX = Math.min(bounds.x, screenWidth - width - margin);
      newX = Math.max(margin, newX);
    } else {
      // Original behavior: anchor to screen bottom, adjust for right-side overflow
      const isExpanding = width > 500;
      const isOnRightSide = (bounds.x + bounds.width) > (screenWidth - 100);
      newY = screenHeight - newHeight - margin;
      newX = bounds.x;
      if (isExpanding && isOnRightSide) {
        newX = Math.max(margin, bounds.x - (width - bounds.width));
      }
      newX = Math.max(margin, Math.min(newX, screenWidth - width - margin));
    }

    unifiedWindow.setBounds({ x: Math.round(newX), y: Math.round(newY), width, height: newHeight }, animate);
  });

  // Dynamic height resize based on content (from UnifiedOverlay)
  ipcMain.on('unified:resize-window', (_e, { height }) => {
    if (!unifiedWindow || unifiedWindow.isDestroyed()) return;
    
    const bounds = unifiedWindow.getBounds();
    const { height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const margin = 20;
    
    // Clamp height to reasonable bounds
    const newHeight = Math.min(Math.max(height, 350), 900);
    
    // If user has manually moved the panel, preserve their Y position (grow upward from current bottom)
    // Otherwise reanchor to screen bottom-right
    const newY = _userHasMovedPanel
      ? Math.max(margin, bounds.y + bounds.height - newHeight) // grow upward from current bottom edge
      : screenHeight - newHeight - margin;
    
    console.log(`[Unified Window] Resizing to height: ${newHeight} (y: ${newY}, userMoved: ${_userHasMovedPanel})`);
    unifiedWindow.setBounds({
      x: bounds.x,
      y: newY,
      width: bounds.width,
      height: newHeight
    }, true); // true = animate
  });

  ipcMain.on('window:move', (_e, { x, y }) => {
    if (unifiedWindow && !unifiedWindow.isDestroyed()) {
      _userHasMovedPanel = true;
      unifiedWindow.setPosition(x, y);
    } else {
      console.log('[IPC] unifiedWindow not available');
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

  ipcMain.on('unified:set-prompt', (event, text) => {
    console.log('[Unified] Received set-prompt request.');
    if (unifiedWindow && !unifiedWindow.isDestroyed()) {
      safeSend(unifiedWindow, 'unified:set-prompt', text);
      if (unifiedWindow.webContents.isLoading()) {
        unifiedWindow.webContents.once('did-finish-load', () => {
          safeSend(unifiedWindow, 'unified:set-prompt', text);
          unifiedWindow.showInactive();
        });
      } else {
        unifiedWindow.showInactive();
        unifiedWindow.moveTop();
      }
    } else if (!unifiedWindow) {
      createUnifiedWindow();
    }
  });

  ipcMain.on('results-window:show-error', (_e, errorMessage) => {
    if (unifiedWindow) {
      safeSend(unifiedWindow, 'results-window:display-error', errorMessage);
      unifiedWindow.show();
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

        // If no oauth: is declared but the skill has naked CLIENT_ID/CLIENT_SECRET secrets,
        // infer the OAuth provider. Priority: skill name/description hint > single configured env.
        if (oauthProviders.length === 0 && secretKeys.some(k => /(CLIENT_ID|CLIENT_SECRET)$/i.test(k))) {
          const PROVIDER_HINTS = {
            google:     /google|gcal|gmail|gdrive|gsheet|gslide|youtube|gcp|bigquery/i,
            github:     /github|gh\b|\bgit\b/i,
            microsoft:  /microsoft|outlook|onedrive|azure|sharepoint|teams|msal/i,
            slack:      /slack/i,
            notion:     /notion/i,
            spotify:    /spotify/i,
            dropbox:    /dropbox/i,
            discord:    /discord/i,
            zoom:       /zoom/i,
            atlassian:  /atlassian|jira|confluence/i,
            salesforce: /salesforce/i,
            hubspot:    /hubspot/i,
            twitter:    /twitter|tweet/i,
            linkedin:   /linkedin/i,
            facebook:   /facebook|instagram|meta\b/i,
          };
          const skillLabel = `${row.name || ''} ${full?.description || row.description || ''}`;
          // First try: name/description hint, but only if that provider has creds in env
          let inferred = null;
          for (const [prov, hint] of Object.entries(PROVIDER_HINTS)) {
            const px = prov.toUpperCase();
            if (hint.test(skillLabel) && (process.env[`${px}_CLIENT_ID`] || process.env[`${px}_CLIENT_SECRET`])) {
              inferred = prov;
              break;
            }
          }
          // Fallback: if hint matched nothing, use env only when exactly one provider configured
          if (!inferred) {
            const INFER_CANDIDATES = Object.keys(PROVIDER_HINTS);
            const envConfigured = INFER_CANDIDATES.filter(p => {
              const px = p.toUpperCase();
              return process.env[`${px}_CLIENT_ID`] && process.env[`${px}_CLIENT_SECRET`];
            });
            if (envConfigured.length === 1) inferred = envConfigured[0];
          }
          if (inferred) {
            oauthProviders = [inferred];
            console.log(`[Skills] Inferred oauth provider '${inferred}' for ${row.name} (CLIENT_ID/CLIENT_SECRET secrets, no oauth: declared)`);
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
          // Only suppress CLIENT_ID/CLIENT_SECRET when an oauth: provider is declared.
          // Skills without oauth: may legitimately need these as user-entered secrets.
          if (oauthProviders.length > 0 && /(CLIENT_ID|CLIENT_SECRET|REDIRECT_URI)$/i.test(k)) return false;
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
              // Always overwrite token entries — they expire. Only skip stable creds.
              const isTokenKey = /(ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN)$/i.test(sec);
              if (!isTokenKey && await keytar.getPassword('thinkdrop', sKey).catch(() => null)) continue;
              const sl = sec.toLowerCase();
              let av = null;
              if (sl === 'refresh_token' && gTok.refresh_token) av = gTok.refresh_token;
              else if (sl === 'access_token' && gTok.access_token) av = gTok.access_token;
              else if (sl === 'client_id') av = process.env[`${provUpper}_CLIENT_ID`] || (prov === 'google' ? process.env.GOOGLE_CLOUD_CLIENT_ID : null);
              else if (sl === 'client_secret') av = process.env[`${provUpper}_CLIENT_SECRET`] || (prov === 'google' ? process.env.GOOGLE_CLOUD_CLIENT_SECRET : null);
              if (av) { await keytar.setPassword('thinkdrop', sKey, av); console.log(`[Skills] Auto-populated ${sKey} from global oauth:${prov}`); }
            }
            // Always write ACCESS_TOKEN + REFRESH_TOKEN under skill:<name>:* so shell scripts
            // using `security find-generic-password -a "skill:<name>:ACCESS_TOKEN"` work.
            if (gTok.access_token) {
              await keytar.setPassword('thinkdrop', `skill:${row.name}:ACCESS_TOKEN`, gTok.access_token).catch(() => {});
            }
            if (gTok.refresh_token) {
              await keytar.setPassword('thinkdrop', `skill:${row.name}:REFRESH_TOKEN`, gTok.refresh_token).catch(() => {});
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

        // Check OAuth token status per provider declared in the skill's oauth: frontmatter.
        // Skills must declare oauth_scopes: in contract_md for scope-aware token matching.
        // If no oauth_scopes declared, any valid access/refresh token counts as connected.
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
                try {
                  tokenData = JSON.parse(raw);
                  // Only mark as connected when there's a real access or refresh token.
                  // A blob with only client_id/client_secret (from startup seeding) is
                  // not yet connected — the Connect button should still appear.
                  connected = !!(tokenData.access_token || tokenData.refresh_token);
                  accountHint = tokenData.email || tokenData.account || undefined;
                } catch(_) {}
              }
            } catch(_) {}

            // Auto-populate already handled in pre-pass above
          }
          // tokenKey always per-skill — Connect button stores to a skill-specific key.
          // This prevents the Skills tab from overwriting the global Connections tab token.
          const tokenKey = perSkillKey;
          const requiredScopes = skillOauthScopes[provider];
          // Scope-aware connected check: if the stored token was granted narrower scopes than
          // the skill actually requires, force re-auth so the user grants the correct scopes.
          if (connected && tokenData?.grantedScopes && requiredScopes) {
            const grantedSet = new Set(tokenData.grantedScopes.split(/\s+/).filter(Boolean));
            const missing    = requiredScopes.split(/\s+/).filter(s => s && !grantedSet.has(s));
            if (missing.length > 0) {
              connected = false;
              console.log(`[Skills] Scope mismatch for ${provider} on ${row.name}: missing ${missing.join(' ')}`);
            }
          }
          const scopes = requiredScopes || '';
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
      if (unifiedWindow && !unifiedWindow.isDestroyed()) safeSend(unifiedWindow, 'skills:list', items);
    } catch (e) {
      console.error('[Skills] skills:list failed:', e.message);
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skills:update', []);
      if (unifiedWindow && !unifiedWindow.isDestroyed()) safeSend(unifiedWindow, 'skills:list', []);
    }
  });

  // ─── Agents: list / learn / train / create ────────────────────────────────
  ipcMain.on('agents:list', async () => {
    try {
      const fsMod = require('fs');
      const osMod = require('os');
      const pathMod = require('path');
      
      const agentsDir = pathMod.join(osMod.homedir(), '.thinkdrop', 'agents');
      if (!fsMod.existsSync(agentsDir)) {
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          safeSend(unifiedWindow, 'agents:list', []);
        }
        return;
      }

      const files = fsMod.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
      console.log(`[Agents] Found ${files.length} agent files:`, files);
      
      const agents = files.map(file => {
        try {
          const filePath = pathMod.join(agentsDir, file);
          const content = fsMod.readFileSync(filePath, 'utf8');
          
          // Parse frontmatter
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          const fm = fmMatch ? fmMatch[1] : '';
          
          // Extract fields (handles both old and new format)
          const getField = (key) => {
            const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
            return m ? m[1].trim() : undefined;
          };
          
          // Parse YAML array format: "key:\n  - item1\n  - item2"
          const getYamlArray = (key) => {
            const regex = new RegExp(`^${key}\\s*:\\s*\\n((?:\\s+-\\s+[^\\n]*\\n?)*)`, 'm');
            const m = fm.match(regex);
            if (m && m[1]) {
              return m[1].split('\n')
                .map(l => l.replace(/^\s*-\s*/, '').trim())
                .filter(Boolean);
            }
            return [];
          };
          
          const id = file.replace('.agent.md', '');
          const service = getField('service');
          const startUrl = getField('start_url');
          const domain = getField('domain') || service || (startUrl?.replace(/^https?:\/\//, '').split('/')[0]) || id.replace('.agent', '');
          const type = getField('type') || 'browser';
          
          // Get capabilities from YAML array in frontmatter
          const capabilities = getYamlArray('capabilities');
          const learnedStates = getYamlArray('learned_states');
          
          // Build skills from capabilities
          const skills = capabilities.map(cap => ({
            name: cap,
            status: 'published',
            description: ''
          })).filter(s => s.name && !s.name.includes('computer')); // Filter out generic caps
          
          // Parse status - map to UI status values
          let status = getField('status') || 'pending';
          if (status === 'needs_training') status = 'needs_training';
          if (status === 'healthy') status = 'learned';
          
          return {
            id,
            name: service ? service.charAt(0).toUpperCase() + service.slice(1) : id.replace('.agent', '').replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            domain,
            category: type === 'browser' ? 'Social & Communication' : 'Utility',
            status,
            created: getField('created'),
            lastLearned: getField('last_learned'),
            userGoal: getField('user_goal') || getField('user_goals'),
            learnedStates,
            skills,
            faviconUrl: getField('favicon_url') || `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
          };
        } catch (fileErr) {
          console.error(`[Agents] Error parsing ${file}:`, fileErr.message);
          return null;
        }
      }).filter(Boolean); // Remove null entries from failed parses
      
      console.log(`[Agents] Parsed ${agents.length} agents:`, agents.map(a => a.id));
      
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:list', agents);
      }
    } catch (e) {
      console.error('[Agents] agents:list failed:', e.message);
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:list', []);
      }
    }
  });

  // Agent creation handler - uses browser.agent build_agent for unified creation
  ipcMain.on('agents:create', async (_event, { domain, goal, goals, headed }) => {
    try {
      const pathMod = require('path');
      
      // Generate service key from domain
      const hostname = domain.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      const serviceKey = hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
      const agentId = `${serviceKey}.agent`;

      // Emit immediately so UI can show a loading state — build_agent is async and can take 10-30s
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:creating', { agentId, domain: hostname });
      }
      
      // Normalize goals to array
      const goalsArray = goals || (goal ? [goal] : ['General task automation']);
      
      // Determine category based on goals
      const goalsText = goalsArray.join(' ').toLowerCase();
      let category = 'Utility';
      if (/music|video|stream|watch|listen|play/i.test(goalsText)) category = 'Entertainment & Media';
      else if (/email|message|chat|social|post|share/i.test(goalsText)) category = 'Social & Communication';
      else if (/buy|shop|purchase|order|pay/i.test(goalsText)) category = 'Commerce & Finance';
      else if (/write|create|edit|upload|generate/i.test(goalsText)) category = 'Creation & Contribution';
      else if (/read|browse|search|find|news/i.test(goalsText)) category = 'Consumption & Discovery';
      
      const startUrl = domain.startsWith('http') ? domain : `https://${domain}`;
      
      // Call browser.agent build_agent for unified creation
      const browserAgent = require(pathMod.join(__dirname, '..', '..', 'mcp-services', 'command-service', 'src', 'skills', 'browser.agent.cjs'));
      const buildResult = await browserAgent({ 
        action: 'build_agent', 
        service: serviceKey, 
        startUrl,
        goals: goalsArray,
        force: headed === true, // force rebuild when headed mode requested (debug)
      });
      
      if (!buildResult.ok) {
        if (buildResult.alreadyExists) {
          // Agent already exists — still emit agents:new so UI shows it
          const existingAgent = {
            id: agentId,
            name: hostname.replace(/\b\w/g, l => l.toUpperCase()),
            domain: hostname,
            category,
            status: buildResult.status || 'healthy',
            created: new Date().toISOString(),
            userGoals: goalsArray,
            skills: []
          };
          if (unifiedWindow && !unifiedWindow.isDestroyed()) {
            safeSend(unifiedWindow, 'agents:new', existingAgent);
          }
          return;
        }
        throw new Error(buildResult.error || 'Failed to create agent');
      }
      
      const newAgent = {
        id: agentId,
        name: hostname.replace(/\b\w/g, l => l.toUpperCase()),
        domain: hostname,
        category,
        status: buildResult.status || 'pending',
        created: new Date().toISOString(),
        userGoals: goalsArray,
        skills: []
      };
      
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:new', newAgent);
      }
      
      console.log(`[Agents] Created agent: ${agentId} via browser.agent`);
    } catch (e) {
      console.error('[Agents] agents:create failed:', e.message);
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:error', { message: e.message });
      }
    }
  });

  // Agent learn handler - triggers learn.agent for blocking domain scan
  ipcMain.on('agents:learn', async (_event, { agentId, goals = [], options = {} }) => {
    // Elevate overlay above headed Chromium so it stays visible during auth
    const _bumpOverlay = () => {
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        unifiedWindow.setAlwaysOnTop(true, 'screen-saver', 5);
      }
    };
    const _restoreOverlay = () => {
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        unifiedWindow.setAlwaysOnTop(true, 'floating', 5);
      }
    };

    try {
      console.log(`[Agents] Starting learn mode for ${agentId}`, options);
      
      // Send initial learning status
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:update', { agentId, status: 'learning' });
      }

      _learnSessionActive = true;
      _bumpOverlay();
      
      // Call learn.agent skill
      const learnAgent = require('../../mcp-services/command-service/src/skills/learn.agent.cjs');
      
      const result = await learnAgent.actionLearn({
        agentId,
        goals,
        maxScanDepth: 2,
        options: {
          headed: options.headed || false,  // default headless
        }
      });

      _learnSessionActive = false;
      _restoreOverlay();
      
      if (result.ok) {
        // Send completion update with learned states
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          safeSend(unifiedWindow, 'agents:update', { 
            agentId, 
            status: 'learned',
            learnedStates: result.states,
            stateCount: result.stateCount,
            duration: result.duration
          });
        }
        console.log(`[Agents] Learn complete for ${agentId}: ${result.stateCount} states`);
      } else {
        // Handle error or cancellation
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          safeSend(unifiedWindow, 'agents:update', { 
            agentId, 
            status: result.reason === 'cancelled' ? 'pending' : 'error',
            error: result.error
          });
        }
        console.error(`[Agents] Learn failed for ${agentId}: ${result.error || result.reason}`);
      }
    } catch (e) {
      _learnSessionActive = false;
      _restoreOverlay();
      console.error('[Agents] agents:learn failed:', e.message);
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        safeSend(unifiedWindow, 'agents:update', { 
          agentId, 
          status: 'error',
          error: e.message
        });
      }
    }
  });

  // Agent learn-cancel handler — signals the active learn session to stop
  ipcMain.on('agents:learn-cancel', (_event, { agentId } = {}) => {
    try {
      console.log(`[Agents] Cancel requested for learn session: ${agentId}`);
      // Reset overlay state immediately so panel returns to normal
      _learnSessionActive = false;
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        unifiedWindow.setAlwaysOnTop(true, 'floating', 5);
        safeSend(unifiedWindow, 'agents:learn-progress', {
          type: 'learn:cancelling', agentId, timestamp: Date.now(),
        });
        // Reset the card spinner immediately — don't wait for the async learn unwind
        safeSend(unifiedWindow, 'agents:update', { agentId, status: 'pending' });
      }
      // Mark the session as cancelled in learn.agent
      const learnAgent = require('../../mcp-services/command-service/src/skills/learn.agent.cjs');
      const result = learnAgent.actionCancelLearn({ agentId });
      console.log(`[Agents] Cancel result for ${agentId}:`, result);
    } catch (e) {
      console.error('[Agents] agents:learn-cancel failed:', e.message);
    }
  });

  // Agent train handler - opens training mode
  ipcMain.on('agents:train', async (_event, { agentId }) => {
    try {
      console.log(`[Agents] Starting train mode for ${agentId}`);
      
      // Call trainer.agent skill
      const trainerAgent = require('../../mcp-services/command-service/src/skills/trainer.agent.cjs');
      
      const result = await trainerAgent.actionTrain({ agentId });
      
      if (result.ok) {
        console.log(`[Agents] Training started for ${agentId}`);
      } else {
        console.error(`[Agents] Training failed: ${result.error}`);
        if (unifiedWindow && !unifiedWindow.isDestroyed()) {
          safeSend(unifiedWindow, 'agents:train-error', { agentId, error: result.error });
        }
      }
    } catch (e) {
      console.error('[Agents] agents:train failed:', e.message);
    }
  });

  // Agent train actions
  ipcMain.on('agents:train-answer', async (_event, { agentId, answer, explanation }) => {
    try {
      const trainerAgent = require('../../mcp-services/command-service/src/skills/trainer.agent.cjs');
      await trainerAgent.actionAnswerTeachMe({ agentId, answer, explanation });
    } catch (e) {
      console.error('[Agents] train-answer failed:', e.message);
    }
  });

  ipcMain.on('agents:train-finish', async (_event, { agentId }) => {
    try {
      const trainerAgent = require('../../mcp-services/command-service/src/skills/trainer.agent.cjs');
      await trainerAgent.actionFinishTraining({ agentId });
    } catch (e) {
      console.error('[Agents] train-finish failed:', e.message);
    }
  });

  ipcMain.on('agents:train-cancel', async (_event, { agentId }) => {
    try {
      const trainerAgent = require('../../mcp-services/command-service/src/skills/trainer.agent.cjs');
      await trainerAgent.actionCancelTraining({ agentId });
    } catch (e) {
      console.error('[Agents] train-cancel failed:', e.message);
    }
  });

  ipcMain.on('agents:train-test', async (_event, { agentId, testValues }) => {
    try {
      const trainerAgent = require('../../mcp-services/command-service/src/skills/trainer.agent.cjs');
      await trainerAgent.actionRunSelfTest({ agentId, testValues });
    } catch (e) {
      console.error('[Agents] train-test failed:', e.message);
    }
  });

  ipcMain.on('agents:train-generate', async (_event, { agentId, skillName }) => {
    try {
      const trainerAgent = require('../../mcp-services/command-service/src/skills/trainer.agent.cjs');
      await trainerAgent.actionGenerateSkill({ agentId, skillName });
    } catch (e) {
      console.error('[Agents] train-generate failed:', e.message);
    }
  });

  // Skill test/publish handlers
  ipcMain.on('agents:test-skill', async (_event, { agentId, skillName }) => {
    console.log(`[Agents] Testing skill ${skillName} for ${agentId}`);
    // TODO: Implement skill testing
  });

  ipcMain.on('agents:publish-skill', async (_event, { agentId, skillName }) => {
    console.log(`[Agents] Publishing skill ${skillName} for ${agentId}`);
    // TODO: Implement skill publishing (move from .draft.cjs to .skill.cjs)
  });

  // Agent delete handler — removes all artifacts (descriptor, DuckDB rows, profiles, domain maps)
  ipcMain.on('agents:delete', async (_event, { agentId }) => {
    try {
      console.log(`[Agents] Deleting agent ${agentId} and all artifacts`);
      const { actionDeleteAgent } = require('../../mcp-services/command-service/src/skills/browser.agent.cjs');
      const result = await actionDeleteAgent({ id: agentId });
      if (result.ok) {
        console.log(`[Agents] Deleted ${result.deleted.length} artifacts for ${agentId}`);
        if (result.errors && result.errors.length > 0) {
          console.warn(`[Agents] Delete had non-fatal errors:`, result.errors);
        }
      } else {
        console.error(`[Agents] Delete failed for ${agentId}: ${result.error}`);
      }
      // Always refresh the agents list so UI is in sync
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        ipcMain.emit('agents:list');
      }
    } catch (e) {
      console.error('[Agents] agents:delete failed:', e.message);
      if (unifiedWindow && !unifiedWindow.isDestroyed()) {
        ipcMain.emit('agents:list');
      }
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
      const cronId = skillName;
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

      // 6. Remove from bridge-pending.json — clears any deferred retry that would
      //    re-fire the skill on next restart via reloadBridgePendingRetries().
      try {
        const _bpPath = require('path').join(require('os').homedir(), '.thinkdrop', 'bridge-pending.json');
        if (require('fs').existsSync(_bpPath)) {
          const _bpEntries = JSON.parse(require('fs').readFileSync(_bpPath, 'utf8'));
          const _bpFiltered = Array.isArray(_bpEntries)
            ? _bpEntries.filter(e => e.skillName !== skillName)
            : [];
          require('fs').writeFileSync(_bpPath, JSON.stringify(_bpFiltered, null, 2), 'utf8');
          console.log(`[Skills] Cleared bridge-pending entry for: ${skillName}`);
        }
      } catch (_bpErr) {
        console.warn(`[Skills] Failed to clean bridge-pending.json for ${skillName}:`, _bpErr.message);
      }

      // 7. Remove from in-memory paused set and persisted paused-crons.json.
      //    Without this, the deleted skill lingers in _pausedCrons and would
      //    falsely show as 'paused' if re-created with the same name.
      _pausedCrons.delete(skillName);
      _savePausedCrons();

      // 7b. Remove pre-cached bridge execution plan (written by planSkills at skill-create time).
      //     Without this, a re-created skill of the same name would load the stale plan.
      try {
        const _bridgePlanPath = pathMod.join(osMod.homedir(), '.thinkdrop', 'plans', `bridge.${skillName}.json`);
        if (fsMod.existsSync(_bridgePlanPath)) {
          fsMod.unlinkSync(_bridgePlanPath);
          console.log(`[Skills] Deleted bridge plan: ${_bridgePlanPath}`);
        }
      } catch (_planErr) {
        console.warn(`[Skills] Failed to clean bridge plan for ${skillName}:`, _planErr.message);
      }

      console.log(`[Skills] Deleted skill: ${skillName}`);

      // 8. Inject a system context message so the LLM knows the skill is gone.
      //    Without this, conversation history still contains messages about what
      //    the skill did, causing the LLM to assume it's still active.
      try {
        const _activeSession = currentSessionId;
        if (_activeSession) {
          const _memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
          const _sysMsg = JSON.stringify({
            version: 'mcp.v1', service: 'conversation', action: 'message.add',
            payload: {
              sessionId: _activeSession,
              text: `[System] Skill "${skillName}" was deleted by the user. Any capabilities it provided, and any enforcement rules it implemented, no longer apply. Do not reference or rely on this skill in future responses.`,
              sender: 'system',
              metadata: { event: 'skill_deleted', skillName, timestamp: new Date().toISOString() },
            },
            requestId: `skill_del_${Date.now()}`,
          });
          await new Promise(resolve => {
            const _convPort = parseInt(process.env.CONVERSATION_SERVICE_PORT || '3004', 10);
            const _req = http.request(
              { hostname: '127.0.0.1', port: _convPort, path: '/message.add', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_sysMsg) },
                timeout: 3000 },
              res => { res.resume(); resolve(); }
            );
            _req.on('error', () => resolve());
            _req.on('timeout', () => { _req.destroy(); resolve(); });
            _req.write(_sysMsg);
            _req.end();
          });
          console.log(`[Skills] System context message injected for deleted skill: ${skillName}`);
        }
      } catch (_ctxErr) {
        console.warn(`[Skills] Failed to inject context message for deleted skill: ${_ctxErr.message}`);
      }

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

    // Fallback priority: global oauth:<provider> keytar blob (seeded at startup via seedOAuthCredentials)
    // → skill-specific keytar keys (manual entry). Checking the global blob first ensures
    // we always find client_id/secret even when the user hasn't stored skill-specific creds.
    if ((!clientId || !clientSecret) && keytar) {
      try {
        const globalRaw = await keytar.getPassword('thinkdrop', `oauth:${provider}`).catch(() => null);
        if (globalRaw) {
          const globalBlob = JSON.parse(globalRaw);
          clientId     = clientId     || globalBlob.client_id;
          clientSecret = clientSecret || globalBlob.client_secret;
        }
      } catch (_) {}
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

      // Store token in keytar — include grantedScopes so skills:list can do scope-aware connected checks
      const tokenJson = JSON.stringify({ ...tokenData, email, grantedScopes: scopeStr, storedAt: new Date().toISOString(), issued_at: Math.floor(Date.now() / 1000) });
      if (keytar) await keytar.setPassword('thinkdrop', tokenKey, tokenJson);
      console.log(`[OAuth] Stored ${provider} token for skill ${skillName} → ${tokenKey}${email ? ' (' + email + ')' : ''}`);

      // Also write per-skill token entries so shell scripts can look them up via:
      //   security find-generic-password -s thinkdrop -a "skill:<name>:ACCESS_TOKEN"
      if (keytar && tokenData.access_token) {
        await keytar.setPassword('thinkdrop', `skill:${skillName}:ACCESS_TOKEN`, tokenData.access_token).catch(() => {});
        if (tokenData.refresh_token) {
          await keytar.setPassword('thinkdrop', `skill:${skillName}:REFRESH_TOKEN`, tokenData.refresh_token).catch(() => {});
        }
        console.log(`[OAuth] Wrote skill-scoped tokens for ${skillName}: skill:${skillName}:ACCESS_TOKEN`);
      }

      // Also store in the format external.skill expects for googleapis (token path or env)
      if (provider === 'google') {
        const fsMod = require('fs'); const pathMod = require('path'); const osMod = require('os');
        const tokDir = pathMod.join(osMod.homedir(), '.thinkdrop', 'tokens');
        if (!fsMod.existsSync(tokDir)) fsMod.mkdirSync(tokDir, { recursive: true });
        const safeName = skillName.replace(/[^a-z0-9.-]/g, '-');
        // Include issued_at so loadOAuthEnv can detect expiry without re-reading keytar
        fsMod.writeFileSync(pathMod.join(tokDir, `${safeName}.json`), JSON.stringify({ ...tokenData, issued_at: Math.floor(Date.now() / 1000) }, null, 2), 'utf8');
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
      const http    = require('http');
      const fsMod   = require('fs');
      const pathMod = require('path');
      const osMod   = require('os');
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

      let contractMd = current?.data?.contractMd || '';

      // Fallback 1: read skill.md from disk (skillCreator writes it alongside index.cjs)
      if (!contractMd) {
        const skillMdPath = pathMod.join(osMod.homedir(), '.thinkdrop', 'skills', skillName, 'skill.md');
        try { contractMd = fsMod.readFileSync(skillMdPath, 'utf8'); } catch(_) {}
      }

      // Fallback 2: construct a minimal valid contract so we can at least persist oauth_scopes
      if (!contractMd) {
        const execPath = pathMod.join(osMod.homedir(), '.thinkdrop', 'skills', skillName, 'index.cjs');
        contractMd = `---\nname: ${skillName}\ndescription: ${skillName}\nexec_path: ${execPath}\nexec_type: node\nversion: 1.0.0\ntrigger: ${skillName}\nschedule: on_demand\nsecrets: \n---\n\n# ${skillName}\n`;
        console.warn(`[Skills] skills:update-oauth-scopes — constructed minimal contractMd for ${skillName}`);
      }

      // Parse existing oauth_scopes map from frontmatter
      const fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
      const fm = fmMatch ? fmMatch[1] : '';
      const existingScopesMatch = fm.match(/^oauth_scopes\s*:\s*(.+)$/m);
      const existingOauthMatch  = fm.match(/^oauth\s*:\s*(.+)$/m);
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
        delete scopesMap[provider];
      }

      // Ensure oauth: field includes this provider
      const oauthSet = new Set(existingOauthMatch
        ? existingOauthMatch[1].split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean) : []);
      if (scopes && scopes.trim()) oauthSet.add(provider.toLowerCase());

      const newOauthLine  = oauthSet.size > 0 ? 'oauth: ' + [...oauthSet].join(', ') : null;
      const newScopeLine  = Object.keys(scopesMap).length > 0
        ? 'oauth_scopes: ' + Object.entries(scopesMap).map(([p, s]) => `${p}=${s}`).join(', ')
        : null;

      // Rewrite frontmatter — update both oauth: and oauth_scopes:
      let updatedMd = contractMd;
      // Update oauth: line
      if (newOauthLine) {
        if (existingOauthMatch) {
          updatedMd = updatedMd.replace(/^oauth\s*:.*$/m, newOauthLine);
        } else {
          updatedMd = updatedMd.replace(/(\n---\s*$)/m, `\n${newOauthLine}$1`);
        }
      }
      // Update oauth_scopes: line
      if (existingScopesMatch) {
        updatedMd = newScopeLine
          ? updatedMd.replace(/^oauth_scopes\s*:.*$/m, newScopeLine)
          : updatedMd.replace(/^oauth_scopes\s*:.*\n?/m, '');
      } else if (newScopeLine) {
        if (/^oauth\s*:/m.test(updatedMd)) {
          updatedMd = updatedMd.replace(/^(oauth\s*:.+)$/m, `$1\n${newScopeLine}`);
        } else {
          updatedMd = updatedMd.replace(/(\n---\s*$)/m, `\n${newScopeLine}$1`);
        }
      }

      // Use skill.install (idempotent UPDATE when skill exists; skill.upsert requires execPath)
      const installBody = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.install', payload: { contractMd: updatedMd }, requestId: 'scope-install-' + Date.now() });
      await new Promise(resolve => {
        const req = http.request({
          hostname: '127.0.0.1', port: memPort, path: '/skill.install', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memApiKey}`, 'Content-Length': Buffer.byteLength(installBody) },
        }, res => { res.resume(); resolve(); });
        req.on('error', () => resolve()); req.write(installBody); req.end();
      });

      console.log(`[Skills] Updated oauth_scopes for ${provider} on ${skillName}: ${scopes || '(cleared)'}`);
      ipcMain.emit('skills:list');
    } catch (e) {
      console.error('[Skills] skills:update-oauth-scopes failed:', e.message);
    }
  });

  // ─── Skills: repair-oauth — re-scan index.cjs and fix contract_md scopes ──
  // Direct IPC bypass for the skill repair that parseSkill can't reach reliably.
  ipcMain.on('skills:repair-oauth', async (_event, { skillName }) => {
    try {
      const http    = require('http');
      const fsMod   = require('fs');
      const pathMod = require('path');
      const osMod   = require('os');
      const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || 'default_key';
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);

      const skillDir = pathMod.join(osMod.homedir(), '.thinkdrop', 'skills', skillName);
      const codePath = pathMod.join(skillDir, 'index.cjs');
      const skillMdPath = pathMod.join(skillDir, 'skill.md');
      let code;
      try { code = fsMod.readFileSync(codePath, 'utf8'); } catch(e) {
        // No index.cjs — fall back to scanning skill.md for provider/scope detection
        try { code = fsMod.readFileSync(skillMdPath, 'utf8'); } catch(e2) {
          console.error(`[Skills] repair-oauth: cannot read ${codePath} or ${skillMdPath}: ${e2.message}`);
          if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skills:repair-oauth-result', { skillName, ok: false, error: `Cannot read skill files for ${skillName}` });
          return;
        }
      }

      // Re-run provider detection
      const oauthSet = new Set();
      if (/googleapis|google\.auth|google-auth/i.test(code))         oauthSet.add('google');
      if (/octokit|github\.com\/login\/oauth|@octokit/i.test(code))  oauthSet.add('github');
      if (/microsoft\.com|msal|@azure|graph\.microsoft/i.test(code)) oauthSet.add('microsoft');
      if (/slack\.com|@slack\/web-api|@slack\/bolt/i.test(code))      oauthSet.add('slack');
      if (/notion\.com|@notionhq\/client/i.test(code))               oauthSet.add('notion');
      if (/spotify\.com|spotify-web-api/i.test(code))                oauthSet.add('spotify');
      if (/dropbox\.com|dropbox-sdk|Dropbox\(/i.test(code))          oauthSet.add('dropbox');
      if (/discord\.com|discord\.js|@discordjs/i.test(code))         oauthSet.add('discord');
      if (/zoom\.us|zoomus/i.test(code))                             oauthSet.add('zoom');
      if (/atlassian\.com|jira\.com/i.test(code))                    oauthSet.add('atlassian');
      if (/salesforce\.com|jsforce|@salesforce/i.test(code))         oauthSet.add('salesforce');
      if (/hubspot\.com|@hubspot/i.test(code))                       oauthSet.add('hubspot');
      if (/facebook\.com|graph\.facebook/i.test(code))               oauthSet.add('facebook');
      if (/twitter\.com|api\.twitter/i.test(code))                   oauthSet.add('twitter');
      if (/linkedin\.com|linkedin-api/i.test(code))                  oauthSet.add('linkedin');

      // Scope detection (google only for now — covers gcal.event)
      const scopesMap = {};
      if (oauthSet.has('google')) {
        const gs = new Set(['https://www.googleapis.com/auth/userinfo.email']);
        if (/gmail/i.test(code))    gs.add('https://www.googleapis.com/auth/gmail.modify');
        if (/calendar/i.test(code)) gs.add('https://www.googleapis.com/auth/calendar');
        if (/drive/i.test(code))    gs.add('https://www.googleapis.com/auth/drive');
        if (/sheets/i.test(code))   gs.add('https://www.googleapis.com/auth/spreadsheets');
        if (/docs/i.test(code))     gs.add('https://www.googleapis.com/auth/documents');
        if (/youtube/i.test(code))  gs.add('https://www.googleapis.com/auth/youtube.readonly');
        scopesMap.google = [...gs].join(' ');
      }

      // Fetch existing contractMd
      let contractMd = '';
      await new Promise((resolve) => {
        const b = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.get', payload: { name: skillName }, requestId: 'repair-get-' + Date.now() });
        const req = http.request({
          hostname: '127.0.0.1', port: memPort, path: '/skill.get', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memApiKey}`, 'Content-Length': Buffer.byteLength(b) },
          timeout: 5000,
        }, (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { contractMd = JSON.parse(d)?.data?.contractMd || ''; } catch(_) {} resolve(); }); });
        req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); }); req.write(b); req.end();
      });

      // Fallback: read skill.md from disk
      if (!contractMd) {
        const skillMdPath = pathMod.join(skillDir, 'skill.md');
        try { contractMd = fsMod.readFileSync(skillMdPath, 'utf8'); } catch(_) {}
      }

      // Final fallback: construct minimal valid contract
      if (!contractMd) {
        contractMd = `---\nname: ${skillName}\ndescription: ${skillName}\nexec_path: ${codePath}\nexec_type: node\nversion: 1.0.0\ntrigger: ${skillName}\nschedule: on_demand\nsecrets: \n---\n\n# ${skillName}\n`;
      }

      // Rebuild with corrected oauth: and oauth_scopes: fields
      const fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
      const existingLines = fmMatch ? fmMatch[1].split('\n') : [];
      const filteredLines = existingLines.filter(l => !/^oauth(_scopes)?:\s*/.test(l));
      if (oauthSet.size > 0)            filteredLines.push('oauth: ' + [...oauthSet].join(', '));
      if (Object.keys(scopesMap).length) filteredLines.push('oauth_scopes: ' + Object.entries(scopesMap).map(([p, s]) => `${p}=${s}`).join(', '));
      const bodyAfterFm  = contractMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
      let finalContractMd = ['---', ...filteredLines, '---', '', bodyAfterFm].join('\n');

      // ── Rewrite ## Auth section so planSkills LLM gets the correct token-file
      // pattern instead of copying CLIENT_ID/SECRET keytar refs from old skill.md.
      // This is the key fix: the LLM copies ## Auth verbatim into shell.run scripts.
      if (oauthSet.has('google')) {
        const safeSN = skillName.replace(/[^a-z0-9.-]/g, '-');
        const newAuthBlock = [
          '## Auth',
          `ThinkDrop stores the OAuth access token at \`~/.thinkdrop/tokens/${safeSN}.json\` after the user connects via the Skills tab.`,
          'Always use **double quotes** around all variable expansions — single quotes prevent `$VAR` and `$(...)` from expanding in bash.',
          '```bash',
          `TOKEN_FILE="$HOME/.thinkdrop/tokens/${safeSN}.json"`,
          `ACCESS_TOKEN=$(python3 -c "import json; d=json.load(open('$TOKEN_FILE')); print(d['access_token'])" 2>/dev/null)`,
          'if [ -z "$ACCESS_TOKEN" ]; then',
          `  echo "ERROR: ${skillName} is not connected. Open the Skills tab, find ${skillName}, and click Reconnect."`,
          '  exit 1',
          'fi',
          '# Use in curl: -H "Authorization: Bearer ${ACCESS_TOKEN}"',
          '```',
        ].join('\n');

        const authMarker = '\n## Auth';
        const authStart = finalContractMd.indexOf(authMarker);
        if (authStart >= 0) {
          const nextSection = finalContractMd.indexOf('\n## ', authStart + authMarker.length);
          const before = finalContractMd.slice(0, authStart);
          const after  = nextSection >= 0 ? finalContractMd.slice(nextSection) : '';
          finalContractMd = before + '\n' + newAuthBlock + '\n' + after;
        } else {
          finalContractMd = finalContractMd.trimEnd() + '\n\n' + newAuthBlock + '\n';
        }
      }

      // Write updated skill.md to disk so it persists across reinstalls
      try {
        fsMod.writeFileSync(skillMdPath, finalContractMd, 'utf8');
        console.log(`[Skills] repair-oauth: updated skill.md on disk for ${skillName}`);
      } catch (diskErr) {
        console.warn(`[Skills] repair-oauth: could not write skill.md: ${diskErr.message}`);
      }

      // Install (idempotent UPDATE)
      const installBody = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.install', payload: { contractMd: finalContractMd }, requestId: 'repair-install-' + Date.now() });
      await new Promise(resolve => {
        const req = http.request({
          hostname: '127.0.0.1', port: memPort, path: '/skill.install', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memApiKey}`, 'Content-Length': Buffer.byteLength(installBody) },
          timeout: 8000,
        }, res => { res.resume(); resolve(); });
        req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); }); req.write(installBody); req.end();
      });

      console.log(`[Skills] repair-oauth: ${skillName} → providers=[${[...oauthSet].join(', ')}] scopes=[${Object.keys(scopesMap).join(', ')}]`);
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skills:repair-oauth-result', { skillName, ok: true, providers: [...oauthSet], scopes: scopesMap });
      ipcMain.emit('skills:list');
    } catch (e) {
      console.error('[Skills] skills:repair-oauth failed:', e.message);
      if (resultsWindow && !resultsWindow.isDestroyed()) safeSend(resultsWindow, 'skills:repair-oauth-result', { skillName, ok: false, error: e.message });
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
  // Persisted to ~/.thinkdrop/paused-crons.json so pause survives app restarts.
  // Without persistence, every restart clears _pausedCrons → paused crons come
  // back active and fire immediately on the next scheduled tick.
  const _PAUSED_CRONS_FILE = require('path').join(require('os').homedir(), '.thinkdrop', 'paused-crons.json');
  function _loadPausedCrons() {
    try {
      const raw = require('fs').readFileSync(_PAUSED_CRONS_FILE, 'utf8');
      const names = JSON.parse(raw);
      if (Array.isArray(names)) names.forEach(n => _pausedCrons.add(n));
    } catch (_) { /* file doesn't exist yet — first run */ }
  }
  function _savePausedCrons() {
    try {
      require('fs').mkdirSync(require('path').dirname(_PAUSED_CRONS_FILE), { recursive: true });
      require('fs').writeFileSync(_PAUSED_CRONS_FILE, JSON.stringify([..._pausedCrons], null, 2), 'utf8');
    } catch (_) { /* non-fatal */ }
  }
  const _pausedCrons = new Set();
  _loadPausedCrons(); // restore persisted pause state immediately

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
      // Merge job items into queueManager, preserving any existing run history.
      // Then read back the full state (with runs[]) for the renderer.
      queueManager.mergeCronItems(jobItems);
      const items = [...reminderItems, ...queueManager.getCron()];
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

    // ── Bridge skill plan helpers ─────────────────────────────────────────────

    /**
     * Extract the skill name from a scheduled block ID.
     * e.g. sched_gmail_daily_sms_summary_1776518541617 → gmail.daily.sms.summary
     */
    function _parseBridgeSkillName(blockId) {
      const m = blockId.match(/^sched_(.+?)_(\d{10,15})$/);
      if (!m) return null;
      return m[1].replace(/_/g, '.');
    }

    /**
     * Read YAML frontmatter from a skill.md file into a plain object.
     * Returns {} on any error or missing file.
     */
    function _readSkillFrontmatter(skillName) {
      const skillPath = path.join(require('os').homedir(), '.thinkdrop', 'skills', skillName, 'skill.md');
      try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const m = content.match(/^---\n([\s\S]+?)\n---/);
        if (!m) return {};
        const result = {};
        for (const line of m[1].split('\n')) {
          const kv = line.match(/^([\w_]+):\s*(.+)$/);
          if (kv) result[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
        }
        return result;
      } catch (_) { return {}; }
    }

    /**
     * Load the pre-built execution plan for a bridge skill from disk cache.
     * Returns the cached plan array, or null on cache miss (full pipeline will run).
     */
    function _loadOrInferBridgePlan(skillName) {
      const plansDir = path.join(require('os').homedir(), '.thinkdrop', 'plans');
      const planPath = path.join(plansDir, `bridge.${skillName}.json`);
      try {
        if (fs.existsSync(planPath)) {
          const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
          if (Array.isArray(plan) && plan.length > 0) {
            console.log(`[Bridge Listener] Loaded pre-built plan for ${skillName} (${plan.length} step(s))`);
            return plan;
          }
        }
      } catch (_) {}
      // No cached plan — return null so the full stategraph pipeline runs,
      // which calls list_agents and picks the correct registered agent dynamically.
      console.log(`[Bridge Listener] No cached plan for ${skillName} — full pipeline will plan`);
      return null;
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
              // Wrap in async IIFE so pre-flight await (OAuth token check) works correctly
              (async () => {

              // Resolve skill name + pre-built execution plan (bypasses LLM re-planning)
              const skillName = _parseBridgeSkillName(block.id);
              const _skillPlan = skillName ? _loadOrInferBridgePlan(skillName) : null;

              // Re-hydrate delivery context from skill.md frontmatter so resolveUserContext
              // doesn't need to look up user-memory under 'bridge_auto' userId.
              // sms_gateway_email is written there at plan-write time; sms_gateway_name defaults to 'me'.
              // delivery_email is written for non-SMS email delivery (e.g. send-to-self digest tasks).
              const _skillFm = skillName ? _readSkillFrontmatter(skillName) : {};
              const _bridgeSmsGateway = _skillFm.sms_gateway_email
                ? { email: _skillFm.sms_gateway_email, name: _skillFm.sms_gateway_name || 'me' }
                : undefined;
              // Resolve delivery email: SMS gateway takes priority, then explicit delivery_email frontmatter
              const _bridgeDelivery = _bridgeSmsGateway?.email || _skillFm.delivery_email || null;
              // Patch stale pre-cached plans: if the task is missing the delivery email, append the
              // compose instruction now so the cron fires correctly even before skill re-creation.
              const _patchedSkillPlan = (_bridgeDelivery && Array.isArray(_skillPlan))
                ? _skillPlan.map(step => {
                    if (step.skill === 'browser.agent' && step.args?.task &&
                        !step.args.task.includes(_bridgeDelivery)) {
                      return {
                        ...step,
                        args: {
                          ...step.args,
                          task: `${step.args.task}. Then compose a new email with To: ${_bridgeDelivery}, Subject: Inbox Summary, and the gathered information in the body. Send it.`,
                        },
                      };
                    }
                    return step;
                  })
                : _skillPlan;
              const runId = `run_${Date.now()}`;

              // Register run in queueManager so Cron tab shows live progress.
              // Auto-seed the item from skill.md if not yet in Map (e.g. cron tab never opened).
              if (skillName) {
                if (!queueManager.getCron().find(i => i.id === skillName)) {
                  queueManager.mergeCronItems([{
                    id:       skillName,
                    label:    _skillFm.title || skillName,
                    schedule: _skillFm.schedule || '',
                    type:     _skillFm.type || 'bridge',
                    status:   'active',
                  }]);
                }
                queueManager.recordCronRunStart(skillName, runId);
              }

              // Notify bridge pill — show skill name + running status (no Results window pop)
              if (resultsWindow && !resultsWindow.isDestroyed()) {
                safeSend(resultsWindow, 'bridge:status', {
                  state: 'watching',
                  bridgeFile: BRIDGE_FILE,
                  cronSkillName: skillName,
                  cronStatus: 'running',
                });
              }

              // Use dedicated cron stategraph so user prompts are never blocked
              if (cronStateGraph) {
                const stepIndexMap = new Map();

                const bridgeProgressCallback = (evt) => {
                  // Route step events to queueManager (Cron tab) instead of Results window
                  if (skillName && evt) {
                    if (evt.type === 'step_start' || evt.type === 'step_running') {
                      const idx = stepIndexMap.get(evt.skill) ?? stepIndexMap.size;
                      stepIndexMap.set(evt.skill, idx);
                      queueManager.recordCronStep(skillName, runId, {
                        index: idx,
                        skill: evt.skill || '',
                        description: evt.description || evt.skill || '',
                        status: 'running',
                      });
                    } else if (evt.type === 'step_done') {
                      const idx = stepIndexMap.get(evt.skill) ?? 0;
                      queueManager.recordCronStep(skillName, runId, {
                        index: idx,
                        skill: evt.skill || '',
                        description: evt.description || evt.skill || '',
                        status: 'done',
                        stdout: evt.output ? String(evt.output).slice(0, 500) : undefined,
                      });
                    } else if (evt.type === 'step_failed') {
                      const idx = stepIndexMap.get(evt.skill) ?? 0;
                      queueManager.recordCronStep(skillName, runId, {
                        index: idx,
                        skill: evt.skill || '',
                        description: evt.description || evt.skill || '',
                        status: 'failed',
                        error: evt.error ? String(evt.error).slice(0, 200) : undefined,
                      });
                    } else if (evt.type === 'agent:thought' && evt.thoughts) {
                      // Record live agent thoughts so the Cron tab can show reasoning
                      const idx = evt.stepIndex ?? stepIndexMap.size;
                      queueManager.recordCronStep(skillName, runId, {
                        index: idx,
                        thoughts: String(evt.thoughts).slice(0, 600),
                        phase: evt.phase || 'plan',
                      });
                    }
                  }
                };

                // ── Pre-flight OAuth token check ────────────────────────────────────────
                // If the skill.md frontmatter declares oauth: <provider>, check keytar
                // before executing. If the token is missing, surface the "Connect to
                // {Service}" card in the Results window (via the existing gather_oauth flow)
                // and pause until the user connects or skips.
                const _bridgeOauthProvider = _skillFm.oauth || null;
                const _bridgeOauthTokenKey = _bridgeOauthProvider ? `oauth:${_bridgeOauthProvider}` : null;
                if (_bridgeOauthProvider && _bridgeOauthTokenKey) {
                  const _kt = (() => { try { return require('keytar'); } catch(_) { return null; } })();
                  const _existingToken = _kt ? await _kt.getPassword('thinkdrop', _bridgeOauthTokenKey).catch(() => null) : null;
                  if (!_existingToken) {
                    console.log(`[Bridge Listener] OAuth token missing for ${_bridgeOauthProvider} — surfacing connect card`);
                    if (resultsWindow && !resultsWindow.isDestroyed()) {
                      safeSend(resultsWindow, 'automation:progress', {
                        type: 'gather_oauth',
                        provider: _bridgeOauthProvider,
                        tokenKey: _bridgeOauthTokenKey,
                        scopes: _skillFm.oauth_scopes || '',
                        skillName: skillName || _bridgeOauthProvider,
                      });
                    }
                    // Wait for user to connect or skip — reuse existing gather IPC events
                    await new Promise((resolveOAuth) => {
                      let settled = false;
                      const settle = () => { if (!settled) { settled = true; ipcMain.off('gather:oauth_connect', onConnect); ipcMain.off('gather:oauth_skip', onSkip); resolveOAuth(); } };
                      const onConnect = async (_ev, { provider: p, tokenKey: tk, scopes, skillName: sn }) => {
                        if (p !== _bridgeOauthProvider) return;
                        ipcMain.emit('skills:oauth-connect', null, { skillName: sn || p, provider: p, tokenKey: tk, scopes });
                        // Poll until token lands then notify the UI
                        const _pollKt = (() => { try { return require('keytar'); } catch(_) { return null; } })();
                        let _attempts = 0;
                        const _poll = setInterval(async () => {
                          _attempts++;
                          try {
                            const _val = _pollKt && await _pollKt.getPassword('thinkdrop', tk);
                            if (_val) {
                              clearInterval(_poll);
                              if (resultsWindow && !resultsWindow.isDestroyed()) {
                                safeSend(resultsWindow, 'automation:progress', { type: 'gather_oauth_connected', provider: p, tokenKey: tk });
                              }
                              settle();
                            }
                          } catch (_) {}
                          if (_attempts >= 120) { clearInterval(_poll); settle(); }
                        }, 1000);
                      };
                      const onSkip = (_ev, { provider: p }) => { if (p === _bridgeOauthProvider) settle(); };
                      ipcMain.on('gather:oauth_connect', onConnect);
                      ipcMain.on('gather:oauth_skip', onSkip);
                      setTimeout(settle, 10 * 60 * 1000); // 10-min hard timeout
                    });
                  }
                }

                const initialState = {
                  message: block.body,
                  selectedText: '',
                  // Only pre-wire the plan if cache hit — on miss, full pipeline runs
                  // so planSkills calls list_agents and picks the correct agent dynamically.
                  // _patchedSkillPlan heals any stale task (missing delivery email) without skill re-creation.
                  ...(_patchedSkillPlan && _patchedSkillPlan.length ? { _skillPlan: _patchedSkillPlan } : {}),
                  // Delivery context from skill.md frontmatter — avoids user-memory lookup
                  // under 'bridge_auto' userId which would miss real user's stored gateway.
                  ...((_bridgeSmsGateway) ? { smsGatewayTarget: _bridgeSmsGateway } : {}),
                  // Inject delivery_email as resolvedSelfContext.email so planSkills _buildBridgeReminderPlan
                  // can resolve _selfEmail when re-planning (full pipeline path, no cached plan).
                  ...(_skillFm.delivery_email && !_bridgeSmsGateway
                    ? { resolvedSelfContext: { email: _skillFm.delivery_email } }
                    : {}),
                  streamCallback: () => {}, // bridge cron output not streamed to UI
                  progressCallback: bridgeProgressCallback,
                  confirmInstallCallback: () => Promise.resolve(false),
                  confirmGuideCallback: () => Promise.resolve(false),
                  isGuideCancelled: () => false,
                  activeBrowserSessionId: null,
                  activeBrowserUrl: null,
                  context: { sessionId: null, userId: 'bridge_auto', source: 'bridge_listener', blockId: block.id },
                };

                activeCronProgressCallback = bridgeProgressCallback;
                cronStateGraph.execute(initialState).then((finalState) => {
                  activeCronProgressCallback = null;
                  console.log(`✅ [Bridge Listener] Done executing block ${block.id}`);
                  markBridgeBlockDone(block.id);
                  if (skillName) queueManager.recordCronRunDone(skillName, runId, 'done');
                  // Cache the executed plan so subsequent cron fires skip re-planning.
                  // Only write when the pipeline produced a plan (not a cached hit that was
                  // already on disk — avoids a pointless write with identical content).
                  if (skillName && !_patchedSkillPlan && finalState?.skillPlan?.length > 0) {
                    try {
                      const _plansDir = path.join(require('os').homedir(), '.thinkdrop', 'plans');
                      fs.mkdirSync(_plansDir, { recursive: true });
                      fs.writeFileSync(
                        path.join(_plansDir, `bridge.${skillName}.json`),
                        JSON.stringify(finalState.skillPlan, null, 2), 'utf8'
                      );
                      console.log(`[Bridge Listener] Cached plan for ${skillName} (${finalState.skillPlan.length} step(s))`);
                    } catch (_) {}
                  }
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    safeSend(resultsWindow, 'bridge:status', {
                      state: 'watching',
                      bridgeFile: BRIDGE_FILE,
                      cronSkillName: skillName,
                      cronStatus: 'done',
                    });
                  }
                }).catch(err => {
                  activeCronProgressCallback = null;
                  console.error(`❌ [Bridge Listener] Error executing block ${block.id}:`, err.message);
                  markBridgeBlockDone(block.id, 'error');
                  if (skillName) queueManager.recordCronRunDone(skillName, runId, 'failed');
                  if (resultsWindow && !resultsWindow.isDestroyed()) {
                    safeSend(resultsWindow, 'bridge:status', {
                      state: 'watching',
                      bridgeFile: BRIDGE_FILE,
                      cronSkillName: skillName,
                      cronStatus: 'failed',
                    });
                  }
                });
              }
              })().catch(err => console.error(`[Bridge Listener] Async block error [${block.id}]:`, err.message));
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

            const skillName = _parseBridgeSkillName(block.id);
            const _skillPlan = skillName ? _loadOrInferBridgePlan(skillName, block.body) : null;
            const runId = `run_${Date.now()}`;

            if (skillName) {
              if (!queueManager.getCron().find(i => i.id === skillName)) {
                const _startupFm = _readSkillFrontmatter(skillName);
                queueManager.mergeCronItems([{
                  id:       skillName,
                  label:    _startupFm.title || skillName,
                  schedule: _startupFm.schedule || '',
                  type:     _startupFm.type || 'bridge',
                  status:   'active',
                }]);
              }
              queueManager.recordCronRunStart(skillName, runId);
            }
            if (resultsWindow && !resultsWindow.isDestroyed()) {
              safeSend(resultsWindow, 'bridge:status', {
                state: 'watching',
                bridgeFile: BRIDGE_FILE,
                cronSkillName: skillName,
                cronStatus: 'running',
              });
            }
            if (cronStateGraph) {
              const stepIndexMap = new Map();
              cronStateGraph.execute({
                message: block.body,
                selectedText: '',
                _skillPlan: _skillPlan || undefined,
                streamCallback: () => {},
                progressCallback: (evt) => {
                  if (skillName && evt) {
                    if (evt.type === 'step_start' || evt.type === 'step_running') {
                      const idx = stepIndexMap.get(evt.skill) ?? stepIndexMap.size;
                      stepIndexMap.set(evt.skill, idx);
                      queueManager.recordCronStep(skillName, runId, { index: idx, skill: evt.skill || '', description: evt.description || evt.skill || '', status: 'running' });
                    } else if (evt.type === 'step_done') {
                      const idx = stepIndexMap.get(evt.skill) ?? 0;
                      queueManager.recordCronStep(skillName, runId, { index: idx, skill: evt.skill || '', description: evt.description || evt.skill || '', status: 'done', stdout: evt.output ? String(evt.output).slice(0, 500) : undefined });
                    } else if (evt.type === 'step_failed') {
                      const idx = stepIndexMap.get(evt.skill) ?? 0;
                      queueManager.recordCronStep(skillName, runId, { index: idx, skill: evt.skill || '', description: evt.description || evt.skill || '', status: 'failed', error: evt.error ? String(evt.error).slice(0, 200) : undefined });
                    }
                  }
                },
                confirmInstallCallback: () => Promise.resolve(false),
                confirmGuideCallback: () => Promise.resolve(false),
                isGuideCancelled: () => false,
                activeBrowserSessionId: null,
                activeBrowserUrl: null,
                context: { sessionId: null, userId: 'bridge_auto', source: 'bridge_startup', blockId: block.id },
              }).then(() => {
                console.log(`✅ [Bridge Listener] Startup: done with block ${block.id}`);
                markBridgeBlockDone(block.id);
                if (skillName) queueManager.recordCronRunDone(skillName, runId, 'done');
                if (resultsWindow && !resultsWindow.isDestroyed()) {
                  safeSend(resultsWindow, 'bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE, cronSkillName: skillName, cronStatus: 'done' });
                }
              }).catch(err => {
                console.error(`❌ [Bridge Listener] Startup: error on block ${block.id}:`, err.message);
                markBridgeBlockDone(block.id, 'error');
                if (skillName) queueManager.recordCronRunDone(skillName, runId, 'failed');
                if (resultsWindow && !resultsWindow.isDestroyed()) {
                  safeSend(resultsWindow, 'bridge:status', { state: 'watching', bridgeFile: BRIDGE_FILE, cronSkillName: skillName, cronStatus: 'failed' });
                }
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
          // Skip pending non-TD blocks — they need to be executed.
          // Exception: stale sched_ blocks older than 10 min are skipped to avoid
          // replaying a backlog of accumulated cron fires from prior sessions.
          if (b.prefix !== 'TD' && b.status === 'pending') {
            const schedMatch = b.id.match(/_(\d{10,15})$/);
            if (schedMatch && Date.now() - parseInt(schedMatch[1], 10) > 10 * 60 * 1000) {
              bridgeSeenIds.add(b.id); // stale — skip silently
            }
            return;
          }
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
  stopCryptoBridge();
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
    createUnifiedWindow();
    if (unifiedWindow) unifiedWindow.hide();
  }
});
