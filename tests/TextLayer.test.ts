import { describe, expect, test } from "bun:test";

import { Text, type Renderer } from "pixi.js";

import { TextLayer, type TextId } from "../src";

describe("TextLayer", () => {
  test("creates visible PixiJS text and publishes a revision", async () => {
    const layer = new TextLayer();
    const id = layer.create({
      text: "上海 120 FPS",
      x: 24,
      y: 32,
      style: { fill: 0xffffff, fontSize: 18 },
    });

    expect(typeof id).toBe("number");
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0]).toBeInstanceOf(Text);
    expect(layer.children[0]?.text).toBe("上海 120 FPS");
    expect(layer.children[0]?.position).toMatchObject({ x: 24, y: 32 });
    expect(layer.stats).toMatchObject({
      backend: "pixi-text-poc",
      labelCount: 1,
      pendingMutations: 1,
      revision: 0,
    });

    expect(Number(await layer.commit())).toBe(1);
    expect(layer.stats.pendingMutations).toBe(0);
    expect(Number(await layer.commit())).toBe(1);

    layer.destroy();
  });

  test("updates and removes labels", async () => {
    const layer = new TextLayer();
    const id = layer.create({ text: "120 FPS" });

    layer.updateLabel(id, {
      text: "121 FPS",
      alpha: 0.5,
      visible: false,
      anchor: 0.5,
    });

    expect(layer.children[0]?.text).toBe("121 FPS");
    expect(layer.children[0]?.alpha).toBe(0.5);
    expect(layer.children[0]?.visible).toBe(false);
    expect(layer.children[0]?.anchor).toMatchObject({ x: 0.5, y: 0.5 });

    expect(Number(await layer.commit())).toBe(1);
    layer.remove(id);
    expect(layer.children).toHaveLength(0);
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

  test("rejects invalid values and unknown ids", () => {
    const layer = new TextLayer();

    expect(() => layer.create({ text: "bad", x: Number.NaN })).toThrow(TypeError);
    expect(() => layer.remove(999 as TextId)).toThrow(RangeError);

    layer.destroy();
    expect(() => layer.create({ text: "late" })).toThrow("TextLayer has been destroyed");
  });
});
