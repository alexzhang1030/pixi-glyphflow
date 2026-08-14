import { describe, expect, test } from "bun:test";

import { TextLayer, type TextId } from "../src";

describe("TextLayer 1.0 CRUD", () => {
  test("creates immutable snapshots with ergonomic defaults", () => {
    const layer = new TextLayer({ initialCapacity: 2 });
    const id = layer.create({
      text: "上海 120 FPS",
      x: 24,
      y: 32,
      scale: { x: 2, y: 3 },
      anchor: 0.5,
      style: { fill: 0xffffff, fontSize: 18 },
    });
    const snapshot = layer.get(id);

    expect(snapshot).toMatchObject({
      id,
      sourceRevision: 1,
      text: "上海 120 FPS",
      x: 24,
      y: 32,
      scaleX: 2,
      scaleY: 3,
      rotation: 0,
      alpha: 1,
      visible: true,
      blendMode: "normal",
      anchor: { x: 0.5, y: 0.5 },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.anchor)).toBe(true);
    expect(Object.isFrozen(snapshot?.style)).toBe(true);
    expect(layer.has(id)).toBe(true);
    expect(layer.stats).toMatchObject({
      backend: "glyphflow-core",
      labelCount: 1,
      capacity: 2,
      pendingMutations: 1,
      revision: 0,
    });

    layer.destroy();
  });

  test("creates batches transactionally and keeps identities layer-local", () => {
    const layer = new TextLayer();

    expect(() => layer.createMany([{ text: "valid" }, { text: "invalid", x: Number.NaN }])).toThrow(
      TypeError,
    );
    expect(layer.stats.labelCount).toBe(0);

    const ids = layer.createMany([{ text: "one" }, { text: "two", x: 2 }]);
    const sibling = new TextLayer();
    const foreign = sibling.create({ text: "foreign" });

    expect(ids).toHaveLength(2);
    expect(layer.get(ids[0] as TextId)?.text).toBe("one");
    expect(layer.get(ids[1] as TextId)?.x).toBe(2);
    expect(layer.has(foreign)).toBe(false);

    layer.destroy();
    sibling.destroy();
  });

  test("applies single and bulk changes with no-op commit semantics", async () => {
    const layer = new TextLayer();
    const [first, second] = layer.createMany([{ text: "one" }, { text: "two" }]);

    expect(Number(await layer.commit())).toBe(1);
    expect(layer.update(first as TextId, { text: "one" })).toBe(false);
    expect(Number(await layer.commit())).toBe(1);

    expect(
      layer.updateMany([
        { id: first as TextId, patch: { text: "updated", x: 10 } },
        { id: second as TextId, patch: { alpha: 0.5, visible: false } },
      ]),
    ).toBe(2);
    expect(layer.get(first as TextId)).toMatchObject({ text: "updated", x: 10 });
    expect(layer.get(second as TextId)).toMatchObject({ alpha: 0.5, visible: false });
    expect(Number(await layer.commit())).toBe(2);
    expect(layer.stats.pendingMutations).toBe(0);

    layer.destroy();
  });

  test("validates a bulk update before publishing any change", () => {
    const layer = new TextLayer();
    const sibling = new TextLayer();
    const local = layer.create({ text: "local", x: 1 });
    const foreign = sibling.create({ text: "foreign" });

    expect(() =>
      layer.updateMany([
        { id: local, patch: { x: 20 } },
        { id: foreign, patch: { x: 30 } },
      ]),
    ).toThrow(RangeError);
    expect(layer.get(local)?.x).toBe(1);

    layer.destroy();
    sibling.destroy();
  });

  test("updates packed positions and rejects malformed batches transactionally", () => {
    const layer = new TextLayer();
    const ids = layer.createMany([{ text: "one" }, { text: "two" }]);
    const packedIds = new Float64Array(ids);

    expect(layer.updatePositions(packedIds, new Float32Array([1, 2, 3, 4]))).toBe(2);
    expect(layer.get(ids[0] as TextId)).toMatchObject({ x: 1, y: 2 });
    expect(layer.get(ids[1] as TextId)).toMatchObject({ x: 3, y: 4 });
    expect(layer.updatePositions(packedIds, new Float32Array([1, 2, 3, 4]))).toBe(0);
    expect(() => layer.updatePositions(packedIds, new Float32Array([5, 6]))).toThrow(TypeError);
    expect(layer.get(ids[0] as TextId)).toMatchObject({ x: 1, y: 2 });

    layer.destroy();
  });

  test("updates broadcast text and packed positions through one columnar batch", async () => {
    const layer = new TextLayer({ culling: false });
    const ids = layer.createMany([
      { text: "old", x: 1 },
      { text: "old", x: 2 },
    ]);
    await layer.commit();
    const packedIds = new Float64Array(ids);

    expect(layer.updateTextPositions(packedIds, "new", new Float32Array([10, 20, 30, 40]))).toBe(2);
    expect(layer.get(ids[0] as TextId)).toMatchObject({ text: "new", x: 10, y: 20 });
    expect(layer.get(ids[1] as TextId)).toMatchObject({ text: "new", x: 30, y: 40 });
    expect(() =>
      layer.updateTextPositions(packedIds, ["valid", "valid"], new Float32Array([1, 2])),
    ).toThrow(TypeError);
    expect(layer.get(ids[0] as TextId)).toMatchObject({ text: "new", x: 10, y: 20 });

    await layer.commit();
    expect(layer.stats.lastCommitContentLabels).toBe(2);
    expect(layer.stats.lastCommitTransformLabels).toBe(2);
    layer.destroy();
  });

  test("removes labels idempotently and clears complete batches", async () => {
    const layer = new TextLayer();
    const ids = layer.createMany([{ text: "one" }, { text: "two" }, { text: "three" }]);

    expect(layer.remove(ids[0] as TextId)).toBe(true);
    expect(layer.remove(ids[0] as TextId)).toBe(false);
    expect(layer.removeMany([ids[1] as TextId, ids[1] as TextId, 1 as TextId])).toBe(1);
    expect(layer.stats.labelCount).toBe(1);
    expect(layer.clear()).toBe(1);
    expect(layer.clear()).toBe(0);
    expect(Number(await layer.commit())).toBe(1);
    expect(layer.stats.labelCount).toBe(0);

    layer.destroy();
  });
});
