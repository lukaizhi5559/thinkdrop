import React, { useState, useEffect, useRef } from 'react';
import { ThinkDropLogo } from './SlideoutDrawer';

const ipcRenderer = (window as any).electron?.ipcRenderer;

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
    | 'boundary_set' | 'boundary_clear';
  elements?: HighlightElement[];
  duration?: number;
  cx?: number;
  cy?: number;
  role?: HighlightRole;
  // progress_drop fields
  label?: string;
  stepNum?: number | null;
  totalSteps?: number | null;
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
  const timerInterval = useRef<NodeJS.Timeout | null>(null);

  // Progress "drop" — a ThinkDrop-styled bubble shown during capture-heavy
  // app.agent steps in place of the (OCR-tainting) main panel. It fades out
  // during each screenshot (capture_begin) and back in afterwards (capture_end).
  const [drop, setDrop] = useState<ProgressDropState | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const captureReadyTimer = useRef<NodeJS.Timeout | null>(null);

  // Persistent app-window boundary owned by the drop session (main.js). Unlike
  // BoundingBox highlights (which auto-exit after ~7s), this border stays up for
  // the entire plan and only dims during each screenshot (capture_begin) so it
  // never taints OCR, then restores (capture_end). Cleared on the terminal event.
  const [boundary, setBoundary] = useState<HighlightElement | null>(null);

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
      } else if (data.type === 'capture_begin') {
        // Fade the drop out, then signal the main process that the screenshot
        // can fire (the drop is now invisible → clean OCR). The opacity
        // transition is 0.4s; we send ready just after it completes. The main
        // process also has its own timeout fallback.
        setDropVisible(false);
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

    ipcRenderer.on('app-agent:highlight', handleHighlight);
    console.log('[GhostLayer] IPC listener registered');

    return () => {
      ipcRenderer.removeListener('app-agent:highlight', handleHighlight);
      if (timerInterval.current) {
        clearInterval(timerInterval.current);
      }
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

  // Show scanning overlay with dark background
  if (isScanning) {
    return <ScanningOverlay timer={scanTimer} />;
  }

  // The progress drop renders independently of bounding-box highlights — it is
  // shown during capture-heavy app.agent steps (monitoring, etc.) where there
  // are no element highlights, only step progress.
  const dropNode = drop ? <ProgressDrop drop={drop} visible={dropVisible} /> : null;
  // Persistent session boundary — fades with the drop (dropVisible) so it dims
  // during each screenshot and never taints OCR, then restores.
  const boundaryNode = boundary ? <PersistentBoundary element={boundary} visible={dropVisible} /> : null;

  if (!isVisible || highlights.length === 0) {
    return (dropNode || boundaryNode) ? <>{boundaryNode}{dropNode}</> : null;
  }

  return (
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
      {boundaryNode}
      {dropNode}
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
  );
}

/**
 * Individual bounding box with label and lifecycle animation
 */
function BoundingBox({ element, index, onExited }: { element: HighlightElement; index: number; onExited: () => void }) {
  const { x, y, width, height, label, color = '#00aaff', role = 'panel', animState = 'enter' } = element;
  const [localAnim, setLocalAnim] = useState<AnimState>(animState);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

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
  `;
  document.head.appendChild(style);
}

const GhostLayerMemo = React.memo(GhostLayer);
export default GhostLayerMemo;
export { GhostLayerMemo as GhostLayer };
