/**
 * parseRichSnippet — extracts rating/price metadata embedded in SERP snippet
 * text so cards can render it as styled components (stars, count, price chip)
 * instead of raw text. Provider-agnostic — works on Google/Bing/DDG snippets
 * and pre-structured cache entries alike. Matched fragments are removed from
 * the returned `text` so they don't render twice.
 *
 * Patterns covered:
 *   "3.1 ★", "★★★☆☆", "4.0/5", "rated 4.0 of 5", "3.5 stars"
 *   "(4,472)", "143 reviews", "20+ comments", "525 ratings"
 *   "Price range: $$", " · $$$ "
 */

export interface RichSnippet {
  rating?: number;
  ratingMax?: number;
  reviewCount?: number;
  priceRange?: string;
  /** Snippet with the consumed rating/price fragments removed. */
  text: string;
}

const RATING_RES = [
  /\b(\d+(?:\.\d+)?)\s*★+\s*(?:\(([\d,]+)\)\s*)?/,          // "3.1 ★ (4,472)" / "3.1 ★★★☆☆"
  /\brated\s+(\d+(?:\.\d+)?)\s+(?:of|out of)\s+(5|10)\b/i,  // "rated 4.0 of 5"
  /\b(\d+(?:\.\d+)?)\s*\/\s*(5|10)\b/,                       // "4.0/5"
  /\b(\d+(?:\.\d+)?)\s*stars?\b/i,                           // "3.5 stars"
];
const LITERAL_STARS_RE = /★{1,5}☆{0,4}/;
const RATING_WITH_COUNT_RE = /\b(\d+(?:\.\d+)?)\s*\(([\d,]+)\s*(?:reviews?|ratings?)\)/; // "1.5 (35 reviews)"
const COUNT_RE = /\(?\b([\d,]+)\+?\)?\s*(?:unbiased\s+)?(?:reviews?|ratings?|comments?|votes?)\b/i;
const PAREN_COUNT_RE = /\(([\d,]{2,})\)/;                    // "(4,472)" sitting near a rating
const PRICE_RE = /price\s*range:?\s*(\${1,4})/i;
const PRICE_BARE_RE = /(?:^|[·\s])(\${2,4})(?=[\s·]|$)/;

export function parseRichSnippet(snippet?: string): RichSnippet {
  const text = (snippet || '').trim();
  const out: RichSnippet = { text };
  if (!text) return out;

  let consumed = '';

  for (const re of RATING_RES) {
    const m = text.match(re);
    if (!m) continue;
    out.rating = parseFloat(m[1]);
    out.ratingMax = m[2] ? parseInt(m[2], 10) : 5;
    consumed = m[0];
    break;
  }
  if (out.rating === undefined) {
    const m = text.match(RATING_WITH_COUNT_RE);
    if (m && parseFloat(m[1]) <= 10) {   // Yelp-style "1.5 (35 reviews)"
      out.rating = parseFloat(m[1]);
      out.ratingMax = 5;
      out.reviewCount = parseInt(m[2].replace(/,/g, ''), 10);
      consumed = m[0];
    }
  }
  if (out.rating === undefined) {
    const m = text.match(LITERAL_STARS_RE);
    if (m) {
      const filled = (m[0].match(/★/g) || []).length;
      const empty = (m[0].match(/☆/g) || []).length;
      out.rating = filled;
      out.ratingMax = filled + empty || 5;
      consumed = m[0];
    }
  }

  const cm = text.match(COUNT_RE);
  if (cm) {
    out.reviewCount = parseInt(cm[1].replace(/,/g, ''), 10);
    consumed += (consumed ? '|' : '') + cm[0];
  } else if (out.rating !== undefined) {
    const pm = text.match(PAREN_COUNT_RE);
    if (pm) {
      out.reviewCount = parseInt(pm[1].replace(/,/g, ''), 10);
      consumed += '|' + pm[0];
    }
  }

  const prm = text.match(PRICE_RE) || text.match(PRICE_BARE_RE);
  if (prm) {
    out.priceRange = prm[1];
    consumed += '|' + prm[0];
  }

  if (consumed) {
    // Remove consumed fragments, then tidy leftover separators/whitespace.
    let cleaned = text;
    for (const frag of consumed.split('|')) cleaned = cleaned.replace(frag, ' ');
    cleaned = cleaned
      .replace(/\s*[·•]\s*/g, ' · ')    // normalize separators
      .replace(/(?:\s*·\s*){2,}/g, ' · ')
      .replace(/^\s*[·•]\s*|\s*[·•]\s*$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    out.text = cleaned;
  }
  return out;
}
