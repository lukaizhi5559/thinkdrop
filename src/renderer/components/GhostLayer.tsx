import { useState, useEffect } from 'react';

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
  type: 'highlight' | 'clear';
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
export function GhostLayer() {
  const [highlights, setHighlights] = useState<HighlightElement[]>([]);
  const [isVisible, setIsVisible] = useState(false);

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
      if (data.type === 'highlight' && data.elements) {
        console.log('[GhostLayer] Setting highlights:', data.elements.length);
        setHighlights(data.elements);
        setIsVisible(true);
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
      }
    };

    ipcRenderer.on('app-agent:highlight', handleHighlight);
    console.log('[GhostLayer] IPC listener registered');

    return () => {
      ipcRenderer.removeListener('app-agent:highlight', handleHighlight);
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
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  console.log('[GhostLayer] Render - isVisible:', isVisible, 'highlights:', highlights.length);

  if (!isVisible || highlights.length === 0) {
    console.log('[GhostLayer] Returning null (not visible or no highlights)');
    return null;
  }

  console.log('[GhostLayer] Rendering', highlights.length, 'bounding boxes');

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

// CSS animation for fade-in
const style = document.createElement('style');
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
`;
document.head.appendChild(style);

export default GhostLayer;
