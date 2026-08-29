# AGENTS.md

## Cursor Cloud specific instructions

This is `@zylem/arena` ("Zylem Moba"): a Vite + SolidJS + Three.js **WebGPU** game client (`src/`) backed by a **SpacetimeDB** module (`server/spacetimedb/`) published as a database named `arena`. Standard commands live in `README.md` and `package.json` `scripts`.

### Environment already provisioned by the update script
- `pnpm install` (root client) and `pnpm run server:install` (server module) are run on startup.
- The **SpacetimeDB CLI 2.6.1** is installed to `~/.local/bin` (via `scripts/ensure-spacetimedb-toolchain-ci.sh`). `~/.local/bin` is added to `PATH` in `~/.bashrc`, so `spacetime` is available in new login shells. If a non-login shell can't find it, run `export PATH="$HOME/.local/bin:$PATH"`.

### Running the stack (three pieces, in order)
1. `pnpm server:start` — SpacetimeDB server, binds `127.0.0.1:3000`. Long-running; run in its own terminal/tmux session.
2. Build + publish the module: `pnpm server:build` then publish the `arena` DB (see caveat below).
3. `pnpm dev` — Vite client on port **1337** (`--host`). Connects to STDB at `ws://127.0.0.1:3000`.

`pnpm moba` is an interactive Clack TUI that launches server + client together, but it is **interactive** (prompts) and not suitable for automated/non-TTY contexts — start the pieces individually instead.

### Non-obvious caveats
- **Publish prompts and hangs without `--yes`.** `pnpm server:publish:arena` (and `pnpm server:dev`, which calls it) runs `spacetime publish arena -s local` and blocks on an interactive confirmation. In automated contexts publish directly with the flag:
  `spacetime publish arena -s local -p server/spacetimedb --yes`
- **WebGPU required.** The client renders via Three.js `WebGPURenderer`. It works in the cloud VM's Chrome without extra flags; if a browser lacks WebGPU the canvas is blank.
- **3D/binary assets come from a CDN** (`https://assets.zylem.cloud/demos`), reached in dev via Vite's `/cdn` proxy (which uses a hardcoded 1.1.1.1 DNS resolver). Full visuals need outbound network access; override the base with `VITE_DEMOS_ASSET_BASE_URL` if needed.
- **`pnpm typecheck` currently fails** on a pre-existing type error from two resolved versions of `@zylem/behaviors` (0.4.1 direct vs 0.3.1 transitive) in `src/demos/arena/characters/attack-effects.ts`. This is unrelated to environment setup. There are no unit-test or lint scripts in this repo.
- SpacetimeDB data persists under `server/.data/spacetimedb` (gitignored). Delete it to reset game state.

### Hello-world / smoke test
Open `http://localhost:1337/`, pick a character + color in the lobby, enter a display name, click **Enter arena**. You should drop into the 3D arena with an HP bar — confirming client, WebGPU rendering, and the SpacetimeDB `arena` module are all wired up.
