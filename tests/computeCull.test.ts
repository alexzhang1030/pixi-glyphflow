import { describe, expect, test } from "bun:test";

import {
  aabbVisible,
  compactVisibleInstances,
  computeCullStructurallyEligible,
  createIndirectArgs,
  createOffscreenAdmitBudget,
  cullRecordMatchesLocal,
  cullRecordWorldAabb,
  cullResidency,
  DEFAULT_OFFSCREEN_ADMIT_BUDGET_BYTES,
  expandPrepareRing,
  expandWorkingSet,
  gpuOwnsCullBoxes,
  OFFSCREEN_ADMIT_LABEL_BYTES,
  packCullRecords,
  planComputeCullStorageBytes,
  resolveCullPath,
  projectedFontHeightPx,
  selectAdmitBoxes,
  shouldAdmitOffscreenGroup,
  shouldAdmitUnshaped,
  shouldDropSubpixelLod,
  shouldInstanceUnshaped,
  shouldPatchComputeCullLane,
  shouldQueryPrepareRing,
  shouldRefreshResidency,
  tryAdmitOffscreen,
  workingSetContains,
  writeCullRecordAt,
} from "../src/culling/computeCull";
import { COMPUTE_CULL_WGSL } from "../src/culling/computeCull.wgsl";
import { GLYPH_DRAW_STRIDE, GLYPH_INSTANCE_STRIDE } from "../src/render/types";

/** PixiJS `requestDevice()` default; see the storage-binding gotcha. */
const WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

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
    expect(COMPUTE_CULL_WGSL).toContain("UINTS_PER_DRAW");
    expect(COMPUTE_CULL_WGSL).toContain("instances_out[dst] = srcBase + glyph");
    expect(COMPUTE_CULL_WGSL).not.toContain("instances_in");
    expect(COMPUTE_CULL_WGSL).toContain("fn world_box");
    expect(COMPUTE_CULL_WGSL).toContain("use_gpu_origin");
    expect(COMPUTE_CULL_WGSL).toContain("transforms[record.palette_index * 2u].xy");
    expect(COMPUTE_CULL_WGSL).toContain("@group(0) @binding(7) var<storage, read> transforms");
  });

  test("owns cull boxes only on a ready storage plus compute-cull path", () => {
    expect(gpuOwnsCullBoxes({ palettePath: "storage", cullPath: "compute-cull" })).toBe(true);
    expect(gpuOwnsCullBoxes({ palettePath: "texture", cullPath: "compute-cull" })).toBe(false);
    expect(gpuOwnsCullBoxes({ palettePath: "storage", cullPath: "cpu-grid" })).toBe(false);
    expect(gpuOwnsCullBoxes({ palettePath: "texture", cullPath: "cpu-grid" })).toBe(false);
    expect(
      shouldPatchComputeCullLane({ gpuOwnsCullBoxes: true, localBoxChanged: false }),
    ).toBe(false);
    expect(
      shouldPatchComputeCullLane({ gpuOwnsCullBoxes: true, localBoxChanged: true }),
    ).toBe(true);
    expect(
      shouldPatchComputeCullLane({ gpuOwnsCullBoxes: false, localBoxChanged: false }),
    ).toBe(true);
  });

  test("storage plus compute-cull storms skip lane record dirty when the local box holds", () => {
    const local = { x: 0, y: 0, width: 10, height: 10 };
    const records = packCullRecords([
      {
        minX: local.x,
        minY: local.y,
        maxX: local.x + local.width,
        maxY: local.y + local.height,
        instanceOffset: 0,
        instanceCount: 1,
        paletteIndex: 0,
      },
      {
        minX: local.x,
        minY: local.y,
        maxX: local.x + local.width,
        maxY: local.y + local.height,
        instanceOffset: 1,
        instanceCount: 1,
        paletteIndex: 1,
      },
    ]);
    const before = new Float32Array(records.slice(0));
    const floats = new Float32Array(records);
    expect(cullRecordMatchesLocal(floats, 0, local)).toBe(true);
    expect(cullRecordMatchesLocal(floats, 0, { x: 0, y: 0, width: 11, height: 10 })).toBe(false);
    expect(
      shouldPatchComputeCullLane({ gpuOwnsCullBoxes: true, localBoxChanged: false }),
    ).toBe(false);

    const originX = new Float32Array([0, 1000]);
    const originY = new Float32Array([0, 0]);
    const viewport = { x: 0, y: 0, width: 50, height: 50, padding: 0 };
    const instances = new ArrayBuffer(2 * GLYPH_INSTANCE_STRIDE);
    const first = compactVisibleInstances(records, 2, instances, viewport, {
      aabbSpace: "local",
      originX,
      originY,
    });
    expect(first.instanceCount).toBe(1);
    const firstWords = new Uint32Array(
      first.compact.buffer,
      first.compact.byteOffset,
      first.compact.byteLength / 4,
    );
    expect(firstWords[0]).toBe(0);
    expect(firstWords[1]).toBe(0);

    originX[0] = 1000;
    originX[1] = 5;
    const moved = compactVisibleInstances(records, 2, instances, viewport, {
      aabbSpace: "local",
      originX,
      originY,
    });
    expect(moved.instanceCount).toBe(1);
    const movedWords = new Uint32Array(
      moved.compact.buffer,
      moved.compact.byteOffset,
      moved.compact.byteLength / 4,
    );
    expect(movedWords[0]).toBe(1);
    expect(movedWords[1]).toBe(1);
    expect(Array.from(new Float32Array(records))).toEqual(Array.from(before));
  });

  test("adds palette origin to a local cull record", () => {
    const records = packCullRecords([
      { minX: 1, minY: 2, maxX: 11, maxY: 12, instanceOffset: 0, instanceCount: 1, paletteIndex: 1 },
    ]);
    const floats = new Float32Array(records);
    const uints = new Uint32Array(records);
    expect(cullRecordWorldAabb(floats, uints, 0)).toEqual({
      minX: 1,
      minY: 2,
      maxX: 11,
      maxY: 12,
    });
    expect(
      cullRecordWorldAabb(floats, uints, 0, "local", new Float32Array([0, 40]), new Float32Array([0, 50])),
    ).toEqual({ minX: 41, minY: 52, maxX: 51, maxY: 62 });
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
      {
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10,
        instanceOffset: 2,
        instanceCount: 1,
        paletteIndex: 21,
      },
      {
        minX: 5,
        minY: 5,
        maxX: 15,
        maxY: 15,
        instanceOffset: 3,
        instanceCount: 1,
        paletteIndex: 31,
      },
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
    expect(result.compact.byteLength).toBe(2 * GLYPH_DRAW_STRIDE);
    const compact = new Uint32Array(
      result.compact.buffer,
      result.compact.byteOffset,
      result.compact.byteLength / 4,
    );
    expect(compact[0]).toBe(2);
    expect(compact[1]).toBe(21);
    expect(compact[2]).toBe(3);
    expect(compact[3]).toBe(31);
  });

  test("scatters shared prototype instances with per-record palette indices", () => {
    const records = packCullRecords([
      {
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10,
        instanceOffset: 0,
        instanceCount: 2,
        paletteIndex: 7,
      },
      {
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10,
        instanceOffset: 0,
        instanceCount: 2,
        paletteIndex: 9,
      },
    ]);
    const instances = new ArrayBuffer(2 * GLYPH_INSTANCE_STRIDE);
    const words = new Uint32Array(instances);
    words[4] = 1;
    words[10] = 1;
    const result = compactVisibleInstances(records, 2, instances, {
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      padding: 0,
    });
    expect(result.instanceCount).toBe(4);
    expect(result.compact.byteLength).toBe(4 * GLYPH_DRAW_STRIDE);
    const compact = new Uint32Array(
      result.compact.buffer,
      result.compact.byteOffset,
      result.compact.byteLength / 4,
    );
    expect(compact[0]).toBe(0);
    expect(compact[1]).toBe(7);
    expect(compact[2]).toBe(1);
    expect(compact[3]).toBe(7);
    expect(compact[4]).toBe(0);
    expect(compact[5]).toBe(9);
    expect(compact[6]).toBe(1);
    expect(compact[7]).toBe(9);
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
    expect(
      shouldRefreshResidency({
        cullPath: "cpu-grid",
        visibilityDirty: false,
        instanced: draw,
        draw,
      }),
    ).toBe(false);
    expect(
      shouldRefreshResidency({
        cullPath: "cpu-grid",
        visibilityDirty: false,
        instanced: undefined,
        draw: undefined,
      }),
    ).toBe(false);
    expect(
      shouldRefreshResidency({
        cullPath: "cpu-grid",
        visibilityDirty: false,
        instanced: draw,
        draw: undefined,
      }),
    ).toBe(true);
    expect(
      shouldRefreshResidency({
        cullPath: "cpu-grid",
        visibilityDirty: true,
        instanced: undefined,
        draw: undefined,
      }),
    ).toBe(true);
  });

  test("instances unshaped compute-cull labels against the prepare ring", () => {
    const draw = { x: 0, y: 0, width: 100, height: 100, padding: 0 };
    const ring = expandPrepareRing(draw);
    expect(ring).toEqual({ x: -25, y: -25, width: 150, height: 150, padding: 0 });
    expect(
      shouldInstanceUnshaped({
        cullPath: "cpu-grid",
        ring: undefined,
        minX: 400,
        minY: 0,
        maxX: 408,
        maxY: 10,
      }),
    ).toBe(true);
    expect(
      shouldInstanceUnshaped({
        cullPath: "compute-cull",
        ring,
        minX: 10,
        minY: 10,
        maxX: 18,
        maxY: 20,
      }),
    ).toBe(true);
    expect(
      shouldInstanceUnshaped({
        cullPath: "compute-cull",
        ring,
        minX: 110,
        minY: 10,
        maxX: 118,
        maxY: 20,
      }),
    ).toBe(true);
    expect(
      shouldInstanceUnshaped({
        cullPath: "compute-cull",
        ring,
        minX: 400,
        minY: 0,
        maxX: 408,
        maxY: 10,
      }),
    ).toBe(false);
  });

  test("admits compute-cull unshaped labels in the tight view or on an intern hit", () => {
    const draw = { x: 0, y: 0, width: 100, height: 100, padding: 0 };
    const ring = expandPrepareRing(draw);
    const tight = { minX: 10, minY: 10, maxX: 18, maxY: 20 };
    const pad = { minX: 110, minY: 10, maxX: 118, maxY: 20 };
    const far = { minX: 400, minY: 0, maxX: 408, maxY: 10 };
    expect(
      shouldAdmitUnshaped({
        cullPath: "cpu-grid",
        ring: undefined,
        draw,
        interned: false,
        ...far,
      }),
    ).toBe(true);
    expect(
      shouldAdmitUnshaped({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: false,
        ...tight,
      }),
    ).toBe(true);
    expect(
      shouldAdmitUnshaped({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: false,
        ...pad,
      }),
    ).toBe(false);
    expect(
      shouldAdmitUnshaped({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: true,
        ...pad,
      }),
    ).toBe(true);
    expect(
      shouldAdmitUnshaped({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: true,
        ...far,
      }),
    ).toBe(false);
    expect(
      shouldAdmitOffscreenGroup({
        cullPath: "compute-cull",
        draw,
        interned: false,
        boxes: [pad],
      }),
    ).toBe(false);
    expect(
      shouldAdmitOffscreenGroup({
        cullPath: "compute-cull",
        draw,
        interned: false,
        boxes: [pad, tight],
      }),
    ).toBe(true);
    expect(
      shouldAdmitOffscreenGroup({
        cullPath: "compute-cull",
        draw,
        interned: true,
        boxes: [pad],
      }),
    ).toBe(true);
  });

  test("charges off-screen intern hits against the per-frame byte budget", () => {
    const draw = { x: 0, y: 0, width: 100, height: 100, padding: 0 };
    const ring = expandPrepareRing(draw);
    const tight = { minX: 10, minY: 10, maxX: 18, maxY: 20 };
    const pad = { minX: 110, minY: 10, maxX: 118, maxY: 20 };
    const far = { minX: 400, minY: 0, maxX: 408, maxY: 10 };
    const cpu = createOffscreenAdmitBudget({ cullPath: "cpu-grid", budgetBytes: 0 });
    expect(cpu.remainingBytes).toBe(Number.POSITIVE_INFINITY);
    expect(tryAdmitOffscreen(cpu)).toBe(true);
    expect(cpu.deferred).toBe(false);
    expect(DEFAULT_OFFSCREEN_ADMIT_BUDGET_BYTES / OFFSCREEN_ADMIT_LABEL_BYTES).toBe(2048);

    const budget = createOffscreenAdmitBudget({
      cullPath: "compute-cull",
      budgetBytes: OFFSCREEN_ADMIT_LABEL_BYTES,
    });
    expect(
      selectAdmitBoxes({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: false,
        boxes: [tight, pad, pad],
        budget,
      }),
    ).toEqual([true, true, false]);
    expect(budget.deferred).toBe(true);
    expect(budget.remainingBytes).toBe(0);

    const interned = createOffscreenAdmitBudget({
      cullPath: "compute-cull",
      budgetBytes: OFFSCREEN_ADMIT_LABEL_BYTES,
    });
    expect(
      selectAdmitBoxes({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: true,
        boxes: [pad, pad, far],
        budget: interned,
      }),
    ).toEqual([true, false, false]);
    expect(interned.deferred).toBe(true);

    const uniqueRing = createOffscreenAdmitBudget({
      cullPath: "compute-cull",
      budgetBytes: OFFSCREEN_ADMIT_LABEL_BYTES * 8,
    });
    expect(
      selectAdmitBoxes({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: false,
        boxes: [pad, pad],
        budget: uniqueRing,
      }),
    ).toEqual([false, false]);
    expect(uniqueRing.deferred).toBe(false);
    expect(uniqueRing.remainingBytes).toBe(OFFSCREEN_ADMIT_LABEL_BYTES * 8);

    const tightOnly = createOffscreenAdmitBudget({ cullPath: "compute-cull", budgetBytes: 0 });
    expect(
      selectAdmitBoxes({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: true,
        boxes: [tight, pad],
        budget: tightOnly,
      }),
    ).toEqual([true, false]);
    expect(tightOnly.deferred).toBe(true);

    const cpuBoxes = createOffscreenAdmitBudget({ cullPath: "cpu-grid", budgetBytes: 0 });
    expect(
      selectAdmitBoxes({
        cullPath: "cpu-grid",
        ring: undefined,
        draw,
        interned: false,
        boxes: [far, pad],
        budget: cpuBoxes,
      }),
    ).toEqual([true, true]);
    expect(cpuBoxes.deferred).toBe(false);

    const prepared = expandPrepareRing(draw);
    expect(
      shouldQueryPrepareRing({
        preparedRing: prepared,
        draw,
        offscreenDeferred: false,
      }),
    ).toBe(false);
    expect(
      shouldQueryPrepareRing({
        preparedRing: prepared,
        draw,
        offscreenDeferred: true,
      }),
    ).toBe(true);
    expect(
      shouldQueryPrepareRing({
        preparedRing: prepared,
        draw: { x: 80, y: 0, width: 100, height: 100, padding: 0 },
        offscreenDeferred: false,
      }),
    ).toBe(true);
  });

  test("rewrites one packed record in place, including a relocated instance range", () => {
    const records = packCullRecords([
      { minX: 1, minY: 2, maxX: 3, maxY: 4, instanceOffset: 5, instanceCount: 6 },
    ]);
    writeCullRecordAt(new Float32Array(records), new Uint32Array(records), 0, {
      minX: 10,
      minY: 20,
      maxX: 30,
      maxY: 40,
      instanceOffset: 7,
      instanceCount: 8,
    });
    const view = new DataView(records);
    expect(view.getFloat32(0, true)).toBe(10);
    expect(view.getFloat32(4, true)).toBe(20);
    expect(view.getFloat32(8, true)).toBe(30);
    expect(view.getFloat32(12, true)).toBe(40);
    expect(view.getUint32(16, true)).toBe(7);
    expect(view.getUint32(20, true)).toBe(8);
  });

  test("drops labels whose projected font height is below one pixel", () => {
    expect(projectedFontHeightPx({ fontSize: 16, scaleY: 1, worldScaleY: 0.24 })).toBeCloseTo(3.84);
    expect(shouldDropSubpixelLod({ fontSize: 16, scaleY: 0.01, worldScaleY: 1 })).toBe(true);
    expect(shouldDropSubpixelLod({ fontSize: 16, scaleY: 1, worldScaleY: 0.24 })).toBe(false);
  });
});
