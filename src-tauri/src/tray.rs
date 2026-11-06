//! System tray: menu construction, checkmark syncing, and menu actions.
//!
//! The look submenus (display, skin, font, time zone) apply to every clock at once; the
//! panel is where a single clock is styled. App-wide switches stay global.

use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Wry,
};

use crate::{
    settings::{self, ClockPatch, DisplayMode, Settings, SettingsPatch, SettingsState, FONTS, TIME_ZONES},
    win,
};

pub const PICK_SKIN_EVENT: &str = "skin://pick";

/// Kept in step with `BUILTIN_SKINS` in `src/lib/skins.ts` (keys and labels).
const BUILTIN_SKINS: [(&str, &str); 5] = [
    ("builtin:default", "Default"),
    ("builtin:minimal", "Minimal"),
    ("builtin:dial", "Classic"),
    ("builtin:neon", "Neon"),
    ("builtin:bauhaus", "Bauhaus"),
];

pub struct TrayMenu {
    toggle_visibility: MenuItem<Wry>,
    always_on_top: CheckMenuItem<Wry>,
    click_through: CheckMenuItem<Wry>,
    smooth: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    opacity: Vec<(u8, CheckMenuItem<Wry>)>,
    skins: Vec<(String, CheckMenuItem<Wry>)>,
    custom_skin: CheckMenuItem<Wry>,
    zones: Vec<(String, CheckMenuItem<Wry>)>,
    modes: Vec<(DisplayMode, CheckMenuItem<Wry>)>,
    fonts: Vec<(String, CheckMenuItem<Wry>)>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let settings = app.state::<SettingsState>().snapshot();

    let toggle_visibility =
        MenuItem::with_id(app, "window:toggle", "Hide clock", true, None::<&str>)?;
    let always_on_top = CheckMenuItem::with_id(
        app,
        "window:on-top",
        "Always on top",
        true,
        settings.always_on_top,
        None::<&str>,
    )?;
    let click_through = CheckMenuItem::with_id(
        app,
        "window:click-through",
        "Click-through",
        true,
        settings.click_through,
        None::<&str>,
    )?;
    let smooth = CheckMenuItem::with_id(
        app,
        "clock:smooth",
        "Smooth second hand",
        true,
        settings.smooth,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "app:autostart",
        "Launch at login",
        true,
        settings.launch_at_login,
        None::<&str>,
    )?;

    let mut opacity_items = Vec::with_capacity(4);
    for value in [100_u8, 80, 60, 40] {
        let item = CheckMenuItem::with_id(
            app,
            format!("opacity:{value}"),
            format!("{value}%"),
            true,
            settings.opacity == value,
            None::<&str>,
        )?;
        opacity_items.push((value, item));
    }

    let mut skin_items = Vec::with_capacity(BUILTIN_SKINS.len());
    for (key, label) in BUILTIN_SKINS {
        let item = CheckMenuItem::with_id(
            app,
            format!("skin:{key}"),
            label,
            true,
            settings.clocks.iter().all(|clock| clock.skin_path == key),
            None::<&str>,
        )?;
        skin_items.push((key.to_string(), item));
    }
    let custom_skin = CheckMenuItem::with_id(
        app,
        "skin:custom",
        "Load custom SVG…",
        true,
        settings
            .clocks
            .iter()
            .all(|clock| !clock.skin_path.starts_with("builtin:")),
        None::<&str>,
    )?;

    let mut mode_items = Vec::with_capacity(2);
    for (id, label, mode) in [
        ("mode:analog", "Analog", DisplayMode::Analog),
        ("mode:digital", "Digital", DisplayMode::Digital),
    ] {
        let item = CheckMenuItem::with_id(
            app,
            id,
            label,
            true,
            settings.clocks.iter().all(|clock| clock.display_mode == mode),
            None::<&str>,
        )?;
        mode_items.push((mode, item));
    }

    let mut font_items = Vec::with_capacity(FONTS.len());
    for (id, label) in FONTS {
        let item = CheckMenuItem::with_id(
            app,
            format!("font:{id}"),
            label,
            true,
            settings.clocks.iter().all(|clock| clock.font == id),
            None::<&str>,
        )?;
        font_items.push((id.to_string(), item));
    }

    let mut zone_items = Vec::with_capacity(TIME_ZONES.len());
    for (zone, label) in TIME_ZONES {
        let item = CheckMenuItem::with_id(
            app,
            format!("tz:{zone}"),
            label,
            true,
            settings.clocks.iter().all(|clock| clock.time_zone == zone),
            None::<&str>,
        )?;
        zone_items.push((zone.to_string(), item));
    }

    let opacity_submenu = Submenu::with_items(
        app,
        "Opacity",
        true,
        &opacity_items
            .iter()
            .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let mut skin_refs: Vec<&dyn IsMenuItem<Wry>> = skin_items
        .iter()
        .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
        .collect();
    skin_refs.push(&custom_skin);
    let skin_submenu = Submenu::with_items(app, "Skin", true, &skin_refs)?;

    let mode_submenu = Submenu::with_items(
        app,
        "Display",
        true,
        &mode_items
            .iter()
            .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let font_submenu = Submenu::with_items(
        app,
        "Font",
        true,
        &font_items
            .iter()
            .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let zone_submenu = Submenu::with_items(
        app,
        "Time zone",
        true,
        &zone_items
            .iter()
            .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let settings_open = MenuItem::with_id(app, "settings:open", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "app:quit", "Quit Flock", true, None::<&str>)?;
    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_middle = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    let wayland_warning = wayland_warning_item(app)?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    if let Some(item) = &wayland_warning {
        items.push(item);
        items.push(&separator_top);
    }
    items.push(&toggle_visibility);
    items.push(&always_on_top);
    items.push(&click_through);
    items.push(&separator_middle);
    items.push(&opacity_submenu);
    items.push(&mode_submenu);
    items.push(&skin_submenu);
    items.push(&font_submenu);
    items.push(&zone_submenu);
    items.push(&separator_bottom);
    items.push(&smooth);
    items.push(&autostart);
    items.push(&settings_open);
    items.push(&quit);

    let menu = Menu::with_items(app, &items)?;

    let mut builder = TrayIconBuilder::with_id("flock-tray")
        .menu(&menu)
        .tooltip("Flock")
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()));

    #[cfg(target_os = "macos")]
    {
        // Template rendering keeps the menu bar glyph readable in light and dark menus.
        builder = builder
            .icon(tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray.png"
            ))?)
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }

    builder.build(app)?;

    app.manage(TrayMenu {
        toggle_visibility,
        always_on_top,
        click_through,
        smooth,
        autostart,
        opacity: opacity_items,
        skins: skin_items,
        custom_skin,
        zones: zone_items,
        modes: mode_items,
        fonts: font_items,
    });

    Ok(())
}

/// Keeps every checkmark and the show/hide label in step with the settings state.
///
/// A look item is checked only when *every* clock matches it, so a mixed set reads as
/// "not applied" without inventing a third state.
pub fn refresh(app: &AppHandle) {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return;
    };
    let settings = app.state::<SettingsState>().snapshot();

    let _ = menu.always_on_top.set_checked(settings.always_on_top);
    let _ = menu.click_through.set_checked(settings.click_through);
    let _ = menu.smooth.set_checked(settings.smooth);
    let _ = menu.autostart.set_checked(settings.launch_at_login);
    let _ = menu.custom_skin.set_checked(
        settings
            .clocks
            .iter()
            .all(|clock| !clock.skin_path.starts_with("builtin:")),
    );

    for (value, item) in &menu.opacity {
        let _ = item.set_checked(settings.opacity == *value);
    }
    for (key, item) in &menu.skins {
        let _ = item.set_checked(
            settings
                .clocks
                .iter()
                .all(|clock| clock.skin_path == key.as_str()),
        );
    }
    for (zone, item) in &menu.zones {
        let _ = item.set_checked(
            settings
                .clocks
                .iter()
                .all(|clock| clock.time_zone == zone.as_str()),
        );
    }
    for (mode, item) in &menu.modes {
        let _ = item.set_checked(
            settings
                .clocks
                .iter()
                .all(|clock| clock.display_mode == *mode),
        );
    }
    for (id, item) in &menu.fonts {
        let _ = item.set_checked(
            settings
                .clocks
                .iter()
                .all(|clock| clock.font == id.as_str()),
        );
    }

    let visible = win::clock_windows(app)
        .iter()
        .any(|window| window.is_visible().unwrap_or(true));
    let noun = if settings.clocks.len() > 1 {
        "clocks"
    } else {
        "clock"
    };
    let _ = menu.toggle_visibility.set_text(if visible {
        format!("Hide {noun}")
    } else {
        format!("Show {noun}")
    });
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "app:quit" => {
            settings::persist_now(app);
            app.exit(0);
        }
        "window:toggle" => win::toggle_visibility(app),
        "window:click-through" => settings::toggle_click_through(app),
        "skin:custom" => {
            // The webview owns the file dialog so the chosen path can be validated first.
            // Only the clock that has focus is asked, so a dialog cannot open per window.
            if let Some(clock) = win::focused_clock(app) {
                let _ = app.emit_to(clock, PICK_SKIN_EVENT, ());
            }
        }
        "settings:open" => {
            if let Err(error) = win::open_settings(app, None) {
                eprintln!("flock: could not open settings: {error}");
            }
        }
        "window:on-top" => {
            let next = !current(app).always_on_top;
            settings::apply_patch(
                app,
                SettingsPatch {
                    always_on_top: Some(next),
                    ..SettingsPatch::default()
                },
            );
        }
        "clock:smooth" => {
            let next = !current(app).smooth;
            settings::apply_patch(
                app,
                SettingsPatch {
                    smooth: Some(next),
                    ..SettingsPatch::default()
                },
            );
        }
        "app:autostart" => {
            let next = !current(app).launch_at_login;
            settings::apply_patch(
                app,
                SettingsPatch {
                    launch_at_login: Some(next),
                    ..SettingsPatch::default()
                },
            );
        }
        other => {
            if let Some(value) = other.strip_prefix("opacity:") {
                if let Ok(opacity) = value.parse::<u8>() {
                    settings::apply_patch(
                        app,
                        SettingsPatch {
                            opacity: Some(opacity),
                            ..SettingsPatch::default()
                        },
                    );
                }
            } else if let Some(key) = other.strip_prefix("skin:") {
                settings::apply_clock_patch_all(
                    app,
                    ClockPatch {
                        skin_path: Some(key.to_string()),
                        ..ClockPatch::default()
                    },
                );
            } else if let Some(zone) = other.strip_prefix("tz:") {
                settings::apply_clock_patch_all(
                    app,
                    ClockPatch {
                        time_zone: Some(zone.to_string()),
                        ..ClockPatch::default()
                    },
                );
            } else if let Some(mode) = other.strip_prefix("mode:") {
                let display_mode = match mode {
                    "digital" => DisplayMode::Digital,
                    _ => DisplayMode::Analog,
                };
                settings::apply_clock_patch_all(
                    app,
                    ClockPatch {
                        display_mode: Some(display_mode),
                        ..ClockPatch::default()
                    },
                );
            } else if let Some(id) = other.strip_prefix("font:") {
                settings::apply_clock_patch_all(
                    app,
                    ClockPatch {
                        font: Some(id.to_string()),
                        ..ClockPatch::default()
                    },
                );
            }
        }
    }
}

fn current(app: &AppHandle) -> Settings {
    app.state::<SettingsState>().snapshot()
}

/// On Wayland the compositor may refuse "always on top"; surface that in the menu itself.
fn wayland_warning_item(app: &AppHandle) -> tauri::Result<Option<MenuItem<Wry>>> {
    #[cfg(target_os = "linux")]
    {
        if is_wayland() {
            return Ok(Some(MenuItem::with_id(
                app,
                "warning:wayland",
                "⚠ Always-on-top may be ignored on Wayland",
                false,
                None::<&str>,
            )?));
        }
    }
    let _ = app;
    Ok(None)
}

#[cfg(target_os = "linux")]
fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
}
