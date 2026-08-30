import { describe, expect, test } from "bun:test";

import { SpatialIndex } from "../src/culling/SpatialIndex";

class SortTrackingUint32Array extends Uint32Array {
  static sortCalls = 0;

  override sort(compareFn?: (left: number, right: number) => number): this {
    SortTrackingUint32Array.sortCalls += 1;
    return super.sort(compareFn);
  }
}

function candidateIndex(candidateCount: number, entries = 4_096): SpatialIndex {
  const index = new SpatialIndex({ initialCapacity: entries });
  for (let slot = 0; slot < entries; slot += 1) {
    index.set(
      slot,
      slot < candidateCount
        ? { x: 0, y: 0, width: 8, height: 8 }
        : { x: 10_000 + slot * 80, y: 0, width: 8, height: 8 },
    );
  }
  return index;
}

function trackedMembership(length: number) {
  let reads = 0;
  const values = new Proxy(new Uint8Array(length).fill(1), {
    get(target, property) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, target);
    },
  });
  return { values, reads: () => reads };
}

describe("SpatialIndex", () => {
  test("updates dense bounds and queries visible slots without allocating output", () => {
    const index = new SpatialIndex({ initialCapacity: 2 });
    index.set(0, { x: 0, y: 0, width: 20, height: 10 }, 1, true);
    index.set(4, { x: 90, y: 90, width: 20, height: 20 }, 2, true);
    index.set(2, { x: 5, y: 5, width: 2, height: 2 }, 3, false);
    const output = new Uint32Array(8);

    expect(index.query({ x: -5, y: -5, width: 30, height: 30 }, output)).toBe(1);
    expect([...output.subarray(0, 1)]).toEqual([0]);

    index.setVisible(2, true);
    expect(index.query({ x: 0, y: 0, width: 10, height: 10 }, output)).toBe(2);
    expect([...output.subarray(0, 2)]).toEqual([0, 2]);

    index.translate(4, -80, -80);
    expect(index.query({ x: 0, y: 0, width: 40, height: 40 }, output)).toBe(3);
    expect(index.stats).toMatchObject({ entries: 3, capacity: 8, queries: 3 });

    index.destroy();
  });

  test("returns topmost hits by z index and insertion order", () => {
    const index = new SpatialIndex();
    index.set(7, { x: 0, y: 0, width: 20, height: 20 }, 4, true);
    index.set(3, { x: 0, y: 0, width: 20, height: 20 }, 4, true);
    index.set(1, { x: 0, y: 0, width: 20, height: 20 }, 8, true);

    expect(index.hitTest({ x: 10, y: 10 })).toBe(1);
    index.setVisible(1, false);
    expect(index.hitTest({ x: 10, y: 10 })).toBe(3);
    expect(index.remove(3)).toBe(true);
    expect(index.hitTest({ x: 10, y: 10 })).toBe(7);
    expect(index.remove(3)).toBe(false);

    index.destroy();
  });

  test("visits each occupied label once in the linear hit-test path", () => {
    const index = new SpatialIndex({ initialCapacity: 8 });
    for (let slot = 0; slot < 8; slot += 1) {
      index.set(slot, { x: 0, y: 0, width: 20, height: 20 }, slot, true);
    }
    const membership = trackedMembership(8);

    expect(index.hitTest({ x: 10, y: 10 }, membership.values)).toBe(7);
    expect(membership.reads()).toBe(8);

    index.destroy();
  });

  test("keeps mid-density hit tests on the grid candidate set", () => {
    const index = candidateIndex(2_112);
    const membership = trackedMembership(4_096);

    expect(index.hitTest({ x: 4, y: 4 }, membership.values)).toBe(2_111);
    expect(membership.reads()).toBe(2_112);

    index.destroy();
  });

  test("sets visibility for every occupied entry", () => {
    const index = new SpatialIndex();
    const output = new Uint32Array(3);
    index.set(0, { x: 0, y: 0, width: 1, height: 1 }, 0, true);
    index.set(1, { x: 1, y: 1, width: 1, height: 1 }, 0, true);
    index.set(2, { x: 2, y: 2, width: 1, height: 1 }, 0, false);
    index.remove(1);

    expect(index.setAllVisible(false)).toBe(1);
    expect(index.setAllVisible(false)).toBe(0);
    expect(index.queryAll(output)).toBe(0);
    expect(index.setAllVisible(true)).toBe(2);
    expect(index.queryAll(output)).toBe(2);
    expect([...output.subarray(0, 2)]).toEqual([0, 2]);
    expect(() => index.setAllVisible("yes" as unknown as boolean)).toThrow(TypeError);

    index.destroy();
  });

  test("queries a small viewport without scanning a large resident set", () => {
    const index = new SpatialIndex({ initialCapacity: 128 });
    const output = new Uint32Array(16);
    for (let slot = 0; slot < 128; slot += 1) {
      index.set(slot, {
        x: (slot % 16) * 80,
        y: Math.floor(slot / 16) * 80,
        width: 10,
        height: 10,
      });
    }

    expect(index.query({ x: 0, y: 0, width: 20, height: 20 }, output)).toBe(1);
    expect(output[0]).toBe(0);
    expect(index.query({ x: 1_200, y: 560, width: 20, height: 20 }, output)).toBe(1);
    expect(output[0]).toBe(127);
    expect(index.hitTest({ x: 5, y: 5 })).toBe(0);
    expect(index.stats.testedEntries).toBeLessThan(128 * 2);

    index.destroy();
  });

  test("sorts sparse grid output into ascending slot order", () => {
    const index = new SpatialIndex({ initialCapacity: 128 });
    for (let slot = 0; slot < 128; slot += 1) {
      index.set(slot, { x: 10_000 + slot * 80, y: 0, width: 8, height: 8 });
    }
    index.set(90, { x: 0, y: 0, width: 8, height: 8 });
    index.set(2, { x: 2, y: 2, width: 8, height: 8 });
    index.set(77, { x: 4, y: 4, width: 8, height: 8 });
    const output = new SortTrackingUint32Array(128);
    SortTrackingUint32Array.sortCalls = 0;
    const before = index.stats.testedEntries;

    expect(index.query({ x: 0, y: 0, width: 16, height: 16 }, output)).toBe(3);
    expect([...output.subarray(0, 3)]).toEqual([2, 77, 90]);
    expect(SortTrackingUint32Array.sortCalls).toBe(1);
    expect(index.stats.testedEntries - before).toBe(3);

    index.destroy();
  });

  test("routes dense grid output through ordered bits and near-full output through linear scan", () => {
    const index = new SpatialIndex({ initialCapacity: 4_096 });
    for (let slot = 0; slot < 4_096; slot += 1) {
      index.set(slot, { x: (slot % 64) * 10, y: Math.floor(slot / 64) * 10, width: 8, height: 8 });
    }
    const output = new SortTrackingUint32Array(4_096);
    SortTrackingUint32Array.sortCalls = 0;
    const before = index.stats.testedEntries;
    const count = index.query({ x: 0, y: 0, width: 640, height: 320 }, output);
    expect(count).toBe(2_112);
    expect(index.stats.testedEntries - before).toBeLessThan(4_096);
    expect(SortTrackingUint32Array.sortCalls).toBe(0);
    for (let position = 1; position < count; position += 1) {
      const previous = output[position - 1] ?? 0;
      expect(output[position] ?? 0).toBeGreaterThan(previous);
    }

    const beforeNearFull = index.stats.testedEntries;
    expect(index.query({ x: 0, y: 0, width: 640, height: 600 }, output)).toBe(3_904);
    expect(index.stats.testedEntries - beforeNearFull).toBe(4_096);
    expect(SortTrackingUint32Array.sortCalls).toBe(0);

    index.destroy();
  });

  test("keeps the quarter and seven-eighths query route boundaries exact", () => {
    const measure = (candidateCount: number) => {
      const entries = 4_096;
      const index = candidateIndex(candidateCount, entries);
      const output = new SortTrackingUint32Array(entries);
      SortTrackingUint32Array.sortCalls = 0;
      const testedBefore = index.stats.testedEntries;
      const count = index.query({ x: 0, y: 0, width: 16, height: 16 }, output);
      const result = {
        count,
        tested: index.stats.testedEntries - testedBefore,
        sortCalls: SortTrackingUint32Array.sortCalls,
      };
      index.destroy();
      return result;
    };

    expect(measure(1_024)).toEqual({ count: 1_024, tested: 1_024, sortCalls: 1 });
    expect(measure(1_025)).toEqual({ count: 1_025, tested: 1_025, sortCalls: 0 });
    expect(measure(3_583)).toEqual({ count: 3_583, tested: 3_583, sortCalls: 0 });
    expect(measure(3_584)).toEqual({ count: 3_584, tested: 4_096, sortCalls: 0 });
  });

  test("keeps dense ordered-bit queries exact across growth, visibility, removal, and spill", () => {
    const index = new SpatialIndex({ initialCapacity: 8 });
    const initialAllocatedBytes = index.stats.allocatedBytes;
    for (let slot = 0; slot < 256; slot += 1) {
      index.set(slot, {
        x: (slot % 16) * 10,
        y: Math.floor(slot / 16) * 10,
        width: 8,
        height: 8,
      });
    }
    expect(index.setVisible(3, false)).toBe(true);
    expect(index.remove(5)).toBe(true);
    index.set(510, { x: 1, y: 1, width: 5_000, height: 5_000 }, 0, false);
    index.set(511, { x: 1, y: 1, width: 5_000, height: 5_000 });
    const output = new Uint32Array(index.capacity);
    const expected = Array.from({ length: 144 }, (_, slot) => slot).filter(
      (slot) => slot !== 3 && slot !== 5,
    );
    expected.push(511);
    const before = index.stats;

    expect(() =>
      index.query({ x: 0, y: 0, width: 160, height: 80 }, new Uint32Array(expected.length - 1)),
    ).toThrow(RangeError);
    const count = index.query({ x: 0, y: 0, width: 160, height: 80 }, output);
    expect([...output.subarray(0, count)]).toEqual(expected);
    expect(index.capacity).toBe(512);
    expect(index.stats.allocatedBytes).toBeGreaterThan(initialAllocatedBytes);
    expect(index.stats.queries - before.queries).toBe(1);
    expect(index.stats.returnedEntries - before.returnedEntries).toBe(expected.length);
    expect(index.stats.testedEntries - before.testedEntries).toBeGreaterThan(expected.length);
    expect(index.stats.testedEntries - before.testedEntries).toBeLessThan(index.stats.entries);

    index.destroy();
    expect(index.stats.allocatedBytes).toBe(0);
  });

  test("clears dense query bits after an output writer throws", () => {
    const index = candidateIndex(2_112);
    let writes = 0;
    const throwingOutput = new Proxy(new Uint32Array(4_096), {
      get(target, property) {
        return Reflect.get(target, property, target);
      },
      set(target, property, value) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          writes += 1;
          if (writes === 32) throw new Error("output writer failed");
        }
        return Reflect.set(target, property, value, target);
      },
    });

    expect(() =>
      index.query({ x: 0, y: 0, width: 16, height: 16 }, throwingOutput as unknown as Uint32Array),
    ).toThrow("output writer failed");
    for (let slot = 32; slot < 1_000; slot += 1) index.setVisible(slot, false);
    const output = new Uint32Array(4_096);
    const count = index.query({ x: 0, y: 0, width: 16, height: 16 }, output);
    const expected = [
      ...Array.from({ length: 32 }, (_, slot) => slot),
      ...Array.from({ length: 1_112 }, (_, index) => index + 1_000),
    ];
    expect(count).toBe(expected.length);
    expect([...output.subarray(0, count)]).toEqual(expected);

    index.destroy();
  });

  test("translates occupied slots from packed deltas without rewriting z or visibility", () => {
    const index = new SpatialIndex({ initialCapacity: 8 });
    index.set(0, { x: 0, y: 0, width: 8, height: 10 }, 1, true);
    index.set(2, { x: 40, y: 40, width: 8, height: 10 }, 2, true);
    index.set(3, { x: 80, y: 80, width: 8, height: 10 }, 3, false);
    const slots = new Uint32Array([0, 2, 3, 7]);
    const deltas = new Float32Array([10, 20, -10, -10, 5, 5, 1, 1]);

    expect(index.translateMany(slots, 3, deltas)).toBe(3);
    expect(index.get(0)).toEqual({ x: 10, y: 20, width: 8, height: 10 });
    expect(index.get(2)).toEqual({ x: 30, y: 30, width: 8, height: 10 });
    expect(index.get(3)).toEqual({ x: 85, y: 85, width: 8, height: 10 });
    expect(index.hitTest({ x: 11, y: 21 })).toBe(0);
    expect(index.hitTest({ x: 86, y: 86 })).toBeUndefined();
    expect(index.translateMany(slots, 3, new Float32Array(6))).toBe(3);

    expect(() => index.translateMany(slots, 3, new Float32Array([1, 2, 3]))).toThrow(TypeError);
    expect(() =>
      index.translateMany(slots, 3, new Float32Array([1, 2, Number.NaN, 0, 0, 0])),
    ).toThrow(TypeError);

    index.destroy();
  });

  test("keeps size class on translate and rebuckets only when the center crosses a cell", () => {
    const index = new SpatialIndex({ initialCapacity: 4 });
    const output = new Uint32Array(4);
    // 10×10 boxes use the 64-wide level. Center 5,5 starts in cell (0,0).
    index.set(0, { x: 0, y: 0, width: 10, height: 10 });

    expect(index.translateMany(new Uint32Array([0]), 1, new Float32Array([20, 0]))).toBe(1);
    expect(index.query({ x: 18, y: 0, width: 20, height: 20 }, output)).toBe(1);
    expect(output[0]).toBe(0);

    expect(index.translateMany(new Uint32Array([0]), 1, new Float32Array([80, 0]))).toBe(1);
    expect(index.get(0)).toEqual({ x: 100, y: 0, width: 10, height: 10 });
    expect(index.query({ x: 98, y: 0, width: 20, height: 20 }, output)).toBe(1);
    expect(output[0]).toBe(0);
    expect(index.query({ x: 0, y: 0, width: 20, height: 20 }, output)).toBe(0);

    index.set(1, { x: 0, y: 0, width: 5_000, height: 5_000 });
    expect(index.translateMany(new Uint32Array([1]), 1, new Float32Array([40, 60]))).toBe(1);
    expect(index.get(1)).toEqual({ x: 40, y: 60, width: 5_000, height: 5_000 });
    expect(index.hitTest({ x: 50, y: 70 })).toBe(1);

    index.destroy();
  });

  test("derives world bounds from aliased origin columns without rewriting a second x/y copy", () => {
    const index = new SpatialIndex({ initialCapacity: 4 });
    const originX = new Float32Array([0, 40, 0, 0]);
    const originY = new Float32Array([0, 40, 0, 0]);
    index.bindOrigins(originX, originY);
    index.set(0, { x: 0, y: 0, width: 10, height: 10 });
    index.set(1, { x: 40, y: 40, width: 10, height: 10 });
    const output = new Uint32Array(4);

    originX[0] = 20;
    expect(index.rehashCurrent(0)).toBe(true);
    expect(index.get(0)).toEqual({ x: 20, y: 0, width: 10, height: 10 });
    expect(index.getLocal(0)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(index.hitTest({ x: 21, y: 1 })).toBe(0);
    expect(index.hitTest({ x: 1, y: 1 })).toBeUndefined();

    // Crossing the 64-wide cell rebuckets from the new aliased origin.
    originX[0] = 100;
    expect(index.rehashCurrent(0)).toBe(true);
    expect(index.get(0)).toEqual({ x: 100, y: 0, width: 10, height: 10 });
    expect(index.query({ x: 98, y: 0, width: 20, height: 20 }, output)).toBe(1);
    expect(output[0]).toBe(0);
    expect(index.query({ x: 0, y: 0, width: 20, height: 20 }, output)).toBe(0);

    // translateMany consumes the already-moved aliased origin once.
    originX[1] = 80;
    expect(index.translateMany(new Uint32Array([1]), 1, new Float32Array([40, 0]))).toBe(1);
    expect(index.get(1)).toEqual({ x: 80, y: 40, width: 10, height: 10 });

    expect(() => index.bindOrigins(new Float32Array(1), new Float32Array(2))).toThrow(TypeError);

    index.destroy();
  });

  test("deduplicates 100k deferred rehashes in typed storage", () => {
    const count = 100_000;
    const originX = new Float32Array(count);
    const originY = new Float32Array(count);
    const index = new SpatialIndex({ initialCapacity: count });
    index.bindOrigins(originX, originY);
    for (let slot = 0; slot < count; slot += 1) {
      index.set(slot, { x: 0, y: 0, width: 8, height: 8 });
    }

    let admitted = 0;
    let duplicates = 0;
    for (let slot = 0; slot < count; slot += 1) {
      admitted += Number(index.deferRehashCurrent(slot));
    }
    for (let slot = 0; slot < count; slot += 1) {
      duplicates += Number(index.deferRehashCurrent(slot));
    }

    expect(admitted).toBe(count);
    expect(duplicates).toBe(0);
    expect(index.deferredRehashCount).toBe(count);
    expect(index.deferredRehashAllocatedBytes).toBeLessThanOrEqual(600_000);
    expect(index.flushDeferredRehash()).toBe(count);
    expect(index.flushDeferredRehash()).toBe(0);
    expect(index.deferredRehashCount).toBe(0);

    index.destroy();
  });

  test("reserves a complete deferred wave before apply without journal growth", () => {
    const count = 64;
    const index = new SpatialIndex({ initialCapacity: count });
    for (let slot = 0; slot < count; slot += 1) {
      index.set(slot, { x: slot * 80, y: 0, width: 8, height: 8 });
    }

    index.reserveDeferredRehash(count * 10);
    const allocatedBytes = index.deferredRehashAllocatedBytes;
    for (let slot = 0; slot < count; slot += 1) {
      expect(index.deferRehashCurrent(slot)).toBe(true);
    }

    expect(index.deferredRehashAllocatedBytes).toBe(allocatedBytes);
    expect(index.deferredRehashCount).toBe(count);
    expect(index.flushDeferredRehash()).toBe(count);
    expect(() => index.reserveDeferredRehash(-1)).toThrow(TypeError);
    index.destroy();
  });

  test("defers one packed rehash wave with duplicate and inactive slots", () => {
    const originX = new Float32Array([0, 80, 160, 240]);
    const originY = new Float32Array(4);
    const index = new SpatialIndex({ initialCapacity: 4 });
    index.bindOrigins(originX, originY);
    for (let slot = 0; slot < 4; slot += 1) {
      index.set(slot, { x: slot * 80, y: 0, width: 8, height: 8 });
    }
    expect(index.remove(3)).toBe(true);
    originX[0] = 400;
    originX[1] = 480;
    index.reserveDeferredRehash(5);
    const allocatedBytes = index.deferredRehashAllocatedBytes;

    expect(index.deferRehashMany(new Uint32Array([0, 1, 0, 3, 1]), 5)).toBe(2);
    expect(index.deferredRehashAllocatedBytes).toBe(allocatedBytes);
    expect(index.deferredRehashCount).toBe(2);
    expect(index.deferRehashMany(new Uint32Array([1, 0]), 2)).toBe(0);
    expect(index.flushDeferredRehash()).toBe(2);
    expect(index.get(0)).toEqual({ x: 400, y: 0, width: 8, height: 8 });
    expect(index.get(1)).toEqual({ x: 480, y: 0, width: 8, height: 8 });

    index.destroy();
  });

  test("flushes deferred aliased-origin moves with immediate-rehash parity", () => {
    const capacity = 128;
    const deferredOriginsX = new Float32Array(capacity);
    const deferredOriginsY = new Float32Array(capacity);
    const immediateOriginsX = new Float32Array(capacity);
    const immediateOriginsY = new Float32Array(capacity);
    const deferred = new SpatialIndex({ initialCapacity: capacity });
    const immediate = new SpatialIndex({ initialCapacity: capacity });
    deferred.bindOrigins(deferredOriginsX, deferredOriginsY);
    immediate.bindOrigins(immediateOriginsX, immediateOriginsY);
    for (let slot = 0; slot < capacity; slot += 1) {
      const x = slot * 80;
      deferredOriginsX[slot] = x;
      immediateOriginsX[slot] = x;
      deferred.set(slot, { x, y: 0, width: 10, height: 10 });
      immediate.set(slot, { x, y: 0, width: 10, height: 10 });
    }
    const movedSlots = [1, 64, 127] as const;
    const movedX = [9_000, 9_080, 9_160] as const;
    for (let index = 0; index < movedSlots.length; index += 1) {
      const slot = movedSlots[index] ?? 0;
      const x = movedX[index] ?? 0;
      deferredOriginsX[slot] = x;
      immediateOriginsX[slot] = x;
      expect(deferred.deferRehashCurrent(slot)).toBe(true);
      expect(immediate.rehashCurrent(slot)).toBe(true);
    }

    expect(deferred.get(1)).toEqual({ x: 9_000, y: 0, width: 10, height: 10 });
    expect(deferred.deferredRehashCount).toBe(3);
    expect(deferred.flushDeferredRehash()).toBe(3);
    const deferredOutput = new Uint32Array(capacity);
    const immediateOutput = new Uint32Array(capacity);
    const bounds = { x: 8_990, y: -10, width: 200, height: 30 };
    const deferredCount = deferred.query(bounds, deferredOutput);
    const immediateCount = immediate.query(bounds, immediateOutput);
    expect([...deferredOutput.subarray(0, deferredCount)]).toEqual([
      ...immediateOutput.subarray(0, immediateCount),
    ]);
    expect(deferred.hitTest({ x: 9_165, y: 5 })).toBe(immediate.hitTest({ x: 9_165, y: 5 }));

    deferred.destroy();
    immediate.destroy();
  });

  test("clears deferred markers across immediate updates, removal, reuse, clear, and destroy", () => {
    const originX = new Float32Array(4);
    const originY = new Float32Array(4);
    const index = new SpatialIndex({ initialCapacity: 4 });
    index.bindOrigins(originX, originY);
    index.set(1, { x: 0, y: 0, width: 10, height: 10 });

    originX[1] = 80;
    expect(index.deferRehashCurrent(1)).toBe(true);
    expect(index.rehashCurrent(1)).toBe(true);
    expect(index.deferredRehashCount).toBe(0);

    originX[1] = 160;
    expect(index.deferRehashCurrent(1)).toBe(true);
    expect(index.remove(1)).toBe(true);
    expect(index.deferredRehashCount).toBe(0);
    index.set(1, { x: 160, y: 0, width: 10, height: 10 });
    expect(index.deferRehashCurrent(1)).toBe(true);
    expect(index.flushDeferredRehash()).toBe(1);
    expect(index.hitTest({ x: 165, y: 5 })).toBe(1);

    expect(index.deferRehashCurrent(1)).toBe(true);
    index.clear();
    expect(index.deferredRehashCount).toBe(0);
    expect(index.flushDeferredRehash()).toBe(0);
    index.destroy();
    expect(index.deferredRehashCount).toBe(0);
    expect(index.deferredRehashAllocatedBytes).toBe(0);
    expect(() => index.flushDeferredRehash()).toThrow("SpatialIndex has been destroyed");
  });

  test("compacts canceled journal entries before growing storage", () => {
    const index = new SpatialIndex({ initialCapacity: 16 });
    for (let slot = 0; slot < 16; slot += 1) {
      index.set(slot, { x: 0, y: 0, width: 8, height: 8 });
      expect(index.deferRehashCurrent(slot)).toBe(true);
    }
    for (let slot = 0; slot < 16; slot += 2) {
      expect(index.rehashCurrent(slot)).toBe(true);
    }
    const allocatedBefore = index.deferredRehashAllocatedBytes;

    expect(index.deferRehashCurrent(0)).toBe(true);
    expect(index.deferredRehashCount).toBe(9);
    expect(index.deferredRehashAllocatedBytes).toBe(allocatedBefore);
    expect(index.flushDeferredRehash()).toBe(9);

    index.destroy();
  });

  test("places occupied slots from packed origins and a shared local box", () => {
    const index = new SpatialIndex({ initialCapacity: 8 });
    index.set(0, { x: 0, y: 0, width: 8, height: 10 }, 1, true);
    index.set(2, { x: 40, y: 40, width: 8, height: 10 }, 2, true);
    index.set(3, { x: 80, y: 80, width: 8, height: 10 }, 3, false);
    const slots = new Uint32Array([0, 2, 3]);
    const xy = new Float32Array([10, 20, 30, 40, 50, 60]);

    expect(index.placeMany(slots, 3, xy, { x: 0, y: 0, width: 12, height: 14 })).toBe(3);
    expect(index.get(0)).toEqual({ x: 10, y: 20, width: 12, height: 14 });
    expect(index.getLocal(0)).toEqual({ x: 0, y: 0, width: 12, height: 14 });
    expect(index.get(2)).toEqual({ x: 30, y: 40, width: 12, height: 14 });
    expect(index.get(3)).toEqual({ x: 50, y: 60, width: 12, height: 14 });
    expect(index.hitTest({ x: 11, y: 21 })).toBe(0);
    expect(index.hitTest({ x: 51, y: 61 })).toBeUndefined();

    index.destroy();
  });

  test("validates output capacity and finite geometry transactionally", () => {
    const index = new SpatialIndex();
    index.set(0, { x: 0, y: 0, width: 1, height: 1 });
    index.set(1, { x: 1, y: 1, width: 1, height: 1 });

    expect(() => index.query({ x: 0, y: 0, width: 10, height: 10 }, new Uint32Array(1))).toThrow(
      RangeError,
    );
    expect(() => index.set(2, { x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow(TypeError);
    expect(index.stats.entries).toBe(2);

    index.destroy();
  });
});
