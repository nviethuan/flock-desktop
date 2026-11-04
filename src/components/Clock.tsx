import { useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { digitalTextStyle } from '../lib/colors';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useClockLoop } from '../hooks/useClockLoop';
import { fontStack } from '../lib/fonts';
import type { DisplayMode } from '../lib/settings';
import type { Skin } from '../lib/skins';

/** Share of the type size kept free around the readout so the glow is not clipped. */
const GLOW_PAD_RATIO = 0.3;

/**
 * macOS gives a borderless window no resize border of its own, so the clock grows one here:
 * presses this close to the edge start a resize drag instead of moving the window.
 */
const RESIZE_BAND = 8;

/** The same values `startResizeDragging` takes; the package keeps its type private. */
type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West';

/** Which edge or corner the press landed on, or null for a plain move. */
function resizeDirection(event: ReactPointerEvent<HTMLDivElement>): ResizeDirection | null {
  const { clientX, clientY } = event;
  const { innerWidth, innerHeight } = window;
  const west = clientX < RESIZE_BAND;
  const east = clientX > innerWidth - RESIZE_BAND;
  const north = clientY < RESIZE_BAND;
  const south = clientY > innerHeight - RESIZE_BAND;

  if (north && west) return 'NorthWest';
  if (north && east) return 'NorthEast';
  if (south && west) return 'SouthWest';
  if (south && east) return 'SouthEast';
  if (north) return 'North';
  if (south) return 'South';
  if (west) return 'West';
  if (east) return 'East';
  return null;
}

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

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const clock = getCurrentWindow();
    const direction = resizeDirection(event);

    if (direction) {
      void clock.startResizeDragging(direction).catch(() => {
        /* resizing is a nicety; a failure must not break the clock */
      });
      return;
    }

    void clock.startDragging().catch(() => {
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
      <div className="clock clock--digital" style={style} onPointerDown={beginDrag}>
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
    <div className="clock" style={{ opacity: opacity / 100 }} onPointerDown={beginDrag}>
      {/* skin.markup has been parsed and sanitized by lib/sanitize-svg.ts */}
      <div className="clock__skin" ref={hostRef} dangerouslySetInnerHTML={{ __html: skin.markup }} />
    </div>
  );
}
