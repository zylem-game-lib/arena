# Zylem Moba

Standalone repository for the Zylem moba example.

## Requirements

- Node >= 22.12.0
- pnpm >= 10.32.1

## App

```bash
pnpm install
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

For local gameplay, start SpacetimeDB, publish the `arena` database, then run the Vite dev server.
