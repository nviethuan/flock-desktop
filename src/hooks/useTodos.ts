import { useEffect, useSyncExternalStore } from 'react';
import {
  getTodosSnapshot,
  subscribeTodos,
  todosReady,
} from '../lib/todos';
import type { TodosSnapshot } from '../lib/todos';

/**
 * Mirror of the Rust todos cache. The first call starts the listener; the initial snapshot
 * is already local, so the panel and the widget render immediately and only the remote
 * refresh can fail.
 */
export function useTodos(): TodosSnapshot {
  const snapshot = useSyncExternalStore(subscribeTodos, getTodosSnapshot, getTodosSnapshot);
  useEffect(() => {
    void todosReady();
  }, []);
  return snapshot;
}
