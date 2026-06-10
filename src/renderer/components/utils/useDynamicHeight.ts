import { useEffect, useRef, useCallback, RefObject } from 'react';

interface UseDynamicHeightOptions {
  activeTab: string;
  tabRefs: Record<string, RefObject<HTMLElement>>;
  headerHeight?: number;
  inputAreaHeight?: number;
  padding?: number;
  minHeight?: number;
  maxHeight?: number;
  debounceMs?: number;
  suppress?: () => boolean;
  onResize?: (height: number) => void;
}

/**
 * Hook to dynamically adjust overlay height based on active tab content.
 * Measures the visible tab's scrollHeight and sends resize IPC commands.
 * 
 * Features:
 * - Debounced resize IPC (default 100ms)
 * - Height stabilization (waits for content to settle)
 * - Min/max bounds (default 350-900px)
 * - Suppression during window drag/resize
 * - Automatic resize on tab switch
 */
export function useDynamicHeight({
  activeTab,
  tabRefs,
  headerHeight = 52,
  inputAreaHeight = 100,
  padding = 32,
  minHeight = 350,
  maxHeight = 900,
  debounceMs = 100,
  suppress,
  onResize,
}: UseDynamicHeightOptions) {
  const lastHeightRef = useRef<number>(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstMountRef = useRef<boolean>(true);

  const calculateHeight = useCallback((contentHeight: number): number => {
    const total = contentHeight + headerHeight + inputAreaHeight + padding;
    return Math.min(Math.max(total, minHeight), maxHeight);
  }, [headerHeight, inputAreaHeight, padding, minHeight, maxHeight]);

  const sendResize = useCallback((height: number) => {
    if (suppress && suppress()) return;
    
    const ipcRenderer = (window as any).electron?.ipcRenderer;
    if (!ipcRenderer) return;

    // Check if height change is significant enough (>20px)
    const heightDelta = Math.abs(height - lastHeightRef.current);
    if (heightDelta < 20 && lastHeightRef.current !== 0) return;

    lastHeightRef.current = height;
    ipcRenderer.send('unified:resize-window', { height: Math.round(height) });
    onResize?.(height);
  }, [suppress, onResize]);

  const measureAndResize = useCallback(() => {
    if (suppress && suppress()) return;

    const visibleTabRef = tabRefs[activeTab];
    if (!visibleTabRef?.current) return;

    const contentHeight = visibleTabRef.current.scrollHeight;
    const totalHeight = calculateHeight(contentHeight);

    // Clear any pending debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Debounce the resize
    debounceTimerRef.current = setTimeout(() => {
      sendResize(totalHeight);
    }, debounceMs);
  }, [activeTab, tabRefs, calculateHeight, sendResize, suppress, debounceMs]);

  // Resize when active tab changes
  useEffect(() => {
    // Skip first mount to avoid initial resize on load
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }

    // Allow DOM to update display:none/block before measuring
    const timer = setTimeout(() => {
      measureAndResize();
    }, 50);

    return () => clearTimeout(timer);
  }, [activeTab, measureAndResize]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    measureNow: measureAndResize,
    lastHeight: lastHeightRef.current,
  };
}

export default useDynamicHeight;
