import { describe, expect, test } from "bun:test";

import {
  allocatePrototypePixels,
  packF16,
  packHalf2x16,
  packedFloatTexelView,
  paletteUploadRects,
  premultiplyRgba8,
  webglFloatPaletteRects,
  prototypeByteRange,
  prototypeTextureLayout,
  unpackF16,
  unpackHalf2x16,
  GPU_TEXTURE_BYTES_PER_ROW_ALIGNMENT,
  gpuTextureBytesPerRow,
  packGpuTextureRows,
  writeDrawInstance,
  writePrototypeGlyphs,
} from "../src/render/pack";
import {
  GLYPH_DRAW_STRIDE,
  GLYPH_INSTANCE_STRIDE,
  GLYPH_PROTO_TEXTURE_WIDTH,
} from "../src/render/types";

describe("packHalf2x16", () => {
  test("round-trips unit rotation and integer anchors", () => {
    expect(unpackHalf2x16(packHalf2x16(0, 1))).toEqual([0, 1]);
    expect(unpackHalf2x16(packHalf2x16(1, 0))).toEqual([1, 0]);
    expect(unpackHalf2x16(packHalf2x16(-1, 20))).toEqual([-1, 20]);
    expect(unpackHalf2x16(packHalf2x16(20, 10))).toEqual([20, 10]);
  });
});

describe("packF16", () => {
  test("round-trips binary16-exact scales and alphas", () => {
    expect(unpackF16(packF16(0))).toBe(0);
    expect(unpackF16(packF16(0.5))).toBe(0.5);
    expect(unpackF16(packF16(1))).toBe(1);
    expect(unpackF16(packF16(-1))).toBe(-1);
  });
});

describe("packGpuTextureRows", () => {
  test("keeps 256-aligned rows as the same buffer", () => {
    const pixels = new Uint8Array(1024 * 2);
    const packed = packGpuTextureRows(pixels, 1024, 2, 1);
    expect(packed.bytesPerRow).toBe(1024);
    expect(packed.data).toBe(pixels);
    expect(gpuTextureBytesPerRow(20, 1)).toBe(GPU_TEXTURE_BYTES_PER_ROW_ALIGNMENT);
    expect(gpuTextureBytesPerRow(64, 4)).toBe(GPU_TEXTURE_BYTES_PER_ROW_ALIGNMENT);
  });

  test("pads a narrow r8 glyph so writeTexture can copy it", () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const packed = packGpuTextureRows(pixels, 3, 2, 1);
    expect(packed.bytesPerRow).toBe(256);
    expect(packed.data).not.toBe(pixels);
    expect(packed.data.byteLength).toBe(512);
    expect([...packed.data.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect([...packed.data.subarray(256, 259)]).toEqual([4, 5, 6]);
  });
});

describe("premultiplyRgba8", () => {
  test("scales RGB by alpha and leaves opaque pixels unchanged", () => {
    const source = new Uint8Array([255, 128, 64, 255, 255, 128, 64, 128, 10, 20, 30, 0]);
    expect([...premultiplyRgba8(source)]).toEqual([
      255, 128, 64, 255, 128, 64, 32, 128, 0, 0, 0, 0,
    ]);
  });
});

describe("paletteUploadRects", () => {
  test("stacks contiguous full rows when the row stride is 256-byte aligned", () => {
    const textureWidth = 1024;
    const texelBytes = 16;
    expect(paletteUploadRects(0, 200 * textureWidth * texelBytes, textureWidth)).toEqual([
      { x: 0, y: 0, width: 1024, height: 200, texel: 0 },
    ]);
    expect(
      paletteUploadRects(3 * texelBytes, (textureWidth * 2 - 3) * texelBytes, textureWidth),
    ).toEqual([
      { x: 3, y: 0, width: 1021, height: 1, texel: 3 },
      { x: 0, y: 1, width: 1024, height: 1, texel: 1024 },
    ]);
  });

  test("keeps unaligned narrow palettes on one-row writes", () => {
    const textureWidth = 8;
    const texelBytes = 16;
    expect(paletteUploadRects(0, 24 * texelBytes, textureWidth)).toEqual([
      { x: 0, y: 0, width: 8, height: 1, texel: 0 },
      { x: 0, y: 1, width: 8, height: 1, texel: 8 },
      { x: 0, y: 2, width: 8, height: 1, texel: 16 },
    ]);
  });
});

describe("webglFloatPaletteRects", () => {
  test("expands a mid-row storm band to one full-width row at x = 0", () => {
    const textureWidth = 1024;
    const storm = [
      { offset: 17_920, length: 624 },
      { offset: 19_136, length: 624 },
      { offset: 20_352, length: 624 },
      { offset: 21_568, length: 624 },
      { offset: 22_784, length: 624 },
      { offset: 24_000, length: 624 },
      { offset: 25_216, length: 624 },
      { offset: 26_432, length: 624 },
    ];
    expect(webglFloatPaletteRects(storm, textureWidth)).toEqual([
      { x: 0, y: 1, width: 1024, height: 1, texel: 1024 },
    ]);
    expect(paletteUploadRects(17_920, 624, textureWidth)).toEqual([
      { x: 96, y: 1, width: 39, height: 1, texel: 1_120 },
    ]);
  });

  test("stacks contiguous dirty rows when the stride is 256-byte aligned", () => {
    const textureWidth = 1024;
    const texelBytes = 16;
    expect(
      webglFloatPaletteRects(
        [{ offset: 0, length: 2 * textureWidth * texelBytes }],
        textureWidth,
      ),
    ).toEqual([{ x: 0, y: 0, width: 1024, height: 2, texel: 0 }]);
  });
});

describe("prototype texture pack", () => {
  test("grows width before height exceeds the device max", () => {
    expect(prototypeTextureLayout(1)).toEqual({ width: GLYPH_PROTO_TEXTURE_WIDTH, height: 1 });
    // Appearance W→AB frees slot 0 and allocates two glyphs at highWater 3. Still one row.
    expect(prototypeTextureLayout(3)).toEqual({ width: GLYPH_PROTO_TEXTURE_WIDTH, height: 1 });
    expect(prototypeTextureLayout(512)).toEqual({ width: GLYPH_PROTO_TEXTURE_WIDTH, height: 1 });
    expect(prototypeTextureLayout(513)).toEqual({ width: GLYPH_PROTO_TEXTURE_WIDTH, height: 2 });
    expect(prototypeTextureLayout(8_000_000, 4096)).toEqual({ width: 4096, height: 3907 });
  });

  test("copies store words into two padded texels per glyph", () => {
    const store = new ArrayBuffer(GLYPH_INSTANCE_STRIDE);
    const src = new Uint32Array(store);
    src[0] = packHalf2x16(1, 2);
    src[1] = packHalf2x16(3, 4);
    src[2] = 65_535 | (65_535 << 16);
    src[3] = 65_535 | (65_535 << 16);
    src[4] = 5;
    src[5] = 0x8000_0001;
    const pixels = allocatePrototypePixels(GLYPH_PROTO_TEXTURE_WIDTH, 1);
    writePrototypeGlyphs(pixels, store, 0, 1);
    const dest = new Uint32Array(pixels.buffer);
    expect(dest[0]).toBe(src[0]);
    expect(dest[1]).toBe(src[1]);
    expect(Number.isFinite(pixels[2])).toBe(true);
    expect(Number.isFinite(pixels[3])).toBe(true);
    expect(unpackHalf2x16(dest[2] ?? 0)).toEqual([1, 1]);
    expect(unpackHalf2x16(dest[3] ?? 0)).toEqual([1, 1]);
    expect(pixels[5]).toBe(1);
    expect(pixels[6]).toBe(0x8000);
    src[5] = 0x8000_0000 | (8191 << 18);
    writePrototypeGlyphs(pixels, store, 0, 1);
    expect(Number.isFinite(pixels[5])).toBe(true);
    expect(Number.isFinite(pixels[6])).toBe(true);
    expect(pixels[6]).toBe(0xfffc);
    expect(prototypeByteRange(0, GLYPH_INSTANCE_STRIDE)).toEqual({ offset: 0, length: 32 });
  });

  test("copies a non-zero-offset float texel view before a WebGL upload", () => {
    const data = new Float32Array(16);
    data[8] = 7;
    data[9] = 8;
    const view = packedFloatTexelView(data, 2, 2);
    expect(view.byteOffset).toBe(0);
    expect([...view.subarray(0, 2)]).toEqual([7, 8]);
    expect(packedFloatTexelView(data, 0, 2).byteOffset).toBe(0);
  });

  test("writes an 8-byte draw record", () => {
    const words = new Uint32Array(GLYPH_DRAW_STRIDE / 4);
    writeDrawInstance(words, 0, 11, 22);
    expect([...words]).toEqual([11, 22]);
  });
});
