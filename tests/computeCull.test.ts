import { describe, expect, test } from "bun:test";

import type { WebGPURenderer } from "pixi.js";

import {
  aabbVisible,
  classifyAdmitSlot,
  compactVisibleInstances,
  CULL_RECORD_STRIDE,
  CULL_MAX_RECORDS,
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
  planBudgetedOffscreenAdmissionWindow,
  planOffscreenAdmissionWindow,
  packCullRecords,
  planComputeCullDispatch,
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
import { ComputeCullPass, hashComputeCullDrawInstances } from "../src/render/ComputeCullPass";
import { GLYPH_DRAW_STRIDE, GLYPH_INSTANCE_STRIDE } from "../src/render/types";
import {
  WebGPUFrameTransaction,
  observeWebGPUFrameTimestamps,
} from "../src/render/WebGPUFrameTransaction";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

/** PixiJS `requestDevice()` default; see the storage-binding gotcha. */
const WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;
const COMPUTE_DEVICE_LIMITS = Object.freeze({
  maxStorageBufferBindingSize: 134_217_728,
  maxBufferSize: 268_435_456,
  maxStorageBuffersPerShaderStage: 8,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupsPerDimension: 65_535,
});
const COMPUTE_PIPELINE_ENTRIES = [
  "mark_visible",
  "scan_counts",
  "scan_group_sums",
  "scan_group_blocks",
  "add_group_offsets",
  "scatter",
];

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
    expect(shouldPatchComputeCullLane({ gpuOwnsCullBoxes: true, localBoxChanged: false })).toBe(
      false,
    );
    expect(shouldPatchComputeCullLane({ gpuOwnsCullBoxes: true, localBoxChanged: true })).toBe(
      true,
    );
    expect(shouldPatchComputeCullLane({ gpuOwnsCullBoxes: false, localBoxChanged: false })).toBe(
      true,
    );
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
    expect(shouldPatchComputeCullLane({ gpuOwnsCullBoxes: true, localBoxChanged: false })).toBe(
      false,
    );

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
      {
        minX: 1,
        minY: 2,
        maxX: 11,
        maxY: 12,
        instanceOffset: 0,
        instanceCount: 1,
        paletteIndex: 1,
      },
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
      cullRecordWorldAabb(
        floats,
        uints,
        0,
        "local",
        new Float32Array([0, 40]),
        new Float32Array([0, 50]),
      ),
    ).toEqual({ minX: 41, minY: 52, maxX: 51, maxY: 62 });
  });

  test("uses a stable two-level parallel prefix for million-record dispatch", () => {
    expect(planComputeCullDispatch(0)).toEqual({
      recordGroups: 0,
      groupBlocks: 0,
      dispatchRecordGroups: 1,
      dispatchGroupBlocks: 1,
    });
    expect(planComputeCullDispatch(1)).toMatchObject({ recordGroups: 1, groupBlocks: 1 });
    expect(planComputeCullDispatch(255)).toMatchObject({ recordGroups: 1, groupBlocks: 1 });
    expect(planComputeCullDispatch(256)).toMatchObject({ recordGroups: 1, groupBlocks: 1 });
    expect(planComputeCullDispatch(257)).toMatchObject({ recordGroups: 2, groupBlocks: 1 });
    expect(planComputeCullDispatch(1_000_000)).toEqual({
      recordGroups: 3_907,
      groupBlocks: 16,
      dispatchRecordGroups: 3_907,
      dispatchGroupBlocks: 16,
    });
    expect(() => planComputeCullDispatch(CULL_MAX_RECORDS + 1)).toThrow(
      "compute-cull record count exceeds the two-level prefix capacity",
    );
    expect(COMPUTE_CULL_WGSL).toContain("fn scan_group_blocks");
    expect(COMPUTE_CULL_WGSL).toContain("fn add_group_offsets");
    expect(COMPUTE_CULL_WGSL).toContain("group_block_sums");
    expect(COMPUTE_CULL_WGSL).toContain("pass-independent stable prefix");
  });

  test("publishes a new resident-record epoch after buffer growth", () => {
    const writes: number[] = [];
    let writeCalls = 0;
    let failWriteAt = Number.POSITIVE_INFINITY;
    const pipelines: string[] = [];
    const buffers: Array<{ size: number; usage: number; destroyed: boolean; destroy(): void }> = [];
    const device = {
      limits: COMPUTE_DEVICE_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => {
        pipelines.push(compute.entryPoint);
        return { entryPoint: compute.entryPoint };
      },
      createBuffer: ({ size, usage }: { size: number; usage: number }) => {
        const buffer = {
          size,
          usage,
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        };
        buffers.push(buffer);
        return buffer;
      },
      queue: {
        writeBuffer: (
          _buffer: unknown,
          _offset: number,
          _source: AllowSharedBufferSource,
          _sourceOffset?: number,
          size?: number,
        ) => {
          writeCalls += 1;
          if (writeCalls === failWriteAt) throw new Error("injected record upload failure");
          writes.push(size ?? 0);
        },
      },
    };
    const renderer = basicComputeRenderer(device);
    const restoreGpuGlobals = installWebGpuGlobals({
      GPUShaderStage: { COMPUTE: 4 },
      GPUBufferUsage: {
        STORAGE: 0x0080,
        COPY_DST: 0x0008,
        VERTEX: 0x0020,
        UNIFORM: 0x0040,
      },
    });
    try {
      const pass = new ComputeCullPass(renderer);
      expect(pass.initialize()).toBe(true);
      expect(pipelines).toEqual(COMPUTE_PIPELINE_ENTRIES);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      const oneRecord = packCullRecords([
        { minX: 0, minY: 0, maxX: 1, maxY: 1, instanceOffset: 0, instanceCount: 1 },
      ]);
      expect(pass.uploadRecords(oneRecord, 1, "all")).toBe(true);
      const first = pass.getResidentRecords();
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(first.reason);
      expect(first).toMatchObject({ epoch: 1, recordCount: 1, byteLength: 8_192 });
      expect(pass.lastRecordUploadBytes).toBe(32);

      expect(pass.ensureCapacity(257, 257 * GLYPH_DRAW_STRIDE)).toBe(true);
      const grownRecords = new ArrayBuffer(257 * 32);
      expect(pass.uploadRecords(grownRecords, 257, "all")).toBe(true);
      const grown = pass.getResidentRecords();
      expect(grown.ok).toBe(true);
      if (!grown.ok) throw new Error(grown.reason);
      expect(grown.epoch).toBe(2);
      expect(grown.buffer).not.toBe(first.buffer);
      expect(grown.byteLength).toBe(16_384);

      expect(pass.uploadRecords(grownRecords, 257, "none")).toBe(false);
      expect(pass.lastRecordUploadBytes).toBe(0);
      expect(pass.recordUploadBytes).toBe(32 + 257 * 32);

      failWriteAt = writeCalls + 2;
      expect(
        pass.uploadRecords(grownRecords, 257, [
          { offset: 0, length: 32 },
          { offset: 32, length: 32 },
        ]),
      ).toBe(false);
      expect(pass.synced).toBe(false);
      expect(pass.requiresFullSync).toBe(true);
      expect(pass.failureReason).toContain("injected record upload failure");

      failWriteAt = Number.POSITIVE_INFINITY;
      expect(pass.uploadRecords(grownRecords, 257, "none")).toBe(true);
      expect(pass.synced).toBe(true);
      expect(pass.ensureCapacity(CULL_MAX_RECORDS + 1, GLYPH_DRAW_STRIDE)).toBe(false);
      expect(pass.failureReason).toContain("two-level prefix capacity");
      pass.destroy();
    } finally {
      restoreGpuGlobals();
    }
  });

  test("retires one device epoch and rebuilds records plus indirect storage after replacement or loss", async () => {
    const restore = installComputeGpuGlobals();
    try {
      const transaction = trackedComputeTransaction();
      const first = trackedComputeDevice("first");
      const renderer = trackedComputeRenderer(first.device);
      const pass = new ComputeCullPass(renderer.renderer, transaction.value as never);
      const records = packCullRecords([
        { minX: 0, minY: 0, maxX: 8, maxY: 10, instanceOffset: 0, instanceCount: 1 },
      ]);

      expect(pass.initialize()).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      expect(pass.uploadRecords(records, 1, "all")).toBe(true);
      const firstResident = pass.getResidentRecords();
      expect(firstResident.ok).toBe(true);
      if (!firstResident.ok) throw new Error(firstResident.reason);
      const firstIndirect = renderer.indirectHandles.at(-1);
      expect(pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 })).toBe(true);
      expect(transaction.works).toHaveLength(1);

      const second = trackedComputeDevice("second");
      renderer.gpu.device = second.device;
      expect(pass.initialize()).toBe(true);
      expect(transaction.works).toHaveLength(0);
      expect(first.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        first.buffers.map(() => 1),
      );
      expect(renderer.indirectDestroyCalls).toEqual([1]);
      expect(pass.requiresFullSync).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      expect(pass.uploadRecords(records, 1, "none")).toBe(true);
      const secondResident = pass.getResidentRecords();
      expect(secondResident.ok).toBe(true);
      if (!secondResident.ok) throw new Error(secondResident.reason);
      expect(secondResident.buffer).not.toBe(firstResident.buffer);
      expect(secondResident.epoch).toBeGreaterThan(firstResident.epoch);
      expect(renderer.indirectHandles.at(-1)).not.toBe(firstIndirect);

      first.resolveLost();
      await settleComputePromises();
      expect(pass.ready).toBe(true);
      expect(second.buffers.every((buffer) => buffer.destroyCalls === 0)).toBe(true);

      second.resolveLost();
      await settleComputePromises();
      expect(pass.ready).toBe(false);
      expect(pass.requiresFullSync).toBe(true);
      expect(second.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        second.buffers.map(() => 1),
      );
      expect(renderer.indirectDestroyCalls).toEqual([1, 1]);
      expect(pass.initialize()).toBe(false);

      const third = trackedComputeDevice("third");
      renderer.gpu.device = third.device;
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      expect(pass.uploadRecords(records, 1, "none")).toBe(true);
      expect(pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 })).toBe(true);
      expect(transaction.works).toHaveLength(1);
      transaction.takeEncoded().complete?.();
      expect(pass.requiresFullSync).toBe(false);

      pass.destroy();
      expect(third.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        third.buffers.map(() => 1),
      );
      expect(renderer.indirectDestroyCalls).toEqual([1, 1, 1]);
      expect(() => pass.destroy()).not.toThrow();
      expect(renderer.indirectDestroyCalls).toEqual([1, 1, 1]);
    } finally {
      restore();
    }
  });

  test("keeps old encoded-frame callbacks scoped to their captured device epoch", async () => {
    const restore = installComputeGpuGlobals();
    try {
      const transaction = trackedComputeTransaction();
      const first = trackedComputeDevice("race-first");
      const renderer = trackedComputeRenderer(first.device);
      const pass = new ComputeCullPass(renderer.renderer, transaction.value as never);
      const records = packCullRecords([
        { minX: 0, minY: 0, maxX: 8, maxY: 10, instanceOffset: 0, instanceCount: 1 },
      ]);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      expect(pass.uploadRecords(records, 1, "all")).toBe(true);
      expect(pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 })).toBe(true);
      const oldWork = transaction.takeEncoded();
      oldWork.encode?.(first.encoder);

      first.resolveLost();
      await settleComputePromises();
      expect(pass.requiresFullSync).toBe(true);

      const second = trackedComputeDevice("race-second");
      renderer.gpu.device = second.device;
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      expect(pass.uploadRecords(records, 1, "none")).toBe(true);
      expect(pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 })).toBe(true);
      const currentWork = transaction.takeEncoded();

      oldWork.complete?.();
      expect(pass.requiresFullSync).toBe(true);
      oldWork.cancel?.("failed");
      oldWork.fail?.(new Error("stale encoded-frame failure"));
      expect(pass.failureReason).toBeUndefined();
      expect(pass.requiresFullSync).toBe(true);

      currentWork.complete?.();
      expect(pass.requiresFullSync).toBe(false);
      expect(pass.failureReason).toBeUndefined();
      oldWork.cancel?.("failed");
      oldWork.fail?.(new Error("late stale encoded-frame failure"));
      expect(pass.requiresFullSync).toBe(false);
      expect(pass.failureReason).toBeUndefined();
      pass.destroy();
    } finally {
      restore();
    }
  });

  test("contains every queued dispatch preparation failure and recovers the current device epoch", () => {
    const restore = installComputeGpuGlobals();
    try {
      for (const stage of [
        "indirect",
        "uniform",
        "bind-group",
        "transaction-epoch",
        "transaction-queue",
        "transaction-rejected",
      ] as const) {
        const expectedFailure = {
          indirect: "injected indirect handle failure",
          uniform: "injected uniform write failure",
          "bind-group": "injected bind-group failure",
          "transaction-epoch": "injected transaction epoch failure",
          "transaction-queue": "injected transaction queue failure",
          "transaction-rejected": "injected transaction rejected failure",
        }[stage];
        const tracked = trackedComputeDevice(`dispatch-${stage}`);
        const renderer = trackedComputeRenderer(tracked.device);
        const transaction = trackedComputeTransaction();
        let armed = false;
        const originalGetGpuBuffer = renderer.renderer.buffer.getGPUBuffer.bind(
          renderer.renderer.buffer,
        );
        renderer.renderer.buffer.getGPUBuffer = ((buffer: object) => {
          if (armed && stage === "indirect") {
            throw new Error("injected indirect handle failure");
          }
          return originalGetGpuBuffer(buffer as never);
        }) as never;
        const originalWriteBuffer = tracked.device.queue.writeBuffer.bind(tracked.device.queue);
        tracked.device.queue.writeBuffer = ((...args: Parameters<GPUQueue["writeBuffer"]>) => {
          if (armed && stage === "uniform") {
            throw new Error("injected uniform write failure");
          }
          originalWriteBuffer(...args);
        }) as never;
        const originalCreateBindGroup = tracked.device.createBindGroup.bind(tracked.device);
        tracked.device.createBindGroup = ((descriptor: GPUBindGroupDescriptor) => {
          if (armed && stage === "bind-group") {
            throw new Error("injected bind-group failure");
          }
          return originalCreateBindGroup(descriptor);
        }) as never;
        const transactionValue = {
          get currentEpoch() {
            if (armed && stage === "transaction-epoch") {
              throw new Error("injected transaction epoch failure");
            }
            return transaction.value.currentEpoch;
          },
          queue(stageName: string, epoch: number, work: TrackedComputeWork) {
            if (armed && stage === "transaction-queue") {
              throw new Error("injected transaction queue failure");
            }
            if (armed && stage === "transaction-rejected") {
              work.fail?.(new Error("injected transaction rejected failure"));
              return false;
            }
            return transaction.value.queue(stageName, epoch, work);
          },
          cancelEpoch: transaction.value.cancelEpoch,
          flush: transaction.value.flush,
        };
        const pass = new ComputeCullPass(renderer.renderer, transactionValue as never);
        const records = packCullRecords([
          { minX: 0, minY: 0, maxX: 8, maxY: 10, instanceOffset: 0, instanceCount: 1 },
        ]);

        expect(pass.initialize()).toBe(true);
        expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
        expect(pass.uploadRecords(records, 1, "all")).toBe(true);
        expect(pass.lastRecordUploadBytes).toBe(CULL_RECORD_STRIDE);
        armed = true;

        let dispatchResult: boolean | undefined;
        expect(() => {
          dispatchResult = pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 });
        }).not.toThrow();
        expect(dispatchResult).toBe(false);
        expect(transaction.works).toHaveLength(0);
        expect(pass.synced).toBe(false);
        expect(pass.requiresFullSync).toBe(true);
        expect(pass.failureReason).toContain(expectedFailure);
        expect(pass.recordWrites).toBe(1);

        armed = false;
        expect(pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 })).toBe(false);
        expect(pass.requiresFullSync).toBe(true);
        expect(transaction.works).toHaveLength(0);
        expect(pass.uploadRecords(records, 1, "all")).toBe(true);
        expect(pass.dispatch({ x: 0, y: 0, width: 20, height: 20, padding: 0 })).toBe(true);
        expect(transaction.works).toHaveLength(1);
        transaction.takeEncoded().complete?.();
        expect(pass.requiresFullSync).toBe(false);
        expect(pass.failureReason).toBeUndefined();

        pass.destroy();
        expect(tracked.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
          tracked.buffers.map(() => 1),
        );
        expect(renderer.indirectDestroyCalls).toEqual([1]);
      }
    } finally {
      restore();
    }
  });

  test("encodes compute cull into the Pixi frame submission", () => {
    const pipelines: string[] = [];
    const submits: unknown[] = [];
    const computePassDescriptors: Array<GPUComputePassDescriptor | undefined> = [];
    let failSubmit = false;
    const indirect = { size: 20, usage: 0x0188, destroy() {} };
    const device = {
      limits: COMPUTE_DEVICE_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => ({
        entryPoint: compute.entryPoint,
      }),
      createBuffer: ({ size, usage }: { size: number; usage: number }) => ({
        size,
        usage,
        destroy() {},
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: (descriptor?: GPUComputePassDescriptor) => {
          computePassDescriptors.push(descriptor);
          return {
            setBindGroup() {},
            setPipeline: (pipeline: { entryPoint: string }) => pipelines.push(pipeline.entryPoint),
            dispatchWorkgroups() {},
            end() {},
          };
        },
        finish: () => ({ label: "pixi-frame" }),
      }),
      queue: {
        writeBuffer() {},
        submit: (commands: unknown) => {
          if (failSubmit) throw new Error("injected compute frame submit failure");
          submits.push(commands);
        },
      },
    };
    const encoder = {
      commandEncoder: null as GPUCommandEncoder | null,
      draw() {},
      renderStart() {
        this.commandEncoder = device.createCommandEncoder() as unknown as GPUCommandEncoder;
      },
      postrender() {
        const commandEncoder = this.commandEncoder;
        if (commandEncoder === null) throw new Error("missing fake command encoder");
        device.queue.submit([commandEncoder.finish()]);
        this.commandEncoder = null;
      },
    };
    const renderer = {
      gpu: { device },
      buffer: {
        updateBuffer() {},
        getGPUBuffer: () => indirect,
      },
      encoder,
    } as unknown as WebGPURenderer;
    const restoreGpuGlobals = installComputeGpuGlobals();
    try {
      const transaction = new WebGPUFrameTransaction(renderer);
      const querySet = {} as GPUQuerySet;
      const detachTimestampObserver = observeWebGPUFrameTimestamps(renderer, {
        beginFrame: () => ({
          querySet,
          paletteStartQuery: 2,
          paletteEndQuery: 3,
          cullStartQuery: 4,
          cullEndQuery: 5,
        }),
      });
      const pass = new ComputeCullPass(renderer, transaction);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      const records = packCullRecords([
        { minX: 0, minY: 0, maxX: 1, maxY: 1, instanceOffset: 0, instanceCount: 1 },
      ]);
      expect(pass.uploadRecords(records, 1, "all")).toBe(true);
      expect(pass.dispatch({ x: 0, y: 0, width: 10, height: 10, padding: 0 })).toBe(true);
      expect(submits).toHaveLength(0);

      renderer.encoder.renderStart();
      renderer.encoder.postrender();

      expect(pipelines).toEqual(COMPUTE_PIPELINE_ENTRIES);
      expect(submits).toHaveLength(1);
      expect(computePassDescriptors[0]).toEqual({
        timestampWrites: {
          querySet,
          beginningOfPassWriteIndex: 4,
          endOfPassWriteIndex: 5,
        },
      });
      expect(transaction.stats).toMatchObject({ fusedSubmissions: 1, submissions: 1 });

      expect(pass.dispatch({ x: 0, y: 0, width: 10, height: 10, padding: 0 })).toBe(true);
      renderer.encoder.renderStart();
      failSubmit = true;
      expect(() => renderer.encoder.postrender()).toThrow("injected compute frame submit failure");
      expect(submits).toHaveLength(1);
      expect(pass.failureReason).toContain("injected compute frame submit failure");
      expect(transaction.stats).toMatchObject({
        encodedWork: 1,
        failedWork: 1,
        fusedSubmissions: 1,
        submissions: 1,
      });

      failSubmit = false;
      expect(pass.uploadRecords(records, 1, "none")).toBe(true);
      expect(pass.dispatch({ x: 0, y: 0, width: 10, height: 10, padding: 0 })).toBe(true);
      renderer.encoder.renderStart();
      renderer.encoder.postrender();
      expect(submits).toHaveLength(2);
      expect(transaction.stats).toMatchObject({
        encodedWork: 2,
        failedWork: 1,
        fusedSubmissions: 2,
        submissions: 2,
      });
      transaction.destroy();
      detachTimestampObserver();
      pass.destroy();
    } finally {
      restoreGpuGlobals();
    }
  });

  test("rolls back a partial capacity allocation and keeps the live record set", () => {
    const buffers: Array<{
      readonly size: number;
      readonly usage: number;
      readonly destroyError: Error | undefined;
      destroyCalls: number;
      destroy(): void;
    }> = [];
    let createCalls = 0;
    let failAt = Number.POSITIVE_INFINITY;
    let faultCandidateCleanup = false;
    const device = {
      limits: COMPUTE_DEVICE_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: ({ size, usage }: { size: number; usage: number }) => {
        createCalls += 1;
        if (createCalls === failAt) throw new Error("injected third allocation failure");
        const buffer = {
          size,
          usage,
          destroyError: faultCandidateCleanup
            ? new Error(`injected candidate ${String(createCalls)} cleanup failure`)
            : undefined,
          destroyCalls: 0,
          destroy() {
            this.destroyCalls += 1;
            if (this.destroyError !== undefined) throw this.destroyError;
          },
        };
        buffers.push(buffer);
        return buffer;
      },
      queue: { writeBuffer() {} },
    };
    const renderer = basicComputeRenderer(device);
    const restoreGpuGlobals = installComputeGpuGlobals();
    try {
      const pass = new ComputeCullPass(renderer);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      const initialBuffers = buffers.slice();
      const live = pass.getResidentRecords();
      expect(live.ok).toBe(true);
      if (!live.ok) throw new Error(live.reason);

      failAt = createCalls + 3;
      faultCandidateCleanup = true;
      expect(pass.ensureCapacity(257, 257 * GLYPH_DRAW_STRIDE)).toBe(false);
      faultCandidateCleanup = false;

      const candidates = buffers.slice(initialBuffers.length);
      const retained = pass.getResidentRecords();
      expect(candidates.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
      expect(initialBuffers.map((buffer) => buffer.destroyCalls)).toEqual(
        initialBuffers.map(() => 0),
      );
      expect(retained.ok).toBe(true);
      if (!retained.ok) throw new Error(retained.reason);
      expect(retained.buffer).toBe(live.buffer);
      expect(retained.epoch).toBe(live.epoch);
      expect(pass.failureReason).toContain("injected third allocation failure");

      pass.destroy();
      expect(candidates.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
      expect(initialBuffers.map((buffer) => buffer.destroyCalls)).toEqual(
        initialBuffers.map(() => 1),
      );
    } finally {
      restoreGpuGlobals();
    }
  });

  test("detaches compute resources and continues destruction after multiple faults", () => {
    const firstError = new Error("injected cull records cleanup failure");
    const buffers: Array<{
      readonly label: string;
      readonly destroyError: Error | undefined;
      destroyCalls: number;
      destroy(): void;
    }> = [];
    const device = {
      limits: COMPUTE_DEVICE_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: ({ label }: { label: string }) => {
        const buffer = {
          label,
          destroyError:
            label === "pixi-glyphflow-cull-records"
              ? firstError
              : label === "pixi-glyphflow-cull-group-sums"
                ? new Error("injected group sums cleanup failure")
                : undefined,
          destroyCalls: 0,
          destroy() {
            this.destroyCalls += 1;
            if (this.destroyError !== undefined) throw this.destroyError;
          },
        };
        buffers.push(buffer);
        return buffer;
      },
      queue: { writeBuffer() {} },
    };
    const originalDraw = (): void => {};
    const renderer = {
      gpu: { device },
      buffer: {
        updateBuffer() {},
        getGPUBuffer: () => ({ size: 20, usage: 0x0188, destroy() {} }),
      },
      encoder: { draw: originalDraw },
    } as unknown as WebGPURenderer;
    const restoreGpuGlobals = installComputeGpuGlobals();
    try {
      const pass = new ComputeCullPass(renderer);
      let indirectDestroyCalls = 0;
      pass.indirectBuffer.on("destroy", () => {
        indirectDestroyCalls += 1;
        throw new Error("injected indirect cleanup failure");
      });
      expect(pass.initialize()).toBe(true);
      expect(renderer.encoder.draw).not.toBe(originalDraw);
      expect(pass.ensureCapacity(1, GLYPH_DRAW_STRIDE)).toBe(true);
      expect(pass.ensureCapacity(257, 257 * GLYPH_DRAW_STRIDE)).toBe(true);

      expect(() => pass.destroy()).toThrow(firstError);

      expect(renderer.encoder.draw).toBe(originalDraw);
      expect(buffers.map((buffer) => buffer.destroyCalls)).toEqual(buffers.map(() => 1));
      expect(indirectDestroyCalls).toBe(1);
      expect(pass.getResidentRecords()).toMatchObject({ ok: false });
      expect(() => pass.destroy()).not.toThrow();
      expect(buffers.map((buffer) => buffer.destroyCalls)).toEqual(buffers.map(() => 1));
      expect(indirectDestroyCalls).toBe(1);
    } finally {
      restoreGpuGlobals();
    }
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

  test("hashes the ordered compacted draw sequence", () => {
    const selected = new Uint32Array([0, 7, 0, 9, 0, 11]);
    const wrongSameCount = new Uint32Array([0, 7, 0, 11, 0, 9]);

    expect(hashComputeCullDrawInstances(selected, 3)).not.toBe(
      hashComputeCullDrawInstances(wrongSameCount, 3),
    );
    expect(hashComputeCullDrawInstances(selected, 2)).toBe(
      hashComputeCullDrawInstances(selected.subarray(0, 4), 2),
    );
    expect(() => hashComputeCullDrawInstances(selected, 4)).toThrow(
      "instance count exceeds the compacted output",
    );
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

  test("packs AABB, instance range, palette, and local-bounds index into 32-byte records", () => {
    const records = packCullRecords([
      {
        minX: 1,
        minY: 2,
        maxX: 3,
        maxY: 4,
        instanceOffset: 5,
        instanceCount: 6,
        paletteIndex: 7,
        localBoundsIndex: 9,
      },
    ]);
    const view = new DataView(records);
    expect(records.byteLength).toBe(32);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(2);
    expect(view.getFloat32(8, true)).toBe(3);
    expect(view.getFloat32(12, true)).toBe(4);
    expect(view.getUint32(16, true)).toBe(5);
    expect(view.getUint32(20, true)).toBe(6);
    expect(view.getUint32(24, true)).toBe(7);
    expect(view.getUint32(28, true)).toBe(9);
  });

  test("keeps stable record order across scan boundaries and a million records", () => {
    for (const count of [0, 1, 255, 256, 257, 1_000_000]) {
      const records = new ArrayBuffer(count * 32);
      const floats = new Float32Array(records);
      const words = new Uint32Array(records);
      for (let index = 0; index < count; index += 1) {
        const base = index * 8;
        floats[base] = index;
        floats[base + 1] = 0;
        floats[base + 2] = index + 0.5;
        floats[base + 3] = 0.5;
        words[base + 4] = 0;
        words[base + 5] = 1;
        words[base + 6] = index;
      }
      const result = compactVisibleInstances(records, count, new ArrayBuffer(0), {
        x: 0,
        y: 0,
        width: count,
        height: 1,
        padding: 0,
      });
      expect(result.instanceCount).toBe(count);
      expect(result.indirect).toEqual(createIndirectArgs(count));
      const compact = new Uint32Array(result.compact.buffer);
      if (count > 0) {
        expect(Array.from(compact.subarray(0, 2))).toEqual([0, 0]);
        expect(Array.from(compact.subarray(compact.length - 2))).toEqual([0, count - 1]);
      }
    }
  });

  test("keeps tombstones in place with instance_count zero", () => {
    const records = packCullRecords([
      {
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        instanceOffset: 0,
        instanceCount: 1,
        paletteIndex: 10,
      },
      {
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        instanceOffset: 0,
        instanceCount: 0,
        paletteIndex: 11,
      },
      {
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        instanceOffset: 0,
        instanceCount: 1,
        paletteIndex: 12,
      },
    ]);
    const result = compactVisibleInstances(records, 3, new ArrayBuffer(0), {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      padding: 0,
    });
    expect(result.instanceCount).toBe(2);
    expect(Array.from(new Uint32Array(result.compact.buffer))).toEqual([0, 10, 0, 12]);
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
    expect(cpu.remainingInspections).toBe(Number.POSITIVE_INFINITY);
    expect(tryAdmitOffscreen(cpu)).toBe(true);
    expect(cpu.deferred).toBe(false);
    expect(DEFAULT_OFFSCREEN_ADMIT_BUDGET_BYTES / OFFSCREEN_ADMIT_LABEL_BYTES).toBe(2048);

    const budget = createOffscreenAdmitBudget({
      cullPath: "compute-cull",
      budgetBytes: OFFSCREEN_ADMIT_LABEL_BYTES,
    });
    expect(budget.remainingInspections).toBe(1);
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

  test("continues bounded ring inspection in order and resets on a new generation", () => {
    const first = planOffscreenAdmissionWindow({
      generation: 7,
      cursor: undefined,
      candidateCount: 5,
      maxInspections: 2,
    });
    expect(first).toEqual({
      start: 0,
      end: 2,
      nextCursor: { generation: 7, index: 2 },
      reset: true,
      completedCycle: false,
      deferred: true,
    });

    const second = planOffscreenAdmissionWindow({
      generation: 7,
      cursor: first.nextCursor,
      candidateCount: 5,
      maxInspections: 2,
    });
    expect(second).toMatchObject({
      start: 2,
      end: 4,
      reset: false,
      completedCycle: false,
      deferred: true,
    });

    const wrapped = planOffscreenAdmissionWindow({
      generation: 7,
      cursor: second.nextCursor,
      candidateCount: 5,
      maxInspections: 2,
    });
    expect(wrapped).toEqual({
      start: 4,
      end: 5,
      nextCursor: { generation: 7, index: 0 },
      reset: false,
      completedCycle: true,
      deferred: false,
    });

    const reset = planOffscreenAdmissionWindow({
      generation: 8,
      cursor: second.nextCursor,
      candidateCount: 6,
      maxInspections: 2,
    });
    expect(reset).toMatchObject({
      start: 0,
      end: 2,
      nextCursor: { generation: 8, index: 2 },
      reset: true,
    });
  });

  test("shares one off-screen inspection budget across repeated scans in a commit", () => {
    const budget = createOffscreenAdmitBudget({
      cullPath: "compute-cull",
      budgetBytes: OFFSCREEN_ADMIT_LABEL_BYTES * 3,
    });
    const first = planBudgetedOffscreenAdmissionWindow({
      generation: 4,
      cursor: undefined,
      candidateCount: 10,
      budget,
    });
    const second = planBudgetedOffscreenAdmissionWindow({
      generation: 4,
      cursor: first.nextCursor,
      candidateCount: 10,
      budget,
    });

    expect(first).toMatchObject({ start: 0, end: 3, deferred: true });
    expect(second).toMatchObject({
      start: 3,
      end: 3,
      nextCursor: first.nextCursor,
      deferred: true,
    });
    expect(first.end - first.start + (second.end - second.start)).toBe(3);
    expect(budget.remainingInspections).toBe(0);
    expect(budget.deferred).toBe(true);
  });

  test("covers a stable ring exactly in insertion order before wrapping", () => {
    const candidates = [11, 3, 19, 7, 23];
    const inspected: number[] = [];
    let cursor: { readonly generation: number; readonly index: number } | undefined;
    let completed = false;
    while (!completed) {
      const window = planOffscreenAdmissionWindow({
        generation: 2,
        cursor,
        candidateCount: candidates.length,
        maxInspections: 2,
      });
      inspected.push(...candidates.slice(window.start, window.end));
      cursor = window.nextCursor;
      completed = window.completedCycle;
    }
    expect(inspected).toEqual(candidates);
    expect(cursor).toEqual({ generation: 2, index: 0 });
  });

  test("restarts before inserts and after a deletion shrinks past the cursor", () => {
    const first = planOffscreenAdmissionWindow({
      generation: 4,
      cursor: undefined,
      candidateCount: 6,
      maxInspections: 4,
    });
    const inserted = planOffscreenAdmissionWindow({
      generation: 5,
      cursor: first.nextCursor,
      candidateCount: 7,
      maxInspections: 2,
    });
    expect(inserted).toMatchObject({ start: 0, end: 2, reset: true });

    const deleted = planOffscreenAdmissionWindow({
      generation: 5,
      cursor: { generation: 5, index: 6 },
      candidateCount: 3,
      maxInspections: 2,
    });
    expect(deleted).toMatchObject({ start: 0, end: 2, reset: true });
  });

  test("keeps a tight conversion outside the off-screen cursor window immediately eligible", () => {
    const draw = { x: 0, y: 0, width: 100, height: 100, padding: 0 };
    const ring = expandPrepareRing(draw);
    const window = planOffscreenAdmissionWindow({
      generation: 3,
      cursor: undefined,
      candidateCount: 4,
      maxInspections: 1,
    });
    expect(window).toMatchObject({ start: 0, end: 1, deferred: true });
    expect(
      classifyAdmitSlot({
        cullPath: "compute-cull",
        ring,
        draw,
        interned: false,
        groupHasTight: false,
        minX: 10,
        minY: 10,
        maxX: 18,
        maxY: 20,
      }),
    ).toBe("tight");
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

interface TrackedComputeBuffer {
  readonly label: string;
  readonly size: number;
  readonly usage: number;
  destroyCalls: number;
  destroy(): void;
}

interface TrackedComputeWork {
  encode?(encoder: GPUCommandEncoder): void;
  complete?(): void;
  cancel?(reason: "superseded" | "stale" | "destroyed" | "failed"): void;
  fail?(error: unknown): void;
}

function basicComputeRenderer(device: object): WebGPURenderer {
  return {
    gpu: { device },
    buffer: {
      updateBuffer() {},
      getGPUBuffer: () => ({ size: 20, usage: 0x0188, destroy() {} }),
    },
    encoder: { draw(): void {} },
  } as unknown as WebGPURenderer;
}

function trackedComputeDevice(name: string): {
  readonly device: GPUDevice;
  readonly buffers: TrackedComputeBuffer[];
  readonly encoder: GPUCommandEncoder;
  resolveLost(): void;
} {
  const buffers: TrackedComputeBuffer[] = [];
  let resolveLostPromise = (_info: unknown): void => {};
  const lost = new Promise<unknown>((resolve) => {
    resolveLostPromise = resolve;
  });
  const encoder = {
    beginComputePass: () => ({
      setBindGroup() {},
      setPipeline() {},
      dispatchWorkgroups() {},
      end() {},
    }),
    finish: () => ({}),
  } as unknown as GPUCommandEncoder;
  const device = {
    name,
    lost,
    limits: COMPUTE_DEVICE_LIMITS,
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => ({
      entryPoint: compute.entryPoint,
      device: name,
    }),
    createBuffer: ({ label, size, usage }: { label?: string; size: number; usage: number }) => {
      const buffer: TrackedComputeBuffer = {
        label: label ?? "buffer",
        size,
        usage,
        destroyCalls: 0,
        destroy() {
          this.destroyCalls += 1;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => ({ device: name }),
    createCommandEncoder: () => encoder,
    queue: {
      writeBuffer() {},
      submit() {},
    },
  } as unknown as GPUDevice;
  return {
    device,
    buffers,
    encoder,
    resolveLost() {
      resolveLostPromise({ message: `${name} lost` });
    },
  };
}

function trackedComputeRenderer(initialDevice: GPUDevice): {
  readonly renderer: WebGPURenderer;
  readonly gpu: { device: GPUDevice };
  readonly indirectHandles: object[];
  readonly indirectDestroyCalls: number[];
} {
  const gpu = { device: initialDevice };
  const indirectHandles: object[] = [];
  const indirectDestroyCalls: number[] = [];
  const handles = new WeakMap<object, object>();
  const renderer = {
    gpu,
    buffer: {
      updateBuffer(buffer: { on(type: string, listener: () => void): void }) {
        if (handles.has(buffer)) return;
        const index = indirectHandles.length;
        const handle = { indirect: index, device: gpu.device };
        handles.set(buffer, handle);
        indirectHandles.push(handle);
        indirectDestroyCalls.push(0);
        buffer.on("destroy", () => {
          indirectDestroyCalls[index] = (indirectDestroyCalls[index] ?? 0) + 1;
        });
      },
      getGPUBuffer(buffer: object) {
        return handles.get(buffer) ?? { indirect: "uninitialized", device: gpu.device };
      },
    },
    encoder: { draw(): void {} },
  } as unknown as WebGPURenderer;
  return { renderer, gpu, indirectHandles, indirectDestroyCalls };
}

function trackedComputeTransaction(): {
  readonly value: {
    readonly currentEpoch: number;
    queue(stage: string, epoch: number, work: TrackedComputeWork): boolean;
    cancelEpoch(epoch: number): number;
    flush(): { readonly ok: true };
  };
  readonly works: Array<{ readonly epoch: number; readonly work: TrackedComputeWork }>;
  takeEncoded(): TrackedComputeWork;
} {
  const works: Array<{ readonly epoch: number; readonly work: TrackedComputeWork }> = [];
  let currentEpoch = 0;
  const value = {
    get currentEpoch() {
      return currentEpoch;
    },
    queue(_stage: string, epoch: number, work: TrackedComputeWork) {
      works.push({ epoch, work });
      return true;
    },
    cancelEpoch(epoch: number) {
      let cancelled = 0;
      for (let index = works.length - 1; index >= 0; index -= 1) {
        const pending = works[index];
        if (pending?.epoch !== epoch) continue;
        works.splice(index, 1);
        pending.work.cancel?.("stale");
        cancelled += 1;
      }
      if (cancelled > 0 && epoch === currentEpoch) currentEpoch += 1;
      return cancelled;
    },
    flush: () => ({ ok: true as const }),
  };
  return {
    value,
    works,
    takeEncoded() {
      const pending = works.shift();
      if (pending === undefined) throw new Error("Expected one queued compute work item");
      return pending.work;
    },
  };
}

function installComputeGpuGlobals(): () => void {
  return installWebGpuGlobals({
    GPUShaderStage: { COMPUTE: 4 },
    GPUBufferUsage: {
      STORAGE: 0x0080,
      COPY_SRC: 0x0004,
      COPY_DST: 0x0008,
      VERTEX: 0x0020,
      UNIFORM: 0x0040,
    },
  });
}

async function settleComputePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
