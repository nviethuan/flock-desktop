# Flock Desktop: Voca Admin Authentication and Personal Todos

This guide is for an implementation agent working in [`nviethuan/flock-desktop`](https://github.com/nviethuan/flock-desktop). It documents the current Voca Admin API contract and the safest integration shape for Flock, including the new delegated-Application path for personal todos.

## 1. Flock project context

The linked project is a Tauri v2 desktop app with a React 19 + TypeScript/Vite frontend and Rust backend. Relevant existing files include:

- `src/SettingsApp.tsx`: the settings window UI.
- `src-tauri/src/lib.rs`: Tauri command registration.
- `src-tauri/src/settings.rs`: persisted clock settings and their Rust commands.
- `src/lib/settings.ts`: frontend mirror of clock settings.
- `src-tauri/tauri.conf.json`: app Content Security Policy.
- `src-tauri/capabilities/default.json`: webview IPC permissions.

Flock currently has no account/session or remote API client. Keep remote Todo/session state separate from the clock settings model and from `settings.json`; do not make cloud availability a prerequisite for the clocks.

## 2. Important authentication distinction

There are two different authentication mechanisms in Voca Admin:

1. **Application authentication** is server-to-server authentication using an API key and secret. Send both as `x-api-key` and `x-api-secret`, or use HTTP Basic with the key as username and secret as password. This authenticates an application principal, not a person.
2. **User authentication** uses `POST /api/auth/login` with a person's username/password. Voca Admin sets `accessToken` and `refreshToken` cookies. The personal Todo handlers identify the owner from the authenticated session username.

### Application credentials can act for one delegated user

An Application may now be linked to a user with `delegateUsn`. When that Application authenticates with `x-api-key` + `x-api-secret`, the Todo handlers scope every read/write to the delegated user's database ID. The Application must also hold the relevant `todos:<action>` policy; RBAC checks the Application's own permissions, not the delegated user's roles.

The delegated user is always explicit:

- No `delegateUsn` means Todo requests return `403`; the server never falls back to a session or to the Application creator (`ownerUsn`).
- The delegated user must exist and remain active. A missing/inactive user returns `403`.
- No request accepts `userId`; the server derives ownership only from the session or the Application's `delegateUsn`.
- Update/delete still filter by both todo ID and the delegated user's ID. An Application cannot touch another user's todos.
- Changing `delegateUsn` takes effect on the next request; no key rotation is required.
- Delegation must be configured with a **user session**, not the Application's own credentials. An actor may bind themselves; binding a different user requires `users:update`. This prevents someone with `applications:create/update` plus `todos:read` from binding an Application to another user just to read that user's todos.
- Create/PATCH/rotate/delete of an Application must use a user session; Application credentials are rejected. PATCH/rotate/delete also require `applications:update` and are limited to the owner (`ownerUsn`) or a user with `users:update`. A non-owner cannot rotate another Application's keys to take over its permissions.

**Still do not embed an Application key or secret in a distributed Flock build.** Flock runs on end-user machines, and any credential shipped in its bundle or persisted in frontend storage can be extracted. The delegated credential grants access to that user's personal todos, so it belongs in a trusted server-side process (secret store, never client code). For a direct desktop client, use the user's login session instead. Do not submit a client-supplied `userId` or treat an Application name as a user.

### Choosing the integration path

- **Direct Flock client:** use the **user login/session cookie flow**. The signed-in user needs RBAC permissions for `todos:read`, `todos:create`, `todos:update`, and/or `todos:delete` for the corresponding operations. The server derives the owner from that session; Flock must never send `userId`.
- **Trusted backend / local companion service:** an operator may create an Application with `delegateUsn` and the needed `todos:*` policies, then keep its key/secret only in that backend's secret store. The backend calls Todo API with the Application credential. A desktop client can call that backend using its own authentication, but the Application secret must not be sent to or stored in the desktop app.

If the product requirement is for Flock itself to hold Application credentials, stop and confirm the security trade-off before implementing. The API supports delegation, but distributing the secret to every install is not a safe design.

## 3. Recommended Flock architecture

Use Rust as the network/session boundary and expose narrow Tauri commands to React. Flock already uses Rust commands as its backend boundary for settings, window management, sounds and file reading.

- Add an isolated Rust API/session module and register only the commands the UI needs (for example: login, logout, list todos, create todo, update todo, delete todo). Keep HTTP, cookie handling and credential-store access in Rust; React receives typed Todo data and safe error results, not raw session tokens.
- Add only the Rust network and operating-system credential-store dependencies needed by the implementation. Flock's current `src-tauri/Cargo.toml` does not include an HTTP client or a keychain crate; inspect current dependency versions and Tauri v2 platform support before selecting them.
- Keep access-token/session handling out of `src-tauri/src/settings.rs` and the clock settings `Settings`/`ClockSettings` types. Never persist auth cookies or passwords through `tauri-plugin-store` in `settings.json`.
- Keep the user's long-lived refresh credential in the operating system credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service/libsecret where available). Keep short-lived access tokens in memory when practical. On logout, call the server logout endpoint and delete the local secure-store entry.
- Reuse a single session-aware HTTP client so cookie updates from login and automatic refresh are retained and concurrent requests do not overwrite a rotated refresh cookie. The server middleware refreshes the session when an access token expires and sets replacement cookies; persist the latest refresh cookie securely. If a refresh is revoked/invalid and the API returns `401`, clear local session state and require login again. Treat `503` as a temporary service failure, not proof that the user should be logged out.
- Use HTTPS for non-loopback API origins. Make the API base URL an explicit environment/build setting or a clearly validated connection setting; never silently send credentials to an arbitrary URL. Do not log passwords, cookie headers, response `Set-Cookie` headers, access tokens, or refresh tokens.
- Avoid direct cross-origin `fetch` from the React webview for session requests unless the API's CORS, cookie `SameSite` and Tauri CSP configuration are deliberately verified. Flock's current CSP allows `connect-src 'self' ipc: http://ipc.localhost`; remote origins are not currently listed. A Rust HTTP client avoids exposing cookies to the webview and avoids depending on browser cross-site cookie behavior. Do not broaden CSP unnecessarily if all remote traffic stays in Rust.

### Suggested UI placement and state

Add a clearly separated “Account / Todos” section to the settings window (`src/SettingsApp.tsx`) rather than putting remote state in the clock list or tray settings. Include login/logout state, loading and retryable error states, and a Todo list with create/edit/complete/reopen/delete actions. Keep the clocks usable while signed out or offline. A failed Todo request must not stop the clock windows or settings from loading.

Use a small typed frontend module for invoking the Todo-related Tauri commands and managing transient UI state. Do not add `todos`, `userId`, cookies, or tokens to the persisted clock snapshot, tray checkmarks, clock windows, or `settings://changed` event.

## 4. Session API

### Login

`POST /api/auth/login` is public and accepts:

```json
{ "username": "<username>", "password": "<password>" }
```

A successful response sets:

- `accessToken`: signed JWT, approximately 2 hours.
- `refreshToken`: httpOnly refresh cookie, approximately 30 days.

The login JSON response is not the session token; the cookies in `Set-Cookie` establish the session. A native Rust client must safely retain/send cookies and capture cookie rotations. Do not return cookie values from a Tauri command to React just to store them in web storage.

Only support the server's existing user/password login unless the server adds and documents another login mechanism. Ask the user for credentials in the app UI; never hardcode them or put them in source. Clear the password field after submission and never log it.

### Logout

`DELETE /api/auth/logout` revokes the refresh-token session in Redis and expires both cookies. Invoke it while the session cookie is available, then remove local refresh-token material even if the remote logout request fails; report the remote failure without leaving secrets in the UI.

### User permissions

A valid session is not sufficient by itself: `/api/todos` is mapped to the independent RBAC resource `todos`. The user's roles must grant the relevant actions. If the API returns `403`, show a permission-specific message; do not retry with an Application key.

## 5. Todo API contract

All four routes require either a user session or a delegated Application credential, plus the matching RBAC permission. IDs are MongoDB ObjectIds serialized as 24-character hexadecimal strings. No route accepts a `userId` field.

| Method   | Endpoint         | Permission     | Purpose                                            |
| -------- | ---------------- | -------------- | -------------------------------------------------- |
| `GET`    | `/api/todos`     | `todos:read`   | List the session user's or delegated user's todos. |
| `POST`   | `/api/todos`     | `todos:create` | Create a todo for the session/delegated user.      |
| `PATCH`  | `/api/todos/:id` | `todos:update` | Edit a todo or change completion state.            |
| `DELETE` | `/api/todos/:id` | `todos:delete` | Delete a todo owned by the session/delegated user. |

### Todo fields and schedule modes

```ts
type TodoScheduleMode = 'none' | 'seconds' | 'hms' | 'at';

interface Todo {
  id: string;
  title: string;
  scheduleMode: TodoScheduleMode;
  durationSeconds: number | null;
  dueAt: string | null; // ISO-8601 datetime, normally UTC
  isCompleted: boolean;
  createdAt?: string;
  updatedAt?: string;
}
```

The persisted record may contain timestamps and server fields in addition to the fields above. Treat `userId` as server-owned and do not expect it in the API response contract.

- `title`: required after trimming, 1–300 characters.
- `scheduleMode`: optional on create (defaults to `none`); values are `none`, `seconds`, `hms`, or `at`.
- `durationSeconds`: optional/null or a positive integer.
- `dueAt`: optional/null ISO datetime. A supplied date must be in the future.
- `none`: send no duration/deadline (omit them or send `null`).
- `seconds`: send positive total seconds **and** a future ISO `dueAt`.
- `hms`: despite the name, the API does **not** parse an `HH:MM:SS` string. Convert it client-side to a positive integer number of seconds and send that as `durationSeconds`, plus a future ISO `dueAt`. Hours may exceed 24; minutes and seconds must be 00–59 if the UI accepts this format.
- `at`: send a future `dueAt` and no duration.

For `seconds` and `hms`, compute `dueAt` as the absolute deadline (`now + durationSeconds`) and serialize with `toISOString()`. The server validates the two values; it does not derive `dueAt` from a duration string. Do not send a placeholder timestamp in a real request.

### List

```http
GET /api/todos
```

Response:

```json
{
  "data": [
    {
      "id": "0123456789abcdef01234567",
      "title": "Review release",
      "scheduleMode": "none",
      "durationSeconds": null,
      "dueAt": null,
      "isCompleted": false
    }
  ]
}
```

The server sorts incomplete items first, then by `dueAt`, then newest creation time. Preserve the server order unless Flock explicitly offers its own sort control.

### Create

```http
POST /api/todos
Content-Type: application/json

{"title":"Review release","scheduleMode":"none"}
```

For a timed todo:

```json
{
  "title": "Study",
  "scheduleMode": "hms",
  "durationSeconds": 5400,
  "dueAt": "<now plus 90 minutes, ISO-8601 UTC>"
}
```

The server derives `userId` from the authenticated user session, or from the Application's explicit `delegateUsn` when Application credentials are used.

### Update content/schedule

For an edit, send the full content/schedule payload including `title`; this is not a title-only partial update:

```http
PATCH /api/todos/0123456789abcdef01234567
Content-Type: application/json

{"title":"Review and publish release","scheduleMode":"none"}
```

Include the relevant `durationSeconds` and `dueAt` fields for timed modes. Do not include `userId`.

### Complete/reopen

Completion has a separate minimal PATCH shape:

```http
PATCH /api/todos/0123456789abcdef01234567
Content-Type: application/json

{"isCompleted":true}
```

Use `false` to reopen. Do not combine this minimal shape with other update fields unless the server contract is deliberately extended.

### Delete

```http
DELETE /api/todos/0123456789abcdef01234567
```

Success response:

```json
{ "id": "0123456789abcdef01234567", "success": true }
```

The server filters update/delete by both the requested todo ID and the current user's database ID (session user or delegated Application user). A todo belonging to someone else is not accessible; do not build “switch user” or owner selection into the desktop UI.

## 6. Error handling

- `400`: malformed ID/body, invalid schedule values, or a deadline that is not in the future. Show a useful validation message and preserve the user's form values.
- `401`: no session or an invalid/revoked session (when no Application credential is supplied). Clear the session only when it is actually invalid/revoked; network/temporary service failures are not logout.
- `403`: the Application has no `delegateUsn`, the delegated user is missing/inactive, the caller lacks the relevant `todos:<action>` permission, or an attempt was made to bind another user's delegation without `users:update`/with Application credentials; an Application PATCH/rotate/delete was attempted by a non-owner without `users:update`. Explain which condition applies where possible; do not loop/retry.
- `404`: todo not found for this user. This also protects against access to another user's todo.
- `503`: refresh/session infrastructure temporarily unavailable. Keep local secure refresh state for a later retry and offer retry; do not discard it as if it were revoked.

Never display raw response headers or credential material. Avoid optimistic mutations unless rollback on failure is implemented; a simple reload after a successful mutation is acceptable.

## 7. RBAC setup in Voca Admin

The resource and CRUD action policies are seeded by:

```bash
npm run db:seed:rbac
```

This creates `todos:read`, `todos:create`, `todos:update`, and `todos:delete` policies and includes them in the seeded Admin role according to the current seed script. For non-Admin users, grant only the needed Todo policies through their roles.

For a trusted server-side Application, grant the needed `todos:*` policies directly to the Application and set its `delegateUsn` to the target user through `POST /api/applications` or `PATCH /api/applications/:id`. Configure delegation from a user session: binding another user requires `users:update`, an Application credential cannot set or change delegation itself, and PATCH/rotate/delete require the Application owner or `users:update`. Application permissions are independent from the user's roles: the Application needs its own Todo policy and an explicit delegated user.

## 8. Implementation acceptance checklist

Before considering the Flock integration complete, verify all of the following in the Flock repository:

1. Signed-out app still starts and every clock/tray feature works offline.
2. A user can log in; credentials and cookies never appear in frontend storage, `settings.json`, logs, crash reports or source/bundle.
3. Restart behavior uses the OS secure credential store for the refresh cookie; logout revokes remotely and clears local secrets.
4. The correct user sees only their own todos; no request includes `userId`. With Application delegation, changing `delegateUsn` changes the visible todo set on the next request.
5. List/create/edit/complete/reopen/delete map to the methods, payloads and RBAC permissions in this document.
6. Both `none` and all supported timing modes work; `hms` is converted to integer seconds and absolute ISO `dueAt`.
7. Signed-out, forbidden (including missing/inactive delegated user), invalid-input, not-found, offline and temporary `503` states are handled without breaking clock settings.
8. No Application key/secret is embedded in Flock. Delegated Application credentials are used only by a trusted backend that stores them securely; a direct desktop client uses the user session flow.
9. Run the project's existing TypeScript/Vite build and the relevant Rust/Tauri build/checks after changes. Manually verify login, refresh, logout, and the Todo CRUD flow against a non-production API/user; do not use production data for test mutations.
