/**
 * EngineChip — transparency pill naming the search engine that served a
 * result ("Google Search", "Bing Copilot Search", "Brave Search", …).
 * Returns null when the engine isn't a real provider (llm-fallback, etc.).
 */

import React from 'react';
import { engineLabel } from './engineLabel';

const EngineChip: React.FC<{ engine?: string | null }> = ({ engine }) => {
  const label = engineLabel(engine);
  if (!label) return null;
  return (
    <span
      className="flex items-center gap-1"
      title={`Answered by ${label}`}
      style={{
        padding: '2px 8px',
        borderRadius: 10,
        backgroundColor: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.09)',
        color: '#9ca3af',
        fontSize: '0.65rem',
        fontFamily: 'monospace',
        whiteSpace: 'nowrap',
      }}
    >
      {/* magnifier glyph */}
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      {label}
    </span>
  );
};

export default EngineChip;
