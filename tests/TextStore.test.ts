import { describe, expect, test } from "bun:test";

import { TextStore } from "../src/store/TextStore";
import { TextDirty, type TextStoreLabel, type TextStoreLabelPatch } from "../src/store/types";

describe("TextStore", () => {
  test("creates stable identities and immutable snapshots", () => {
    const store = new TextStore({ initialCapacity: 2 });
    const id = store.create(label({ text: "alpha", x: 12 }));
    const snapshot = store.get(id);

    expect(snapshot).toMatchObject({
      id,
      text: "alpha",
      x: 12,
      sourceRevision: 1,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.style)).toBe(true);
    expect(() => {
      (snapshot as { x: number }).x = 99;
    }).toThrow(TypeError);
  });

  test("returns precise dirty domains and advances shaping revisions for source updates", () => {
    const store = new TextStore();
    const id = store.create(label());

    expect(store.update(id, { text: "updated", x: 4 })).toBe(
      TextDirty.Content | TextDirty.Transform,
    );
    expect(store.get(id)?.sourceRevision).toBe(2);
    expect(store.update(id, { text: "updated", x: 4 })).toBe(TextDirty.None);
    expect(store.get(id)?.sourceRevision).toBe(2);

    const style = Object.freeze({ fill: 0x38bdf8, fontSize: 18 });
    expect(store.update(id, { style })).toBe(TextDirty.Style);
    expect(store.get(id)?.sourceRevision).toBe(3);

    expect(store.update(id, { x: 8, rotation: 0.5 })).toBe(TextDirty.Transform);
    expect(store.get(id)?.sourceRevision).toBe(3);
  });

  test("applies packed positions transactionally while preserving shaping revisions", () => {
    const store = new TextStore();
    const first = store.create(label({ x: 1, y: 2 }));
    const second = store.create(label({ x: 3, y: 4 }));
    const ids = new Float64Array([first, second]);

    expect(store.updatePositions(ids, new Float32Array([10, 20, 30, 40]))).toBe(2);
    const warmedBytes = store.stats.allocatedBytes;
    expect(store.get(first)).toMatchObject({ x: 10, y: 20, sourceRevision: 1 });
    expect(store.get(second)).toMatchObject({ x: 30, y: 40, sourceRevision: 1 });
    expect(store.updatePositions(ids, new Float32Array([10, 20, 30, 40]))).toBe(0);
    expect(store.stats.allocatedBytes).toBe(warmedBytes);

    const stale = first;
    store.remove(first);
    expect(() =>
      store.updatePositions(new Float64Array([second, stale]), new Float32Array([50, 60, 70, 80])),
    ).toThrow(RangeError);
    expect(store.get(second)).toMatchObject({ x: 30, y: 40, sourceRevision: 1 });
  });

  test("reuses free slots with a fresh generation and rejects stale identities", () => {
    const store = new TextStore({ initialCapacity: 1 });
    const first = store.create(label({ text: "first" }));

    expect(store.remove(first)).toBe(true);
    expect(store.remove(first)).toBe(false);
    expect(store.get(first)).toBeUndefined();

    const second = store.create(label({ text: "second" }));

    expect(second).not.toBe(first);
    expect(store.capacity).toBe(1);
    expect(() => store.update(first, { x: 1 })).toThrow(RangeError);
    expect(store.get(second)?.text).toBe("second");
  });

  test("rejects identities owned by another store", () => {
    const firstStore = new TextStore();
    const secondStore = new TextStore();
    const first = firstStore.create(label());
    const second = secondStore.create(label());

    expect(first).not.toBe(second);
    expect(secondStore.has(first)).toBe(false);
    expect(() => secondStore.update(first, { x: 10 })).toThrow(RangeError);
  });

  test("grows geometrically and clears active generations", () => {
    const store = new TextStore({ initialCapacity: 1 });
    const first = store.create(label({ text: "one" }));
    store.create(label({ text: "two" }));
    store.create(label({ text: "three" }));

    expect(store.capacity).toBe(4);
    expect(store.stats).toMatchObject({
      size: 3,
      capacity: 4,
      freeSlots: 0,
    });
    expect(store.stats.allocatedBytes).toBeGreaterThan(0);
    expect(store.stats.allocatedBytes).toBe(
      store.stats.numericBytes + store.stats.referenceSlotBytes,
    );

    store.clear();

    expect(store.size).toBe(0);
    expect(store.get(first)).toBeUndefined();
    expect(store.stats.freeSlots).toBe(3);
    expect(store.create(label({ text: "after clear" }))).not.toBe(first);
    expect(store.capacity).toBe(4);
  });

  test("validates construction and mutation inputs", () => {
    expect(() => new TextStore({ initialCapacity: 0 })).toThrow(TypeError);

    const store = new TextStore();
    const id = store.create(label());

    expect(() => store.update(id, { x: Number.NaN })).toThrow(TypeError);
    expect(() => store.create(label({ text: "" }))).not.toThrow();
  });
});

const defaultStyle = Object.freeze({ fill: 0xffffff, fontFamily: "sans-serif", fontSize: 16 });

function label(patch: TextStoreLabelPatch = {}): TextStoreLabel {
  return {
    text: "label",
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    zIndex: 0,
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style: defaultStyle,
    ...patch,
  };
}
