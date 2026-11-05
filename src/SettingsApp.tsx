import { use, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from './hooks/useSettings';
import { DIGITAL_COLORS, digitalColorLabel, digitalTextStyle } from './lib/colors';
import { FONTS, fontStack } from './lib/fonts';
import { DEFAULT_FORMAT, FORMAT_PRESETS, FORMAT_TOKENS, previewFormat } from './lib/format';
import {
  ANALOG_SIZE_MAX,
  ANALOG_SIZE_MIN,
  DIGITAL_SIZE_MAX,
  DIGITAL_SIZE_MIN,
  settingsReady,
  updateSettings,
} from './lib/settings';
import type { Settings } from './lib/settings';
import { BUILTIN_SKINS, chooseSkinFile, describeError, loadSkin } from './lib/skins';

export default function SettingsApp() {
  use(settingsReady());
  const settings = useSettings();

  if (!settings) return null;
  return <SettingsForm settings={settings} />;
}

/** The preview panel is smaller than the clock: show the size in proportion, not to scale. */
const PREVIEW_SCALE = 26 / 44;

/** The analog face is square, so its side is the window side the face scales into. */
function analogSide(settings: Settings): number {
  const side = settings.width ?? settings.height ?? 220;
  return Math.min(ANALOG_SIZE_MAX, Math.max(ANALOG_SIZE_MIN, side));
}

function SettingsForm({ settings }: { settings: Settings }) {
  const [format, setFormat] = useState(settings.digitalFormat);
  const [size, setSize] = useState(settings.digitalSize);
  const [side, setSide] = useState(analogSide(settings));
  const [skinError, setSkinError] = useState<string | null>(null);

  // Keep the controls in step when the value changes elsewhere (tray, another window).
  useEffect(() => {
    setFormat(settings.digitalFormat);
  }, [settings.digitalFormat]);

  useEffect(() => {
    setSize(settings.digitalSize);
  }, [settings.digitalSize]);

  useEffect(() => {
    setSide(analogSide(settings));
  }, [settings.width, settings.height]);

  // Typing is local, writes are debounced so a half-typed token never fights the store.
  useEffect(() => {
    if (format === settings.digitalFormat) return;
    const timer = window.setTimeout(() => {
      void updateSettings({ digitalFormat: format });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [format, settings.digitalFormat]);

  // Dragging the slider fires a lot of input events: same debounce, so the tray does not
  // rebuild its menu on every pixel.
  useEffect(() => {
    if (size === settings.digitalSize) return;
    const timer = window.setTimeout(() => {
      void updateSettings({ digitalSize: size });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [size, settings.digitalSize]);

  // The analog side is written as a square: the window keeps its aspect in this mode.
  useEffect(() => {
    if (side === analogSide(settings)) return;
    const timer = window.setTimeout(() => {
      void updateSettings({ width: side, height: side });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [side, settings]);

  // The tray cannot open a dialog, so the settings window owns the custom-skin picker.
  const pickSkin = async (): Promise<void> => {
    try {
      setSkinError(null);
      const picked = await chooseSkinFile();
      if (picked) await updateSettings({ skinPath: picked.path });
    } catch (error) {
      setSkinError(describeError(error));
    }
  };

  const isDigital = settings.displayMode === 'digital';
  const customSkin = settings.skinPath.startsWith('builtin:')
    ? null
    : (settings.skinPath.split(/[/\\]/).pop() ?? settings.skinPath);
  const empty = format.trim().length === 0;
  const tooLong = format.length > 64;
  const preview = previewFormat(settings.timeZone, format);

  return (
    <div className="settings">
      <header className="settings__header">
        <h1>Flock</h1>
        <p>Pick how the clock looks. Changes apply immediately.</p>
      </header>

      <section className="settings__section">
        <h2>Display</h2>
        <div className="segmented" role="group" aria-label="Display mode">
          <button
            type="button"
            aria-pressed={!isDigital}
            onClick={() => void updateSettings({ displayMode: 'analog' })}
          >
            Analog
          </button>
          <button
            type="button"
            aria-pressed={isDigital}
            onClick={() => void updateSettings({ displayMode: 'digital' })}
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
                  aria-pressed={settings.skinPath === entry.key}
                  onClick={() => void updateSettings({ skinPath: entry.key })}
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
              offers the same list.
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
              The face is square, so this is the window side and the skin scales to fill it. The skin
              itself comes from the tray menu.
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
                {empty ? `Empty formats fall back to ${DEFAULT_FORMAT}.` : 'Formats are limited to 64 characters.'}
              </p>
            ) : null}

            <p
              className="settings__preview"
              style={{
                fontFamily: fontStack(settings.font),
                fontSize: `${Math.round(size * PREVIEW_SCALE)}px`,
                background: settings.digitalBackdrop ? undefined : 'transparent',
                ...digitalTextStyle(settings.digitalColor, settings.digitalNeon),
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
                {"Wrap literal text in single quotes, e.g. HH:mm 'UTC'. Type \\n to start a new line, e.g. HH:mm\\nEEE."}
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
                  aria-pressed={settings.font === font.id}
                  onClick={() => void updateSettings({ font: font.id })}
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
                  checked={settings.digitalFit}
                  onChange={(event) => void updateSettings({ digitalFit: event.target.checked })}
                />
                Fit to window
              </label>
            </div>
            <p className="settings__hint">
              44 px is the default and 100 px is the maximum. The clock window hugs the readout at
              this exact size. Fit to window only kicks in when you drag the clock smaller than the
              text: it wraps and shrinks the readout instead of clipping it.
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
                  aria-pressed={settings.digitalColor === color.value}
                  aria-label={color.label}
                  title={color.label}
                  onClick={() => void updateSettings({ digitalColor: color.value })}
                />
              ))}
            </div>
            <div className="settings__toggles">
              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={settings.digitalNeon}
                  onChange={(event) => void updateSettings({ digitalNeon: event.target.checked })}
                />
                Neon glow
              </label>
              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={settings.digitalBackdrop}
                  onChange={(event) => void updateSettings({ digitalBackdrop: event.target.checked })}
                />
                Dark backdrop
              </label>
            </div>
            <p className="settings__hint">
              {digitalColorLabel(settings.digitalColor)}. Turn the backdrop off to float the time on your
              desktop; the neon glow makes it readable over most wallpapers.
            </p>
          </section>
        </>
      ) : null}

      <footer className="settings__footer">
        <button type="button" className="settings__close" onClick={() => void invoke('close_settings')}>
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
