import { invoke } from '@tauri-apps/api/core';

/** One alert sound the OS offers: a system alert tone or an alarm/ring tone. */
export interface AlertSound {
  /** Absolute path, chosen by the picker; Rust re-checks it before playing. */
  id: string;
  label: string;
}

let sounds: Promise<readonly AlertSound[]> | null = null;

/**
 * The list is discovered by the window (Rust scans the OS sound libraries), so the tray,
 * the panel and the countdown can never disagree about what is available.
 */
export function alertSounds(): Promise<readonly AlertSound[]> {
  sounds ??= invoke<AlertSound[]>('alert_sounds').catch((): AlertSound[] => []);
  return sounds;
}

/** Plays one alert sound; an empty id plays the OS default. */
export function playAlertSound(soundId: string): void {
  void invoke('play_alert_sound', { soundId }).catch(() => {
    /* a missing sound file must never break the clock */
  });
}
