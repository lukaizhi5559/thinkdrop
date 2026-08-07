import { useEffect, useRef, useCallback, RefObject } from 'react';

// Collapsed height = header (row1 ~36) + tabbar (~40) + input area (~120) + footer/padding.
// Keep in sync with UNIFIED_COLLAPSED_HEIGHT in src/main/main.js (applyUnifiedBounds).
export const COLLAPSED_HEIGHT = 220;

// Maximum total window height the renderer will ever request. The main process
// also clamps to (workAreaHeight - 2*margin), so this is just an upper bound for
// very tall screens.
export const MAX_HEIGHT = 900;

// Minimum delta (px) before a resize IPC is sent — avoids jitter on tiny layout shifts.
const HEIGHT_DELTA_THRESHOLD = 12;

// Padding (p-4 = 16px top + 16px bottom) on the results scroll container. The results
// entry in contentRefs points at the INNER auto-height content div, whose scrollHeight
// excludes the container's own padding — so we add it back here. Other tab containers
// are measured directly (their scrollHeight already includes their own padding).
const RESULTS_CONTAINER_PADDING = 32;

// Below this measured content height the results tab is treated as empty → collapse.
const EMPTY_CONTENT_THRESHOLD = 8;

interface UseDynamicHeightOptions {
  activeTab: string;
  /** Fixed header (row1 + TabBar). */
  headerRef: RefObject<HTMLElement>;
  /** Bottom input bar (textarea + action buttons). */
  inputBarRef: RefObject<HTMLElement>;
  /** Per-tab content measurement targets.
   *  - `results`: the INNER auto-height content div (NOT the h-full scroll container —
   *    a scroll container's scrollHeight can't drop below its clientHeight, which is
   *    window-constrained → ratchet).
   *  - other tabs: the tab container itself (height:auto → scrollHeight = intrinsic
   *    content height including its own padding). */
  contentRefs: Record<string, RefObject<HTMLElement>>;
  /** Desired window width (drives the width sent alongside the height). */
  getWidth?: () => number;
  /** When set, all measurements report this height (used to pin MAX_HEIGHT while expanded). */
  forceHeight?: number | null;
  debounceMs?: number;
  /** When true, all resize IPC is suppressed (e.g. while the user drags/resizes the window). */
  suppress?: () => boolean;
  onResize?: (height: number) => void;
}

/**
 * Dynamic overlay height — single consolidated pipeline.
 *
 * Measures the FIXED sections (header + input bar) plus the ACTIVE tab's
 * intrinsic content height. Collapse is purely measurement-driven: when the
 * results tab's content measures ~0, we report COLLAPSED_HEIGHT. Any rendered
 * content (stream, auth card, schedule card, automation phases) measures > 0,
 * so the panel can never collapse while content is visible.
 *
 * Sends one IPC: `unified:set-content-height`. The main process owns all
 * clamping + anchoring.
 */
export function useDynamicHeight({
  activeTab,
  headerRef,
  inputBarRef,
  contentRefs,
  getWidth,
  forceHeight = null,
  debounceMs = 120,
  suppress,
  onResize,
}: UseDynamicHeightOptions) {
  const lastHeightRef = useRef<number>(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const computeTargetHeight = useCallback((): number => {
    // Pinned (expanded) mode: always report the forced height regardless of content.
    if (forceHeight != null) return forceHeight;

    const contentEl = contentRefs[activeTab]?.current;
    let contentH = contentEl ? contentEl.scrollHeight : 0;
    if (activeTab === 'results') {
      // Measurement-driven collapse: no rendered content → collapsed height.
      if (contentH < EMPTY_CONTENT_THRESHOLD) return COLLAPSED_HEIGHT;
      contentH += RESULTS_CONTAINER_PADDING;
    }

    const headerH = headerRef.current?.offsetHeight ?? 0;
    const inputH = inputBarRef.current?.offsetHeight ?? 0;
    const total = headerH + inputH + contentH;
    if (total <= COLLAPSED_HEIGHT) return COLLAPSED_HEIGHT;
    return Math.min(total, MAX_HEIGHT);
  }, [activeTab, headerRef, inputBarRef, contentRefs, forceHeight]);

  const sendResize = useCallback((height: number) => {
    if (suppress && suppress()) return;
    const ipcRenderer = (window as any).electron?.ipcRenderer;
    if (!ipcRenderer) return;

    // Skip insignificant deltas (but always allow a collapse to COLLAPSED_HEIGHT).
    const delta = Math.abs(height - lastHeightRef.current);
    if (lastHeightRef.current !== 0 && delta < HEIGHT_DELTA_THRESHOLD && height !== COLLAPSED_HEIGHT) return;

    lastHeightRef.current = height;
    const width = getWidth?.();
    ipcRenderer.send('unified:set-content-height', {
      height: Math.round(height),
      ...(width != null ? { width: Math.round(width) } : {}),
      animate: true,
    });
    onResize?.(height);
  }, [suppress, getWidth, onResize]);

  const measureAndResize = useCallback(() => {
    if (suppress && suppress()) return;
    const target = computeTargetHeight();

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      sendResize(target);
    }, debounceMs);
  }, [computeTargetHeight, sendResize, suppress, debounceMs]);

  // ResizeObserver on header + input bar + all tab content targets.
  // - Content growth (streaming, automation, list loads) fires via the content targets.
  // - Textarea auto-resize grows the input bar → caught here.
  // - display:none elements report 0×0 and re-fire when shown → tab switches caught here.
  useEffect(() => {
    const elements: HTMLElement[] = [];
    if (headerRef.current) elements.push(headerRef.current);
    if (inputBarRef.current) elements.push(inputBarRef.current);
    for (const ref of Object.values(contentRefs)) {
      if (ref.current) elements.push(ref.current);
    }
    if (elements.length === 0) return;

    if (observerRef.current) observerRef.current.disconnect();

    const obs = new ResizeObserver(() => {
      measureAndResize();
    });
    for (const el of elements) obs.observe(el);
    observerRef.current = obs;

    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
    // contentRefs is memoized at the call site — stable identity across renders.
  }, [headerRef, inputBarRef, contentRefs, measureAndResize]);

  // Re-measure on tab switch (guarantees a fresh measurement after display:none→block).
  useEffect(() => {
    const t = setTimeout(() => measureAndResize(), 50);
    return () => clearTimeout(t);
  }, [activeTab, measureAndResize]);

  // Cleanup debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return {
    measureNow: measureAndResize,
    lastHeight: lastHeightRef.current,
  };
}

export default useDynamicHeight;
