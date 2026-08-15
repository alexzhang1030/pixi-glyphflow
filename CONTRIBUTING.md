# Contributing

## Prerequisites

- Bun 1.3.14, sourced from `packageManager` in `package.json`
- Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` for tsdown's supported runtime path

## Setup

```bash
bun install
bun run check
```

`bun.lock` is committed and CI installs it through `bun ci`.

## Change discipline

- Keep the root export ESM-only and side-effect free.
- Add explicit return types to exported functions so Oxc can generate isolated declarations.
- Keep `pixi.js` external and represented as a peer dependency.
- Add Bun tests for observable API changes.
- Update `README.md`, `docs/POC.md`, and `CHANGELOG.md` when their contracts move.
- Update affected PCR records under `.agents/docs/` in the same change.

## Commands

| Command                  | Gate                                            |
| ------------------------ | ----------------------------------------------- |
| `bun run format:check`   | Project formatting                              |
| `bun run lint`           | Correctness and warning-free lint               |
| `bun run typecheck`      | TypeScript 7 diagnostics                        |
| `bun run site:typecheck` | Nuxt and Vue diagnostics through Golar          |
| `bun test`               | Runtime behavior                                |
| `bun run build`          | ESM and declaration output                      |
| `bun run site:build`     | Clean-checkout Nuxt production build            |
| `bun run site:test`      | Responsive site and live-render browser checks  |
| `bun run package:lint`   | npm metadata and exports                        |
| `bun run package:types`  | Consumer module/type resolution                 |
| `bun run package:smoke`  | Packed runtime and TypeScript consumer behavior |
| `bun run audit`          | High and critical advisories                    |

## Release

Version tags use `v<package-version>`. Publishing the matching GitHub Release activates the workflow,
verifies tag alignment, and publishes via npm Trusted Publishing from the protected `npm`
environment.
