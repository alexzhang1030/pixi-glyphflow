import { describe, expect, test } from "bun:test";

import type { Renderer } from "pixi.js";

import { TextLayer, type PositionedRun } from "../src";

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

describe("TextLayer culling and hit bounds", () => {
  test("renders viewport entrants, retires exits, and preserves label revisions on camera frames", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      culling: { enabled: true, bounds: { x: 0, y: 0, width: 100, height: 100 } },
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
    const first = layer.create({ text: "A", x: 10, y: 10, style: { fontSize: 16 } });
    const second = layer.create({ text: "A", x: 1_000, y: 10, style: { fontSize: 16 } });

    expect(Number(await layer.commit())).toBe(1);
    expect(layouts).toBe(1);
    expect(layer.stats).toMatchObject({ visibleLabelCount: 1, culledLabelCount: 1, glyphCount: 1 });
    expect(layer.hitTest({ x: 12, y: 12 })).toBe(first);
    expect(layer.getBoundsFor(second)).toMatchObject({ x: 1_000, y: 10 });

    layer.setViewportBounds({ x: 950, y: 0, width: 100, height: 100 });
    expect(Number(await layer.commit())).toBe(1);
    expect(layouts).toBe(1);
    expect(layer.stats).toMatchObject({ visibleLabelCount: 1, culledLabelCount: 1, glyphCount: 1 });
    expect(layer.hitTest({ x: 1_002, y: 12 })).toBe(second);

    layer.destroy();
  });

  test("skips subpixel labels when lod is on and admits them after they grow", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      culling: { enabled: true, lod: true, bounds: { x: 0, y: 0, width: 100, height: 100 } },
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
    const tiny = layer.create({
      text: "A",
      x: 10,
      y: 10,
      scaleY: 0.01,
      style: { fontSize: 16 },
    });
    const visible = layer.create({ text: "B", x: 20, y: 10, style: { fontSize: 16 } });

    expect(Number(await layer.commit())).toBe(1);
    expect(layouts).toBe(1);
    expect(layer.stats).toMatchObject({ glyphCount: 1 });
    expect(layer.hitTest({ x: 22, y: 12 })).toBe(visible);

    layer.update(tiny, { scaleY: 1 });
    expect(Number(await layer.commit())).toBe(2);
    expect(layouts).toBe(2);
    expect(layer.stats).toMatchObject({ glyphCount: 2 });
    expect(layer.hitTest({ x: 12, y: 12 })).toBe(tiny);

    layer.update(visible, { scaleY: 0.01 });
    expect(Number(await layer.commit())).toBe(3);
    expect(layouts).toBe(2);
    expect(layer.stats).toMatchObject({ glyphCount: 1 });

    layer.destroy();
  });

  test("updates hit bounds through packed position storms", async () => {
    const layer = new TextLayer({ rendering: false });
    const ids = layer.createMany([
      { text: "A", x: 0, y: 0, style: { fontSize: 10 } },
      { text: "B", x: 20, y: 20, style: { fontSize: 10 } },
    ]);
    await layer.commit();

    expect(layer.updatePositions(ids, new Float32Array([100, 100, 120, 120]))).toBe(2);
    expect(layer.hitTest({ x: 101, y: 101 })).toBe(ids[0]);
    expect(layer.hitTest({ x: 1, y: 1 })).toBeUndefined();

    expect(layer.updateTextPositions(ids, ["A", "B"], new Float32Array([0, 0, 20, 20]))).toBe(2);
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(ids[0]);
    expect(layer.hitTest({ x: 101, y: 101 })).toBeUndefined();

    // Cross a 64-wide hash cell so translateMany must rebucket, not only slide AABB.
    expect(layer.updatePositions(ids, new Float32Array([200, 0, 280, 0]))).toBe(2);
    expect(layer.hitTest({ x: 201, y: 1 })).toBe(ids[0]);
    expect(layer.hitTest({ x: 1, y: 1 })).toBeUndefined();

    layer.destroy();
  });

  test("admits an in-view create without a residency refresh", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      culling: { enabled: true, bounds: { x: 0, y: 0, width: 100, height: 100 } },
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
    layer.create({ text: "A", x: 10, y: 10, style: { fontSize: 16 } });
    expect(Number(await layer.commit())).toBe(1);
    expect(layouts).toBe(1);
    const queries = layer.stats.cullingQueries;

    const inside = layer.create({ text: "B", x: 20, y: 10, style: { fontSize: 16 } });
    layer.create({ text: "C", x: 1_000, y: 10, style: { fontSize: 16 } });
    expect(Number(await layer.commit())).toBe(2);
    expect(layer.stats.cullingQueries).toBe(queries);
    expect(layouts).toBe(2);
    expect(layer.stats).toMatchObject({ visibleLabelCount: 2, culledLabelCount: 1, glyphCount: 2 });
    expect(layer.hitTest({ x: 22, y: 12 })).toBe(inside);

    layer.setViewportBounds({ x: 950, y: 0, width: 100, height: 100 });
    expect(Number(await layer.commit())).toBe(2);
    expect(layouts).toBe(3);
    expect(layer.stats).toMatchObject({ visibleLabelCount: 1, culledLabelCount: 2, glyphCount: 1 });

    layer.destroy();
  });

  test("rebuilds the full resident set after the viewport is cleared", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { enabled: true, bounds: { x: 0, y: 0, width: 50, height: 50 } },
    });
    layer.createMany([
      { text: "A", x: 0, y: 0, style: { fontSize: 10 } },
      { text: "B", x: 200, y: 0, style: { fontSize: 10 } },
    ]);
    await layer.commit();
    expect(layer.stats.visibleLabelCount).toBe(1);

    layer.setViewportBounds(undefined);
    await layer.commit();
    expect(layer.stats.visibleLabelCount).toBe(2);

    layer.destroy();
  });

  test("resolves overlapping labels by z index and latest insertion order", async () => {
    const layer = new TextLayer({ rendering: false });
    const first = layer.create({ text: "first", x: 0, y: 0, zIndex: 1 });
    const second = layer.create({ text: "second", x: 0, y: 0, zIndex: 5 });
    await layer.commit();

    expect(layer.hitTest({ x: 1, y: 1 })).toBe(second);
    layer.update(first, { zIndex: 8 });
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(first);

    layer.destroy();
  });

  test("ignores the off-screen admit budget on the cpu-grid tight set", async () => {
    let layouts = 0;
    const layer = new TextLayer({
      renderer: {} as Renderer,
      culling: {
        enabled: true,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        offscreenAdmitBudgetBytes: 0,
      },
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
    const first = layer.create({ text: "A", x: 10, y: 10, style: { fontSize: 16 } });
    const second = layer.create({ text: "B", x: 40, y: 10, style: { fontSize: 16 } });
    expect(Number(await layer.commit())).toBe(1);
    expect(layouts).toBe(2);
    expect(layer.stats).toMatchObject({ visibleLabelCount: 2, glyphCount: 2 });
    expect(layer.hitTest({ x: 12, y: 12 })).toBe(first);
    expect(layer.hitTest({ x: 42, y: 12 })).toBe(second);
    layer.destroy();
  });

  test("rejects a negative off-screen admit budget", () => {
    expect(
      () =>
        new TextLayer({
          rendering: false,
          culling: { offscreenAdmitBudgetBytes: -1 },
        }),
    ).toThrow("offscreenAdmitBudgetBytes");
  });
});
