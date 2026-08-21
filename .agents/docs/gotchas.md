# Paid traps

## CI Chrome does not draw `float16x4` instance attributes

Keep the 24-byte CPU layout (four `f16` local-rect components). Bind the rect as `uint32x2` and unpack in the shader with `unpackHalf2x16` / `unpack2x16float`.

`bun run test:browser` on CI Chrome drew 0 pixels when `GlyphMesh` used `float16x4` while the shaders declared `vec4`. ANGLE either skipped `HALF_FLOAT` instance attributes or rejected that type pairing. Palette index and metadata already use integer attributes; that path is proven.

Do not revert to 32-byte `float32x4` rects to make CI green.

## Compute culling cannot stay locked to last frame's compact mesh

The homepage million-label demo rasterizes unique glyphs after the first commit. Those late
instance ranges are not in spatial draw order, so the CPU path builds compact meshes. The first
Wave 3 eligibility check then treated a compact or multi-mesh surface as a permanent `cpu-grid`
veto. WebGPU camera frames never tried again, and the HUD kept reporting `cpu-grid`.

A single atlas bank can stay on the direct instance store. GPU scatter writes draw-state order
into the compact buffer. Only a true multi-segment scene or a fragmented store (`highWater` more
than twice the live instances) must keep the CPU compact path.

## Compute culling needs a larger CPU working set than its draw set

When culling has viewport bounds, never instance `SpatialIndex.queryAll()` for compute culling. A
million-label world can exceed the 16,777,216-glyph instance ceiling before the GPU removes
offscreen labels.

Do not instance only the tight draw viewport either. Every camera frame would cross the residency
edge and run the CPU grid again. Query the expanded working viewport with zero query padding, then
let compute culling compact those resident instances against the tight padded draw viewport.

## Live atlas keys omit `glyphText` when a glyph id is present

Packed identities are family intern + glyph id + size bucket + weight class + mode + font revision. Rasterize must use the same size bucket as the key. String keys stay valid for `atlas-pressure` (`glyph-${index}`), prebuilt pages, non-BMP text with glyph id 0, and unusual weights. Do not put `glyphText` back into the packed key, and do not fall back to `float16x4` instance attributes.

## Do not fail CI on the 1.1.0 atlas-pressure frame

`atlas-pressure` frame p95 is 638.50 ms in the published 1.1.0 artifact. Wave 1 changed the packer in source, but the committed artifact is still the old run. Measure the frame p95; do not add a 16.67 ms fail gate against that file. Same rule as the deferred 40 KiB gzip check.
