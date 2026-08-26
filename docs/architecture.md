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
layouts and rasters first-seen labels that intersect the tight draw view plus a 0.25-viewport ring.
`tinySdf: true` builds those HarfBuzz glyphs as a local SDF from the canvas mask.
`rasterizerOptions.prebuilt` serves packed pages first so a known alphabet miss is a crop, not a
generator start. `culling.lod` drops labels whose projected font height is below one pixel.
Off-screen residents stay unshaped until the camera reaches them. On-screen text appears in that
commit. There is no leftover admission wave.

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

`RenderSurface` binds consecutive atlas pages in banks of eight. Visible instances split by texture
bank, z order, and blend mode, so page changes within a bank stay in one ordered instanced draw.
Equal-z labels retain insertion order. `GlyphMesh` selects the correct page per instance through
paired GLSL and WGSL shaders for MSDF, SDF, alpha, color, fill, stroke, shadow, anchor, rotation,
scale, and alpha behavior. Eight fragment textures plus the vertex transform palette and the
prototype texture fit the WebGL 2 minimum texture-unit budget and the WebGPU minimum sampled-texture
limit.

## Culling and camera integration

`SpatialIndex` keeps dense bounds, visibility, z order, and stable insertion order. Query output uses
caller-owned typed arrays. `ViewportBinding` converts pixi-viewport camera corners through the layer
transform, coalesces the current input burst, updates culling bounds, and publishes visibility work.

WebGPU compute culling keeps two sets. The CPU grid shapes and instances labels from an expanded
working viewport. A stable prefix sum and scatter compact those resident glyphs against the tight
padded draw viewport. Camera motion inside the working viewport does not query the grid or write the
instance store, and it skips the first-seen ring query while the draw viewport stays inside the last
prepared ring. Crossing the working-set edge refreshes residency. GPU mirrors sync incrementally:
commits upload dirty prototype texels and changed or appended cull records, keyed by a
draw-list epoch that appends preserve; re-sorts, removals, and cull-path fallbacks force a full
repack or resync. Scatter writes 8-byte draw records and does not read the store.

The direct `GlyphMesh` rebinds its instance attributes to the compact buffer and uses an indexed
indirect draw. The encoder hook checks geometry ownership and is removed when the pass is
destroyed. WebGL, missing devices, disabled compute culling, oversized storage buffers, and
multi-segment meshes retain the tight CPU-grid path. A single-bank mesh stays on the compute path
when CPU instance order is not spatial order. PixiJS devices keep the 128 MiB storage-binding default;
`requestComputeCullGpu()` raises that limit to the adapter maximum.

## Diagnostics

`TextLayer.stats` allocates one immutable snapshot at read time. It reports CPU capacity, dirty
domains, revisions, shaping, visible labels, spatial queries, renderer backend, cull path, draw
calls, glyphs, pending glyphs, pending admissions, upload bytes, and last-commit layout,
instance-write, palette-write, spatial, and upload milliseconds. `visibleLabelCount` is the instanced
working set. On the CPU grid that set is the tight padded viewport. On compute cull it is the
expanded residency query. The getter does not walk the grid.
