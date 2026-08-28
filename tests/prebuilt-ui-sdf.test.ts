import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FontRegistry } from "../src";
import { RasterGlyphProvider } from "../src/advanced";
import { TINY_SDF_RADIUS } from "../src/atlas/tinySdf";
import { UI_SDF_FAMILY, UI_SDF_FONT_SIZE, uiSdfPrebuilt } from "../src/prebuilt";
import { LATIN_8X8, LATIN_8X8_COUNT } from "../src/prebuilt/latin8x8";

const projectRoot = resolve(import.meta.dir, "..");

describe("pixi-glyphflow/prebuilt", () => {
  test("bakes printable ASCII once and remaps keys on later calls", () => {
    const first = uiSdfPrebuilt({ family: "HUD" });
    const second = uiSdfPrebuilt({ family: "Counters", fontWeight: "bold" });

    expect(UI_SDF_FONT_SIZE).toBe(16);
    expect(UI_SDF_FAMILY).toBe("glyphflow-ui");
    expect(LATIN_8X8).toHaveLength(LATIN_8X8_COUNT * 8);
    expect(first.pages).toHaveLength(1);
    expect(first.pages[0]?.pixels).toBe(second.pages[0]?.pixels);
    expect(first.glyphs).toHaveLength(95);
    expect(second.glyphs).toHaveLength(95);
    expect(first.glyphs[0]?.key).not.toBe(second.glyphs[0]?.key);
    expect(first.pages[0]).toMatchObject({ mode: "sdf", width: 512, height: 192 });

    const cell = 16 + TINY_SDF_RADIUS * 2;
    const letterA = first.glyphs.find((glyph) => glyph.key.split("\0")[2] === "A");
    expect(letterA).toMatchObject({
      width: cell,
      height: cell,
      metrics: {
        bearingX: -TINY_SDF_RADIUS,
        bearingY: 16 + TINY_SDF_RADIUS,
        advance: 16,
        fieldRange: TINY_SDF_RADIUS,
      },
    });
    expect(() => uiSdfPrebuilt({ family: "HUD", fontSize: 24 })).toThrow(TypeError);
    expect(() => uiSdfPrebuilt({ family: "" })).toThrow(TypeError);
  });

  test("serves HarfBuzz-style ASCII as a crop instead of TinySDF", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "HUD", source: new Uint8Array([1, 2]) });
    let canvasCalls = 0;
    let generatorStarts = 0;
    const provider = new RasterGlyphProvider(registry, {
      prebuilt: uiSdfPrebuilt({ family: "HUD" }),
      canvasRasterizer() {
        canvasCalls += 1;
        return Promise.resolve({
          mode: "alpha",
          width: 8,
          height: 8,
          pixels: new Uint8Array(64).fill(255),
          metrics: { bearingX: 0, bearingY: 6, advance: 8 },
        });
      },
      async createMsdfGenerator() {
        generatorStarts += 1;
        throw new Error("MSDF generator must not start for a uiSdf hit");
      },
    });

    const raster = await provider.rasterize({
      family: "HUD",
      fontRevision: font.revision,
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      mode: "sdf",
    });

    expect(raster.mode).toBe("sdf");
    expect(raster.width).toBe(32);
    expect(raster.height).toBe(32);
    expect(raster.pixels[0]).toBeLessThan(128);
    expect(raster.pixels[16 * 32 + 16]).toBeGreaterThan(128);
    expect(canvasCalls).toBe(0);
    expect(generatorStarts).toBe(0);
    expect(provider.stats).toMatchObject({
      prebuiltHits: 1,
      tinySdfRasters: 0,
      distanceFieldRasters: 0,
    });

    const larger = await provider.rasterize({
      family: "HUD",
      fontRevision: font.revision,
      glyphId: 65,
      glyphText: "A",
      fontSize: 32,
      mode: "sdf",
    });
    expect(larger.width).not.toBe(raster.width);
    expect(canvasCalls).toBe(1);
    expect(provider.stats.tinySdfRasters).toBe(1);

    await provider.destroy();
    registry.destroy();
  });

  test("stays out of the root and advanced module graphs", async () => {
    const [root, advanced] = await Promise.all([
      readFile(resolve(projectRoot, "src/index.ts"), "utf8"),
      readFile(resolve(projectRoot, "src/advanced/index.ts"), "utf8"),
    ]);
    expect(root).not.toContain("uiSdf");
    expect(root).not.toContain("prebuilt/");
    expect(advanced).not.toContain("uiSdf");
    expect(advanced).not.toContain("../prebuilt");

    const distEntry = resolve(projectRoot, "dist/index.js");
    if (await Bun.file(distEntry).exists()) {
      const graph = await readStaticJsGraph(distEntry);
      expect(graph).not.toContain("uiSdf");
      expect(graph).not.toContain("glyphflow-ui");
      expect(graph).not.toContain("183c3c1818001800");
    }
  });
});

async function readStaticJsGraph(entry: string): Promise<string> {
  const visited = new Set<string>();
  const sources: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    sources.push(source);
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.endsWith(".js")) continue;
      pending.push(resolve(path, "..", specifier));
    }
  }
  return sources.join("\n");
}
