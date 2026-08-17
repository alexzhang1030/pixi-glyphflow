# Paid traps

## CI Chrome does not draw `float16x4` instance attributes

Keep the 24-byte CPU layout (four `f16` local-rect components). Bind the rect as `uint32x2` and unpack in the shader with `unpackHalf2x16` / `unpack2x16float`.

`bun run test:browser` on CI Chrome drew 0 pixels when `GlyphMesh` used `float16x4` while the shaders declared `vec4`. ANGLE either skipped `HALF_FLOAT` instance attributes or rejected that type pairing. Palette index and metadata already use integer attributes; that path is proven.

Do not revert to 32-byte `float32x4` rects to make CI green.

## Live atlas keys omit `glyphText` when a glyph id is present

Packed identities are family intern + glyph id + size bucket + weight class + mode + font revision. Rasterize must use the same size bucket as the key. String keys stay valid for `atlas-pressure` (`glyph-${index}`), prebuilt pages, non-BMP text with glyph id 0, and unusual weights. Do not put `glyphText` back into the packed key, and do not fall back to `float16x4` instance attributes.

## Do not fail CI on the 1.1.0 atlas-pressure frame

`atlas-pressure` frame p95 is 638.50 ms in the published 1.1.0 artifact. Wave 1 changed the packer in source, but the committed artifact is still the old run. Measure the frame p95; do not add a 16.67 ms fail gate against that file. Same rule as the deferred 40 KiB gzip check.

## Compute cull packs after spatial writes and does not use Pixi `drawIndexed`

Pack cull records after `spatial.set` so position commits do not upload stale AABBs. Pixi `GpuEncoderSystem.draw` issues `drawIndexed`, not `drawIndexedIndirect`; the compute pass writes indirect args and a shared encoder hook rebinds instance attributes to the compact buffer for tracked `GlyphMesh` geometries. Multi-bank compact meshes stay on the CPU draw path. Do not atomic-append visible text; prefix-sum then scatter preserves z then insertion order.

## Compute cull must not `queryAll` the million-label world

`GlyphInstanceStore` caps at 16,777,216 glyphs. The documentation site keeps 1,000,000 multilingual labels; uploading every resident overflows that ceiling and the demo dies with `Renderer setup failed`. The CPU hash grid still selects who is shaped and instanced. GPU compact only sees that viewport working set. Do not skip the grid walk on camera frames, and do not treat `cullPath === "compute-cull"` as permission to keep offscreen labels in the coordinator.
