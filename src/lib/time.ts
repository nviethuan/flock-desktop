export interface WallClock {
  /** Hours in the selected zone, 0-23. */
  h: number;
  /** Minutes, 0-59. */
  m: number;
  /** Seconds including a fractional part for smooth sweeps. */
  s: number;
}

export interface HandAngles {
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Returns true for `system` and for IANA zones this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === 'system') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (timeZone === 'system') return null;
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  if (!isValidTimeZone(timeZone)) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Wall-clock time in `timeZone` at `epochMs`.
 *
 * `Intl.DateTimeFormat` only reports whole seconds, so the fraction is taken from the
 * timestamp itself; that keeps the smooth sweep accurate without a second API call.
 */
export function wallClock(timeZone: string, epochMs: number): WallClock {
  const fraction = (epochMs % 1000) / 1000;
  const formatter = formatterFor(timeZone);

  if (!formatter) {
    const date = new Date(epochMs);
    return { h: date.getHours(), m: date.getMinutes(), s: date.getSeconds() + fraction };
  }

  let h = 0;
  let m = 0;
  let s = 0;
  for (const part of formatter.formatToParts(epochMs)) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === 'hour') h = value % 24;
    else if (part.type === 'minute') m = value;
    else if (part.type === 'second') s = value;
  }
  return { h, m, s: s + fraction };
}

/** Rotation in degrees for each hand, clockwise from 12 o'clock. */
export function handAngles(clock: WallClock): HandAngles {
  return {
    hour: (clock.h % 12) * 30 + clock.m * 0.5 + clock.s * (0.5 / 60),
    minute: clock.m * 6 + clock.s * 0.1,
    second: clock.s * 6,
  };
}
