#!/usr/bin/env bash
# Render build: install SpacetimeDB toolchain, build module, build Vite client.
set -euo pipefail

_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${_repo_root}"

export SPACETIME_AUTO_INSTALL_TOOLCHAIN="${SPACETIME_AUTO_INSTALL_TOOLCHAIN:-1}"
export RENDER="${RENDER:-true}"

bash "${_repo_root}/scripts/ensure-spacetimedb-toolchain-ci.sh"
export PATH="${HOME}/.local/bin:${HOME}/.spacetimedb:${HOME}/.spacetimedb/bin/current:${HOME}/.local/share/spacetime/bin/current:${PATH}"

# Prefer the Linux install over any macOS binaries vendored under .tools/.
if [[ -x "${HOME}/.local/share/spacetime/bin/current/spacetimedb-cli" ]]; then
  export SPACETIME_CLI="${HOME}/.local/share/spacetime/bin/current/spacetimedb-cli"
elif [[ -x "${HOME}/.spacetimedb/bin/current/spacetimedb-cli" ]]; then
  export SPACETIME_CLI="${HOME}/.spacetimedb/bin/current/spacetimedb-cli"
elif command -v spacetime >/dev/null 2>&1; then
  export SPACETIME_CLI="$(command -v spacetime)"
fi

echo "Building SpacetimeDB module..."
pnpm run server:build

echo "Building Vite client..."
pnpm run build

echo "Render build complete."
