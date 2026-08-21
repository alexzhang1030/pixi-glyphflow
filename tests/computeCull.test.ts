import { describe, expect, test } from "bun:test";

import {
  aabbVisible,
  compactVisibleInstances,
  computeCullStructurallyEligible,
  createIndirectArgs,
  cullResidency,
  expandWorkingSet,
  packCullRecords,
  patchCullRecordAabbAt,
  planComputeCullStorageBytes,
  resolveCullPath,
  shouldRefreshResidency,
  WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
  workingSetContains,
} from "../src/culling/computeCull";
import { COMPUTE_CULL_WGSL } from "../src/culling/computeCull.wgsl";
import { GLYPH_INSTANCE_STRIDE } from "../src/render/types";

describe("compute cull host reference", () => {
  test("keeps million-label residency on the CPU viewport set", () => {
    expect(cullResidency(true, true)).toBe("viewport");
    expect(cullResidency(true, false)).toBe("all");
    expect(cullResidency(false, true)).toBe("all");
  });

  test("keeps a single-bank store compute-eligible when instance order is not draw order", () => {
    expect(
      computeCullStructurallyEligible({
        segmentCount: 1,
        highWater: 8,
        activeInstances: 6,
      }),
    ).toBe(true);
    expect(
      computeCullStructurallyEligible({
        segmentCount: 2,
        highWater: 8,
        activeInstances: 6,
      }),
    ).toBe(false);
    expect(
      computeCullStructurallyEligible({
        segmentCount: 1,
        highWater: 13,
        activeInstances: 6,
      }),
    ).toBe(false);
  });

  test("keeps storage buffers inside the device binding limit", () => {
    expect(planComputeCullStorageBytes(24, WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE)).toBe(
      32,
    );
    expect(
      planComputeCullStorageBytes(90 * 1024 * 1024, WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE),
    ).toBe(WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE);
    expect(
      planComputeCullStorageBytes(
        WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE + 1,
        WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
      ),
    ).toBeUndefined();
    expect(planComputeCullStorageBytes(200_000_000, 210_000_000)).toBe(200_000_000);
    expect(planComputeCullStorageBytes(268_435_456, 4_294_967_292)).toBe(268_435_456);
  });

  test("enables compute cull only on a ready WebGPU device", () => {
    expect(resolveCullPath({ adapter: "webgpu", computeCull: "auto", deviceReady: true })).toBe(
      "compute-cull",
    );
    expect(resolveCullPath({ adapter: "webgpu", computeCull: true, deviceReady: true })).toBe(
      "compute-cull",
    );
    expect(resolveCullPath({ adapter: "webgpu", computeCull: "auto", deviceReady: false })).toBe(
      "cpu-grid",
    );
    expect(resolveCullPath({ adapter: "webgl", computeCull: "auto", deviceReady: true })).toBe(
      "cpu-grid",
    );
    expect(resolveCullPath({ adapter: "webgpu", computeCull: false, deviceReady: true })).toBe(
      "cpu-grid",
    );
  });

  test("avoids WGSL reserved identifiers in the scatter pass", () => {
    expect(COMPUTE_CULL_WGSL).not.toMatch(/\blet from\b/);
    expect(COMPUTE_CULL_WGSL).not.toMatch(/\blet to\b/);
  });

  test("keeps axis-aligned overlap and rejects separated boxes", () => {
    const viewport = { x: 0, y: 0, width: 100, height: 100, padding: 10 };
    expect(aabbVisible(90, 90, 110, 110, viewport)).toBe(true);
    expect(aabbVisible(120, 0, 140, 20, viewport)).toBe(false);
    expect(aabbVisible(-20, -20, -5, -5, viewport)).toBe(true);
  });

  test("compacts visible instances in record order without atomics", () => {
    const records = packCullRecords([
      { minX: 1000, minY: 0, maxX: 1010, maxY: 10, instanceOffset: 0, instanceCount: 2 },
      { minX: 0, minY: 0, maxX: 10, maxY: 10, instanceOffset: 2, instanceCount: 1 },
      { minX: 5, minY: 5, maxX: 15, maxY: 15, instanceOffset: 3, instanceCount: 1 },
    ]);
    const instances = new ArrayBuffer(4 * GLYPH_INSTANCE_STRIDE);
    const words = new Uint32Array(instances);
    words[4] = 11;
    words[10] = 12;
    words[16] = 21;
    words[22] = 31;
    const result = compactVisibleInstances(records, 3, instances, {
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      padding: 0,
    });

    expect(result.instanceCount).toBe(2);
    expect(result.indirect).toEqual(createIndirectArgs(2));
    const compact = new Uint32Array(
      result.compact.buffer,
      result.compact.byteOffset,
      result.compact.byteLength / 4,
    );
    expect(compact[4]).toBe(21);
    expect(compact[10]).toBe(31);
  });

  test("packs AABB and instance ranges into 32-byte records", () => {
    const records = packCullRecords([
      { minX: 1, minY: 2, maxX: 3, maxY: 4, instanceOffset: 5, instanceCount: 6 },
    ]);
    const view = new DataView(records);
    expect(records.byteLength).toBe(32);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(2);
    expect(view.getFloat32(8, true)).toBe(3);
    expect(view.getFloat32(12, true)).toBe(4);
    expect(view.getUint32(16, true)).toBe(5);
    expect(view.getUint32(20, true)).toBe(6);
  });

  test("writes a zero-instance indirect draw when every record is offscreen", () => {
    const records = packCullRecords([
      { minX: 1000, minY: 1000, maxX: 1010, maxY: 1010, instanceOffset: 0, instanceCount: 2 },
    ]);
    const result = compactVisibleInstances(records, 1, new ArrayBuffer(2 * GLYPH_INSTANCE_STRIDE), {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      padding: 0,
    });
    expect(result.instanceCount).toBe(0);
    expect(result.compact.byteLength).toBe(0);
    expect(result.indirect).toEqual(createIndirectArgs(0));
  });

  test("keeps a camera move inside the working set off the CPU grid", () => {
    const draw = { x: 0, y: 0, width: 100, height: 100, padding: 0 };
    const instanced = expandWorkingSet(draw, Math.max(draw.width, draw.height));
    expect(workingSetContains(instanced, { ...draw, x: 40 })).toBe(true);
    expect(workingSetContains(instanced, { ...draw, x: 950 })).toBe(false);
    expect(aabbVisible(1000, 10, 1008, 20, instanced)).toBe(false);
  });

  test("refreshes residency only when the selected path needs CPU work", () => {
    const draw = { x: 0, y: 0, width: 100, height: 100, padding: 8 };
    const instanced = expandWorkingSet(draw, Math.max(draw.width, draw.height));
    expect(
      shouldRefreshResidency({
        cullPath: "compute-cull",
        visibilityDirty: false,
        instanced,
        draw: { ...draw, x: 40 },
      }),
    ).toBe(false);
    expect(
      shouldRefreshResidency({
        cullPath: "compute-cull",
        visibilityDirty: false,
        instanced,
        draw: { ...draw, x: 950 },
      }),
    ).toBe(true);
    expect(
      shouldRefreshResidency({
        cullPath: "compute-cull",
        visibilityDirty: false,
        instanced,
        draw,
      }),
    ).toBe(false);
    expect(
      shouldRefreshResidency({
        cullPath: "compute-cull",
        visibilityDirty: true,
        instanced,
        draw,
      }),
    ).toBe(true);
    expect(
      shouldRefreshResidency({
        cullPath: "cpu-grid",
        visibilityDirty: false,
        instanced,
        draw,
      }),
    ).toBe(true);
  });

  test("patches a packed AABB without rewriting instance ranges", () => {
    const records = packCullRecords([
      { minX: 1, minY: 2, maxX: 3, maxY: 4, instanceOffset: 5, instanceCount: 6 },
    ]);
    patchCullRecordAabbAt(new Float32Array(records), 0, 10, 20, 30, 40);
    const view = new DataView(records);
    expect(view.getFloat32(0, true)).toBe(10);
    expect(view.getFloat32(4, true)).toBe(20);
    expect(view.getFloat32(8, true)).toBe(30);
    expect(view.getFloat32(12, true)).toBe(40);
    expect(view.getUint32(16, true)).toBe(5);
    expect(view.getUint32(20, true)).toBe(6);
  });
});
