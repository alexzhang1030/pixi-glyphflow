import { describe, expect, test } from "bun:test";

import {
  aabbVisible,
  compactVisibleInstances,
  createIndirectArgs,
  packCullRecords,
} from "../src/culling/computeCull";
import { GLYPH_INSTANCE_STRIDE } from "../src/render/types";

describe("compute cull host reference", () => {
  test("keeps axis-aligned overlap and rejects separated boxes", () => {
    const viewport = { x: 0, y: 0, width: 100, height: 100, padding: 10 };
    expect(aabbVisible(90, 90, 110, 110, viewport)).toBe(true);
    expect(aabbVisible(120, 0, 140, 20, viewport)).toBe(false);
    expect(aabbVisible(-20, -20, -5, -5, viewport)).toBe(true);
  });

  test("compacts visible instances in z then insertion order without atomics", () => {
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
    const compact = new Uint32Array(result.compact.buffer);
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
});
