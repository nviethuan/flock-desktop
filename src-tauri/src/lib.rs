mod settings;
mod tray;
mod win;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The store is used from Rust only: one writer, no stale caches.
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::update_settings,
            settings::update_clock,
            settings::add_clock,
            settings::remove_clock,
            settings::time_zones,
            settings::read_skin_file,
            win::resize_clock_box,
            win::close_settings,
            win::show_settings,
            win::platform,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = settings::load(&handle);

            app.manage(settings::SettingsState::new(loaded.clone()));
            settings::apply_autostart(&handle, loaded.launch_at_login);

            // Every clock is its own window, so none of them comes from tauri.conf.json.
            win::setup(&handle, &loaded)?;
            tray::build(&handle)?;

            if let Err(error) = settings::register_shortcut(&handle) {
                eprintln!("flock: global shortcut unavailable: {error}");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Flock")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                settings::persist_now(app);
            }
        });
}
