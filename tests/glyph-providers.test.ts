import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src";
import {
  PrebuiltGlyphProvider,
  RasterGlyphProvider,
  prebuiltGlyphKey,
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
      distanceFieldMinFontSize: 32,
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
    expect(sdf.mode).toBe("sdf");
    expect(sdf.pixels).toHaveLength(2);
    expect(msdf.metrics).toEqual({ bearingX: 1, bearingY: 4, advance: 5, fieldRange: 6 });
    expect({ canvasCalls, generatorStarts, generatorCalls }).toEqual({
      canvasCalls: 3,
      generatorStarts: 1,
      generatorCalls: 1,
    });
    expect(provider.stats.tinySdfRasters).toBe(1);

    registry.unregister("Fixture");
    await registry.register({ family: "Fixture", source: new Uint8Array([3]) });
    expect(provider.rasterize({ ...base, mode: "alpha" })).rejects.toThrow(RangeError);

    await provider.destroy();
    registry.destroy();
  });

  test("oversamples small distance fields while preserving logical metrics", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "CJK fixture", source: new Uint8Array([1, 2]) });
    let generationOptions: Readonly<Record<string, unknown>> | undefined;
    const provider = new RasterGlyphProvider(registry, {
      generatorConcurrency: 1,
      async createMsdfGenerator() {
        return {
          async generateAtlas(options) {
            generationOptions = options;
            return {
              texture: {
                width: 64,
                height: 64,
                data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
              },
              glyphs: [
                {
                  char: "漢",
                  atlasPosition: [0, 0],
                  atlasSize: [24, 48],
                  bounds: { left: 3, bottom: -6, right: 27, top: 42 },
                  advance: 30,
                },
              ],
              fieldRange: 6,
            };
          },
          async dispose() {},
        };
      },
    });

    const raster = await provider.rasterize({
      family: "CJK fixture",
      fontRevision: font.revision,
      glyphId: 28_050,
      glyphText: "漢",
      fontSize: 16,
      mode: "msdf",
    });

    expect(generationOptions).toMatchObject({ fontSize: 48, textureSize: [128, 128] });
    expect(raster).toMatchObject({
      width: 24,
      height: 48,
      metrics: {
        bearingX: 1,
        bearingY: 14,
        advance: 10,
        fieldRange: 2,
        rasterScale: 3,
      },
    });

    await provider.destroy();
    registry.destroy();
  });

  test("validates dynamic request identities before raster work", async () => {
    const registry = new FontRegistry();
    expect(() => new RasterGlyphProvider(registry, { distanceFieldMinFontSize: 0 })).toThrow(
      TypeError,
    );
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

  test("batches same-size MSDF misses into one generator pass and serializes each worker", async () => {
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
                width: charset.length,
                height: 1,
                data: new Uint8ClampedArray(charset.length * 4).fill(255),
              },
              glyphs: [...charset].map((char, index) => ({
                char,
                atlasPosition: [index, 0] as [number, number],
                atlasSize: [1, 1] as [number, number],
                bounds: { left: index, bottom: 0, right: index + 1, top: 1 },
                advance: 1,
              })),
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
      mode: "msdf",
    } as const;

    const rasters = await Promise.all([
      provider.rasterize({ ...base, fontSize: 48, glyphId: 65, glyphText: "A" }),
      provider.rasterize({ ...base, fontSize: 48, glyphId: 66, glyphText: "B" }),
      provider.rasterize({ ...base, fontSize: 96, glyphId: 67, glyphText: "C" }),
    ]);

    expect(maximumActive).toBe(1);
    expect(charsets).toEqual(["AB", "C"]);
    expect(rasters[0]?.metrics?.bearingX).toBe(0);
    expect(rasters[1]?.metrics?.bearingX).toBeGreaterThan(0);
    await provider.destroy();
    registry.destroy();
  });

  test("serves prebuilt pages before TinySDF or MSDF generation", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "Fixture", source: new Uint8Array([1, 2]) });
    const request = {
      family: "Fixture",
      fontRevision: font.revision,
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      mode: "msdf" as const,
    };
    let generatorStarts = 0;
    const pixels = new Uint8Array([9, 8, 7, 255]);
    const provider = new RasterGlyphProvider(registry, {
      prebuilt: {
        pages: [{ id: "latin", mode: "msdf", width: 1, height: 1, pixels }],
        glyphs: [
          {
            key: prebuiltGlyphKey(request),
            pageId: "latin",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            metrics: { bearingX: 0, bearingY: 1, advance: 2, fieldRange: 4 },
          },
        ],
      },
      async createMsdfGenerator() {
        generatorStarts += 1;
        throw new Error("MSDF generator must not start for a prebuilt hit");
      },
    });

    const raster = await provider.rasterize(request);
    expect(raster.pixels).toEqual(pixels);
    expect(raster.metrics).toEqual({ bearingX: 0, bearingY: 1, advance: 2, fieldRange: 4 });
    expect(generatorStarts).toBe(0);
    expect(provider.stats).toMatchObject({
      prebuiltHits: 1,
      distanceFieldRasters: 0,
      tinySdfRasters: 0,
    });

    await provider.destroy();
    registry.destroy();
  });

  test("builds an SDF from the canvas mask without starting the MSDF generator", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "System UI" });
    let generatorStarts = 0;
    const alpha = new Uint8Array(8 * 8);
    alpha.fill(255, 16, 48);
    const provider = new RasterGlyphProvider(registry, {
      canvasRasterizer(): Promise<GlyphRaster> {
        return Promise.resolve({
          mode: "alpha",
          width: 8,
          height: 8,
          pixels: alpha,
          metrics: { bearingX: 1, bearingY: 6, advance: 8 },
        });
      },
      async createMsdfGenerator() {
        generatorStarts += 1;
        throw new Error("MSDF generator must not start for TinySDF");
      },
    });

    const raster = await provider.rasterize({
      family: "System UI",
      fontRevision: font.revision,
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      mode: "sdf",
    });

    expect(raster.mode).toBe("sdf");
    expect(raster.width).toBe(8);
    expect(raster.height).toBe(8);
    expect(raster.pixels[0]).toBeLessThan(128);
    expect(raster.pixels[28]).toBeGreaterThan(128);
    expect(raster.metrics).toMatchObject({
      bearingX: 1 / 3,
      bearingY: 2,
      advance: 8 / 3,
      fieldRange: 8 / 3,
      rasterScale: 3,
    });
    expect(generatorStarts).toBe(0);
    expect(provider.stats).toMatchObject({ tinySdfRasters: 1, distanceFieldRasters: 0 });

    await provider.destroy();
    registry.destroy();
  });

  test("batches same-size TinySDF misses and serializes canvas rasters", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "System UI" });
    let canvasCalls = 0;
    const gates: Array<(raster: GlyphRaster) => void> = [];
    const provider = new RasterGlyphProvider(registry, {
      canvasRasterizer(): Promise<GlyphRaster> {
        canvasCalls += 1;
        return new Promise((resolve) => {
          gates.push(resolve);
        });
      },
      async createMsdfGenerator() {
        throw new Error("MSDF generator must not start for TinySDF");
      },
    });
    const base = {
      family: "System UI",
      fontRevision: font.revision,
      fontSize: 16,
      mode: "sdf",
    } as const;
    const pending = Promise.all([
      provider.rasterize({ ...base, glyphId: 65, glyphText: "A" }),
      provider.rasterize({ ...base, glyphId: 66, glyphText: "B" }),
    ]);

    await waitForCanvasGate(gates, 1);
    expect(canvasCalls).toBe(1);

    const alpha = {
      mode: "alpha",
      width: 8,
      height: 8,
      pixels: new Uint8Array(64).fill(255),
      metrics: { bearingX: 1, bearingY: 6, advance: 8 },
    } satisfies GlyphRaster;
    gates[0]?.(alpha);
    await waitForCanvasGate(gates, 2);
    expect(canvasCalls).toBe(2);
    gates[1]?.(alpha);

    const rasters = await pending;
    expect(rasters[0]?.mode).toBe("sdf");
    expect(rasters[1]?.mode).toBe("sdf");
    expect(provider.stats).toMatchObject({
      tinySdfRasters: 2,
      canvasRasters: 2,
      distanceFieldRasters: 0,
    });

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

async function waitForCanvasGate(
  gates: ReadonlyArray<(raster: GlyphRaster) => void>,
  count: number,
): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (gates.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for TinySDF canvas gate ${String(count)}`);
}
