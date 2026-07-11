#!/usr/bin/env sh
# Install SpacetimeDB CLI for CI / Render (Linux). Idempotent.
# Pins to SPACETIME_VERSION (default 2.6.1) to match package.json.
set -eu

SPACETIME_VERSION="${SPACETIME_VERSION:-2.6.1}"
_home_bin="${HOME}/.local/bin"
_spacetime_share="${HOME}/.local/share/spacetime"
_legacy_home="${HOME}/.spacetimedb"

export PATH="${_home_bin}:${_legacy_home}:${_legacy_home}/bin/current:${_spacetime_share}/bin/current:${PATH}"

_cli_version() {
  _bin="$1"
  if [ ! -x "${_bin}" ]; then
    return 1
  fi
  _out="$("${_bin}" --version 2>/dev/null || true)"
  printf '%s' "${_out}" | grep -q "spacetimedb tool version ${SPACETIME_VERSION}"
}

_resolve_cli() {
  if [ -n "${SPACETIME_CLI:-}" ] && _cli_version "${SPACETIME_CLI}"; then
    printf '%s\n' "${SPACETIME_CLI}"
    return 0
  fi
  for _candidate in \
    "${_spacetime_share}/bin/current/spacetimedb-cli" \
    "${_legacy_home}/bin/current/spacetimedb-cli" \
    "${_home_bin}/spacetime"
  do
    if _cli_version "${_candidate}"; then
      printf '%s\n' "${_candidate}"
      return 0
    fi
  done
  if command -v spacetime >/dev/null 2>&1 && _cli_version "$(command -v spacetime)"; then
    command -v spacetime
    return 0
  fi
  if command -v spacetimedb-cli >/dev/null 2>&1 && _cli_version "$(command -v spacetimedb-cli)"; then
    command -v spacetimedb-cli
    return 0
  fi
  return 1
}

if _resolved="$(_resolve_cli)"; then
  echo "SpacetimeDB ${SPACETIME_VERSION} already available: ${_resolved}"
  exit 0
fi

echo "Installing SpacetimeDB ${SPACETIME_VERSION}..."
curl -sSf https://install.spacetimedb.com | sh -s -- -y

export PATH="${_home_bin}:${_legacy_home}:${_legacy_home}/bin/current:${_spacetime_share}/bin/current:${PATH}"

if ! command -v spacetime >/dev/null 2>&1; then
  echo "spacetime not found on PATH after install" >&2
  exit 127
fi

# Pin the requested version when the installer landed on something else.
if ! spacetime --version 2>/dev/null | grep -q "spacetimedb tool version ${SPACETIME_VERSION}"; then
  echo "Switching SpacetimeDB to ${SPACETIME_VERSION}..."
  spacetime version install "${SPACETIME_VERSION}" || true
  spacetime version use "${SPACETIME_VERSION}"
fi

if ! spacetime --version 2>/dev/null | grep -q "spacetimedb tool version ${SPACETIME_VERSION}"; then
  echo "Failed to install SpacetimeDB ${SPACETIME_VERSION}" >&2
  spacetime --version >&2 || true
  exit 1
fi

echo "SpacetimeDB ${SPACETIME_VERSION} ready: $(command -v spacetime)"
