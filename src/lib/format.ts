/**
 * The digital clock's token formatter.
 *
 * Patterns follow the usual ISO/Unicode token style: `HH:mm` (24h), `hh:mm A` (12h),
 * `yyyy-MM-dd HH:mm:ss` (ISO 8601). Literal text goes in single quotes, e.g. `HH:mm 'UTC'`.
 */

export const DEFAULT_FORMAT = 'HH:mm';
export const MAX_FORMAT_LENGTH = 64;

export const FORMAT_PRESETS = [
  'HH:mm',
  'HH:mm:ss',
  'hh:mm A',
  'EEE HH:mm',
  'yyyy-MM-dd',
  'yyyy-MM-dd HH:mm:ss',
] as const;

export const FORMAT_TOKENS = [
  ['HH', 'hour, 24h, 2 digits'],
  ['H', 'hour, 24h'],
  ['hh', 'hour, 12h, 2 digits'],
  ['h', 'hour, 12h'],
  ['mm', 'minute, 2 digits'],
  ['m', 'minute'],
  ['ss', 'second, 2 digits'],
  ['s', 'second'],
  ['a / A', 'am/pm, AM/PM'],
  ['EEE / EEEE', 'weekday, short / long'],
  ['yyyy / yy', 'year'],
  ['MMMM / MMM', 'month name, long / short'],
  ['MM / M', 'month number'],
  ['dd / d', 'day'],
] as const;

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayLong: string;
  weekdayShort: string;
  monthLong: string;
  monthShort: string;
}

type Piece = string | { token: string };

const TOKENS = [
  'yyyy',
  'MMMM',
  'MMM',
  'EEEE',
  'EEE',
  'yy',
  'MM',
  'HH',
  'hh',
  'mm',
  'ss',
  'dd',
  'M',
  'd',
  'H',
  'h',
  'm',
  's',
  'a',
  'A',
];

const formatters = new Map<string, Intl.DateTimeFormat>();
const compiled = new Map<string, Piece[]>();

export function isValidFormat(pattern: string): boolean {
  return pattern.trim().length > 0 && pattern.length <= MAX_FORMAT_LENGTH;
}

/** Renders `pattern` for the wall clock in `timeZone` at `epochMs`. */
export function formatDigital(timeZone: string, epochMs: number, pattern: string): string {
  const pieces = compile(pattern);
  const parts = partsFor(timeZone, epochMs);
  let output = '';
  for (const piece of pieces) {
    output += typeof piece === 'string' ? piece : renderToken(piece.token, parts);
  }
  return output;
}

/** A sample rendering for the settings preview; invalid patterns fall back to `HH:mm`. */
export function previewFormat(timeZone: string, pattern: string): string {
  return formatDigital(timeZone, Date.now(), isValidFormat(pattern) ? pattern : DEFAULT_FORMAT);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  const options: Intl.DateTimeFormatOptions = {
    hourCycle: 'h23',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  };

  try {
    const formatter =
      timeZone === 'system'
        ? new Intl.DateTimeFormat('en-US', options)
        : new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    // Unknown zone in a stored setting: behave like the system zone.
    return formatterFor('system');
  }
}

const monthFormatters = new Map<string, Intl.DateTimeFormat>();

function monthFormatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = monthFormatters.get(timeZone);
  if (cached) return cached;

  try {
    const formatter =
      timeZone === 'system'
        ? new Intl.DateTimeFormat('en-US', { month: 'long' })
        : new Intl.DateTimeFormat('en-US', { timeZone, month: 'long' });
    monthFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return monthFormatterFor('system');
  }
}

function partsFor(timeZone: string, epochMs: number): DateParts {
  const parts: DateParts = {
    year: 0,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    weekdayLong: '',
    weekdayShort: '',
    monthLong: '',
    monthShort: '',
  };

  for (const part of formatterFor(timeZone).formatToParts(epochMs)) {
    const value = Number(part.value);
    switch (part.type) {
      case 'year':
        parts.year = value;
        break;
      case 'month':
        parts.month = value;
        break;
      case 'day':
        parts.day = value;
        break;
      case 'hour':
        parts.hour = value % 24;
        break;
      case 'minute':
        parts.minute = value;
        break;
      case 'second':
        parts.second = value;
        break;
      case 'weekday':
        parts.weekdayLong = part.value;
        parts.weekdayShort = part.value.slice(0, 3);
        break;
      default:
        break;
    }
  }

  const monthLong = monthFormatterFor(timeZone).format(epochMs);
  parts.monthLong = monthLong;
  parts.monthShort = monthLong.slice(0, 3);

  return parts;
}

function compile(pattern: string): Piece[] {
  const source = pattern.trim() === '' ? DEFAULT_FORMAT : pattern;
  const cached = compiled.get(source);
  if (cached) return cached;

  const pieces = parse(source);
  compiled.set(source, pieces);
  return pieces;
}

function parse(source: string): Piece[] {
  const pieces: Piece[] = [];
  let literal = '';
  let index = 0;

  const flush = (): void => {
    if (literal) {
      pieces.push(literal);
      literal = '';
    }
  };

  while (index < source.length) {
    const char = source[index] ?? '';

    if (char === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) {
        literal += source.slice(index + 1);
        break;
      }
      const quoted = source.slice(index + 1, end);
      // `''` is an escaped quote, matching ICU behaviour.
      literal += quoted === '' ? "'" : quoted;
      index = end + 1;
      continue;
    }

    const token = TOKENS.find((candidate) => source.startsWith(candidate, index));
    if (token) {
      flush();
      pieces.push({ token });
      index += token.length;
      continue;
    }

    // An unrecognised letter run is kept verbatim (quote it to be explicit).
    if (/[A-Za-z]/.test(char)) {
      let end = index;
      while (end < source.length && /[A-Za-z]/.test(source[end] ?? '')) end += 1;
      literal += source.slice(index, end);
      index = end;
      continue;
    }

    literal += char;
    index += 1;
  }

  flush();
  return pieces;
}

function renderToken(token: string, parts: DateParts): string {
  switch (token) {
    case 'yyyy':
      return String(parts.year);
    case 'yy':
      return pad2(parts.year % 100);
    case 'MMMM':
      return parts.monthLong;
    case 'MMM':
      return parts.monthShort;
    case 'MM':
      return pad2(parts.month);
    case 'M':
      return String(parts.month);
    case 'dd':
      return pad2(parts.day);
    case 'd':
      return String(parts.day);
    case 'HH':
      return pad2(parts.hour);
    case 'H':
      return String(parts.hour);
    case 'hh':
      return pad2(hour12(parts.hour));
    case 'h':
      return String(hour12(parts.hour));
    case 'mm':
      return pad2(parts.minute);
    case 'm':
      return String(parts.minute);
    case 'ss':
      return pad2(parts.second);
    case 's':
      return String(parts.second);
    case 'a':
      return parts.hour < 12 ? 'am' : 'pm';
    case 'A':
      return parts.hour < 12 ? 'AM' : 'PM';
    case 'EEE':
      return parts.weekdayShort;
    case 'EEEE':
      return parts.weekdayLong;
    default:
      return token;
  }
}

function hour12(hour: number): number {
  return hour % 12 === 0 ? 12 : hour % 12;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
