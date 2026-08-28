import { describe, expect, test } from "bun:test";

import type { Renderer } from "pixi.js";

import { TextLayer, type TextId } from "../src";

describe("TextLayer", () => {
  test("creates label state and publishes a revision", async () => {
    const layer = new TextLayer();
    const id = layer.create({
      text: "上海 120 FPS",
      x: 24,
      y: 32,
      style: { fill: 0xffffff, fontSize: 18 },
    });

    expect(typeof id).toBe("number");
    expect(layer.get(id)).toMatchObject({ text: "上海 120 FPS", x: 24, y: 32 });
    expect(layer.stats).toMatchObject({
      backend: "glyphflow-core",
      labelCount: 1,
      pendingMutations: 1,
      revision: 0,
      palettePath: "texture",
    });

    expect(Number(await layer.commit())).toBe(1);
    expect(layer.stats.pendingMutations).toBe(0);
    expect(Number(await layer.commit())).toBe(1);

    layer.destroy();
  });

  test("keeps the 0.0.x update alias", async () => {
    const layer = new TextLayer();
    const id = layer.create({ text: "120 FPS" });

    expect(
      layer.updateLabel(id, {
        text: "121 FPS",
        alpha: 0.5,
        visible: false,
        anchor: 0.5,
      }),
    ).toBe(true);
    expect(layer.get(id)).toMatchObject({
      text: "121 FPS",
      alpha: 0.5,
      visible: false,
      anchor: { x: 0.5, y: 0.5 },
    });

    expect(Number(await layer.commit())).toBe(1);
    expect(layer.remove(id)).toBe(true);
    expect(layer.stats.labelCount).toBe(0);
    expect(Number(await layer.commit())).toBe(2);

    layer.destroy();
  });

  test("tracks renderer attachment", () => {
    const layer = new TextLayer();
    const renderer = {} as Renderer;

    layer.attach(renderer);
    expect(layer.stats.attached).toBe(true);
    layer.detach();
    expect(layer.stats.attached).toBe(false);

    layer.destroy();
  });

  test("rejects invalid values and stale updates", () => {
    const layer = new TextLayer();

    expect(() => layer.create({ text: "bad", x: Number.NaN })).toThrow(TypeError);
    expect(layer.remove(999 as TextId)).toBe(false);
    expect(() => layer.update(999 as TextId, { x: 1 })).toThrow(RangeError);

    layer.destroy();
    expect(() => layer.create({ text: "late" })).toThrow("TextLayer has been destroyed");
  });
});
