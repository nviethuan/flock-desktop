//! Window plumbing: one clock window per saved clock, bounds restore/persist, the square
//! analog face, digital readout, countdown, the settings panel, and hide-instead-of-quit.

use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::{
    settings::{self, Clock, DisplayMode, Settings, SettingsState, VISIBILITY_CHANGED},
    settings::{CLOCK_PREFIX, SETTINGS_FOCUS, SETTINGS_WINDOW},
};

pub const MIN_SIDE: u32 = 120;
/// Matches the configured `maxHeight`, so a square face can use the whole allowed area.
pub const MAX_SIDE: u32 = 1200;

/// The digital clock hugs a rectangle, so it may be wider (or shorter) than the analog square.
pub const MIN_WIDTH: u32 = 120;
pub const MAX_WIDTH: u32 = 1600;
pub const MIN_HEIGHT: u32 = 64;
pub const MAX_HEIGHT: u32 = 1200;

const DEFAULT_WIDTH: u32 = 220;
const DEFAULT_HEIGHT: u32 = 220;

/// Offset of a freshly added clock from the previous one, in physical pixels.
const CASCADE_OFFSET: i32 = 36;

const SETTINGS_PANEL_WIDTH: f64 = 420.0;
const SETTINGS_PANEL_HEIGHT: f64 = 600.0;

const BOUNDS_PERSIST_INTERVAL: Duration = Duration::from_millis(900);

pub fn setup(app: &AppHandle, settings: &Settings) -> tauri::Result<()> {
    for clock in &settings.clocks {
        create_clock(app, clock, settings.always_on_top, settings.click_through)?;
    }
    Ok(())
}

/// Hides the Dock icon on macOS by switching the app to the accessory policy.
///
/// The clock windows, the tray item and the settings panel all keep working; what goes away
/// is the Dock icon, the Cmd-Tab entry and the app menu (the tray carries Quit). Switching
/// back to `Regular` restores all of them without a restart.
pub fn apply_dock_visibility(app: &AppHandle, hidden: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if hidden {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        if let Err(error) = app.set_activation_policy(policy) {
            eprintln!("flock: could not change the activation policy: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows and Linux have no Dock; the switch is macOS-only and stays invisible there.
        let _ = (app, hidden);
    }
}

/// Every window that shows a clock, in no particular order.
pub fn clock_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(CLOCK_PREFIX))
        .map(|(_, window)| window)
        .collect()
}

/// Builds the frameless, transparent, always-on-top window for one clock.
pub fn create_clock(
    app: &AppHandle,
    clock: &Clock,
    always_on_top: bool,
    click_through: bool,
) -> tauri::Result<WebviewWindow> {
    let (width, height) = restored_size(clock);
    let mut builder = WebviewWindowBuilder::new(
        app,
        clock.id.clone(),
        WebviewUrl::App("index.html".into()),
    )
    .title("Flock")
    .inner_size(width, height)
    .min_inner_size(MIN_WIDTH as f64, MIN_HEIGHT as f64)
    .max_inner_size(MAX_WIDTH as f64, MAX_HEIGHT as f64)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(always_on_top)
    .visible(false)
    .focused(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder.accept_first_mouse(true);
    }

    let window = builder.build()?;

    // Windows has no per-workspace visibility API; this is a no-op there.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.set_visible_on_all_workspaces(true);
    }

    let _ = window.set_ignore_cursor_events(click_through);

    // Sizing belongs to Settings, so macOS drops the resizable style mask: a borderless
    // window that keeps it still grows an invisible edge-drag frame, and dragging an edge
    // would change the size behind the panel's back. tao's macOS `set_resizable` only edits
    // the mask (no min/max clamp), so the programmatic `set_size` used by restore, the analog
    // Size slider and the digital hug keeps working. GTK is deliberately left alone: there
    // `set_resizable(false)` pins the window to its natural size and the hug would die.
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_resizable(false);
    }

    place_window(&window, clock);
    install_handlers(&window);
    window.show()?;
    Ok(window)
}

fn place_window(window: &WebviewWindow, clock: &Clock) {
    let (width, height) = restored_size(clock);
    let _ = window.set_size(LogicalSize::new(width, height));

    if let (Some(x), Some(y)) = (clock.x, clock.y) {
        if is_on_screen(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }

    // First run, or the monitor is gone: fall back to the centre of the primary display.
    let _ = window.center();
}

/// Saved size, clamped to the mode's limits.
fn restored_size(clock: &Clock) -> (f64, f64) {
    let width = clock.width.unwrap_or(DEFAULT_WIDTH);
    let height = clock.height.unwrap_or(DEFAULT_HEIGHT);

    match clock.display_mode {
        DisplayMode::Analog => {
            let side = width.max(height).clamp(MIN_SIDE, MAX_SIDE) as f64;
            (side, side)
        }
        DisplayMode::Digital | DisplayMode::Countdown => (
            width.clamp(MIN_WIDTH, MAX_WIDTH) as f64,
            height.clamp(MIN_HEIGHT, MAX_HEIGHT) as f64,
        ),
    }
}

/// Re-applies the mode's shape: square for analog, left to the webview's hug for digital.
pub fn apply_mode_size(window: &WebviewWindow, clock: &Clock) {
    let (width, height) = restored_size(clock);
    let _ = window.set_size(LogicalSize::new(width, height));
}

/// Physical position for a new clock: a small cascade off the previous window.
pub fn cascade_position(app: &AppHandle, previous: Option<&Clock>) -> Option<(i32, i32)> {
    let previous = previous?;
    let window = app.get_webview_window(&previous.id);
    let origin = match window.and_then(|window| window.outer_position().ok()) {
        Some(position) => (position.x, position.y),
        None => match (previous.x, previous.y) {
            (Some(x), Some(y)) => (x, y),
            _ => return None,
        },
    };
    Some((origin.0 + CASCADE_OFFSET, origin.1 + CASCADE_OFFSET))
}

pub fn is_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let right = position.x + size.width as i32;
        let bottom = position.y + size.height as i32;
        x >= position.x - 40 && y >= position.y - 40 && x + 80 <= right && y + 80 <= bottom
    })
}

fn install_handlers(window: &WebviewWindow) {
    // The closure cannot capture the window it is registered on, so it owns a second clone.
    let target = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(size) => {
            // Ignore the 1px rounding some window managers apply while dragging.
            let delta = size.width as i64 - size.height as i64;
            if delta.abs() > 1 && is_square_mode(&target) {
                enforce_square(&target);
            }
            record_bounds(&target);
        }
        WindowEvent::Moved(_) => record_bounds(&target),
        WindowEvent::CloseRequested { api, .. } => {
            // Closing one clock hides it; quit lives in the tray.
            api.prevent_close();
            let _ = target.hide();
            let _ = target.app_handle().emit_to(
                target.label(),
                VISIBILITY_CHANGED,
                false,
            );
        }
        _ => {}
    });
}

/// Only the analog clock is square; the digital one is sized by the readout.
fn is_square_mode(window: &WebviewWindow) -> bool {
    let label = window.label().to_string();
    window
        .app_handle()
        .state::<SettingsState>()
        .snapshot()
        .clocks
        .iter()
        .any(|clock| clock.id == label && clock.display_mode == DisplayMode::Analog)
}

/// Tauri v2 exposes no native aspect-ratio constraint, so the square is enforced on resize.
fn enforce_square(window: &WebviewWindow) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let side = (size.width.max(size.height) as f64 / scale).clamp(MIN_SIDE as f64, MAX_SIDE as f64);
    let _ = window.set_size(LogicalSize::new(side, side));
}

fn record_bounds(window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };

    let width = (size.width as f64 / scale).round() as u32;
    let height = (size.height as f64 / scale).round() as u32;
    let label = window.label().to_string();
    let app = window.app_handle();
    let state = app.state::<SettingsState>();

    let current = state.snapshot();
    let Some(clock) = current.clocks.iter().find(|clock| clock.id == label) else {
        return;
    };
    if clock.x == Some(position.x)
        && clock.y == Some(position.y)
        && clock.width == Some(width)
        && clock.height == Some(height)
    {
        return;
    }

    state.edit(|settings| {
        if let Some(clock) = settings.clocks.iter_mut().find(|clock| clock.id == label) {
            clock.x = Some(position.x);
            clock.y = Some(position.y);
            clock.width = Some(width);
            clock.height = Some(height);
        }
    });

    if state.should_persist(BOUNDS_PERSIST_INTERVAL) {
        settings::persist(app, &state.snapshot());
    }
}

/// The webview needs exactly one OS fact: macOS is the only place where the native window
/// drag is unusable, so the clock moves itself there (see `src/lib/drag.ts`).
#[tauri::command]
pub fn platform() -> &'static str {
    std::env::consts::OS
}

/// Command behind the clock's double click: the same panel the tray opens, focused on the
/// clock that was double-clicked.
#[tauri::command]
pub fn show_settings(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    open_settings(&app, Some(window.label().to_string()))
}

/// Quit from the panel: same path as the tray's Quit (save bounds, then leave).
///
/// It has to live somewhere in the UI because hiding the Dock icon also hides the app menu,
/// which takes `Cmd+Q` with it.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    settings::persist_now(&app);
    app.exit(0);
}

/// Clock that most recently had keyboard focus, so the tray knows which one it means.
pub fn focused_clock(app: &AppHandle) -> Option<String> {
    let windows = clock_windows(app);
    let focused = windows
        .iter()
        .find(|window| window.is_focused().unwrap_or(false));
    // Clicking the tray does not focus a clock; the first one is the predictable fallback.
    let window = focused.or_else(|| windows.first());
    window.map(|window| window.label().to_string())
}

/// Opens (or re-focuses) the settings window next to the clock it should edit.
///
/// The panel is placed beside that clock so the live preview stays visible; if there is no
/// room on that monitor it falls back to the centred default.
pub fn open_settings(app: &AppHandle, focus_clock: Option<String>) -> Result<(), String> {
    let target = focus_clock.or_else(|| focused_clock(app));

    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(clock) = target {
            let _ = app.emit_to(SETTINGS_WINDOW, SETTINGS_FOCUS, clock);
        }
        return Ok(());
    }

    // The clock to edit travels in the URL, so the panel's very first render already knows
    // it; the event above is only for a panel that is already open.
    let address = match &target {
        Some(clock) => format!("index.html?focus={clock}"),
        None => "index.html".to_string(),
    };

    let mut builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW,
        WebviewUrl::App(address.into()),
    )
    .title("Flock Settings")
    .inner_size(SETTINGS_PANEL_WIDTH, SETTINGS_PANEL_HEIGHT)
    .min_inner_size(SETTINGS_PANEL_WIDTH, 480.0)
    .focused(true);

    let placement = position_beside_clock(app, target.as_deref());
    if let Some((x, y)) = placement {
        builder = builder.position(x, y);
    }

    let window = builder.build().map_err(|error| error.to_string())?;
    if placement.is_none() {
        let _ = window.center();
    }
    Ok(())
}

/// Sizes the calling clock window so the digital readout is hugged instead of clipped.
/// Dimensions are logical pixels; `record_bounds` persists the result like a manual resize.
#[tauri::command]
pub fn resize_clock_box(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let width = width.round().clamp(MIN_WIDTH as f64, MAX_WIDTH as f64);
    let height = height.round().clamp(MIN_HEIGHT as f64, MAX_HEIGHT as f64);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn close_settings(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn position_beside_clock(app: &AppHandle, clock: Option<&str>) -> Option<(f64, f64)> {
    let label = clock?;
    let window = app.get_webview_window(label)?;
    let scale = window.scale_factor().ok()?;
    let origin = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let monitor = window.current_monitor().ok().flatten()?;

    let x = origin.x as f64 / scale;
    let y = origin.y as f64 / scale;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;

    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;
    let monitor_height = monitor.size().height as f64 / scale;

    let margin = 12.0;
    if monitor_height <= SETTINGS_PANEL_HEIGHT + margin * 2.0 {
        return None;
    }

    let top = (y + height / 2.0 - SETTINGS_PANEL_HEIGHT / 2.0)
        .clamp(monitor_y + margin, monitor_y + monitor_height - SETTINGS_PANEL_HEIGHT - margin);
    let right = x + width + margin;
    let left = x - SETTINGS_PANEL_WIDTH - margin;

    if right + SETTINGS_PANEL_WIDTH <= monitor_x + monitor_width - margin {
        return Some((right, top));
    }
    if left >= monitor_x + margin {
        return Some((left, top));
    }
    None
}

/// Hides every clock, or brings them all back.
pub fn toggle_visibility(app: &AppHandle) {
    let windows = clock_windows(app);
    if windows.is_empty() {
        return;
    }
    let visible = windows
        .iter()
        .any(|window| window.is_visible().unwrap_or(true));

    for window in &windows {
        if visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
        }
        let _ = app.emit_to(window.label(), VISIBILITY_CHANGED, !visible);
    }

    crate::tray::refresh(app);
}
