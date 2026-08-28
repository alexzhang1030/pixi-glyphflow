import { describe, expect, test } from "bun:test";

import { TRANSFORM_PALETTE_STRIDE } from "../src/advanced";
import { computeCullDeviceLimits } from "../src/culling/requestComputeCullGpu";
import { PALETTE_PATCH_WGSL } from "../src/render/palettePatch.wgsl";
import {
  applyPaletteMoves,
  originColumnUploadBytes,
  PALETTE_ORIGIN_FLOATS,
  paletteMoveRange,
  refreshPaletteOrigins,
  readyPalettePath,
  resolvePalettePath,
  shouldWriteCpuPalettePositions,
} from "../src/render/paletteStorage";

const WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

describe("palette storage path", () => {
  test("keeps WebGL and devices without vertex storage on the texture palette", () => {
    expect(
      resolvePalettePath({
        adapter: "webgl",
        maxStorageBuffersInVertexStage: 8,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 32,
      }),
    ).toBe("texture");
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 0,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 32,
      }),
    ).toBe("texture");
    expect(
      resolvePalettePath({
        adapter: "unknown",
        maxStorageBuffersInVertexStage: 8,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 32,
      }),
    ).toBe("texture");
    expect(shouldWriteCpuPalettePositions("texture")).toBe(true);
    expect(shouldWriteCpuPalettePositions("storage")).toBe(false);
    expect(readyPalettePath("storage", true)).toBe("storage");
    expect(readyPalettePath("storage", false)).toBe("texture");
    expect(readyPalettePath("texture", true)).toBe("texture");
    expect(readyPalettePath("texture", false)).toBe("texture");
  });

  test("selects a storage palette when the vertex stage can bind the table", () => {
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 1_000_000 * TRANSFORM_PALETTE_STRIDE,
      }),
    ).toBe("storage");
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: 1024,
        paletteBytes: 2048,
      }),
    ).toBe("texture");
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 0,
      }),
    ).toBe("texture");
  });

  test("requests vertex storage only when the adapter exposes it", () => {
    expect(
      computeCullDeviceLimits({
        limits: {
          maxStorageBufferBindingSize: 256,
          maxBufferSize: 512,
        },
      }),
    ).toEqual({
      maxStorageBufferBindingSize: 256,
      maxBufferSize: 512,
    });
    expect(
      computeCullDeviceLimits({
        limits: {
          maxStorageBufferBindingSize: 256,
          maxBufferSize: 512,
          maxStorageBuffersInVertexStage: 8,
        },
      }),
    ).toEqual({
      maxStorageBufferBindingSize: 256,
      maxBufferSize: 512,
      maxStorageBuffersInVertexStage: 8,
    });
  });

  test("patches only x/y in a 32-byte fill record", () => {
    const data = new Float32Array(PALETTE_ORIGIN_FLOATS * 2);
    data.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const slots = new Uint32Array([1]);
    const originX = new Float32Array([0, 40]);
    const originY = new Float32Array([0, 50]);

    expect(applyPaletteMoves(data, slots, 1, originX, originY)).toBe(1);
    expect(Array.from(data.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(data.subarray(8, 16))).toEqual([40, 50, 11, 12, 13, 14, 15, 16]);
    expect(applyPaletteMoves(data, slots, 1, originX, originY)).toBe(0);
  });

  test("uploads origin columns instead of a 32-byte gather", () => {
    const dense = new Uint32Array(1_000);
    for (let index = 0; index < dense.length; index += 1) dense[index] = index;
    const denseRange = paletteMoveRange(dense, dense.length, dense.length);
    if (denseRange === undefined) throw new Error("dense movers must form a range");
    const denseBytes = originColumnUploadBytes(denseRange, dense.length);
    expect(denseBytes).toBe(1_000 * Float32Array.BYTES_PER_ELEMENT * 2);
    expect(denseBytes).toBeLessThan(1_000 * TRANSFORM_PALETTE_STRIDE);

    const sparse = new Uint32Array([0, 999_999]);
    const sparseRange = paletteMoveRange(sparse, 2, 1_000_000);
    if (sparseRange === undefined) throw new Error("sparse movers must form a range");
    expect(originColumnUploadBytes(sparseRange)).toBe(
      1_000_000 * Float32Array.BYTES_PER_ELEMENT * 2,
    );
    expect(originColumnUploadBytes(sparseRange, 2)).toBe(2 * Float32Array.BYTES_PER_ELEMENT * 2);
    expect(paletteMoveRange(new Uint32Array(), 0, 8)).toBeUndefined();
  });

  test("refreshes occupied origins without touching empty slots", () => {
    const data = new Float32Array(PALETTE_ORIGIN_FLOATS * 3);
    data.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    data.set([9, 10, 11, 12, 13, 14, 15, 16], PALETTE_ORIGIN_FLOATS);
    const occupied = new Uint8Array([1, 0, 1]);
    const originX = new Float32Array([100, 200, 300]);
    const originY = new Float32Array([101, 201, 301]);

    expect(refreshPaletteOrigins(data, occupied, originX, originY, 3)).toBe(2);
    expect(Array.from(data.subarray(0, 2))).toEqual([100, 101]);
    expect(Array.from(data.subarray(PALETTE_ORIGIN_FLOATS, PALETTE_ORIGIN_FLOATS + 2))).toEqual([
      9, 10,
    ]);
  });

  test("avoids WGSL reserved identifiers in the origin patch", () => {
    expect(PALETTE_PATCH_WGSL).not.toMatch(/\blet from\b/);
    expect(PALETTE_PATCH_WGSL).not.toMatch(/\blet to\b/);
    expect(PALETTE_PATCH_WGSL).toContain("fn patch_xy");
    expect(PALETTE_PATCH_WGSL).toContain("transforms[base] = texel");
    expect(PALETTE_PATCH_WGSL).toContain("origin_x[slot]");
    expect(PALETTE_PATCH_WGSL).toContain("origin_y[slot]");
  });
});
