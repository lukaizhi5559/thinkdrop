import React, { useState, useEffect, useRef } from 'react';
import { ThinkDropLogo } from './SlideoutDrawer';
import { ScreenStage } from './screen/ScreenStage';

const ipcRenderer = (window as any).electron?.ipcRenderer;
// Listener token — untokened listeners can't be removed across contextBridge.
const GHOST_TOKEN = 'ghost-layer';

type AnimState = 'enter' | 'pulse' | 'active' | 'exit';
type HighlightRole = 'panel' | 'scroll_active';

interface HighlightElement {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
  role?: HighlightRole;
  animState?: AnimState;
  id?: number;
}

interface HighlightData {
  type: 'highlight' | 'clear' | 'scanning_start' | 'scanning_complete' | 'highlight_update'
    | 'progress_drop' | 'capture_begin' | 'capture_end' | 'progress_clear'
    | 'boundary_set' | 'boundary_clear' | 'control_lock' | 'control_unlock';
  elements?: HighlightElement[];
  duration?: number;
  cx?: number;
  cy?: number;
  role?: HighlightRole;
  // progress_drop fields
  label?: string;
  stepNum?: number | null;
  totalSteps?: number | null;
  // control_lock fields
  taskId?: string | null;
  // boundary_set fields (persistent app-window border for the whole plan)
  element?: HighlightElement;
}

interface ProgressDropState {
  label: string;
  stepNum?: number | null;
  totalSteps?: number | null;
}

let _highlightIdCounter = 0;

/**
 * GhostLayer - Transparent overlay for visual UI element highlighting
 * 
 * Displays bounding boxes around detected UI elements with labels.
 * Used by app.agent to show what elements are being detected/interacted with.
 * 
 * Features:
 * - Transparent click-through background
 * - Colored bounding boxes with labels
 * - Auto-clear after duration
 * - IPC communication with main process
 */
function GhostLayer() {
  const [highlights, setHighlights] = useState<HighlightElement[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanTimer, setScanTimer] = useState(0);
  const scanStartTime = useRef<number | null>(null);
  const timerInterval = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Progress "drop" — a ThinkDrop-styled bubble shown during capture-heavy
  // app.agent steps in place of the (OCR-tainting) main panel. It fades out
  // during each screenshot (capture_begin) and back in afterwards (capture_end).
  const [drop, setDrop] = useState<ProgressDropState | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const captureReadyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persistent app-window boundary owned by the drop session (main.js). Unlike
  // BoundingBox highlights (which auto-exit after ~7s), this border stays up for
  // the entire plan and only dims during each screenshot (capture_begin) so it
  // never taints OCR, then restores (capture_end). Cleared on the terminal event.
  const [boundary, setBoundary] = useState<HighlightElement | null>(null);

  // "AI in Control" lock — glowing fullscreen border + cancel pill shown while
  // an input-driving step runs (main.js arms it via control_lock). lockVisible
  // follows the capture_begin/end fade like the boundary so it never taints OCR.
  const [controlLock, setControlLock] = useState<{ taskId: string | null; label: string } | null>(null);
  const [lockVisible, setLockVisible] = useState(false);

  // Camera-flash overlay — briefly brightens the screen during screenshots.
  // Triggered by /overlay/flash (main.js) before a screen capture, cleared by
  // /overlay/unflash after. Gives the user visual feedback that a screenshot
  // is being taken while the UnifiedOverlay is briefly hidden.
  const [flash, setFlash] = useState(false);

  // Screen-output displays (ScreenStage) — the "screen as an output" channel.
  // Reported upward so we can tell main when the window is truly empty.
  const [screenOccupied, setScreenOccupied] = useState(false);

  // Filler-library warmup — "Warming up marin's voice — 43/126". Shown while
  // the voice-service batch-generates the cached voice clips in the background.
  const [fillerProgress, setFillerProgress] = useState<{ done: number; total: number; voiceKey?: string } | null>(null);
  const fillerClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Voice sleep mode — pulsing "ThinkDrop is sleeping" pill; SR keeps running
  // server-side but only wake phrases get through.
  const [voiceSleeping, setVoiceSleeping] = useState(false);
  // Voice session startup — the hidden Chrome launch takes a few seconds;
  // this pill covers that dead air ("Starting voice…").
  const [voiceStarting, setVoiceStarting] = useState(false);
  // Selection context — pill shown while a text selection is armed for the
  // next prompt (main captures the text at submit time).
  const [selectionCtx, setSelectionCtx] = useState(false);

  // Track previous state for conditional logging
  const prevState = useRef({ highlights: 0, isVisible: false, isScanning: false });

  // Auto-clear when all highlights have exited
  useEffect(() => {
    if (highlights.length > 0 && highlights.every(h => h.animState === 'exit')) {
      const t = setTimeout(() => {
        setHighlights([]);
        setIsVisible(false);
      }, 800);
      return () => clearTimeout(t);
    }
  }, [highlights]);

  // Listen for highlight events from main process
  useEffect(() => {
    console.log('[GhostLayer] useEffect running, ipcRenderer exists:', !!ipcRenderer);
    if (!ipcRenderer) {
      console.error('[GhostLayer] ERROR: ipcRenderer not available!');
      return;
    }

    console.log('[GhostLayer] Registering IPC listener for app-agent:highlight');

    const handleHighlight = (data: HighlightData) => {
      console.log('[GhostLayer] IPC event received:', data.type, data.elements?.length, 'elements');
      if (data.type === 'scanning_start') {
        setIsScanning(true);
        setIsVisible(true);
        scanStartTime.current = Date.now();
        
        // Start timer
        timerInterval.current = setInterval(() => {
          if (scanStartTime.current) {
            const elapsed = (Date.now() - scanStartTime.current) / 1000;
            setScanTimer(elapsed);
          }
        }, 100);
      } else if (data.type === 'scanning_complete') {
        setIsScanning(false);
        if (timerInterval.current) {
          clearInterval(timerInterval.current);
          timerInterval.current = null;
        }
      } else if (data.type === 'highlight' && data.elements) {
        console.log('[GhostLayer] Setting highlights:', data.elements.length);
        const stamped = data.elements.map(el => ({
          ...el,
          id: ++_highlightIdCounter,
          role: (el.role || 'panel') as HighlightRole,
          animState: 'enter' as AnimState,
        }));
        setHighlights(stamped);
        setIsVisible(true);
        setIsScanning(false);
        if (timerInterval.current) {
          clearInterval(timerInterval.current);
          timerInterval.current = null;
        }
        console.log('[GhostLayer] isVisible set to true');
      } else if (data.type === 'highlight_update' && data.cx != null && data.cy != null) {
        // Confirmed scroll region: turn green + active; dismiss others
        setHighlights(prev => prev.map(h => {
          const centerX = h.x + h.width / 2;
          const centerY = h.y + h.height / 2;
          const dist = Math.hypot(centerX - data.cx!, centerY - data.cy!);
          const isMatch = dist < Math.max(h.width, h.height) / 2 + 20;
          return {
            ...h,
            role: isMatch ? ('scroll_active' as HighlightRole) : h.role,
            color: isMatch ? '#00ff00' : h.color,
            animState: isMatch ? ('active' as AnimState) : ('exit' as AnimState),
          };
        }));
      } else if (data.type === 'progress_drop') {
        // Show / update the ThinkDrop progress drop for a capture-heavy step.
        setDrop({
          label: data.label || 'Working…',
          stepNum: data.stepNum ?? null,
          totalSteps: data.totalSteps ?? null,
        });
        setDropVisible(true);
      } else if (data.type === 'control_lock') {
        setControlLock({ taskId: data.taskId ?? null, label: data.label || 'AI in Control' });
        setLockVisible(true);
      } else if (data.type === 'control_unlock') {
        setControlLock(null);
        setLockVisible(false);
      } else if (data.type === 'capture_begin') {
        // Fade the drop out, then signal the main process that the screenshot
        // can fire (the drop is now invisible → clean OCR). The opacity
        // transition is 0.4s; we send ready just after it completes. The main
        // process also has its own timeout fallback.
        setDropVisible(false);
        setLockVisible(false);
        if (captureReadyTimer.current) clearTimeout(captureReadyTimer.current);
        captureReadyTimer.current = setTimeout(() => {
          ipcRenderer?.send('ghostlayer:capture-ready');
        }, 420);
      } else if (data.type === 'capture_end') {
        // Screenshot done — fade the drop back in.
        if (captureReadyTimer.current) {
          clearTimeout(captureReadyTimer.current);
          captureReadyTimer.current = null;
        }
        setDropVisible(true);
        setLockVisible(true); // harmless if no lock — it only renders when set
      } else if (data.type === 'boundary_set' && data.element) {
        // Persistent app-window border for the whole plan (drop-session owned).
        setBoundary(data.element);
        setDropVisible(true);
      } else if (data.type === 'boundary_clear') {
        setBoundary(null);
      } else if (data.type === 'progress_clear') {
        if (captureReadyTimer.current) {
          clearTimeout(captureReadyTimer.current);
          captureReadyTimer.current = null;
        }
        setDrop(null);
        setDropVisible(false);
        setBoundary(null);
        setControlLock(null);
        setLockVisible(false);
      } else if (data.type === 'clear') {
        setHighlights([]);
        setIsVisible(false);
        setIsScanning(false);
        if (timerInterval.current) {
          clearInterval(timerInterval.current);
          timerInterval.current = null;
        }
      }
    };

    ipcRenderer.on('app-agent:highlight', handleHighlight, GHOST_TOKEN);
    console.log('[GhostLayer] IPC listener registered');

    return () => {
      ipcRenderer.removeListenerByToken('app-agent:highlight', GHOST_TOKEN);
      if (timerInterval.current) {
        clearInterval(timerInterval.current);
      }
    };
  }, []);

  // Camera-flash IPC listener — triggered by /overlay/flash (main.js)
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleFlash = () => setFlash(true);
    const handleUnflash = () => setFlash(false);
    ipcRenderer.on('ghostlayer:flash', handleFlash, GHOST_TOKEN);
    ipcRenderer.on('ghostlayer:unflash', handleUnflash, GHOST_TOKEN);
    return () => {
      ipcRenderer.removeListenerByToken('ghostlayer:flash', GHOST_TOKEN);
      ipcRenderer.removeListenerByToken('ghostlayer:unflash', GHOST_TOKEN);
    };
  }, []);

  // Voice filler warmup progress — pill lingers briefly after completion.
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleProgress = (data: { done: number; total: number; complete?: boolean; voiceKey?: string }) => {
      if (fillerClearTimer.current) { clearTimeout(fillerClearTimer.current); fillerClearTimer.current = null; }
      const finished = !!data?.complete || (data?.total > 0 && data?.done >= data?.total);
      if (finished) {
        setFillerProgress({ done: data.total, total: data.total, voiceKey: data.voiceKey });
        fillerClearTimer.current = setTimeout(() => setFillerProgress(null), 1600);
      } else if (data?.total > 0) {
        setFillerProgress({ done: data.done, total: data.total, voiceKey: data.voiceKey });
      }
    };
    ipcRenderer.on('voice:filler-progress', handleProgress, GHOST_TOKEN);
    return () => {
      ipcRenderer.removeListenerByToken('voice:filler-progress', GHOST_TOKEN);
      if (fillerClearTimer.current) clearTimeout(fillerClearTimer.current);
    };
  }, []);

  // Voice sleep state — keeps the ghost window occupied while asleep.
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleSleep = (data: { sleeping?: boolean }) => setVoiceSleeping(!!data?.sleeping);
    ipcRenderer.on('voice:sleep-state', handleSleep, GHOST_TOKEN);
    return () => {
      ipcRenderer.removeListenerByToken('voice:sleep-state', GHOST_TOKEN);
    };
  }, []);

  // Selection armed/disarmed — keeps the ghost window occupied while the
  // "Text Highlighted Context" pill is up.
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleSel = (data: { armed?: boolean }) => setSelectionCtx(!!data?.armed);
    ipcRenderer.on('selection:armed', handleSel, GHOST_TOKEN);
    return () => {
      ipcRenderer.removeListenerByToken('selection:armed', GHOST_TOKEN);
    };
  }, []);

  // Voice session state — 'starting' shows a pill until the worker is live.
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleVoiceState = (data: { state?: string }) => {
      const s = data?.state;
      if (s === 'starting') setVoiceStarting(true);
      else if (s === 'listening' || s === 'talking' || s === 'speaking' || s === 'sleeping' ||
               s === 'idle' || s === 'disconnected' || s === 'error') {
        setVoiceStarting(false);
      }
    };
    ipcRenderer.on('voice:state', handleVoiceState, GHOST_TOKEN);
    return () => {
      ipcRenderer.removeListenerByToken('voice:state', GHOST_TOKEN);
    };
  }, []);

  // Clear highlights on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHighlights([]);
        setIsVisible(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (timerInterval.current) {
        clearInterval(timerInterval.current);
      }
    };
  }, []);

  // Only log when state meaningfully changes
  useEffect(() => {
    const stateChanged = 
      highlights.length !== prevState.current.highlights ||
      isVisible !== prevState.current.isVisible ||
      isScanning !== prevState.current.isScanning;
    
    if (stateChanged) {
      console.log('[GhostLayer] State change - isVisible:', isVisible, 'isScanning:', isScanning, 'highlights:', highlights.length);
      prevState.current = { highlights: highlights.length, isVisible, isScanning };
    }
  }, [isVisible, isScanning, highlights.length]);

  // Tell main when the window goes fully idle — highlights gone, not scanning,
  // no drop/boundary, and no screen-output displays. Main then hides the
  // window + clears its display tracking (restores click-through).
  const ghostOccupied = screenOccupied || isVisible || isScanning || !!drop || !!boundary || !!controlLock || !!fillerProgress || voiceSleeping || voiceStarting || selectionCtx;
  const prevOccupied = useRef(ghostOccupied);
  useEffect(() => {
    if (prevOccupied.current && !ghostOccupied) {
      ipcRenderer?.send('ghostlayer:display-idle');
    }
    prevOccupied.current = ghostOccupied;
  }, [ghostOccupied]);

  // Screen-output stage — the "screen as an output" channel. Mounted as an
  // always-on sibling (not gated by isScanning/isVisible) so displays work
  // with zero highlights and alerts can preempt the scan UI.
  const stageNode = <ScreenStage onOccupancyChange={setScreenOccupied} />;

  // Voice-startup pill — covers the seconds while the hidden worker launches.
  const startNode = voiceStarting ? <VoiceStartingPill /> : null;

  // Filler warmup pill — renders in every path (independent of highlights).
  const fillerNode = fillerProgress ? <FillerProgressPill progress={fillerProgress} /> : null;

  // Sleep overlay — pulsing dim logo + "say Hey ThinkDrop" pill.
  const sleepNode = voiceSleeping ? <SleepOverlay /> : null;

  // Selection context pill — "Text Highlighted Context" while armed.
  const selNode = selectionCtx ? <SelectionContextPill /> : null;

  // "AI in Control" lock — renders in every path (independent of highlights).
  const lockNode = controlLock ? (
    <ControlLock
      label={controlLock.label}
      visible={lockVisible}
      onCancel={() => {
        ipcRenderer?.send('ghostlayer:control-cancel', { taskId: controlLock.taskId });
        setControlLock(null);
        setLockVisible(false);
      }}
    />
  ) : null;

  // Show scanning overlay with dark background
  if (isScanning) {
    return <>{stageNode}{fillerNode}{startNode}{sleepNode}{selNode}{lockNode}<ScanningOverlay timer={scanTimer} /></>;
  }

  // The progress drop renders independently of bounding-box highlights — it is
  // shown during capture-heavy app.agent steps (monitoring, etc.) where there
  // are no element highlights, only step progress.
  const dropNode = drop ? <ProgressDrop drop={drop} visible={dropVisible} /> : null;
  // Persistent session boundary — fades with the drop (dropVisible) so it dims
  // during each screenshot and never taints OCR, then restores.
  const boundaryNode = boundary ? <PersistentBoundary element={boundary} visible={dropVisible} /> : null;

  if (!isVisible || highlights.length === 0) {
    return <>{stageNode}{boundaryNode}{dropNode}{fillerNode}{startNode}{sleepNode}{selNode}{lockNode}</>;
  }

  return (
    <>
    {stageNode}
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none', // Click-through
        zIndex: 99999,
        backgroundColor: 'transparent',
      }}
    >
      {/* Camera-flash overlay — brief white flash during screenshots */}
      {flash && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'white',
            opacity: 0.85,
            zIndex: 100000,
            pointerEvents: 'none',
            transition: 'opacity 0.15s ease-out',
          }}
        />
      )}
      {boundaryNode}
      {dropNode}
      {fillerNode}
      {startNode}
      {sleepNode}
      {selNode}
      {lockNode}
      {highlights.map((element, index) => (
        <BoundingBox
          key={element.id ?? index}
          element={element}
          index={index}
          onExited={() => {
            setHighlights(prev => prev.map(h =>
              h.id === element.id ? { ...h, animState: 'exit' as AnimState } : h
            ));
          }}
        />
      ))}
    </div>
    </>
  );
}

/**
 * Individual bounding box with label and lifecycle animation
 */
function BoundingBox({ element, index, onExited }: { element: HighlightElement; index: number; onExited: () => void }) {
  const { x, y, width, height, label, color = '#00aaff', role = 'panel', animState = 'enter' } = element;
  const [localAnim, setLocalAnim] = useState<AnimState>(animState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalAnim(animState);
  }, [animState]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (localAnim === 'enter') {
      // After enter animation, transition to pulse
      timerRef.current = setTimeout(() => setLocalAnim('pulse'), 300);
    } else if (localAnim === 'pulse' && role === 'panel') {
      // Non-scroll panels: pulse longer so user can see boundaries, then fade out after ~7s
      timerRef.current = setTimeout(() => setLocalAnim('exit'), 7000);
    } else if (localAnim === 'active') {
      // Confirmed scroll region: pulse green for 12s then exit
      timerRef.current = setTimeout(() => setLocalAnim('exit'), 12000);
    } else if (localAnim === 'exit') {
      // After exit animation completes, notify parent
      timerRef.current = setTimeout(() => onExited(), 700);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [localAnim, role]);

  const animation = localAnim === 'enter' ? 'ghostlayer-fade-in 0.3s ease-out forwards'
    : localAnim === 'pulse' ? 'ghostlayer-pulse 1.5s ease-in-out 3'
    : localAnim === 'active' ? 'ghostlayer-pulse-active 1.5s ease-in-out infinite'
    : 'ghostlayer-fade-out 0.7s ease-in forwards';

  const opacity = localAnim === 'exit' ? 0 : 1;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: width,
        height: height,
        border: `2px solid ${color}`,
        borderRadius: '2px',
        boxShadow: `0 0 4px ${color}`,
        pointerEvents: 'none',
        animation,
        opacity,
      }}
    >
      {/* Label */}
      {label && (
        <div
          style={{
            position: 'absolute',
            top: -20,
            left: 0,
            backgroundColor: color,
            color: '#000',
            padding: '2px 6px',
            borderRadius: '2px',
            fontSize: '11px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '200px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          }}
        >
          {label}
        </div>
      )}

      {/* Corner markers for visibility */}
      <CornerMarker x={0} y={0} color={color} />
      <CornerMarker x={width - 6} y={0} color={color} />
      <CornerMarker x={0} y={height - 6} color={color} />
      <CornerMarker x={width - 6} y={height - 6} color={color} />

      {/* Index number for debugging */}
      <div
        style={{
          position: 'absolute',
          bottom: -14,
          right: 0,
          fontSize: '9px',
          color: color,
          fontFamily: 'monospace',
          opacity: 0.7,
        }}
      >
        #{index + 1}
      </div>
    </div>
  );
}

/**
 * Small corner marker for visual emphasis
 */
function CornerMarker({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 6,
        height: 6,
        backgroundColor: color,
        borderRadius: '1px',
      }}
    />
  );
}

/**
 * ProgressDrop — a ThinkDrop-styled progress bubble shown during capture-heavy
 * app.agent steps in place of the main panel. Fades via an opacity transition;
 * `visible=false` (set on capture_begin) drives it to opacity 0 so the
 * screenshot is taken with nothing of ours on screen.
 */
function ProgressDrop({ drop, visible }: { drop: ProgressDropState; visible: boolean }) {
  const stepText = drop.stepNum && drop.totalSteps ? `${drop.stepNum}/${drop.totalSteps}` : null;
  return (
    <div
      style={{
        position: 'fixed',
        top: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        borderRadius: 9999,
        background: 'rgba(10,14,22,0.82)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(96,165,250,0.35)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35), 0 0 16px rgba(96,165,250,0.22)',
        color: '#e5e7eb',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }}
    >
      <span style={{ display: 'flex', animation: 'td-drop-bob 2.4s ease-in-out infinite' }}>
        <ThinkDropLogo size={20} />
      </span>
      {stepText && (
        <span style={{ fontSize: 11, fontWeight: 700, color: '#93c5fd', opacity: 0.85 }}>
          {stepText}
        </span>
      )}
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          maxWidth: 360,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {drop.label}
      </span>
      <span
        style={{
          width: 14,
          height: 14,
          flexShrink: 0,
          borderRadius: '50%',
          border: '2px solid #3b82f6',
          borderTopColor: 'transparent',
          animation: 'td-drop-spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

/**
 * PersistentBoundary — a session-owned border drawn around the target app window
 * for the entire app.agent plan. Unlike BoundingBox (auto-exits ~7s), this stays
 * until the terminal event clears it. Its opacity follows `visible` so it dims
 * during each screenshot (capture_begin → visible=false) and never taints OCR,
 * then restores afterwards (capture_end → visible=true).
 */
function PersistentBoundary({ element, visible }: { element: HighlightElement; visible: boolean }) {
  const { x, y, width, height, label, color = '#ffaa00' } = element;
  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        width,
        height,
        border: `2px solid ${color}`,
        borderRadius: '4px',
        boxShadow: `0 0 6px ${color}`,
        pointerEvents: 'none',
        zIndex: 99998,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }}
    >
      {label && (
        <div
          style={{
            position: 'absolute',
            top: -20,
            left: 0,
            backgroundColor: color,
            color: '#000',
            padding: '2px 6px',
            borderRadius: '2px',
            fontSize: '11px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '240px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          }}
        >
          {label}
        </div>
      )}
      <CornerMarker x={0} y={0} color={color} />
      <CornerMarker x={width - 6} y={0} color={color} />
      <CornerMarker x={0} y={height - 6} color={color} />
      <CornerMarker x={width - 6} y={height - 6} color={color} />
    </div>
  );
}

/**
 * ControlLock — fullscreen glowing border + "AI in Control" pill shown while an
 * input-driving step runs. NOT a dim: the user still watches the automation.
 * The border region is non-interactive; clicks are captured at the window level
 * (main.js lifts click-through while the lock is up). Only the X is clickable —
 * it sends ghostlayer:control-cancel which cancels the owning task.
 */
function ControlLock({ label, visible, onCancel }: { label: string; visible: boolean; onCancel: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 100001,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }}
    >
      {/* Animated glowing frame — inset 3px so the glow hugs the screen edge */}
      <div
        style={{
          position: 'absolute',
          top: 3, left: 3, right: 3, bottom: 3,
          border: '2px solid rgba(96,165,250,0.9)',
          borderRadius: '6px',
          boxShadow: '0 0 14px rgba(96,165,250,0.55), inset 0 0 14px rgba(96,165,250,0.25)',
          animation: 'td-lock-glow 2.2s ease-in-out infinite',
          pointerEvents: 'none',
        }}
      />
      {/* Top-center pill: label + cancel */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px 8px 16px',
          borderRadius: 9999,
          background: 'rgba(10,14,22,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(96,165,250,0.45)',
          boxShadow: '0 6px 24px rgba(0,0,0,0.35), 0 0 18px rgba(96,165,250,0.3)',
          color: '#e5e7eb',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          pointerEvents: 'auto',
        }}
      >
        <span style={{ display: 'flex', animation: 'td-drop-bob 2.4s ease-in-out infinite' }}>
          <ThinkDropLogo size={18} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#93c5fd' }}>
          AI IN CONTROL
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            maxWidth: 260,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            opacity: 0.85,
          }}
        >
          {label}
        </span>
        <button
          onClick={onCancel}
          title="Cancel automation (Esc)"
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.25)',
            background: 'rgba(255,255,255,0.08)',
            color: '#e5e7eb',
            fontSize: 12,
            fontWeight: 700,
            lineHeight: '20px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * FillerProgressPill — bottom-center pill shown while the voice-service
 * batch-generates the cached voice filler library in the background.
 * voiceKey looks like "openai:marin:gpt-4o-mini-tts" — middle segment is
 * the friendly voice name.
 */
/**
 * SelectionContextPill — shown while a text selection is armed: the user
 * highlighted text in another app and ThinkDrop will capture it when the
 * next prompt is submitted. Click-through (no interaction — the selection
 * disarms on click-away or is consumed at submit).
 */
function SelectionContextPill() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 48,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        borderRadius: 9999,
        background: 'rgba(10,14,22,0.82)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(249,115,22,0.4)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35), 0 0 16px rgba(249,115,22,0.22)',
        color: '#e5e7eb',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <span style={{ display: 'flex', color: '#fb923c' }}>
        {/* highlighter icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 11-6 6v3h9l3-3" />
          <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8z" />
        </svg>
      </span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>Text Highlighted Context</span>
      <span style={{ fontSize: 11, fontWeight: 500, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 5 }}>
        add to overlay
        <span
          style={{
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            color: '#fdba74',
            background: 'rgba(251,146,60,0.12)',
            border: '1px solid rgba(251,146,60,0.35)',
          }}
        >
          ⌘;
        </span>
      </span>
    </div>
  );
}

/**
 * VoiceStartingPill — shown while the hidden Chrome worker launches and the
 * voice session connects (covers the multi-second dead air after mic click).
 */
function VoiceStartingPill() {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 28,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        borderRadius: 9999,
        background: 'rgba(10,14,22,0.82)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(251,191,36,0.35)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35), 0 0 16px rgba(251,191,36,0.18)',
        color: '#e5e7eb',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <span style={{ display: 'flex', animation: 'td-drop-bob 2.4s ease-in-out infinite' }}>
        <ThinkDropLogo size={18} />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>Starting voice…</span>
      <span
        style={{
          width: 12,
          height: 12,
          flexShrink: 0,
          borderRadius: '50%',
          border: '2px solid #fbbf24',
          borderTopColor: 'transparent',
          animation: 'td-drop-spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

function FillerProgressPill({ progress }: { progress: { done: number; total: number; voiceKey?: string } }) {
  const voice = (progress.voiceKey || '').split(':')[1] || (progress.voiceKey || 'voice');
  const finished = progress.total > 0 && progress.done >= progress.total;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 76,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        borderRadius: 9999,
        background: 'rgba(10,14,22,0.82)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(167,139,250,0.35)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35), 0 0 16px rgba(167,139,250,0.22)',
        color: '#e5e7eb',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <span style={{ display: 'flex', animation: 'td-drop-bob 2.4s ease-in-out infinite' }}>
        <ThinkDropLogo size={18} />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>
        {finished ? `${voice}'s voice is ready` : `Warming up ${voice}'s voice…`}
      </span>
      {finished ? (
        <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399' }}>✓</span>
      ) : (
        <>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', opacity: 0.9 }}>
            {progress.done}/{progress.total}
          </span>
          <span
            style={{
              width: 12,
              height: 12,
              flexShrink: 0,
              borderRadius: '50%',
              border: '2px solid #a78bfa',
              borderTopColor: 'transparent',
              animation: 'td-drop-spin 0.8s linear infinite',
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * SleepOverlay — pulsing dim ThinkDrop logo + "sleeping" pill. The voice
 * bridge keeps SR running but drops all non-wake-phrase transcripts, so the
 * cost of staying asleep is zero; saying "Hey ThinkDrop" (or clicking the
 * voice button) wakes it.
 */
function SleepOverlay() {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100000,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <span style={{ display: 'flex', animation: 'td-sleep-breathe 3.2s ease-in-out infinite', opacity: 0.75 }}>
        <ThinkDropLogo size={44} />
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 14px',
          borderRadius: 9999,
          background: 'rgba(10,14,22,0.7)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(148,163,184,0.25)',
          color: '#94a3b8',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.02em',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: '#818cf8',
            animation: 'pulse-dot 2s ease-in-out infinite',
          }}
        />
        ThinkDrop is sleeping — say "Hey ThinkDrop"
        <span style={{ opacity: 0.6, fontWeight: 400 }}>zZz</span>
      </div>
    </div>
  );
}

/**
 * Scanning overlay with wave animation and timer
 */
function ScanningOverlay({ timer }: { timer: number }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        backdropFilter: 'blur(2px)',
        pointerEvents: 'none',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {/* Wave Scan Animation */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: '4px',
          background: 'linear-gradient(90deg, transparent, #60a5fa, #3b82f6, #60a5fa, transparent)',
          boxShadow: '0 0 20px #3b82f6, 0 0 40px #60a5fa',
          animation: 'scan-wave 2.5s ease-in-out infinite',
        }}
      />
      
      {/* Timer - Upper Left */}
      <div
        style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          padding: '10px',
          color: '#60a5fa',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: '14px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          textShadow: '0 0 10px rgba(96, 165, 250, 0.5)',
          background: '#000',
          borderRadius: '10px',
        }}
      >
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#60a5fa',
            animation: 'pulse-dot 1s ease-in-out infinite',
          }}
        />
        Scanning... {timer.toFixed(1)}s
      </div>
      
      {/* Center Logo */}
      <div
        style={{
          opacity: 0.3,
          animation: 'logo-pulse 2s ease-in-out infinite',
          filter: 'drop-shadow(0 0 30px rgba(96, 165, 250, 0.6))',
        }}
      >
        <ThinkDropLogo size={120} />
      </div>
    </div>
  );
}

// CSS animations - wrapped to prevent duplicates on HMR
if (!document.getElementById('ghostlayer-styles')) {
  const style = document.createElement('style');
  style.id = 'ghostlayer-styles';
  style.textContent = `
    @keyframes ghostlayer-fade-in {
      from {
        opacity: 0;
        transform: scale(0.98);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    @keyframes ghostlayer-fade-out {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(0.97); }
    }

    @keyframes ghostlayer-pulse {
      0%, 100% { opacity: 1;   box-shadow: 0 0 4px currentColor; }
      50%       { opacity: 0.5; box-shadow: 0 0 12px currentColor; }
    }

    @keyframes ghostlayer-pulse-active {
      0%, 100% { opacity: 1;   box-shadow: 0 0 8px #00ff00, 0 0 20px rgba(0,255,0,0.4); }
      50%       { opacity: 0.8; box-shadow: 0 0 16px #00ff00, 0 0 40px rgba(0,255,0,0.6); }
    }
    
    @keyframes scan-wave {
      0% {
        top: -4px;
        opacity: 0;
      }
      10% {
        opacity: 1;
      }
      90% {
        opacity: 1;
      }
      100% {
        top: 100vh;
        opacity: 0;
      }
    }
    
    @keyframes pulse-dot {
      0%, 100% {
        transform: scale(1);
        opacity: 1;
      }
      50% {
        transform: scale(0.6);
        opacity: 0.6;
      }
    }
    
    @keyframes logo-pulse {
      0%, 100% {
        transform: scale(1);
        opacity: 0.3;
      }
      50% {
        transform: scale(1.05);
        opacity: 0.4;
      }
    }

    @keyframes td-drop-spin {
      to { transform: rotate(360deg); }
    }

    @keyframes td-drop-bob {
      0%, 100% { transform: translateY(0); }
      50%       { transform: translateY(-2px); }
    }

    @keyframes td-sleep-breathe {
      0%, 100% { transform: scale(1);    opacity: 0.55; filter: drop-shadow(0 0 6px rgba(129,140,248,0.25)); }
      50%       { transform: scale(1.07); opacity: 0.95; filter: drop-shadow(0 0 18px rgba(129,140,248,0.55)); }
    }

    @keyframes td-lock-glow {
      0%, 100% {
        border-color: rgba(96,165,250,0.9);
        box-shadow: 0 0 14px rgba(96,165,250,0.55), inset 0 0 14px rgba(96,165,250,0.25);
      }
      50% {
        border-color: rgba(147,197,253,1);
        box-shadow: 0 0 26px rgba(96,165,250,0.9), inset 0 0 26px rgba(96,165,250,0.45);
      }
    }
  `;
  document.head.appendChild(style);
}

const GhostLayerMemo = React.memo(GhostLayer);
export default GhostLayerMemo;
export { GhostLayerMemo as GhostLayer };
