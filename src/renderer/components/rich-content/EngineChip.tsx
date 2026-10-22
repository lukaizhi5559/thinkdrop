/**
 * EngineChip — transparency pill naming the search engine that served a
 * result ("Google Search", "Bing Copilot Search", "Brave Search", …).
 * Returns null when the engine isn't a real provider (llm-fallback, etc.).
 */

import React from 'react';
import { engineLabel, engineFaviconDomain } from './engineLabel';

const PULSE_CSS =
  '@keyframes tdChipPulse{0%,100%{opacity:1}50%{opacity:0.3}}' +
  '@keyframes tdChipDot{0%,80%,100%{opacity:0.25}40%{opacity:1}}';

const EngineChip: React.FC<{ engine?: string | null; loading?: boolean }> = ({ engine, loading }) => {
  const label = engineLabel(engine);
  if (!label) return null;
  const domain = engineFaviconDomain(engine);
  return (
    <span
      className="flex items-center gap-1"
      title={loading ? `Searching ${label}…` : `Answered by ${label}`}
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
      <style>{PULSE_CSS}</style>
      {domain ? (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
          alt=""
          width={10}
          height={10}
          referrerPolicy="no-referrer"
          style={{ borderRadius: 2, flexShrink: 0, ...(loading ? { animation: 'tdChipPulse 1.2s ease-in-out infinite' } : {}) }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      )}
      {loading ? `Searching ${label}` : label}
      {loading && (
        <span className="flex items-center" style={{ gap: 2, marginLeft: 1 }}>
          {[0, 1, 2].map(i => (
            <span key={i} style={{
              width: 2.5, height: 2.5, borderRadius: '50%', backgroundColor: '#9ca3af',
              animation: `tdChipDot 1.2s ease-in-out ${i * 0.18}s infinite`,
            }} />
          ))}
        </span>
      )}
    </span>
  );
};

export default EngineChip;
