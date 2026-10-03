/**
 * StreamingRichContent — markdown renderer for content that is still growing.
 *
 * RichContentRenderer re-parses the ENTIRE document (remark-gfm + rehype-raw +
 * Prism + linkify) on every render — at stream rates that's an O(n) parse per
 * rAF frame, O(n²) over a response. This wrapper splits content at blank-line
 * boundaries that are not inside fenced code blocks: committed blocks are
 * parsed exactly once (React.memo), and the in-progress tail re-renders at
 * most ~4x/sec so formatting is preserved without per-frame full parses.
 * When `streaming` is false the full RichContentRenderer renders the finished
 * document, unchanged.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import RichContentRenderer from './RichContentRenderer';
import { stripItemImageMarkdown } from './itemImages';
import type { WebResultItem } from './WebResultCard';

// A committed block's content never changes — parse it exactly once.
const MemoBlock = React.memo(function MemoBlock({ content, className, onFileLinkClick, searchResults }: {
  content: string;
  className?: string;
  onFileLinkClick?: (path: string) => void;
  searchResults?: WebResultItem[];
}) {
  return (
    <RichContentRenderer
      content={content}
      animated={false}
      className={className}
      onFileLinkClick={onFileLinkClick}
      searchResults={searchResults}
    />
  );
});

/** Returns `value` updated at most once per `ms` (trailing-edge flush). */
function useThrottled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const now = Date.now();
    const wait = ms - (now - last.current);
    if (wait <= 0) {
      last.current = now;
      setV(value);
    } else {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        last.current = Date.now();
        setV(value);
      }, wait);
    }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, ms]);
  return v;
}

const TAIL_THROTTLE_MS = 250;

// The in-progress tail is the only part that changes per frame — throttle its
// re-render so partial markdown still formats without parsing every chunk.
function StreamingTail({ content, className, onFileLinkClick, searchResults }: {
  content: string;
  className?: string;
  onFileLinkClick?: (path: string) => void;
  searchResults?: WebResultItem[];
}) {
  const throttled = useThrottled(content, TAIL_THROTTLE_MS);
  return (
    <RichContentRenderer
      content={throttled}
      animated={false}
      className={className}
      onFileLinkClick={onFileLinkClick}
      searchResults={searchResults}
    />
  );
}

const FENCE_RE = /```/g;

// Split at blank-line boundaries that are not inside a fenced code block.
// Returns contiguous committed spans (safe to parse standalone) + the tail.
function splitStableBlocks(content: string): { blocks: string[]; tail: string } {
  const blocks: string[] = [];
  let fences = 0;
  let start = 0;
  let i = 0;
  while (i <= content.length) {
    const next = content.indexOf('\n\n', i);
    const end = next < 0 ? content.length : next;
    const chunk = content.slice(i, end);
    const m = chunk.match(FENCE_RE);
    if (m) fences += m.length;
    if (next >= 0 && fences % 2 === 0 && end > start) {
      blocks.push(content.slice(start, end));
      start = next + 2;
    }
    if (next < 0) break;
    i = next + 2;
  }
  return { blocks, tail: content.slice(start) };
}

export default function StreamingRichContent({ content, streaming, className, onFileLinkClick, searchResults }: {
  content: string;
  streaming: boolean;
  className?: string;
  onFileLinkClick?: (path: string) => void;
  searchResults?: WebResultItem[];
}) {
  const stripped = useMemo(
    () => stripItemImageMarkdown(content, searchResults || []),
    [content, searchResults],
  );
  const { blocks, tail } = useMemo(() => splitStableBlocks(stripped), [stripped]);

  if (!streaming) {
    return (
      <RichContentRenderer
        content={stripped}
        animated
        className={className}
        onFileLinkClick={onFileLinkClick}
        searchResults={searchResults}
      />
    );
  }

  return (
    <>
      {blocks.map((b, i) => (
        <MemoBlock key={i} content={b} className={className} onFileLinkClick={onFileLinkClick} searchResults={searchResults} />
      ))}
      {tail && (
        <StreamingTail content={tail} className={className} onFileLinkClick={onFileLinkClick} searchResults={searchResults} />
      )}
    </>
  );
}
