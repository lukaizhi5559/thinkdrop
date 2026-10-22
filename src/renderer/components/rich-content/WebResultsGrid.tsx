/**
 * WebResultsGrid — Horizontal snap-scroll row of WebResultCards.
 *
 * Renders extracted page items (from web.crawl extractItems or browser.agent
 * extract_items) as a horizontally scrollable card row. Video items
 * (mediaType === 'video') split into their own labeled "Videos" carousel when
 * 2+ exist — matching the SERP's "Short videos" strip; a lone video stays
 * inline. Empty-state returns null so callers can drop it inline without
 * conditional checks.
 */

import React from 'react';
import WebResultCard, { WebResultItem } from './WebResultCard';

interface WebResultsGridProps {
  items?: WebResultItem[] | null;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  overflowX: 'auto',
  paddingBottom: 6,
  scrollbarWidth: 'thin',
  scrollSnapType: 'x mandatory',
  margin: '8px 0',
};

const CardRow: React.FC<{ items: WebResultItem[] }> = ({ items }) => (
  <div className="web-results-grid" style={rowStyle}>
    {items.map((item, i) => (
      <div key={`${item.url || item.imageUrl || ''}-${i}`} style={{ scrollSnapAlign: 'start' }}>
        <WebResultCard item={item} />
      </div>
    ))}
  </div>
);

const WebResultsGrid: React.FC<WebResultsGridProps> = ({ items }) => {
  if (!items || !Array.isArray(items) || items.length === 0) return null;

  const videos = items.filter(i => i.mediaType === 'video');
  const rest = items.filter(i => i.mediaType !== 'video');
  const splitVideos = videos.length >= 2;

  return (
    <>
      {(rest.length > 0 || !splitVideos) && <CardRow items={splitVideos ? rest : items} />}
      {splitVideos && (
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.45)',
            margin: '6px 0 0', letterSpacing: '0.02em',
          }}>
            Videos
          </div>
          <CardRow items={videos} />
        </div>
      )}
    </>
  );
};

export default WebResultsGrid;
