/** Digital-clock typefaces. Files are vendored in `src/assets/fonts`. */

export interface ClockFont {
  id: string;
  label: string;
  /** CSS `font-family` value; the stack keeps a system fallback per family style. */
  stack: string;
}

export const FONTS: readonly ClockFont[] = [
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  {
    id: 'share-tech-mono',
    label: 'Share Tech Mono',
    stack: "'Share Tech Mono', ui-monospace, monospace",
  },
  {
    id: 'space-mono',
    label: 'Space Mono',
    stack: "'Space Mono', ui-monospace, monospace",
  },
  {
    id: 'oswald',
    label: 'Oswald',
    stack: "'Oswald', 'Arial Narrow', sans-serif",
  },
  {
    id: 'quicksand',
    label: 'Quicksand',
    stack: "'Quicksand', 'Trebuchet MS', sans-serif",
  },
  {
    id: 'monoton',
    label: 'Monoton',
    stack: "'Monoton', 'Impact', fantasy",
  },
];

export const DEFAULT_FONT = 'jetbrains-mono';

export function isKnownFont(id: string): boolean {
  return FONTS.some((font) => font.id === id);
}

export function fontStack(id: string): string {
  const match = FONTS.find((font) => font.id === id);
  return (match ?? FONTS[0]!).stack;
}

export function fontLabel(id: string): string {
  const match = FONTS.find((font) => font.id === id);
  return match?.label ?? FONTS[0]!.label;
}
