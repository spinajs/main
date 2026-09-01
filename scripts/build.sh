#!/usr/bin/env bash
# Linux/macOS equivalent of `npm run build`.
# Cleans every package, compiles ESM + CJS, copies static assets
# and writes the per-flavour package.json module markers.

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

echo "==> compile esm (tsconfig.build.json)"
node "$TSC" -b tsconfig.build.json

echo "==> compile cjs (tsconfig.build.cjs.json)"
node "$TSC" -b tsconfig.build.cjs.json

echo "==> copy static assets"
npm run copy-static

echo "==> prepare module support"
npm run prepare-module-support

echo "Build finished."
