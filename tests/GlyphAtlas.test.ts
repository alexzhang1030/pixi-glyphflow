import { describe, expect, test } from "bun:test";

import {
  GlyphAtlas,
  type ExternalColorGlyphRaster,
  type GlyphCacheKey,
  type GlyphRaster,
} from "../src/advanced";
import {
  commitGlyphAtlasRenderFrame,
  requestGlyphAtlasRenderToken,
  stageGlyphAtlasRenderToken,
} from "../src/atlas/GlyphAtlas";

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
      layer: 0,
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      mode: "alpha",
    });
    expect(atlas.getPage(0)).toMatchObject({ id: 0, mode: "alpha", layer: 0 });
    expect(atlas.stats).toMatchObject({ staleResults: 1, entries: 1, pages: 1 });

    atlas.destroy();
  });

  test("keeps the visible generation until its replacement commits", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    const first = atlas.request("glyph");
    atlas.stage(first, raster(4, 4, 1));
    atlas.commitFrame();
    const visible = atlas.get("glyph");
    const second = atlas.request("glyph");

    atlas.stage(second, raster(4, 4, 2));
    expect(atlas.get("glyph")).toBe(visible);
    atlas.commitFrame();
    expect(atlas.get("glyph")).toMatchObject({ generation: 2 });

    atlas.destroy();
  });

  test("preserves per-key generation numbering while metadata remains retained", () => {
    const atlas = new GlyphAtlas({ requestGenerationCacheEntries: 4 });

    expect(atlas.request("A").generation).toBe(1);
    expect(atlas.request("B").generation).toBe(1);
    expect(atlas.request("A").generation).toBe(2);

    atlas.destroy();
  });

  test("drops a staged generation when a newer request supersedes it before commit", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    const staged = atlas.request("glyph");
    atlas.stage(staged, raster(2, 2, 1));
    const current = atlas.request("glyph");

    expect(atlas.commitFrame().entries).toHaveLength(0);
    expect(atlas.stats).toMatchObject({ pendingEntries: 0, staleResults: 1 });
    expect(atlas.stage(current, raster(2, 2, 2))).toBe(true);
    atlas.commitFrame();
    expect(atlas.get("glyph")).toMatchObject({ generation: current.generation });

    atlas.destroy();
  });

  test("keeps the visible entry in LRU order after a staged replacement becomes stale", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    stageAndCommit(atlas, "A", raster(4, 8, 1));
    stageAndCommit(atlas, "B", raster(4, 8, 2));
    atlas.get("A");
    const staged = atlas.request("A");
    atlas.stage(staged, raster(4, 8, 3));
    atlas.request("A");
    atlas.commitFrame();
    stageAndCommit(atlas, "C", raster(4, 8, 4));
    stageAndCommit(atlas, "D", raster(4, 8, 5));

    expect(atlas.get("A")).toBeUndefined();
    expect(atlas.get("C")).toBeDefined();
    expect(atlas.get("D")).toBeDefined();

    atlas.destroy();
  });

  test("keeps active, pending, and pinned generations outside the bounded tombstone cache", () => {
    const atlas = new GlyphAtlas({
      pageWidth: 8,
      pageHeight: 8,
      maxBytes: 64,
      requestGenerationCacheEntries: 2,
    });
    const active = atlas.request("active");
    atlas.stage(active, raster(2, 2, 1));
    atlas.commitFrame();
    const pending = atlas.request("pending");
    atlas.stage(pending, raster(2, 2, 2));
    const pinned = atlas.request("pinned");
    atlas.pin("pinned");

    for (let index = 0; index < 100; index += 1) atlas.request(`cold-${String(index)}`);

    expect(atlas.stage(pinned, raster(2, 2, 3))).toBe(true);
    atlas.commitFrame();
    expect(atlas.get("active")).toMatchObject({ generation: active.generation });
    expect(atlas.get("pending")).toMatchObject({ generation: pending.generation });
    expect(atlas.get("pinned")).toMatchObject({ generation: pinned.generation });
    expect(atlas.stats).toMatchObject({
      requestGenerationEntries: 5,
      requestGenerationProtectedEntries: 3,
      requestGenerationTombstones: 2,
      requestGenerationEvictions: 98,
    });

    atlas.destroy();
  });

  test("rejects a late request after its tombstone is evicted and the key is requested again", () => {
    const atlas = new GlyphAtlas({
      pageWidth: 8,
      pageHeight: 8,
      maxBytes: 64,
      requestGenerationCacheEntries: 1,
    });
    const stale = atlas.request("glyph");
    atlas.request("pressure");
    const current = atlas.request("glyph");

    expect(current.generation).toBeGreaterThan(stale.generation);
    expect(atlas.stage(stale, raster(2, 2, 1))).toBe(false);
    expect(atlas.stage(current, raster(2, 2, 2))).toBe(true);
    atlas.commitFrame();
    expect(atlas.get("glyph")).toMatchObject({ generation: current.generation });

    atlas.destroy();
  });

  test("retains bounded generation metadata after one million distinct request keys", () => {
    const cacheEntries = 1_024;
    const atlas = new GlyphAtlas({ requestGenerationCacheEntries: cacheEntries });

    for (let key = 0; key < 1_000_000; key += 1) atlas.request(key);

    expect(atlas.stats).toMatchObject({
      requests: 1_000_000,
      requestGenerationEntries: cacheEntries,
      requestGenerationProtectedEntries: 0,
      requestGenerationTombstones: cacheEntries,
      requestGenerationEvictions: 1_000_000 - cacheEntries,
    });

    atlas.destroy();
  });

  test("isolates destinations and discards a staged token after its render ticket advances", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    const destination = {};
    const otherDestination = {};
    const token = requestGlyphAtlasRenderToken(
      atlas,
      "glyph",
      {
        lifecycleEpoch: 1,
        commitTicket: 1,
        fontRegistryRevision: 1,
        destinationIdentity: destination,
      },
      1,
    );
    stageGlyphAtlasRenderToken(atlas, token, raster(4, 4, 1));

    expect(
      commitGlyphAtlasRenderFrame(atlas, {
        lifecycleEpoch: 1,
        commitTicket: 1,
        fontRegistryRevision: 1,
        destinationIdentity: otherDestination,
      }).uploads,
    ).toHaveLength(0);
    expect(atlas.stats.pendingEntries).toBe(1);
    expect(
      commitGlyphAtlasRenderFrame(atlas, {
        lifecycleEpoch: 1,
        commitTicket: 2,
        fontRegistryRevision: 1,
        destinationIdentity: destination,
      }).uploads,
    ).toHaveLength(0);
    expect(atlas.stats).toMatchObject({ pendingEntries: 0, staleResults: 1 });

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

  test("evicts twenty thousand unique glyphs under a four mebibyte ceiling", () => {
    const maxBytes = 4 * 1024 * 1024;
    const atlas = new GlyphAtlas({ pageWidth: 1_024, pageHeight: 1_024, maxBytes });
    const pixels = new Uint8Array(16 * 16).fill(255);
    const started = performance.now();
    for (let index = 0; index < 20_000; index += 1) {
      expect(
        atlas.stage(atlas.request(`glyph-${String(index)}`), {
          mode: "alpha",
          width: 16,
          height: 16,
          pixels,
        }),
      ).toBe(true);
      if (index % 1_000 === 999) atlas.commitFrame();
    }
    atlas.commitFrame();
    const elapsed = performance.now() - started;
    expect(atlas.stats.allocatedBytes).toBeLessThanOrEqual(maxBytes);
    expect(atlas.stats.evictions).toBeGreaterThan(0);
    expect(atlas.stats.capacityFailures).toBe(0);
    expect(elapsed).toBeLessThan(250);

    atlas.destroy();
  });

  test("accepts packed numeric keys beside diagnostic strings", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 64 });
    stageAndCommit(atlas, 42, raster(4, 4, 1));

    expect(atlas.get(42)).toMatchObject({ key: 42, page: 0, width: 4, height: 4 });
    expect(atlas.pin(42)).toBe(true);
    expect(atlas.stage(atlas.request("glyph"), raster(4, 8, 2))).toBe(true);
    atlas.commitFrame();
    expect(atlas.get(42)).toBeDefined();
    expect(atlas.get("glyph")).toBeDefined();
    expect(() => atlas.request(-1)).toThrow(TypeError);

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

  test("assigns array layers per format so sdf/alpha share R and msdf/color share RGBA", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 1_024 });
    stageAndCommit(atlas, "alpha-0", raster(8, 8, 1));
    stageAndCommit(atlas, "sdf-1", { ...raster(8, 8, 2), mode: "sdf" });
    stageAndCommit(atlas, "msdf-0", {
      mode: "msdf",
      width: 4,
      height: 4,
      pixels: new Uint8Array(4 * 4 * 4).fill(3),
    });
    stageAndCommit(atlas, "color-1", {
      mode: "color",
      width: 4,
      height: 4,
      pixels: new Uint8Array(4 * 4 * 4).fill(4),
    });

    expect(atlas.get("alpha-0")).toMatchObject({ page: 0, layer: 0, mode: "alpha" });
    expect(atlas.get("sdf-1")).toMatchObject({ page: 1, layer: 1, mode: "sdf" });
    expect(atlas.get("msdf-0")).toMatchObject({ page: 2, layer: 0, mode: "msdf" });
    expect(atlas.get("color-1")).toMatchObject({ page: 3, layer: 1, mode: "color" });
    expect(atlas.getPage(1)).toMatchObject({ layer: 1, mode: "sdf" });
    expect(atlas.getPage(2)).toMatchObject({ layer: 0, mode: "msdf" });

    atlas.destroy();
  });

  test("consumes external raster ownership across validation exits and preserves primary errors", () => {
    const invalidKeyAtlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    const invalidKey = externalRaster();
    expect(() => invalidKeyAtlas.stage({ key: "", generation: 1 }, invalidKey.raster)).toThrow(
      "Glyph key must be a non-empty string or a non-negative safe integer",
    );
    expect(invalidKey.releases()).toBe(1);
    invalidKeyAtlas.destroy();

    const invalidGenerationAtlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    const invalidGeneration = externalRaster();
    expect(() =>
      invalidGenerationAtlas.stage({ key: "glyph", generation: 0 }, invalidGeneration.raster),
    ).toThrow("request.generation must be a positive safe integer");
    expect(invalidGeneration.releases()).toBe(1);
    invalidGenerationAtlas.destroy();

    const validationAtlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    const releaseError = new Error("secondary release failure");
    const invalidRaster = externalRaster(releaseError, { width: 0 });
    expect(() =>
      validationAtlas.stage(validationAtlas.request("glyph"), invalidRaster.raster),
    ).toThrow("raster.width must be a positive safe integer");
    expect(invalidRaster.releases()).toBe(1);
    validationAtlas.destroy();

    const destroyedAtlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    destroyedAtlas.destroy();
    const destroyedRaster = externalRaster();
    expect(() =>
      destroyedAtlas.stage({ key: "glyph", generation: 1 }, destroyedRaster.raster),
    ).toThrow("GlyphAtlas has been destroyed");
    expect(destroyedRaster.releases()).toBe(1);
  });

  test("detaches a faulting pending replacement and releases both raster owners once", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    const firstError = new Error("first pending release failed");
    const first = externalRaster(firstError);
    const replacement = externalRaster();
    expect(atlas.stage(atlas.request("glyph"), first.raster)).toBe(true);

    expect(() => atlas.stage(atlas.request("glyph"), replacement.raster)).toThrow(firstError);
    expect(first.releases()).toBe(1);
    expect(replacement.releases()).toBe(1);
    expect(atlas.stats.pendingEntries).toBe(0);

    const recovered = externalRaster();
    expect(atlas.stage(atlas.request("glyph"), recovered.raster)).toBe(true);
    atlas.destroy();
    expect(first.releases()).toBe(1);
    expect(replacement.releases()).toBe(1);
    expect(recovered.releases()).toBe(1);
  });

  test("detaches a rejected pending raster before its release callback faults", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    const releaseError = new Error("rejected pending release failed");
    const pending = externalRaster(releaseError);
    expect(atlas.stage(atlas.request("glyph"), pending.raster)).toBe(true);
    atlas.request("glyph");

    expect(() => atlas.commitFrame()).toThrow(releaseError);
    expect(pending.releases()).toBe(1);
    expect(atlas.stats.pendingEntries).toBe(0);
    expect(atlas.commitFrame().entries).toEqual([]);
    atlas.destroy();
    expect(pending.releases()).toBe(1);
  });

  test("destroys every pending raster once and reports the first cleanup failure", () => {
    const atlas = new GlyphAtlas({ pageWidth: 8, pageHeight: 8, maxBytes: 256 });
    const firstError = new Error("first destroy release failed");
    const first = externalRaster(firstError);
    const second = externalRaster(new Error("second destroy release failed"));
    expect(atlas.stage(atlas.request("first"), first.raster)).toBe(true);
    expect(atlas.stage(atlas.request("second"), second.raster)).toBe(true);

    expect(() => atlas.destroy()).toThrow(firstError);
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
    expect(atlas.stats.pendingEntries).toBe(0);
    expect(() => atlas.destroy()).not.toThrow();
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
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

function stageAndCommit(atlas: GlyphAtlas, key: GlyphCacheKey, value: GlyphRaster): void {
  expect(atlas.stage(atlas.request(key), value)).toBe(true);
  atlas.commitFrame();
}

function externalRaster(
  releaseError?: Error,
  overrides: Partial<Pick<ExternalColorGlyphRaster, "width" | "height">> = {},
): {
  readonly raster: ExternalColorGlyphRaster;
  readonly releases: () => number;
} {
  let releases = 0;
  const raster: ExternalColorGlyphRaster = {
    mode: "color",
    width: overrides.width ?? 4,
    height: overrides.height ?? 4,
    source: {
      texture: {} as GPUTexture,
      format: "rgba8unorm",
      width: 4,
      height: 4,
    },
    sourceX: 0,
    sourceY: 0,
    release() {
      releases += 1;
      if (releaseError !== undefined) throw releaseError;
    },
  };
  return { raster, releases: () => releases };
}
