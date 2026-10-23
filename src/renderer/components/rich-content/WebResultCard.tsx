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
import StarRating from './StarRating';
import { parseRichSnippet } from './parseRichSnippet';
import logoUrl from '../../assets/logo.jpg';

export interface WebResultItem {
  title?: string;
  imageUrl?: string;
  thumbnail?: string;
  url?: string;
  price?: string;
  snippet?: string;
  hostname?: string;
  // Structured SERP rich-snippet fields (google-serp); when absent the card
  // parses item.snippet for the same patterns (Bing/DDG + cached results).
  rating?: number;
  ratingMax?: number;
  reviewCount?: number;
  priceRange?: string;
  // Media fields (videos / rich cards)
  mediaType?: 'video' | 'image' | 'product' | 'article' | 'card';
  videoUrl?: string;
  embedUrl?: string;
  posterUrl?: string;
  originalUrl?: string;
  duration?: string;
  channel?: string;
  sourceUrl?: string;
}

interface WebResultCardProps {
  item: WebResultItem;
  /** 'card' = 220px media card (default); 'row' = full-width vertical-list
   * row with a small left thumb — link results where title/snippet matter. */
  variant?: 'card' | 'row';
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

const WebResultCard: React.FC<WebResultCardProps> = ({ item, variant = 'card' }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  // Direct thumbnail/CDN URLs (Brave imgs.search proxy, hotlink-protected
  // hosts) fail intermittently — walk the fallback chain before giving up.
  // item.thumbnail first: providers send the engine-proxied thumb (fast,
  // always reachable); imageUrl is often the original — hotlink-blocked.
  const thumbCandidates = React.useMemo(
    () => [item.thumbnail, item.imageUrl, item.posterUrl, item.originalUrl]
      .filter((u): u is string => typeof u === 'string' && /^https?:|^data:|^thinkdrop-image:/.test(u))
      .filter((u, i, a) => a.indexOf(u) === i),
    [item.thumbnail, item.imageUrl, item.posterUrl, item.originalUrl]
  );
  const [srcIdx, setSrcIdx] = useState(0);
  const thumbUrl = thumbCandidates[srcIdx];

  const handleClick = useCallback(() => {
    // For video items, prefer the watch page (url) then the direct video/embed URL.
    const target = item.url || item.videoUrl || item.embedUrl || item.imageUrl || '';
    openUrl(target);
  }, [item.url, item.videoUrl, item.embedUrl, item.imageUrl]);

  const handleImgError = useCallback(() => {
    setImgLoaded(false);
    if (srcIdx < thumbCandidates.length - 1) setSrcIdx(srcIdx + 1);
    else setImgFailed(true);
  }, [srcIdx, thumbCandidates.length]);
  const handleImgLoad = useCallback(() => setImgLoaded(true), []);

  const isVideo = item.mediaType === 'video';
  const isMedia = isVideo || item.mediaType === 'image';

  const hostname = item.hostname || (() => {
    try { return new URL(item.url || item.imageUrl || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  })();

  // Rich-snippet mapping: structured fields win; snippet text is the fallback
  // source and also yields the deduped display text.
  const parsed = React.useMemo(() => parseRichSnippet(item.snippet), [item.snippet]);
  const rating = item.rating ?? parsed.rating;
  const ratingMax = item.ratingMax ?? parsed.ratingMax ?? 5;
  const reviewCount = item.reviewCount ?? parsed.reviewCount;
  const priceChip = item.price || item.priceRange || parsed.priceRange;

  // 'row' variant — link results in a vertical list: small left thumb,
  // full-width title + readable snippet. Same click + thumb-fallback logic.
  if (variant === 'row') {
    return (
      <div
        onClick={handleClick}
        className="web-result-card"
        style={{
          display: 'flex', gap: 10, alignItems: 'flex-start',
          padding: '8px 10px', borderRadius: 8,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          cursor: 'pointer',
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
        {thumbUrl && !imgFailed && (
          <div style={{ position: 'relative', width: 72, height: 56, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.04)' }}>
            {!imgLoaded && <div className="image-skeleton" style={{ position: 'absolute', inset: 0 }} />}
            <img
              src={thumbUrl}
              alt={item.title || ''}
              referrerPolicy="no-referrer"
              loading="lazy"
              onError={handleImgError}
              onLoad={handleImgLoad}
              style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.2s' }}
            />
            {isVideo && imgLoaded && (
              <div style={{
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                width: 24, height: 24, borderRadius: '50%', background: 'rgba(0,0,0,0.65)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
              }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><polygon points="6,4 20,12 6,20" /></svg>
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
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
          {priceChip && (
            <span style={{
              display: 'inline-block', alignSelf: 'flex-start',
              fontSize: 12, fontWeight: 600, color: '#4ade80',
              background: 'rgba(74,222,128,0.1)', padding: '1px 6px', borderRadius: 4,
            }}>
              {priceChip}
            </span>
          )}
          {rating !== undefined && (
            <StarRating value={rating} max={ratingMax} count={reviewCount} size={11} />
          )}
          {parsed.text && (
            <div style={{
              fontSize: 11, lineHeight: 1.35, color: 'rgba(255,255,255,0.5)',
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {parsed.text}
            </div>
          )}
          {hostname && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 2 }}>
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
  }

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
      {thumbUrl && !imgFailed && (
        <div style={{ position: 'relative', width: '100%', height: 140, background: 'rgba(255,255,255,0.04)' }}>
          {!imgLoaded && (
            <div className="image-skeleton" style={{ position: 'absolute', inset: 0 }} />
          )}
          <img
            src={thumbUrl}
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
          {/* Play badge for video items */}
          {isVideo && imgLoaded && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 40, height: 40, borderRadius: '50%',
              background: 'rgba(0,0,0,0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                <polygon points="6,4 20,12 6,20" />
              </svg>
            </div>
          )}
          {/* Duration chip for video items (bottom-right) */}
          {isVideo && item.duration && (
            <span style={{
              position: 'absolute', bottom: 4, right: 4,
              fontSize: 10, fontWeight: 600, color: 'white',
              background: 'rgba(0,0,0,0.75)', padding: '1px 5px', borderRadius: 3,
              pointerEvents: 'none',
            }}>
              {item.duration}
            </span>
          )}
        </div>
      )}
      {/* Placeholder — media cards get the ThinkDrop logo when no thumb is
        * available or every candidate failed; other cards keep the icon. */}
      {isMedia && (!thumbUrl || imgFailed) && (
        <div style={{
          position: 'relative', width: '100%', height: 140,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.04)',
        }}>
          <img src={logoUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10, opacity: 0.45 }} />
          {isVideo && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 40, height: 40, borderRadius: '50%',
              background: 'rgba(0,0,0,0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                <polygon points="6,4 20,12 6,20" />
              </svg>
            </div>
          )}
        </div>
      )}
      {!isMedia && thumbUrl && imgFailed && (
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
        {priceChip && (
          <span style={{
            display: 'inline-block', alignSelf: 'flex-start',
            fontSize: 12, fontWeight: 600, color: '#4ade80',
            background: 'rgba(74,222,128,0.1)', padding: '1px 6px', borderRadius: 4,
          }}>
            {priceChip}
          </span>
        )}
        {rating !== undefined && (
          <StarRating value={rating} max={ratingMax} count={reviewCount} size={11} />
        )}
        {parsed.text && (
          <div style={{
            fontSize: 11, lineHeight: 1.35, color: 'rgba(255,255,255,0.5)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {parsed.text}
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
