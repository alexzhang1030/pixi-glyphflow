# Paid traps

## CI Chrome does not draw `float16x4` instance attributes

Keep the 24-byte CPU store layout (four `f16` local-rect components). Shaders fetch those bits from
the prototype texture and unpack with `unpackHalf2x16` / `unpack2x16float`. Draw instances are two
`uint32`s (`aProtoIndex`, `aPaletteIndex`).

`bun run test:browser` on CI Chrome drew 0 pixels when `GlyphMesh` used `float16x4` while the shaders
declared `vec4`. ANGLE either skipped `HALF_FLOAT` instance attributes or rejected that type pairing.
Integer attributes and RGBA32F + `floatBitsToUint` are the proven path. Do not bind the prototype
as `RGBA32UI` / `usampler2D` to "skip" the bit cast. Do not upload raw unorm16 UV words or the
metadata uint through RGBA32F: `0xFFFFFFFF` and `ACTIVE | high raster` are NaN bit patterns, and
the GPU canonicalizes them. Pack UV as f16 pairs and split metadata into two 16-bit integer floats.
Do not size proto fetches with a `uPrototypeWidth` uniform: the first stroke grows the palette and
Pixi rebuilds `glyphUniforms` as the two floats it already knows (`uPaletteWidth`, `uEffectBase`).
A third float is dropped, width becomes 0, and every fetch hits texel 0. Read
`textureSize` / `textureDimensions` instead. Re-bind `uPrototype` after palette init and again on
each mesh render. `setPaletteTexture` alone is too early; Pixi overwrites that slot when it
initializes the new palette texture.

WebGL `texSubImage2D` of an `rgba32float` range must pass a `Float32Array` whose `byteOffset` is
0. ANGLE / SwiftShader ignore the view offset and read from the start of the underlying buffer.
A dirty proto upload for store glyph 1 then writes glyph 0 (often cleared, `isActive` false) onto
the live texel. `packedFloatTexelView` copies the range first. Do not pass `data.subarray(...)`
straight to `texSubImage2D`.

A position storm's first dirty palette write is the first GPU rewrite after
`initializeTexture` (full `texImage2D`). Sixteen sparse movers publish eight 624-byte bands.
`texSubImage2D` of those bands blanks the canvas while CPU slots stay live — including a packed
1024-wide row at `x = 0` with `UNPACK_*` reset and `glError` 0. A second `texImage2D` of the
same GL texture object (`sameResource: true`, 1024×2048, 32 MiB, `glError` 0) also blanks.
First Pixi `initializeTexture` / `getGlSource` still paints. Experiment M kept glyphs by
consuming those ranges and skipping the WebGL rewrite. Experiment O unbinds the palette from
each mesh (`unbindPaletteTexture` → `Texture.EMPTY`) and from every GL `TEXTURE_2D` unit
(`renderer.texture.unbind` plus a combined-unit walk), then dirty-`texSubImage2D`s the same
object and rebinds through `#bindMeshSources`. Do not call `source.update()` here: Pixi's
buffer uploader takes `texSubImage2D` when the GL size already matches. Do not create a new
`BufferImageSource` / `Texture`. WebGPU keeps dirty rectangles. Proto dirty rects still go
through `uploadFloatTextureRanges`.

The first proto `initializeTexture` uploads whatever `highWater` is at that moment (often glyph 0
only). Three appearance glyphs still fit in one 1024-wide row, so the texture size does not grow
and later glyphs live on the GPU only through dirty rects. Growing the palette recreates a vertex
texture and Pixi re-inits sibling sources from that first upload, so protoIndex ≥ 1 becomes
inactive. After a palette buffer replace, rewrite the live store into the existing proto pixels
and upload that same texture (`source.update()` plus a full float range write). Do not create a
new `BufferImageSource` / `Texture` and `destroy` the old one: readPixels of the replacement
looks fine, but vertex `texelFetch` returns zeros, the instance rect collapses, and
W→AB→W plus stroke draws 0 pixels. A first-stroke-only label stays on protoIndex 0 and hides
this. Rebuild the mesh if you want, it does not fix the empty fetch.

Do not revert to 32-byte `float32x4` rects to make CI green. Do not bind the 24-byte store as the
instance buffer: after `share`, `highWater` is unique glyphs and their baked palette is the
prototype's.

## PixiJS WebGPU devices keep the 128 MiB storage binding default

PixiJS `requestDevice()` does not raise `maxStorageBufferBindingSize`. The core default is
134,217,728 bytes. A million-label homepage working set rounds the instance storage buffer to
268,435,456 bytes. Binding it fails even when the adapter allows ~4 GiB.

Call `requestComputeCullGpu()` and pass `{ gpu }` into `Application.init`. The helper copies the
adapter's `maxStorageBufferBindingSize` and `maxBufferSize`. It also copies
`maxStorageBuffersInVertexStage` when that adapter limit is greater than 0. The WebGPU core
default for vertex storage bindings is 0. Without the raise, the vertex stage cannot bind the
palette storage buffer and the layer stays on the texture path. If a compute-cull buffer still
exceeds the live device limit, that pass falls back to `cpu-grid` instead of submitting an
invalid bind group.

## WGSL rejects `from` as an identifier

`CreateShaderModule` failed on `let from = …` in the compute-cull scatter pass. Tint treats `from`
as reserved. Use `src` / `dst`. Do not name locals `from` or `to`.

## A compact mesh is not a permanent compute-cull veto

Late glyph allocation leaves instance ranges out of draw order, so the CPU path builds compact
meshes. Do not read that shape as `cpu-grid` forever. One blend/z group keeps one `GlyphMesh`
(two array textures). GPU scatter writes 8-byte draw-state-order refs. Multi-segment scenes and a
store with `highWater` more than twice the live instances stay on the CPU compact path.

## Pixi BufferImageSource cannot upload 2d-array layers

`viewDimension: "2d-array"` plus `arrayLayerCount` allocates a WebGL `TEXTURE_2D_ARRAY` / WebGPU
array texture. Pixi's `buffer` uploaders still call `texImage2D` / `writeTexture` at `z = 0` for
one 2D slice. Set `uploadMethodId` to something else so `getGlSource` uses `texImage3D` (empty
array) and `getGpuSource` skips the 2D buffer write. Do not call `source.update()` on atlas
arrays. Write layers with `texSubImage3D` / `writeTexture` at `origin.z = layer`. WebGPU
`writeTexture` rejects a `bytesPerRow` that is not a multiple of 256 — pad narrow glyph rects
(`packGpuTextureRows`). WebGL rejects `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
on 3D / array uploads (`INVALID_OPERATION`); clear both around the write. GLSL ES 3.00 needs
`precision highp sampler2DArray` or the fragment program fails to compile and draws 0 pixels.
R8 (sdf/alpha) and RGBA8 (msdf/color) cannot share one array. Growing an array mid-commit
leaves the replaced `AtlasArray` in that frame's dirty set. `getGlSource` on the destroyed
source reads `source.style === null` and throws `addressModeU`. Skip destroyed arrays;
rebind live meshes to the next source before `texture.destroy(true)`. Bind `uSampler` to an
owned `TextureStyle`, not `source.style`. WebGL 2 has no storage buffers; keep the transform
table as a texture there. Do not build a second feature-complete stack.

## WebGPU palette storage cannot bind unless vertex storage is requested

PixiJS `requestDevice()` leaves `maxStorageBuffersInVertexStage` at the core default of 0.
`requestComputeCullGpu()` raises it when the adapter allows at least one vertex storage binding.
`resolvePalettePath` stays on `"texture"` when the live device still reports 0, when the adapter
is WebGL, or when the palette byte length exceeds `maxStorageBufferBindingSize`.

The storage table uses the same 32-byte fill records as the texture (`array<vec4<f32>>`, two
`vec4`s per slot). Position storms skip `writePositions`. The CPU submits the mover slot list
and a dirty origin-column span (or per-slot origin writes when the span is sparse). A compute
`patch_xy` writes `transforms[slot * 2].xy` from the store x/y columns. Camera-only frames
submit neither a slot list nor a palette gather.

A storage-buffer rebuild or geometric grow must `refreshOrigins` from the live store columns
before a full upload. Mover-only storms leave CPU texels stale. Uploading that table without
the refresh clobbers GPU-patched x/y. Hit-test keeps using the aliased store columns.

## Compute culling needs a larger CPU working set than its draw set

When culling has viewport bounds, never instance `SpatialIndex.queryAll()` for compute culling. A
million-label world can exceed the 16,777,216-glyph instance ceiling before the GPU removes
offscreen labels.

Do not instance only the tight draw viewport either. Every camera frame would cross the residency
edge and run the CPU grid again. Query the expanded working viewport with zero query padding, then
let compute culling compact those resident instances against the tight padded draw viewport.

Do not treat a position storm as a residency refresh. A Chrome trace of the homepage demo spent
most of the storm frame in `RenderSurface.#buildDrawSegments` and `GlyphInstanceStore.getRange`
(`Object.freeze({ ...range })` per label) because `hasLabelChanges` re-queried the working set and
repacked every draw state. Position-only commits inside the working set patch resident AABBs and
the palette. Re-query only on show/hide/add/remove or when the camera leaves the working set.

`getRange` must return the live range. Copying and freezing it on every pack or segment walk is the
hot leaf.

Compute scatter no longer reads the store. Upload dirty store bytes into the prototype texture.
Content edits can relocate a range, so record patches must rewrite offset and count, not only the
AABB. Size `instances_out` from logical `activeInstances * 8`, not `highWater * 24`. Shared
duplicates make `highWater` much smaller than the visible glyph count.

`ComputeCullPass.ensureCapacity` pushes the CPU-side indirect args (instance count 0) to the GPU.
An idle compute frame must return before touching it, or the previous dispatch's draw count is
clobbered without a new dispatch to restore it.

Leaving the working set must not delete the run, instances, or palette. A later homepage trace
spent the pan windows in `RenderCoordinator.#prepare` / `#ensureGlyph` / `#buildInstances` because
re-entry used `ALL_DIRTY` after a full remove. Drop the draw state and cull records only. `remove()`
still tears the slot down. WebGL keeps the tight evict.

## Do not drip-feed on-screen labels

Budgeted first-seen waves (`prepareBudgetMs` / `prepareWave` / leftover rAF) hid most of a new
working set and filled it in over later frames. That is rejected: on-screen text must appear in
the commit that first sees it.

The homepage demo follows that rule with a two-phase allocate. It creates every label that
intersects the first camera working set, commits once so that text appears, then allocates the
rest of the million off that view. Do not split the first on-screen set across later commits.
Pass `rendering.transformOptions.initialCapacity` at the million-label size before the first
commit. A first commit on a small palette then a 1M grow replaces the palette `BufferImageSource`;
the next draw fetches empty proto/palette texels and the canvas goes black while `visibleLabelCount`
stays honest.

The hitch those waves were papering over is still real. A homepage pan after a working-set miss
spent 1.89s then 2.65s in layout and raster because compute-cull prepared the padded working set,
not the tight draw view. `retainResources` only helps revisits. New glyphs still need layout and
raster. Do that for labels that intersect the tight draw view. Cache hits in the 0.25-viewport
ring are eligible on the same turn, then gated by `offscreenAdmitBudgetBytes` (32 bytes per
off-screen intern-hit label). Off-screen working-set unique misses stay unshaped until the camera
reaches them.

Do not bring back leftover rAF, `pendingAdmissionCount`, or animation-frame continue. That path
also remirrored the instance buffer every wave and made compute-cull slower than `cpu-grid`.
Resume deferred ring hits by querying the prepare ring on a later commit, or when a leftover
enters the tight view. Do not gate atlas texel uploads for already-instanced glyphs.

Compute-cull must not raster a unique miss that only intersects the prepare ring. The tight
draw view still finishes in that commit, including unique text. Ring copies of a string that
already has an intern, or that has a tight member in the same group, are eligible that turn
and then spend `offscreenAdmitBudgetBytes`. Skip the
rendered-epoch stamp on a dropped ring unique, or a later camera move will think it is done.
Camera motion that stays inside the last prepared ring must still query the tight view for
those leftovers. If the last commit deferred off-screen intern hits, query the prepare ring
again so the budget can resume. Skipping the whole first-seen scan there was only safe when
the ring was fully prepared.

## TinySDF binary fonts need FontFace

`tinySdf: true` draws the glyph with canvas and runs a local EDT. Binary families are installed
through `FontFace` from the registered bytes. Without `FontFace` (or a document font set) the
canvas would paint a fallback family. Keep `@zappar/msdf-generator` for `mode: "msdf"` and for
hosts that cannot install a face.

Intern `#ensureDocumentFont` / `#installDocumentFont` on family. A tight-view miss burst must
not start N `FontFace.load()` calls for one family. Same-size misses share a microtask batch
so they wait on that load once, then serialize canvas plus EDT. Do not run EDT on a
multi-glyph sheet. Neighbors corrupt distances. Do not reuse one canvas across awaits unless
the work is serialized after fonts are ready.

Intern the physical field at `max(fontSize, distanceFieldMinFontSize)`. A 16px and 32px
request of the same glyph must not run EDT or MSDF twice. TinySDF keys omit `glyphId`
because canvas paints `glyphText`; ligatures stay distinct texts. Sizes above the minimum
are separate physical rasters. Atlas entries stay per size bucket so instance
`rasterScale` stays honest. Do not put logical `fontSize` in the physical key.

Do not raster or instance a single White_Space or default-ignorable scalar. Those fields
sit below the 0.5 contour, so skipping the quad is pixel-identical. Keep Ogham U+1680 —
it is White_Space and often paints. Do not skip `source === "trusted"`, ligatures, or a
glyph that shares its cluster with a mark. Identify the scalar from `glyphKeys` or
`codePointAt(cluster)`; do not `Array.from` the remaining text on this path. An empty
TinySDF mask skips both EDTs and encodes zeros. CJK and other ink still generate.

## Prebuilt glyph keys omit font revision

`prebuiltGlyphKey` is family, glyph id, glyph text, rounded size, weight, and mode. A re-registered
family keeps the same page. Do not put `fontRevision` in the bake key. A page baked for different
bytes under the same family name is a product mistake, not a cache miss.

HarfBuzz `glyphId` values are font-specific. A family page keyed with `glyphId: 0` still hits
when the request is a single Unicode scalar. Ligatures and multi-scalar `glyphText` stay
exact-key only. A distance-field page also hits when `fontSize * (rasterScale ?? 1)` equals
`max(request.fontSize, distanceFieldMinFontSize)`. A 14px charset bake therefore crops a 13px
or 32px first sight. Do not rematch a native-size page (no `rasterScale`, or a different
physical size) onto a larger request — `uiSdfPrebuilt` at 16 px must not serve 32 px. Do not
put default pages on `src/index.ts` or `src/advanced/index.ts`.
`pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) is a side export: first call encodes a public-domain
VGA 8×8 set at 16 px only (`rasterScale` cannot be below 1). Later calls remap keys. This is
not production typography and is not wired into the homepage CJK demo.

`charsetSdfPrebuilt` bakes host text with the same TinySDF path. It does not ship CJK bitmaps.
Paint after `FontFace.load` or inject `rasterize`. Empty-ink scalars are omitted. Logical sizes
that clamp to `distanceFieldMinFontSize` store `rasterScale`. `mergePrebuilt` concatenates
family pages. The homepage demo bakes its language samples this way so first-seen CJK is a
crop. A host that bakes once at 14 px does not need a second bake for 13 px. Do not put those
pages on `src/index.ts`. Adopted prebuilt crops intern into the physical field table so a
later clamp size is a lookup, not a second crop.

## LOD remirrors only when labels cross one pixel

`culling.lod` uses `fontSize * scaleY * worldScaleY`. Zoom inside a working set does not remirror
the instance store unless a label crosses the one-pixel line. Position storms stay on palette
patches. A camera move that does refresh residency still keeps rendered position-only movers on
`writePositions`. Do not rebuild per-label snapshots for those slots. Do not treat every camera
frame as a residency refresh when LOD is on.

## Stamp the rendered epoch on unchanged visible labels

`#buildRenderChanges` stamps `#renderedEpochs[slot] = nextEpoch` for every resident it intends to
keep. `getDrawStates()` treats a stale epoch as an exit. Skipping `wasRendered && dirty === None`
before that stamp drops the unchanged sibling. The compositing fixture then keeps one normal mesh
after a z-raise instead of two.

Do not move the dirty-none continue above the epoch stamp. Off-screen unshaped working-set labels
still skip before the stamp so they never enter the draw set.

## Live atlas keys omit `glyphText` when a glyph id is present

Packed identities are family intern + glyph id + size bucket + weight class + mode + font revision. Rasterize must use the same size bucket as the key. String keys stay valid for `atlas-pressure` (`glyph-${index}`), prebuilt pages, non-BMP text with glyph id 0, and unusual weights. Do not put `glyphText` back into the packed key, and do not fall back to `float16x4` instance attributes.

## Budget checks fall back to the newest older formal artifacts

`benchmark:check` loads `results/browser-<workload>-<packageVersion>.json` when that file exists,
otherwise the newest older formal file for the same workload. Exploratory files and newer versions
than `package.json` are ignored. CI and `release:check` share that rule, so a version bump can
publish without renaming 1.1.0 measurements into 1.2.0 names.

`--require-current` still exists for a local gate that refuses a version with no matching files.
Do not turn it on in the publish workflow until the reference M1 Pro Chrome suite has been rerun.

## The browser benchmark page must stay free of node builtins

`benchmarks/browser/*` runs in Chrome through Vite. Any VALUE import from a module whose top level
touches `node:os` (or other node builtins) breaks the page before `__glyphflowBenchmark.done` is
set, and every browser workload then "times out" instead of failing loudly. Wave 0 did this by
importing `BENCHMARK_SCHEMA_VERSION` from `schema.ts` while `benchmarkRuntime()` lived there; the
suite was unrunnable until `benchmarks/runtime.ts` took the node-only half. Keep `schema.ts`
isomorphic; put node-only helpers in `runtime.ts`. Type-only imports are safe.

## Dirty uploads do not collapse leftover ranges into one first-to-last span

`DirtyRanges.publish` still merges a 256-byte gap and promotes when dirty bytes reach 75% of the
live span. After that, more than eight ranges land in equal-width bands of the first-to-last
interval. Two tight clusters stay two uploads. A uniform scatter that fills every band still
covers the live span and then hits the 75% whole-buffer rule. Do not restore the old single
first-to-last collapse to "keep the 8-range cap simple."

## Wiping the rendered set must dirty visibility

`#resetRenderedSet` (attach, detach, a failed render tail) clears rendered epochs. The next
commit has to walk residents again and rebuild draw states. That flag is `visibilityDirty`.
Do not treat a post-attach camera-only commit as a no-op just because no viewport exists.

## A commit with no viewport does not re-query every resident

`shouldRefreshResidency` used to treat a missing draw viewport as "refresh." `dynamic-counters`
and other `culling: false` workloads then called `queryAll` on every commit. Hide, show, remove,
and group visibility still set `visibilityDirty`. Creates do not: after the first residency
query they join through `#buildResidentDirtyChanges`, which admits unrendered dirty slots that
belong in the current set. Camera motion only matters once a draw viewport exists. Clearing a
previous viewport still refreshes, because the last instanced working set would otherwise stay
as the visible set.

Do not restore `visibilityDirty` on `create` / `createMany` when a coordinator exists. That
forces a full resident scan on every admission. Layers without a coordinator still flip the
flag so `visibleLabelCount` stays honest on the `rendering: false` path.

## Duplicate-string layout intern keys on face plus text

`RenderCoordinator` reuses a layout result for later labels that share family, size, weight, and
text (or the same interned style object). A font register or unregister bumps
`FontRegistry.stats.revision` and drops that intern so a new face cannot keep a stale run.

Shaping overrides, vertical writing, and italic faces skip the face map and use a slower extra
key. Do not intern trusted runs; those stay per-label.

Content-plus-position commits with default zero anchors patch palette x/y only. Non-zero anchors
still rewrite the fill record because packed anchors are `anchor * run bounds`.

Rendered labels that share one interned (text, style) pair take `applyContentLane` instead of
per-label snapshots. A mixed-text dirty wave, a shaping/layout/trusted side table, a non-zero
anchor, or a non-unit scale/rotation forces the object path for the whole content group. Do not
put first-seen unrendered slots on that lane: they still need a full palette write, which is
`applyAdmitLane` / `writeFills`, not `writePositions`.

`cloneMany` writes dest ranges from one source and bumps `segmentEpoch` once. Atlas key retain
adds the column's extra refs in one pass; dests that already share the prototype key array are
skipped. `placeMany` writes the shared local box and rehashes. World AABB is origin plus that
box. `TextLayer` aliases `TextStore` x/y as the origin, so a position storm writes x/y once.
`rehashCurrent` only rebuckets. Do not call `spatial.set` per content-lane slot. Do not call
`spatial.translate` per mover. Bind origins before insert, or only to grown copies of the same
values. Spill (oversize or unhashed) still goes through `#cellFor`. Standalone `translateMany`
still slides owned origins. Aliased origins already moved with the store, so `translateMany`
must not add the delta again.

Duplicate strings share one instance block. Do not bake dest palette indices into those bytes —
scatter and the CPU compact mesh write `paletteIndex` from the cull record or draw span (`slot`).
Draw records are `(storeGlyphIndex, paletteIndex)`. Shaders fetch rect/UV/metadata. One mesh per
unique string, instanced by label count, is not the default: it drops insertion order and explodes
when texts are unique.
`set` on a shared dest must copy-on-write. `clone` still copies exclusively; the live path uses
`share` / `shareMany`. `clone` / `cloneMany` of a dest that already shares must copy-on-write.
In-place write would patch the prototype palette. A second `share` onto dests that already point
at the source does not bump `segmentEpoch`. Compact unique offsets once; do not size the packed
buffer from the logical instance sum.

Rendered unit-transform labels skip the intake estimate rehash on `updateTextPositions` when a
coordinator will rewrite the box from the run at commit. Unrendered slots, non-zero anchors, and
scaled or rotated labels still reindex at intake so hit bounds do not wait on a path that may
not run.

`updateTextPositions` keeps the position-only transform kind even when text changes. After
layout, rewrite that box from the run: `placeMany` for the shared-string group; the object path
must still do it when `mask` includes Content. Skipping every `positionOnly` change leaves hit
bounds stale.

First-seen fill-only labels (visible, z 0, normal blend, alpha 1, unit transform, zero anchors,
no stroke or trusted run) group by interned (text, style) and take `applyAdmitLane`. Tight
first-seen must skip a slot already stamped for this commit, or a create-plus-camera frame
would admit the same slot twice. Scale, rotation, anchors, z-index, and effects stay on the
object path so `writeFills` does not lie about the fill record. Unique groups prepare together.
Do not `await` `#prepareSharedColumn` per group; that made a tight-view wave the sum of each
string. `atlas.commitFrame` and the instance/palette writes stay after that wave.
Unique groups that share a `style.fill` identity concatenate into one `writeFills`. Do not
merge instance columns or draw-state inserts across strings. Different fill objects that
happen to resolve to the same color stay two writes.

## Palette row uploads must stay 256-byte aligned when taller than one row

`uploadFloatTextureRanges` stacks contiguous full palette rows into one `texSubImage2D` /
`writeTexture`. WebGPU requires `bytesPerRow % 256 === 0` when `height > 1`. The default 1024
texel width is 16 KiB per row and is aligned. Narrow palettes (unit tests use width 8) stay
row-by-row so WebGL and WebGPU share the same rectangles. Do not pad `bytesPerRow` — the CPU
buffer has no row padding. WebGL `rgba32float` palette dirties blank on any GPU rewrite of
the bound texture after the first `initializeTexture` (`texSubImage2D` and a second
`texImage2D` of the same object). Experiment O unbinds the mesh sampler and GL units,
dirty-uploads the same object, then rebinds.

## Spatial queries with dense results must not pay the grid sort

Hash-grid output restores insertion order with an `O(K log K)` sort. A mid-zoom viewport at one
million labels returns hundreds of thousands of hits, and the sort alone cost ~37 ms per frame
(viewport-zoom 38.2 ms vs 9.0 ms on the 1.1.0 linear scan, same machine). `#shouldScanLinear` must
stay result-aware: it sums candidate bucket sizes with an early exit and falls back to the
ascending dense scan once candidates exceed a quarter of all entries. Do not judge the grid by
small-viewport queries alone; zoom sweeps cross the density spectrum.

## Do not fail CI on the 1.1.0 atlas-pressure frame

`atlas-pressure` frame p95 is 638.50 ms in the published 1.1.0 artifact. Wave 1 changed the packer in source, but the committed artifact is still the old run. Measure the frame p95; do not add a 16.67 ms fail gate against that file. Same rule as the deferred 40 KiB gzip check.
