# 100× homepage performance

Status: unstamped research after the on-screen admission drip was rejected.

The current conclusion: compute-cull is not 100× slower because the GPU prefix-sum is slow. It felt
worse than `cpu-grid` because it prepared a padded working set as if every resident were on screen,
then drip-fed those glyphs across frames. On-screen drip is gone. The remaining 100× is “do not
generate or instance work the user cannot see, and do not rebuild what the GPU already has.”

## What 100× means

Use the homepage fixture: 1,000,000 labels, zoom 0.24, 100,000 movers every 100 ms, WebGPU.

| Moment | What the user sees | Current order of cost | 100× target |
| --- | --- | --- | --- |
| Camera inside a prepared working set | Same pixels, view moves | Viewport uniform + compute dispatch | Already near the floor. Aim for ≤ 0.3 ms CPU. |
| Position storm inside that set | 100k labels move | Palette x/y + AABB patch | ≤ 1 ms if we stop walking draw states. |
| Zoom or pan onto new labels | New text appears at once | Layout + raster + instance write for first-seen | Tight view only, cache hits stay sync. Aim ≤ 16 ms for a few thousand labels sharing a handful of strings. |
| First miss of a new ideograph | New CJK glyph | `@zappar/msdf-generator` | TinySDF / prebake. One miss must not be a frame. |

A 2.65 s first-seen hitch to 26 ms is 100×. A 5 ms camera frame to 50 µs is also 100× and is the
wrong target: the GPU already submits in that neighborhood. Do not spend the program chasing camera
dispatch.

Homepage math at zoom 0.24 on a ~1280×720 canvas:

- Tight view ≈ 35 × 100 labels ≈ 3,500 on screen.
- Working set slack is `max(draw.width, draw.height)` on every side ≈ 48,000 residents.
- Unique strings are about 12 language samples plus one emoji line.

Preparing 48,000 first-seen copies of 12 strings is why compute-cull lost to `cpu-grid` (3,500).
Layout and atlas already cache by text and glyph. The waste is per-label async `layout()`, instance
writes, and remirroring the store.

## Landed in this pass

- No `prepareBudgetMs`, `prepareWave`, leftover slot list, or rAF continue. On-screen text appears
  in the commit that first sees it.
- `shouldInstanceUnshaped`: compute-cull layouts an unshaped resident only when its AABB hits the
  prepare ring (tight draw plus 0.25×`max(w,h)`). The expanded working set stays for retain and
  GPU compact.
- Camera motion inside the working set queries that ring and prepares newly visible unshaped
  labels. It does not remirror the instance buffer when nothing new is shaped.
- `LayoutEngine.layout` is not `async`. A `#shapeCache` hit returns the run on the same turn.
  `RenderCoordinator` only awaits labels that still need shaping or raster.
- Duplicate strings clone the prototype instance range and rewrite the palette index. They do not
  walk `#buildInstances`.

## Remaining slices, in order

1. **TinySDF / prebaked pages.** Wave 4. The 2.65 s bars were raster, not compact. This is the
   only way a true new glyph stays inside 16 ms.
2. **LOD.** Drop glyphs whose projected height is below one pixel. Policy flag, default off.
   Changes pixels.
3. **Palette storage buffer and atlas texture array.** Wave 3 leftovers. Binding cost, not the
   zoom hitch.

Reject: drip-feed admission, `queryAll()` for compute-cull, BVH rebuilds on the 100k storm, and
replacing PixiJS with a compute 2D engine.

## Evidence

- Homepage traces `Trace-20260822T035924` and `Trace-20260822T033314` (working-set miss in
  `#prepare` / `#ensureGlyph` / `#buildInstances`).
- `expandWorkingSet` in `src/culling/computeCull.ts`.
- Language samples in `site/components/GlyphflowDemo.client.vue`.
- Shape cache in `src/layout/LayoutEngine.ts`. Atlas key cache in `RenderCoordinator.#ensureGlyph`.
