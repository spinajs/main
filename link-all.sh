#!/usr/bin/env bash
# Shell script to npm link all packages in a monorepo workspace.
# Linux/macOS equivalent of link-all.ps1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGES_DIR="$ROOT/packages"

if [ ! -d "$PACKAGES_DIR" ]; then
  echo "Packages directory not found: $PACKAGES_DIR" >&2
  exit 1
fi

# Find all directories containing a package.json file, only one level deep
for dir in "$PACKAGES_DIR"/*/; do
  [ -f "${dir}package.json" ] || continue

  echo "Linking package in directory: ${dir%/}"
  (cd "$dir" && npm link)
done

echo "All packages have been linked successfully."
