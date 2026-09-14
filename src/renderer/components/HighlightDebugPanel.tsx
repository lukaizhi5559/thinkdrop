import React from 'react';

interface HighlightDebugPanelProps {
  highlightQuery: string;
  onQueryChange: (value: string) => void;
  onExecute: (query: string) => void;
  onClose: () => void;
}

function HighlightDebugPanelImpl({ highlightQuery, onQueryChange, onExecute, onClose }: HighlightDebugPanelProps) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 105,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 280,
        padding: 16,
        borderRadius: 10,
        backgroundColor: 'rgba(23,23,23,0.98)',
        border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        zIndex: 1001,
      }}
    >
      <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginBottom: 10 }}>
        Highlight Debug Mode
      </div>
      <input
        value={highlightQuery}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onExecute(highlightQuery);
          }
          if (e.key === 'Escape') {
            onClose();
          }
        }}
        placeholder="Type: all | boundaries | assets | search"
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.15)',
          backgroundColor: 'rgba(0,0,0,0.3)',
          color: '#fff',
          fontSize: '0.85rem',
          marginBottom: 10,
          outline: 'none',
        }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, fontSize: '0.75rem', color: '#6b7280' }}>
        <span style={{ color: '#4ade80' }}>● all</span>
        <span style={{ color: '#3b82f6' }}>● boundaries</span>
        <span style={{ color: '#facc15' }}>● assets</span>
        <span>or type to search</span>
      </div>
    </div>
  );
}

export const HighlightDebugPanel = React.memo(HighlightDebugPanelImpl);
export default HighlightDebugPanel;
