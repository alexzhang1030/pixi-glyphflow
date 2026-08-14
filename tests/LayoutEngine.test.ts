import { describe, expect, test } from "bun:test";

import {
  FontRegistry,
  LayoutEngine,
  type BitmapLayoutInput,
  type HarfBuzzShapeInput,
  type PositionedRun,
} from "../src";

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
        direction: "ltr",
        trimEnd: true,
      },
    ]);
    expect(shapeInputs[0]).toMatchObject({
      family: "Complex",
      text: "سلام",
      fontSize: 24,
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
});

function positionedRun(
  source: "bitmap" | "harfbuzz",
  text: string,
  family: string,
  fontRevision: number,
): Readonly<PositionedRun> {
  return Object.freeze({
    source,
    text,
    fontFamily: family,
    fontRevision,
    glyphCount: 1,
    direction: "ltr",
    glyphIds: new Uint32Array([1]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([10]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    bounds: Object.freeze({ x: 0, y: 0, width: 10, height: 16 }),
  });
}
