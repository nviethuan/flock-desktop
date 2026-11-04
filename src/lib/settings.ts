import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const OPACITY_STEPS = [100, 80, 60, 40] as const;
export type Opacity = (typeof OPACITY_STEPS)[number];

export type DisplayMode = 'analog' | 'digital';

/** Kept in step with `MIN_DIGITAL_SIZE`/`MAX_DIGITAL_SIZE` in `src-tauri/src/settings.rs`. */
export const DIGITAL_SIZE_MIN = 10;
export const DIGITAL_SIZE_MAX = 100;

/** Kept in step with `MIN_SIDE`/`MAX_SIDE` in `src-tauri/src/win.rs` (logical pixels). */
export const ANALOG_SIZE_MIN = 120;
export const ANALOG_SIZE_MAX = 1200;

/**
 * Shape of the settings object persisted by the Rust side in
 * `tauri-plugin-store` (`settings.json`). The window is the single source of truth,
 * so this module only mirrors it; see `src-tauri/src/settings.rs`.
 */
export interface Settings {
  x: number | null;
  y: number | null;
  size: number | null;
  /** Clock window size in logical pixels; analog keeps it square, digital hugs the readout. */
  width: number | null;
  height: number | null;
  skinPath: string;
  opacity: Opacity;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  /** `system` or an IANA zone such as `Europe/Berlin`. */
  timeZone: string;
  smooth: boolean;
  launchAtLogin: boolean;
  displayMode: DisplayMode;
  /** Token pattern for the digital display, e.g. `HH:mm` or `yyyy-MM-dd HH:mm:ss`. */
  digitalFormat: string;
  /** One of `FONTS` in `lib/fonts.ts`. */
  font: string;
  /** Digital type size in CSS pixels (10-100); the clock window hugs it. */
  digitalSize: number;
  /** Translucent pill behind the digital time. */
  digitalBackdrop: boolean;
  /** Neon glow instead of flat text. */
  digitalNeon: boolean;
  /** `#rrggbb` from `DIGITAL_COLORS` in `lib/colors.ts`. */
  digitalColor: string;
  /** Wrap and shrink the readout when a manual drag leaves the window smaller than it. */
  digitalFit: boolean;
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'skinPath'
    | 'opacity'
    | 'width'
    | 'height'
    | 'alwaysOnTop'
    | 'clickThrough'
    | 'timeZone'
    | 'smooth'
    | 'launchAtLogin'
    | 'displayMode'
    | 'digitalFormat'
    | 'font'
    | 'digitalSize'
    | 'digitalBackdrop'
    | 'digitalNeon'
    | 'digitalColor'
    | 'digitalFit'
  >
>;

let snapshot: Settings | null = null;
const listeners = new Set<() => void>();
let ready: Promise<void> | null = null;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Stable snapshot for `useSyncExternalStore`. */
export function getSnapshot(): Settings | null {
  return snapshot;
}

/** Stable subscription for `useSyncExternalStore`. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Resolves once the initial snapshot is in place. The promise is created once, so it is
 * safe to read with `use()` from any number of renders (including StrictMode double renders).
 */
export function settingsReady(): Promise<void> {
  ready ??= (async () => {
    await listen<Settings>('settings://changed', (event) => {
      snapshot = event.payload;
      notify();
    });
    snapshot = await invoke<Settings>('get_settings');
    notify();
  })();
  return ready;
}

/** Writes a patch through the window (which persists it and broadcasts the new snapshot). */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  const next = await invoke<Settings>('update_settings', { patch });
  snapshot = next;
  notify();
}
