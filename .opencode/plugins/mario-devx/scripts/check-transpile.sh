#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="/tmp/mario-devx-transpile-check"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for file in "$ROOT"/*.ts; do
  name="$(basename "$file")"
  npx --yes esbuild "$file" --format=esm --outfile="$OUT_DIR/$name.js" >/dev/null
done

count="$(ls -1 "$OUT_DIR" | wc -l | tr -d ' ')"
printf 'Transpile check passed (%s files).\n' "$count"
