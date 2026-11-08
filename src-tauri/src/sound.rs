//! System alert sounds for the countdown alarm.
//!
//! The list is discovered from the OS at runtime, so Flock never ships its own audio:
//! macOS reads the alert-sound library behind System Settings › Sound, Windows the
//! `Media` folder with the OS alarm/ring tones, and Linux the freedesktop sound theme.
//! Playback goes through the platform's own player, so no audio dependency is linked in.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::settings::SettingsState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertSound {
    /// Absolute path of the file. The UI treats it as opaque; playback re-checks it
    /// against a fresh scan, so a hand-edited setting cannot run an arbitrary program.
    pub id: String,
    pub label: String,
}

/// The formats the platform sound libraries actually use.
const EXTENSIONS: [&str; 7] = ["aiff", "aif", "caf", "wav", "mp3", "oga", "ogg"];

fn sound_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut dirs = vec![
            PathBuf::from("/System/Library/Sounds"),
            PathBuf::from("/Library/Sounds"),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Library/Sounds"));
        }
        dirs
    }

    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        vec![root.join("Media")]
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        vec![
            PathBuf::from("/usr/share/sounds/freedesktop/stereo"),
            PathBuf::from("/usr/share/sounds/ubuntu/stereo"),
            PathBuf::from("/usr/share/sounds/gnome/default/alarms"),
        ]
    }
}

fn is_sound_file(path: &Path) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|extension| EXTENSIONS.contains(&extension.as_str()))
}

/// File stem as a menu label: `alarm-clock-elapsed` → `Alarm clock elapsed`.
fn label(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut words = stem.replace(['_', '-'], " ");
    if let Some(first) = words.chars().next() {
        words.replace_range(..first.len_utf8(), &first.to_uppercase().to_string());
    }
    words
}

/// Every alert sound the OS offers, first library first, alphabetical inside each.
pub fn list() -> Vec<AlertSound> {
    let mut sounds: Vec<AlertSound> = Vec::new();
    for dir in sound_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| is_sound_file(path))
            .collect();
        paths.sort();

        for path in paths {
            let id = path.to_string_lossy().into_owned();
            if sounds.iter().any(|sound| sound.id == id) {
                continue;
            }
            sounds.push(AlertSound {
                id,
                label: label(&path),
            });
        }
    }
    sounds
}

/// The closest thing to the OS's own default alert tone in the libraries we found.
const PREFERRED: [&str; 5] = ["Boop", "Ping", "Glass", "Alarm 01", "Bell"];

fn default_sound(sounds: &[AlertSound]) -> Option<&AlertSound> {
    PREFERRED
        .iter()
        .find_map(|preferred| {
            sounds
                .iter()
                .find(|sound| sound.label.eq_ignore_ascii_case(preferred))
        })
        .or_else(|| sounds.first())
}

/// Plays the chosen sound; an empty or stale id falls back to the OS default, and a
/// missing library falls back to the system beep.
pub fn play(sound_id: &str) {
    let sounds = list();
    let chosen = sounds
        .iter()
        .find(|sound| sound.id == sound_id)
        .or_else(|| default_sound(&sounds));

    match chosen {
        Some(sound) if play_file(Path::new(&sound.id)) => {}
        Some(sound) => {
            eprintln!("flock: could not play {}", sound.id);
            beep();
        }
        None => beep(),
    }
}

#[cfg(target_os = "macos")]
fn play_file(path: &Path) -> bool {
    Command::new("/usr/bin/afplay").arg(path).spawn().is_ok()
}

#[cfg(target_os = "windows")]
fn play_file(path: &Path) -> bool {
    let quoted = path.to_string_lossy().replace('\'', "''");
    let script = format!("(New-Object Media.SoundPlayer '{quoted}').PlaySync()");
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .spawn()
        .is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn play_file(path: &Path) -> bool {
    let players: [(&str, &[&str]); 3] = [
        ("paplay", &[]),
        ("canberra-gtk-play", &["-f"]),
        ("aplay", &["-q"]),
    ];
    for (program, args) in players {
        if Command::new(program).args(args).arg(path).spawn().is_ok() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn beep() {
    if Command::new("/usr/bin/afplay")
        .arg("/System/Library/Sounds/Ping.aiff")
        .spawn()
        .is_err()
    {
        let _ = Command::new("/usr/bin/osascript").args(["-e", "beep"]).spawn();
    }
}

#[cfg(target_os = "windows")]
fn beep() {
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "[console]::beep(880,250)",
        ])
        .spawn();
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn beep() {
    if Command::new("paplay")
        .arg("/usr/share/sounds/freedesktop/stereo/bell.oga")
        .spawn()
        .is_err()
    {
        let _ = Command::new("canberra-gtk-play")
            .args(["-i", "bell"])
            .spawn();
    }
}

/// Alarms already waiting, keyed by clock and deadline, so repeated settings broadcasts
/// during a running countdown arm exactly one thread.
static ARMED: LazyLock<Mutex<Vec<(String, u64)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn armed() -> std::sync::MutexGuard<'static, Vec<(String, u64)>> {
    match ARMED.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Waits for one countdown to reach its deadline, optionally sounding once per second
/// during the configured final seconds, then sounds the completion alarm.
///
/// It runs here rather than in the clock webview so a hidden or minimised clock still
/// alerts. Settings are re-read while waiting, so pausing, resetting or turning the alarm
/// off cancels it and changes to the selected sound/tick window apply immediately.
pub fn arm(app: &AppHandle, clock_id: &str, ends_at: u64, enabled: bool) {
    if !enabled || ends_at <= now_ms() {
        return;
    }

    {
        let mut waiting = armed();
        if waiting
            .iter()
            .any(|(id, deadline)| id == clock_id && *deadline == ends_at)
        {
            return;
        }
        waiting.retain(|(id, _)| id != clock_id);
        waiting.push((clock_id.to_string(), ends_at));
    }

    let handle = app.clone();
    let id = clock_id.to_string();
    std::thread::spawn(move || {
        let mut last_tick = None;
        loop {
            let remaining_ms = ends_at.saturating_sub(now_ms());
            if remaining_ms == 0 {
                break;
            }

            let settings = handle.state::<SettingsState>().snapshot();
            let Some(clock) = settings.clocks.iter().find(|clock| clock.id == id) else {
                break;
            };
            if !clock.countdown_alert || clock.countdown_ends_at != ends_at {
                break;
            }

            let remaining_seconds = remaining_ms.div_ceil(1000) as u32;
            let tick_window = clock.countdown_alert_tick_seconds.min(15) as u64;
            let in_window = tick_window > 0 && remaining_seconds as u64 <= tick_window;
            // `>= 200 ms` keeps a delayed arming from ticking right on top of the final alarm.
            if in_window && remaining_ms >= 200 && last_tick != Some(remaining_seconds) {
                play(&clock.countdown_alert_sound);
                last_tick = Some(remaining_seconds);
            }

            // Poll finely only where a tick can land; otherwise a coarse sleep keeps the
            // wake-ups negligible on a widget that is meant to idle at ~0% CPU.
            let sleep_ms = if in_window {
                remaining_ms.min(100)
            } else if tick_window > 0 {
                remaining_ms
                    .saturating_sub(tick_window * 1000)
                    .saturating_add(50)
                    .min(500)
            } else {
                remaining_ms.min(500)
            };
            std::thread::sleep(Duration::from_millis(sleep_ms.max(20)));
        }

        armed().retain(|(waiting_id, deadline)| !(waiting_id == &id && *deadline == ends_at));

        let settings = handle.state::<SettingsState>().snapshot();
        let clock = settings.clocks.iter().find(|clock| clock.id == id);
        if let Some(clock) = clock {
            if clock.countdown_alert && clock.countdown_ends_at == ends_at {
                play(&clock.countdown_alert_sound);
            }
        }
    });
}

/// Sound list for the panel's picker.
#[tauri::command]
pub fn alert_sounds() -> Vec<AlertSound> {
    list()
}

/// Plays one alert sound; used by the countdown at zero and by the panel's preview.
#[tauri::command]
pub fn play_alert_sound(sound_id: String) {
    play(&sound_id);
}
