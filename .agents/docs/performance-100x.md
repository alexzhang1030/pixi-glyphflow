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
- `tinySdf: true` builds HarfBuzz glyphs as a local SDF from the canvas mask. The homepage demo
  turns this on so a new ideograph does not start `@zappar/msdf-generator`. MSDF stays the default
  because the field changes pixels.
- `rasterizerOptions.prebuilt` crops packed pages before TinySDF or MSDF. Keys omit font revision.
  The core package does not ship default alphabet pages.
- `culling.lod` drops labels whose projected font height is below one pixel. Default is off.
- Compute-cull GPU mirrors sync incrementally. Commits upload only dirty instance byte ranges and
  changed or appended cull records; `RenderCoordinator.drawListEpoch` bumps on re-sorts and
  removals, so TextLayer appends records while it holds and repacks in full when it moves. A cull
  fallback invalidates the pass mirrors so re-entry uploads whole buffers. Before this, one
  first-seen label re-mirrored the entire instance buffer (~20 MB per pan frame at homepage scale),
  and a patch-path content edit left stale instance bytes and record offsets on the GPU.
- New draw states no longer force a full re-sort. Zero-z ascending inserts append in sorted order;
  the sort now triggers only on out-of-order inserts, z/order changes, or once any nonzero z-index
  exists. The old `previousDrawState?.zIndex !== 0` check treated every insert as a sort.
- Camera frames skip the first-seen **ring** query while the draw viewport stays inside the last
  prepared ring. They still query the tight view so a deferred unique miss is admitted the
  frame it crosses on screen. Ring escape re-queries the pad for intern hits.
- HarfBuzz glyphs with ids skip `resolveGlyphText` on identity paths (it sliced the remaining
  code points per glyph, O(N²) per label); the real character is derived only on an atlas miss.
  Duplicate-string labels ensure glyphs once per (run, size, weight) per commit.
- Later creates skip `queryAll`. They enter through the resident dirty path and still appear in
  the same commit.
- Palette storms upload stacked full texture rows instead of one write per row.
- Duplicate strings intern one layout result per (family, size, weight, text) and skip
  `LayoutEngine.layout` for the rest of that commit and later first-seen copies. Font-registry
  revision drops the intern.
- `GlyphInstanceStore.clone` rewrites a dest range in place when its capacity already fits, and
  copies with `copyWithin` instead of allocating two `Uint8Array` views.
- Broadcast `updateTextPositions` keeps the position-only transform kind when only x/y move, so a
  content storm with default anchors patches 16 palette bytes instead of rewriting the fill
  record. Non-zero anchors still take the full palette write because packed anchors include
  run bounds.
- Rendered labels that share one interned (text, style) and zero anchors take
  `applyContentLane`: one layout, in-place clones, columnar x/y. They do not build per-label
  `RenderChange` snapshots. Shaping, vertical writing, trusted runs, and non-zero anchors stay
  on the object path.
- Content-lane instance writes use `shareMany` from one prototype and retain atlas keys in one
  pass. Spatial AABBs come from `placeMany`: packed x/y plus the shared run box. Rendered
  unit-transform labels skip the intake estimate rehash. Scale or rotation keeps the object path.
- Duplicate strings **share** one instance range. `share` / `shareMany` retarget dests at the
  prototype bytes. Compact and CPU draws write the label's palette index from the cull record or
  draw span. Eight copies of `"AB"` keep `highWater` at 2. Removing a sharer does not free the
  block until the last user leaves. A `set` on a shared dest copy-on-writes.
- First-seen fill-only duplicates take `applyAdmitLane`. One layout per (text, style), `shareMany`,
  `writeFills` for the full palette row, then draw-state insert. They do not build per-label
  `RenderChange` snapshots. Scale, rotation, non-zero anchors, z-index, stroke, and trusted runs
  stay on the object path. Already-rendered storms stay on the content lane (`writePositions`).
- Draw instances are 8 bytes: store glyph index plus palette index. Shaders `texelFetch` rect, UV,
  and metadata from an RGBA32F prototype texture packed from the unique store. CPU compact and
  WebGPU scatter write two uints per visible glyph. The 24-byte store is not the instance buffer.
  Palette growth rewrites the existing proto texture so Pixi's first-upload snapshot cannot drop
  dirty glyphs after texel 0. Replacing that `Texture` leaves vertex fetches empty. One
  `GlyphMesh`, insertion order and z stay. One mesh per unique string is still rejected.
- Compute-cull ring-only unique misses stay unshaped. Tight-view unique still layouts and
  rasters in the seeing commit. Ring intern hits and same-commit copies of a tight unique
  string still finish that turn. No leftover admission wave.
- Unique admit groups prepare in parallel. A tight-view wave of distinct strings is not the
  sum of each string's layout and raster. Writes stay serial after that wave.
- Same-size TinySDF misses share one FontFace wait and serialize canvas plus EDT. EDT stays
  per glyph. A miss burst does not start N `FontFace.load()` calls for one family.
- Position storms slide spatial AABBs through `translateMany`. Size is unchanged, so the
  size class stays. Only a cell-boundary crossing rebuckets. `updatePositions` and
  same-text `updateTextPositions` collect packed deltas and call it once.
- Unique admit groups that share a `style.fill` identity write one `writeFills` column.
  Instance writes stay per string. Distinct fills stay separate writes.
- Optional `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) bakes a coarse VGA 8×8 SDF of printable
  ASCII. Hosts pass it as `rasterizerOptions.prebuilt`. A single-scalar miss retries
  `glyphId: 0` so HarfBuzz ids crop that page. The core gzip graph still has no default pages.
- TinySDF and MSDF intern one physical field at `distanceFieldMinFontSize`. Logical sizes
  that clamp to that size share pixels and keep their own `rasterScale`. TinySDF also shares
  across HarfBuzz ids for the same `glyphText`. A first unseen CJK at one size still
  generates once.
- Empty-ink scalars (White_Space except Ogham U+1680, plus default ignorables) skip
  raster and instance quads. Layout advance and label AABBs stay. Trusted runs, ligatures,
  and shared-cluster marks still generate. An empty TinySDF mask skips both EDTs.
- Atlas pages bind as layers in two texture arrays. `vMode` selects R or RGBA. Compact
  walks split only on blend and z. Growing an array reallocates and recopies layers.
  Palette SSBO is still not started.

## Remaining slices, in order

1. **Tight-view unique raster.** A pan onto fresh unique text that is already on screen still
   layouts and rasters those glyphs in that commit. Admit groups no longer wait on each other
   during prepare. Shared-fill unique groups write one palette column. Layout count is still
   one per unseen string. TinySDF no longer starts one canvas plus FontFace load per glyph
   across a miss burst. Same-glyph logical sizes that clamp to `distanceFieldMinFontSize`
   share one field. Empty-ink scalars skip generation. EDT is still per unseen physical
   glyph that has ink. Known ASCII can skip that path when the host imports `uiSdfPrebuilt`.
   CJK and unseen ink still generate. Do not defer texel uploads for glyphs already
   instanced.
2. **Palette storage buffer.** Wave 3 leftover. Binding cost, not the zoom hitch. Atlas pages
   are already two `sampler2DArray` / `texture_2d_array` textures (R8 and RGBA8). Do not start
   this leftover with a palette SSBO: WebGL 2 has no storage buffers.
3. **Default baked pages.** The optional side export landed. Shipping those pages in the core
   gzip is still rejected. The core graph stays empty of alphabet pages.

Reject: drip-feed admission, `queryAll()` for compute-cull, BVH rebuilds on the 100k storm, and
replacing PixiJS with a compute 2D engine.

## Evidence

- Homepage traces `Trace-20260822T035924` and `Trace-20260822T033314` (working-set miss in
  `#prepare` / `#ensureGlyph` / `#buildInstances`).
- `expandWorkingSet` in `src/culling/computeCull.ts`.
- Language samples in `site/components/GlyphflowDemo.client.vue`.
- Shape cache in `src/layout/LayoutEngine.ts`. Atlas key cache in `RenderCoordinator.#ensureGlyph`.
