#!/usr/bin/env bash
# Linux/macOS equivalent of `npm run build`.
# Cleans every package, compiles ESM into lib/ and copies static assets.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TSC="node_modules/typescript-7/lib/tsc.js"

if [ ! -f "$TSC" ]; then
  echo "Missing $TSC - run 'npm install' first." >&2
  exit 1
fi

echo "==> clean"
npm run clean

echo "==> compile (tsconfig.build.json)"
node "$TSC" -b tsconfig.build.json

echo "==> copy static assets"
npm run copy-static

echo "Build finished."
