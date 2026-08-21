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
- `computeCull: "auto"` plus a HUD and `data-cull-path` readout of `stats.cullPath`. WebGPU with one
  atlas bank reports `compute-cull` even after late glyph rasterization breaks CPU instance order.
  WebGL and multi-segment meshes report `cpu-grid`;
- 1,000,000 resident labels and viewport culling;
- 100,000 packed position updates every 100 milliseconds;
- five registered Noto subsets covering CJKV, Arabic, Devanagari, Hebrew, and Thai;
- Greek, Cyrillic, Vietnamese, emoji, language/script overrides, and system fallback samples;
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
default backend, capability-gated WebGPU renderer, WebGL override and rebuild, cull-path readout,
position-storm revisions, progressive examples, camera controls, theme switching, reduced motion,
keyboard access, console errors, and horizontal fit at 320, 768, 1024, and 1440 pixels.
