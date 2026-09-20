/**
 * itemImages — helpers for reconciling markdown image embeds with card items.
 *
 * When web search results are surfaced as WebResultsGrid cards, the answer
 * markdown may still contain `![alt](url)` embeds for the same images. Strip
 * those embeds so each image displays once — as a card — while the caption
 * text (e.g. `* **Title**:`) remains.
 */

import type { WebResultItem } from './WebResultCard';

const IMAGE_MD_RE = /!\[[^\]]*\]\(([^\s")]+)(?:\s+"[^"]*")?\)/g;

/**
 * Remove `![alt](url)` image embeds whose URL matches an item's imageUrl.
 * Returns the content unchanged when there are no items or no matches.
 */
export function stripItemImageMarkdown(content: string, items?: WebResultItem[] | null): string {
  if (!content || !items || items.length === 0) return content;

  const normalize = (u: string): string => {
    let s = u.replace(/\\_/g, '_').replace(/[?#]+$/, '').replace(/\/+$/, '');
    try { s = decodeURI(s); } catch (_) { /* keep undecoded */ }
    return s;
  };
  const basename = (u: string): string => {
    const n = normalize(u);
    try { return new URL(n).pathname.split('/').pop() || ''; } catch (_) { return n.split('/').pop() || ''; }
  };

  const itemImageUrls = new Set(
    items.map(it => it.imageUrl).filter((u): u is string => typeof u === 'string' && u.length > 0)
  );
  if (itemImageUrls.size === 0) return content;
  const itemNormUrls = new Set([...itemImageUrls].map(normalize));
  const itemBasenames = new Set([...itemImageUrls].map(basename).filter(b => b.length > 3));

  // Strip embeds matching an item's imageUrl — exact, normalized, or same
  // filename (LLMs re-emit the same image with escaped chars or different
  // params; leaving it would render the photo twice: grid card + carousel).
  const stripped = content.replace(IMAGE_MD_RE, (match, url) => {
    if (itemImageUrls.has(url) || itemNormUrls.has(normalize(url))) return '';
    const b = basename(url);
    if (b && itemBasenames.has(b)) return '';
    return match;
  });

  // Collapse stray empty bullet markers / whitespace-only lines left behind.
  return stripped
    .replace(/(\n\s*[*\-+]\s*)\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
