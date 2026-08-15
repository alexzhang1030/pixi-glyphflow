import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src";
import {
  PrebuiltGlyphProvider,
  RasterGlyphProvider,
  type GlyphMode,
  type GlyphRaster,
  type RasterGlyphRequest,
} from "../src/advanced";

describe("glyph providers", () => {
  test("extracts stable MSDF, SDF, alpha, and color rasters from prebuilt pages", async () => {
    const modes: GlyphMode[] = ["msdf", "sdf", "alpha", "color"];
    const pages = modes.map((mode, index) => ({
      id: `page-${mode}`,
      mode,
      width: 2,
      height: 2,
      pixels: new Uint8Array(2 * 2 * (mode === "sdf" || mode === "alpha" ? 1 : 4)).fill(index + 1),
    }));
    const provider = new PrebuiltGlyphProvider({
      pages,
      glyphs: modes.map((mode) => ({
        key: `glyph-${mode}`,
        pageId: `page-${mode}`,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        metrics: { bearingX: 1, bearingY: 2, advance: 3, fieldRange: 4 },
      })),
    });

    for (const mode of modes) {
      const first = await provider.rasterize(`glyph-${mode}`);
      const second = await provider.rasterize(`glyph-${mode}`);
      expect(first).toBe(second);
      expect(first).toMatchObject({
        mode,
        width: 2,
        height: 2,
        metrics: { bearingX: 1, bearingY: 2, advance: 3, fieldRange: 4 },
      });
    }
    expect(provider.stats).toEqual({ glyphs: 4, pages: 4, cacheEntries: 4, hits: 4, misses: 4 });

    provider.destroy();
  });

  test("uses injected canvas and lazy MSDF boundaries with revisioned caching", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "Fixture", source: new Uint8Array([1, 2]) });
    let canvasCalls = 0;
    let generatorStarts = 0;
    let generatorCalls = 0;
    const provider = new RasterGlyphProvider(registry, {
      generatorConcurrency: 1,
      canvasRasterizer(request): Promise<GlyphRaster> {
        canvasCalls += 1;
        const channels = request.mode === "color" ? 4 : 1;
        return Promise.resolve({
          mode: request.mode,
          width: 2,
          height: 1,
          pixels: new Uint8Array(2 * channels).fill(7),
          metrics: { bearingX: 0, bearingY: 1, advance: 2 },
        });
      },
      async createMsdfGenerator() {
        generatorStarts += 1;
        return {
          async generateAtlas() {
            generatorCalls += 1;
            return {
              texture: {
                width: 2,
                height: 1,
                data: new Uint8ClampedArray([10, 20, 30, 255, 100, 50, 0, 255]),
              },
              glyphs: [
                {
                  char: "A",
                  atlasPosition: [0, 0],
                  atlasSize: [2, 1],
                  bounds: { left: 1, bottom: -2, right: 3, top: 4 },
                  advance: 5,
                },
              ],
              fieldRange: 6,
            };
          },
          async dispose() {},
        };
      },
    });
    const base = {
      family: "Fixture",
      fontRevision: font.revision,
      glyphId: 65,
      glyphText: "A",
      fontSize: 32,
    } as const;

    const alpha = await provider.rasterize({ ...base, mode: "alpha" });
    const color = await provider.rasterize({ ...base, mode: "color" });
    const msdf = await provider.rasterize({ ...base, mode: "msdf" });
    const sdf = await provider.rasterize({ ...base, mode: "sdf" });
    expect(await provider.rasterize({ ...base, mode: "msdf" })).toBe(msdf);

    expect(alpha.pixels).toEqual(new Uint8Array([7, 7]));
    expect(color.pixels).toEqual(new Uint8Array(8).fill(7));
    expect(msdf.pixels).toEqual(new Uint8Array([10, 20, 30, 255, 100, 50, 0, 255]));
    expect(sdf.pixels).toEqual(new Uint8Array([20, 50]));
    expect(msdf.metrics).toEqual({ bearingX: 1, bearingY: 4, advance: 5, fieldRange: 6 });
    expect({ canvasCalls, generatorStarts, generatorCalls }).toEqual({
      canvasCalls: 2,
      generatorStarts: 1,
      generatorCalls: 2,
    });

    registry.unregister("Fixture");
    await registry.register({ family: "Fixture", source: new Uint8Array([3]) });
    expect(provider.rasterize({ ...base, mode: "alpha" })).rejects.toThrow(RangeError);

    await provider.destroy();
    registry.destroy();
  });

  test("validates dynamic request identities before raster work", async () => {
    const registry = new FontRegistry();
    const provider = new RasterGlyphProvider(registry, {
      canvasRasterizer: async () => {
        throw new Error("unreachable");
      },
    });
    const invalid = {
      family: "Missing",
      fontRevision: 1,
      glyphId: 1,
      glyphText: "A",
      fontSize: 16,
      mode: "alpha",
    } satisfies RasterGlyphRequest;

    expect(provider.rasterize(invalid)).rejects.toThrow(RangeError);
    await provider.destroy();
    registry.destroy();
  });

  test("serializes atlas generation within each MSDF worker", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "Fixture", source: new Uint8Array([1, 2]) });
    let active = 0;
    let maximumActive = 0;
    const charsets: string[] = [];
    const provider = new RasterGlyphProvider(registry, {
      generatorConcurrency: 1,
      async createMsdfGenerator() {
        return {
          async generateAtlas(options) {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            const charset = String(options.charset);
            charsets.push(charset);
            await Bun.sleep(5);
            active -= 1;
            return {
              texture: {
                width: 1,
                height: 1,
                data: new Uint8ClampedArray([255, 255, 255, 255]),
              },
              glyphs: [
                {
                  char: charset,
                  atlasPosition: [0, 0],
                  atlasSize: [1, 1],
                  bounds: { left: 0, bottom: 0, right: 1, top: 1 },
                  advance: 1,
                },
              ],
              fieldRange: 4,
            };
          },
          async dispose() {},
        };
      },
    });
    const base = {
      family: "Fixture",
      fontRevision: font.revision,
      fontSize: 16,
      mode: "msdf",
    } as const;

    await Promise.all([
      provider.rasterize({ ...base, glyphId: 65, glyphText: "A" }),
      provider.rasterize({ ...base, glyphId: 66, glyphText: "B" }),
    ]);

    expect(maximumActive).toBe(1);
    expect(charsets).toEqual(["A", "B"]);
    await provider.destroy();
    registry.destroy();
  });

  test("keys canvas glyphs by the complete multilingual font stack", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "System UI" });
    const requests: RasterGlyphRequest[] = [];
    const provider = new RasterGlyphProvider(registry, {
      canvasRasterizer(request): Promise<GlyphRaster> {
        requests.push(request);
        return Promise.resolve({
          mode: request.mode,
          width: 1,
          height: 1,
          pixels: new Uint8Array([255]),
        });
      },
    });
    const base = {
      family: "System UI",
      fontRevision: font.revision,
      glyphId: 28_050,
      glyphText: "漢",
      fontSize: 24,
      mode: "alpha",
    } as const;
    const cjkvStack = ["System UI", "Noto Sans CJK SC", "sans-serif"] as const;

    const first = await provider.rasterize({ ...base, fontFamilies: cjkvStack });
    expect(await provider.rasterize({ ...base, fontFamilies: cjkvStack })).toBe(first);
    await provider.rasterize({ ...base, fontFamilies: ["System UI", "sans-serif"] });

    expect(requests.map((request) => request.fontFamilies)).toEqual([
      cjkvStack,
      ["System UI", "sans-serif"],
    ]);
    expect(
      provider.rasterize({ ...base, fontFamilies: ["sans-serif", "System UI"] }),
    ).rejects.toThrow(TypeError);

    await provider.destroy();
    registry.destroy();
  });
});
