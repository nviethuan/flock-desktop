import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

export const VISIBILITY_EVENT = 'clock://visibility';

/**
 * True while the clock is actually on screen. Combines the DOM visibility state
 * (covers minimise on most platforms) with an explicit event from the window, which
 * fires when the tray hides or shows the clock.
 */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const onVisibilityChange = (): void => {
      setVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void listen<boolean>(VISIBILITY_EVENT, (event) => {
      if (!disposed) setVisible(event.payload);
    }).then((unlistenFn) => {
      // StrictMode unmount can race the async listener registration.
      if (disposed) unlistenFn();
      else unlisten = unlistenFn;
    });

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unlisten?.();
    };
  }, []);

  return visible;
}
