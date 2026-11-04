import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe } from '../lib/settings';
import type { Settings } from '../lib/settings';

/** Re-renders only when the window broadcasts a new settings snapshot. */
export function useSettings(): Settings | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
