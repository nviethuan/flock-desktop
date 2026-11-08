import { use, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Clock from './components/Clock';
import { useSettings } from './hooks/useSettings';
import { useWindowVisible } from './hooks/useWindowVisible';
import { chooseSkinFile, describeError, loadSkin } from './lib/skins';
import { clockForLabel, settingsReady, updateClockSettings } from './lib/settings';
import type { ClockSettings, Settings } from './lib/settings';

export const PICK_SKIN_EVENT = 'skin://pick';

/** A clock window's label is its clock id; a plain browser dev session shows the first one. */
function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'clock-1';
  }
}

export default function App() {
  // Suspends until the first snapshot arrives; the promise is module-level so it is stable.
  use(settingsReady());
  const settings = useSettings();
  const clock = clockForLabel(settings, currentLabel());

  // An orphaned window (its clock was removed) has nothing to draw; it is being destroyed.
  if (!settings || !clock) return null;
  return <ClockScreen settings={settings} clock={clock} />;
}

function ClockScreen({ settings, clock }: { settings: Settings; clock: ClockSettings }) {
  const skin = use(loadSkin(clock.skinPath));
  const visible = useWindowVisible();
  const [message, setMessage] = useState<string | null>(null);
  const clockId = clock.id;

  // The tray cannot open a webview-owned dialog itself, so it asks this window to. The
  // event is addressed to one clock only, so the picker cannot open several times.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen(PICK_SKIN_EVENT, () => {
      void (async () => {
        try {
          const picked = await chooseSkinFile();
          if (!picked) return;
          await updateClockSettings(clockId, { skinPath: picked.path });
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
  }, [clockId]);

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
        displayMode={clock.displayMode}
        digitalFormat={clock.digitalFormat}
        countdownDisplay={clock.countdownDisplay}
        countdownRemainingSeconds={clock.countdownRemainingSeconds}
        countdownEndsAt={clock.countdownEndsAt}
        countdownAnimation={clock.countdownAnimation}
        countdownAnimationLastSeconds={clock.countdownAnimationLastSeconds}
        font={clock.font}
        digitalSize={clock.digitalSize}
        digitalFit={clock.digitalFit}
        digitalColor={clock.digitalColor}
        digitalNeon={clock.digitalNeon}
        digitalBackdrop={clock.digitalBackdrop}
        smooth={settings.smooth}
        timeZone={clock.timeZone}
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
