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

  const itemImageUrls = new Set(
    items.map(it => it.imageUrl).filter((u): u is string => typeof u === 'string' && u.length > 0)
  );
  if (itemImageUrls.size === 0) return content;

  const stripped = content.replace(IMAGE_MD_RE, (match, url) =>
    itemImageUrls.has(url) ? '' : match
  );

  // Collapse stray empty bullet markers / whitespace-only lines left behind.
  return stripped
    .replace(/(\n\s*[*\-+]\s*)\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
