#!/usr/bin/env sh
set -eu
WORKSTATION_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORKSTATION_APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
if [ ! -f "$WORKSTATION_SOURCE_DIR/Workstation.desktop" ]; then
  printf '%s\n' 'Build the app first with npm run build.'
  exit 1
fi
install -Dm644 "$WORKSTATION_SOURCE_DIR/Workstation.desktop" "$WORKSTATION_APPLICATIONS_DIR/workstation-desktop.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$WORKSTATION_APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi
printf '%s\n' 'Workstation is now available in your application menu.'
