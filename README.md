# Zylem Moba

Standalone repository for the Zylem moba example.

## Requirements

- Node >= 22.12.0
- pnpm >= 10.32.1
- A WebGPU-capable browser. `@zylem/game-lib` renders with Three.js' `WebGPURenderer`, so the arena requires WebGPU support (recent Chrome/Edge/Safari, or Firefox with WebGPU enabled).

## Quick start

```bash
pnpm install
pnpm moba
```

`pnpm moba` opens an interactive launcher (Clack TUI) that boots the SpacetimeDB
server and the Vite game client together, with prefixed log streams and a clean
Ctrl+C that stops everything. It can also (re)build and publish the `arena`
module once the server is reachable.

## App

```bash
pnpm dev
pnpm build
```

The client loads binary assets from the Zylem demos CDN by default. Override the CDN base with `VITE_DEMOS_ASSET_BASE_URL`.

## SpacetimeDB

```bash
pnpm server:start
pnpm server:build
pnpm server:publish:arena
pnpm server:generate:bindings
```

For local gameplay, start SpacetimeDB, publish the `arena` database, then run the Vite dev server. `pnpm moba` automates starting the server + client (and optionally publishing the module) in one step.

## Deploy on Render

Create a single **Web Service** (Node 22+) that serves the Vite client and proxies SpacetimeDB on the same origin:

| Setting | Value |
| --- | --- |
| Build Command | `pnpm install && pnpm render:build` |
| Start Command | `pnpm render:start` |

`render:start` runs SpacetimeDB on `127.0.0.1:3000`, publishes the `arena` module, then serves `dist/` on `$PORT` with `/v1/*` (HTTP + WebSocket) reverse-proxied to SpacetimeDB. Leave `VITE_STDB_URI` unset so the client uses `window.location.origin`.

SpacetimeDB data under `server/.data` lives on the instance disk and is ephemeral unless you attach a Render persistent disk.
