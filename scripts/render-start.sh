#!/usr/bin/env bash
# Render start: SpacetimeDB on 127.0.0.1:3000 + static/proxy on $PORT.
set -euo pipefail

_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${_repo_root}"

export RENDER="${RENDER:-true}"
export SPACETIME_AUTO_INSTALL_TOOLCHAIN="${SPACETIME_AUTO_INSTALL_TOOLCHAIN:-1}"
# Bind SpacetimeDB internally; the Node proxy owns Render's public $PORT.
export SPACETIME_SERVER_LISTEN_ADDR="${SPACETIME_SERVER_LISTEN_ADDR:-127.0.0.1:3000}"
export SPACETIME_PROXY_TARGET="${SPACETIME_PROXY_TARGET:-http://127.0.0.1:3000}"
export PORT="${PORT:-10000}"

# Prefer an explicit override, then a Render disk mount at /var/data, else repo-local.
if [[ -n "${SPACETIME_SERVER_DATA_DIR:-}" ]]; then
  :
elif [[ -d /var/data ]]; then
  export SPACETIME_SERVER_DATA_DIR="/var/data/spacetimedb"
else
  export SPACETIME_SERVER_DATA_DIR="${_repo_root}/server/.data/spacetimedb"
fi
mkdir -p "${SPACETIME_SERVER_DATA_DIR}"
echo "SpacetimeDB data dir: ${SPACETIME_SERVER_DATA_DIR}"

bash "${_repo_root}/scripts/ensure-spacetimedb-toolchain-ci.sh"
export PATH="${HOME}/.local/bin:${HOME}/.spacetimedb:${HOME}/.spacetimedb/bin/current:${HOME}/.local/share/spacetime/bin/current:${PATH}"

if [[ -x "${HOME}/.local/share/spacetime/bin/current/spacetimedb-cli" ]]; then
  export SPACETIME_CLI="${HOME}/.local/share/spacetime/bin/current/spacetimedb-cli"
elif [[ -x "${HOME}/.spacetimedb/bin/current/spacetimedb-cli" ]]; then
  export SPACETIME_CLI="${HOME}/.spacetimedb/bin/current/spacetimedb-cli"
elif command -v spacetime >/dev/null 2>&1; then
  export SPACETIME_CLI="$(command -v spacetime)"
fi

_stdb_pid=""
_serve_pid=""
_shutting_down=0

_cleanup() {
  if [[ "${_shutting_down}" -eq 1 ]]; then
    return 0
  fi
  _shutting_down=1
  if [[ -n "${_serve_pid}" ]] && kill -0 "${_serve_pid}" 2>/dev/null; then
    kill "${_serve_pid}" 2>/dev/null || true
    wait "${_serve_pid}" 2>/dev/null || true
  fi
  if [[ -n "${_stdb_pid}" ]] && kill -0 "${_stdb_pid}" 2>/dev/null; then
    echo "Stopping SpacetimeDB (pid ${_stdb_pid})..."
    kill "${_stdb_pid}" 2>/dev/null || true
    wait "${_stdb_pid}" 2>/dev/null || true
  fi
}

trap _cleanup EXIT
trap ' _cleanup; exit 0' INT TERM

echo "Starting SpacetimeDB on ${SPACETIME_SERVER_LISTEN_ADDR}..."
pnpm run server:start &
_stdb_pid=$!

_wait_for_stdb() {
  local _url="http://127.0.0.1:3000/v1/ping"
  local _i
  for _i in $(seq 1 60); do
    if ! kill -0 "${_stdb_pid}" 2>/dev/null; then
      echo "SpacetimeDB exited before becoming ready" >&2
      return 1
    fi
    if curl -sf "${_url}" >/dev/null 2>&1; then
      echo "SpacetimeDB is ready."
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for SpacetimeDB at ${_url}" >&2
  return 1
}

_wait_for_stdb

echo "Publishing arena module..."
pnpm run server:publish:arena

echo "Starting static + /v1 proxy on 0.0.0.0:${PORT}..."
# Keep this shell as supervisor so SIGTERM cleans up SpacetimeDB.
node "${_repo_root}/scripts/render-serve.mjs" &
_serve_pid=$!
wait "${_serve_pid}"
_serve_exit=$?
_serve_pid=""
exit "${_serve_exit}"
