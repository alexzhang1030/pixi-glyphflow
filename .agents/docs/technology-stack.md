# Technology stack

Status: unstamped project record dated 2026-08-15. Package versions are pinned by [package.json](../../package.json) and [bun.lock](../../bun.lock).

## Current selections

| Area | Selection | Rationale and boundary |
| --- | --- | --- |
| Package manager, scripts, tests, audit | Bun 1.3.14 | One native tool covers installation, the text lockfile, scripts, tests, and dependency audit. CI uses bun ci for frozen installs. |
| Type checking | TypeScript 7.0.2 | Native tsc provides parallel checking. Strict mode, isolated declarations, unused checks, and unchecked-index diagnostics stay enabled. |
| Library build | tsdown 0.22.14 | The Rolldown and Oxc pipeline emits ESM, declarations, and source maps. PixiJS remains an external peer dependency. |
| Lint and formatting | Oxlint 1.78.0 and Oxfmt 0.63.0 | Native Oxc tools cover source, JSON, Markdown, and workflow YAML. Warnings fail the gate. |
| Package shape | publint 0.3.23 and Are the Types Wrong 0.18.5 | Release checks cover metadata, exports, declarations, and ESM consumer resolution. |
| Rendering host | PixiJS 8.19.0 development pin and ^8.19.0 peer range | The implementation uses public scene, geometry, shader, texture, and bitmap-font interfaces. Advanced compatibility code stays isolated under src/pixi/compat. |
| Complex shaping | harfbuzzjs, loaded on demand | HarfBuzz supplies glyph IDs, cluster mapping, positioning, and outlines for registered binary fonts. Its version lands as an exact dependency with the shaping slice. |
| Dynamic distance fields | WebAssembly MSDF generation, loaded on demand | Runtime MSDF work runs outside the core startup path. Prebuilt bitmap fonts remain the fastest startup route. |
| Publication | npm 12 and GitHub OIDC Trusted Publishing | Release tags align with package versions. Provenance and public consumer verification form part of the release gate. |

## Compatibility constraints

- The package is ESM-only and side-effect free at its root export.
- PixiJS stays external so every application owns one renderer and extension registry.
- Renderer-specific code consumes one logical glyph-instance contract for WebGL and WebGPU.
- The TypeScript 7 consumer fixture enables skipLibCheck while PixiJS and the DOM library both provide WebGPU declarations. Project source and generated declarations remain strictly checked.
- Optional WebAssembly assets load through explicit font and shaping operations. Importing the core package performs no network request and starts no worker.
- Public interface behavior is tested through TextLayer, FontRegistry, worker protocol, and package exports. Internal stores and adapters remain replaceable.

## Tooling evidence

- TypeScript 7 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- tsdown declarations: https://tsdown.dev/options/dts
- Bun frozen installs: https://bun.sh/docs/pm/cli/install
- PixiJS Mesh: https://pixijs.com/8.x/guides/components/scene-objects/mesh
- PixiJS BitmapFontManager: https://pixijs.download/dev/docs/text.BitmapFontManager.html
- HarfBuzz JavaScript bindings: https://github.com/harfbuzz/harfbuzzjs
- npm Trusted Publishers: https://docs.npmjs.com/trusted-publishers/

## Legal state

package.json currently declares UNLICENSED. An explicit human license decision will update the package metadata and add the corresponding license file.
