import { describe, expect, test } from "bun:test";

import type { Renderer } from "pixi.js";

import { TextLayer, type PositionedRun } from "../src";

describe("TextLayer commit and maintenance", () => {
  test("publishes coalesced dirty domains and reports zero work for no-op commits", async () => {
    const layer = new TextLayer();
    const [first, second] = layer.createMany([{ text: "one" }, { text: "two" }]);

    expect(layer.stats.pendingDirtyLabels).toBe(2);
    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastCommitDirtyLabels: 2,
      lastCommitContentLabels: 2,
      lastCommitTransformLabels: 2,
      lastCommitStyleLabels: 2,
    });

    layer.update(first!, { x: 10 });
    layer.update(first!, { y: 20 });
    layer.update(second!, { style: { fill: 0xff0000 } });
    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastCommitDirtyLabels: 2,
      lastCommitContentLabels: 0,
      lastCommitTransformLabels: 1,
      lastCommitStyleLabels: 1,
    });

    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastCommitDirtyLabels: 0,
      lastCommitContentLabels: 0,
      lastCommitTransformLabels: 0,
      lastCommitStyleLabels: 0,
    });

    layer.destroy();
  });

  test("shrinks reserved capacity while preserving identities and snapshots", async () => {
    const layer = new TextLayer({ initialCapacity: 1_024 });
    const first = layer.create({ text: "one", x: 1 });
    const second = layer.create({ text: "two", x: 2 });
    await layer.commit();

    const result = layer.compact();

    expect(result.beforeCapacity).toBe(1_024);
    expect(result.afterCapacity).toBe(16);
    expect(result.releasedBytes).toBeGreaterThan(0);
    expect(layer.get(first)).toMatchObject({ text: "one", x: 1 });
    expect(layer.get(second)).toMatchObject({ text: "two", x: 2 });
    expect(Number(await layer.commit())).toBe(1);

    layer.destroy();
  });

  test("serializes complete render revisions and reuses glyph work for transform updates", async () => {
    let layouts = 0;
    let rasters = 0;
    const run: PositionedRun = Object.freeze({
      source: "bitmap",
      text: "A",
      fontFamily: "sans-serif",
      fontRevision: 0,
      direction: "ltr",
      glyphCount: 1,
      glyphIds: new Uint32Array([65]),
      glyphKeys: Object.freeze(["A"]),
      clusters: new Uint32Array([0]),
      x: new Float32Array([0]),
      y: new Float32Array([8]),
      xAdvance: new Float32Array([8]),
      yAdvance: new Float32Array([0]),
      lineIndices: new Uint32Array([0]),
      bounds: Object.freeze({ x: 0, y: 0, width: 8, height: 10 }),
    });
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            layouts += 1;
            return run;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            rasters += 1;
            return {
              mode: "alpha" as const,
              width: 8,
              height: 10,
              pixels: new Uint8Array(80).fill(255),
            };
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const id = layer.create({ text: "A", style: { fontSize: 16 } });

    const first = layer.commit();
    layer.update(id, { x: 24, y: 32, scale: 2 });
    const second = layer.commit();

    expect(Number(await first)).toBe(1);
    expect(Number(await second)).toBe(2);
    expect(layouts).toBe(1);
    expect(rasters).toBe(1);
    expect(layer.stats).toMatchObject({
      glyphCount: 1,
      shapedLabels: 1,
      transformOnlyLabels: 1,
    });

    layer.detach();
    expect(layer.stats.attached).toBe(false);
    layer.attach({} as Renderer);
    expect(Number(await layer.commit())).toBe(2);
    expect(layouts).toBe(2);

    layer.destroy();
  });

  test("publishes writing mode, font weight, and fill through the render commit seam", async () => {
    const inputs: Array<{
      readonly writingMode?: string;
      readonly style: Readonly<Record<string, unknown>>;
    }> = [];
    const rasterWeights: unknown[] = [];
    const run: PositionedRun = Object.freeze({
      source: "bitmap",
      text: "竖排",
      fontFamily: "sans-serif",
      fontRevision: 0,
      direction: "ltr",
      glyphCount: 1,
      glyphIds: new Uint32Array([1]),
      glyphKeys: Object.freeze(["竖"]),
      clusters: new Uint32Array([0]),
      x: new Float32Array([0]),
      y: new Float32Array([0]),
      xAdvance: new Float32Array([16]),
      yAdvance: new Float32Array([0]),
      lineIndices: new Uint32Array([0]),
      bounds: Object.freeze({ x: 0, y: 0, width: 16, height: 16 }),
    });
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout(_id, _revision, input) {
            inputs.push(input);
            return run;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize(request) {
            rasterWeights.push(request.fontWeight);
            return {
              mode: "alpha" as const,
              width: 8,
              height: 8,
              pixels: new Uint8Array(64).fill(255),
            };
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const id = layer.create({
      text: "竖排",
      layout: { writingMode: "vertical-rl" },
      style: { fontFamily: "sans-serif", fontSize: 16, fontWeight: "700", fill: 0xff3366 },
    });

    await layer.commit();
    expect(inputs[0]).toMatchObject({
      writingMode: "vertical-rl",
      style: { fontWeight: "700", fill: 0xff3366 },
    });
    expect(rasterWeights).toEqual(["700"]);

    expect(
      layer.update(id, {
        layout: null,
        style: { fontFamily: "sans-serif", fontSize: 16, fontWeight: "bold", fill: 0x33ccff },
      }),
    ).toBe(true);
    await layer.commit();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ style: { fontWeight: "bold", fill: 0x33ccff } });
    expect(inputs[1]?.writingMode).toBeUndefined();
    expect(rasterWeights).toEqual(["700", "bold"]);
    expect(layer.stats.lastCommitStyleLabels).toBe(1);

    layer.destroy();
  });
});
