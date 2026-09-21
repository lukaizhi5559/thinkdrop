/**
 * React bindings for feedStore — `useSyncExternalStore` (React 18, no deps).
 *
 * RULE: selectors must return state fields or primitives (stable refs).
 * Returning a fresh object/array per call defeats the snapshot check and
 * re-renders every notify — derive with useMemo in the component instead.
 */
import { useSyncExternalStore } from 'react';
import { feedStore, type FeedState } from './feedStore.mts';

export function useFeedStore<T>(selector: (s: FeedState) => T): T {
  return useSyncExternalStore(
    feedStore.subscribe,
    () => selector(feedStore.getState()),
    () => selector(feedStore.getState()),
  );
}

export const useFeedEntries = () => useFeedStore(s => s.entries);
export const useStreamText = () => useFeedStore(s => s.streamText);
export const useCommsTasks = () => useFeedStore(s => s.commsTasks);
