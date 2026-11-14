//! Personal todos from the Voca Admin API.
//!
//! This module is deliberately separate from `settings.rs`: clock settings are a local,
//! offline-first model, while todos are remote state that must never make the clocks fail.
//!
//! - Non-secret connection data and the pinned widget live in `todos.json`.
//! - The API key and secret live in the OS credential store (macOS Keychain, Windows
//!   Credential Manager, Linux Secret Service) and are never written to disk by Flock.
//! - HTTP happens in Rust, so the webview never sees credentials and the CSP stays closed.
//!
//! The API is authenticated as an Application (`x-api-key` + `x-api-secret`) with an
//! explicit `delegateUsn` on the server; ownership is always derived server-side and no
//! request carries a user id. See `docs/flock-desktop-todos-integration.md`.

use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use chrono::{DateTime, SecondsFormat, Utc};
use keyring::Entry;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_store::StoreExt;

use crate::settings::SettingsState;
use crate::win;

/// Connection config plus the pinned widget. Separate from `settings.json` on purpose.
pub const CONFIG_FILE: &str = "todos.json";
const CONFIG_KEY: &str = "todos";

pub const DEFAULT_API_URL: &str = "https://www.huannguyen.blog/api/todos";

/// Sent whenever the connection, the list or the widget changes.
pub const TODOS_CHANGED: &str = "todos://changed";

/// Window label of the pinned-todo widget.
pub const TODO_WIDGET: &str = "todo";

const KEYRING_SERVICE: &str = "com.flock.clock.todos";
const KEYRING_KEY: &str = "api-key";
const KEYRING_SECRET: &str = "api-secret";

const WIDGET_WIDTH: f64 = 360.0;
const WIDGET_HEIGHT: f64 = 172.0;
const WIDGET_BOUNDS_PERSIST_INTERVAL: Duration = Duration::from_millis(900);

const MAX_TITLE_CHARS: usize = 300;
const MAX_DURATION_SECONDS: i64 = 31_536_000;
const DEFAULT_WIDGET_COLOR: &str = "#f3f7ff";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoError {
    /// HTTP status, or 0 for local validation/transport failures.
    pub status: u16,
    pub message: String,
}

impl TodoError {
    fn local(message: impl Into<String>) -> Self {
        Self {
            status: 0,
            message: message.into(),
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: 401,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Todo {
    pub id: String,
    pub title: String,
    /// `none`, `seconds`, `hms` or `at`.
    pub schedule_mode: String,
    pub duration_seconds: Option<i64>,
    /// ISO-8601 deadline, normally UTC.
    pub due_at: Option<String>,
    pub is_completed: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for Todo {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            schedule_mode: "none".to_string(),
            duration_seconds: None,
            due_at: None,
            is_completed: false,
            created_at: None,
            updated_at: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoInput {
    pub title: String,
    pub schedule_mode: Option<String>,
    pub duration_seconds: Option<i64>,
    pub due_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoWidgetSettings {
    pub todo_id: String,
    /// Physical screen position; `None` centres the widget on first pin.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// `#rrggbb` for the countdown and its glow.
    pub color: String,
    pub neon: bool,
    pub backdrop: bool,
}

impl Default for TodoWidgetSettings {
    fn default() -> Self {
        Self {
            todo_id: String::new(),
            x: None,
            y: None,
            color: DEFAULT_WIDGET_COLOR.to_string(),
            neon: true,
            backdrop: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoConfig {
    pub api_url: String,
    /// Last four characters of the saved key, for display only.
    pub key_hint: String,
    /// Whether a key/secret pair is expected in the OS credential store.
    pub has_credentials: bool,
    pub widget: Option<TodoWidgetSettings>,
}

impl Default for TodoConfig {
    fn default() -> Self {
        Self {
            api_url: DEFAULT_API_URL.to_string(),
            key_hint: String::new(),
            has_credentials: false,
            widget: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodosSnapshot {
    pub config: TodoConfig,
    pub todos: Vec<Todo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoConfigPatch {
    pub api_url: Option<String>,
    /// Key id and secret are written together, and never echoed back.
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    pub clear_credentials: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoWidgetPatch {
    pub color: Option<String>,
    pub neon: Option<bool>,
    pub backdrop: Option<bool>,
}

struct Credentials {
    key: String,
    secret: String,
}

pub struct TodosState {
    config: Mutex<TodoConfig>,
    todos: Mutex<Vec<Todo>>,
    credentials: Mutex<Option<Credentials>>,
    last_persist: Mutex<Instant>,
}

impl TodosState {
    pub fn new(config: TodoConfig) -> Self {
        Self {
            config: Mutex::new(config),
            todos: Mutex::new(Vec::new()),
            credentials: Mutex::new(None),
            last_persist: Mutex::new(Instant::now()),
        }
    }

    pub fn snapshot(&self) -> TodosSnapshot {
        TodosSnapshot {
            config: self.config(),
            todos: self.list(),
        }
    }

    pub fn config_snapshot(&self) -> TodoConfig {
        self.config()
    }

    fn config(&self) -> TodoConfig {
        match self.config.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn list(&self) -> Vec<Todo> {
        match self.todos.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn edit_config<F: FnOnce(&mut TodoConfig)>(&self, edit: F) -> TodoConfig {
        let mut guard = match self.config.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        edit(&mut guard);
        normalize(&mut guard);
        guard.clone()
    }

    fn edit_todos<F: FnOnce(&mut Vec<Todo>)>(&self, edit: F) {
        let mut guard = match self.todos.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        edit(&mut guard);
    }

    fn cached_credentials(&self) -> Option<(String, String)> {
        let guard = match self.credentials.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .as_ref()
            .map(|credentials| (credentials.key.clone(), credentials.secret.clone()))
    }

    fn set_credentials(&self, credentials: Option<Credentials>) {
        let mut guard = match self.credentials.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = credentials;
    }

    fn should_persist(&self) -> bool {
        let mut last = match self.last_persist.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if last.elapsed() < WIDGET_BOUNDS_PERSIST_INTERVAL {
            return false;
        }
        *last = Instant::now();
        true
    }
}

pub fn load(app: &AppHandle) -> TodoConfig {
    let Ok(store) = app.store(CONFIG_FILE) else {
        eprintln!("flock: could not open the todos config, using defaults");
        return TodoConfig::default();
    };
    let Some(value) = store.get(CONFIG_KEY) else {
        return TodoConfig::default();
    };
    let mut config: TodoConfig = match serde_json::from_value(value) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("flock: ignoring unreadable todos config: {error}");
            TodoConfig::default()
        }
    };
    normalize(&mut config);
    config
}

fn normalize(config: &mut TodoConfig) {
    if normalize_api_url(&config.api_url).is_err() {
        config.api_url = DEFAULT_API_URL.to_string();
    }
    config.key_hint = config.key_hint.trim().to_string();
    if config.key_hint.chars().count() > 16 {
        config.key_hint = config.key_hint.chars().take(16).collect();
    }
    if !config.has_credentials {
        config.key_hint.clear();
    }
    if let Some(widget) = &mut config.widget {
        widget.color = widget.color.trim().to_ascii_lowercase();
        if !is_hex_color(&widget.color) {
            widget.color = DEFAULT_WIDGET_COLOR.to_string();
        }
        widget.todo_id = widget.todo_id.trim().to_string();
        if widget.todo_id.is_empty() {
            config.widget = None;
        }
    }
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

pub fn persist(app: &AppHandle, config: &TodoConfig) {
    let store = match app.store(CONFIG_FILE) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("flock: could not open the todos config: {error}");
            return;
        }
    };
    match serde_json::to_value(config) {
        Ok(value) => store.set(CONFIG_KEY, value),
        Err(error) => {
            eprintln!("flock: could not serialize the todos config: {error}");
            return;
        }
    }
    if let Err(error) = store.save() {
        eprintln!("flock: could not save the todos config: {error}");
    }
}

fn broadcast(app: &AppHandle) {
    let snapshot = app.state::<TodosState>().snapshot();
    let _ = app.emit(TODOS_CHANGED, snapshot);
}

fn normalize_api_url(raw: &str) -> Result<String, TodoError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(TodoError::validation("The API URL cannot be empty."));
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|error| TodoError::validation(format!("That is not a valid URL: {error}")))?;
    let is_loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_loopback) {
        return Err(TodoError::validation(
            "Use an https:// URL (http:// is only accepted for localhost during development).",
        ));
    }
    if parsed.host_str().is_none() {
        return Err(TodoError::validation("The API URL needs a host."));
    }
    Ok(trimmed.to_string())
}

fn valid_todo_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn client() -> Result<&'static Client, TodoError> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Flock Desktop")
            .build()
            .map_err(|error| error.to_string())
    }) {
        Ok(client) => Ok(client),
        Err(error) => Err(TodoError::local(format!(
            "Could not create the HTTP client: {error}"
        ))),
    }
}

fn keyring_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

fn read_credentials() -> Result<Credentials, String> {
    let key_entry = keyring_entry(KEYRING_KEY)?;
    let secret_entry = keyring_entry(KEYRING_SECRET)?;
    let key = key_entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => "no API key is saved".to_string(),
        other => other.to_string(),
    })?;
    let secret = secret_entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => "no API secret is saved".to_string(),
        other => other.to_string(),
    })?;
    Ok(Credentials { key, secret })
}

fn write_credentials(key: &str, secret: &str) -> Result<(), String> {
    let key_entry = keyring_entry(KEYRING_KEY)?;
    let secret_entry = keyring_entry(KEYRING_SECRET)?;
    secret_entry
        .set_password(secret)
        .map_err(|error| error.to_string())?;
    if let Err(error) = key_entry.set_password(key) {
        // Never leave half a credential pair behind.
        let _ = secret_entry.delete_credential();
        return Err(error.to_string());
    }
    Ok(())
}

fn clear_credentials() {
    if let Ok(entry) = keyring_entry(KEYRING_KEY) {
        let _ = entry.delete_credential();
    }
    if let Ok(entry) = keyring_entry(KEYRING_SECRET) {
        let _ = entry.delete_credential();
    }
}

async fn credentials(app: &AppHandle) -> Result<(String, String), TodoError> {
    let state = app.state::<TodosState>();
    if let Some(cached) = state.cached_credentials() {
        return Ok(cached);
    }
    if !state.config().has_credentials {
        return Err(TodoError::unauthorized(
            "No API credentials are saved. Add the API key and secret under Settings → Todos.",
        ));
    }

    let result = tauri::async_runtime::spawn_blocking(read_credentials)
        .await
        .map_err(|error| {
            TodoError::local(format!("Could not read the saved credentials: {error}"))
        })?;

    match result {
        Ok(credentials) => {
            let pair = (credentials.key.clone(), credentials.secret.clone());
            state.set_credentials(Some(credentials));
            Ok(pair)
        }
        Err(error) => Err(TodoError::local(format!(
            "Could not read the API credentials from the OS credential store: {error}"
        ))),
    }
}

fn describe_response(status: u16, value: &Value) -> TodoError {
    let detail = ["message", "error", "detail"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string);

    let message = match status {
        400 => detail.unwrap_or_else(|| {
            "The API rejected the todo. Check the title, the duration and that the deadline is in the future.".to_string()
        }),
        401 => "The API did not accept the saved credentials (401). Check the API key and secret.".to_string(),
        403 => "This Application is not allowed to read or change todos (403). It needs the todos:* policies and an explicit delegated user (delegateUsn) on the server.".to_string(),
        404 => "That todo no longer exists for this user (404).".to_string(),
        503 => "The todos service is temporarily unavailable (503). Try again in a moment.".to_string(),
        _ => match detail {
            Some(detail) => format!("The todos API answered {status}: {detail}"),
            None => format!("The todos API answered {status}."),
        },
    };
    TodoError { status, message }
}

async fn request(
    url: &str,
    method: Method,
    body: Option<Value>,
    key: &str,
    secret: &str,
) -> Result<Value, TodoError> {
    let mut call = client()?
        .request(method, url)
        .header("accept", "application/json")
        .header("x-api-key", key)
        .header("x-api-secret", secret);
    if let Some(body) = body {
        call = call.json(&body);
    }

    let response = call.send().await.map_err(|error| {
        let detail = if error.is_timeout() {
            "the request timed out"
        } else if error.is_connect() {
            "the server could not be reached"
        } else {
            "the request failed"
        };
        TodoError::local(format!("Could not reach the todos API: {detail}."))
    })?;

    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    if !(200..300).contains(&status) {
        return Err(describe_response(status, &value));
    }
    Ok(value)
}

fn parse_list(value: &Value) -> Result<Vec<Todo>, TodoError> {
    let items = match value.get("data") {
        Some(Value::Array(items)) => items,
        _ => match value.as_array() {
            Some(items) => items,
            None => {
                return Err(TodoError::local(
                    "The todos API returned an unexpected response shape.",
                ))
            }
        },
    };
    Ok(items
        .iter()
        .filter_map(|item| serde_json::from_value::<Todo>(item.clone()).ok())
        .collect())
}

/// The create/update routes are not documented with a body, so accept either a wrapped
/// object or a bare one; `None` means the next list request is the source of truth.
fn single_todo(value: &Value) -> Option<Todo> {
    let candidate = value.get("data").unwrap_or(value);
    serde_json::from_value::<Todo>(candidate.clone())
        .ok()
        .filter(|todo| !todo.id.is_empty())
}

fn validate_title(raw: &str) -> Result<String, TodoError> {
    let title = raw.trim();
    let length = title.chars().count();
    if length == 0 {
        return Err(TodoError::validation("A todo needs a title."));
    }
    if length > MAX_TITLE_CHARS {
        return Err(TodoError::validation(format!(
            "The title is limited to {MAX_TITLE_CHARS} characters."
        )));
    }
    Ok(title.to_string())
}

fn future_due_at(raw: Option<&str>) -> Result<String, TodoError> {
    let raw = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| TodoError::validation("Pick a deadline for this schedule."))?;
    let parsed = DateTime::parse_from_rfc3339(raw)
        .map_err(|_| TodoError::validation("The deadline must be an ISO-8601 date and time."))?;
    if parsed <= Utc::now() {
        return Err(TodoError::validation("The deadline must be in the future."));
    }
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Maps the panel's input onto the exact payload shape the API expects; `hms` becomes
/// integer seconds plus an absolute ISO deadline, as the server does not parse `HH:MM:SS`.
fn build_payload(input: &TodoInput) -> Result<Value, TodoError> {
    let title = validate_title(&input.title)?;
    let mode = input
        .schedule_mode
        .as_deref()
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();

    let payload = match mode.as_str() {
        "none" => json!({
            "title": title,
            "scheduleMode": "none",
            "durationSeconds": Value::Null,
            "dueAt": Value::Null,
        }),
        "seconds" | "hms" => {
            let duration = input
                .duration_seconds
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    TodoError::validation("A timed todo needs a duration greater than zero.")
                })?;
            if duration > MAX_DURATION_SECONDS {
                return Err(TodoError::validation("That duration is too long."));
            }
            let due_at = future_due_at(input.due_at.as_deref())?;
            json!({
                "title": title,
                "scheduleMode": mode,
                "durationSeconds": duration,
                "dueAt": due_at,
            })
        }
        "at" => {
            let due_at = future_due_at(input.due_at.as_deref())?;
            json!({
                "title": title,
                "scheduleMode": "at",
                "durationSeconds": Value::Null,
                "dueAt": due_at,
            })
        }
        other => {
            return Err(TodoError::validation(format!(
                "Unknown schedule mode: {other}"
            )))
        }
    };
    Ok(payload)
}

async fn refresh(app: &AppHandle) -> Result<(), TodoError> {
    let config = app.state::<TodosState>().config();
    let (key, secret) = credentials(app).await?;
    let value = request(&config.api_url, Method::GET, None, &key, &secret).await?;
    let todos = parse_list(&value)?;
    app.state::<TodosState>().edit_todos(|list| *list = todos);
    broadcast(app);
    Ok(())
}

/// After a successful mutation: reconcile from the server, but keep the local change if
/// the follow-up list request fails (offline flakiness must not look like a failed write).
async fn resync(app: &AppHandle) {
    if let Err(error) = refresh(app).await {
        eprintln!("flock: todo refresh failed: {}", error.message);
    }
}

#[tauri::command]
pub fn todos_snapshot(state: tauri::State<'_, TodosState>) -> TodosSnapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn todos_set_config(
    app: AppHandle,
    patch: TodoConfigPatch,
) -> Result<TodosSnapshot, TodoError> {
    let state = app.state::<TodosState>();

    // Validate everything before touching the keychain or the saved config, so a rejected
    // input cannot leave half-applied credentials behind.
    let api_url = match patch.api_url {
        Some(url) => Some(normalize_api_url(&url)?),
        None => None,
    };
    let key = patch.api_key.unwrap_or_default().trim().to_string();
    let secret = patch.api_secret.unwrap_or_default().trim().to_string();
    if !key.is_empty() || !secret.is_empty() {
        if key.is_empty() || secret.is_empty() {
            return Err(TodoError::validation(
                "The API key and the API secret have to be saved together.",
            ));
        }
    }

    if patch.clear_credentials {
        clear_credentials();
        state.set_credentials(None);
        state.edit_config(|config| {
            config.has_credentials = false;
            config.key_hint.clear();
        });
        // Disconnecting also takes the personal data off the desktop.
        state.edit_todos(|list| list.clear());
        if let Some(window) = app.get_webview_window(TODO_WIDGET) {
            let _ = window.destroy();
        }
        state.edit_config(|config| config.widget = None);
    }

    if let Some(url) = api_url {
        state.edit_config(|config| config.api_url = url);
    }

    if !key.is_empty() {
        let hint = format!(
            "…{}",
            key.chars()
                .rev()
                .take(4)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        );
        let save_key = key.clone();
        let save_secret = secret.clone();
        tauri::async_runtime::spawn_blocking(move || write_credentials(&save_key, &save_secret))
            .await
            .map_err(|error| {
                TodoError::local(format!("Could not save the API credentials: {error}"))
            })?
            .map_err(|error| {
                TodoError::local(format!(
                    "Could not save the API credentials in the OS credential store: {error}"
                ))
            })?;
        state.set_credentials(Some(Credentials { key, secret }));
        state.edit_config(|config| {
            config.has_credentials = true;
            config.key_hint = hint;
        });
        // A new identity can have a different list; never show the previous user's rows.
        state.edit_todos(|list| list.clear());
    }

    let config = state.config();
    persist(&app, &config);
    broadcast(&app);
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn todos_refresh(app: AppHandle) -> Result<TodosSnapshot, TodoError> {
    refresh(&app).await?;
    Ok(app.state::<TodosState>().snapshot())
}

#[tauri::command]
pub async fn todos_create(app: AppHandle, input: TodoInput) -> Result<TodosSnapshot, TodoError> {
    let config = app.state::<TodosState>().config();
    let (key, secret) = credentials(&app).await?;
    let payload = build_payload(&input)?;

    let value = request(&config.api_url, Method::POST, Some(payload), &key, &secret).await?;
    if let Some(todo) = single_todo(&value) {
        let created = todo;
        app.state::<TodosState>().edit_todos(|list| {
            if !list.iter().any(|todo| todo.id == created.id) {
                list.push(created);
            }
        });
        broadcast(&app);
    }
    resync(&app).await;
    Ok(app.state::<TodosState>().snapshot())
}

#[tauri::command]
pub async fn todos_update(
    app: AppHandle,
    id: String,
    input: TodoInput,
) -> Result<TodosSnapshot, TodoError> {
    if !valid_todo_id(&id) {
        return Err(TodoError::validation("That todo id is not valid."));
    }
    let config = app.state::<TodosState>().config();
    let (key, secret) = credentials(&app).await?;
    let payload = build_payload(&input)?;

    let url = format!("{}/{}", config.api_url, id);
    let value = request(&url, Method::PATCH, Some(payload), &key, &secret).await?;
    if let Some(updated) = single_todo(&value) {
        app.state::<TodosState>().edit_todos(|list| {
            if let Some(existing) = list.iter_mut().find(|todo| todo.id == updated.id) {
                *existing = updated;
            }
        });
        broadcast(&app);
    }
    resync(&app).await;
    Ok(app.state::<TodosState>().snapshot())
}

#[tauri::command]
pub async fn todos_set_completed(
    app: AppHandle,
    id: String,
    is_completed: bool,
) -> Result<TodosSnapshot, TodoError> {
    if !valid_todo_id(&id) {
        return Err(TodoError::validation("That todo id is not valid."));
    }
    let config = app.state::<TodosState>().config();
    let (key, secret) = credentials(&app).await?;

    let url = format!("{}/{}", config.api_url, id);
    let payload = json!({ "isCompleted": is_completed });
    let value = request(&url, Method::PATCH, Some(payload), &key, &secret).await?;

    let returned = single_todo(&value);
    app.state::<TodosState>().edit_todos(|list| {
        if let Some(todo) = list.iter_mut().find(|todo| todo.id == id) {
            match &returned {
                Some(updated) => *todo = updated.clone(),
                None => todo.is_completed = is_completed,
            }
        }
    });
    broadcast(&app);
    resync(&app).await;
    Ok(app.state::<TodosState>().snapshot())
}

#[tauri::command]
pub async fn todos_delete(app: AppHandle, id: String) -> Result<TodosSnapshot, TodoError> {
    if !valid_todo_id(&id) {
        return Err(TodoError::validation("That todo id is not valid."));
    }
    let config = app.state::<TodosState>().config();
    let (key, secret) = credentials(&app).await?;

    let url = format!("{}/{}", config.api_url, id);
    request(&url, Method::DELETE, None, &key, &secret).await?;

    app.state::<TodosState>()
        .edit_todos(|list| list.retain(|todo| todo.id != id));
    // A deleted todo cannot be the pinned one.
    let pinned_gone = app
        .state::<TodosState>()
        .config()
        .widget
        .is_some_and(|widget| widget.todo_id == id);
    if pinned_gone {
        if let Some(window) = app.get_webview_window(TODO_WIDGET) {
            let _ = window.destroy();
        }
        app.state::<TodosState>()
            .edit_config(|config| config.widget = None);
        persist(&app, &app.state::<TodosState>().config());
    }
    broadcast(&app);
    resync(&app).await;
    Ok(app.state::<TodosState>().snapshot())
}

#[tauri::command]
pub fn todo_widget_pin(app: AppHandle, todo_id: String) -> Result<TodosSnapshot, TodoError> {
    let state = app.state::<TodosState>();
    if !state.list().iter().any(|todo| todo.id == todo_id) {
        return Err(TodoError::not_found(
            "That todo is not in the list yet. Refresh the todos first.",
        ));
    }

    let previous = state.config().widget;
    let widget = previous
        .clone()
        .map(|mut widget| {
            widget.todo_id = todo_id.clone();
            widget
        })
        .unwrap_or_else(|| TodoWidgetSettings {
            todo_id: todo_id.clone(),
            ..TodoWidgetSettings::default()
        });
    state.edit_config(|config| config.widget = Some(widget.clone()));
    persist(&app, &state.config());

    if app.get_webview_window(TODO_WIDGET).is_none() {
        if let Err(error) = create_widget_window(&app, &widget) {
            state.edit_config(|config| config.widget = previous);
            persist(&app, &state.config());
            return Err(TodoError::local(format!(
                "Could not open the todo widget: {error}"
            )));
        }
    } else if let Some(window) = app.get_webview_window(TODO_WIDGET) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    broadcast(&app);
    Ok(state.snapshot())
}

#[tauri::command]
pub fn todo_widget_unpin(app: AppHandle) -> TodosSnapshot {
    if let Some(window) = app.get_webview_window(TODO_WIDGET) {
        let _ = window.destroy();
    }
    let state = app.state::<TodosState>();
    state.edit_config(|config| config.widget = None);
    persist(&app, &state.config());
    broadcast(&app);
    state.snapshot()
}

#[tauri::command]
pub fn todo_widget_style(
    app: AppHandle,
    patch: TodoWidgetPatch,
) -> Result<TodosSnapshot, TodoError> {
    let state = app.state::<TodosState>();
    if state.config().widget.is_none() {
        return Err(TodoError::not_found("No todo widget is pinned."));
    }
    if let Some(color) = &patch.color {
        let color = color.trim().to_ascii_lowercase();
        if !is_hex_color(&color) {
            return Err(TodoError::validation("That is not a valid hex colour."));
        }
    }
    state.edit_config(|config| {
        if let Some(widget) = &mut config.widget {
            if let Some(color) = &patch.color {
                widget.color = color.trim().to_ascii_lowercase();
            }
            if let Some(neon) = patch.neon {
                widget.neon = neon;
            }
            if let Some(backdrop) = patch.backdrop {
                widget.backdrop = backdrop;
            }
        }
    });
    persist(&app, &state.config());
    broadcast(&app);
    Ok(state.snapshot())
}

/// Re-creates the widget on launch when one was pinned, so it is part of the desktop again.
pub fn restore_widget(app: &AppHandle) -> tauri::Result<()> {
    let config = app.state::<TodosState>().config();
    let Some(widget) = config.widget else {
        return Ok(());
    };
    if app.get_webview_window(TODO_WIDGET).is_some() {
        return Ok(());
    }
    create_widget_window(app, &widget)?;
    Ok(())
}

fn create_widget_window(
    app: &AppHandle,
    widget: &TodoWidgetSettings,
) -> tauri::Result<WebviewWindow> {
    let settings = app.state::<SettingsState>().snapshot();
    let mut builder =
        WebviewWindowBuilder::new(app, TODO_WIDGET, WebviewUrl::App("index.html".into()))
            .title("Flock Todo")
            .inner_size(WIDGET_WIDTH, WIDGET_HEIGHT)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .always_on_top(settings.always_on_top)
            .visible(false)
            .focused(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder.accept_first_mouse(true);
    }

    let window = builder.build()?;

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.set_visible_on_all_workspaces(true);
    }
    let _ = window.set_ignore_cursor_events(settings.click_through);

    place_widget(&window, widget);
    install_widget_handlers(&window);
    window.show()?;
    Ok(window)
}

fn place_widget(window: &WebviewWindow, widget: &TodoWidgetSettings) {
    if let (Some(x), Some(y)) = (widget.x, widget.y) {
        if win::is_on_screen(window, x, y) {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            return;
        }
    }
    let _ = window.center();
}

fn install_widget_handlers(window: &WebviewWindow) {
    let target = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => record_widget_bounds(&target),
        WindowEvent::CloseRequested { api, .. } => {
            // Closing hides the widget; unpinning removes it for good.
            api.prevent_close();
            let _ = target.hide();
        }
        _ => {}
    });
}

fn record_widget_bounds(window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let app = window.app_handle();
    let state = app.state::<TodosState>();
    let Some(widget) = state.config().widget else {
        return;
    };
    if widget.x == Some(position.x) && widget.y == Some(position.y) {
        return;
    }
    state.edit_config(|config| {
        if let Some(widget) = &mut config.widget {
            widget.x = Some(position.x);
            widget.y = Some(position.y);
        }
    });
    if state.should_persist() {
        persist(app, &state.config());
    }
}
