# Architecture

## Data flow

```text
application mutations
        |
        v
TextLayer -> TextStore + DirtyJournal -> SpatialIndex
        |                 |
        | commit          | visible slots
        v                 v
LayoutEngine -> HarfBuzz worker / Pixi bitmap layout
        |
        v
Glyph providers -> bounded GlyphAtlas
        |
        v
GlyphInstanceStore + TransformPalette
        |
        v
RenderSurface -> GlyphMesh -> WebGL 2 / WebGPU
```

## Ownership

`TextLayer` owns label state, `FontRegistry`, spatial state, render coordination, and renderer
resources created through `attach`. The renderer owns API-level GPU context lifetime. Optional
viewport and accessibility adapters own their listeners and DOM nodes.

Each resource follows one explicit destruction path. Layer destruction releases its worker, atlas,
textures, buffers, meshes, registry registrations, and spatial arrays. Sibling layers and sibling
applications keep independent resources.

## Dense state

`TextStore` stores numeric fields in typed-array columns and text/style references in parallel
arrays. Position and z-index stay `Float32`. Scale, rotation, alpha, and anchors are binary16.
Generation and source revision are `u16`. Occupied, visible, and the position-only kind share one
flag byte. A `TextId` encodes a store namespace, generation, and slot. Free slots receive a fresh
generation before reuse.

`DirtyJournal` coalesces content, transform, and style domains per slot. The dirty-slot list grows
with the pending wave and releases on publish. A commit publishes one monotonic label revision.
Camera-only commits preserve that revision.

## Layout and shaping

System and PixiJS bitmap fonts use `BitmapLayoutAdapter`. Binary fonts use HarfBuzz through a worker.
Fallback aliases expand recursively, and layout selects the first binary font with complete glyph
coverage before reaching the system stack. Both paths return compact `PositionedRun` data with glyph
IDs, clusters, positions, advances, line metadata, and bounds.

The default bitmap adapter, HarfBuzz worker shaper, and dynamic raster provider load through their
first-use async seams. A CPU-only layer and an unrendered scene keep these backends outside the core
startup path.

Language, script, direction, OpenType feature, and variation overrides live in a sparse side table
keyed by `TextId`. Labels sharing content and shaping inputs share one canonical asynchronous shape
result across commits.

Group membership and layout overrides use sparse side tables as well. `TextGroupId` values are
created independently by their owning layer. Group masks compose with label-local visibility before
spatial queries, rendering, hit testing, and accessibility synchronization. Basic vertical writing
converts the shared horizontal run into upright top-to-bottom columns before atlas instance creation.

Trusted glyph runs let an upstream layout system supply immutable typed arrays with explicit
ownership and revision stamps.

`RenderCoordinator` prepares accepted changes without a microtask per label. Cache hits and atlas
hits stay on the same turn. Duplicate strings share one prototype instance range. Draw instances
are an 8-byte `(prototypeGlyph, paletteIndex)` pair; shaders fetch the unique rect, UV, and
metadata. Compute-cull still instances an expanded working set for camera slack, but it only
layouts and rasters first-seen labels that intersect the tight draw view. The 0.25-viewport ring
may admit intern hits and same-commit copies of a tight unique string, up to
`culling.offscreenAdmitBudgetBytes` (default 65536, 32 bytes per off-screen label). Ring-only
unique misses stay unshaped. Deferred ring hits resume on a later commit that queries the ring
or when they enter the tight view. Atlas texel uploads for already-instanced glyphs stay ungated.
Unique admit groups prepare in parallel so a tight-view wave is not the sum of
each string's layout and raster.
`tinySdf: true` builds those HarfBuzz glyphs as a local SDF from the canvas mask.
Same-size TinySDF misses share one FontFace wait and serialize canvas plus EDT. EDT stays per
unseen physical glyph that has ink. Empty-ink scalars skip raster and instance quads. Logical
sizes that clamp to `distanceFieldMinFontSize` intern one field.
`rasterizerOptions.prebuilt` serves packed pages first so a known alphabet miss is a crop, not a
generator start. A single-scalar miss retries `glyphId: 0` so HarfBuzz ids can still crop a
family page. A miss whose physical size matches a baked field crops that field and interns it,
so clamp-equivalent logical sizes do not start TinySDF or MSDF. Optional
`pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`, `charsetSdfPrebuilt`) bakes
a coarse VGA ASCII page or host-painted charset pages outside the core ESM graph. `culling.lod` drops labels whose projected font height is below one pixel.
Off-screen unique residents stay unshaped until the camera reaches them. On-screen text appears
in that commit. There is no leftover rAF admission wave.

## Atlas and instances

`GlyphAtlas` stages raster results and publishes a complete generation at a frame boundary. Visible
glyphs pin entries. LRU eviction reclaims unpinned entries under a fixed allocation ceiling. Pages
pack with Skyline Bottom-Left, a waste map for eviction holes, and a next-fit shelf when the next
glyph matches the current row height. Live path keys are packed integers (family intern, glyph id,
size bucket, weight class, mode, revision). String keys remain valid for tests, prebuilt pages, and
identities that cannot pack.

Binary-font rasterization consumes the exact HarfBuzz glyph ID. Direct cmap hits reuse the original
font bytes; contextual, ligature, and language-localized glyphs receive a temporary cmap mapping for
the character-based MSDF generator. A bounded worker pool runs in parallel and serializes operations
inside each worker so mutable font state remains isolated. Small distance fields rasterize at a
48-pixel minimum and carry a physical-to-logical scale through atlas entries and packed instances.

Each live glyph store record uses 24 bytes (four `f16` local-rect components, packed UVs, a
prototype palette word, and metadata). Draw instances are 8 bytes: the store glyph index and the
label palette index. Shaders fetch the store from an `rgba32float` prototype texture and unpack
the rect with `unpackHalf2x16` / `unpack2x16float`. The published instance ceiling stays 32 bytes
until new artifacts exist. Each
fill-only label transform uses 32 bytes (two
`rgba32float` texels). Stroke and drop shadow occupy one extra texel after the core region when
any label uses those effects. The instance free list is a power-of-two segregated first-fit.
Dirty-range adapters coalesce a 256-byte accepted gap, collapse after eight ranges, and promote to
the live span when dirty bytes reach 75% of that span. They then issue partial WebGL buffer updates
or budgeted WebGPU queue writes.

## Rendering

`RenderSurface` binds two `sampler2DArray` / `texture_2d_array` textures: R8 for sdf/alpha and
RGBA8 for msdf/color. Each atlas page is a layer among same-format pages. Visible instances split
by z order and blend mode only. Equal-z labels retain insertion order. `GlyphMesh` selects the
array from `vMode` and the layer from instance metadata. Two array textures plus the vertex
transform palette and the prototype texture stay inside the WebGL 2 minimum texture-unit budget.

WebGPU devices that expose at least one vertex storage binding keep the 32-byte fill records in
a storage buffer. Vertex WGSL reads `uTransforms[slot * 2]`. The storage-path mesh binds that
name at group 2 binding 3 and does not keep a leftover `uTransformTexture` resource. The path
stays `"texture"` until the storage table is registered with Pixi. After the first full upload
that table is the live draw source for x/y. Position-only storms skip the CPU 32-byte scatter
and upload one packed move-command buffer (`slot`, `x`, `y`); a compute pass writes
`transforms[slot * 2].xy`. Camera-only frames do not gather the table. WebGL and devices with
`maxStorageBuffersInVertexStage` 0 keep the texture palette. `requestComputeCullGpu()` raises that
vertex-storage limit when the adapter allows it. Hit-test stays on the aliased store columns.
Storage-backed viewport compute-cull records store local boxes; the cull shader adds the live
palette origin, so position storms upload zero cull-record bytes. Texture-backed viewport records
store world AABBs and receive CPU patches. GPU-scene records store absolute AABBs and receive mover
patches in the fused palette compute pass.

## Culling and camera integration

`SpatialIndex` keeps a local box, visibility, z order, and stable insertion order. `TextLayer`
aliases `TextStore` x/y as the origin, so world bounds are derived. Query output uses
caller-owned typed arrays. `ViewportBinding` converts pixi-viewport camera corners through the layer
transform, coalesces the current input burst, updates culling bounds, and publishes visibility work.

WebGPU compute culling keeps two sets. The CPU grid shapes and instances labels from an expanded
working viewport. A stable prefix sum and scatter compact those resident glyphs against the tight
padded draw viewport. Camera motion inside the working viewport does not query the grid or write the
instance store, and it skips the first-seen ring query while the draw viewport stays inside the last
prepared ring. It still queries the tight view so a deferred unique miss is admitted when it
crosses on screen. Crossing the working-set edge refreshes residency. GPU mirrors sync incrementally:
commits upload dirty prototype texels and changed or appended cull records, keyed by a
draw-list epoch that appends preserve; re-sorts, removals, and cull-path fallbacks force a full
repack or resync. Scatter writes 8-byte draw records and does not read the store.

The direct `GlyphMesh` rebinds its instance attributes to the compact buffer and uses an indexed
indirect draw. The encoder hook checks geometry ownership and is removed when the pass is
destroyed. WebGL, missing devices, disabled compute culling, oversized storage buffers, and
multi-segment meshes retain the tight CPU-grid path. A single-bank mesh stays on the compute path
when CPU instance order is not spatial order. PixiJS devices keep the 128 MiB storage-binding default;
`requestComputeCullGpu()` raises those limits to the adapter maximum, including
`maxStorageBuffersInVertexStage` when the adapter exposes a non-zero value.

Collision selection consumes monotonic candidate slots through `selectRankedCandidates`, whose
admission order proof skips the rank scratch sort. Contiguous candidates with identical padded
bounds share cached identical-bound run lengths, so one accepted or rejected leader settles the rest of that run.
Packed collision-record writes invalidate every touched run; structural changes retire the full
cache. The selected output receives a final draw-order sort and preserves its stable selection hash.

### Full GPU-scene residency

`culling.residency: "gpu-scene"` selects a separate, explicit WebGPU path for a bounded scene. The
default `"viewport"` path keeps the general label model. `GpuSceneCompiler` retains up to 64 exact
rendered prototypes and 8 canonical paints, partitions labels into at most 512 prototype/paint
columns, uploads every typed transform row, and builds one 32-byte absolute-AABB cull record per
slot. Record word 7 indexes a prototype-local `vec4<f32>` bounds table. The compute pass owns the
resident record buffer and exposes its buffer/epoch binding to the storage-palette pass.

The structural submission order is:

1. ensure cull capacity and upload setup, append, remove, or repack record dirties;
2. ensure the local-bounds table and bind the current resident record buffer epoch;
3. dispatch fused palette/AABB position moves;
4. dispatch stable compute culling and the indexed indirect draw.

`WebGPUFrameTransaction` stages every palette slice in commit order and coalesces each owner's cull
work to its latest viewport. Pixi's `renderStart` hook snapshots all owners, encodes every palette
stage followed by every cull stage into Pixi's active command encoder, and then opens the existing
render pass. Pixi's `postrender` performs the product submission and completes the staged work. A
steady resident camera or position frame therefore advances one fused transaction submission and
zero standalone submissions. Capacity growth, resource retirement, and recovery may flush staged
work through the counted standalone path before a new epoch begins.

The compute and palette passes scope every resource and queued callback to one live `GPUDevice`
identity and pass epoch. `WebGPUFrameTransaction` also scopes staged work to the current Pixi command
encoder epoch. Device replacement rebuilds pipelines, storage, the indirect Pixi buffer, and
renderer hooks. Encoder replacement cancels encoded work in the retired epoch and requeues pending
work on the replacement encoder. Late lifecycle callbacks release their captured resources while
current-epoch callbacks alone publish success or failure. Resident recovery retransmits local
bounds when palette full-sync state outlives the scene snapshot's structural dirty flag, then binds
the replacement cull-record epoch.

Camera-only commits start at step 4 with a refreshed viewport uniform. They skip the spatial query,
admission collector, render coordinator, and cull-record upload. Position-only commits with sorted,
unique, strictly contiguous active slots queue one 8-byte exact-f32 `x`/`y` command per slot. Their
16-byte header carries `baseSlot` and `count`, producing exact uploads of 80,016 bytes for 10,000
movers and 800,016 bytes for 100,000 movers. Sparse, reordered, duplicate, and holed inputs use the
indexed 12-byte `slot`/`x`/`y` fallback with last-write-wins identity. The fused pass writes the GPU
transform origin and derives its absolute AABB from indexed local bounds. CPU spatial rebucketing
records those slots in a typed journal. Bounds reads, hit tests, CPU culling, and resident fallback
flush the journal first.

Monotonic appends that stay within the retained 64-prototype / 8-paint compiler extend the record
high-water mark. Removes set `instanceCount = 0` tombstones. Slot reuse and changes outside the
bounded fill-only lane retire the resident generation and route the next commit through viewport residency. Detach,
reattach, and destruction follow the layer render-lifecycle epoch, so each resident buffer and
palette binding belongs to one renderer destination.

### Map symbol-continuity laboratory

The `pixi-glyphflow/advanced` side entry retains one logical symbol record across scene, camera,
zoom, tile, and collision revisions. A frame may submit several candidate keys and anchors for the
same logical key. Selection uses f32 priority descending, retained-candidate preference, insertion
order ascending, then typed candidate and anchor order. Source presence and collision placement use
separate frame epochs, so a continuously sourced collision loser keeps its continuity id and anchor
history while its visual phase fades.

Each frame is a staged transaction. Provisional ids stay hidden from committed reads; reclaimed
tombstones carry an undo snapshot; `abortFrame()` restores arrays, maps, queues, counters, and id
allocation. `endFrame()` preflights every touched invariant before the synchronous commit scan.
Fade transitions, source-retention deadlines, typed logical/candidate/anchor identity, f32 priority,
per-symbol revisions, and bit-level timing state participate in the deterministic hash. The index
has an explicit reserve path, a 1,048,576-record hard ceiling, and terminal u32 id exhaustion.
The default manual hash policy keeps complete hashing at explicit inactive checkpoints;
`every-frame` folds identical hash bytes into the commit/absence scan.
Product integration waits for the revisioned Scene WAL/delta source so absent-symbol detection can
arrive as patches instead of a 100k full reconciliation scan.

### Sparse glyph-strip laboratory

The `pixi-glyphflow/outline` side entry can encode an outline coverage bitmap into a versioned
4x4-tile `SparseStripGlyph`. Row-major records retain horizontal tile spans; solid spans use an
implicit coverage sentinel, boundary tiles retain 16 coverage bytes, and transparent tiles consume
zero records. A two-pass typed builder counts exact record and boundary payload sizes before its
single allocation. Coverage stays independent from color so one retained glyph can be recolored.

`SparseGlyphStripCache` owns defensive copies and applies a byte-bounded LRU. Its key covers every
raster-affecting field, including padding and AA mode. Oversized candidates fail preflight while
resident entries keep their recency and bytes. The WebGPU adapter concatenates headers, tile-row
prefixes, strip records, and coverage into four storage buffers, then writes a batched premultiplied
RGBA8 texture through an 8x8 compute kernel. Atlas geometry, metadata offsets, and allocation
products pass u32 and safe-arithmetic preflight. An x-axis sweep with a compressed range-max tree
validates disjoint placements near O(N log N). Requests then form stable exact-workgroup-size
dispatch groups, keeping padded invocations proportional to each glyph. The packed storage and
copied quad metadata become an owned snapshot before asynchronous pipeline compilation. The result
implements the existing `OutlineColorAtlas` seam. Device limits, shader compilation, queue
completion, destruction races, and exact-once GPU resource release have explicit outcomes. Product
routing remains gated by sustained atlas-pressure, stable-atlas-hit, and whole-frame tail evidence.

## Diagnostics

`TextLayer.stats` allocates one immutable snapshot at read time. It reports CPU capacity, dirty
domains, revisions, shaping, visible labels, spatial queries, renderer backend, cull path,
palette path, draw calls, glyphs, pending glyphs, pending admissions, upload bytes, and last-commit layout,
instance-write, palette-write, spatial, and upload milliseconds. `visibleLabelCount` is the instanced
working set. On the CPU grid that set is the tight padded viewport. On compute cull it is the
expanded residency query. The getter does not walk the grid.

Resident diagnostics separate requested and active policy, stable fallback reason, active GPU
labels, prototype and paint counts, deferred spatial labels, cumulative cull-record upload bytes, and latest
successful setup duration. Transaction diagnostics report cumulative total, fused, and standalone
submissions. Per-frame deltas let a camera or position workload prove one fused product submission
and the intended resident path.
