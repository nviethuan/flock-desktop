#!/usr/bin/env bash
# Rebuilds Flock and replaces the installed app, then launches it again.
#
# Usage: scripts/reinstall-macos.sh [--no-build]
#   scripts/reinstall-macos.sh             # build, quit, replace, relaunch
#   scripts/reinstall-macos.sh --no-build  # reinstall the last build as-is
#
# The app goes to /Applications (the usual place). If that folder is not writable
# by your user, it falls back to ~/Applications instead of asking for sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Flock"
SOURCE_APP="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DO_BUILD=true

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=false ;;
    -h|--help)
      echo "Usage: scripts/reinstall-macos.sh [--no-build]"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: scripts/reinstall-macos.sh [--no-build]" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "reinstall-macos.sh only runs on macOS (this is $(uname -s))." >&2
  exit 1
fi

if [[ "$DO_BUILD" == true ]]; then
  "$ROOT/scripts/build-macos.sh"
fi

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "No build at $SOURCE_APP." >&2
  echo "Run scripts/build-macos.sh first, or drop --no-build." >&2
  exit 1
fi

if [[ -w /Applications ]]; then
  TARGET_DIR="/Applications"
else
  TARGET_DIR="$HOME/Applications"
  mkdir -p "$TARGET_DIR"
  echo "==> /Applications is not writable for you; installing to $TARGET_DIR"
fi
TARGET_APP="$TARGET_DIR/$APP_NAME.app"

# Quit gracefully first (the panel and the tray both use this path), so the clock
# positions, the pinned todo and the settings are persisted on the way out.
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "==> Quitting the running $APP_NAME"
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
    sleep 0.25
  done
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    # A stale instance would keep the old bundle's files in use.
    pkill -x "$APP_NAME" 2>/dev/null || true
    for _ in $(seq 1 20); do
      pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
      sleep 0.25
    done
  fi
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    echo "$APP_NAME is still running. Quit it from the tray (Quit Flock) and retry." >&2
    exit 1
  fi
fi

echo "==> Installing $TARGET_APP"
rm -rf "$TARGET_APP"
# ditto keeps the bundle's structure, permissions and symlinks intact.
ditto "$SOURCE_APP" "$TARGET_APP"

# Local builds are unsigned; clear any quarantine flag so Gatekeeper does not block it.
xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true

echo "==> Launching $APP_NAME"
open -a "$TARGET_APP"

echo "Done: $TARGET_APP"
