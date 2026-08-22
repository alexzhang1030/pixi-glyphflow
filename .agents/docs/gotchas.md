# Paid traps

## CI Chrome does not draw `float16x4` instance attributes

Keep the 24-byte CPU layout (four `f16` local-rect components). Bind the rect as `uint32x2` and unpack in the shader with `unpackHalf2x16` / `unpack2x16float`.

`bun run test:browser` on CI Chrome drew 0 pixels when `GlyphMesh` used `float16x4` while the shaders declared `vec4`. ANGLE either skipped `HALF_FLOAT` instance attributes or rejected that type pairing. Palette index and metadata already use integer attributes; that path is proven.

Do not revert to 32-byte `float32x4` rects to make CI green.

## PixiJS WebGPU devices keep the 128 MiB storage binding default

PixiJS `requestDevice()` does not raise `maxStorageBufferBindingSize`. The core default is
134,217,728 bytes. A million-label homepage working set rounds the instance storage buffer to
268,435,456 bytes. Binding it fails even when the adapter allows ~4 GiB.

Call `requestComputeCullGpu()` and pass `{ gpu }` into `Application.init`. The helper copies the
adapter's `maxStorageBufferBindingSize` and `maxBufferSize`. If a buffer still exceeds the live
device limit, compute cull falls back to `cpu-grid` instead of submitting an invalid bind group.

## WGSL rejects `from` as an identifier

`CreateShaderModule` failed on `let from = …` in the compute-cull scatter pass. Tint treats `from`
as reserved. Use `src` / `dst`. Do not name locals `from` or `to`.

## A compact mesh is not a permanent compute-cull veto

Late glyph allocation leaves instance ranges out of draw order, so the CPU path builds compact
meshes. Do not read that shape as `cpu-grid` forever. A single atlas bank stays on the direct
store; GPU scatter writes draw-state order. Multi-segment scenes and a store with `highWater` more
than twice the live instances stay on the CPU compact path.

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

Leaving the working set must not delete the run, instances, or palette. A later homepage trace
spent the pan windows in `RenderCoordinator.#prepare` / `#ensureGlyph` / `#buildInstances` because
re-entry used `ALL_DIRTY` after a full remove. Drop the draw state and cull records only. `remove()`
still tears the slot down. WebGL keeps the tight evict.

## Do not drip-feed on-screen labels

Budgeted first-seen waves (`prepareBudgetMs` / `prepareWave` / leftover rAF) hid most of a new
working set and filled it in over later frames. That is rejected: on-screen text must appear in
the commit that first sees it.

The hitch those waves were papering over is still real. A homepage pan after a working-set miss
spent 1.89s then 2.65s in layout and raster because compute-cull prepared the padded working set,
not the tight draw view. `retainResources` only helps revisits. New glyphs still need layout and
raster. Do that for labels that intersect the tight draw view, in one `Promise.all`. Off-screen
working-set residents stay unshaped until the camera reaches them.

Do not bring back per-frame admission leftovers, `pendingAdmissionCount`, or animation-frame
continue. That path also remirrored the instance buffer every wave and made compute-cull slower
than `cpu-grid`.

## Live atlas keys omit `glyphText` when a glyph id is present

Packed identities are family intern + glyph id + size bucket + weight class + mode + font revision. Rasterize must use the same size bucket as the key. String keys stay valid for `atlas-pressure` (`glyph-${index}`), prebuilt pages, non-BMP text with glyph id 0, and unusual weights. Do not put `glyphText` back into the packed key, and do not fall back to `float16x4` instance attributes.

## Do not fail CI on the 1.1.0 atlas-pressure frame

`atlas-pressure` frame p95 is 638.50 ms in the published 1.1.0 artifact. Wave 1 changed the packer in source, but the committed artifact is still the old run. Measure the frame p95; do not add a 16.67 ms fail gate against that file. Same rule as the deferred 40 KiB gzip check.
