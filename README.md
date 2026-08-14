# pixi-glyphflow

A high-throughput batched text layer for PixiJS v8.

`0.0.1` is a contract POC. It provides a working `TextLayer` backed by PixiJS Canvas Text,
stable label identities, mutation commits, lifecycle management, and diagnostics. The shared glyph
atlas and instanced GPU renderer enter the M1 implementation milestone, followed by benchmark-backed
performance claims.

## Install

```bash
bun add pixi-glyphflow pixi.js
```

The package is ESM-only and declares `pixi.js@^8.19.0` as a peer dependency.

## Usage

```ts
import { Application } from "pixi.js";
import { TextLayer } from "pixi-glyphflow";

const app = new Application();
await app.init({ resizeTo: window });

const layer = new TextLayer();
app.stage.addChild(layer);
layer.attach(app.renderer);

const fpsLabel = layer.create({
  text: "上海 120 FPS",
  x: 24,
  y: 24,
  style: {
    fill: 0xffffff,
    fontFamily: "Inter, Noto Sans CJK SC",
    fontSize: 18,
  },
});

layer.updateLabel(fpsLabel, { text: "上海 121 FPS" });
const revision = await layer.commit();

console.log(revision, layer.stats);
```

## POC contract

| API                             | Contract in `0.0.1`                                                              |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `create(spec)`                  | Creates one visible PixiJS `Text` and returns a stable `TextId`.                 |
| `updateLabel(id, patch)`        | Applies text, position, style, alpha, visibility, rotation, and anchor changes.  |
| `remove(id)`                    | Releases the label and its PixiJS text resources.                                |
| `commit()`                      | Publishes pending mutations as one monotonic `TextRevision`.                     |
| `attach(renderer)` / `detach()` | Establishes the renderer ownership seam used by future GPU resources.            |
| `stats`                         | Reports backend, label count, pending mutations, revision, and attachment state. |

`stats.backend` is `"pixi-text-poc"` for this release. The M1 backend will preserve the public
mutation seam while moving labels into shared glyph-instance storage.

## Development

The repository pins a native-first toolchain: Bun 1.3, TypeScript 7, tsdown, Oxlint, Oxfmt,
publint, and Are the Types Wrong.

```bash
bun install
bun run check
```

| Command                 | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `bun test`              | Run the Bun unit suite.                                          |
| `bun run typecheck`     | Run the native TypeScript 7 compiler.                            |
| `bun run lint`          | Run Oxlint with warnings as failures.                            |
| `bun run format`        | Format project-owned files with Oxfmt.                           |
| `bun run build`         | Build ESM JavaScript, declarations, and source maps with tsdown. |
| `bun run package:lint`  | Validate package metadata and exports with publint.              |
| `bun run package:types` | Validate ESM consumer types with Are the Types Wrong.            |
| `bun run package:smoke` | Install the tarball and run runtime plus TypeScript probes.      |
| `bun run audit`         | Check high and critical dependency advisories.                   |

TypeScript 7 consumers use `skipLibCheck: true` while PixiJS 8.19 ships `@webgpu/types`
alongside the WebGPU declarations in TypeScript 7's `lib.dom`. Project source and generated public
declarations remain under strict type checking.

## Project documents

- [POC contract and release path](https://github.com/alexzhang1030/pixi-glyphflow/blob/main/docs/POC.md)
- [Performance text rendering blueprint](https://github.com/alexzhang1030/pixi-glyphflow/blob/main/.agents/docs/pixi-glyphflow-blueprint.md)
- [Project context map](https://github.com/alexzhang1030/pixi-glyphflow/blob/main/.agents/docs/README.md)

## License

The source is currently `UNLICENSED`. A future release can carry an explicit open-source license
after the project records that legal decision.
