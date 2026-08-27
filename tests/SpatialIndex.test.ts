import { describe, expect, test } from "bun:test";

import { SpatialIndex } from "../src/culling/SpatialIndex";

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

  test("scans linearly when candidate buckets hold most entries, keeping insertion order cheap", () => {
    const index = new SpatialIndex({ initialCapacity: 4_096 });
    // 4,096 small labels tiled densely: a half-world query returns thousands of hits.
    for (let slot = 0; slot < 4_096; slot += 1) {
      index.set(slot, { x: (slot % 64) * 10, y: Math.floor(slot / 64) * 10, width: 8, height: 8 });
    }
    const output = new Uint32Array(4_096);
    const before = index.stats.testedEntries;
    const count = index.query({ x: 0, y: 0, width: 640, height: 320 }, output);
    expect(count).toBeGreaterThan(1_000);
    // The dense scan tests every entry; the grid path would test only the candidates.
    expect(index.stats.testedEntries - before).toBe(4_096);
    for (let position = 1; position < count; position += 1) {
      const previous = output[position - 1] ?? 0;
      expect(output[position] ?? 0).toBeGreaterThan(previous);
    }

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

  test("places occupied slots from packed origins and a shared local box", () => {
    const index = new SpatialIndex({ initialCapacity: 8 });
    index.set(0, { x: 0, y: 0, width: 8, height: 10 }, 1, true);
    index.set(2, { x: 40, y: 40, width: 8, height: 10 }, 2, true);
    index.set(3, { x: 80, y: 80, width: 8, height: 10 }, 3, false);
    const slots = new Uint32Array([0, 2, 3]);
    const xy = new Float32Array([10, 20, 30, 40, 50, 60]);

    expect(index.placeMany(slots, 3, xy, { x: 0, y: 0, width: 12, height: 14 })).toBe(3);
    expect(index.get(0)).toEqual({ x: 10, y: 20, width: 12, height: 14 });
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
