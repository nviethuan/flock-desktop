import { useEffect } from 'react';
import type { RefObject } from 'react';
import { formatDigital } from '../lib/format';
import { handAngles, wallClock } from '../lib/time';
import type { DisplayMode } from '../lib/settings';

interface ClockLoopOptions {
  mode: DisplayMode;
  /** Analog host: contains the skin markup. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Digital text node. */
  digitalRef: RefObject<HTMLSpanElement | null>;
  digitalFormat: string;
  /** Typeface id, so a font swap re-measures the readout. */
  digitalFont: string;
  /** Requested type size in CSS pixels, see `fitDigital`. */
  digitalSize: number;
  /** When true the readout shrinks to stay inside the window; otherwise the size wins. */
  digitalFit: boolean;
  /** Changes when the readout's box changes without a text change (glow room, pill padding). */
  hugKey: string;
  /**
   * Resizes the clock window. `hug` means the box applies as measured (shrinking too);
   * without it the caller only has to grow a window that is too small.
   */
  onRequestBox?: (box: WindowBox, hug: boolean) => void;
  /** Changes whenever the skin markup changes, so hands are re-resolved. */
  skinKey: string;
  smooth: boolean;
  timeZone: string;
  paused: boolean;
}

/** Frames per second for the analog sweep. 30 is smooth and roughly halves idle CPU vs 60. */
const SMOOTH_FPS = 30;

/**
 * Drives the display with direct DOM writes. React never re-renders on a tick: hands get
 * a new `transform`, the digital view gets `textContent`, and nothing else moves.
 */
export function useClockLoop({
  mode,
  hostRef,
  digitalRef,
  digitalFormat,
  digitalFont,
  digitalSize,
  digitalFit,
  hugKey,
  onRequestBox,
  skinKey,
  smooth,
  timeZone,
  paused,
}: ClockLoopOptions): void {
  useEffect(() => {
    let frame = 0;
    let interval = 0;
    let alignment = 0;
    let disposed = false;
    let paint: (() => void) | null = null;

    if (mode === 'digital') {
      const element = digitalRef.current;
      if (element)
        paint = createDigitalPainter(
          element,
          timeZone,
          digitalFormat,
          digitalSize,
          digitalFit,
          onRequestBox,
        );
    } else {
      const host = hostRef.current;
      const hands = host ? resolveHands(host) : null;
      if (hands) paint = createAnalogPainter(hands, timeZone, smooth);
    }

    if (!paint) return;
    const advance = paint;
    advance();

    // Hidden or minimised: stop scheduling entirely (a single repaint already happened).
    if (paused) return;

    if (mode === 'analog' && smooth) {
      const minDelta = 1000 / SMOOTH_FPS;
      let last = 0;
      const step = (timestamp: number): void => {
        if (disposed) return;
        if (timestamp - last >= minDelta) {
          last = timestamp;
          advance();
        }
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    } else {
      // Digital views and tick mode only change once per second: align to the second.
      alignment = window.setTimeout(() => {
        if (disposed) return;
        advance();
        interval = window.setInterval(advance, 1000);
      }, 1000 - (Date.now() % 1000));
    }

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (alignment) window.clearTimeout(alignment);
      if (interval) window.clearInterval(interval);
    };
  }, [
    mode,
    hostRef,
    digitalRef,
    digitalFormat,
    digitalFont,
    digitalSize,
    digitalFit,
    onRequestBox,
    skinKey,
    smooth,
    timeZone,
    paused,
  ]);

  // Only settings changes re-hug the window; the per-second repaint never resizes it.
  useHugWindow(mode, digitalRef, onRequestBox, digitalSize, [
    digitalFormat,
    digitalFont,
    digitalSize,
    digitalFit,
    hugKey,
  ]);
}

interface HandTargets {
  hour: SVGElement;
  minute: SVGElement;
  second: SVGElement;
  cx: number;
  cy: number;
}

function resolveHands(host: HTMLElement): HandTargets | null {
  const svg = host.querySelector<SVGSVGElement>('svg');
  const hour = host.querySelector<SVGElement>('#hour-hand');
  const minute = host.querySelector<SVGElement>('#minute-hand');
  const second = host.querySelector<SVGElement>('#second-hand');
  if (!svg || !hour || !minute || !second) return null;

  const [cx, cy] = pivot(svg);
  return { hour, minute, second, cx, cy };
}

function createAnalogPainter(targets: HandTargets, timeZone: string, smooth: boolean): () => void {
  const { hour, minute, second, cx, cy } = targets;

  return () => {
    const clock = wallClock(timeZone, Date.now());
    // Tick mode snaps the second hand to whole seconds.
    const angles = handAngles(smooth ? clock : { h: clock.h, m: clock.m, s: Math.floor(clock.s) });
    setRotation(hour, angles.hour, cx, cy);
    setRotation(minute, angles.minute, cx, cy);
    setRotation(second, angles.second, cx, cy);
  };
}

/** Never shrink past this, even if the pattern is absurd. */
const MIN_DIGITAL_SIZE = 6;

/** Hard ceiling for the rendered type. */
const MAX_RENDERED_SIZE = 100;

/** Logical window size, in CSS pixels. */
export interface WindowBox {
  width: number;
  height: number;
}

function createDigitalPainter(
  element: HTMLSpanElement,
  timeZone: string,
  pattern: string,
  size: number,
  shrink: boolean,
  onRequestBox: ((box: WindowBox, hug: boolean) => void) | undefined,
): () => void {
  let lastText = '';
  let lastViewport = '';

  return () => {
    const text = formatDigital(timeZone, Date.now(), pattern);
    const viewport = `${window.innerWidth}x${window.innerHeight}`;
    // Digits are tabular, so nothing needs re-measuring until the text or the window changes.
    if (text === lastText && viewport === lastViewport) return;
    lastText = text;
    lastViewport = viewport;
    if (element.textContent !== text) element.textContent = text;

    const requested = Math.max(MIN_DIGITAL_SIZE, Math.min(MAX_RENDERED_SIZE, size));
    if (shrink) {
      fitDigital(element, requested);
      return;
    }

    // The chosen size wins: ask the window to grow around the text instead of clipping it.
    element.style.fontSize = `${requested.toFixed(2)}px`;
    const box = neededBox(element);
    if (
      box.width > window.innerWidth + 1 ||
      box.height > window.innerHeight + 1
    ) {
      onRequestBox?.(box, false);
    }
  };
}

/**
 * Makes the window hug the readout at the chosen size after a size/format/font change,
 * shrinking included. It only runs on those changes, so a manual drag sticks.
 */
function useHugWindow(
  mode: DisplayMode,
  digitalRef: RefObject<HTMLSpanElement | null>,
  onRequestBox: ((box: WindowBox, hug: boolean) => void) | undefined,
  size: number,
  deps: unknown[],
): void {
  useEffect(() => {
    if (mode !== 'digital' || !onRequestBox) return;
    const element = digitalRef.current;
    if (!element) return;

    let cancelled = false;
    const measure = (): void => {
      if (cancelled) return;
      // The chosen size is authoritative here; `fitDigital` only shrinks a manual squeeze.
      element.style.fontSize = `${clampSize(size).toFixed(2)}px`;
      const box = neededBox(element);
      const width = Math.round(window.innerWidth);
      const height = Math.round(window.innerHeight);
      if (Math.abs(box.width - width) > 2 || Math.abs(box.height - height) > 2) {
        onRequestBox(box, true);
      }
    };

    // The painter writes the text and the size first; the webfont also changes the metrics,
    // so measure on the next frame and again whenever a font finishes loading.
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener('loadingdone', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are forwarded by the caller
  }, [mode, digitalRef, onRequestBox, size, ...deps]);
}

function clampSize(size: number): number {
  return Math.max(MIN_DIGITAL_SIZE, Math.min(MAX_RENDERED_SIZE, size));
}

/**
 * Smallest window that hugs the whole readout: the pill's natural (unwrapped) box plus the
 * clock's own padding. The measure class lifts `max-width`/`max-height` for the read: with
 * them in place a too-small window would report its wrapped, squeezed size instead.
 */
const MEASURE_CLASS = 'clock__digital--measure';

function neededBox(element: HTMLSpanElement): WindowBox {
  const host = element.parentElement;
  const hostStyle = host ? window.getComputedStyle(host) : null;

  element.classList.add(MEASURE_CLASS);
  const rect = element.getBoundingClientRect();
  element.classList.remove(MEASURE_CLASS);

  const paddingX = hostStyle ? total(hostStyle.paddingLeft, hostStyle.paddingRight) : 0;
  const paddingY = hostStyle ? total(hostStyle.paddingTop, hostStyle.paddingBottom) : 0;

  // 2 px of slack keeps the anti-aliased glyph edge off the window border.
  return {
    width: Math.ceil(rect.width + paddingX) + 2,
    height: Math.ceil(rect.height + paddingY) + 2,
  };
}

function total(first: string, second: string): number {
  return Number.parseFloat(first) + Number.parseFloat(second);
}

/**
 * Renders at the requested size and wraps first: `white-space: pre-wrap` lets `EEE HH:mm`
 * and `yyyy-MM-dd HH:mm:ss` break at spaces and hyphens, but never inside `HH:mm`, which
 * would look broken. A block that still exceeds the clock area is scaled down, so a long
 * format costs size only as far as the window actually forces.
 */
function fitDigital(element: HTMLSpanElement, requested: number): void {
  const host = element.parentElement;
  if (!host) return;

  const style = window.getComputedStyle(host);
  const box = host.getBoundingClientRect();
  const availableWidth =
    box.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  const availableHeight =
    box.height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
  if (availableWidth <= 0 || availableHeight <= 0) return;

  // Measure the glyph box, not the element box: `max-width`/`max-height` clamp the element
  // even while a line or a wrapped block spills out of it, which would read as a fit. The
  // pill padding is in `em`, so it has to be subtracted at each candidate size.
  const fits = (size: number): boolean => {
    element.style.fontSize = `${size.toFixed(2)}px`;
    const padding = window.getComputedStyle(element);
    const innerWidth =
      availableWidth -
      Number.parseFloat(padding.paddingLeft) -
      Number.parseFloat(padding.paddingRight);
    const innerHeight =
      availableHeight -
      Number.parseFloat(padding.paddingTop) -
      Number.parseFloat(padding.paddingBottom);

    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    // 0.2% of slack absorbs subpixel rounding without letting a line visibly spill.
    return rect.width <= innerWidth * 1.002 && rect.height <= innerHeight * 1.002;
  };

  if (fits(requested)) return;

  // Bisect for the largest size that still shows everything: a single ratio-based jump
  // overshoots, because the wrap pattern changes with the size it is measured at.
  let low = MIN_DIGITAL_SIZE;
  let high = requested;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  element.style.fontSize = `${low.toFixed(2)}px`;
}

function setRotation(element: SVGElement, degrees: number, cx: number, cy: number): void {
  element.setAttribute('transform', `rotate(${degrees.toFixed(2)} ${cx} ${cy})`);
}

/** Hands pivot around the centre of the skin's viewBox. */
function pivot(svg: SVGSVGElement): [number, number] {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const values = viewBox.trim().split(/[\s,]+/).map(Number);
    const [x, y, width, height] = values;
    if (
      values.length === 4 &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height)
    ) {
      return [x + width / 2, y + height / 2];
    }
  }
  return [100, 100];
}
