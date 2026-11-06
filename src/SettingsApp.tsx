import { use, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from './hooks/useSettings';
import { DIGITAL_COLORS, digitalColorLabel, digitalTextStyle } from './lib/colors';
import { FONTS, fontStack } from './lib/fonts';
import { DEFAULT_FORMAT, FORMAT_PRESETS, FORMAT_TOKENS, previewFormat } from './lib/format';
import {
  ANALOG_SIZE_MAX,
  ANALOG_SIZE_MIN,
  DIGITAL_SIZE_MAX,
  DIGITAL_SIZE_MIN,
  MAX_CLOCKS,
  addClock,
  clockById,
  removeClock,
  settingsReady,
  timeZones,
  updateClockSettings,
} from './lib/settings';
import type { ClockSettings, Settings, TimeZone } from './lib/settings';
import { BUILTIN_SKINS, chooseSkinFile, describeError, loadSkin } from './lib/skins';

/** Sent by Rust when the panel is already open and another clock asks for it. */
export const FOCUS_EVENT = 'settings://focus-clock';

export default function SettingsApp() {
  use(settingsReady());
  const settings = useSettings();
  const [selectedId, setSelectedId] = useState<string | null>(focusedClockFromUrl);

  // A double click on a clock asks this panel to switch to that clock.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>(FOCUS_EVENT, (event) => setSelectedId(event.payload)).then((unlistenFn) => {
      if (disposed) unlistenFn();
      else unlisten = unlistenFn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!settings) return null;
  // A selected clock can disappear: fall back to the first one, never to an empty panel.
  const clock = clockById(settings, selectedId) ?? settings.clocks[0] ?? null;
  if (!clock) return null;

  return <SettingsForm settings={settings} clock={clock} onSelect={setSelectedId} />;
}

/** The clock to edit when the panel is opened for a specific window (see `win.rs`). */
function focusedClockFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('focus');
  } catch {
    return null;
  }
}

/** The preview panel is smaller than the clock: show the size in proportion, not to scale. */
const PREVIEW_SCALE = 26 / 44;

/** The analog face is square, so its side is the window side the face scales into. */
function analogSide(clock: ClockSettings): number {
  const side = clock.width ?? clock.height ?? 220;
  return Math.min(ANALOG_SIZE_MAX, Math.max(ANALOG_SIZE_MIN, side));
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** One-line description shown in the clock list. */
function clockSummary(clock: ClockSettings, zones: readonly TimeZone[]): string {
  const zone = zones.find(([name]) => name === clock.timeZone)?.[1] ?? clock.timeZone;
  const look =
    clock.displayMode === 'analog'
      ? (BUILTIN_SKINS.find((skin) => skin.key === clock.skinPath)?.label ?? fileName(clock.skinPath))
      : clock.digitalFormat.trim() || DEFAULT_FORMAT;
  return `${clock.displayMode === 'analog' ? 'Analog' : 'Digital'} · ${look} · ${zone}`;
}

interface SettingsFormProps {
  settings: Settings;
  clock: ClockSettings;
  onSelect: (clockId: string) => void;
}

function SettingsForm({ settings, clock, onSelect }: SettingsFormProps) {
  const zones = use(timeZones());
  const [format, setFormat] = useState(clock.digitalFormat);
  const [size, setSize] = useState(clock.digitalSize);
  const [side, setSide] = useState(analogSide(clock));
  const [skinError, setSkinError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const index = settings.clocks.findIndex((entry) => entry.id === clock.id);

  // Keep the controls in step when the value changes elsewhere (tray, another clock, drag).
  useEffect(() => {
    setFormat(clock.digitalFormat);
  }, [clock.id, clock.digitalFormat]);

  useEffect(() => {
    setSize(clock.digitalSize);
  }, [clock.id, clock.digitalSize]);

  useEffect(() => {
    setSide(analogSide(clock));
  }, [clock.id, clock.width, clock.height]);

  // Typing is local, writes are debounced so a half-typed token never fights the store.
  useEffect(() => {
    if (format === clock.digitalFormat) return;
    const timer = window.setTimeout(() => {
      void updateClockSettings(clock.id, { digitalFormat: format });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [format, clock.id, clock.digitalFormat]);

  // Dragging the slider fires a lot of input events: same debounce, so the tray does not
  // rebuild its menu on every pixel.
  useEffect(() => {
    if (size === clock.digitalSize) return;
    const timer = window.setTimeout(() => {
      void updateClockSettings(clock.id, { digitalSize: size });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [size, clock.id, clock.digitalSize]);

  // The analog side is written as a square: the window keeps its aspect in this mode.
  // Depend on the values rather than the clock object, or every broadcast restarts the
  // debounce and a slider drag never lands.
  useEffect(() => {
    if (side === analogSide(clock)) return;
    const timer = window.setTimeout(() => {
      void updateClockSettings(clock.id, { width: side, height: side });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [side, clock.id, clock.width, clock.height]);

  // The tray cannot open a dialog, so the settings window owns the custom-skin picker.
  const pickSkin = async (): Promise<void> => {
    try {
      setSkinError(null);
      const picked = await chooseSkinFile();
      if (picked) await updateClockSettings(clock.id, { skinPath: picked.path });
    } catch (error) {
      setSkinError(describeError(error));
    }
  };

  const addAnother = async (): Promise<void> => {
    try {
      setNotice(null);
      const next = await addClock();
      const created = next.clocks[next.clocks.length - 1];
      if (created) onSelect(created.id);
    } catch (error) {
      setNotice(describeError(error));
    }
  };

  const removeThis = async (clockId: string): Promise<void> => {
    try {
      setNotice(null);
      const next = await removeClock(clockId);
      if (!next.clocks.some((entry) => entry.id === clock.id)) onSelect(next.clocks[0]?.id ?? '');
    } catch (error) {
      setNotice(describeError(error));
    }
  };

  const isDigital = clock.displayMode === 'digital';
  const customSkin = clock.skinPath.startsWith('builtin:') ? null : fileName(clock.skinPath);
  const empty = format.trim().length === 0;
  const tooLong = format.length > 64;
  const preview = previewFormat(clock.timeZone, format);

  return (
    <div className="settings">
      <header className="settings__header">
        <h1>Flock</h1>
        <p>
          {settings.clocks.length > 1
            ? `Editing clock ${index + 1} of ${settings.clocks.length}. Changes apply immediately.`
            : 'Pick how the clock looks. Changes apply immediately.'}
        </p>
      </header>

      <section className="settings__section">
        <h2>Clocks</h2>
        <div className="clocks" role="list">
          {settings.clocks.map((entry, position) => (
            <div className="clocks__row" role="listitem" key={entry.id}>
              <button
                type="button"
                className="clocks__pick"
                aria-pressed={entry.id === clock.id}
                onClick={() => onSelect(entry.id)}
              >
                <span className="clocks__name">Clock {position + 1}</span>
                <span className="clocks__detail">{clockSummary(entry, zones)}</span>
              </button>
              <button
                type="button"
                className="clocks__remove"
                aria-label={`Remove clock ${position + 1}`}
                title={
                  settings.clocks.length > 1
                    ? `Remove clock ${position + 1}`
                    : 'Flock keeps at least one clock'
                }
                disabled={settings.clocks.length <= 1}
                onClick={() => void removeThis(entry.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="clocks__add"
          disabled={settings.clocks.length >= MAX_CLOCKS}
          onClick={() => void addAnother()}
        >
          + Add clock
        </button>
        <p className="settings__hint">
          Every clock is its own always-on-top window with its own style, time zone and size, so
          you can mix an analog face with a digital readout on the same desktop. Double-click a
          clock to edit it here; drag it to move it.
        </p>
        {notice ? (
          <p className="settings__warning" role="status">
            {notice}
          </p>
        ) : null}
      </section>

      <section className="settings__section">
        <h2>Display</h2>
        <div className="segmented" role="group" aria-label="Display mode">
          <button
            type="button"
            aria-pressed={!isDigital}
            onClick={() => void updateClockSettings(clock.id, { displayMode: 'analog' })}
          >
            Analog
          </button>
          <button
            type="button"
            aria-pressed={isDigital}
            onClick={() => void updateClockSettings(clock.id, { displayMode: 'digital' })}
          >
            Digital
          </button>
        </div>
      </section>

      {!isDigital ? (
        <>
          <section className="settings__section">
            <h2>Skin</h2>
            <div className="skins" role="group" aria-label="Clock skin">
              {BUILTIN_SKINS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="skins__option"
                  aria-pressed={clock.skinPath === entry.key}
                  onClick={() => void updateClockSettings(clock.id, { skinPath: entry.key })}
                >
                  <SkinThumb markupKey={entry.key} />
                  <span className="skins__label">{entry.label}</span>
                </button>
              ))}
            </div>
            <div className="skins__custom">
              <button type="button" className="skins__pick" onClick={() => void pickSkin()}>
                Load custom SVG…
              </button>
              <span className="skins__customName">{customSkin ?? 'No file loaded'}</span>
            </div>
            {skinError ? (
              <p className="settings__warning" role="status">
                {skinError}
              </p>
            ) : null}
            <p className="settings__hint">
              Skins are SVG files that draw the time with hands (#hour-hand, #minute-hand,
              #second-hand) or with progress rings (#second-ring, #minute-ring, #hour-ring). They
              are sanitized before they are shown: no scripts, no remote images. The tray menu
              applies a skin to every clock at once.
            </p>
          </section>
          <section className="settings__section">
            <h2>Size</h2>
            <div className="settings__range">
              <input
                type="range"
                min={ANALOG_SIZE_MIN}
                max={ANALOG_SIZE_MAX}
                step={4}
                value={side}
                aria-label="Analog clock size in pixels"
                onChange={(event) => setSide(Number(event.target.value))}
              />
              <output className="settings__rangeValue">{side}px</output>
            </div>
            <p className="settings__hint">
              The face is square, so this is the window side and the skin scales to fill it. Only
              this clock changes.
            </p>
          </section>
        </>
      ) : null}

      {isDigital ? (
        <>
          <section className="settings__section">
            <h2>Format</h2>
            <input
              className="settings__input"
              value={format}
              spellCheck={false}
              autoComplete="off"
              placeholder={DEFAULT_FORMAT}
              aria-invalid={tooLong}
              aria-label="Digital time format"
              onChange={(event) => setFormat(event.target.value)}
            />
            {empty || tooLong ? (
              <p className="settings__warning">
                {empty
                  ? `Empty formats fall back to ${DEFAULT_FORMAT}.`
                  : 'Formats are limited to 64 characters.'}
              </p>
            ) : null}

            <p
              className="settings__preview"
              style={{
                fontFamily: fontStack(clock.font),
                fontSize: `${Math.round(size * PREVIEW_SCALE)}px`,
                background: clock.digitalBackdrop ? undefined : 'transparent',
                ...digitalTextStyle(clock.digitalColor, clock.digitalNeon),
              }}
            >
              {preview}
            </p>

            <div className="presets">
              {FORMAT_PRESETS.map((preset) => (
                <button key={preset} type="button" onClick={() => setFormat(preset)}>
                  {preset}
                </button>
              ))}
            </div>

            <details className="settings__tokens">
              <summary>Format tokens</summary>
              <dl>
                {FORMAT_TOKENS.map(([token, description]) => (
                  <div key={token}>
                    <dt>{token}</dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
              <p className="settings__hint">
                {
                  "Wrap literal text in single quotes, e.g. HH:mm 'UTC'. Type \\n to start a new line, e.g. HH:mm\\nEEE."
                }
              </p>
            </details>
          </section>

          <section className="settings__section">
            <h2>Font</h2>
            <div className="fonts" role="group" aria-label="Clock font">
              {FONTS.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  className="fonts__option"
                  aria-pressed={clock.font === font.id}
                  onClick={() => void updateClockSettings(clock.id, { font: font.id })}
                >
                  <span className="fonts__sample" style={{ fontFamily: font.stack }}>
                    12:34
                  </span>
                  <span className="fonts__label">{font.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings__section">
            <h2>Size</h2>
            <div className="settings__range">
              <input
                type="range"
                min={DIGITAL_SIZE_MIN}
                max={DIGITAL_SIZE_MAX}
                step={1}
                value={size}
                aria-label="Digital font size in pixels"
                onChange={(event) => setSize(Number(event.target.value))}
              />
              <output className="settings__rangeValue">{size}px</output>
            </div>
            <div className="settings__toggles">
              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={clock.digitalFit}
                  onChange={(event) =>
                    void updateClockSettings(clock.id, { digitalFit: event.target.checked })
                  }
                />
                Fit to window
              </label>
            </div>
            <p className="settings__hint">
              44 px is the default and 100 px is the maximum. This clock's window hugs its readout
              at that exact size. Fit to window only kicks in when you drag the clock smaller than
              the text: it wraps and shrinks the readout instead of clipping it.
            </p>
          </section>

          <section className="settings__section">
            <h2>Style</h2>
            <div className="swatches" role="group" aria-label="Digital colour">
              {DIGITAL_COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  className="swatches__option"
                  style={{ background: color.value }}
                  aria-pressed={clock.digitalColor === color.value}
                  aria-label={color.label}
                  title={color.label}
                  onClick={() => void updateClockSettings(clock.id, { digitalColor: color.value })}
                />
              ))}
            </div>
            <div className="settings__toggles">
              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={clock.digitalNeon}
                  onChange={(event) =>
                    void updateClockSettings(clock.id, { digitalNeon: event.target.checked })
                  }
                />
                Neon glow
              </label>
              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={clock.digitalBackdrop}
                  onChange={(event) =>
                    void updateClockSettings(clock.id, { digitalBackdrop: event.target.checked })
                  }
                />
                Dark backdrop
              </label>
            </div>
            <p className="settings__hint">
              {digitalColorLabel(clock.digitalColor)}. Turn the backdrop off to float the time on
              your desktop; the neon glow makes it readable over most wallpapers.
            </p>
          </section>
        </>
      ) : null}

      <section className="settings__section">
        <h2>Time zone</h2>
        <select
          className="settings__input settings__select"
          value={clock.timeZone}
          aria-label="Clock time zone"
          onChange={(event) => void updateClockSettings(clock.id, { timeZone: event.target.value })}
        >
          {zones.map(([zone, label]) => (
            <option key={zone} value={zone}>
              {label}
            </option>
          ))}
        </select>
        <p className="settings__hint">
          Each clock reads its own zone, so two windows can show two cities. The list is shared
          with the tray submenu.
        </p>
      </section>

      <footer className="settings__footer">
        {/* The panel is the only place to quit once the Dock icon (and so `Cmd+Q`) is gone. */}
        <button
          type="button"
          className="settings__quit"
          onClick={() => void invoke('quit_app')}
        >
          Quit Flock
        </button>
        <button
          type="button"
          className="settings__close"
          onClick={() => void invoke('close_settings')}
        >
          Close
        </button>
      </footer>
    </div>
  );
}

/** Hands at ten past ten, so a tile reads as a clock instead of hands stacked at twelve. */
const THUMB_POSE: readonly (readonly [string, number])[] = [
  ['hour-hand', 305],
  ['minute-hand', 60],
  ['second-hand', 240],
];

function SkinThumb({ markupKey }: { markupKey: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [markup, setMarkup] = useState('');

  // `loadSkin` sanitizes the file; its markup is the only thing that may be injected here.
  useEffect(() => {
    let alive = true;
    void loadSkin(markupKey).then((skin) => {
      if (alive) setMarkup(skin.markup);
    });
    return () => {
      alive = false;
    };
  }, [markupKey]);

  // The clock window rotates the hands from the painter; a thumbnail has to pose them once.
  useEffect(() => {
    const svg = host.current?.querySelector('svg');
    const box = svg?.viewBox.baseVal;
    if (!svg || !box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const [id, angle] of THUMB_POSE) {
      svg.querySelector<SVGElement>(`#${id}`)?.setAttribute('transform', `rotate(${angle} ${cx} ${cy})`);
    }
  }, [markup]);

  return <div className="skins__thumb" ref={host} dangerouslySetInnerHTML={{ __html: markup }} />;
}
