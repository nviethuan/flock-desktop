import { use, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import Clock from './components/Clock';
import { useSettings } from './hooks/useSettings';
import { useWindowVisible } from './hooks/useWindowVisible';
import { chooseSkinFile, describeError, loadSkin } from './lib/skins';
import { settingsReady, updateSettings } from './lib/settings';
import type { Settings } from './lib/settings';

export const PICK_SKIN_EVENT = 'skin://pick';

export default function App() {
  // Suspends until the first snapshot arrives; the promise is module-level so it is stable.
  use(settingsReady());
  const settings = useSettings();

  if (!settings) return null;
  return <ClockScreen settings={settings} />;
}

function ClockScreen({ settings }: { settings: Settings }) {
  const skin = use(loadSkin(settings.skinPath));
  const visible = useWindowVisible();
  const [message, setMessage] = useState<string | null>(null);

  // The tray cannot open a webview-owned dialog itself, so it asks us to.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen(PICK_SKIN_EVENT, () => {
      void (async () => {
        try {
          const picked = await chooseSkinFile();
          if (!picked) return;
          await updateSettings({ skinPath: picked.path });
        } catch (error) {
          if (!disposed) setMessage(describeError(error));
        }
      })();
    }).then((unlistenFn) => {
      if (disposed) unlistenFn();
      else unlisten = unlistenFn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Picker errors are transient; skin validation errors stay visible while they apply.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const notice = message ?? skin.error;

  return (
    <div className="app">
      <Clock
        skin={skin}
        displayMode={settings.displayMode}
        digitalFormat={settings.digitalFormat}
        font={settings.font}
        digitalSize={settings.digitalSize}
        digitalFit={settings.digitalFit}
        digitalColor={settings.digitalColor}
        digitalNeon={settings.digitalNeon}
        digitalBackdrop={settings.digitalBackdrop}
        smooth={settings.smooth}
        timeZone={settings.timeZone}
        paused={!visible}
        opacity={settings.opacity}
      />
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
