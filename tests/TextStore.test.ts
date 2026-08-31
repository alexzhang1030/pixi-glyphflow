import { describe, expect, test } from "bun:test";

import {
  PALETTE_DENSE_MOVE_STRIDE,
  PALETTE_DENSE_MOVE_WORDS,
  PALETTE_MOVE_STRIDE,
  PALETTE_MOVE_WORDS,
} from "../src/render/paletteStorage";
import { TextStore } from "../src/store/TextStore";
import { TextDirty, type TextStoreLabel, type TextStoreLabelPatch } from "../src/store/types";

describe("TextStore", () => {
  test("validates packed rigid transforms before mutation and retains exact dirty domains", () => {
    const store = new TextStore();
    const ids = [store.create(label()), store.create(label())];
    store.publishDirty();
    ids.forEach((id) => store.consumePositionOnly(store.slotOf(id)!));
    const xy = new Float32Array([10, 20, 30, 40]);
    expect(() => store.updateTransforms(ids, xy, new Float32Array([0.5, Number.NaN]))).toThrow(
      "finite",
    );
    expect(() => store.updateTransforms(ids, xy, new Float32Array([0.5]))).toThrow("per TextId");
    expect(store.get(ids[0]!)!.x).toBe(0);
    expect(store.pendingDirty.labels).toBe(0);
    expect(store.updateTransforms(ids, xy, new Float64Array([0.5, 0]))).toBe(2);
    expect(store.get(ids[0]!)).toMatchObject({ x: 10, y: 20, rotation: 0.5, sourceRevision: 1 });
    expect(store.consumePositionOnly(store.slotOf(ids[0]!)!)).toBe(false);
    expect(store.consumePositionOnly(store.slotOf(ids[1]!)!)).toBe(true);
    expect(store.updateTransforms(ids, xy, new Float32Array([0.5, 0]))).toBe(0);
    expect(store.updateTransforms([ids[0]!, ids[0]!], xy, new Float32Array([1, -1]))).toBe(2);
    expect(store.get(ids[0]!)).toMatchObject({ x: 30, y: 40, rotation: -1 });
    expect(store.pendingDirty).toEqual({ labels: 2, mask: TextDirty.Transform });
  });

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

  test("stores blend modes compactly as transform-only state", () => {
    const store = new TextStore();
    const id = store.create(label());
    store.publishDirty();

    expect(store.get(id)?.blendMode).toBe("normal");
    expect(store.update(id, { blendMode: "add" })).toBe(TextDirty.Transform);
    expect(store.get(id)?.blendMode).toBe("add");
    expect(() => store.update(id, { blendMode: "invalid" as "normal" })).toThrow(TypeError);
  });

  test("sets visibility for every occupied slot while preserving free slots", () => {
    const store = new TextStore();
    const first = store.create(label());
    const removed = store.create(label());
    const third = store.create(label({ visible: false }));
    store.remove(removed);
    store.publishDirty();
    const warmedBytes = store.stats.allocatedBytes;

    expect(store.setAllVisible(false)).toBe(1);
    expect(store.setAllVisible(false)).toBe(0);
    expect(store.get(first)?.visible).toBe(false);
    expect(store.get(third)?.visible).toBe(false);
    expect(store.pendingDirty).toEqual({ labels: 1, mask: TextDirty.Transform });

    expect(store.setAllVisible(true)).toBe(2);
    expect(store.get(first)?.visible).toBe(true);
    expect(store.get(third)?.visible).toBe(true);
    expect(store.stats.allocatedBytes).toBe(warmedBytes);
    expect(() => store.setAllVisible("yes" as unknown as boolean)).toThrow(TypeError);
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

  test("takes one leased resident payload with last-write-wins slot commands", () => {
    const { store, first, second } = positionedStore();

    expect(
      store.updatePositions(
        new Float64Array([first, second, first]),
        new Float64Array([10.25, 20.5, 30.75, 40.125, 50.5, 60.25]),
        undefined,
        true,
      ),
    ).toBe(3);
    expect(store.pendingDirty).toEqual({ labels: 0, mask: TextDirty.None });
    expect(store.pendingResidentPositionUpdates).toBe(2);

    const batch = takeResidentBatch(store, "last-write-wins");
    expect(batch).toBeDefined();
    expect(batch.mode).toBe("indexed");
    expect(batch.count).toBe(2);
    expect(batch.commands.byteLength).toBe(4 * PALETTE_MOVE_STRIDE);
    expect(Array.from(batch.slots.subarray(0, batch.count))).toEqual([0, 1]);
    const words = new Uint32Array(batch.commands);
    const floats = new Float32Array(batch.commands);
    expect([words[0], floats[1], floats[2]]).toEqual([0, 50.5, 60.25]);
    expect([
      words[PALETTE_MOVE_WORDS],
      floats[PALETTE_MOVE_WORDS + 1],
      floats[PALETTE_MOVE_WORDS + 2],
    ]).toEqual([1, 30.75, 40.125]);
    expect(store.pendingResidentPositionUpdates).toBe(0);
    expect(store.residentPositionStats).toMatchObject({
      pending: 0,
      leased: 1,
      takes: 1,
      materializations: 0,
    });

    store.releaseResidentPositionUpdates(batch);
    expect(store.residentPositionStats.leased).toBe(0);
    store.dispose();
  });

  test("leases sorted contiguous resident movers as dense exact-f32 pairs", () => {
    const store = new TextStore({ initialCapacity: 8 });
    const ids = Array.from({ length: 6 }, (_, slot) => store.create(label({ x: slot })));
    store.publishDirty();
    const expected = new Float32Array([
      Math.fround(Math.PI),
      Math.fround(-Math.E),
      Math.fround(1 / 3),
      Math.fround(-1 / 7),
      Math.fround(16_777_000.25),
      Math.fround(-8_388_000.5),
    ]);

    expect(store.updatePositions(ids.slice(2, 5), expected, undefined, true)).toBe(3);
    const batch = takeResidentBatch(store, "dense");
    expect(batch).toMatchObject({ mode: "dense", baseSlot: 2, count: 3 });
    expect(batch.commands.byteLength).toBe(4 * PALETTE_DENSE_MOVE_STRIDE);
    expect(Array.from(batch.slots.subarray(0, batch.count))).toEqual([2, 3, 4]);
    expect(
      Array.from(new Uint32Array(batch.commands, 0, batch.count * PALETTE_DENSE_MOVE_WORDS)),
    ).toEqual(Array.from(new Uint32Array(expected.buffer)));
    expect(store.releaseResidentPositionUpdates(batch)).toBe(true);
    store.dispose();
  });

  test("keeps sparse, out-of-order, and duplicate resident movers on indexed commands", () => {
    const cases: ReadonlyArray<{
      readonly pick: readonly number[];
      readonly positions: readonly number[];
      readonly expectedSlots: readonly number[];
      readonly expectedXy: readonly number[];
    }> = [
      {
        pick: [0, 2],
        positions: [10, 11, 20, 21],
        expectedSlots: [0, 2],
        expectedXy: [10, 11, 20, 21],
      },
      {
        pick: [2, 1],
        positions: [30, 31, 40, 41],
        expectedSlots: [2, 1],
        expectedXy: [30, 31, 40, 41],
      },
      {
        pick: [1, 1],
        positions: [50, 51, 60, 61],
        expectedSlots: [1],
        expectedXy: [60, 61],
      },
    ];

    for (const fixture of cases) {
      const store = new TextStore({ initialCapacity: 4 });
      const ids = Array.from({ length: 4 }, (_, slot) => store.create(label({ x: slot })));
      store.publishDirty();
      const selected = fixture.pick.map((slot) => ids[slot]!);
      expect(
        store.updatePositions(selected, new Float32Array(fixture.positions), undefined, true),
      ).toBe(fixture.pick.length);
      const batch = takeResidentBatch(store, "indexed");
      expect(batch.mode).toBe("indexed");
      expect(Array.from(batch.slots.subarray(0, batch.count))).toEqual([...fixture.expectedSlots]);
      const words = new Uint32Array(batch.commands);
      const floats = new Float32Array(batch.commands);
      for (let index = 0; index < batch.count; index += 1) {
        const base = index * PALETTE_MOVE_WORDS;
        expect(words[base]).toBe(fixture.expectedSlots[index]);
        expect([floats[base + 1], floats[base + 2]]).toEqual([
          fixture.expectedXy[index * 2],
          fixture.expectedXy[index * 2 + 1],
        ]);
      }
      expect(store.releaseResidentPositionUpdates(batch)).toBe(true);
      store.dispose();
    }
  });

  test("preserves exact f32 mover bits and command identity across storage growth", () => {
    const store = new TextStore({ initialCapacity: 3 });
    const first = store.create(label());
    const second = store.create(label());
    const third = store.create(label());
    store.publishDirty();
    const firstX = Math.fround(Math.PI);
    const firstY = Math.fround(-Math.E);
    const secondX = Math.fround(1 / 3);
    const secondY = Math.fround(-1 / 7);
    const thirdX = Math.fround(16_777_000.25);
    const thirdY = Math.fround(-8_388_000.5);

    expect(
      store.updatePositions([first], new Float64Array([Math.PI, -Math.E]), undefined, true),
    ).toBe(1);
    expect(
      store.updatePositions(
        [second, third],
        new Float64Array([1 / 3, -1 / 7, 16_777_000.25, -8_388_000.5]),
        undefined,
        true,
      ),
    ).toBe(2);

    const batch = takeResidentBatch(store, "grown");
    expect(batch).toMatchObject({ mode: "dense", baseSlot: 0, count: 3 });
    expect(batch.commands.byteLength).toBe(4 * PALETTE_DENSE_MOVE_STRIDE);
    expect(Array.from(batch.slots.subarray(0, batch.count))).toEqual([0, 1, 2]);
    const words = new Uint32Array(batch.commands);
    const expectedBits = new Uint32Array(
      new Float32Array([firstX, firstY, secondX, secondY, thirdX, thirdY]).buffer,
    );
    for (let index = 0; index < batch.count; index += 1) {
      const base = index * PALETTE_DENSE_MOVE_WORDS;
      expect(words[base]).toBe(expectedBits[index * 2]);
      expect(words[base + 1]).toBe(expectedBits[index * 2 + 1]);
    }
    const commands = batch.commands;
    const slots = batch.slots;
    expect(
      store.visitResidentPositionLeases((leased) => {
        expect(leased.commands).toBe(commands);
        expect(leased.slots).toBe(slots);
        expect(leased.count).toBe(3);
      }),
    ).toBe(1);
    expect(store.releaseResidentPositionUpdates(batch)).toBe(true);
    store.dispose();
  });

  test("keeps a pending dense mover batch dense across a later no-op update", () => {
    const store = new TextStore({ initialCapacity: 4 });
    const ids = Array.from({ length: 3 }, (_, slot) =>
      store.create(label({ x: slot, y: slot + 10 })),
    );
    store.publishDirty();

    expect(
      store.updatePositions(ids.slice(0, 2), new Float32Array([20, 21, 30, 31]), undefined, true),
    ).toBe(2);
    expect(store.updatePositions(ids.slice(2), new Float32Array([2, 12]), undefined, true)).toBe(0);

    const batch = takeResidentBatch(store, "pending dense");
    expect(batch).toMatchObject({ mode: "dense", baseSlot: 0, count: 2 });
    expect(Array.from(new Float32Array(batch.commands).subarray(0, 4))).toEqual([20, 21, 30, 31]);
    expect(store.releaseResidentPositionUpdates(batch)).toBe(true);
    store.dispose();
  });

  test("publishes one compact changed-slot batch after a resident apply", () => {
    const { store, first, second } = positionedStore();
    const preflightSnapshots: Array<readonly [number, number]> = [];
    const appliedBatches: number[][] = [];

    expect(
      store.updatePositions(
        new Float64Array([first, second, first]),
        new Float64Array([1, 2, 30, 40, 50, 60]),
        undefined,
        true,
        (slots, count) => {
          expect(Array.from(slots.subarray(0, count))).toEqual([0, 1, 0]);
          preflightSnapshots.push([store.snapshotAt(0)?.x ?? 0, store.snapshotAt(1)?.x ?? 0]);
        },
        (slots, count) => {
          appliedBatches.push(Array.from(slots.subarray(0, count)));
          expect(store.snapshotAt(0)).toMatchObject({ x: 50, y: 60 });
          expect(store.snapshotAt(1)).toMatchObject({ x: 30, y: 40 });
        },
      ),
    ).toBe(2);
    expect(preflightSnapshots).toEqual([[1, 3]]);
    expect(appliedBatches).toEqual([[1, 0]]);
    expect(store.pendingResidentPositionUpdates).toBe(2);

    expect(
      store.updatePositions(
        new Float64Array([first, second]),
        new Float32Array([50, 60, 30, 40]),
        undefined,
        true,
        undefined,
        (slots, count) => appliedBatches.push(Array.from(slots.subarray(0, count))),
      ),
    ).toBe(0);
    expect(appliedBatches).toEqual([[1, 0]]);

    const batch = store.takeResidentPositionUpdates();
    if (batch !== undefined) store.releaseResidentPositionUpdates(batch);
    store.dispose();
  });

  test("visits overlapping resident leases in commit order until each owner releases", () => {
    const store = new TextStore();
    const id = store.create(label({ x: 1, y: 2 }));
    store.publishDirty();

    expect(store.updatePositions([id], new Float32Array([10, 11]), undefined, true)).toBe(1);
    const first = takeResidentBatch(store, "first overlapping");
    expect(first).toBeDefined();
    expect(store.updatePositions([id], new Float32Array([20, 21]), undefined, true)).toBe(1);
    const second = takeResidentBatch(store, "second overlapping");
    expect(second).toBeDefined();

    const visited: number[][] = [];
    expect(
      store.visitResidentPositionLeases((batch) => {
        expect(batch).toMatchObject({ mode: "dense", baseSlot: 0, count: 1 });
        const values = new Float32Array(batch.commands);
        visited.push([values[0] ?? 0, values[1] ?? 0]);
      }),
    ).toBe(2);
    expect(visited).toEqual([
      [10, 11],
      [20, 21],
    ]);
    expect(store.residentPositionStats).toMatchObject({ leased: 2, releases: 0 });

    expect(store.releaseResidentPositionUpdates(first)).toBe(true);
    expect(store.releaseResidentPositionUpdates(second)).toBe(true);
    expect(store.residentPositionStats).toMatchObject({ leased: 0, releases: 2 });
    expect(store.releaseResidentPositionUpdates(first)).toBe(false);
    expect(store.releaseResidentPositionUpdates(second)).toBe(false);
    expect(store.residentPositionStats).toMatchObject({ leased: 0, releases: 2 });
    store.dispose();
  });

  test("keeps resident position validation atomic and materializes mixed work on demand", () => {
    const { store, first, second } = positionedStore();

    expect(
      store.updatePositions([first, second], new Float32Array([10, 20, 30, 40]), undefined, true),
    ).toBe(2);
    let visitors = 0;
    let preflights = 0;
    let residentBatches = 0;
    expect(() =>
      store.updatePositions(
        [first, second],
        new Float64Array([100, 200, Number.NaN, 400]),
        () => {
          visitors += 1;
        },
        true,
        () => {
          preflights += 1;
        },
        () => {
          residentBatches += 1;
        },
      ),
    ).toThrow(TypeError);
    expect(visitors).toBe(0);
    expect(preflights).toBe(0);
    expect(residentBatches).toBe(0);
    expect(store.get(first)).toMatchObject({ x: 10, y: 20 });
    expect(store.get(second)).toMatchObject({ x: 30, y: 40 });
    expect(store.pendingResidentPositionUpdates).toBe(2);

    visitors = 0;
    expect(() =>
      store.updatePositions(
        [first, second],
        new Float64Array([101, 201, 301, 401]),
        () => {
          visitors += 1;
        },
        true,
        () => {
          throw new Error("fixture preflight allocation failure");
        },
        () => {
          residentBatches += 1;
        },
      ),
    ).toThrow("fixture preflight allocation failure");
    expect(visitors).toBe(0);
    expect(residentBatches).toBe(0);
    expect(store.get(first)).toMatchObject({ x: 10, y: 20 });
    expect(store.get(second)).toMatchObject({ x: 30, y: 40 });
    expect(store.pendingResidentPositionUpdates).toBe(2);

    expect(store.update(first, { text: "mixed" })).toBe(TextDirty.Content);
    expect(store.pendingDirtyIncludingResidentPositions).toEqual({
      labels: 2,
      mask: TextDirty.Content | TextDirty.Transform,
    });
    expect(store.materializeResidentPositionUpdates()).toBe(2);
    const published: Array<readonly [number, number, boolean]> = [];
    store.publishDirty((slot, mask) => {
      published.push([slot, mask, store.consumePositionOnly(slot)]);
    });
    expect(published).toEqual([
      [0, TextDirty.Content | TextDirty.Transform, true],
      [1, TextDirty.Transform, true],
    ]);
    expect(store.residentPositionStats).toMatchObject({ pending: 0, materializations: 1 });

    store.dispose();
  });

  test("caps duplicate resident input allocation at the reachable slot capacity", () => {
    const store = new TextStore({ initialCapacity: 2 });
    const id = store.create(label());
    store.publishDirty();
    const ids = new Float64Array(100).fill(id);
    const positions = new Float32Array(200);
    for (let index = 0; index < ids.length; index += 1) {
      positions[index * 2] = index + 1;
      positions[index * 2 + 1] = index + 2;
    }

    expect(store.updatePositions(ids, positions, undefined, true)).toBe(100);
    const batch = store.takeResidentPositionUpdates();
    expect(batch?.count).toBe(1);
    expect(batch?.commands.byteLength).toBeLessThanOrEqual(store.capacity * PALETTE_MOVE_STRIDE);
    if (batch !== undefined) store.releaseResidentPositionUpdates(batch);
    store.dispose();
  });

  test("reuses resident command storage across 100K leased waves", () => {
    const count = 100_000;
    const store = new TextStore({ initialCapacity: count });
    const ids = new Float64Array(count);
    const positions = new Float32Array(count * 2);
    for (let index = 0; index < count; index += 1) {
      ids[index] = store.create(label({ x: index }));
      positions[index * 2] = index + 0.25;
      positions[index * 2 + 1] = index + 0.5;
    }
    store.publishDirty();

    expect(store.updatePositions(ids, positions, undefined, true)).toBe(count);
    const first = takeResidentBatch(store, "first reusable");
    expect(first.count).toBe(count);
    expect(first).toMatchObject({ mode: "dense", baseSlot: 0 });
    expect(first.commands.byteLength).toBeGreaterThanOrEqual(count * PALETTE_DENSE_MOVE_STRIDE);
    store.releaseResidentPositionUpdates(first);
    const allocations = store.residentPositionStats.allocations;

    for (let index = 0; index < count; index += 1) {
      positions[index * 2] = (positions[index * 2] ?? 0) + 1;
    }
    expect(store.updatePositions(ids, positions, undefined, true)).toBe(count);
    const second = takeResidentBatch(store, "second reusable");
    expect(second.count).toBe(count);
    expect(second.commands).toBe(first.commands);
    expect(store.residentPositionStats).toMatchObject({
      allocations,
      reuses: 1,
      takes: 2,
      leased: 1,
    });
    store.releaseResidentPositionUpdates(second);
    store.dispose();
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

  test("interns equal styles so shared formats share one frozen object", () => {
    const store = new TextStore();
    const first = store.create(label({ style: { fill: 0x38bdf8, fontSize: 18 } }));
    const second = store.create(label({ style: { fontSize: 18, fill: 0x38bdf8 } }));
    const firstStyle = store.get(first)?.style;
    const secondStyle = store.get(second)?.style;

    expect(firstStyle).toBe(secondStyle);
    expect(Object.isFrozen(firstStyle)).toBe(true);
    expect(store.update(first, { style: { fill: 0x38bdf8, fontSize: 18 } })).toBe(TextDirty.None);

    store.dispose();
  });

  test("marks packed x/y updates as position-only until another transform field changes", () => {
    const { store, first, second } = positionedStore();

    expect(store.updatePositions([first, second], new Float32Array([10, 20, 30, 40]))).toBe(2);
    expect(store.consumePositionOnly(store.slotOf(first) ?? -1)).toBe(true);
    expect(store.consumePositionOnly(store.slotOf(second) ?? -1)).toBe(true);

    store.update(first, { x: 11 });
    expect(store.consumePositionOnly(store.slotOf(first) ?? -1)).toBe(true);
    store.update(second, { x: 31, rotation: 0.25 });
    expect(store.consumePositionOnly(store.slotOf(second) ?? -1)).toBe(false);

    store.publishDirty();
    expect(
      store.updateTextPositions([first, second], "next", new Float32Array([12, 22, 32, 42]))
        .changed,
    ).toBe(2);
    expect(store.consumePositionOnly(store.slotOf(first) ?? -1)).toBe(true);
    expect(store.consumePositionOnly(store.slotOf(second) ?? -1)).toBe(true);

    store.dispose();
  });

  test("reads slot identity, text, style, and zero anchors without a snapshot", () => {
    const store = new TextStore();
    const id = store.create(label({ x: 4, y: 5 }));
    const slot = store.slotOf(id);
    expect(slot).toBeDefined();
    expect(store.idAt(slot ?? -1)).toBe(id);
    expect(store.textAt(slot ?? -1)).toBe("label");
    expect(store.styleAt(slot ?? -1)).toBe(store.get(id)?.style);
    expect(store.anchorsZeroAt(slot ?? -1)).toBe(true);
    expect(store.unitTransformAt(slot ?? -1)).toBe(true);
    expect(store.admitLaneAt(slot ?? -1)).toBe(true);
    store.update(id, { rotation: 0.5 });
    expect(store.admitLaneAt(slot ?? -1)).toBe(false);
    expect(store.admitLaneAt(slot ?? -1, true)).toBe(true);
    store.update(id, { rotation: 1e6 });
    expect(store.admitLaneAt(slot ?? -1, true)).toBe(false);
    store.update(id, { rotation: 0 });
    store.update(id, { anchorX: 0.5 });
    expect(store.anchorsZeroAt(slot ?? -1)).toBe(false);
    expect(store.admitLaneAt(slot ?? -1)).toBe(false);
    store.update(id, { scaleX: 2 });
    expect(store.unitTransformAt(slot ?? -1)).toBe(false);
    expect(store.admitLaneAt(slot ?? -1)).toBe(false);
    store.dispose();
  });

  test("keeps one million reserved slots within 48 MiB", () => {
    const store = new TextStore({ initialCapacity: 1_000_000 });
    expect(store.capacity).toBe(1_048_576);
    expect(store.stats.allocatedBytes).toBeLessThanOrEqual(48 * 1024 * 1024 + 256);
    expect(store.update(store.create(label({ scaleX: 1, rotation: 0.25 })), { scaleX: 1 })).toBe(
      TextDirty.None,
    );
    store.dispose();
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

function positionedStore() {
  const store = new TextStore();
  const first = store.create(label({ x: 1, y: 2 }));
  const second = store.create(label({ x: 3, y: 4 }));
  store.publishDirty();
  return { store, first, second };
}

function takeResidentBatch(store: TextStore, fixture: string) {
  const batch = store.takeResidentPositionUpdates();
  if (batch === undefined) throw new Error(`${fixture} resident position batch is missing`);
  return batch;
}

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
    blendMode: patch.blendMode ?? "normal",
  };
}
