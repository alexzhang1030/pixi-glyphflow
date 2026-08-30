# Documentation site

The `site/` workspace is the interactive product documentation for pixi-glyphflow. It uses Nuxt 4
SSR, Vue 3, Tailwind CSS 4, server-rendered Shiki highlighting, and TypeScript 7-native Golar
checking.

## Commands

Run every command from the repository root:

```bash
bun run site:dev
bun run site:typecheck
bun run site:build
bun run site:test
```

Development, type-check, generation, and production commands build the root library first. This
clean-checkout contract guarantees that Nuxt resolves `pixi-glyphflow` and its optional entry
points through exact aliases to `dist/`.

## Live renderer

`components/GlyphflowDemo.client.vue` runs the public package surface with:

- a WebGL 2 or WebGPU selector that rebuilds the complete PixiJS scene;
- WebGPU as the first boot when a GPU adapter is available and `?renderer` is absent;
- `?renderer=webgl` and `?renderer=webgpu` as hard overrides;
- `computeCull: "auto"` plus a compact HUD and `data-cull-path` / `data-palette-path` readouts of
  `stats.cullPath` (`compute-cull` or `cpu-grid`) and `stats.palettePath` (`storage` or `texture`);
- WebGPU requests `residency: "gpu-scene"` with a bounded 24-prototype / 8-paint scene, while the
  HUD and `data-residency-active` / `data-residency-fallback` expose the live residency decision;
- a first camera view framed on the multilingual specimen band, painted before the rest of the
  million-label set is allocated;
- 1,000,000 resident labels and viewport culling;
- 100,000 packed position updates every 100 milliseconds;
- five registered Noto subsets covering CJKV, Arabic, Devanagari, Hebrew, and Thai;
- `charsetSdfPrebuilt` pages for those language samples after `FontFace.load`;
- Greek, Cyrillic, Vietnamese, emoji, and system fallback samples; the Fonts section demonstrates
  explicit language/script overrides on the public API;
- explicitly bundled MSDF worker and WebAssembly assets for deterministic production startup;
- pixi-viewport drag, deceleration, wheel, pinch, zoom, and rotation;
- keyboard pan and zoom controls plus reduced-motion behavior;
- resize, intersection, timer, binding, renderer, and scene cleanup.

The compact page workload demonstrates the same code path as the million-label playground while
keeping documentation navigation responsive through culling, repeated-run shaping caches, and
shared glyph atlases.

## Examples

The page presents a progressive public-API path: a label with only its required `text`, independent
group creation plus group and `TextId` visibility, and optional `vertical-rl`, font-weight, and fill
styling. `components/ExamplesSection.vue` composes the production code-block component inside the
existing responsive document layout.

## Browser acceptance

`bun run site:test` builds the root package and Nuxt server, then runs Chrome checks for the live
default backend, capability-gated WebGPU renderer, WebGL override and rebuild, cull-path and
palette-path readouts, position-storm revisions, progressive examples, camera controls, theme
switching, reduced motion, keyboard access, console errors, and horizontal fit at 320, 768, 1024,
and 1440 pixels. WebGL stays on `palettePath` `"texture"`. WebGPU reports `"storage"` when
`requestComputeCullGpu()` raised `maxStorageBuffersInVertexStage`.

If a live WebGPU device takes `"storage"` and then throws
`createBindGroup` / `GPUBindGroupDescriptor` `layout` undefined on the first compute-cull
draw, that is a library `GlyphMesh` bind (`uTransformTexture` vs `uTransforms`), not a
site bug. #36 binds `uTransforms` only. The homepage must not catch a regression and rebuild
as WebGL, force a texture palette, or drop storage resources so the canvas still paints.
Show the error. WebGL remains the valid path on this page.
