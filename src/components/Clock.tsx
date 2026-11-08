import { useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { digitalTextStyle } from '../lib/colors';
import { invoke } from '@tauri-apps/api/core';
import { beginWindowDrag } from '../lib/drag';
import { useClockLoop } from '../hooks/useClockLoop';
import { fontStack } from '../lib/fonts';
import type { CountdownDisplay, DisplayMode } from '../lib/settings';
import type { Skin } from '../lib/skins';

/** Share of the type size kept free around the readout so the glow is not clipped. */
const GLOW_PAD_RATIO = 0.3;

/** The clock window hugs the readout, so the side is never the whole story. */
function requestBox(box: { width: number; height: number }): void {
  void invoke('resize_clock_box', { width: box.width, height: box.height }).catch(() => {
    /* resizing is a nicety; a failure must not break the clock */
  });
}

export interface ClockProps {
  skin: Skin;
  displayMode: DisplayMode;
  digitalFormat: string;
  countdownDisplay: CountdownDisplay;
  countdownRemainingSeconds: number;
  countdownEndsAt: number;
  font: string;
  digitalSize: number;
  digitalFit: boolean;
  digitalColor: string;
  digitalNeon: boolean;
  digitalBackdrop: boolean;
  smooth: boolean;
  timeZone: string;
  paused: boolean;
  /** 0-100, applied to the whole clock (the window itself stays transparent). */
  opacity: number;
}

export default function Clock({
  skin,
  displayMode,
  digitalFormat,
  countdownDisplay,
  countdownRemainingSeconds,
  countdownEndsAt,
  font,
  digitalSize,
  digitalFit,
  digitalColor,
  digitalNeon,
  digitalBackdrop,
  smooth,
  timeZone,
  paused,
  opacity,
}: ClockProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const digitalRef = useRef<HTMLSpanElement>(null);

  useClockLoop({
    mode: displayMode,
    hostRef,
    digitalRef,
    digitalFormat,
    countdownDisplay,
    countdownRemainingSeconds,
    countdownEndsAt,
    digitalFont: font,
    digitalSize,
    digitalFit,
    hugKey: `${digitalNeon}|${digitalBackdrop}`,
    onRequestBox: requestBox,
    skinKey: skin.key,
    smooth,
    timeZone,
    paused,
  });

  const openSettings = (): void => {
    void invoke('show_settings').catch(() => {
      /* the tray is still there if the panel cannot open */
    });
  };

  // The whole surface moves the window: sizing belongs to Settings, never to a mouse drag.
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // Where the OS runs the drag (Windows, Linux) it swallows the second click, so the click
    // count is the only signal the webview gets; macOS moves itself and reports a real
    // dblclick instead, and this early exit there just costs one extra focus call.
    if (event.detail >= 2) {
      openSettings();
      return;
    }
    beginWindowDrag(event.nativeEvent);
  };

  if (displayMode === 'digital' || displayMode === 'countdown') {
    const className = digitalBackdrop
      ? 'clock__digital clock__digital--backdrop'
      : 'clock__digital';
    // The glow's outermost layer blurs out to ~0.85em, so the window keeps a slice of that
    // room and the window edge never cuts the halo. Without neon there is nothing to make
    // room for and the window hugs the glyph box.
    const pad = digitalNeon ? Math.round(digitalSize * GLOW_PAD_RATIO) : 0;
    const style = { opacity: opacity / 100, '--clock-pad': `${pad}px` } as CSSProperties;
    return (
      <div
        className="clock clock--digital"
        style={style}
        onPointerDown={beginDrag}
        onDoubleClick={openSettings}
      >
        {/* The loop owns this node's text; React only sets type, colour and glow. */}
        <span
          className={className}
          ref={digitalRef}
          style={{ fontFamily: fontStack(font), ...digitalTextStyle(digitalColor, digitalNeon) }}
        />
      </div>
    );
  }

  return (
    <div className="clock" style={{ opacity: opacity / 100 }} onPointerDown={beginDrag} onDoubleClick={openSettings}>
      {/* skin.markup has been parsed and sanitized by lib/sanitize-svg.ts */}
      <div className="clock__skin" ref={hostRef} dangerouslySetInnerHTML={{ __html: skin.markup }} />
    </div>
  );
}
