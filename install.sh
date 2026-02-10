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
rm -rf .opencode/plugins/mario-devx
rm -f .opencode/plugins/mario-devx.ts
cp -R "$tmpdir/.opencode/plugins/mario-devx" .opencode/plugins/mario-devx
cp "$tmpdir/.opencode/plugins/mario-devx.ts" .opencode/plugins/mario-devx.ts

# Merge .opencode/package.json dependencies without clobbering existing config
src_pkg="$tmpdir/.opencode/package.json"
dst_pkg=".opencode/package.json"
if [ -f "$dst_pkg" ]; then
    SRC_PKG="$src_pkg" DST_PKG="$dst_pkg" node <<'NODE'
const fs = require("fs");

const srcPath = process.env.SRC_PKG;
const dstPath = process.env.DST_PKG;

const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const dst = JSON.parse(fs.readFileSync(dstPath, "utf8"));

dst.dependencies = {
  ...(dst.dependencies || {}),
  ...(src.dependencies || {}),
};

if (!dst.type && src.type) {
  dst.type = src.type;
}

fs.writeFileSync(dstPath, `${JSON.stringify(dst, null, 2)}\n`, "utf8");
NODE
else
    cp "$src_pkg" "$dst_pkg"
fi

# Cleanup
rm -rf "$tmpdir"

echo "✅ Mario DevX installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Run: opencode ."
echo "  2. In OpenCode, run: /mario-devx:new your project idea"
