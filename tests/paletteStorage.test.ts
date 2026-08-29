import { describe, expect, test } from "bun:test";

import { TRANSFORM_PALETTE_STRIDE } from "../src/advanced";
import { computeCullDeviceLimits } from "../src/culling/requestComputeCullGpu";
import { PALETTE_PATCH_WGSL } from "../src/render/palettePatch.wgsl";
import {
  applyPaletteMoves,
  PALETTE_MOVE_STRIDE,
  PALETTE_MOVE_UNIFORM_BYTES,
  PALETTE_ORIGIN_FLOATS,
  packPaletteMoves,
  paletteMoveDispatchBytes,
  paletteMoveUploadBytes,
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

  test("patches only x/y in a 32-byte fill record from packed commands", () => {
    const data = new Float32Array(PALETTE_ORIGIN_FLOATS * 2);
    data.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const commands = new ArrayBuffer(PALETTE_MOVE_STRIDE);
    const originX = new Float32Array([0, 40]);
    const originY = new Float32Array([0, 50]);
    expect(packPaletteMoves(commands, 0, new Uint32Array([1]), 1, originX, originY)).toBe(1);

    expect(applyPaletteMoves(data, commands, 1)).toBe(1);
    expect(Array.from(data.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(data.subarray(8, 16))).toEqual([40, 50, 11, 12, 13, 14, 15, 16]);
    expect(applyPaletteMoves(data, commands, 1)).toBe(0);
  });

  test("uploads packed moves instead of origin columns", () => {
    const denseCount = 100_000;
    const denseBytes = paletteMoveUploadBytes(denseCount);
    expect(denseBytes).toBe(denseCount * PALETTE_MOVE_STRIDE);
    expect(denseBytes).toBeLessThan(denseCount * TRANSFORM_PALETTE_STRIDE);
    expect(paletteMoveDispatchBytes(denseCount)).toBe(denseBytes + PALETTE_MOVE_UNIFORM_BYTES);
    expect(paletteMoveDispatchBytes(0)).toBe(0);

    const originColumnSpanBytes = 1_000_000 * Float32Array.BYTES_PER_ELEMENT * 2;
    const sparseCount = 2;
    const sparseBytes = paletteMoveUploadBytes(sparseCount);
    expect(sparseBytes).toBe(sparseCount * PALETTE_MOVE_STRIDE);
    expect(sparseBytes).toBeLessThan(originColumnSpanBytes);
    expect(paletteMoveDispatchBytes(sparseCount)).toBeLessThan(originColumnSpanBytes);

    const originX = new Float32Array(1_000_000);
    const originY = new Float32Array(1_000_000);
    originX[0] = 11;
    originY[0] = 12;
    originX[999_999] = 21;
    originY[999_999] = 22;
    const commands = new ArrayBuffer(sparseCount * PALETTE_MOVE_STRIDE);
    expect(
      packPaletteMoves(commands, 0, new Uint32Array([0, 999_999]), sparseCount, originX, originY),
    ).toBe(2);
    const uints = new Uint32Array(commands);
    const floats = new Float32Array(commands);
    expect(uints[0]).toBe(0);
    expect(floats[1]).toBe(11);
    expect(floats[2]).toBe(12);
    expect(uints[4]).toBe(999_999);
    expect(floats[5]).toBe(21);
    expect(floats[6]).toBe(22);
    expect(commands.byteLength).toBe(sparseBytes);
    expect(commands.byteLength).not.toBe(originColumnSpanBytes);
  });

  test("packs lane and content movers into one command buffer", () => {
    const originX = new Float32Array([1, 2, 3]);
    const originY = new Float32Array([4, 5, 6]);
    const commands = new ArrayBuffer(3 * PALETTE_MOVE_STRIDE);
    const lane = packPaletteMoves(commands, 0, new Uint32Array([0, 2]), 2, originX, originY);
    const content = packPaletteMoves(commands, lane, new Uint32Array([1]), 1, originX, originY);
    expect(lane).toBe(2);
    expect(content).toBe(1);
    const uints = new Uint32Array(commands);
    const floats = new Float32Array(commands);
    expect(uints[0]).toBe(0);
    expect(floats[1]).toBe(1);
    expect(uints[4]).toBe(2);
    expect(floats[5]).toBe(3);
    expect(uints[8]).toBe(1);
    expect(floats[9]).toBe(2);
    expect(() =>
      packPaletteMoves(
        new ArrayBuffer(PALETTE_MOVE_STRIDE),
        0,
        new Uint32Array([0, 1]),
        2,
        originX,
        originY,
      ),
    ).toThrow(RangeError);
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

  test("patches live x/y from packed commands, not origin-column lookups", () => {
    expect(PALETTE_PATCH_WGSL).not.toMatch(/\blet from\b/);
    expect(PALETTE_PATCH_WGSL).not.toMatch(/\blet to\b/);
    expect(PALETTE_PATCH_WGSL).toContain("fn patch_xy");
    expect(PALETTE_PATCH_WGSL).toContain("struct MoveCommand");
    expect(PALETTE_PATCH_WGSL).toContain("commands[id.x]");
    expect(PALETTE_PATCH_WGSL).toContain("texel.x = command.x");
    expect(PALETTE_PATCH_WGSL).toContain("texel.y = command.y");
    expect(PALETTE_PATCH_WGSL).toContain("transforms[base] = texel");
    expect(PALETTE_PATCH_WGSL).not.toContain("origin_x");
    expect(PALETTE_PATCH_WGSL).not.toContain("origin_y");
    expect(PALETTE_PATCH_WGSL).not.toContain("array<u32>");
    expect(PALETTE_PATCH_WGSL).toContain("@group(0) @binding(1) var<storage, read> commands");
    expect(PALETTE_PATCH_WGSL).toContain(
      "@group(0) @binding(2) var<storage, read_write> transforms",
    );
    expect(PALETTE_PATCH_WGSL).not.toContain("@group(0) @binding(3)");
    expect(PALETTE_PATCH_WGSL).not.toContain("@group(0) @binding(4)");
  });
});
