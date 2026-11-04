//! Window plumbing: restore bounds, keep the analog clock square (the digital clock hugs
//! its readout instead), persist moves/resizes, and hide instead of quitting when the
//! clock is closed.

use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::{
    settings::{self, DisplayMode, Settings, SettingsState, VISIBILITY_CHANGED},
    MAIN_WINDOW,
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

const SETTINGS_PANEL_WIDTH: f64 = 420.0;
const SETTINGS_PANEL_HEIGHT: f64 = 600.0;

const BOUNDS_PERSIST_INTERVAL: Duration = Duration::from_millis(900);

pub fn setup(app: &AppHandle, settings: &Settings) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };

    // Windows has no per-workspace visibility API; this is a no-op there.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.set_visible_on_all_workspaces(true);
    }

    let _ = window.set_always_on_top(settings.always_on_top);
    let _ = window.set_ignore_cursor_events(settings.click_through);

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

    restore_bounds(&window, settings);
    install_handlers(&window);

    window.show()?;
    Ok(())
}

fn restore_bounds(window: &WebviewWindow, settings: &Settings) {
    let (width, height) = restored_size(settings);
    let _ = window.set_size(LogicalSize::new(width, height));

    if let (Some(x), Some(y)) = (settings.x, settings.y) {
        if is_on_screen(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }

    // First run, or the monitor is gone: fall back to the centre of the primary display.
    let _ = window.center();
}

/// Saved size, migrated from the old square `size` field, clamped to the mode's limits.
fn restored_size(settings: &Settings) -> (f64, f64) {
    let width = settings.width.or(settings.size).unwrap_or(DEFAULT_WIDTH);
    let height = settings.height.or(settings.size).unwrap_or(DEFAULT_HEIGHT);

    match settings.display_mode {
        DisplayMode::Analog => {
            let side = width.max(height).clamp(MIN_SIDE, MAX_SIDE) as f64;
            (side, side)
        }
        DisplayMode::Digital => (
            width.clamp(MIN_WIDTH, MAX_WIDTH) as f64,
            height.clamp(MIN_HEIGHT, MAX_HEIGHT) as f64,
        ),
    }
}

/// Re-applies the mode's shape: square for analog, left to the webview's hug for digital.
pub fn apply_mode_size(window: &WebviewWindow, settings: &Settings) {
    let (width, height) = restored_size(settings);
    let _ = window.set_size(LogicalSize::new(width, height));
}

fn is_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
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
            // Closing the clock hides it; quit lives in the tray.
            api.prevent_close();
            let _ = target.hide();
            let _ = target.app_handle().emit(VISIBILITY_CHANGED, false);
        }
        _ => {}
    });
}

/// Only the analog clock is square; the digital one is sized by the readout.
fn is_square_mode(window: &WebviewWindow) -> bool {
    window.app_handle().state::<SettingsState>().snapshot().display_mode == DisplayMode::Analog
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
    let app = window.app_handle();
    let state = app.state::<SettingsState>();

    let current = state.snapshot();
    if current.x == Some(position.x)
        && current.y == Some(position.y)
        && current.width == Some(width)
        && current.height == Some(height)
    {
        return;
    }

    state.edit(|settings| {
        settings.x = Some(position.x);
        settings.y = Some(position.y);
        settings.width = Some(width);
        settings.height = Some(height);
        // The legacy field keeps the smaller side, which is the old square behaviour.
        settings.size = Some(width.min(height));
    });

    if state.should_persist(BOUNDS_PERSIST_INTERVAL) {
        settings::persist(app, &state.snapshot());
    }
}

/// Command behind the clock's double click: the same panel the tray opens, so the two
/// entry points can never drift apart.
#[tauri::command]
pub fn show_settings(app: AppHandle) -> Result<(), String> {
    open_settings(&app)
}

/// Opens (or re-focuses) the settings window next to the clock.
///
/// The panel is placed beside the clock so the live preview stays visible; if there is no
/// room on that monitor it falls back to the centred default.
pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(settings::SETTINGS_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        settings::SETTINGS_WINDOW,
        WebviewUrl::App("index.html".into()),
    )
    .title("Flock Settings")
    .inner_size(SETTINGS_PANEL_WIDTH, SETTINGS_PANEL_HEIGHT)
    .min_inner_size(SETTINGS_PANEL_WIDTH, 480.0)
    .focused(true);

    builder = match position_beside_clock(app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

/// Sizes the clock window so the digital readout is hugged instead of clipped.
/// Dimensions are logical pixels; `record_bounds` persists the result like a manual resize.
#[tauri::command]
pub fn resize_clock_box(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Err("the clock window is not available".to_string());
    };
    let width = width.round().clamp(MIN_WIDTH as f64, MAX_WIDTH as f64);
    let height = height.round().clamp(MIN_HEIGHT as f64, MAX_HEIGHT as f64);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn close_settings(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(settings::SETTINGS_WINDOW) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn position_beside_clock(app: &AppHandle) -> Option<(f64, f64)> {
    let clock = app.get_webview_window(MAIN_WINDOW)?;
    let scale = clock.scale_factor().ok()?;
    let origin = clock.outer_position().ok()?;
    let size = clock.inner_size().ok()?;
    let monitor = clock.current_monitor().ok().flatten()?;

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

pub fn toggle_visibility(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true);

    if visible {
        let _ = window.hide();
    } else {
        let _ = window.show();
    }

    crate::tray::refresh(app);
    let _ = app.emit(VISIBILITY_CHANGED, !visible);
}
