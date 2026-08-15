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
arrays. A `TextId` encodes a store namespace, generation, and slot. Free slots receive a fresh
generation before reuse.

`DirtyJournal` coalesces content, transform, and style domains per slot. A commit publishes one
monotonic label revision. Camera-only commits preserve that revision.

## Layout and shaping

System and PixiJS bitmap fonts use `BitmapLayoutAdapter`. Binary fonts use HarfBuzz through a worker.
Fallback aliases expand recursively, and layout selects the first binary font with complete glyph
coverage before reaching the system stack. Both paths return compact `PositionedRun` data with glyph
IDs, clusters, positions, advances, line metadata, and bounds.

Language, script, direction, OpenType feature, and variation overrides live in a sparse side table
keyed by `TextId`. Labels sharing content and shaping inputs share one canonical asynchronous shape
result across commits.

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

Each glyph instance uses 32 bytes. Each label transform palette record uses 64 bytes. Dirty-range
adapters issue partial WebGL buffer updates or budgeted WebGPU queue writes.

## Rendering

`RenderSurface` groups visible instances by atlas page, z order, and blend mode. Equal-z labels retain
insertion order. `GlyphMesh` uses paired GLSL and WGSL shaders for MSDF, SDF, alpha, color, fill,
stroke, shadow, anchor, rotation, scale, and alpha behavior.

## Culling and camera integration

`SpatialIndex` keeps dense bounds, visibility, z order, and stable insertion order. Query output uses
caller-owned typed arrays. `ViewportBinding` converts pixi-viewport camera corners through the layer
transform, coalesces the current input burst, updates culling bounds, and publishes visibility work.

## Diagnostics

`TextLayer.stats` allocates one immutable snapshot at read time. It reports CPU capacity, dirty
domains, revisions, shaping, visible labels, spatial queries, renderer backend, draw calls, glyphs,
pending glyphs, and upload bytes.
