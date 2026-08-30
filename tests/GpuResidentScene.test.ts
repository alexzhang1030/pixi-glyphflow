import { describe, expect, test } from "bun:test";

import { compactVisibleInstances } from "../src/culling/computeCull";
import {
  GpuResidentScene,
  GPU_RESIDENT_RECORD_STRIDE,
  gpuResidentAdmitEligible,
} from "../src/render/GpuResidentScene";
import {
  PALETTE_DENSE_MOVE_STRIDE,
  PALETTE_DENSE_MOVE_WORDS,
  PALETTE_MOVE_STRIDE,
  PALETTE_MOVE_WORDS,
} from "../src/render/paletteStorage";

const VIEWPORT = Object.freeze({ x: 0, y: 0, width: 100, height: 100, padding: 0 });

describe("GpuResidentScene", () => {
  test("sets up interleaved prototype columns over one exact dense slot union", () => {
    const scene = new GpuResidentScene({ initialCapacity: 4, maxCapacity: 4 });
    scene.setupMany([
      {
        ...column([0, 2], [10, 30], 4, 2),
        xy: new Float32Array([10, 20, 30, 40]),
        localBounds: new Float32Array([-1, -2, 8, 6]),
        instanceOffset: 11,
      },
      {
        ...column([1, 3], [20, 40], 9, 1),
        xy: new Float32Array([50, 60, 70, 80]),
        localBounds: new Float32Array([-3, -4, 12, 10]),
        instanceOffset: 21,
      },
    ]);

    const update = scene.snapshot(VIEWPORT);
    const floats = new Float32Array(update.records);
    const uints = new Uint32Array(update.records);
    expect(update.recordCount).toBe(4);
    expect(update.drawInstanceCount).toBe(6);
    expect(Array.from(floats.subarray(0, 4))).toEqual([9, 18, 17, 24]);
    expect(Array.from(uints.subarray(4, 8))).toEqual([11, 2, 0, 0]);
    expect(Array.from(floats.subarray(8, 12))).toEqual([47, 56, 59, 66]);
    expect(Array.from(uints.subarray(12, 16))).toEqual([21, 1, 1, 1]);
    expect(Array.from(floats.subarray(16, 20))).toEqual([29, 38, 37, 44]);
    expect(Array.from(uints.subarray(20, 24))).toEqual([11, 2, 2, 0]);
    expect(Array.from(floats.subarray(24, 28))).toEqual([67, 76, 79, 86]);
    expect(Array.from(uints.subarray(28, 32))).toEqual([21, 1, 3, 1]);
    expect(Array.from(update.localBounds.subarray(0, 8))).toEqual([-1, -2, 8, 6, -3, -4, 12, 10]);
    expect(scene.stats).toMatchObject({
      activeLabels: 4,
      activeGlyphInstances: 6,
      prototypeCount: 2,
    });

    scene.destroy();
  });

  test("validates the complete setupMany union before replacing an active scene", () => {
    const scene = new GpuResidentScene({ initialCapacity: 4, maxCapacity: 4 });
    scene.setup(column([0, 1], [1, 2], 1));
    const before = new Uint8Array(scene.snapshot(VIEWPORT).records).slice();

    expect(() => scene.setupMany([column([0, 2], [3, 5], 2), column([2], [4], 3)])).toThrow(
      "GPU resident setup requires columns whose union is exactly dense",
    );
    expect(scene.stats).toMatchObject({ activeLabels: 2, recordCount: 2, prototypeCount: 1 });
    expect(Array.from(new Uint8Array(scene.snapshot(VIEWPORT).records))).toEqual(
      Array.from(before),
    );

    scene.destroy();
  });

  test("appends interleaved prototype columns as one monotonic dense revision", () => {
    const scene = new GpuResidentScene({ initialCapacity: 2, maxCapacity: 8 });
    scene.setup(column([0, 1], [1, 2], 1));
    scene.snapshot(VIEWPORT);

    expect(
      scene.appendMany([
        { ...column([2, 4], [3, 5], 2, 1), instanceOffset: 20 },
        { ...column([3, 5], [4, 6], 3, 3), instanceOffset: 30 },
      ]),
    ).toBe(true);
    const update = scene.snapshot(VIEWPORT);
    const uints = new Uint32Array(update.records);
    expect(update.recordCount).toBe(6);
    expect(update.drawInstanceCount).toBe(12);
    expect(Array.from([uints[20], uints[28], uints[36], uints[44]])).toEqual([20, 30, 20, 30]);
    expect(scene.stats.prototypeCount).toBe(3);

    scene.destroy();
  });

  test("accepts slot zero after an empty setupMany revision", () => {
    const scene = new GpuResidentScene({ initialCapacity: 1, maxCapacity: 2 });
    scene.setupMany([]);

    expect(scene.appendMany([column([0], [0], 1)])).toBe(true);
    expect(scene.stats).toMatchObject({ activeLabels: 1, recordCount: 1 });

    scene.destroy();
  });

  test("sets up fixed slot-indexed local-bound records through typed columns", () => {
    const scene = new GpuResidentScene({ initialCapacity: 3 });
    scene.setup({
      slots: new Uint32Array([0, 1, 2]),
      count: 3,
      xy: new Float32Array([10, 20, 30, 40, 50, 60]),
      orders: new Uint32Array([1, 2, 3]),
      localBounds: new Float32Array([-1, -2, 10, 6]),
      prototypeId: 7,
      instanceOffset: 11,
      instanceCount: 2,
      zIndex: 0,
      blendMode: "normal",
    });

    const update = scene.snapshot(VIEWPORT);
    expect(update.recordDirty).toBe("all");
    expect(update.localBoundsDirty).toBe("all");
    expect(update.recordCount).toBe(3);
    expect(update.drawInstanceCount).toBe(6);
    expect(update.records.byteLength).toBe(3 * GPU_RESIDENT_RECORD_STRIDE);
    const floats = new Float32Array(update.records);
    const uints = new Uint32Array(update.records);
    expect(Array.from(floats.subarray(0, 4))).toEqual([9, 18, 19, 24]);
    expect(Array.from(uints.subarray(4, 8))).toEqual([11, 2, 0, 0]);
    expect(Array.from(floats.subarray(8, 12))).toEqual([29, 38, 39, 44]);
    expect(Array.from(uints.subarray(12, 16))).toEqual([11, 2, 1, 0]);
    expect(Array.from(update.localBounds)).toEqual([-1, -2, 10, 6]);
    expect(scene.stats).toMatchObject({
      activeLabels: 3,
      activeGlyphInstances: 6,
      recordCount: 3,
      recordBytes: 96,
      prototypeCount: 1,
      perLabelObjectCount: 0,
    });

    scene.destroy();
  });

  test("rounds resident max AABBs after each f32 addition at setup and CPU reconcile", () => {
    const originX = Math.fround(16_777_206);
    const localX = Math.fround(2.25);
    const width = Math.fround(9);
    const expectedMinX = Math.fround(16_777_208);
    const expectedMaxX = Math.fround(16_777_216);
    const scene = new GpuResidentScene({ initialCapacity: 1 });
    scene.setup({
      slots: new Uint32Array([0]),
      count: 1,
      xy: new Float32Array([originX, 0]),
      orders: new Uint32Array([1]),
      localBounds: new Float32Array([localX, 0, width, 1]),
      prototypeId: 0,
      instanceOffset: 0,
      instanceCount: 1,
      zIndex: 0,
      blendMode: "normal",
    });

    const setupRecord = new Float32Array(scene.snapshot(VIEWPORT).records);
    expect([setupRecord[0], setupRecord[2]]).toEqual([expectedMinX, expectedMaxX]);
    expect(
      compactVisibleInstances(setupRecord.buffer, 1, new ArrayBuffer(0), {
        x: expectedMaxX,
        y: 0,
        width: 0,
        height: 1,
        padding: 0,
      }).instanceCount,
    ).toBe(1);
    expect(
      compactVisibleInstances(setupRecord.buffer, 1, new ArrayBuffer(0), {
        x: expectedMaxX + 1,
        y: 0,
        width: 0,
        height: 1,
        padding: 0,
      }).instanceCount,
    ).toBe(0);

    scene.updatePositions(new Uint32Array([0]), 1, new Float32Array([originX, 0]));
    expect(scene.flushSpatialMoves(() => {})).toBe(1);
    const reconciledRecord = new Float32Array(scene.snapshot(VIEWPORT).records);
    expect([reconciledRecord[0], reconciledRecord[2]]).toEqual([expectedMinX, expectedMaxX]);
    expect(
      compactVisibleInstances(reconciledRecord.buffer, 1, new ArrayBuffer(0), {
        x: expectedMaxX + 1,
        y: 0,
        width: 0,
        height: 1,
        padding: 0,
      }).instanceCount,
    ).toBe(0);

    const expectedBits = new Uint32Array(new Float32Array([expectedMinX, expectedMaxX]).buffer);
    const actualBits = new Uint32Array(reconciledRecord.buffer);
    expect([actualBits[0], actualBits[2]]).toEqual(Array.from(expectedBits));
    scene.destroy();
  });

  test("keeps camera and position waves off the CPU cull-upload path", () => {
    const scene = new GpuResidentScene({ initialCapacity: 3 });
    setupMovableLabels(scene);
    scene.snapshot(VIEWPORT);
    const camera = scene.snapshot({ ...VIEWPORT, x: 12 });
    expect(camera.recordDirty).toBe("none");
    expect(camera.localBoundsDirty).toBe("none");

    const moved = scene.updatePositions(
      new Uint32Array([1, 2]),
      2,
      new Float32Array([100, 200, 300, 400]),
    );
    expect(moved.recordDirty).toBe("none");
    expect(moved.paletteMoves).toMatchObject({ mode: "dense", baseSlot: 1, count: 2 });
    expect(moved.paletteMoves.count).toBe(2);
    expect(moved.paletteMoves.commands.byteLength).toBe(2 * PALETTE_DENSE_MOVE_STRIDE);
    const commandFloats = new Float32Array(moved.paletteMoves.commands);
    expect([commandFloats[0], commandFloats[1]]).toEqual([100, 200]);
    expect([
      commandFloats[PALETTE_DENSE_MOVE_WORDS],
      commandFloats[PALETTE_DENSE_MOVE_WORDS + 1],
    ]).toEqual([300, 400]);
    expect(scene.stats.pendingSpatialMoves).toBe(2);

    const beforeFlush = new Float32Array(scene.snapshot(VIEWPORT).records);
    expect(Array.from(beforeFlush.subarray(8, 12))).toEqual([10, 15, 18, 21]);
    let flushedSlots = new Uint32Array();
    let flushedXy = new Float32Array();
    expect(
      scene.flushSpatialMoves((slots, count, xy) => {
        flushedSlots = slots.slice(0, count);
        flushedXy = xy.slice(0, count * 2);
      }),
    ).toBe(2);
    expect(Array.from(flushedSlots)).toEqual([1, 2]);
    expect(Array.from(flushedXy)).toEqual([100, 200, 300, 400]);
    const afterFlush = scene.snapshot(VIEWPORT);
    expect(afterFlush.recordDirty).toBe("none");
    expect(afterFlush.localBoundsDirty).toBe("none");
    expect(Array.from(new Float32Array(afterFlush.records).subarray(8, 12))).toEqual([
      100, 195, 108, 201,
    ]);
    expect(scene.stats.pendingSpatialMoves).toBe(0);

    scene.destroy();
  });

  test("passes through trusted packed movers and reconciles external origin columns", () => {
    const scene = new GpuResidentScene({ initialCapacity: 3 });
    setupMovableLabels(scene);
    scene.snapshot(VIEWPORT);
    const originX = new Float32Array([0, 100, 300]);
    const originY = new Float32Array([0, 200, 400]);
    scene.bindOriginColumns(originX, originY);
    scene.reservePositionNotes(2);
    const reservedBytes = scene.stats.allocatedBytes;
    expect(scene.notePosition(1)).toBe(true);
    expect(scene.notePosition(2)).toBe(true);
    expect(scene.stats.allocatedBytes).toBe(reservedBytes);

    const commands = new ArrayBuffer(2 * PALETTE_MOVE_STRIDE);
    const words = new Uint32Array(commands);
    const floats = new Float32Array(commands);
    words[0] = 1;
    floats[1] = 100;
    floats[2] = 200;
    words[PALETTE_MOVE_WORDS] = 2;
    floats[PALETTE_MOVE_WORDS + 1] = 300;
    floats[PALETTE_MOVE_WORDS + 2] = 400;
    const moved = scene.updatePositionsPacked({ mode: "indexed", commands, count: 2 });

    expect(moved.paletteMoves.commands).toBe(commands);
    expect(moved.paletteMoves.count).toBe(2);
    expect(moved.recordDirty).toBe("none");
    expect(scene.stats.pendingSpatialMoves).toBe(2);
    expect(scene.flushSpatialMoves(() => {})).toBe(2);
    const records = new Float32Array(scene.snapshot(VIEWPORT).records);
    expect(Array.from(records.subarray(8, 12))).toEqual([100, 195, 108, 201]);
    expect(Array.from(records.subarray(16, 20))).toEqual([300, 395, 308, 401]);

    scene.destroy();
  });

  test("keeps sparse scene movers indexed and passes dense leases through unchanged", () => {
    const scene = new GpuResidentScene({ initialCapacity: 4 });
    scene.setup(column([0, 1, 2, 3], [1, 2, 3, 4], 0));

    const sparse = scene.updatePositions(
      new Uint32Array([0, 2]),
      2,
      new Float32Array([10, 11, 20, 21]),
    );
    expect(sparse.paletteMoves.mode).toBe("indexed");
    expect(sparse.paletteMoves.commands.byteLength).toBe(2 * PALETTE_MOVE_STRIDE);
    const sparseWords = new Uint32Array(sparse.paletteMoves.commands);
    expect([sparseWords[0], sparseWords[PALETTE_MOVE_WORDS]]).toEqual([0, 2]);

    const commands = new Float32Array([30, 31, 40, 41]).buffer;
    const dense = scene.updatePositionsPacked({
      mode: "dense",
      baseSlot: 1,
      commands,
      count: 2,
    });
    expect(dense.paletteMoves).toMatchObject({ mode: "dense", baseSlot: 1, count: 2 });
    expect(dense.paletteMoves.commands).toBe(commands);

    expect(() =>
      scene.updatePositionsPacked({
        mode: "dense",
        baseSlot: 0xffff_ffff,
        commands,
        count: 2,
      }),
    ).toThrow("uint32 capacity");
    scene.destroy();
  });

  test("notes one packed authoritative-origin wave with duplicate and inactive slots", () => {
    const scene = new GpuResidentScene({ initialCapacity: 4 });
    setupMovableLabels(scene);
    scene.snapshot(VIEWPORT);
    const originX = new Float32Array([0, 100, 300, 0]);
    const originY = new Float32Array([0, 200, 400, 0]);
    scene.bindOriginColumns(originX, originY);
    scene.reservePositionNotes(5);
    const allocatedBytes = scene.stats.allocatedBytes;

    expect(scene.notePositions(new Uint32Array([1, 2, 1, 3, 2]), 5)).toBe(2);
    expect(scene.stats.allocatedBytes).toBe(allocatedBytes);
    expect(scene.stats.pendingSpatialMoves).toBe(2);
    expect(scene.notePositions(new Uint32Array([2, 1]), 2)).toBe(0);
    expect(scene.flushSpatialMoves(() => {})).toBe(2);
    const records = new Float32Array(scene.snapshot(VIEWPORT).records);
    expect(Array.from(records.subarray(8, 12))).toEqual([100, 195, 108, 201]);
    expect(Array.from(records.subarray(16, 20))).toEqual([300, 395, 308, 401]);

    scene.destroy();
  });

  test("keeps append growth transactional when external origin columns are short", () => {
    const scene = new GpuResidentScene({ initialCapacity: 2, maxCapacity: 8 });
    scene.setup(column([0, 1], [1, 2], 2));
    const before = scene.snapshot(VIEWPORT);
    const beforeRecords = new Uint8Array(before.records).slice();
    scene.bindOriginColumns(new Float32Array(2), new Float32Array(2));

    expect(() => scene.append(column([2], [3], 1))).toThrow(
      "GPU resident external origin columns are shorter than append capacity",
    );
    const rejected = scene.snapshot(VIEWPORT);
    expect(rejected.recordCount).toBe(before.recordCount);
    expect(rejected.records.byteLength).toBe(before.records.byteLength);
    expect(Array.from(new Uint8Array(rejected.records))).toEqual(Array.from(beforeRecords));

    scene.bindOriginColumns(new Float32Array(8), new Float32Array(8));
    expect(scene.append(column([2], [3], 1))).toBe(true);
    const appended = scene.snapshot(VIEWPORT);
    expect(appended.recordCount).toBe(3);
    expect(appended.records.byteLength).toBe(4 * GPU_RESIDENT_RECORD_STRIDE);
    scene.destroy();
  });

  test("appends records, tombstones removals, and signals slot reuse for repack", () => {
    const scene = new GpuResidentScene({ initialCapacity: 3, maxCapacity: 8 });
    scene.setup(column([0, 1, 2], [1, 2, 3], 4));
    scene.snapshot(VIEWPORT);

    expect(scene.remove(new Uint32Array([1]), 1)).toBe(1);
    expect(scene.isActive(1)).toBe(false);
    expect(scene.stats).toMatchObject({ activeLabels: 2, tombstones: 1, prototypeCount: 1 });
    const removed = scene.snapshot(VIEWPORT);
    expect(removed.drawInstanceCount).toBe(4);
    expect(removed.recordDirty).toEqual([{ offset: 32, length: 32 }]);
    expect(new Uint32Array(removed.records)[13]).toBe(0);

    expect(scene.append(column([3], [4], 5, 3))).toBe(true);
    const appended = scene.snapshot(VIEWPORT);
    expect(appended.recordCount).toBe(4);
    expect(appended.drawInstanceCount).toBe(7);
    expect(appended.recordDirty).toBe("all");
    expect(scene.stats).toMatchObject({
      activeLabels: 3,
      activeGlyphInstances: 7,
      tombstones: 1,
      prototypeCount: 2,
    });

    expect(scene.append(column([1], [5], 4))).toBe(false);
    expect(scene.repackRequired).toBe(true);
    expect(scene.stats.repackSignals).toBe(1);
    expect(scene.stats.activeGlyphInstances).toBe(7);
    scene.clearRepackSignal();
    expect(scene.repackRequired).toBe(false);

    scene.setup(column([0, 1, 2, 3], [1, 2, 3, 4], 4, 4));
    expect(scene.repackRequired).toBe(false);
    expect(scene.snapshot(VIEWPORT).drawInstanceCount).toBe(16);
    expect(scene.stats).toMatchObject({
      activeLabels: 4,
      activeGlyphInstances: 16,
      tombstones: 0,
      prototypeCount: 1,
    });

    scene.destroy();
  });

  test("rejects a draw-instance total beyond the uint32 indirect-count range", () => {
    const scene = new GpuResidentScene({ initialCapacity: 1, maxCapacity: 2 });
    scene.setup(column([0], [1], 4, 0xffff_ffff));

    expect(scene.snapshot(VIEWPORT).drawInstanceCount).toBe(0xffff_ffff);
    expect(() => scene.append(column([1], [2], 5, 1))).toThrow(
      "GPU resident draw instance count exceeds uint32 capacity",
    );
    expect(scene.stats.activeGlyphInstances).toBe(0xffff_ffff);

    scene.destroy();
  });

  test("admits only zero-z normal-blend columns whose slot order preserves draw order", () => {
    expect(gpuResidentAdmitEligible(column([0, 1], [1, 2], 1))).toBe(true);
    expect(gpuResidentAdmitEligible({ ...column([0, 1], [1, 2], 1), zIndex: 1 })).toBe(false);
    expect(gpuResidentAdmitEligible({ ...column([0, 1], [1, 2], 1), blendMode: "add" })).toBe(
      false,
    );
    expect(gpuResidentAdmitEligible(column([0, 1], [2, 1], 1))).toBe(false);
  });

  test("projects one million shared labels into one prototype and 32-byte records", () => {
    const count = 1_000_000;
    const slots = new Uint32Array(count);
    const orders = new Uint32Array(count);
    const xy = new Float32Array(count * 2);
    for (let slot = 0; slot < count; slot += 1) {
      slots[slot] = slot;
      orders[slot] = slot + 1;
      xy[slot * 2] = slot % 1_000;
      xy[slot * 2 + 1] = Math.floor(slot / 1_000);
    }
    const scene = new GpuResidentScene({ initialCapacity: count, maxCapacity: count });
    scene.setup({
      slots,
      count,
      xy,
      orders,
      localBounds: new Float32Array([0, -5, 8, 6]),
      prototypeId: 0,
      instanceOffset: 0,
      instanceCount: 2,
      zIndex: 0,
      blendMode: "normal",
    });

    const update = scene.snapshot(VIEWPORT);
    expect(update.records.byteLength).toBe(count * 32);
    expect(update.drawInstanceCount).toBe(count * 2);
    expect(update.localBounds.byteLength).toBe(16);
    expect(scene.stats).toMatchObject({
      activeLabels: count,
      recordCount: count,
      recordBytes: count * 32,
      prototypeCount: 1,
      perLabelObjectCount: 0,
    });

    scene.destroy();
  });

  test("destroys owned buffers idempotently and closes every query seam", () => {
    const scene = new GpuResidentScene({ initialCapacity: 1 });
    scene.setup(column([0], [1], 0));
    scene.destroy();
    scene.destroy();

    expect(() => scene.snapshot(VIEWPORT)).toThrow("GpuResidentScene has been destroyed");
    expect(() => scene.isActive(0)).toThrow("GpuResidentScene has been destroyed");
    expect(() => scene.stats).toThrow("GpuResidentScene has been destroyed");
  });
});

function setupMovableLabels(scene: GpuResidentScene): void {
  scene.setup({
    slots: new Uint32Array([0, 1, 2]),
    count: 3,
    xy: new Float32Array([0, 0, 10, 20, 30, 40]),
    orders: new Uint32Array([1, 2, 3]),
    localBounds: new Float32Array([0, -5, 8, 6]),
    prototypeId: 0,
    instanceOffset: 4,
    instanceCount: 2,
    zIndex: 0,
    blendMode: "normal",
  });
}

function column(
  slots: readonly number[],
  orders: readonly number[],
  prototypeId: number,
  instanceCount = 2,
): Parameters<GpuResidentScene["setup"]>[0] {
  const xy = new Float32Array(slots.length * 2);
  for (let index = 0; index < slots.length; index += 1) {
    xy[index * 2] = index * 10;
    xy[index * 2 + 1] = index * 20;
  }
  return {
    slots: Uint32Array.from(slots),
    count: slots.length,
    xy,
    orders: Uint32Array.from(orders),
    localBounds: new Float32Array([0, -5, 8, 6]),
    prototypeId,
    instanceOffset: 4,
    instanceCount,
    zIndex: 0,
    blendMode: "normal",
  };
}
