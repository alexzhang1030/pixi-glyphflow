import { describe, expect, test } from "bun:test";

import { FontRegistry, type PositionedRun } from "../src";
import { LayoutEngine, type BitmapLayoutInput } from "../src/advanced";
import type { HarfBuzzShapeInput } from "../src/shaping";

describe("LayoutEngine", () => {
  test("routes system fonts through bitmap layout and binary fonts through HarfBuzz", async () => {
    const registry = new FontRegistry();
    const system = await registry.register({ family: "System" });
    const binary = await registry.register({
      family: "Complex",
      source: new Uint8Array([1, 2, 3]),
    });
    const bitmapInputs: BitmapLayoutInput[] = [];
    const shapeInputs: HarfBuzzShapeInput[] = [];
    const bitmapRun = positionedRun("bitmap", "hello", "System", system.revision);
    const harfbuzzRun = positionedRun("harfbuzz", "سلام", "Complex", binary.revision);
    const engine = new LayoutEngine(registry, {
      bitmapAdapter: {
        layout(input) {
          bitmapInputs.push(input);
          return bitmapRun;
        },
      },
      harfbuzzShaper: {
        async shape(_labelId, _sourceRevision, input) {
          shapeInputs.push(input);
          return harfbuzzRun;
        },
      },
    });

    expect(
      await engine.layout(10, 1, {
        text: "hello",
        style: { fontFamily: "System", fontSize: 16 },
      }),
    ).toBe(bitmapRun);
    expect(
      await engine.layout(11, 2, {
        text: "سلام",
        style: { fontFamily: "Complex", fontSize: 24 },
        direction: "rtl",
        language: "ar",
        script: "Arab",
        features: ["liga=1"],
      }),
    ).toBe(harfbuzzRun);

    expect(bitmapInputs).toEqual([
      {
        text: "hello",
        style: { fontFamily: "System", fontSize: 16 },
        fontRevision: system.revision,
        cacheRevision: registry.stats.revision,
        direction: "ltr",
        trimEnd: true,
      },
    ]);
    expect(shapeInputs[0]).toMatchObject({
      family: "Complex",
      text: "سلام",
      fontSize: 24,
      fontRevision: binary.revision,
      direction: "rtl",
      language: "ar",
      script: "Arab",
      features: ["liga=1"],
    });
    expect(engine.stats).toEqual({ layouts: 2, bitmapLayouts: 1, harfbuzzLayouts: 1 });

    engine.destroy();
    registry.destroy();
  });

  test("resolves named fallback chains before selecting a shaping backend", async () => {
    const registry = new FontRegistry();
    const binary = await registry.register({
      family: "Primary",
      source: new Uint8Array([1]),
    });
    registry.registerFallback("UI", ["Primary", "sans-serif"]);
    let selectedFamily = "";
    const engine = new LayoutEngine(registry, {
      bitmapAdapter: { layout: () => positionedRun("bitmap", "A", "sans-serif", 0) },
      harfbuzzShaper: {
        async shape(_labelId, _sourceRevision, input) {
          selectedFamily = input.family;
          return positionedRun("harfbuzz", input.text, input.family, binary.revision);
        },
      },
    });

    await engine.layout(1, 1, { text: "A", style: { fontFamily: "UI", fontSize: 20 } });
    expect(selectedFamily).toBe("Primary");

    engine.destroy();
    registry.destroy();
  });

  test("selects the first custom font with complete glyph coverage", async () => {
    const registry = new FontRegistry();
    const latin = await registry.register({
      family: "Latin custom",
      source: new Uint8Array([1]),
    });
    const cjkv = await registry.register({
      family: "CJKV custom",
      source: new Uint8Array([2]),
    });
    registry.registerFallback("Global UI", ["Latin custom", "CJKV custom", "sans-serif"]);
    const shapeInputs: HarfBuzzShapeInput[] = [];
    const engine = new LayoutEngine(registry, {
      bitmapAdapter: { layout: () => positionedRun("bitmap", "漢字", "sans-serif", 0) },
      harfbuzzShaper: {
        async shape(_labelId, _sourceRevision, input) {
          shapeInputs.push(input);
          const revision = input.family === "Latin custom" ? latin.revision : cjkv.revision;
          const glyphId = input.family === "Latin custom" ? 0 : 30_000;
          return positionedRun("harfbuzz", input.text, input.family, revision, glyphId);
        },
      },
    });

    const run = await engine.layout(12, 4, {
      text: "漢字",
      style: { fontFamily: "Global UI", fontSize: 28 },
      language: "zh-Hant",
      script: "Hant",
      features: ["kern"],
      variations: { wght: 560 },
    });

    expect(run.fontFamily).toBe("CJKV custom");
    expect(shapeInputs.map((input) => input.family)).toEqual(["Latin custom", "CJKV custom"]);
    expect(shapeInputs[1]).toMatchObject({
      language: "zh-Hant",
      script: "Hant",
      features: ["kern"],
      variations: { wght: 560 },
      fontRevision: cjkv.revision,
    });
    expect(engine.stats).toEqual({ layouts: 1, bitmapLayouts: 0, harfbuzzLayouts: 2 });

    const cached = engine.layout(14, 8, {
      text: "漢字",
      style: { fontFamily: "Global UI", fontSize: 28 },
      language: "zh-Hant",
      script: "Hant",
      features: ["kern"],
      variations: { wght: 560 },
    });
    expect(cached).toBe(run);
    expect(cached).not.toBeInstanceOf(Promise);
    expect(shapeInputs).toHaveLength(2);
    expect(engine.stats).toEqual({ layouts: 2, bitmapLayouts: 0, harfbuzzLayouts: 2 });

    engine.destroy();
    registry.destroy();
  });

  test("expands fallback aliases into the bitmap font stack after binary coverage misses", async () => {
    const registry = new FontRegistry();
    const latin = await registry.register({
      family: "Latin custom",
      source: new Uint8Array([1]),
    });
    const system = await registry.register({ family: "CJKV system" });
    registry.registerFallback("Global UI", ["Latin custom", "CJKV system", "sans-serif"]);
    let bitmapInput: BitmapLayoutInput | undefined;
    const bitmapRun = positionedRun("bitmap", "서울", "CJKV system", system.revision);
    const engine = new LayoutEngine(registry, {
      bitmapAdapter: {
        layout(input) {
          bitmapInput = input;
          return bitmapRun;
        },
      },
      harfbuzzShaper: {
        async shape(_labelId, _sourceRevision, input) {
          return positionedRun("harfbuzz", input.text, input.family, latin.revision, 0);
        },
      },
    });

    expect(
      await engine.layout(13, 5, {
        text: "서울",
        style: { fontFamily: "Global UI", fontSize: 22 },
        language: "ko",
        script: "Kore",
      }),
    ).toBe(bitmapRun);
    expect(bitmapInput).toEqual({
      text: "서울",
      style: { fontFamily: ["CJKV system", "sans-serif"], fontSize: 22 },
      fontRevision: system.revision,
      cacheRevision: registry.stats.revision,
      direction: "ltr",
      trimEnd: true,
    });

    engine.destroy();
    registry.destroy();
  });

  test("lays out upright glyphs in top-to-bottom right-to-left columns", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Vertical fixture" });
    const horizontalRun: Readonly<PositionedRun> = Object.freeze({
      source: "bitmap",
      text: "AB\n中",
      fontFamily: "Vertical fixture",
      fontRevision: 1,
      glyphCount: 3,
      direction: "ltr",
      glyphIds: new Uint32Array([101, 102, 20_013]),
      clusters: new Uint32Array([0, 1, 3]),
      x: new Float32Array([0, 10, 0]),
      y: new Float32Array([2, 2, 26]),
      xAdvance: new Float32Array([10, 10, 20]),
      yAdvance: new Float32Array([0, 0, 0]),
      lineIndices: new Uint32Array([0, 0, 1]),
      glyphKeys: Object.freeze(["A", "B", "中"]),
      bounds: Object.freeze({ x: 0, y: 0, width: 20, height: 48 }),
    });
    const engine = new LayoutEngine(registry, {
      bitmapAdapter: { layout: () => horizontalRun },
      harfbuzzShaper: {
        async shape() {
          throw new Error("Unexpected binary shaping");
        },
      },
    });

    const run = await engine.layout(20, 1, {
      text: "AB\n中",
      style: { fontFamily: "Vertical fixture", fontSize: 20, lineHeight: 24 },
      writingMode: "vertical-rl",
    });

    expect(run).not.toBe(horizontalRun);
    expect([...run.x]).toEqual([24, 24, 0]);
    expect([...run.y]).toEqual([0, 20, 0]);
    expect([...run.xAdvance]).toEqual([0, 0, 0]);
    expect([...run.yAdvance]).toEqual([20, 20, 20]);
    expect([...run.lineIndices]).toEqual([0, 0, 1]);
    expect(run.bounds).toEqual({ x: 0, y: 0, width: 48, height: 40 });

    engine.destroy();
    registry.destroy();
  });
});

function positionedRun(
  source: "bitmap" | "harfbuzz",
  text: string,
  family: string,
  fontRevision: number,
  glyphId = 1,
): Readonly<PositionedRun> {
  return Object.freeze({
    source,
    text,
    fontFamily: family,
    fontRevision,
    glyphCount: 1,
    direction: "ltr",
    glyphIds: new Uint32Array([glyphId]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([10]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    bounds: Object.freeze({ x: 0, y: 0, width: 10, height: 16 }),
  });
}
