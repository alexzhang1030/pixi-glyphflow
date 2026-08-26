import { describe, expect, test } from "bun:test";

import {
  allocatePrototypePixels,
  packF16,
  packHalf2x16,
  paletteUploadRects,
  premultiplyRgba8,
  prototypeByteRange,
  prototypeTextureLayout,
  unpackF16,
  unpackHalf2x16,
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

describe("prototype texture pack", () => {
  test("grows width before height exceeds the device max", () => {
    expect(prototypeTextureLayout(1)).toEqual({ width: GLYPH_PROTO_TEXTURE_WIDTH, height: 1 });
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

  test("writes an 8-byte draw record", () => {
    const words = new Uint32Array(GLYPH_DRAW_STRIDE / 4);
    writeDrawInstance(words, 0, 11, 22);
    expect([...words]).toEqual([11, 22]);
  });
});
