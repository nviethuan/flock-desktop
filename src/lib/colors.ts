import type { CSSProperties } from 'react';

/**
 * Neon-friendly palette for the digital clock. Settings store the plain `#rrggbb` value
 * (validated as hex by the Rust side), so the list can grow without a migration.
 */
export interface DigitalColor {
  value: string;
  label: string;
}

export const DIGITAL_COLORS: readonly DigitalColor[] = [
  { value: '#f3f7ff', label: 'Ice' },
  { value: '#22e1ff', label: 'Cyan' },
  { value: '#ff3df0', label: 'Magenta' },
  { value: '#9dff3c', label: 'Lime' },
  { value: '#ffb020', label: 'Amber' },
  { value: '#9d6bff', label: 'Violet' },
  { value: '#ff4f6b', label: 'Coral' },
];

export const DEFAULT_DIGITAL_COLOR = DIGITAL_COLORS[0]!.value;

/** Unknown values (hand-edited settings.json) fall back to the default swatch. */
export function resolveDigitalColor(value: string): string {
  const wanted = value.trim().toLowerCase();
  return DIGITAL_COLORS.find((color) => color.value === wanted)?.value ?? DEFAULT_DIGITAL_COLOR;
}

export function digitalColorLabel(value: string): string {
  const wanted = value.trim().toLowerCase();
  return DIGITAL_COLORS.find((color) => color.value === wanted)?.label ?? DIGITAL_COLORS[0]!.label;
}

/**
 * Inline colour and glow. `useClockLoop` only ever rewrites `font-size` on this node, so
 * the effect can live in React's `style` prop and survives every tick.
 */
export function digitalTextStyle(color: string, neon: boolean): CSSProperties {
  const base = resolveDigitalColor(color);
  if (!neon) return { color: base };
  return {
    // A near-white core is what reads as a lit tube rather than coloured text.
    color: mix(base, '#ffffff', 0.62),
    textShadow: [
      `0 0 0.05em ${rgba(base, 0.9)}`,
      `0 0 0.16em ${base}`,
      `0 0 0.38em ${rgba(base, 0.78)}`,
      `0 0 0.85em ${rgba(base, 0.5)}`,
    ].join(', '),
  };
}

function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  if (!a || !b) return from;
  const blended = a.map((value, index) => Math.round(value + (b[index]! - value) * amount));
  return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function rgba(hex: string, alpha: number): string {
  const values = channels(hex);
  if (!values) return hex;
  return `rgba(${values[0]}, ${values[1]}, ${values[2]}, ${alpha})`;
}

function channels(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
