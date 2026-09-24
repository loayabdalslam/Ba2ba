#!/usr/bin/env bash
# Verify every component carries the same version (and, if given, that it matches a tag like v4.1.0).
set -euo pipefail
cd "$(dirname "$0")/.."
py=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' bee2bee/_version.py)
desktop=$(node -p "require('./desktop/package.json').version")
gateway=$(node -p "require('./gateway/package.json').version")
server=$(node -p "require('./server/package.json').version")
tauri=$(sed -n '0,/^version = /s/^version = "\(.*\)"/\1/p' desktop/src-tauri/Cargo.toml)
core=$(sed -n '0,/^version = /s/^version = "\(.*\)"/\1/p' desktop/src-tauri/core/Cargo.toml)
printf 'python %s | desktop %s | tauri %s | core %s | gateway %s | server %s\n' "$py" "$desktop" "$tauri" "$core" "$gateway" "$server"
for v in "$desktop" "$tauri" "$core" "$gateway" "$server"; do
  [ "$v" = "$py" ] || { echo "version mismatch: expected $py everywhere"; exit 1; }
done
if [ "${1:-}" != "" ] && [ "v$py" != "$1" ]; then
  echo "tag $1 does not match version v$py"; exit 1
fi
grep -q "^## \[$py\]" CHANGELOG.md || { echo "CHANGELOG.md has no section for $py"; exit 1; }
echo "versions OK: $py"
