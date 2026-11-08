import { useEffect } from 'react';
import type { RefObject } from 'react';
import { formatDigital } from '../lib/format';
import { handAngles, wallClock } from '../lib/time';
import type { CountdownAnimation, CountdownDisplay, DisplayMode } from '../lib/settings';

interface ClockLoopOptions {
  mode: DisplayMode;
  /** Analog host: contains the skin markup. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Digital text node. */
  digitalRef: RefObject<HTMLSpanElement | null>;
  digitalFormat: string;
  countdownDisplay: CountdownDisplay;
  countdownRemainingSeconds: number;
  countdownEndsAt: number;
  countdownAnimation: CountdownAnimation;
  countdownAnimationLastSeconds: number;
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
  countdownDisplay,
  countdownRemainingSeconds,
  countdownEndsAt,
  countdownAnimation,
  countdownAnimationLastSeconds,
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

    if (mode === 'digital' || mode === 'countdown') {
      const element = digitalRef.current;
      if (element && mode === 'digital') {
        paint = createDigitalPainter(
          element,
          timeZone,
          digitalFormat,
          digitalSize,
          digitalFit,
          onRequestBox,
        );
      } else if (element) {
        paint = createCountdownPainter(
          element,
          countdownDisplay,
          countdownRemainingSeconds,
          countdownEndsAt,
          countdownAnimation,
          countdownAnimationLastSeconds,
          digitalSize,
          digitalFit,
          onRequestBox,
        );
      }
    } else {
      const host = hostRef.current;
      const targets = host ? resolveTargets(host) : null;
      if (targets) paint = createAnalogPainter(targets, timeZone, smooth);
    }

    if (!paint) return;
    const advance = paint;
    advance();

    // Hidden, minimised, or already expired: repaint once, then stop scheduling entirely.
    if (paused || (mode === 'countdown' && countdownEndsAt > 0 && countdownEndsAt <= Date.now())) return;

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
      // Align wall clocks to the next whole second. A countdown uses its own phase so its
      // first decrement lands exactly one second after Start, not at the next wall second.
      const now = Date.now();
      const phase = mode === 'countdown' && countdownEndsAt > 0 ? countdownEndsAt % 1000 : now % 1000;
      const delay = (phase - (now % 1000) + 1000) % 1000 || 1000;
      alignment = window.setTimeout(() => {
        if (disposed) return;
        advance();
        interval = window.setInterval(() => {
          advance();
          if (mode === 'countdown' && countdownEndsAt > 0 && Date.now() >= countdownEndsAt) {
            window.clearInterval(interval);
            interval = 0;
          }
        }, 1000);
      }, delay);
    }

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (alignment) window.clearTimeout(alignment);
      if (interval) window.clearInterval(interval);
      if (mode === 'countdown') {
        digitalRef.current?.classList.remove('animate__animated', 'animate__jello', 'animate__rubberBand');
      }
    };
  }, [
    mode,
    hostRef,
    digitalRef,
    digitalFormat,
    countdownDisplay,
    countdownRemainingSeconds,
    countdownEndsAt,
    countdownAnimation,
    countdownAnimationLastSeconds,
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
    countdownDisplay,
    countdownRemainingSeconds,
    countdownEndsAt,
    digitalFont,
    digitalSize,
    digitalFit,
    hugKey,
  ]);
}

/**
 * Two ways a skin can show the time: rotating hands, or progress rings (seconds outside,
 * then minutes, then hours) with an optional live `HH:mm` label in the middle.
 */
interface SkinTargets {
  hands: { hour: SVGElement; minute: SVGElement; second: SVGElement } | null;
  rings: { hour: SVGElement; minute: SVGElement; second: SVGElement } | null;
  label: SVGElement | null;
  cx: number;
  cy: number;
}

function resolveTargets(host: HTMLElement): SkinTargets | null {
  const svg = host.querySelector<SVGSVGElement>('svg');
  if (!svg) return null;

  const find = (id: string): SVGElement | null => host.querySelector<SVGElement>(`#${id}`);
  const hour = find('hour-hand');
  const minute = find('minute-hand');
  const second = find('second-hand');
  const hourRing = find('hour-ring');
  const minuteRing = find('minute-ring');
  const secondRing = find('second-ring');

  const hands = hour && minute && second ? { hour, minute, second } : null;
  const rings =
    hourRing && minuteRing && secondRing
      ? { hour: hourRing, minute: minuteRing, second: secondRing }
      : null;
  if (!hands && !rings) return null;

  const [cx, cy] = pivot(svg);
  return { hands, rings, label: find('center-label'), cx, cy };
}

function createAnalogPainter(targets: SkinTargets, timeZone: string, smooth: boolean): () => void {
  const { hands, rings, label, cx, cy } = targets;
  let lastLabel = '';

  return () => {
    const clock = wallClock(timeZone, Date.now());
    // Tick mode snaps the hands and the rings to whole seconds.
    const time = smooth ? clock : { h: clock.h, m: clock.m, s: Math.floor(clock.s) };

    if (hands) {
      const angles = handAngles(time);
      setRotation(hands.hour, angles.hour, cx, cy);
      setRotation(hands.minute, angles.minute, cx, cy);
      setRotation(hands.second, angles.second, cx, cy);
    }

    if (rings) {
      // Seconds alternate one minute at a time, both phases clockwise: an even minute
      // fills from twelve towards the hand, the next one is drained the same way, so each
      // phase ends exactly where the following one starts.
      const progress = time.s / 60;
      if (time.m % 2 === 0) {
        setProgress(rings.second, progress);
      } else {
        const remaining = 1 - progress;
        setProgress(rings.second, remaining, 2 * remaining);
      }
      setProgress(rings.minute, (time.m + time.s / 60) / 60);
      // The hour ring wraps every twelve hours, the other two every sixty units.
      setProgress(rings.hour, ((time.h % 12) + time.m / 60) / 12);
    }

    if (label) {
      const text = `${pad2(time.h)}:${pad2(time.m)}`;
      if (text !== lastLabel) {
        lastLabel = text;
        label.textContent = text;
      }
    }
  };
}

/**
 * Rings carry `pathLength="1"`, so the dash is a fraction of the ring and the painter
 * never has to know a circumference.
 *
 * A positive `dashOffset` slides the dash forward, which is how the seconds ring is eaten
 * from twelve instead of growing away from it: with a dash of `p`, offsetting by `2p`
 * leaves the arc between the second hand and twelve.
 */
function setProgress(ring: SVGElement, fraction: number, dashOffset = 0): void {
  const value = Math.max(0, Math.min(1, fraction));
  const dash = `${value.toFixed(4)} 1`;
  if (ring.getAttribute('stroke-dasharray') !== dash) {
    ring.setAttribute('stroke-dasharray', dash);
  }
  // Always written, so a ring that switches back to growing starts from twelve again.
  const offset = Math.max(0, dashOffset).toFixed(4);
  if (ring.getAttribute('stroke-dashoffset') !== offset) {
    ring.setAttribute('stroke-dashoffset', offset);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
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

function createCountdownPainter(
  element: HTMLSpanElement,
  display: CountdownDisplay,
  remainingSeconds: number,
  endsAt: number,
  animation: CountdownAnimation,
  animationLastSeconds: number,
  size: number,
  shrink: boolean,
  onRequestBox: ((box: WindowBox, hug: boolean) => void) | undefined,
): () => void {
  let lastText = element.textContent ?? '';
  let lastViewport = '';
  return () => {
    const now = Date.now();
    const running = endsAt > now;
    const left = running ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : endsAt > 0 ? 0 : remainingSeconds;
    const text = display === 'seconds' ? String(left) : formatCountdown(left);
    const viewport = `${window.innerWidth}x${window.innerHeight}`;
    const textChanged = text !== lastText;
    if (!textChanged && viewport === lastViewport) return;
    if (textChanged) {
      if (lastText && running && left > 0 && left <= animationLastSeconds && animation) {
        element.classList.remove('animate__animated', 'animate__jello', 'animate__rubberBand');
        void element.offsetWidth;
        element.classList.add('animate__animated', animation);
      }
      lastText = text;
    }
    lastViewport = viewport;
    if (element.textContent !== text) element.textContent = text;
    if (left === 0) {
      element.classList.remove('animate__animated', 'animate__jello', 'animate__rubberBand');
    }
    const requested = Math.max(MIN_DIGITAL_SIZE, Math.min(MAX_RENDERED_SIZE, size));
    if (shrink) {
      fitDigital(element, requested);
      return;
    }
    element.style.fontSize = `${requested.toFixed(2)}px`;
    const box = neededBox(element);
    if (box.width > window.innerWidth + 1 || box.height > window.innerHeight + 1) {
      onRequestBox?.(box, false);
    }
  };
}

function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${pad2(minutes)}:${pad2(seconds % 60)}`;
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
    if ((mode !== 'digital' && mode !== 'countdown') || !onRequestBox) return;
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
