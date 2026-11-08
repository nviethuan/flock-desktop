import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const OPACITY_STEPS = [100, 80, 60, 40] as const;
export type Opacity = (typeof OPACITY_STEPS)[number];

export type DisplayMode = 'analog' | 'digital' | 'countdown';
export type CountdownDisplay = 'hhmmss' | 'seconds';
export type CountdownAnimation = '' | 'animate__jello' | 'animate__rubberBand';

/** Kept in step with `MIN_DIGITAL_SIZE`/`MAX_DIGITAL_SIZE` in `src-tauri/src/settings.rs`. */
export const DIGITAL_SIZE_MIN = 10;
export const DIGITAL_SIZE_MAX = 100;

/** Kept in step with `MIN_SIDE`/`MAX_SIDE` in `src-tauri/src/win.rs` (logical pixels). */
export const ANALOG_SIZE_MIN = 120;
export const ANALOG_SIZE_MAX = 1200;

/** Kept in step with `MAX_CLOCKS` in `src-tauri/src/settings.rs`. */
export const MAX_CLOCKS = 8;

/** One always-on-top window; `id` is also its window label (`clock-1`, `clock-2`, …). */
export interface ClockSettings {
  id: string;
  x: number | null;
  y: number | null;
  /** Window size in logical pixels; analog keeps it square, digital hugs the readout. */
  width: number | null;
  height: number | null;
  skinPath: string;
  /** `system` or an IANA zone such as `Europe/Berlin`. */
  timeZone: string;
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
  /** Configured duration used by countdown Reset and Start after expiry. */
  countdownDurationSeconds: number;
  /** Remaining seconds saved when paused. */
  countdownRemainingSeconds: number;
  /** Absolute Unix time in milliseconds when the running countdown expires; zero means paused. */
  countdownEndsAt: number;
  /** Countdown readout style: padded clock or total seconds. */
  countdownDisplay: CountdownDisplay;
  /** Optional animation played when countdown digits change. */
  countdownAnimation: CountdownAnimation;
  /** Animate only when this many seconds or fewer remain (1-60). */
  countdownAnimationLastSeconds: number;
  /** Play an OS alert sound when the countdown reaches zero. */
  countdownAlert: boolean;
  /** Id from `alertSounds()` in `lib/sounds.ts`; empty means the OS default. */
  countdownAlertSound: string;
  /** Play the selected sound at each tick in the last N seconds (0 disables, max 15). */
  countdownAlertTickSeconds: number;
}

/**
 * Shape of the settings object persisted by the Rust side in
 * `tauri-plugin-store` (`settings.json`). The window is the single source of truth,
 * so this module only mirrors it; see `src-tauri/src/settings.rs`.
 */
export interface Settings {
  /** At least one clock, at most `MAX_CLOCKS`. */
  clocks: ClockSettings[];
  /** 0-100, applied to every clock. */
  opacity: Opacity;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  smooth: boolean;
  launchAtLogin: boolean;
  /** macOS only: the app runs as an accessory, so it has no Dock icon. */
  hideDockIcon: boolean;
}

/** App-wide switches; the look of one clock is a `ClockPatch`. */
export type SettingsPatch = Partial<
  Pick<
    Settings,
    'opacity' | 'alwaysOnTop' | 'clickThrough' | 'smooth' | 'launchAtLogin' | 'hideDockIcon'
  >
>;

/** Bounds are owned by the window itself, so they are not part of a look patch. */
export type ClockPatch = Partial<Omit<ClockSettings, 'id' | 'x' | 'y'>>;

let snapshot: Settings | null = null;
const listeners = new Set<() => void>();
let ready: Promise<void> | null = null;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function publish(next: Settings): Settings {
  snapshot = next;
  notify();
  return next;
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
      publish(event.payload);
    });
    publish(await invoke<Settings>('get_settings'));
  })();
  return ready;
}

/**
 * The clock a window label belongs to. A clock window's label *is* its id; `null` means the
 * window is orphaned (its clock was removed), which the view renders as nothing.
 */
export function clockForLabel(settings: Settings | null, label: string): ClockSettings | null {
  return settings?.clocks.find((clock) => clock.id === label) ?? null;
}

export function clockById(settings: Settings | null, id: string | null): ClockSettings | null {
  if (!settings || !id) return null;
  return settings.clocks.find((clock) => clock.id === id) ?? null;
}

/** Edits the look of one clock: skin, mode, pattern, font, size, colours, time zone. */
export async function updateClockSettings(clockId: string, patch: ClockPatch): Promise<Settings> {
  return publish(await invoke<Settings>('update_clock', { clockId, patch }));
}

/** Opens one more clock window; the new clock is the last entry of the new snapshot. */
export async function addClock(): Promise<Settings> {
  return publish(await invoke<Settings>('add_clock'));
}

/** Destroys one clock window. The store keeps at least one clock. */
export async function removeClock(clockId: string): Promise<Settings> {
  return publish(await invoke<Settings>('remove_clock', { clockId }));
}

/** Writes a patch through the window (which persists it and broadcasts the new snapshot). */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return publish(await invoke<Settings>('update_settings', { patch }));
}

export type TimeZone = readonly [zone: string, label: string];

let zones: Promise<readonly TimeZone[]> | null = null;

/** The curated zone list lives in Rust, so the tray and the panel can never disagree. */
export function timeZones(): Promise<readonly TimeZone[]> {
  zones ??= invoke<TimeZone[]>('time_zones').catch((): TimeZone[] => [['system', 'System']]);
  return zones;
}
