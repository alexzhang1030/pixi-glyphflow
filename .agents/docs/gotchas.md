# Paid traps

## CI Chrome does not draw `float16x4` instance attributes

Keep the 24-byte CPU layout (four `f16` local-rect components). Bind the rect as `uint32x2` and unpack in the shader with `unpackHalf2x16` / `unpack2x16float`.

`bun run test:browser` on CI Chrome drew 0 pixels when `GlyphMesh` used `float16x4` while the shaders declared `vec4`. ANGLE either skipped `HALF_FLOAT` instance attributes or rejected that type pairing. Palette index and metadata already use integer attributes; that path is proven.

Do not revert to 32-byte `float32x4` rects to make CI green.
