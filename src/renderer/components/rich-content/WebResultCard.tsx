/**
 * WebResultCard — Generic card for displaying a scraped page item.
 *
 * Renders whichever fields are present: thumbnail, title (clickable link),
 * price chip, snippet, hostname + favicon row. Adapts to product listings,
 * search results, email rows, news articles, doc pages — any extracted item.
 *
 * Click anywhere on the card opens item.url (or imageUrl) externally via
 * shell:open-url, matching the RichContentRenderer link pattern.
 */

import React, { useState, useCallback } from 'react';

export interface WebResultItem {
  title?: string;
  imageUrl?: string;
  url?: string;
  price?: string;
  snippet?: string;
  hostname?: string;
}

interface WebResultCardProps {
  item: WebResultItem;
}

const openUrl = (url: string) => {
  if (!url) return;
  const ipcRenderer = (window as any).electron?.ipcRenderer;
  if (ipcRenderer) {
    ipcRenderer.send('shell:open-url', url);
  } else {
    window.open(url, '_blank');
  }
};

const WebResultCard: React.FC<WebResultCardProps> = ({ item }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  const handleClick = useCallback(() => {
    openUrl(item.url || item.imageUrl || '');
  }, [item.url, item.imageUrl]);

  const handleImgError = useCallback(() => setImgFailed(true), []);
  const handleImgLoad = useCallback(() => setImgLoaded(true), []);

  const hostname = item.hostname || (() => {
    try { return new URL(item.url || item.imageUrl || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  })();

  return (
    <div
      onClick={handleClick}
      className="web-result-card"
      style={{
        flex: '0 0 220px',
        maxWidth: 220,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        overflow: 'hidden',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(59,130,246,0.4)';
        e.currentTarget.style.background = 'rgba(59,130,246,0.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
        e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
      }}
    >
      {/* Thumbnail */}
      {item.imageUrl && !imgFailed && (
        <div style={{ position: 'relative', width: '100%', height: 140, background: 'rgba(255,255,255,0.04)' }}>
          {!imgLoaded && (
            <div className="image-skeleton" style={{ position: 'absolute', inset: 0 }} />
          )}
          <img
            src={item.imageUrl}
            alt={item.title || ''}
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={handleImgError}
            onLoad={handleImgLoad}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: imgLoaded ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          />
        </div>
      )}
      {item.imageUrl && imgFailed && (
        <div style={{
          width: '100%', height: 140,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.04)',
          color: 'rgba(255,255,255,0.3)',
          fontSize: 11,
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
      )}

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        {item.title && (
          <div style={{
            fontSize: 12, fontWeight: 500, lineHeight: 1.3,
            color: 'rgba(255,255,255,0.9)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {item.title}
          </div>
        )}
        {item.price && (
          <span style={{
            display: 'inline-block', alignSelf: 'flex-start',
            fontSize: 12, fontWeight: 600, color: '#4ade80',
            background: 'rgba(74,222,128,0.1)', padding: '1px 6px', borderRadius: 4,
          }}>
            {item.price}
          </span>
        )}
        {item.snippet && (
          <div style={{
            fontSize: 11, lineHeight: 1.35, color: 'rgba(255,255,255,0.5)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {item.snippet}
          </div>
        )}
        {hostname && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 'auto', paddingTop: 4 }}>
            <img
              src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`}
              alt=""
              width={12}
              height={12}
              referrerPolicy="no-referrer"
              style={{ borderRadius: 2, flexShrink: 0 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {hostname}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default WebResultCard;
