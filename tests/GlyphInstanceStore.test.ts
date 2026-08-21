import { describe, expect, test } from "bun:test";

import {
  GLYPH_INSTANCE_STRIDE,
  GLYPH_INSTANCE_STRIDE_CEILING,
  GlyphInstanceStore,
  type GlyphInstanceBatch,
} from "../src/advanced";
import { unpackF16 } from "../src/render/pack";

describe("GlyphInstanceStore", () => {
  test("packs each glyph into 24 bytes and preserves a reserved buffer across updates", () => {
    expect(GLYPH_INSTANCE_STRIDE).toBe(24);
    expect(GLYPH_INSTANCE_STRIDE_CEILING).toBe(32);
    const store = new GlyphInstanceStore({ initialCapacity: 8 });
    const buffer = store.buffer;
    const first = batch(2, 10);

    expect(store.set(100, first)).toBe(true);
    expect(store.getRange(100)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(store.getRange(100)).toBe(store.getRange(100));
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
      rasterScale: 1,
      active: true,
    });
    store.consumeDirty();

    expect(store.set(100, first)).toBe(false);
    expect(store.consumeDirty()).toEqual([]);
    expect(store.set(100, batch(2, 20))).toBe(true);
    expect(store.buffer).toBe(buffer);
    expect(store.consumeDirty()).toEqual([{ offset: 0, length: 48 }]);

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
    expect(store.consumeDirty()).toEqual([{ offset: 0, length: 96 }]);

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

  test("reuses a leftover hole from a larger power-of-two range", () => {
    const store = new GlyphInstanceStore({ initialCapacity: 16 });
    store.set(1, batch(8, 1));
    store.set(2, batch(2, 2));
    expect(store.getRange(1)).toEqual({ offset: 0, count: 8, capacity: 8 });
    expect(store.getRange(2)).toEqual({ offset: 8, count: 2, capacity: 2 });
    store.remove(1);
    expect(store.set(3, batch(2, 3))).toBe(true);
    expect(store.getRange(3)?.offset).toBe(0);
    expect(store.set(4, batch(4, 4))).toBe(true);
    expect(store.getRange(4)?.offset).toBe(2);
    expect(store.stats.freeInstances).toBe(2);

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
  const metadata = view.getUint32(20, true);
  return {
    x: unpackF16(view.getUint16(0, true)),
    y: unpackF16(view.getUint16(2, true)),
    width: unpackF16(view.getUint16(4, true)),
    height: unpackF16(view.getUint16(6, true)),
    u0: view.getUint16(8, true),
    v0: view.getUint16(10, true),
    u1: view.getUint16(12, true),
    v1: view.getUint16(14, true),
    paletteIndex: view.getUint32(16, true),
    page: metadata & 0xffff,
    mode: (metadata >>> 16) & 0x3,
    rasterScale: ((metadata >>> 18) & 0x1fff) / 64,
    active: (metadata & 0x8000_0000) !== 0,
  };
}
