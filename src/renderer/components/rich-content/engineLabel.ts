/**
 * engineLabel.ts — human label for the search provider key carried on a
 * reply/task (`google-serp`, `bing-copilot`, `brave-web`, …). Rendered as a
 * small transparency chip so the user can see which engine answered. Unknown
 * keys title-case the raw provider so future API integrations show up
 * without a code change.
 */

const ENGINE_LABELS: Record<string, string> = {
  'google-serp': 'Google Search',
  'bing-serp': 'Bing Search',
  'bing-copilot': 'Bing Copilot Search',
  'duckduckgo': 'DuckDuckGo',
  'searxng': 'SearXNG',
  'newsapi': 'NewsAPI',
  'bible-api': 'Bible API',
};

// Anything that is obviously not a search engine shouldn't render a chip.
const HIDDEN = new Set(['llm-fallback', 'web-search']);

export function engineLabel(engine?: string | null): string | null {
  if (!engine) return null;
  if (HIDDEN.has(engine)) return null;
  if (engine.startsWith('brave-')) return 'Brave Search';
  return ENGINE_LABELS[engine] || engine.replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
