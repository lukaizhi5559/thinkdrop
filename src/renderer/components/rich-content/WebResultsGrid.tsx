/**
 * WebResultsGrid — Horizontal snap-scroll row of WebResultCards.
 *
 * Renders extracted page items (from web.crawl extractItems or browser.agent
 * extract_items) as a horizontally scrollable card row. Empty-state returns null
 * so callers can drop it inline without conditional checks.
 */

import React from 'react';
import WebResultCard, { WebResultItem } from './WebResultCard';

interface WebResultsGridProps {
  items?: WebResultItem[] | null;
}

const WebResultsGrid: React.FC<WebResultsGridProps> = ({ items }) => {
  if (!items || !Array.isArray(items) || items.length === 0) return null;

  return (
    <div
      className="web-results-grid"
      style={{
        display: 'flex',
        gap: 10,
        overflowX: 'auto',
        paddingBottom: 6,
        scrollbarWidth: 'thin',
        scrollSnapType: 'x mandatory',
        margin: '8px 0',
      }}
    >
      {items.map((item, i) => (
        <div
          key={`${item.url || item.imageUrl || ''}-${i}`}
          style={{ scrollSnapAlign: 'start' }}
        >
          <WebResultCard item={item} />
        </div>
      ))}
    </div>
  );
};

export default WebResultsGrid;
