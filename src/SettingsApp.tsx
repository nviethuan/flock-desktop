import { use, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from './hooks/useSettings';
import TodosSection from './components/TodosSection';
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
import type { ClockSettings, CountdownAnimation, Settings, TimeZone } from './lib/settings';
import { BUILTIN_SKINS, chooseSkinFile, describeError, loadSkin } from './lib/skins';
import { alertSounds, playAlertSound } from './lib/sounds';

/** Sent by Rust when the panel is already open and another clock asks for it. */
export const FOCUS_EVENT = 'settings://focus-clock';

/** One entry of the panel's sidebar navigation. Each section is a different job. */
type SectionId = 'appearance' | 'countdown' | 'timezone' | 'todos';

interface SectionDef {
  id: SectionId;
  label: string;
  title: string;
  hint: string;
  /** Sections that edit the selected clock show which one in the header. */
  perClock: boolean;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    title: 'Appearance',
    hint: 'How this clock looks. Every change applies immediately.',
    perClock: true,
  },
  {
    id: 'countdown',
    label: 'Countdown',
    title: 'Countdown',
    hint: 'Run a timer in this clock’s window, with an optional alert.',
    perClock: true,
  },
  {
    id: 'timezone',
    label: 'Time zone',
    title: 'Time zone',
    hint: 'Which city’s time this clock reads.',
    perClock: true,
  },
  {
    id: 'todos',
    label: 'Todos',
    title: 'Todos',
    hint: 'Your personal list and the countdown widget on the desktop.',
    perClock: false,
  },
];

export default function SettingsApp() {
  use(settingsReady());
  const settings = useSettings();
  const [selectedId, setSelectedId] = useState<string | null>(focusedClockFromUrl);
  const [section, setSection] = useState<SectionId>('appearance');

  // A double click on a clock asks this panel to switch to that clock and to its look.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>(FOCUS_EVENT, (event) => {
      setSelectedId(event.payload);
      setSection('appearance');
    }).then((unlistenFn) => {
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

  return (
    <SettingsForm
      settings={settings}
      clock={clock}
      section={section}
      onSelect={setSelectedId}
      onSectionChange={setSection}
    />
  );
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

/** Format a timestamp in the user's local timezone for a `datetime-local` field. */
function localDateTimeInput(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `HH:MM:SS` for a whole number of seconds, used by the countdown controls. */
function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(safe / 3600))}:${pad(Math.floor((safe % 3600) / 60))}:${pad(safe % 60)}`;
}

/** One-line description shown in the clock list. */
function clockSummary(clock: ClockSettings, zones: readonly TimeZone[]): string {
  if (clock.displayMode === 'countdown') {
    const display = clock.countdownDisplay === 'seconds' ? 'seconds' : 'HH:MM:SS';
    return `Countdown · ${display} · ${clock.countdownDurationSeconds}s`;
  }
  const zone = zones.find(([name]) => name === clock.timeZone)?.[1] ?? clock.timeZone;
  const look =
    clock.displayMode === 'analog'
      ? (BUILTIN_SKINS.find((skin) => skin.key === clock.skinPath)?.label ?? fileName(clock.skinPath))
      : clock.digitalFormat.trim() || DEFAULT_FORMAT;
  return `Analog · ${look} · ${zone}`;
}

/** Sidebar glyphs: one per section, drawn from the section id so they stay in step. */
function SectionIcon({ id }: { id: SectionId }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {id === 'appearance' ? (
        <>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M8 4.9V8l2.2 1.4" />
        </>
      ) : id === 'countdown' ? (
        <>
          <path d="M4.6 2.4h6.8M4.6 13.6h6.8" />
          <path d="M5.6 2.4v1.9L8 7.5l2.4-3.2V2.4M5.6 13.6v-1.9L8 8.5l2.4 3.2v1.9" />
        </>
      ) : id === 'timezone' ? (
        <>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M2.4 8h11.2" />
          <path d="M8 2.4c1.7 1.6 2.6 3.5 2.6 5.6S9.7 12.3 8 13.6C6.3 12 5.4 10.1 5.4 8S6.3 3.9 8 2.4Z" />
        </>
      ) : (
        <>
          <path d="M2.8 4.6l1.1 1.1 2-2.1M2.8 10.4l1.1 1.1 2-2.1" />
          <path d="M8.6 4.9h4.6M8.6 10.7h4.6" />
        </>
      )}
    </svg>
  );
}

interface SettingsFormProps {
  settings: Settings;
  clock: ClockSettings;
  section: SectionId;
  onSelect: (clockId: string) => void;
  onSectionChange: (section: SectionId) => void;
}

function SettingsForm({ settings, clock, section, onSelect, onSectionChange }: SettingsFormProps) {
  const zones = use(timeZones());
  const sounds = use(alertSounds());
  const [format, setFormat] = useState(clock.digitalFormat);
  const [size, setSize] = useState(clock.digitalSize);
  const [side, setSide] = useState(analogSide(clock));
  const [countdownDuration, setCountdownDuration] = useState(clock.countdownDurationSeconds);
  const [countdownTarget, setCountdownTarget] = useState('');
  // Which input Start reads: exactly one of them is visible at a time, so there is never a
  // question about which time the button will use.
  const [countdownMode, setCountdownMode] = useState<'duration' | 'target'>('duration');
  const [now, setNow] = useState(Date.now());
  const [skinError, setSkinError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const index = settings.clocks.findIndex((entry) => entry.id === clock.id);
  const activeSection = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

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

  useEffect(() => {
    setCountdownDuration(clock.countdownDurationSeconds);
  }, [clock.id, clock.countdownDurationSeconds]);

  useEffect(() => {
    setCountdownTarget('');
    setCountdownMode('duration');
  }, [clock.id]);

  useEffect(() => {
    if (clock.countdownEndsAt <= 0 && !countdownTarget) return;
    const target = countdownTarget ? new Date(countdownTarget).getTime() : 0;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (
        (clock.countdownEndsAt > 0 && current >= clock.countdownEndsAt) ||
        (target > 0 && current >= target)
      ) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [clock.countdownEndsAt, countdownTarget]);

  useEffect(() => {
    if (countdownDuration === clock.countdownDurationSeconds) return;
    const timer = window.setTimeout(() => {              void updateClockSettings(clock.id, {
                countdownDurationSeconds: countdownDuration,
                ...(clock.countdownEndsAt <= Date.now()
                  ? { countdownRemainingSeconds: countdownDuration }
                  : {}),
              });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [countdownDuration, clock.id, clock.countdownDurationSeconds]);

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

  const isAnalog = clock.displayMode === 'analog';
  const isDigital = clock.displayMode === 'digital';
  const isCountdown = clock.displayMode === 'countdown';
  const isReadout = !isAnalog;
  const countdownRunning = clock.countdownEndsAt > now;
  const countdownLeft = countdownRunning
    ? Math.max(0, Math.ceil((clock.countdownEndsAt - now) / 1000))
    : clock.countdownEndsAt > 0
      ? 0
      : clock.countdownRemainingSeconds;
  const targetTimestamp = countdownTarget ? new Date(countdownTarget).getTime() : Number.NaN;
  const targetSeconds = Number.isFinite(targetTimestamp)
    ? Math.max(0, Math.ceil((targetTimestamp - now) / 1000))
    : null;
  // What Start would run, given the selected mode, and therefore what the preview shows.
  const countdownStartSeconds = countdownMode === 'target' ? targetSeconds : countdownDuration;
  const countdownStartReady = countdownStartSeconds !== null && countdownStartSeconds > 0;
  const pausedSeconds =
    !countdownRunning &&
    clock.countdownEndsAt === 0 &&
    clock.countdownRemainingSeconds > 0 &&
    clock.countdownRemainingSeconds < clock.countdownDurationSeconds
      ? clock.countdownRemainingSeconds
      : 0;
  const countdownPreview = countdownRunning ? countdownLeft : (countdownStartSeconds ?? countdownLeft);
  const customSkin = clock.skinPath.startsWith('builtin:') ? null : fileName(clock.skinPath);
  const empty = format.trim().length === 0;
  const tooLong = format.length > 64;
  const preview = previewFormat(clock.timeZone, format);

  return (
    <div className="settings">
      <aside className="settings__sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__brandName">Flock</span>
          <span className="sidebar__brandHint">Settings</span>
        </div>

        <div className="sidebar__scroll">
          <div className="sidebar__group">
            <p className="sidebar__label">Clocks</p>
            <div className="clocks" role="list">
              {settings.clocks.map((entry, position) => (
                <div className="clockItem" role="listitem" key={entry.id}>
                  <button
                    type="button"
                    className="clockItem__pick"
                    aria-pressed={entry.id === clock.id}
                    onClick={() => onSelect(entry.id)}
                  >
                    <span className="clockItem__name">Clock {position + 1}</span>
                    <span className="clockItem__detail">{clockSummary(entry, zones)}</span>
                  </button>
                  <button
                    type="button"
                    className="clockItem__remove"
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
              className="sidebar__add"
              disabled={settings.clocks.length >= MAX_CLOCKS}
              onClick={() => void addAnother()}
            >
              + Add clock
            </button>
            {notice ? (
              <p className="settings__warning" role="status">
                {notice}
              </p>
            ) : null}
          </div>

          <nav className="sidebar__nav" aria-label="Settings sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="sidebar__navItem"
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => onSectionChange(entry.id)}
              >
                <SectionIcon id={entry.id} />
                <span>{entry.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="sidebar__footer">
          {/* The panel is the only place to quit once the Dock icon (and so `Cmd+Q`) is gone. */}
          <button type="button" className="sidebar__quit" onClick={() => void invoke('quit_app')}>
            Quit Flock
          </button>
          <button type="button" className="sidebar__close" onClick={() => void invoke('close_settings')}>
            Close
          </button>
        </div>
      </aside>

      <main className="settings__content">
        <header className="settings__header">
          <div>
            <h1>{activeSection.title}</h1>
            <p>{activeSection.hint}</p>
          </div>
          {activeSection.perClock ? (
            <span className="settings__chip" title={clockSummary(clock, zones)}>
              Clock {index + 1}
            </span>
          ) : null}
        </header>

        <div className="settings__body">
          {section === 'appearance' ? (
            <>
              <section className="settings__section">
                <h2>Display mode</h2>
                <div className="segmented segmented--three" role="group" aria-label="Display mode">
                  <button
                    type="button"
                    aria-pressed={isAnalog}
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
                  <button
                    type="button"
                    aria-pressed={isCountdown}
                    onClick={() => void updateClockSettings(clock.id, { displayMode: 'countdown' })}
                  >
                    Countdown
                  </button>
                </div>
                <p className="settings__hint">
                  {isAnalog
                    ? 'A skin draws the time with hands or progress rings.'
                    : isDigital
                      ? 'The readout shows this clock’s time zone in a format you write.'
                      : 'This window counts down; the timer itself is under Countdown.'}
                </p>
              </section>

              {isAnalog ? (
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
                      #second-hand) or with progress rings (#second-ring, #minute-ring,
                      #hour-ring). They are sanitized before they are shown: no scripts, no remote
                      images. The tray menu applies a skin to every clock at once.
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
                      The face is square, so this is the window side and the skin scales to fill
                      it. Only this clock changes.
                    </p>
                  </section>
                </>
              ) : null}

              {isDigital ? (
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
              ) : null}

              {isReadout ? (
                <>
                  <section className="settings__section">
                    <h2>{isCountdown ? 'Countdown font' : 'Font'}</h2>
                    <div
                      className="fonts"
                      role="group"
                      aria-label={isCountdown ? 'Countdown font family' : 'Clock font'}
                    >
                      {FONTS.map((font) => (
                        <button
                          key={font.id}
                          type="button"
                          className="fonts__option"
                          aria-pressed={clock.font === font.id}
                          onClick={() => void updateClockSettings(clock.id, { font: font.id })}
                        >
                          <span className="fonts__sample" style={{ fontFamily: font.stack }}>
                            {isCountdown ? '00:12:34' : '12:34'}
                          </span>
                          <span className="fonts__label">{font.label}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settings__section">
                    <h2>{isCountdown ? 'Countdown size' : 'Size'}</h2>
                    <div className="settings__range">
                      <input
                        type="range"
                        min={DIGITAL_SIZE_MIN}
                        max={DIGITAL_SIZE_MAX}
                        step={1}
                        value={size}
                        aria-label={
                          isCountdown ? 'Countdown font size in pixels' : 'Digital font size in pixels'
                        }
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
                        {isCountdown ? 'Fit countdown to window' : 'Fit to window'}
                      </label>
                    </div>
                    <p className="settings__hint">
                      {isCountdown
                        ? 'Countdown uses this clock’s selected font family and size, like Digital. '
                        : ''}
                      44 px is the default and 100 px is the maximum. This clock's window hugs its
                      readout at that exact size. Fit to window only kicks in when you drag the
                      clock smaller than the text: it wraps and shrinks the readout instead of
                      clipping it.
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
                            void updateClockSettings(clock.id, {
                              digitalBackdrop: event.target.checked,
                            })
                          }
                        />
                        Dark backdrop
                      </label>
                    </div>
                    <p className="settings__hint">
                      {digitalColorLabel(clock.digitalColor)}. Turn the backdrop off to float the
                      time on your desktop; the neon glow makes it readable over most wallpapers.
                    </p>
                  </section>
                </>
              ) : null}
            </>
          ) : null}

          {section === 'countdown' ? (
            isCountdown ? (
              <>
                <section className="settings__section">
                  <h2>Timer</h2>
                  <div className="segmented" role="group" aria-label="How the countdown length is set">
                    <button
                      type="button"
                      aria-pressed={countdownMode === 'duration'}
                      onClick={() => setCountdownMode('duration')}
                    >
                      Run for a duration
                    </button>
                    <button
                      type="button"
                      aria-pressed={countdownMode === 'target'}
                      onClick={() => setCountdownMode('target')}
                    >
                      Run until a time
                    </button>
                  </div>
                  <div className="countdown__controls">
                    {countdownMode === 'duration' ? (
                      <label className="countdown__duration">
                        Duration
                        <span className="countdown__durationFields">
                          <input
                            className="settings__input"
                            type="number"
                            min={0}
                            max={99}
                            value={Math.floor(countdownDuration / 3600)}
                            aria-label="Countdown hours"
                            onChange={(event) => {
                              const hours = Math.min(99, Math.max(0, Number(event.target.value) || 0));
                              setCountdownDuration(hours * 3600 + (countdownDuration % 3600));
                            }}
                          />
                          <span>h</span>
                          <input
                            className="settings__input"
                            type="number"
                            min={0}
                            max={59}
                            value={Math.floor((countdownDuration % 3600) / 60)}
                            aria-label="Countdown minutes"
                            onChange={(event) => {
                              const minutes = Math.min(59, Math.max(0, Number(event.target.value) || 0));
                              setCountdownDuration(Math.floor(countdownDuration / 3600) * 3600 + minutes * 60 + (countdownDuration % 60));
                            }}
                          />
                          <span>m</span>
                          <input
                            className="settings__input"
                            type="number"
                            min={0}
                            max={59}
                            value={countdownDuration % 60}
                            aria-label="Countdown seconds"
                            onChange={(event) => {
                              const seconds = Math.min(59, Math.max(0, Number(event.target.value) || 0));
                              setCountdownDuration(Math.floor(countdownDuration / 60) * 60 + seconds);
                            }}
                          />
                          <span>s</span>
                        </span>
                      </label>
                    ) : (
                      <label className="countdown__duration">
                        End at (local time)
                        <input
                          className="settings__input countdown__target"
                          type="datetime-local"
                          min={localDateTimeInput(Math.ceil(now / 60_000) * 60_000)}
                          value={countdownTarget}
                          aria-label="Countdown end date and time"
                          onChange={(event) => setCountdownTarget(event.target.value)}
                        />
                      </label>
                    )}
                  </div>
                  <p className="settings__hint">
                    {countdownRunning
                      ? `Running: ${formatCountdown(countdownLeft)} left. Pause keeps that time; Reset goes back to the duration.`
                      : countdownMode === 'target'
                        ? targetSeconds === null
                          ? 'Pick a date and time in the future. Start then counts down to exactly that moment.'
                          : targetSeconds > 0
                            ? `Start counts down to ${new Date(targetTimestamp).toLocaleString()} (${formatCountdown(targetSeconds)} from now).`
                            : 'That time has passed. Pick a future date and time to enable Start.'
                        : countdownDuration > 0
                          ? `Start counts down for ${formatCountdown(countdownDuration)} from the moment you press it.`
                          : 'Set a duration above zero to enable Start.'}
                  </p>
                  <div className="countdown__actions">
                    <button
                      type="button"
                      disabled={countdownRunning || !countdownStartReady}
                      onClick={() => {
                        const endsAt =
                          countdownMode === 'target'
                            ? targetTimestamp
                            : Date.now() + countdownDuration * 1000;
                        const remaining = Math.ceil((endsAt - Date.now()) / 1000);
                        if (!Number.isFinite(endsAt) || remaining <= 0) return;
                        setCountdownDuration(remaining);
                        void updateClockSettings(clock.id, {
                          countdownDurationSeconds: remaining,
                          countdownRemainingSeconds: remaining,
                          countdownEndsAt: endsAt,
                        });
                        setCountdownTarget('');
                        setCountdownMode('duration');
                      }}
                    >
                      {countdownStartReady ? `Start ${formatCountdown(countdownStartSeconds)}` : 'Start'}
                    </button>
                    {pausedSeconds > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          void updateClockSettings(clock.id, {
                            countdownRemainingSeconds: pausedSeconds,
                            countdownEndsAt: Date.now() + pausedSeconds * 1000,
                          })
                        }
                      >
                        Resume {formatCountdown(pausedSeconds)}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={!countdownRunning}
                      onClick={() =>
                        void updateClockSettings(clock.id, {
                          countdownRemainingSeconds: countdownLeft,
                          countdownEndsAt: 0,
                        })
                      }
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void updateClockSettings(clock.id, {
                          countdownRemainingSeconds: countdownDuration,
                          countdownEndsAt: 0,
                        })
                      }
                    >
                      Reset
                    </button>
                  </div>
                </section>

                <section className="settings__section">
                  <h2>Readout</h2>
                  <div className="segmented" role="group" aria-label="Countdown display format">
                    <button
                      type="button"
                      aria-pressed={clock.countdownDisplay === 'hhmmss'}
                      onClick={() => void updateClockSettings(clock.id, { countdownDisplay: 'hhmmss' })}
                    >
                      HH:MM:SS
                    </button>
                    <button
                      type="button"
                      aria-pressed={clock.countdownDisplay === 'seconds'}
                      onClick={() => void updateClockSettings(clock.id, { countdownDisplay: 'seconds' })}
                    >
                      Seconds
                    </button>
                  </div>
                  <p
                    className="settings__preview"
                    style={{
                      fontFamily: fontStack(clock.font),
                      fontSize: `${Math.round(size * PREVIEW_SCALE)}px`,
                      background: clock.digitalBackdrop ? undefined : 'transparent',
                      ...digitalTextStyle(clock.digitalColor, clock.digitalNeon),
                    }}
                  >
                    {clock.countdownDisplay === 'seconds'
                      ? countdownPreview
                      : formatCountdown(countdownPreview)}
                  </p>
                  <label className="countdown__animationSetting">
                    Number animation
                    <select
                      className="settings__input settings__select"
                      value={clock.countdownAnimation}
                      aria-label="Countdown number animation"
                      onChange={(event) =>
                        void updateClockSettings(clock.id, {
                          countdownAnimation: event.target.value as CountdownAnimation,
                        })
                      }
                    >
                      <option value="">None</option>
                      <option value="animate__jello">animate__jello</option>
                      <option value="animate__rubberBand">animate__rubberBand</option>
                    </select>
                  </label>
                  {clock.countdownAnimation ? (
                    <label className="countdown__animationSetting">
                      Animate in the last N seconds
                      <input
                        className="settings__input"
                        type="number"
                        min={1}
                        max={60}
                        value={clock.countdownAnimationLastSeconds}
                        aria-label="Seconds remaining to start animation"
                        onChange={(event) => {
                          const value = Math.max(1, Math.min(60, Number(event.target.value) || 1));
                          void updateClockSettings(clock.id, { countdownAnimationLastSeconds: value });
                        }}
                      />
                    </label>
                  ) : null}
                </section>

                <section className="settings__section">
                  <h2>Alert</h2>
                  <label className="settings__toggle">
                    <input
                      type="checkbox"
                      checked={clock.countdownAlert}
                      onChange={(event) =>
                        void updateClockSettings(clock.id, { countdownAlert: event.target.checked })
                      }
                    />
                    Sound alert when it finishes
                  </label>
                  {clock.countdownAlert ? (
                    <>
                      <div className="countdown__sound">
                        <select
                          className="settings__input settings__select"
                          value={clock.countdownAlertSound}
                          aria-label="Countdown alert sound"
                          onChange={(event) =>
                            void updateClockSettings(clock.id, {
                              countdownAlertSound: event.target.value,
                            })
                          }
                        >
                          <option value="">System default</option>
                          {sounds.map((sound) => (
                            <option key={sound.id} value={sound.id}>
                              {sound.label}
                            </option>
                          ))}
                          {/* A saved sound can disappear when the OS library changes. */}
                          {clock.countdownAlertSound &&
                          !sounds.some((sound) => sound.id === clock.countdownAlertSound) ? (
                            <option value={clock.countdownAlertSound}>{clock.countdownAlertSound}</option>
                          ) : null}
                        </select>
                        <button
                          type="button"
                          className="countdown__preview"
                          onClick={() => playAlertSound(clock.countdownAlertSound)}
                        >
                          Preview
                        </button>
                      </div>
                      <label className="countdown__animationSetting">
                        Repeat the sound every second in the last N seconds (0 = off, max 15)
                        <input
                          className="settings__input countdown__tickSeconds"
                          type="number"
                          min={0}
                          max={15}
                          value={clock.countdownAlertTickSeconds}
                          aria-label="Seconds before the end to repeat the sound"
                          onChange={(event) => {
                            const value = Math.max(0, Math.min(15, Number(event.target.value) || 0));
                            void updateClockSettings(clock.id, { countdownAlertTickSeconds: value });
                          }}
                        />
                      </label>
                    </>
                  ) : null}
                </section>
              </>
            ) : (
              <section className="settings__section">
                <h2>Countdown is off for this clock</h2>
                <p className="settings__hint">
                  This window shows {isAnalog ? 'an analog face' : 'the time of day'} right now.
                  Switch its display mode to Countdown and the timer controls appear here; the
                  clock keeps its position, font and colours.
                </p>
                <div className="settings__actions">
                  <button
                    type="button"
                    className="settings__primary"
                    onClick={() => void updateClockSettings(clock.id, { displayMode: 'countdown' })}
                  >
                    Switch to Countdown
                  </button>
                </div>
              </section>
            )
          ) : null}

          {section === 'timezone' ? (
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
                Each clock reads its own zone, so two windows can show two cities. The list is
                shared with the tray submenu.
              </p>
              {isCountdown ? (
                <p className="settings__hint">
                  This clock is in Countdown mode, which counts down instead of reading a zone; the
                  choice applies again the next time it shows Analog or Digital.
                </p>
              ) : null}
            </section>
          ) : null}

          {section === 'todos' ? <TodosSection heading={false} /> : null}
        </div>
      </main>
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
