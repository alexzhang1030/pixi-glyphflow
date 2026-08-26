import { describe, expect, test } from "bun:test";

import type { Renderer } from "pixi.js";

import { TextLayer, type PositionedRun } from "../src";
import { TransformPalette } from "../src/advanced";

const RUN: PositionedRun = Object.freeze({
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

function alphaRaster() {
  return {
    mode: "alpha" as const,
    width: 8,
    height: 10,
    pixels: new Uint8Array(80).fill(255),
  };
}

describe("TextLayer commit and maintenance", () => {
  test("routes position storms through the columnar lane without relayout or object changes", async () => {
    let layouts = 0;
    const transforms = new TransformPalette({ initialCapacity: 8, textureWidth: 8 });
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        transforms,
        layoutEngine: {
          layout() {
            layouts += 1;
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const ids = layer.createMany([
      { text: "A", x: 1, y: 1 },
      { text: "A", x: 2, y: 2 },
      { text: "A", x: 3, y: 3 },
    ]);
    await layer.commit();
    transforms.consumeDirty();
    expect(layouts).toBe(1);

    const first = ids[0];
    const third = ids[2];
    if (first === undefined || third === undefined) throw new Error("Fixture ids missing");
    layer.updatePositions(new Float64Array([first, third]), new Float32Array([40, 50, 60, 70]));
    await layer.commit();

    expect(layouts).toBe(1);
    expect(Array.from(transforms.data.subarray(0, 2))).toEqual([40, 50]);
    expect(Array.from(transforms.data.subarray(16, 18))).toEqual([60, 70]);
    // Slot 0 and slot 2 patches sit 48 bytes apart, inside the 256-byte merge gap.
    expect(transforms.consumeDirty()).toEqual([{ offset: 0, length: 80 }]);
    expect(layer.stats.transformOnlyLabels).toBe(2);

    layer.updateTextPositions(
      new Float64Array([first, third]),
      "A",
      new Float32Array([80, 90, 100, 110]),
    );
    await layer.commit();
    expect(layouts).toBe(1);
    expect(layer.getBoundsFor(first)).toMatchObject({ x: 80, y: 90, width: 8, height: 10 });
    expect(Array.from(transforms.data.subarray(0, 2))).toEqual([80, 90]);

    transforms.consumeDirty();
    layer.updateTextPositions(
      new Float64Array([first, third]),
      "B",
      new Float32Array([81, 91, 101, 111]),
    );
    await layer.commit();
    expect(layouts).toBe(2);
    expect(layer.get(first)).toMatchObject({ text: "B", x: 81, y: 91 });
    expect(layer.get(third)).toMatchObject({ text: "B", x: 101, y: 111 });
    expect(Array.from(transforms.data.subarray(0, 2))).toEqual([81, 91]);
    expect(transforms.consumeDirty()).toEqual([{ offset: 0, length: 80 }]);

    layer.updateTextPositions(
      new Float64Array([first, third]),
      ["C", "D"],
      new Float32Array([82, 92, 102, 112]),
    );
    await layer.commit();
    expect(layouts).toBe(4);
    expect(layer.get(first)).toMatchObject({ text: "C", x: 82, y: 92 });
    expect(layer.get(third)).toMatchObject({ text: "D", x: 102, y: 112 });

    layer.destroy();
  });

  test("keeps non-zero anchors on the object path during a content storm", async () => {
    let layouts = 0;
    const transforms = new TransformPalette({ initialCapacity: 8, textureWidth: 8 });
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        transforms,
        layoutEngine: {
          layout() {
            layouts += 1;
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const ids = layer.createMany([
      { text: "A", x: 1, y: 1, anchorX: 0.5, anchorY: 0.5 },
      { text: "A", x: 2, y: 2, anchorX: 0.5, anchorY: 0.5 },
    ]);
    await layer.commit();
    expect(layouts).toBe(1);
    const first = ids[0];
    const second = ids[1];
    if (first === undefined || second === undefined) throw new Error("Fixture ids missing");

    layer.updateTextPositions(
      new Float64Array([first, second]),
      "B",
      new Float32Array([10, 20, 30, 40]),
    );
    await layer.commit();
    expect(layouts).toBe(2);
    expect(layer.get(first)).toMatchObject({ text: "B", x: 10, y: 20, anchorX: 0.5, anchorY: 0.5 });
    expect(layer.get(second)).toMatchObject({ text: "B", x: 30, y: 40, anchorX: 0.5, anchorY: 0.5 });
    expect(layer.getBoundsFor(first)).toMatchObject({ x: 6, y: 15, width: 8, height: 10 });

    layer.destroy();
  });

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
      lastLayoutMs: 0,
      lastInstanceWriteMs: 0,
      lastPaletteWriteMs: 0,
      lastSpatialUpdateMs: 0,
      lastUploadMs: 0,
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
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            layouts += 1;
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            rasters += 1;
            return alphaRaster();
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
    expect(layer.stats.lastLayoutMs).toBeGreaterThanOrEqual(0);
    expect(layer.stats.lastInstanceWriteMs).toBeGreaterThanOrEqual(0);
    expect(layer.stats.lastPaletteWriteMs).toBeGreaterThanOrEqual(0);
    expect(layer.stats.lastSpatialUpdateMs).toBeGreaterThanOrEqual(0);
    expect(layer.stats.lastUploadMs).toBeGreaterThanOrEqual(0);

    layer.detach();
    expect(layer.stats.attached).toBe(false);
    layer.attach({} as Renderer);
    expect(Number(await layer.commit())).toBe(2);
    expect(layouts).toBe(2);

    layer.destroy();
  });

  test("reuses glyph work for packed position storms", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            layouts += 1;
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const id = layer.create({ text: "A", style: { fontSize: 16 } });
    await layer.commit();
    layer.updatePositions([id], new Float32Array([40, 50]));
    await layer.commit();

    expect(layouts).toBe(1);
    expect(layer.stats).toMatchObject({
      glyphCount: 1,
      shapedLabels: 1,
      transformOnlyLabels: 1,
    });
    expect(layer.get(id)).toMatchObject({ x: 40, y: 50 });

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
        style: { fontFamily: "sans-serif", fontSize: 16, fontWeight: "normal", fill: 0x33ccff },
      }),
    ).toBe(true);
    await layer.commit();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ style: { fontWeight: "normal", fill: 0x33ccff } });
    expect(inputs[1]?.writingMode).toBeUndefined();
    expect(rasterWeights).toEqual(["700", "normal"]);
    expect(layer.stats.lastCommitStyleLabels).toBe(1);

    layer.destroy();
  });

  test("keeps rendering-off creates on a residency refresh so visible counts stay honest", async () => {
    const layer = new TextLayer({ rendering: false });
    layer.create({ text: "one" });
    await layer.commit();
    expect(layer.stats.visibleLabelCount).toBe(1);
    const queries = layer.stats.cullingQueries;

    layer.create({ text: "two" });
    await layer.commit();
    expect(layer.stats.visibleLabelCount).toBe(2);
    expect(layer.stats.cullingQueries).toBeGreaterThan(queries);

    layer.destroy();
  });

  test("admits later creates without scanning the resident set", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            layouts += 1;
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    layer.createMany(Array.from({ length: 8 }, (_, index) => ({ text: "A", x: index * 12, y: 0 })));
    await layer.commit();
    expect(layouts).toBe(1);
    const queries = layer.stats.cullingQueries;

    layer.createMany(
      Array.from({ length: 4 }, (_, index) => ({ text: "A", x: 100 + index * 12, y: 0 })),
    );
    await layer.commit();
    expect(layer.stats.cullingQueries).toBe(queries);
    expect(layouts).toBe(1);
    expect(layer.stats.glyphCount).toBe(12);
    expect(layer.stats.visibleLabelCount).toBe(12);

    layer.destroy();
  });

  test("prepares every first-seen label in one commit", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            layouts += 1;
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    layer.createMany(
      Array.from({ length: 10 }, (_, index) => ({ text: "A", x: index * 12, y: 0 })),
    );

    await layer.commit();
    expect(layouts).toBe(1);
    expect(layer.stats.glyphCount).toBe(10);

    await layer.commit();
    expect(layouts).toBe(1);
    expect(layer.stats.glyphCount).toBe(10);

    layer.hideAll();
    await layer.commit();
    expect(layer.stats.visibleLabelCount).toBe(0);
    expect(layer.stats.glyphCount).toBe(0);
    expect(layouts).toBe(1);

    layer.destroy();
  });

  test("keeps unchanged siblings on the draw set when one label changes z-index", async () => {
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            return RUN;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const [bottom, top] = layer.createMany([
      { text: "A", x: 0, y: 0, zIndex: 0 },
      { text: "A", x: 0, y: 0, zIndex: 0 },
    ]);

    await layer.commit();
    expect(layer.stats.glyphCount).toBe(2);
    expect(layer.stats.removedRenderLabels).toBe(0);

    layer.update(bottom!, { zIndex: 2 });
    await layer.commit();
    expect(layer.stats.glyphCount).toBe(2);
    expect(layer.stats.removedRenderLabels).toBe(0);
    expect(layer.get(top!)?.zIndex).toBe(0);

    layer.destroy();
  });
});
