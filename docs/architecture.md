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

## Atlas and instances

`GlyphAtlas` stages raster results and publishes a complete generation at a frame boundary. Visible
glyphs pin entries. LRU eviction reclaims unpinned entries under a fixed allocation ceiling.

Binary-font rasterization consumes the exact HarfBuzz glyph ID. Direct cmap hits reuse the original
font bytes; contextual, ligature, and language-localized glyphs receive a temporary cmap mapping for
the character-based MSDF generator. A bounded worker pool runs in parallel and serializes operations
inside each worker so mutable font state remains isolated. Small distance fields rasterize at a
48-pixel minimum and carry a physical-to-logical scale through atlas entries and packed instances.

Each live glyph instance uses 24 bytes (four `f16` local-rect components bound as `uint32x2`,
`unorm16x4` UVs, palette index, and metadata). Shaders unpack the rect with `unpackHalf2x16` /
`unpack2x16float`. The published instance ceiling stays 32 bytes until new artifacts exist. Each
fill-only label transform uses 32 bytes (two
`rgba32float` texels). Stroke and drop shadow occupy one extra texel after the core region when
any label uses those effects. Dirty-range adapters issue partial WebGL buffer updates or
budgeted WebGPU queue writes.

## Rendering

`RenderSurface` binds consecutive atlas pages in banks of eight. Visible instances split by texture
bank, z order, and blend mode, so page changes within a bank stay in one ordered instanced draw.
Equal-z labels retain insertion order. `GlyphMesh` selects the correct page per instance through
paired GLSL and WGSL shaders for MSDF, SDF, alpha, color, fill, stroke, shadow, anchor, rotation,
scale, and alpha behavior. Eight fragment textures plus the vertex transform palette fit the WebGL 2
minimum texture-unit budget and the WebGPU minimum sampled-texture limit.

## Culling and camera integration

`SpatialIndex` keeps dense bounds, visibility, z order, and stable insertion order. Query output uses
caller-owned typed arrays. `ViewportBinding` converts pixi-viewport camera corners through the layer
transform, coalesces the current input burst, updates culling bounds, and publishes visibility work.

## Diagnostics

`TextLayer.stats` allocates one immutable snapshot at read time. It reports CPU capacity, dirty
domains, revisions, shaping, visible labels, spatial queries, renderer backend, draw calls, glyphs,
pending glyphs, upload bytes, and last-commit layout, instance-write, palette-write, spatial, and
upload milliseconds.
