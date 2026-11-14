//! Single source of truth for settings.
//!
//! The window owns the `tauri-plugin-store` file, so only one writer ever touches it.
//! The webviews mirror this state through `get_settings` and the `settings://changed`
//! event, which keeps the tray checkmarks and the React UI in sync without a second
//! copy of the truth.
//!
//! A snapshot holds a list of clocks. Each clock is its own always-on-top window with its
//! own look (mode, skin, format, font, size, time zone); the look of a window is pinned to
//! its label, so a clock's identity is also its window label.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_store::StoreExt;

use crate::{sound, tray, win};

pub const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

pub const SETTINGS_CHANGED: &str = "settings://changed";
/// Names the clock the panel should select; sent to an already open settings window.
pub const SETTINGS_FOCUS: &str = "settings://focus-clock";
pub const VISIBILITY_CHANGED: &str = "clock://visibility";

/// Toggles click-through from anywhere, so a click-through clock can never lock the user out.
pub const CLICK_THROUGH_SHORTCUT: &str = "CmdOrCtrl+Shift+O";

/// Label of the single window that hosts the settings form.
pub const SETTINGS_WINDOW: &str = "settings";

/// Clock windows are labelled `<CLOCK_PREFIX><n>`; the label doubles as the clock id.
pub const CLOCK_PREFIX: &str = "clock-";

/// Every clock is a separate always-on-top window, so the list is capped by design.
pub const MAX_CLOCKS: usize = 8;

const OPACITY_STEPS: [u8; 4] = [100, 80, 60, 40];
const DEFAULT_SKIN: &str = "builtin:default";
const DEFAULT_TIME_ZONE: &str = "system";
const DEFAULT_FORMAT: &str = "HH:mm";
const DEFAULT_FONT: &str = "jetbrains-mono";
const MAX_FORMAT_LEN: usize = 64;

/// Digital type size in CSS pixels. Format length never changes it: the window grows to
/// hug the readout, and only a manual squeeze rescales or wraps the block.
const DEFAULT_DIGITAL_SIZE: u16 = 44;
pub const MIN_DIGITAL_SIZE: u16 = 10;
pub const MAX_DIGITAL_SIZE: u16 = 100;

/// `#rrggbb` glow/text colour; any valid hex is accepted, the palette lives in `src/lib/colors.ts`.
const DEFAULT_DIGITAL_COLOR: &str = "#f3f7ff";

/// Digital-clock typefaces, vendored in `src/assets/fonts`. Ids must match `src/lib/fonts.ts`.
pub const FONTS: [(&str, &str); 6] = [
    ("jetbrains-mono", "JetBrains Mono"),
    ("share-tech-mono", "Share Tech Mono"),
    ("space-mono", "Space Mono"),
    ("oswald", "Oswald"),
    ("quicksand", "Quicksand"),
    ("monoton", "Monoton"),
];

/// Curated zones keep the submenu and the panel's select usable; `system` follows the OS.
pub const TIME_ZONES: [(&str, &str); 24] = [
    ("system", "System"),
    ("UTC", "UTC"),
    ("America/Los_Angeles", "Los Angeles"),
    ("America/Denver", "Denver"),
    ("America/Chicago", "Chicago"),
    ("America/New_York", "New York"),
    ("America/Sao_Paulo", "São Paulo"),
    ("Europe/London", "London"),
    ("Europe/Berlin", "Berlin"),
    ("Europe/Paris", "Paris"),
    ("Europe/Madrid", "Madrid"),
    ("Europe/Warsaw", "Warsaw"),
    ("Europe/Moscow", "Moscow"),
    ("Africa/Cairo", "Cairo"),
    ("Africa/Johannesburg", "Johannesburg"),
    ("Asia/Dubai", "Dubai"),
    ("Asia/Karachi", "Karachi"),
    ("Asia/Kolkata", "Kolkata"),
    ("Asia/Bangkok", "Bangkok"),
    ("Asia/Shanghai", "Shanghai"),
    ("Asia/Tokyo", "Tokyo"),
    ("Asia/Seoul", "Seoul"),
    ("Australia/Sydney", "Sydney"),
    ("Pacific/Auckland", "Auckland"),
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    #[default]
    Analog,
    Digital,
    Countdown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CountdownDisplay {
    #[default]
    Hhmmss,
    Seconds,
}

/// One on-screen clock: its window label, its bounds, and how it draws the time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Clock {
    /// Window label, `clock-1`, `clock-2`, …
    pub id: String,
    /// Outer window position in physical pixels.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Clock window size in logical pixels. Analog mode stays square; digital mode keeps
    /// whatever rectangle hugs the readout.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// `builtin:default`, `builtin:minimal`, or an absolute path to an SVG file.
    pub skin_path: String,
    /// `system` or an IANA time zone name.
    pub time_zone: String,
    pub display_mode: DisplayMode,
    /// Token pattern for the digital display, e.g. `HH:mm` or `yyyy-MM-dd HH:mm:ss`.
    pub digital_format: String,
    /// One of `FONTS`.
    pub font: String,
    /// Digital type size in CSS pixels, `MIN_DIGITAL_SIZE..=MAX_DIGITAL_SIZE`.
    pub digital_size: u16,
    /// Draws the translucent pill behind the digital time.
    pub digital_backdrop: bool,
    /// Adds the neon glow instead of flat text.
    pub digital_neon: bool,
    /// `#rrggbb` for the time and its glow.
    pub digital_color: String,
    /// Wraps and shrinks the readout when a manual drag leaves the window too small for it.
    pub digital_fit: bool,
    /// User-configured countdown length; also used by Reset and Start after expiry.
    pub countdown_duration_seconds: u32,
    /// Remaining seconds saved while paused.
    pub countdown_remaining_seconds: u32,
    /// Absolute Unix timestamp in milliseconds when a running countdown expires.
    pub countdown_ends_at: u64,
    /// Whether the countdown shows HH:MM:SS or total seconds.
    pub countdown_display: CountdownDisplay,
    /// Optional CSS animation to play on each countdown tick.
    pub countdown_animation: String,
    /// Limit animation to this many seconds at the end (1-60).
    pub countdown_animation_last_seconds: u32,
    /// Plays an alert sound when the countdown reaches zero.
    pub countdown_alert: bool,
    /// Id from `alert_sounds()`; empty means the OS default sound.
    pub countdown_alert_sound: String,
    /// Play the selected alert sound at each tick in the last N seconds (0 disables, max 15).
    pub countdown_alert_tick_seconds: u32,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            id: String::new(),
            x: None,
            y: None,
            width: None,
            height: None,
            skin_path: DEFAULT_SKIN.to_string(),
            time_zone: DEFAULT_TIME_ZONE.to_string(),
            display_mode: DisplayMode::Analog,
            digital_format: DEFAULT_FORMAT.to_string(),
            font: DEFAULT_FONT.to_string(),
            digital_size: DEFAULT_DIGITAL_SIZE,
            digital_backdrop: true,
            digital_neon: false,
            digital_color: DEFAULT_DIGITAL_COLOR.to_string(),
            digital_fit: true,
            countdown_duration_seconds: 300,
            countdown_remaining_seconds: 300,
            countdown_ends_at: 0,
            countdown_display: CountdownDisplay::Hhmmss,
            countdown_animation: String::new(),
            countdown_animation_last_seconds: 10,
            countdown_alert: false,
            countdown_alert_sound: String::new(),
            countdown_alert_tick_seconds: 0,
        }
    }
}

impl Clock {
    fn new(id: String) -> Self {
        Self {
            id,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// At least one clock, at most `MAX_CLOCKS`.
    pub clocks: Vec<Clock>,
    /// 0-100, applied to every clock.
    pub opacity: u8,
    pub always_on_top: bool,
    pub click_through: bool,
    pub smooth: bool,
    pub launch_at_login: bool,
    /// macOS only: accessory app, so no Dock icon and no Cmd-Tab entry. A desktop clock
    /// has no windows to manage, so the tray is the entry point instead.
    /// Defaulted on its own, because `Settings`' container default would give `false`.
    #[serde(default = "default_true")]
    pub hide_dock_icon: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            clocks: vec![Clock::new(first_clock_id())],
            opacity: 100,
            always_on_top: true,
            click_through: false,
            smooth: true,
            launch_at_login: false,
            hide_dock_icon: true,
        }
    }
}

/// App-wide switches; the panel and the tray both write these.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub opacity: Option<u8>,
    pub always_on_top: Option<bool>,
    pub click_through: Option<bool>,
    pub smooth: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub hide_dock_icon: Option<bool>,
}

impl SettingsPatch {
    fn apply(self, settings: &mut Settings) {
        if let Some(value) = self.opacity {
            settings.opacity = value;
        }
        if let Some(value) = self.always_on_top {
            settings.always_on_top = value;
        }
        if let Some(value) = self.click_through {
            settings.click_through = value;
        }
        if let Some(value) = self.smooth {
            settings.smooth = value;
        }
        if let Some(value) = self.launch_at_login {
            settings.launch_at_login = value;
        }
        if let Some(value) = self.hide_dock_icon {
            settings.hide_dock_icon = value;
        }
    }
}

/// A look-only patch for one clock: bounds are owned by the window, never by the panel.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClockPatch {
    pub skin_path: Option<String>,
    pub time_zone: Option<String>,
    /// Analog only: the square window side, which is also the size of the face.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub display_mode: Option<DisplayMode>,
    pub digital_format: Option<String>,
    pub font: Option<String>,
    pub digital_size: Option<u16>,
    pub digital_backdrop: Option<bool>,
    pub digital_neon: Option<bool>,
    pub digital_color: Option<String>,
    pub digital_fit: Option<bool>,
    pub countdown_duration_seconds: Option<u32>,
    pub countdown_remaining_seconds: Option<u32>,
    pub countdown_ends_at: Option<u64>,
    pub countdown_display: Option<CountdownDisplay>,
    pub countdown_animation: Option<String>,
    pub countdown_animation_last_seconds: Option<u32>,
    pub countdown_alert: Option<bool>,
    pub countdown_alert_sound: Option<String>,
    pub countdown_alert_tick_seconds: Option<u32>,
}

impl ClockPatch {
    fn apply(self, clock: &mut Clock) {
        if let Some(value) = self.skin_path {
            clock.skin_path = value;
        }
        if let Some(value) = self.time_zone {
            clock.time_zone = value;
        }
        if let Some(value) = self.width {
            clock.width = Some(value);
        }
        if let Some(value) = self.height {
            clock.height = Some(value);
        }
        if let Some(value) = self.display_mode {
            clock.display_mode = value;
        }
        if let Some(value) = self.digital_format {
            clock.digital_format = value;
        }
        if let Some(value) = self.font {
            clock.font = value;
        }
        if let Some(value) = self.digital_size {
            clock.digital_size = value;
        }
        if let Some(value) = self.digital_backdrop {
            clock.digital_backdrop = value;
        }
        if let Some(value) = self.digital_neon {
            clock.digital_neon = value;
        }
        if let Some(value) = self.digital_color {
            clock.digital_color = value;
        }
        if let Some(value) = self.digital_fit {
            clock.digital_fit = value;
        }
        if let Some(value) = self.countdown_duration_seconds {
            clock.countdown_duration_seconds = value;
        }
        if let Some(value) = self.countdown_remaining_seconds {
            clock.countdown_remaining_seconds = value;
        }
        if let Some(value) = self.countdown_ends_at {
            clock.countdown_ends_at = value;
        }
        if let Some(value) = self.countdown_display {
            clock.countdown_display = value;
        }
        if let Some(value) = self.countdown_animation {
            clock.countdown_animation = value;
        }
        if let Some(value) = self.countdown_animation_last_seconds {
            clock.countdown_animation_last_seconds = value;
        }
        if let Some(value) = self.countdown_alert {
            clock.countdown_alert = value;
        }
        if let Some(value) = self.countdown_alert_sound {
            clock.countdown_alert_sound = value;
        }
        if let Some(value) = self.countdown_alert_tick_seconds {
            clock.countdown_alert_tick_seconds = value;
        }
    }
}

/// The pre-multi-clock store: one flat clock plus the app switches. Only read for migration.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct GlobalsPatch {
    opacity: Option<u8>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
    smooth: Option<bool>,
    launch_at_login: Option<bool>,
    hide_dock_icon: Option<bool>,
}

pub struct SettingsState {
    settings: Mutex<Settings>,
    last_persist: Mutex<Instant>,
}

impl SettingsState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            last_persist: Mutex::new(Instant::now()),
        }
    }

    pub fn snapshot(&self) -> Settings {
        self.lock().clone()
    }

    pub fn edit<F: FnOnce(&mut Settings)>(&self, edit: F) -> Settings {
        let mut guard = self.lock();
        edit(&mut guard);
        normalize(&mut guard);
        guard.clone()
    }

    /// Debounces the frequent writes caused by dragging/resizing a window.
    pub fn should_persist(&self, min_interval: Duration) -> bool {
        let mut last = match self.last_persist.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if last.elapsed() < min_interval {
            return false;
        }
        *last = Instant::now();
        true
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        match self.settings.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn first_clock_id() -> String {
    format!("{CLOCK_PREFIX}1")
}

/// Next unused `clock-<n>`, so removing the middle clock and adding one reuses no label.
fn next_clock_id(used: &[String]) -> String {
    for index in 1..=MAX_CLOCKS + 1 {
        let candidate = format!("{CLOCK_PREFIX}{index}");
        if !used.iter().any(|id| id == &candidate) {
            return candidate;
        }
    }
    format!("{CLOCK_PREFIX}{}", used.len() + 1)
}

fn normalize(settings: &mut Settings) {
    if !OPACITY_STEPS.contains(&settings.opacity) {
        settings.opacity = 100;
    }
    settings.clocks.truncate(MAX_CLOCKS);
    if settings.clocks.is_empty() {
        settings.clocks.push(Clock::new(first_clock_id()));
    }

    // Ids are window labels: unique, non-empty and safe. A hand-edited store is repaired
    // here instead of failing to open a window later.
    let mut used: Vec<String> = Vec::with_capacity(settings.clocks.len());
    for clock in &mut settings.clocks {
        let candidate = clock.id.clone();
        let id = if is_valid_id(&candidate) && !used.contains(&candidate) {
            candidate
        } else {
            next_clock_id(&used)
        };
        used.push(id.clone());
        clock.id = id;
        normalize_clock(clock);
    }
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn normalize_clock(clock: &mut Clock) {
    if clock.skin_path.trim().is_empty() {
        clock.skin_path = DEFAULT_SKIN.to_string();
    }
    if clock.time_zone.trim().is_empty() {
        clock.time_zone = DEFAULT_TIME_ZONE.to_string();
    }
    if let Some(width) = clock.width {
        clock.width = Some(width.clamp(win::MIN_WIDTH, win::MAX_WIDTH));
    }
    if let Some(height) = clock.height {
        clock.height = Some(height.clamp(win::MIN_HEIGHT, win::MAX_HEIGHT));
    }
    // An empty pattern is allowed: the window renders `DEFAULT_FORMAT` for it, which keeps
    // a cleared input field cleared while the clock still shows a sane time.
    if clock.digital_format.chars().count() > MAX_FORMAT_LEN {
        clock.digital_format = clock.digital_format.chars().take(MAX_FORMAT_LEN).collect();
    }
    if !FONTS.iter().any(|(id, _)| *id == clock.font) {
        clock.font = DEFAULT_FONT.to_string();
    }
    clock.digital_size = clock.digital_size.clamp(MIN_DIGITAL_SIZE, MAX_DIGITAL_SIZE);
    clock.countdown_duration_seconds = clock.countdown_duration_seconds.clamp(1, 359_999);
    clock.countdown_remaining_seconds = clock.countdown_remaining_seconds.min(359_999);
    if clock.countdown_ends_at > 0 && clock.countdown_remaining_seconds == 0 {
        clock.countdown_ends_at = 0;
    }
    if !matches!(
        clock.countdown_animation.as_str(),
        "" | "animate__jello" | "animate__rubberBand"
    ) {
        clock.countdown_animation.clear();
    }
    clock.countdown_animation_last_seconds = clock.countdown_animation_last_seconds.clamp(1, 60);
    clock.countdown_alert_sound = clock.countdown_alert_sound.trim().to_string();
    if clock.countdown_alert_sound.chars().count() > 512 {
        clock.countdown_alert_sound.clear();
    }
    clock.countdown_alert_tick_seconds = clock.countdown_alert_tick_seconds.min(15);
    clock.digital_color = clock.digital_color.trim().to_ascii_lowercase();
    if !is_hex_color(&clock.digital_color) {
        clock.digital_color = DEFAULT_DIGITAL_COLOR.to_string();
    }
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(store) = app.store(STORE_FILE) else {
        eprintln!("flock: could not open the settings store, using defaults");
        return Settings::default();
    };
    let Some(value) = store.get(STORE_KEY) else {
        return Settings::default();
    };
    let mut settings = parse(value);
    normalize(&mut settings);
    settings
}

fn parse(value: Value) -> Settings {
    // The multi-clock store has a `clocks` array; anything else is the old flat shape.
    if value.get("clocks").is_some() {
        return match serde_json::from_value(value) {
            Ok(settings) => settings,
            Err(error) => {
                eprintln!("flock: ignoring unreadable settings: {error}");
                Settings::default()
            }
        };
    }
    migrate_legacy(value)
}

/// Turns `{ x, y, size, skinPath, … }` into one clock plus the app switches.
fn migrate_legacy(value: Value) -> Settings {
    let legacy_size = value
        .get("size")
        .and_then(Value::as_u64)
        .map(|size| size as u32);
    let mut clock: Clock = serde_json::from_value(value.clone()).unwrap_or_default();
    clock.id = first_clock_id();
    if clock.width.is_none() && clock.height.is_none() {
        if let Some(size) = legacy_size {
            clock.width = Some(size);
            clock.height = Some(size);
        }
    }

    let globals: GlobalsPatch = serde_json::from_value(value).unwrap_or_default();
    let defaults = Settings::default();
    let mut settings = Settings {
        clocks: vec![clock],
        opacity: globals.opacity.unwrap_or(defaults.opacity),
        always_on_top: globals.always_on_top.unwrap_or(defaults.always_on_top),
        click_through: globals.click_through.unwrap_or(defaults.click_through),
        smooth: globals.smooth.unwrap_or(defaults.smooth),
        launch_at_login: globals.launch_at_login.unwrap_or(defaults.launch_at_login),
        hide_dock_icon: globals.hide_dock_icon.unwrap_or(defaults.hide_dock_icon),
    };
    normalize(&mut settings);
    settings
}

pub fn persist(app: &AppHandle, settings: &Settings) {
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("flock: could not open the settings store: {error}");
            return;
        }
    };
    match serde_json::to_value(settings) {
        Ok(value) => store.set(STORE_KEY, value),
        Err(error) => {
            eprintln!("flock: could not serialize settings: {error}");
            return;
        }
    }
    if let Err(error) = store.save() {
        eprintln!("flock: could not save settings: {error}");
    }
}

pub fn persist_now(app: &AppHandle) {
    let settings = app.state::<SettingsState>().snapshot();
    persist(app, &settings);
}

fn broadcast(app: &AppHandle, settings: &Settings) {
    arm_alerts(app, settings);
    tray::refresh(app);
    let _ = app.emit(SETTINGS_CHANGED, settings);
}

/// (Re)arms the countdown alarms of a snapshot; idempotent, so broadcasting is cheap.
pub fn arm_alerts(app: &AppHandle, settings: &Settings) {
    for clock in &settings.clocks {
        sound::arm(
            app,
            &clock.id,
            clock.countdown_ends_at,
            clock.countdown_alert,
        );
    }
}

/// Applies an app-wide patch, mirrors it onto every clock window, persists and broadcasts.
pub fn apply_patch(app: &AppHandle, patch: SettingsPatch) -> Settings {
    let state = app.state::<SettingsState>();
    let previous = state.snapshot();
    let updated = state.edit(|settings| patch.apply(settings));

    if previous.always_on_top != updated.always_on_top {
        for window in win::clock_windows(app) {
            let _ = window.set_always_on_top(updated.always_on_top);
        }
        // The todo widget is a desktop widget too, so the tray switch applies to it.
        if let Some(window) = app.get_webview_window(crate::todos::TODO_WIDGET) {
            let _ = window.set_always_on_top(updated.always_on_top);
        }
    }
    if previous.click_through != updated.click_through {
        for window in win::clock_windows(app) {
            let _ = window.set_ignore_cursor_events(updated.click_through);
        }
        if let Some(window) = app.get_webview_window(crate::todos::TODO_WIDGET) {
            let _ = window.set_ignore_cursor_events(updated.click_through);
        }
    }
    if previous.launch_at_login != updated.launch_at_login {
        apply_autostart(app, updated.launch_at_login);
    }
    if previous.hide_dock_icon != updated.hide_dock_icon {
        win::apply_dock_visibility(app, updated.hide_dock_icon);
    }

    persist(app, &updated);
    broadcast(app, &updated);
    updated
}

/// Applies a look patch to one clock and re-applies the shape of its window.
pub fn apply_clock_patch(
    app: &AppHandle,
    clock_id: &str,
    patch: ClockPatch,
) -> Result<Settings, String> {
    apply_clock_patch_inner(app, Some(clock_id), patch)
}

/// Tray entry point: the same skin/format applies to every clock at once.
pub fn apply_clock_patch_all(app: &AppHandle, patch: ClockPatch) -> Settings {
    apply_clock_patch_inner(app, None, patch).unwrap_or_else(|_| {
        app.state::<SettingsState>().snapshot()
    })
}

fn apply_clock_patch_inner(
    app: &AppHandle,
    clock_id: Option<&str>,
    patch: ClockPatch,
) -> Result<Settings, String> {
    let state = app.state::<SettingsState>();
    let previous = state.snapshot();
    if let Some(id) = clock_id {
        if !previous.clocks.iter().any(|clock| clock.id == id) {
            return Err(format!("there is no clock called {id}"));
        }
    }

    let updated = state.edit(|settings| {
        for clock in &mut settings.clocks {
            if clock_id.is_none_or(|id| clock.id == id) {
                patch.clone().apply(clock);
            }
        }
    });

    // Analog is square by contract; digital and countdown hug their readout from the webview. A size chosen
    // in the panel has to reach the window too, or the face would not scale with it.
    for (before, after) in previous.clocks.iter().zip(updated.clocks.iter()) {
        if before.id != after.id {
            continue;
        }
        let mode_changed = before.display_mode != after.display_mode;
        let size_changed = after.display_mode == DisplayMode::Analog
            && (before.width != after.width || before.height != after.height);
        if !mode_changed && !size_changed {
            continue;
        }
        if let Some(window) = app.get_webview_window(&after.id) {
            win::apply_mode_size(&window, after);
        }
    }

    persist(app, &updated);
    broadcast(app, &updated);
    Ok(updated)
}

/// Adds a clock window, cascaded off the last one. The panel selects the new clock.
#[tauri::command]
pub fn add_clock(app: AppHandle) -> Result<Settings, String> {
    let state = app.state::<SettingsState>();
    let current = state.snapshot();
    if current.clocks.len() >= MAX_CLOCKS {
        return Err(format!("Flock can show up to {MAX_CLOCKS} clocks"));
    }

    let ids: Vec<String> = current.clocks.iter().map(|clock| clock.id.clone()).collect();
    // A new clock starts as a copy of the last one, like adding a second widget: same look
    // and size, offset a little so it is visibly its own window. The panel edits it next.
    let mut clock = current
        .clocks
        .last()
        .cloned()
        .unwrap_or_else(|| Clock::new(String::new()));
    clock.id = next_clock_id(&ids);
    clock.x = None;
    clock.y = None;
    if let Some((x, y)) = win::cascade_position(&app, current.clocks.last()) {
        clock.x = Some(x);
        clock.y = Some(y);
    }

    // The clock joins the snapshot before its window exists, so the new webview's first
    // `get_settings` already finds it. A failed window is rolled back.
    let clock_id = clock.id.clone();
    state.edit(|settings| settings.clocks.push(clock.clone()));
    if let Err(error) =
        win::create_clock(&app, &clock, current.always_on_top, current.click_through)
    {
        state.edit(|settings| settings.clocks.retain(|clock| clock.id != clock_id));
        return Err(error.to_string());
    }

    let updated = state.snapshot();
    persist(&app, &updated);
    broadcast(&app, &updated);
    Ok(updated)
}

/// Destroys one clock window. `destroy` skips the close-to-hide handler on purpose.
#[tauri::command]
pub fn remove_clock(app: AppHandle, clock_id: String) -> Result<Settings, String> {
    let state = app.state::<SettingsState>();
    let current = state.snapshot();
    if !current.clocks.iter().any(|clock| clock.id == clock_id) {
        return Err(format!("there is no clock called {clock_id}"));
    }
    if current.clocks.len() <= 1 {
        return Err("Flock keeps at least one clock".to_string());
    }

    if let Some(window) = app.get_webview_window(&clock_id) {
        let _ = window.destroy();
    }
    let updated = state.edit(|settings| settings.clocks.retain(|clock| clock.id != clock_id));
    persist(&app, &updated);
    broadcast(&app, &updated);
    Ok(updated)
}

pub fn toggle_click_through(app: &AppHandle) {
    let click_through = app.state::<SettingsState>().snapshot().click_through;
    apply_patch(
        app,
        SettingsPatch {
            click_through: Some(!click_through),
            ..SettingsPatch::default()
        },
    );
}

pub fn apply_autostart(app: &AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(error) = result {
        eprintln!("flock: could not update the login item: {error}");
    }
}

pub fn register_shortcut(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    app.global_shortcut()
        .on_shortcut(CLICK_THROUGH_SHORTCUT, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_click_through(app);
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> Settings {
    state.snapshot()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, patch: SettingsPatch) -> Settings {
    apply_patch(&app, patch)
}

#[tauri::command]
pub fn update_clock(app: AppHandle, clock_id: String, patch: ClockPatch) -> Result<Settings, String> {
    apply_clock_patch(&app, &clock_id, patch)
}

/// The panel's time-zone select reads the same curated list as the tray submenu.
#[tauri::command]
pub fn time_zones() -> Vec<(&'static str, &'static str)> {
    TIME_ZONES.to_vec()
}

/// Reads a user-picked skin. Reading here avoids granting the webview a filesystem scope.
#[tauri::command]
pub fn read_skin_file(path: String) -> Result<String, String> {
    let path = std::path::Path::new(&path);
    let is_svg = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"));
    if !is_svg {
        return Err("only .svg files can be used as a skin".to_string());
    }

    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > 1_048_576 {
        return Err("the SVG file is larger than 1 MiB".to_string());
    }

    std::fs::read_to_string(path).map_err(|error| error.to_string())
}
