#!/bin/bash
# Mario DevX Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/valerio-mc/mario-devx/main/install.sh | bash

set -e

echo "Installing Mario DevX..."

# Check if we're in a git repo
if [ ! -d ".git" ]; then
    echo "Error: Not a git repository. Run 'git init' first."
    exit 1
fi

# Create .opencode directory
mkdir -p .opencode/plugins

# Clone the plugin
tmpdir=$(mktemp -d)
git clone --depth 1 https://github.com/valerio-mc/mario-devx.git "$tmpdir" 2>/dev/null || {
    echo "Error: Failed to clone repository"
    rm -rf "$tmpdir"
    exit 1
}

# Copy plugin files
cp -R "$tmpdir/.opencode/plugins/mario-devx" .opencode/plugins/
cp "$tmpdir/.opencode/plugins/mario-devx.ts" .opencode/plugins/
cp "$tmpdir/.opencode/package.json" .opencode/
cp "$tmpdir/.opencode/tsconfig.json" .opencode/

# Cleanup
rm -rf "$tmpdir"

echo "✅ Mario DevX installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Run: opencode ."
echo "  2. In OpenCode, run: /mario-devx:new your project idea"
