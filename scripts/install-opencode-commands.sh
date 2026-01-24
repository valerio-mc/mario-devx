#!/usr/bin/env bash
set -euo pipefail

DEST_DIR="${OPENCODE_COMMANDS_DIR:-$HOME/.config/opencode/commands}"
mkdir -p "$DEST_DIR"

cp -f "commands/mario-init.md" "$DEST_DIR/mario-init.md"

echo "Installed: $DEST_DIR/mario-init.md"
