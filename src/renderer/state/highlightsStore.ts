/**
 * highlightsStore — external store for the context-highlight chips.
 *
 * File/folder drops, pastes, and `highlights:*` IPC events all write the same
 * array. Keeping it in UnifiedOverlay root state meant every drop re-rendered
 * the ENTIRE overlay tree (the 1–3s chip delay) — PromptInputBar is the only
 * visual consumer, so it subscribes via useSyncExternalStore and everything
 * else reads/writes imperatively.
 */
import { useSyncExternalStore } from 'react';

export type Highlight = string;

let _highlights: Highlight[] = [];
const _listeners = new Set<() => void>();

function _emit() {
  for (const l of _listeners) l();
}

export const highlightsStore = {
  get: (): Highlight[] => _highlights,
  subscribe(fn: () => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  },
  /** Same updater semantics as React setState — accepts a value or updater fn. */
  set(next: Highlight[] | ((prev: Highlight[]) => Highlight[])) {
    _highlights = typeof next === 'function' ? next(_highlights) : next;
    _emit();
  },
  clear() {
    if (_highlights.length === 0) return;
    _highlights = [];
    _emit();
  },
};

export function useHighlights(): Highlight[] {
  return useSyncExternalStore(highlightsStore.subscribe, highlightsStore.get);
}
