import { describe, expect, test } from "bun:test";

import { PrebuiltGlyphProvider, prebuiltGlyphKey } from "../src/atlas/PrebuiltGlyphProvider";
import { RasterGlyphProvider } from "../src/atlas/RasterGlyphProvider";
import type {
  GlyphMode,
  GlyphRaster,
  MsdfAtlasLike,
  RasterGlyphProviderOptions,
  RasterGlyphRequest,
} from "../src/atlas/types";
import { FontRegistry } from "../src/FontRegistry";

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
    expect(provider.stats).toEqual({
      glyphs: 4,
      pages: 4,
      cacheEntries: 4,
      cacheBytes: 40,
      cacheEvictions: 0,
      cacheEvictedBytes: 0,
      hits: 4,
      misses: 4,
    });

    provider.destroy();
  });

  test("bounds materialized prebuilt rasters with observable LRU eviction", () => {
    const provider = new PrebuiltGlyphProvider({
      materializationCacheEntries: 2,
      materializationCacheBytes: 64,
      materializationCachePolicy: "lru",
      pages: [
        {
          id: "page",
          mode: "alpha",
          width: 3,
          height: 1,
          pixels: new Uint8Array([1, 2, 3]),
        },
      ],
      glyphs: ["A", "B", "C"].map((key, x) => ({
        key,
        pageId: "page",
        x,
        y: 0,
        width: 1,
        height: 1,
      })),
    });

    const firstA = provider.lookup("A");
    const firstB = provider.lookup("B");
    expect(provider.lookup("A")).toBe(firstA);
    provider.lookup("C");

    expect(provider.stats).toMatchObject({
      cacheEntries: 2,
      cacheBytes: 2,
      cacheEvictions: 1,
      cacheEvictedBytes: 1,
      hits: 1,
      misses: 3,
    });
    expect(provider.lookup("A")).toBe(firstA);
    expect(provider.lookup("B")).not.toBe(firstB);
    expect(provider.stats.cacheEntries).toBe(2);

    provider.destroy();
  });

  test("keeps NUL-bearing prebuilt tuples distinct on exact lookup", () => {
    const firstKey = prebuiltGlyphKey({
      family: "Fixture\u00001",
      glyphId: 2,
      glyphText: "A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "alpha",
    });
    const secondKey = prebuiltGlyphKey({
      family: "Fixture",
      glyphId: 1,
      glyphText: "2\u0000A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "alpha",
    });

    expect(firstKey).not.toBe(secondKey);

    const provider = new PrebuiltGlyphProvider({
      pages: [
        { id: "first", mode: "alpha", width: 1, height: 1, pixels: new Uint8Array([11]) },
        { id: "second", mode: "alpha", width: 1, height: 1, pixels: new Uint8Array([22]) },
      ],
      glyphs: [
        { key: firstKey, pageId: "first", x: 0, y: 0, width: 1, height: 1 },
        { key: secondKey, pageId: "second", x: 0, y: 0, width: 1, height: 1 },
      ],
    });

    expect(provider.lookup(firstKey)?.pixels).toEqual(new Uint8Array([11]));
    expect(provider.lookup(secondKey)?.pixels).toEqual(new Uint8Array([22]));
    provider.destroy();
  });

  test("resolves legacy NUL-delimited prebake keys through the v2 lookup", () => {
    const request = {
      family: "Fixture",
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "alpha",
    } as const;
    const legacyKey = ["Fixture", "65", "A", "16", "normal", "alpha"].join("\u0000");
    const pixels = new Uint8Array([31]);
    const provider = new PrebuiltGlyphProvider({
      pages: [{ id: "legacy", mode: "alpha", width: 1, height: 1, pixels }],
      glyphs: [{ key: legacyKey, pageId: "legacy", x: 0, y: 0, width: 1, height: 1 }],
    });

    expect(prebuiltGlyphKey(request)).toBe(
      "pixi-glyphflow/prebuilt/v2:7:Fixture2:651:A2:166:normal5:alpha",
    );
    const fromV2 = provider.lookup(prebuiltGlyphKey(request));
    expect(fromV2?.pixels).toBe(pixels);
    expect(provider.lookup(legacyKey)).toBe(fromV2);
    provider.destroy();
  });

  test("resolves a prefix-family legacy prebake through the v2 lookup", () => {
    const request = {
      family: "pixi-glyphflow/prebuilt/v2:Fixture",
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "alpha",
    } as const;
    const legacyKey = [
      request.family,
      String(request.glyphId),
      request.glyphText,
      String(request.fontSize),
      request.fontWeight,
      request.mode,
    ].join("\u0000");
    const pixels = new Uint8Array([41]);
    const provider = new PrebuiltGlyphProvider({
      pages: [{ id: "legacy-prefix", mode: "alpha", width: 1, height: 1, pixels }],
      glyphs: [{ key: legacyKey, pageId: "legacy-prefix", x: 0, y: 0, width: 1, height: 1 }],
    });

    expect(provider.lookup(prebuiltGlyphKey(request))?.pixels).toBe(pixels);
    provider.destroy();
  });

  test("keeps malformed v2 keys with non-six-field tuples out of canonical aliases", () => {
    const tooFewRequest = {
      family: "Fixture",
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "alpha",
    } as const;
    const tooManyRequest = { ...tooFewRequest, glyphId: 66, glyphText: "B" } as const;
    const tooFew = "pixi-glyphflow/prebuilt/v2:7:Fixture2:651:A2:166:normal";
    const tooMany = `${prebuiltGlyphKey(tooManyRequest)}5:extra`;
    const fewPixels = new Uint8Array([51]);
    const manyPixels = new Uint8Array([52]);
    const provider = new PrebuiltGlyphProvider({
      pages: [
        { id: "too-few", mode: "alpha", width: 1, height: 1, pixels: fewPixels },
        { id: "too-many", mode: "alpha", width: 1, height: 1, pixels: manyPixels },
      ],
      glyphs: [
        { key: tooFew, pageId: "too-few", x: 0, y: 0, width: 1, height: 1 },
        { key: tooMany, pageId: "too-many", x: 0, y: 0, width: 1, height: 1 },
      ],
    });

    expect(provider.lookup(tooFew)?.pixels).toBe(fewPixels);
    expect(provider.lookup(tooMany)?.pixels).toBe(manyPixels);
    expect(provider.lookup(prebuiltGlyphKey(tooFewRequest))).toBeUndefined();
    expect(provider.lookup(prebuiltGlyphKey(tooManyRequest))).toBeUndefined();
    provider.destroy();
  });

  test("keeps NUL-bearing identities distinct during physical-size rematch", () => {
    const first = {
      family: "Fixture\u00001",
      glyphId: 2,
      glyphText: "A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "msdf",
    } as const;
    const second = {
      family: "Fixture",
      glyphId: 1,
      glyphText: "2\u0000A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "msdf",
    } as const;
    const firstPixels = new Uint8Array([11, 11, 11, 255]);
    const secondPixels = new Uint8Array([22, 22, 22, 255]);
    const metrics = { bearingX: 1, bearingY: 2, advance: 3, fieldRange: 4, rasterScale: 3 };
    const provider = new PrebuiltGlyphProvider({
      pages: [
        { id: "first", mode: "msdf", width: 1, height: 1, pixels: firstPixels },
        { id: "second", mode: "msdf", width: 1, height: 1, pixels: secondPixels },
      ],
      glyphs: [
        {
          key: prebuiltGlyphKey(first),
          pageId: "first",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          metrics,
        },
        {
          key: prebuiltGlyphKey(second),
          pageId: "second",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          metrics,
        },
      ],
    });

    expect(provider.lookupPhysical({ ...first, fontSize: 32 }, 48)?.pixels).toBe(firstPixels);
    expect(provider.lookupPhysical({ ...second, fontSize: 32 }, 48)?.pixels).toBe(secondPixels);
    provider.destroy();
  });

  test("uses injected canvas and lazy MSDF boundaries with revisioned caching", async () => {
    let canvasCalls = 0;
    let generatorStarts = 0;
    let generatorCalls = 0;
    const { registry, font, provider } = await createRasterFixture({
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
    const base = rasterRequest(font.revision, { fontSize: 32 });

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

    await destroyRasterFixture(provider, registry);
  });

  test("oversamples small distance fields while preserving logical metrics", async () => {
    let generationOptions: Readonly<Record<string, unknown>> | undefined;
    const { registry, font, provider } = await createRasterFixture(
      {
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
      },
      { family: "CJK fixture", source: new Uint8Array([1, 2]) },
    );

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

    await destroyRasterFixture(provider, registry);
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
    await destroyRasterFixture(provider, registry);
  });

  test("isolates exact raster cache entries across variable-font axes", async () => {
    const registry = new FontRegistry();
    const seen: string[] = [];
    const provider = new RasterGlyphProvider(registry, {
      async canvasRasterizer(request) {
        seen.push(request.variationKey ?? "");
        return {
          mode: "alpha",
          width: 1,
          height: 1,
          pixels: new Uint8Array([seen.length]),
        };
      },
    });
    const base = rasterRequest(0, { fontWeight: "400" });

    const regular = await provider.rasterize({ ...base, variationKey: "wdth=100,wght=400" });
    const condensed = await provider.rasterize({ ...base, variationKey: "wdth=75,wght=400" });
    const regularAgain = await provider.rasterize({
      ...base,
      variationKey: "wdth=100,wght=400",
    });

    expect(seen).toEqual(["wdth=100,wght=400", "wdth=75,wght=400"]);
    expect(regular.pixels).toEqual(new Uint8Array([1]));
    expect(condensed.pixels).toEqual(new Uint8Array([2]));
    expect(regularAgain).toBe(regular);

    await destroyRasterFixture(provider, registry);
  });

  test("isolates raster cache entries across embedded tuple separators", async () => {
    const registry = new FontRegistry();
    const seen: Array<readonly [string, string]> = [];
    const provider = new RasterGlyphProvider(registry, {
      async canvasRasterizer(request) {
        seen.push([request.glyphText, request.variationKey ?? ""]);
        return {
          mode: "alpha",
          width: 1,
          height: 1,
          pixels: new Uint8Array([seen.length]),
        };
      },
    });
    const base = rasterRequest(0, { fontWeight: "400" });
    const firstRequest = { ...base, glyphText: "x\u0000y", variationKey: "z" };
    const secondRequest = { ...base, glyphText: "x", variationKey: "y\u0000z" };

    const [first, second] = await Promise.all([
      provider.rasterize(firstRequest),
      provider.rasterize(secondRequest),
    ]);
    const [firstAgain, secondAgain] = await Promise.all([
      provider.rasterize(firstRequest),
      provider.rasterize(secondRequest),
    ]);

    expect(seen).toEqual([
      ["x\u0000y", "z"],
      ["x", "y\u0000z"],
    ]);
    expect(first.pixels).toEqual(new Uint8Array([1]));
    expect(second.pixels).toEqual(new Uint8Array([2]));
    expect(firstAgain).toBe(first);
    expect(secondAgain).toBe(second);

    await destroyRasterFixture(provider, registry);
  });

  test("routes variable-axis requests through the dynamic path beside static prebuilt pages", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "Fixture" });
    const staticPixels = new Uint8Array([1]);
    let canvasCalls = 0;
    const request = rasterRequest(font.revision, { fontWeight: "normal" });
    const provider = new RasterGlyphProvider(registry, {
      prebuilt: {
        pages: [{ id: "static", mode: "alpha", width: 1, height: 1, pixels: staticPixels }],
        glyphs: [
          {
            key: prebuiltGlyphKey(request),
            pageId: "static",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
      async canvasRasterizer() {
        canvasCalls += 1;
        return { mode: "alpha", width: 1, height: 1, pixels: new Uint8Array([9]) };
      },
    });

    const variable = await provider.rasterize({ ...request, variationKey: "wght=700" });
    const staticRaster = await provider.rasterize(request);

    expect(variable.pixels).toEqual(new Uint8Array([9]));
    expect(staticRaster.pixels).toEqual(staticPixels);
    expect(canvasCalls).toBe(1);
    expect(provider.stats.prebuiltHits).toBe(1);

    await destroyRasterFixture(provider, registry);
  });

  test("isolates physical MSDF fields across variation axes and weight", async () => {
    let generatorCalls = 0;
    const { registry, font, provider } = await createRasterFixture({
      generatorConcurrency: 1,
      async createMsdfGenerator() {
        return {
          async generateAtlas() {
            generatorCalls += 1;
            return {
              texture: {
                width: 1,
                height: 1,
                data: new Uint8ClampedArray([10, 20, 30, 255]),
              },
              glyphs: [
                {
                  char: "A",
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
    const base = rasterRequest(font.revision, { fontSize: 32, mode: "msdf" });

    await provider.rasterize({
      ...base,
      fontWeight: "400",
      variationKey: "wdth=100,wght=400",
    });
    await provider.rasterize({
      ...base,
      fontWeight: "400",
      variationKey: "wdth=75,wght=400",
    });
    await provider.rasterize({
      ...base,
      fontWeight: "700",
      variationKey: "wdth=100,wght=700",
    });

    expect(generatorCalls).toBe(3);

    await destroyRasterFixture(provider, registry);
  });

  test("batches same-size MSDF misses into one generator pass and serializes each worker", async () => {
    let active = 0;
    let maximumActive = 0;
    const charsets: string[] = [];
    const { registry, font, provider } = await createRasterFixture({
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
    const base = rasterRequest(font.revision, { mode: "msdf" });

    const rasters = await Promise.all([
      provider.rasterize({ ...base, fontSize: 48, glyphId: 65, glyphText: "A" }),
      provider.rasterize({ ...base, fontSize: 48, glyphId: 66, glyphText: "B" }),
      provider.rasterize({ ...base, fontSize: 96, glyphId: 67, glyphText: "C" }),
    ]);

    expect(maximumActive).toBe(1);
    expect(charsets).toEqual(["AB", "C"]);
    expect(rasters[0]?.metrics?.bearingX).toBe(0);
    expect(rasters[1]?.metrics?.bearingX).toBeGreaterThan(0);
    await destroyRasterFixture(provider, registry);
  });

  test("serves prebuilt pages before TinySDF or MSDF generation", async () => {
    const registry = new FontRegistry();
    const font = await registry.register({ family: "Fixture", source: new Uint8Array([1, 2]) });
    const request = rasterRequest(font.revision, { mode: "msdf" });
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

    await destroyRasterFixture(provider, registry);
  });

  test("rematches a prebuilt field across clamp-equivalent logical sizes", async () => {
    const pixels = new Uint8Array([9, 8, 7, 255]);
    let generatorStarts = 0;
    const { registry, font, provider } = await createRasterFixture({
      distanceFieldMinFontSize: 48,
      prebuilt: {
        pages: [{ id: "latin", mode: "msdf", width: 1, height: 1, pixels }],
        glyphs: [
          {
            key: prebuiltGlyphKey({
              family: "Fixture",
              glyphId: 0,
              glyphText: "A",
              fontSize: 16,
              fontWeight: "normal",
              mode: "msdf",
            }),
            pageId: "latin",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            metrics: {
              bearingX: 1,
              bearingY: 4,
              advance: 5,
              fieldRange: 2,
              rasterScale: 3,
            },
          },
        ],
      },
      async createMsdfGenerator() {
        generatorStarts += 1;
        throw new Error("MSDF generator must not start for a clamp-size prebuilt rematch");
      },
    });
    const base = rasterRequest(font.revision, { mode: "msdf" });

    const thirtyTwo = await provider.rasterize({ ...base, fontSize: 32 });
    const sixteen = await provider.rasterize({ ...base, fontSize: 16 });
    expect(thirtyTwo.pixels).toBe(sixteen.pixels);
    expect(thirtyTwo.pixels).toEqual(pixels);
    expect(thirtyTwo.metrics).toMatchObject({
      rasterScale: 1.5,
      bearingX: 2,
      bearingY: 8,
      advance: 10,
    });
    expect(sixteen.metrics).toMatchObject({
      rasterScale: 3,
      bearingX: 1,
      bearingY: 4,
      advance: 5,
    });
    expect(generatorStarts).toBe(0);
    expect(provider.stats).toMatchObject({
      prebuiltHits: 1,
      distanceFieldRasters: 0,
    });

    await destroyRasterFixture(provider, registry);
  });

  test("retries a single-scalar prebuilt miss with glyphId 0", async () => {
    const pixels = new Uint8Array([11, 12, 13, 255]);
    const ligaturePixels = new Uint8Array([21, 22, 23, 255]);
    const pageKey = prebuiltGlyphKey({
      family: "Fixture",
      glyphId: 0,
      glyphText: "A",
      fontSize: 16,
      fontWeight: "normal",
      mode: "msdf",
    });
    const ligatureKey = prebuiltGlyphKey({
      family: "Fixture",
      glyphId: 0,
      glyphText: "fi",
      fontSize: 16,
      fontWeight: "normal",
      mode: "msdf",
    });
    let generatorStarts = 0;
    let generatedCharset = "";
    const { registry, font, provider } = await createRasterFixture({
      prebuilt: {
        pages: [
          { id: "latin", mode: "msdf", width: 1, height: 1, pixels },
          { id: "liga", mode: "msdf", width: 1, height: 1, pixels: ligaturePixels },
        ],
        glyphs: [
          {
            key: pageKey,
            pageId: "latin",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            metrics: { bearingX: 0, bearingY: 1, advance: 2, fieldRange: 4 },
          },
          {
            key: ligatureKey,
            pageId: "liga",
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
        return {
          async generateAtlas(options) {
            generatedCharset = String(options.charset);
            return {
              texture: {
                width: 1,
                height: 1,
                data: new Uint8ClampedArray([10, 20, 30, 255]),
              },
              glyphs: [
                {
                  char: "fi",
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

    const raster = await provider.rasterize({
      family: "Fixture",
      fontRevision: font.revision,
      glyphId: 65,
      glyphText: "A",
      fontSize: 16,
      mode: "msdf",
    });
    expect(raster.pixels).toEqual(pixels);
    expect(generatorStarts).toBe(0);
    expect(provider.stats).toMatchObject({
      prebuiltHits: 1,
      distanceFieldRasters: 0,
      tinySdfRasters: 0,
    });

    const ligature = await provider.rasterize({
      family: "Fixture",
      fontRevision: font.revision,
      glyphId: 256,
      glyphText: "fi",
      fontSize: 16,
      mode: "msdf",
    });
    expect(ligature.mode).toBe("msdf");
    expect(ligature.pixels).not.toEqual(ligaturePixels);
    expect(generatedCharset).toBe("fi");
    expect(generatorStarts).toBe(1);
    expect(provider.stats).toMatchObject({
      prebuiltHits: 1,
      distanceFieldRasters: 1,
    });

    await destroyRasterFixture(provider, registry);
  });

  test("builds an SDF from the canvas mask without starting the MSDF generator", async () => {
    let generatorStarts = 0;
    const alpha = new Uint8Array(8 * 8);
    alpha.fill(255, 16, 48);
    const { registry, font, provider } = await createRasterFixture(
      {
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
      },
      { family: "System UI" },
    );

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

    await destroyRasterFixture(provider, registry);
  });

  test("batches same-size TinySDF misses and serializes canvas rasters", async () => {
    let canvasCalls = 0;
    const gates: Array<(raster: GlyphRaster) => void> = [];
    const { registry, font, provider } = await createRasterFixture(
      {
        canvasRasterizer(): Promise<GlyphRaster> {
          canvasCalls += 1;
          return new Promise((resolve) => {
            gates.push(resolve);
          });
        },
        async createMsdfGenerator() {
          throw new Error("MSDF generator must not start for TinySDF");
        },
      },
      { family: "System UI" },
    );
    const base = rasterRequest(font.revision, { family: "System UI", mode: "sdf" });
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

    await destroyRasterFixture(provider, registry);
  });

  test("interns one TinySDF field for logical sizes that clamp to the same physical size", async () => {
    let canvasCalls = 0;
    const alpha = {
      mode: "alpha" as const,
      width: 8,
      height: 8,
      pixels: new Uint8Array(64).fill(255),
      metrics: { bearingX: 3, bearingY: 6, advance: 8 },
    };
    const { registry, font, provider } = await createRasterFixture(
      {
        canvasRasterizer(): Promise<GlyphRaster> {
          canvasCalls += 1;
          return Promise.resolve(alpha);
        },
        async createMsdfGenerator() {
          throw new Error("MSDF generator must not start for TinySDF");
        },
      },
      { family: "System UI" },
    );
    const base = rasterRequest(font.revision, { family: "System UI", mode: "sdf" });

    const sixteen = await provider.rasterize({ ...base, fontSize: 16 });
    const thirtyTwo = await provider.rasterize({ ...base, fontSize: 32 });
    const otherId = await provider.rasterize({ ...base, fontSize: 16, glyphId: 99 });
    const sixtyFour = await provider.rasterize({ ...base, fontSize: 64 });
    const [bSixteen, bThirtyTwo] = await Promise.all([
      provider.rasterize({ ...base, glyphId: 66, glyphText: "B", fontSize: 16 }),
      provider.rasterize({ ...base, glyphId: 66, glyphText: "B", fontSize: 32 }),
    ]);

    expect(sixteen.pixels).toBe(thirtyTwo.pixels);
    expect(sixteen.pixels).toBe(otherId.pixels);
    expect(sixtyFour.pixels).not.toBe(sixteen.pixels);
    expect(bSixteen.pixels).toBe(bThirtyTwo.pixels);
    expect(bSixteen.pixels).not.toBe(sixteen.pixels);
    expect(sixteen.metrics).toMatchObject({
      bearingX: 1,
      bearingY: 2,
      advance: 8 / 3,
      fieldRange: 8 / 3,
      rasterScale: 3,
    });
    expect(thirtyTwo.metrics).toMatchObject({
      bearingX: 2,
      bearingY: 4,
      advance: 8 / 1.5,
      fieldRange: 8 / 1.5,
      rasterScale: 1.5,
    });
    expect(canvasCalls).toBe(3);
    expect(provider.stats).toMatchObject({ tinySdfRasters: 3, canvasRasters: 3 });

    await destroyRasterFixture(provider, registry);
  });

  test("interns one MSDF field for logical sizes that clamp to the same physical size", async () => {
    let generatorCalls = 0;
    const { registry, font, provider } = await createRasterFixture({
      generatorConcurrency: 1,
      async createMsdfGenerator() {
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
                  bounds: { left: 3, bottom: -2, right: 9, top: 12 },
                  advance: 15,
                },
              ],
              fieldRange: 6,
            };
          },
          async dispose() {},
        };
      },
    });
    const base = rasterRequest(font.revision, { mode: "msdf" });

    const sixteen = await provider.rasterize({ ...base, fontSize: 16 });
    const thirtyTwo = await provider.rasterize({ ...base, fontSize: 32 });

    expect(sixteen.pixels).toBe(thirtyTwo.pixels);
    expect(sixteen.metrics).toMatchObject({ rasterScale: 3, bearingX: 1, bearingY: 4, advance: 5 });
    expect(thirtyTwo.metrics).toMatchObject({
      rasterScale: 1.5,
      bearingX: 2,
      bearingY: 8,
      advance: 10,
    });
    expect(generatorCalls).toBe(1);
    expect(provider.stats.distanceFieldRasters).toBe(1);

    await destroyRasterFixture(provider, registry);
  });

  test("keys canvas glyphs by the complete multilingual font stack", async () => {
    const requests: RasterGlyphRequest[] = [];
    const { registry, font, provider } = await createRasterFixture(
      {
        canvasRasterizer(request): Promise<GlyphRaster> {
          requests.push(request);
          return Promise.resolve({
            mode: request.mode,
            width: 1,
            height: 1,
            pixels: new Uint8Array([255]),
          });
        },
      },
      { family: "System UI" },
    );
    const base = rasterRequest(font.revision, {
      family: "System UI",
      glyphId: 28_050,
      glyphText: "漢",
      fontSize: 24,
    });
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

    await destroyRasterFixture(provider, registry);
  });

  test("detaches synchronously and completes every teardown after simultaneous faults", async () => {
    const registry = new FontRegistry();
    const firstFace = await registry.register({
      family: "Destroy face A",
      source: new Uint8Array([1, 2]),
    });
    const secondFace = await registry.register({
      family: "Destroy face B",
      source: new Uint8Array([3, 4]),
    });
    const msdfFont = await registry.register({
      family: "Destroy MSDF",
      source: new Uint8Array([5, 6]),
    });
    const prebuiltError = new Error("prebuilt teardown failed");
    const faceError = new Error("first face deletion failed");
    const tailError = new Error("active generator tail failed");
    const factoryError = new Error("active generator factory failed");
    const firstDisposeError = new Error("first generator disposal failed");
    const secondDisposeError = new Error("second generator disposal failed");
    const tailGate = deferred<void>();
    const factoryGate = deferred<void>();
    const cleanupEvents: string[] = [];
    const disposeCalls = new Map<number, number>();
    let factoryStarts = 0;

    const previousFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPrebuiltDestroy = PrebuiltGlyphProvider.prototype.destroy;
    class FixtureFontFace {
      constructor(readonly family: string) {}
      async load(): Promise<this> {
        return this;
      }
    }
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      value: FixtureFontFace,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        fonts: {
          add() {},
          delete(face: FixtureFontFace) {
            cleanupEvents.push(`face:${face.family}`);
            if (face.family === "Destroy face A") throw faceError;
            return true;
          },
        },
      },
    });
    PrebuiltGlyphProvider.prototype.destroy = function destroyWithFault(): void {
      cleanupEvents.push("prebuilt");
      throw prebuiltError;
    };

    const provider = new RasterGlyphProvider(registry, {
      generatorConcurrency: 5,
      prebuilt: { pages: [], glyphs: [] },
      canvasRasterizer: async () => ({
        mode: "alpha",
        width: 1,
        height: 1,
        pixels: new Uint8Array([255]),
      }),
      async createMsdfGenerator() {
        const index = factoryStarts;
        factoryStarts += 1;
        if (index === 1) {
          await factoryGate.promise;
          throw factoryError;
        }
        return {
          async generateAtlas(options) {
            if (index === 0) {
              await tailGate.promise;
              throw tailError;
            }
            return msdfAtlasFor(options);
          },
          async dispose() {
            disposeCalls.set(index, (disposeCalls.get(index) ?? 0) + 1);
            cleanupEvents.push(`dispose:${String(index)}`);
            if (index === 2) throw firstDisposeError;
            if (index === 3) throw secondDisposeError;
          },
        };
      },
    });

    try {
      await provider.rasterize({
        family: "Destroy face A",
        fontRevision: firstFace.revision,
        glyphId: 65,
        glyphText: "A",
        fontSize: 16,
        mode: "sdf",
      });
      await provider.rasterize({
        family: "Destroy face B",
        fontRevision: secondFace.revision,
        glyphId: 66,
        glyphText: "B",
        fontSize: 16,
        mode: "sdf",
      });

      const rasters = [48, 64, 80, 96, 112].map((fontSize, index) =>
        provider.rasterize({
          family: "Destroy MSDF",
          fontRevision: msdfFont.revision,
          glyphId: 65 + index,
          glyphText: String.fromCodePoint(65 + index),
          fontSize,
          mode: "msdf",
        }),
      );
      await waitFor(() => factoryStarts === 5, "five live generator factories");

      const destruction = provider.destroy();
      void destruction.catch(() => undefined);
      expect(provider.stats).toMatchObject({ cacheEntries: 0, pending: 0 });
      await expect(
        provider.rasterize({
          family: "Destroy face A",
          fontRevision: firstFace.revision,
          glyphId: 67,
          glyphText: "C",
          fontSize: 16,
          mode: "alpha",
        }),
      ).rejects.toThrow("RasterGlyphProvider has been destroyed");

      tailGate.reject(tailError);
      factoryGate.reject(factoryError);
      const rasterResults = await Promise.allSettled(rasters);

      expect(rasterResults[0]).toEqual({ status: "rejected", reason: tailError });
      expect(rasterResults[1]).toEqual({ status: "rejected", reason: factoryError });
      expect(rasterResults.slice(2).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
        "rejected",
      ]);
      await expect(destruction).rejects.toBe(prebuiltError);
      expect(provider.destroy()).toBe(destruction);
      expect(cleanupEvents).toEqual([
        "prebuilt",
        "face:Destroy face A",
        "face:Destroy face B",
        "dispose:0",
        "dispose:2",
        "dispose:3",
        "dispose:4",
      ]);
      expect([...disposeCalls]).toEqual([
        [0, 1],
        [2, 1],
        [3, 1],
        [4, 1],
      ]);
    } finally {
      tailGate.resolve();
      factoryGate.resolve();
      PrebuiltGlyphProvider.prototype.destroy = originalPrebuiltDestroy;
      restoreGlobal("FontFace", previousFontFace);
      restoreGlobal("document", previousDocument);
      registry.destroy();
    }
  });

  test("rolls back a generator whose initialization and disposal both fail", async () => {
    const initializeError = new Error("generator initialization failed");
    const disposeError = new Error("failed generator disposal failed");
    let factoryStarts = 0;
    let failedGeneratorDisposals = 0;
    let successfulGeneratorDisposals = 0;
    const { registry, font, provider } = await createRasterFixture(
      {
        generatorConcurrency: 2,
        async createMsdfGenerator() {
          const index = factoryStarts;
          factoryStarts += 1;
          if (index === 0) {
            return {
              async initialize() {
                throw initializeError;
              },
              async generateAtlas(options) {
                return msdfAtlasFor(options);
              },
              async dispose() {
                failedGeneratorDisposals += 1;
                throw disposeError;
              },
            };
          }
          return {
            async generateAtlas(options) {
              return msdfAtlasFor(options);
            },
            async dispose() {
              successfulGeneratorDisposals += 1;
            },
          };
        },
      },
      { family: "Init fixture", source: new Uint8Array([1, 2]) },
    );
    const base = rasterRequest(font.revision, { family: "Init fixture", mode: "msdf" });

    const rasterResults = await Promise.allSettled([
      provider.rasterize({ ...base, fontSize: 48 }),
      provider.rasterize({ ...base, fontSize: 64 }),
    ]);
    expect(rasterResults[0]).toEqual({ status: "rejected", reason: initializeError });
    expect(rasterResults[1]?.status).toBe("fulfilled");

    const destruction = provider.destroy();
    await expect(destruction).rejects.toBe(initializeError);
    expect(provider.destroy()).toBe(destruction);
    expect(failedGeneratorDisposals).toBe(1);
    expect(successfulGeneratorDisposals).toBe(1);
    expect(provider.destroy()).toBe(destruction);
    registry.destroy();
  });
});

async function createRasterFixture(
  options: RasterGlyphProviderOptions,
  registration: Parameters<FontRegistry["register"]>[0] = {
    family: "Fixture",
    source: new Uint8Array([1, 2]),
  },
) {
  const registry = new FontRegistry();
  const font = await registry.register(registration);
  const provider = new RasterGlyphProvider(registry, options);
  return { registry, font, provider };
}

async function destroyRasterFixture(
  provider: RasterGlyphProvider,
  registry: FontRegistry,
): Promise<void> {
  await provider.destroy();
  registry.destroy();
}

function rasterRequest(
  fontRevision: number,
  overrides: Partial<RasterGlyphRequest> = {},
): RasterGlyphRequest {
  return {
    family: "Fixture",
    fontRevision,
    glyphId: 65,
    glyphText: "A",
    fontSize: 16,
    mode: "alpha",
    ...overrides,
  };
}

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

function msdfAtlasFor(options: Readonly<Record<string, unknown>>): MsdfAtlasLike {
  const charset = String(options.charset);
  return {
    texture: {
      width: charset.length,
      height: 1,
      data: new Uint8ClampedArray(charset.length * 4).fill(255),
    },
    glyphs: [...charset].map((char, index) => ({
      char,
      atlasPosition: [index, 0] as const,
      atlasSize: [1, 1] as const,
      bounds: { left: 0, bottom: 0, right: 1, top: 1 },
      advance: 1,
    })),
    fieldRange: 4,
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function restoreGlobal(
  name: "FontFace" | "document",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Object.defineProperty(globalThis, name, descriptor);
}
