import { describe, expect, test } from "bun:test";

import { TextLayer, type TrustedGlyphRunInput } from "../src";

describe("trusted glyph runs", () => {
  test("adopts caller-owned typed arrays in constant time and survives transform updates", async () => {
    const layer = new TextLayer();
    const font = await layer.fonts.register({ family: "Fixture" });
    const id = layer.create({ text: "AB", x: 1, y: 2 });
    const input = trustedInput(font.revision);

    const run = layer.createTrustedRun(id, input);
    expect(run.glyphIds).toBe(input.glyphIds);
    expect(run.x).toBe(input.x);
    expect(run.atlasId).toBe("fixture-atlas");
    expect(run.sourceRevision).toBe(1);
    expect(layer.adoptRun(id, run)).toBe(true);
    expect(layer.getTrustedRun(id)).toBe(run);
    expect(layer.adoptRun(id, run)).toBe(false);

    layer.updatePositions(new Float64Array([id]), new Float32Array([100, 200]));
    await layer.commit();
    expect(layer.get(id)?.sourceRevision).toBe(1);
    expect(layer.getTrustedRun(id)).toBe(run);

    layer.destroy();
  });

  test("rejects cross-layer ownership and stale source or font revisions", async () => {
    const first = new TextLayer();
    const second = new TextLayer();
    const firstFont = await first.fonts.register({ family: "Fixture" });
    await second.fonts.register({ family: "Fixture" });
    const firstId = first.create({ text: "AB" });
    const secondId = second.create({ text: "AB" });
    const run = first.createTrustedRun(firstId, trustedInput(firstFont.revision));

    expect(() => second.adoptRun(secondId, run)).toThrow(TypeError);
    first.update(firstId, { text: "CD" });
    expect(() => first.adoptRun(firstId, run)).toThrow(RangeError);

    first.fonts.unregister("Fixture");
    const revised = await first.fonts.register({ family: "Fixture" });
    expect(revised.revision).toBeGreaterThan(firstFont.revision);
    expect(() => first.createTrustedRun(firstId, trustedInput(firstFont.revision, "CD"))).toThrow(
      RangeError,
    );

    first.destroy();
    second.destroy();
  });

  test("checks structural lengths and finite bounds before trust is granted", async () => {
    const layer = new TextLayer();
    const font = await layer.fonts.register({ family: "Fixture" });
    const id = layer.create({ text: "AB" });

    expect(() =>
      layer.createTrustedRun(id, {
        ...trustedInput(font.revision),
        x: new Float32Array([0]),
      }),
    ).toThrow(TypeError);
    expect(() =>
      layer.createTrustedRun(id, {
        ...trustedInput(font.revision),
        bounds: { x: 0, y: 0, width: Number.NaN, height: 16 },
      }),
    ).toThrow(TypeError);

    layer.destroy();
  });
});

function trustedInput(fontRevision: number, text = "AB"): TrustedGlyphRunInput {
  return {
    text,
    fontFamily: "Fixture",
    fontRevision,
    atlasId: "fixture-atlas",
    direction: "ltr",
    glyphIds: new Uint32Array([101, 102]),
    clusters: new Uint32Array([0, 1]),
    x: new Float32Array([0, 10]),
    y: new Float32Array([0, 0]),
    xAdvance: new Float32Array([10, 10]),
    yAdvance: new Float32Array([0, 0]),
    lineIndices: new Uint32Array([0, 0]),
    bounds: { x: 0, y: -12, width: 20, height: 16 },
  };
}
