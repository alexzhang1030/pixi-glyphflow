import { describe, expect, test } from "bun:test";

import { GlyphAtlas, type GlyphRaster } from "../src";

describe("GlyphAtlas", () => {
  test("publishes staged glyphs at frame boundaries and rejects stale generations", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    const stale = atlas.request("font:1:A");
    const current = atlas.request("font:1:A");

    expect(atlas.stage(stale, raster(4, 4, 1))).toBe(false);
    expect(atlas.stage(current, raster(4, 4, 2))).toBe(true);
    expect(atlas.get("font:1:A")).toBeUndefined();
    const commit = atlas.commitFrame();

    expect(commit.entries).toHaveLength(1);
    expect(commit.uploads).toHaveLength(1);
    expect(atlas.get("font:1:A")).toMatchObject({
      key: "font:1:A",
      generation: 2,
      page: 0,
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      mode: "alpha",
    });
    expect(atlas.stats).toMatchObject({ staleResults: 1, entries: 1, pages: 1 });

    atlas.destroy();
  });

  test("keeps the visible generation until its replacement commits", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    const first = atlas.request("glyph");
    atlas.stage(first, raster(4, 4, 1));
    atlas.commitFrame();
    const visible = atlas.get("glyph")!;
    const second = atlas.request("glyph");

    atlas.stage(second, raster(4, 4, 2));
    expect(atlas.get("glyph")).toBe(visible);
    atlas.commitFrame();
    expect(atlas.get("glyph")).toMatchObject({ generation: 2 });

    atlas.destroy();
  });

  test("evicts the least-recently-used unpinned entry within a fixed page budget", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    stageAndCommit(atlas, "A", raster(4, 8, 1));
    stageAndCommit(atlas, "B", raster(4, 8, 2));
    atlas.get("A");
    atlas.pin("A");

    const request = atlas.request("C");
    expect(atlas.stage(request, raster(4, 8, 3))).toBe(true);
    atlas.commitFrame();

    expect(atlas.get("A")).toBeDefined();
    expect(atlas.get("B")).toBeUndefined();
    expect(atlas.get("C")).toBeDefined();
    expect(atlas.stats).toMatchObject({ pages: 1, allocatedBytes: 64, evictions: 1 });

    atlas.destroy();
  });

  test("reports capacity pressure while every eviction candidate is pinned", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    stageAndCommit(atlas, "A", raster(8, 8, 1));
    atlas.pin("A");

    expect(atlas.stage(atlas.request("B"), raster(4, 4, 2))).toBe(false);
    expect(atlas.stats.capacityFailures).toBe(1);
    atlas.unpin("A");
    expect(atlas.stage(atlas.request("B"), raster(4, 4, 2))).toBe(true);

    atlas.destroy();
  });
});

function raster(width: number, height: number, value: number): GlyphRaster {
  return {
    mode: "alpha",
    width,
    height,
    pixels: new Uint8Array(width * height).fill(value),
  };
}

function stageAndCommit(atlas: GlyphAtlas, key: string, value: GlyphRaster): void {
  expect(atlas.stage(atlas.request(key), value)).toBe(true);
  atlas.commitFrame();
}
