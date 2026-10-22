'use strict';

/**
 * serp-item.cjs — normalize a raw SERP result into the renderer's
 * WebResultItem contract (see rich-content/WebResultCard.tsx). Shared by the
 * web-search express lane (webSearchExpress.cjs) and generalQuick's
 * serp_overview path so both emit the same card shape.
 */

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

/**
 * @param {Object} r - raw provider result (google-serp / bing / ddg shape)
 * @returns {Object|null} WebResultItem, or null when nothing renderable exists
 */
function toItem(r) {
  const url = r.url || r.link || null;
  const isImage = r.type === 'image-result' || r.type === 'image';
  const isVideo = r.type === 'video-result' || r.type === 'video';
  const imageUrl = isImage
    ? (r.metadata?.properties?.url || r.thumbnail || r.imageUrl || null)
    : isVideo
      ? (r.metadata?.thumbnail?.src || r.thumbnail?.src || r.metadata?.properties?.thumbnail
          || (typeof r.thumbnail === 'string' ? r.thumbnail : null))
      : (r.metadata?.thumbnail?.src || (typeof r.thumbnail === 'string' ? r.thumbnail : null));
  const itemUrl = (url && url.startsWith('http')) ? url
    : (isImage ? (r.metadata?.properties?.originalUrl || r.originalUrl || null) : null);
  // Real destination host from the SERP cite row — r.url is often a wrapped
  // google.com/goto link whose derived hostname would render 'google.com'.
  // goto?url= tokens are opaque so they can't be unwrapped — a card that
  // resolves to google.com is a wrapper, not a source: drop the branding.
  let host = r.displayDomain || hostnameOf(itemUrl || imageUrl || '');
  if (host === 'google.com') host = '';
  // Image tiles carry the literal title 'Image', and wrapper rows can carry
  // a bare domain ('google.com') — neither labels a card. Prefer the real
  // title; else the source host; else nothing.
  const rawTitle = r.title && r.title !== 'Image' && !/^[\w-]+(\.[\w-]+)+$/.test(r.title.trim())
    ? r.title : undefined;
  const title = rawTitle || host || undefined;
  const item = {
    title,
    imageUrl: imageUrl || undefined,
    // Engine-proxied thumb — fast, always reachable; the card tries it
    // before the (often hotlink-blocked) original imageUrl.
    thumbnail: (typeof r.thumbnail === 'string' ? r.thumbnail : r.thumbnail?.src) || undefined,
    originalUrl: r.originalUrl || r.metadata?.properties?.originalUrl || undefined,
    url: itemUrl || undefined,
    snippet: r.snippet || r.description || undefined,
    hostname: host || undefined,
    // Structured rich-snippet fields (google-serp extraction); the card also
    // parses item.snippet as fallback for providers that don't emit them.
    rating: r.rating !== undefined ? r.rating : undefined,
    ratingMax: r.ratingMax !== undefined ? r.ratingMax : undefined,
    reviewCount: r.reviewCount !== undefined ? r.reviewCount : undefined,
    priceRange: r.priceRange || undefined,
    mediaType: isVideo ? 'video' : (isImage ? 'image' : undefined),
    duration: isVideo ? (r.metadata?.duration || r.duration || undefined) : undefined,
    channel: isVideo ? (r.metadata?.channel || r.channel || undefined) : undefined,
  };
  return (item.imageUrl || item.url) ? item : null;
}

module.exports = { toItem, hostnameOf };
