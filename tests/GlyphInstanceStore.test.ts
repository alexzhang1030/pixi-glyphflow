import { describe, expect, test } from "bun:test";

import { GLYPH_INSTANCE_STRIDE, GlyphInstanceStore, type GlyphInstanceBatch } from "../src";

describe("GlyphInstanceStore", () => {
  test("packs each glyph into 32 bytes and preserves a reserved buffer across updates", () => {
    const store = new GlyphInstanceStore({ initialCapacity: 8 });
    const buffer = store.buffer;
    const first = batch(2, 10);

    expect(store.set(100, first)).toBe(true);
    expect(store.getRange(100)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(store.buffer).toBe(buffer);
    expect(readInstance(store.buffer, 0)).toEqual({
      x: 10,
      y: 11,
      width: 12,
      height: 13,
      u0: 0,
      v0: 0,
      u1: 65_535,
      v1: 65_535,
      paletteIndex: 10,
      page: 0,
      mode: 0,
      active: true,
    });
    store.consumeDirty();

    expect(store.set(100, first)).toBe(false);
    expect(store.consumeDirty()).toEqual([]);
    expect(store.set(100, batch(2, 20))).toBe(true);
    expect(store.buffer).toBe(buffer);
    expect(store.consumeDirty()).toEqual([{ offset: 0, length: 64 }]);

    store.destroy();
  });

  test("reuses freed ranges, grows geometrically, and compacts active instances", () => {
    const store = new GlyphInstanceStore({ initialCapacity: 2 });
    store.set(1, batch(2, 1));
    store.set(2, batch(3, 2));
    expect(store.stats.capacity).toBe(8);
    const grownBuffer = store.buffer;
    store.consumeDirty();

    expect(store.remove(1)).toBe(true);
    expect(store.set(3, batch(1, 3))).toBe(true);
    expect(store.getRange(3)?.offset).toBe(0);
    expect(store.buffer).toBe(grownBuffer);
    expect(store.stats).toMatchObject({ labels: 2, activeInstances: 4 });

    const result = store.compact();
    expect(result).toMatchObject({ beforeCapacity: 8, afterCapacity: 4 });
    expect(store.getRange(2)?.offset).toBe(0);
    expect(store.getRange(3)?.offset).toBe(3);
    expect(store.consumeDirty()).toEqual([{ offset: 0, length: 128 }]);

    store.destroy();
  });

  test("validates complete batches before changing storage", () => {
    const store = new GlyphInstanceStore();
    const invalid: GlyphInstanceBatch = {
      ...batch(2, 1),
      uvs: new Float32Array([0, 0, 1, 1]),
    };

    expect(() => store.set(1, invalid)).toThrow(TypeError);
    expect(store.stats).toMatchObject({ labels: 0, activeInstances: 0 });
    expect(store.consumeDirty()).toEqual([]);

    store.destroy();
  });
});

function batch(count: number, seed: number): GlyphInstanceBatch {
  const positions = new Float32Array(count * 4);
  const uvs = new Float32Array(count * 4);
  const paletteIndices = new Uint32Array(count);
  const pages = new Uint16Array(count);
  const modes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = seed + index;
    positions.set([value, value + 1, value + 2, value + 3], index * 4);
    uvs.set([0, 0, 1, 1], index * 4);
    paletteIndices[index] = value;
    pages[index] = index;
    modes[index] = index % 4;
  }
  return { positions, uvs, paletteIndices, pages, modes };
}

function readInstance(
  buffer: ArrayBuffer,
  index: number,
): Readonly<Record<string, number | boolean>> {
  const view = new DataView(buffer, index * GLYPH_INSTANCE_STRIDE, GLYPH_INSTANCE_STRIDE);
  const metadata = view.getUint32(28, true);
  return {
    x: view.getFloat32(0, true),
    y: view.getFloat32(4, true),
    width: view.getFloat32(8, true),
    height: view.getFloat32(12, true),
    u0: view.getUint16(16, true),
    v0: view.getUint16(18, true),
    u1: view.getUint16(20, true),
    v1: view.getUint16(22, true),
    paletteIndex: view.getUint32(24, true),
    page: metadata & 0xffff,
    mode: (metadata >>> 16) & 0x3,
    active: (metadata & 0x8000_0000) !== 0,
  };
}
