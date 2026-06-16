import React, { useState, useEffect, useRef } from 'react';
import { ThinkDropLogo } from './SlideoutDrawer';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface HighlightElement {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
}

interface HighlightData {
  type: 'highlight' | 'clear' | 'scanning_start' | 'scanning_complete';
  elements?: HighlightElement[];
  duration?: number;
}

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

  // Track previous state for conditional logging
  const prevState = useRef({ highlights: 0, isVisible: false, isScanning: false });

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
        setHighlights(data.elements);
        setIsVisible(true);
        setIsScanning(false); // Stop scanning when highlights arrive
        if (timerInterval.current) {
          clearInterval(timerInterval.current);
          timerInterval.current = null;
        }
        console.log('[GhostLayer] isVisible set to true');

        // Auto-clear after duration
        if (data.duration && data.duration > 0) {
          setTimeout(() => {
            setHighlights([]);
            setIsVisible(false);
          }, data.duration);
        }
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

  if (!isVisible || highlights.length === 0) {
    return null;
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
      {highlights.map((element, index) => (
        <BoundingBox
          key={index}
          element={element}
          index={index}
        />
      ))}
    </div>
  );
}

/**
 * Individual bounding box with label
 */
function BoundingBox({ element, index }: { element: HighlightElement; index: number }) {
  const { x, y, width, height, label, color = '#00ff00' } = element;

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
        animation: 'ghostlayer-fade-in 0.2s ease-out',
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

// CSS animation for fade-in - wrapped to prevent duplicates on HMR
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
  `;
  document.head.appendChild(style);
}

const GhostLayerMemo = React.memo(GhostLayer);
export default GhostLayerMemo;
export { GhostLayerMemo as GhostLayer };
