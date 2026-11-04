//! Single source of truth for settings.
//!
//! The window owns the `tauri-plugin-store` file, so only one writer ever touches it.
//! The webview mirrors this state through `get_settings` and the `settings://changed`
//! event, which keeps the tray checkmarks and the React UI in sync without a second
//! copy of the truth.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_store::StoreExt;

use crate::{tray, win, MAIN_WINDOW};

pub const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

pub const SETTINGS_CHANGED: &str = "settings://changed";
pub const VISIBILITY_CHANGED: &str = "clock://visibility";

/// Toggles click-through from anywhere, so a click-through clock can never lock the user out.
pub const CLICK_THROUGH_SHORTCUT: &str = "CmdOrCtrl+Shift+O";

/// Label of the secondary window that hosts the settings form.
pub const SETTINGS_WINDOW: &str = "settings";

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    #[default]
    Analog,
    Digital,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Outer window position in physical pixels.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Legacy square side, read only when `width`/`height` are missing.
    pub size: Option<u32>,
    /// Clock window size in logical pixels. Analog mode stays square; digital mode keeps
    /// whatever rectangle hugs the readout.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// `builtin:default`, `builtin:minimal`, or an absolute path to an SVG file.
    pub skin_path: String,
    pub opacity: u8,
    pub always_on_top: bool,
    pub click_through: bool,
    /// `system` or an IANA time zone name.
    pub time_zone: String,
    pub smooth: bool,
    pub launch_at_login: bool,
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            size: None,
            width: None,
            height: None,
            skin_path: DEFAULT_SKIN.to_string(),
            opacity: 100,
            always_on_top: true,
            click_through: false,
            time_zone: DEFAULT_TIME_ZONE.to_string(),
            smooth: true,
            launch_at_login: false,
            display_mode: DisplayMode::Analog,
            digital_format: DEFAULT_FORMAT.to_string(),
            font: DEFAULT_FONT.to_string(),
            digital_size: DEFAULT_DIGITAL_SIZE,
            digital_backdrop: true,
            digital_neon: false,
            digital_color: DEFAULT_DIGITAL_COLOR.to_string(),
            digital_fit: true,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub skin_path: Option<String>,
    pub opacity: Option<u8>,
    /// Analog only: the square window side, which is also the size of the face.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub always_on_top: Option<bool>,
    pub click_through: Option<bool>,
    pub time_zone: Option<String>,
    pub smooth: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub display_mode: Option<DisplayMode>,
    pub digital_format: Option<String>,
    pub font: Option<String>,
    pub digital_size: Option<u16>,
    pub digital_backdrop: Option<bool>,
    pub digital_neon: Option<bool>,
    pub digital_color: Option<String>,
    pub digital_fit: Option<bool>,
}

impl SettingsPatch {
    fn apply(self, settings: &mut Settings) {
        if let Some(value) = self.skin_path {
            settings.skin_path = value;
        }
        if let Some(value) = self.opacity {
            settings.opacity = value;
        }
        if let Some(value) = self.width {
            settings.width = Some(value);
        }
        if let Some(value) = self.height {
            settings.height = Some(value);
        }
        if let Some(value) = self.always_on_top {
            settings.always_on_top = value;
        }
        if let Some(value) = self.click_through {
            settings.click_through = value;
        }
        if let Some(value) = self.time_zone {
            settings.time_zone = value;
        }
        if let Some(value) = self.smooth {
            settings.smooth = value;
        }
        if let Some(value) = self.launch_at_login {
            settings.launch_at_login = value;
        }
        if let Some(value) = self.display_mode {
            settings.display_mode = value;
        }
        if let Some(value) = self.digital_format {
            settings.digital_format = value;
        }
        if let Some(value) = self.font {
            settings.font = value;
        }
        if let Some(value) = self.digital_size {
            settings.digital_size = value;
        }
        if let Some(value) = self.digital_backdrop {
            settings.digital_backdrop = value;
        }
        if let Some(value) = self.digital_neon {
            settings.digital_neon = value;
        }
        if let Some(value) = self.digital_color {
            settings.digital_color = value;
        }
        if let Some(value) = self.digital_fit {
            settings.digital_fit = value;
        }
    }
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

    /// Debounces the frequent writes caused by dragging/resizing the window.
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

fn normalize(settings: &mut Settings) {
    if !OPACITY_STEPS.contains(&settings.opacity) {
        settings.opacity = 100;
    }
    if settings.skin_path.trim().is_empty() {
        settings.skin_path = DEFAULT_SKIN.to_string();
    }
    if settings.time_zone.trim().is_empty() {
        settings.time_zone = DEFAULT_TIME_ZONE.to_string();
    }
    if let Some(size) = settings.size {
        settings.size = Some(size.clamp(win::MIN_SIDE, win::MAX_SIDE));
    }
    if let Some(width) = settings.width {
        settings.width = Some(width.clamp(win::MIN_WIDTH, win::MAX_WIDTH));
    }
    if let Some(height) = settings.height {
        settings.height = Some(height.clamp(win::MIN_HEIGHT, win::MAX_HEIGHT));
    }
    // An empty pattern is allowed: the window renders `DEFAULT_FORMAT` for it, which keeps
    // a cleared input field cleared while the clock still shows a sane time.
    if settings.digital_format.chars().count() > MAX_FORMAT_LEN {
        settings.digital_format = settings.digital_format.chars().take(MAX_FORMAT_LEN).collect();
    }
    if !FONTS.iter().any(|(id, _)| *id == settings.font) {
        settings.font = DEFAULT_FONT.to_string();
    }
    settings.digital_size = settings
        .digital_size
        .clamp(MIN_DIGITAL_SIZE, MAX_DIGITAL_SIZE);
    settings.digital_color = settings.digital_color.trim().to_ascii_lowercase();
    if !is_hex_color(&settings.digital_color) {
        settings.digital_color = DEFAULT_DIGITAL_COLOR.to_string();
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
    let mut settings: Settings = match serde_json::from_value(value) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("flock: ignoring unreadable settings: {error}");
            Settings::default()
        }
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

/// Applies a patch, mirrors it onto the live window, persists it, and broadcasts it.
pub fn apply_patch(app: &AppHandle, patch: SettingsPatch) -> Settings {
    let state = app.state::<SettingsState>();
    let previous = state.snapshot();
    let updated = state.edit(|settings| patch.apply(settings));

    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if previous.always_on_top != updated.always_on_top {
            let _ = window.set_always_on_top(updated.always_on_top);
        }
        if previous.click_through != updated.click_through {
            let _ = window.set_ignore_cursor_events(updated.click_through);
        }
    }

    if previous.launch_at_login != updated.launch_at_login {
        apply_autostart(app, updated.launch_at_login);
    }

    // Analog is square by contract; digital hugs its readout from the webview. A size chosen
    // in the panel has to reach the window too, or the face would not scale with it.
    let resized_by_panel =
        updated.display_mode == DisplayMode::Analog
            && (previous.width != updated.width || previous.height != updated.height);
    if previous.display_mode != updated.display_mode || resized_by_panel {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            win::apply_mode_size(&window, &updated);
        }
    }

    persist(app, &updated);
    tray::refresh(app);
    let _ = app.emit(SETTINGS_CHANGED, &updated);

    updated
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
