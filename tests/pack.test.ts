import { describe, expect, test } from "bun:test";

import {
  packF16,
  packHalf2x16,
  paletteUploadRects,
  premultiplyRgba8,
  unpackF16,
  unpackHalf2x16,
} from "../src/render/pack";

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
