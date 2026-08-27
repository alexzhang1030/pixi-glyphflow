import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FontRegistry } from "../src";
import { RasterGlyphProvider } from "../src/advanced";
import { TINY_SDF_RADIUS } from "../src/atlas/tinySdf";
import {
  charsetSdfPrebuilt,
  mergePrebuilt,
  uniqueInkCharset,
  type CharsetSdfPaint,
} from "../src/prebuilt";

const projectRoot = resolve(import.meta.dir, "..");

describe("charsetSdfPrebuilt", () => {
  test("skips empty-ink scalars and remaps keys on a later bake", async () => {
    let paints = 0;
    const first = await charsetSdfPrebuilt({
      family: "Noto",
      charset: "上 海\u200b字",
      fontSize: 14,
      fontWeight: "500",
      rasterize: (request) => {
        paints += 1;
        return paint(request.glyphText);
      },
    });
    const second = await charsetSdfPrebuilt({
      family: "Noto",
      charset: "字上海",
      fontSize: 14,
      fontWeight: "500",
      rasterize: () => {
        throw new Error("memoized bake must not paint again");
      },
    });

    expect(uniqueInkCharset("上 海\u200b字")).toBe("上海字");
    expect(paints).toBe(3);
    expect(first.glyphs).toHaveLength(3);
    expect(second.glyphs).toHaveLength(3);
    expect(first.pages).toHaveLength(1);
    expect(first.pages[0]?.pixels).toBe(second.pages[0]?.pixels);
    expect(first.glyphs[0]?.key).toBe(second.glyphs[0]?.key);
    expect(first.glyphs[0]?.metrics).toMatchObject({
      fieldRange: TINY_SDF_RADIUS / (48 / 14),
      rasterScale: 48 / 14,
    });
  });

  test("serves a HarfBuzz-style CJK miss as a crop", async () => {
    const pages = await charsetSdfPrebuilt({
      family: "CJK",
      charset: "上",
      fontSize: 14,
      rasterize: () => paint("上"),
    });
    const registry = new FontRegistry();
    const font = await registry.register({ family: "CJK", source: new Uint8Array([1, 2]) });
    let canvasCalls = 0;
    const provider = new RasterGlyphProvider(registry, {
      prebuilt: pages,
      distanceFieldMinFontSize: 48,
      canvasRasterizer() {
        canvasCalls += 1;
        throw new Error("canvas must not run for a charsetSdf hit");
      },
      async createMsdfGenerator() {
        throw new Error("MSDF generator must not start for a charsetSdf hit");
      },
    });

    const raster = await provider.rasterize({
      family: "CJK",
      fontRevision: font.revision,
      glyphId: 842,
      glyphText: "上",
      fontSize: 14,
      mode: "sdf",
    });

    expect(raster.mode).toBe("sdf");
    expect(raster.width).toBe(8);
    expect(raster.height).toBe(8);
    expect(raster.metrics?.rasterScale).toBe(48 / 14);
    expect(canvasCalls).toBe(0);
    expect(provider.stats).toMatchObject({
      prebuiltHits: 1,
      tinySdfRasters: 0,
      distanceFieldRasters: 0,
    });

    await provider.destroy();
    registry.destroy();
  });

  test("merges family pages and stays out of the core graph", async () => {
    const first = await charsetSdfPrebuilt({
      family: "CJK",
      charset: "上",
      fontSize: 14,
      rasterize: () => paint("上"),
    });
    const second = await charsetSdfPrebuilt({
      family: "Arab",
      charset: "ع",
      fontSize: 14,
      rasterize: () => paint("ع"),
    });
    const merged = mergePrebuilt(first, second);
    expect(merged.pages).toHaveLength(2);
    expect(merged.glyphs).toHaveLength(2);
    expect(() => mergePrebuilt(first, first)).toThrow(RangeError);

    const [root, advanced] = await Promise.all([
      readFile(resolve(projectRoot, "src/index.ts"), "utf8"),
      readFile(resolve(projectRoot, "src/advanced/index.ts"), "utf8"),
    ]);
    expect(root).not.toContain("charsetSdf");
    expect(root).not.toContain("prebuilt/");
    expect(advanced).not.toContain("charsetSdf");
    expect(advanced).not.toContain("../prebuilt");

    const distEntry = resolve(projectRoot, "dist/index.js");
    if (await Bun.file(distEntry).exists()) {
      const graph = await readStaticJsGraph(distEntry);
      expect(graph).not.toContain("charsetSdf");
      expect(graph).not.toContain("charset-sdf-");
    }
  });
});

function paint(_glyphText: string): CharsetSdfPaint {
  const pixels = new Uint8Array(64);
  pixels[28] = 255;
  pixels[29] = 255;
  pixels[36] = 255;
  return {
    width: 8,
    height: 8,
    pixels,
    bearingX: 0,
    bearingY: 6,
    advance: 7,
  };
}

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
