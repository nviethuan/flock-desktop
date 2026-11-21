#!/usr/bin/env bash
# Builds Flock for macOS: a release .app bundle plus a .dmg, into
# src-tauri/target/release/bundle/{macos,dmg}.
#
# Usage: scripts/build-macos.sh [extra tauri build args]
#   scripts/build-macos.sh                     # app + dmg
#   scripts/build-macos.sh --bundles app       # app only, faster
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos.sh only runs on macOS (this is $(uname -s))." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "==> Installing npm dependencies"
  npm install
fi

echo "==> Building Flock for $(uname -m) (release)"
npm run tauri -- build "$@"

APP="$ROOT/src-tauri/target/release/bundle/macos/Flock.app"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

echo
if [[ -d "$APP" ]]; then
  echo "App:  $APP"
else
  echo "App:  not found at $APP" >&2
  exit 1
fi

shopt -s nullglob
for dmg in "$DMG_DIR"/*.dmg; do
  # The timestamp shows whether this dmg came from the current build or an older one.
  echo "DMG:  $dmg (modified $(date -r "$dmg" '+%Y-%m-%d %H:%M'))"
done

echo
echo "Install it with scripts/reinstall-macos.sh (or copy the .app to /Applications)."
