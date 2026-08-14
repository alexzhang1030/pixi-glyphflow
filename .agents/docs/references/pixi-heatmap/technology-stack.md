# Technology stack

Why these tools over the defaults they displaced.

- **TypeScript 7 (`typescript@^7`)** — Go-native compiler, ~10× faster typecheck than TS 6; GA 2026-07-08. Caveat: no stable programmatic API yet, so anything invoking the tsc API breaks.
- **tsdown (Rolldown/Oxc)** — library bundler chosen over tsup; ESM-only output + d.ts. Its default dts path (rolldown-plugin-dts) calls the tsc API, which fails under TS 7 → **`dts: { oxc: true }` is required** (learned the hard way: `useCaseSensitiveFileNames` TypeError).
- **oxlint / oxfmt** — lint/format, Rust-fast. The codebase follows Pixi-style `_privateField` names, so `no-underscore-dangle` is disabled while correctness and suspicious categories stay enforced.
- **vitest** — unit tests for the data layer and GPU orchestration; Pixi construction uses a `DOMAdapter` canvas stub while renderer calls stay recorded or inert.
- **pnpm workspace (pnpm 11)** — root = library, `docs/` = docs app. pnpm 11 gotchas already paid for: settings moved out of package.json into `pnpm-workspace.yaml`, and `onlyBuiltDependencies` was **replaced by `allowBuilds`** (map form: `allowBuilds: { esbuild: true }`); the old key is silently ignored and every script dies with `ERR_PNPM_IGNORED_BUILDS` in the pre-run deps check.
- **Nuxt 4.5 for docs** — SSR with `future: { compatibilityVersion: 5 }`; Pixi demos live inside `ClientOnly` and load Pixi plus the library dynamically on the client. Server-rendered usage/API content remains indexable, and Shiki/Twoslash stays in the server bundle. Lock 4.5+: 4.4.x had an SPA dev-server IPC regression (nuxt#34957).
- **pixi.js ^8 as peerDependency** — consumers bring their own Pixi; only v8 is supported, by design.
- **Publishing identity** — the canonical GitHub repository is `alexzhang1030/pixi-heatmap`; docs, package metadata, release links, and badges use that owner.
- **Release contract** — npm ships the ESM library plus its worker subpath, declarations, changelog, README, and MIT license. `prepublishOnly` runs tests, lint, typecheck, and build; GitHub CI adds the docs production build and package manifest check.
- **Release automation** — `.github/workflows/publish.yml` publishes `v*` tags from a GitHub-hosted Node 24 runner through npm Trusted Publishing with short-lived OIDC credentials. The workflow grants `contents: read` and `id-token: write`, pins an OIDC-capable npm CLI, builds the docs, audits dependencies, and requires the tag to equal `v${package.json.version}`. The npm trusted publisher record uses owner `alexzhang1030`, repository `pixi-heatmap`, workflow filename `publish.yml`, and the `npm publish` action.
