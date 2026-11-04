import { useRef } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { digitalTextStyle } from '../lib/colors';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useClockLoop } from '../hooks/useClockLoop';
import { fontStack } from '../lib/fonts';
import type { DisplayMode } from '../lib/settings';
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

  const beginPress = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // The first press already hands the pointer to the window manager, so the webview never
    // delivers a dblclick for a press that starts a move: the second press is the signal.
    if (event.detail >= 2) {
      openSettings();
      return;
    }

    // The whole surface moves the window: sizing belongs to Settings, never to a mouse drag.
    void getCurrentWindow().startDragging().catch(() => {
      /* dragging is a nicety; a failure must not break the clock */
    });
  };

  if (displayMode === 'digital') {
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
        onMouseDown={beginPress}
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
    <div className="clock" style={{ opacity: opacity / 100 }} onMouseDown={beginPress} onDoubleClick={openSettings}>
      {/* skin.markup has been parsed and sanitized by lib/sanitize-svg.ts */}
      <div className="clock__skin" ref={hostRef} dangerouslySetInnerHTML={{ __html: skin.markup }} />
    </div>
  );
}
