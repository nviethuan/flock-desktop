import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import bauhausSvg from '../skins/bauhaus.svg?raw';
import defaultSvg from '../skins/default.svg?raw';
import dialSvg from '../skins/dial.svg?raw';
import minimalSvg from '../skins/minimal.svg?raw';
import neonSvg from '../skins/neon.svg?raw';
import { sanitizeSvg } from './sanitize-svg';

export interface Skin {
  key: string;
  /** Already sanitized; safe for `dangerouslySetInnerHTML`. */
  markup: string;
  source: 'builtin' | 'custom';
  error: string | null;
}

interface BuiltinSkin {
  key: string;
  label: string;
  markup: string;
}

/** Kept in step with `BUILTIN_SKINS` in `src-tauri/src/tray.rs` (keys and labels). */
export const BUILTIN_SKINS: readonly BuiltinSkin[] = [
  { key: 'builtin:default', label: 'Default', markup: defaultSvg },
  { key: 'builtin:minimal', label: 'Minimal', markup: minimalSvg },
  { key: 'builtin:dial', label: 'Classic', markup: dialSvg },
  { key: 'builtin:neon', label: 'Neon', markup: neonSvg },
  { key: 'builtin:bauhaus', label: 'Bauhaus', markup: bauhausSvg },
];

export const DEFAULT_SKIN_KEY = 'builtin:default';

const cache = new Map<string, Promise<Skin>>();

/** Loads (and caches) a skin by key or absolute path. Never rejects: failures fall back. */
export function loadSkin(skinPath: string): Promise<Skin> {
  const cached = cache.get(skinPath);
  if (cached) return cached;
  const pending = resolveSkin(skinPath);
  cache.set(skinPath, pending);
  return pending;
}

async function resolveSkin(skinPath: string): Promise<Skin> {
  const builtin = BUILTIN_SKINS.find((skin) => skin.key === skinPath);
  if (builtin) {
    const result = sanitizeSvg(builtin.markup);
    if (result.ok) return { key: builtin.key, markup: result.markup, source: 'builtin', error: null };
    return fallback(`Built-in skin "${builtin.label}" is invalid: ${result.reason}`);
  }

  try {
    const raw = await invoke<string>('read_skin_file', { path: skinPath });
    const result = sanitizeSvg(raw);
    if (!result.ok) return fallback(`Custom skin rejected: ${result.reason}`);
    return { key: skinPath, markup: result.markup, source: 'custom', error: null };
  } catch (error) {
    return fallback(`Could not load custom skin: ${describeError(error)}`);
  }
}

function fallback(error: string): Skin {
  const base = BUILTIN_SKINS[0];
  if (!base) return { key: DEFAULT_SKIN_KEY, markup: '', source: 'builtin', error };
  const result = sanitizeSvg(base.markup);
  return {
    key: base.key,
    markup: result.ok ? result.markup : '',
    source: 'builtin',
    error,
  };
}

/**
 * Opens the system file picker and validates the chosen file. Throws with a readable
 * message when the file is not a usable skin, so the caller can surface it.
 */
export async function chooseSkinFile(): Promise<{ path: string } | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: 'Choose an SVG clock skin',
    filters: [{ name: 'SVG skin', extensions: ['svg'] }],
  });

  if (typeof selected !== 'string') return null;

  const raw = await invoke<string>('read_skin_file', { path: selected });
  const result = sanitizeSvg(raw);
  if (!result.ok) throw new Error(result.reason);

  return { path: selected };
}

export function describeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
