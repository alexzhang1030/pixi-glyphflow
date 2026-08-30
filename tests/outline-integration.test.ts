import { describe, expect, test } from "bun:test";

import type { Container, Renderer, TextStyleOptions } from "pixi.js";

import { FontRegistry, type PositionedRun } from "../src";
import {
  GlyphAtlas,
  GlyphInstanceStore,
  RenderCoordinator,
  type AtlasCommit,
  type ExternalColorGlyphRaster,
  type GlyphRaster,
  type RasterGlyphRequest,
  type RenderCommitResult,
} from "../src/advanced";
import type {
  OutlineExternalColorRaster,
  OutlineRenderingPlugin,
  OutlineRenderingRasterRequest,
} from "../src/render/outline";
import type {
  PixiRendererBackend,
  RenderColorAtlasCopy,
  RenderColorAtlasSource,
  RenderComputeCullUpdate,
  RenderSurfaceStats,
} from "../src/render/PixiRendererBackend";
import { releaseAtlasCommitExternalUploads, RenderSurface } from "../src/render/RenderSurface";

const CONTENT = 1;
const STYLE = 4;

describe("outline renderer integration", () => {
  test("transfers external raster ownership through atlas commit and retires rejected work", () => {
    const atlas = new GlyphAtlas({ pageWidth: 16, pageHeight: 16, maxBytes: 1_024 });
    const stale = atlas.request("stale");
    atlas.request("stale");
    const staleRaster = externalRaster();

    expect(atlas.stage(stale, staleRaster.raster)).toBe(false);
    expect(staleRaster.releases()).toBe(1);

    const superseded = atlas.request("superseded");
    const supersededRaster = externalRaster();
    expect(atlas.stage(superseded, supersededRaster.raster)).toBe(true);
    atlas.request("superseded");
    expect(atlas.commitFrame().entries).toEqual([]);
    expect(supersededRaster.releases()).toBe(1);

    const committedRaster = externalRaster();
    expect(atlas.stage(atlas.request("committed"), committedRaster.raster)).toBe(true);
    const commit = atlas.commitFrame();
    expect(commit.uploads).toEqual([]);
    expect(commit.externalUploads).toHaveLength(1);
    expect(committedRaster.releases()).toBe(0);
    commit.externalUploads[0]?.release();
    expect(committedRaster.releases()).toBe(1);

    const pendingRaster = externalRaster();
    expect(atlas.stage(atlas.request("pending"), pendingRaster.raster)).toBe(true);
    atlas.destroy();
    expect(pendingRaster.releases()).toBe(1);
  });

  test("routes opt-in projected HarfBuzz glyphs through outline and keeps auto on atlas", async () => {
    const optIn = await outlineCoordinator("outline", 160);
    expect(optIn.outline.requests).toEqual([
      expect.objectContaining({ glyphId: 65, projectedHeightPx: 160, rasterPixelHeight: 256 }),
    ]);
    expect(optIn.providerRequests).toEqual([]);
    expect(optIn.result).toMatchObject({ atlasUploads: 1 });
    expect(optIn.result.atlasCommit).toMatchObject({ uploads: [], externalUploads: [{}] });
    expect(
      optIn.coordinator.atlas.get(optIn.result.atlasCommit.entries[0]?.key ?? ""),
    ).toMatchObject({ mode: "color" });
    optIn.result.atlasCommit.externalUploads[0]?.release();
    optIn.coordinator.destroy();
    optIn.registry.destroy();

    const automatic = await outlineCoordinator("auto", 160);
    expect(automatic.outline.requests).toEqual([]);
    expect(automatic.providerRequests).toHaveLength(1);
    expect(automatic.result.atlasCommit).toMatchObject({ uploads: [{}], externalUploads: [] });
    automatic.coordinator.destroy();
    automatic.registry.destroy();
  });

  test("reuses a projected raster bucket and allocates the next bucket after zoom", async () => {
    const fixture = await outlineCoordinator("outline", 160);
    const sameBucket = await fixture.coordinator.commit(2, [
      {
        slot: 0,
        mask: STYLE,
        snapshot: renderSnapshot(180),
      },
    ]);
    const nextBucket = await fixture.coordinator.commit(3, [
      {
        slot: 0,
        mask: STYLE,
        snapshot: renderSnapshot(300),
      },
    ]);

    expect(fixture.outline.requests.map((request) => request.rasterPixelHeight)).toEqual([
      256, 512,
    ]);
    expect(sameBucket.atlasUploads).toBe(0);
    expect(nextBucket.atlasCommit.externalUploads).toHaveLength(1);

    fixture.result.atlasCommit.externalUploads[0]?.release();
    nextBucket.atlasCommit.externalUploads[0]?.release();
    fixture.coordinator.destroy();
    fixture.registry.destroy();
  });

  test("rasterizes both outline buckets when one interned run is used in the same commit", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const outline = new FakeOutlinePlugin();
    const sharedRun = harfBuzzRun();
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      glyphMode: "outline",
      outline,
      layoutEngine: {
        layout() {
          layoutCalls += 1;
          return sharedRun;
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          throw new Error("Outline bucket unexpectedly used the atlas raster provider");
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 512, pageHeight: 512, maxBytes: 512 * 512 * 4 },
      instanceOptions: { initialCapacity: 4 },
    });

    const firstSnapshot = renderSnapshot(160);
    const result = await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: firstSnapshot },
      {
        slot: 1,
        mask: CONTENT | STYLE,
        snapshot: { ...renderSnapshot(300), order: 1, style: firstSnapshot.style },
      },
    ]);

    expect(layoutCalls).toBe(1);
    expect(outline.requests.map((request) => request.rasterPixelHeight)).toEqual([256, 512]);
    expect(result.atlasCommit.externalUploads).toHaveLength(2);
    expect(coordinator.instances.getRange(0)?.offset).not.toBe(
      coordinator.instances.getRange(1)?.offset,
    );

    for (const upload of result.atlasCommit.externalUploads) upload.release();
    await coordinator.destroy();
    registry.destroy();
  });

  test("replays retained sources after color-array growth and releases them on eviction", async () => {
    const backend = new FakeBackend();
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend,
    });
    const first = externalRaster();
    const firstCommit = externalCommit("first", 1, 0, first.raster);

    await surface.apply(renderResult(firstCommit));
    expect(backend.copies).toHaveLength(1);
    expect(first.releases()).toBe(0);

    await surface.apply(
      renderResult({
        entries: [atlasEntry("cpu", 1, 1)],
        uploads: [{ entry: atlasEntry("cpu", 1, 1), pixels: new Uint8Array(4 * 4 * 4).fill(255) }],
        externalUploads: [],
        evictedKeys: [],
      }),
    );
    expect(backend.copies).toHaveLength(2);

    await surface.apply(
      renderResult({ entries: [], uploads: [], externalUploads: [], evictedKeys: ["first"] }),
    );
    expect(first.releases()).toBe(1);
    surface.destroy();
    expect(first.releases()).toBe(1);
  });

  test("retries a retained external copy after a transient backend failure", async () => {
    const backend = new FakeBackend([false, true]);
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend,
    });
    const raster = externalRaster();

    await expect(
      surface.apply(renderResult(externalCommit("retry", 1, 0, raster.raster))),
    ).rejects.toThrow("Renderer cannot import an external color glyph atlas");
    await surface.apply(
      renderResult({ entries: [], uploads: [], externalUploads: [], evictedKeys: [] }),
    );

    expect(backend.copies).toHaveLength(2);
    expect(raster.releases()).toBe(0);
    surface.destroy();
    expect(raster.releases()).toBe(1);
  });

  test("takes ownership before a renderer apply failure", async () => {
    const backend = new FakeBackend([], new Error("renderer apply failed"));
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend,
    });
    const raster = externalRaster();

    await expect(
      surface.apply(renderResult(externalCommit("apply-failure", 1, 0, raster.raster))),
    ).rejects.toThrow("renderer apply failed");
    expect(raster.releases()).toBe(0);

    surface.destroy();
    expect(raster.releases()).toBe(1);
  });

  test("releases an external upload once when apply starts after destroy", async () => {
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend: new FakeBackend(),
    });
    const raster = externalRaster();
    surface.destroy();
    const commit = externalCommit("destroyed-apply", 1, 0, raster.raster);

    await expect(
      surface.apply(
        renderResult({
          ...commit,
          externalUploads: [...commit.externalUploads, ...commit.externalUploads],
        }),
      ),
    ).rejects.toThrow(/destroyed/i);
    expect(raster.releases()).toBe(1);

    surface.destroy();
    expect(raster.releases()).toBe(1);
  });

  test("keeps the destroyed error primary while every rejected upload release runs", async () => {
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend: new FakeBackend(),
    });
    surface.destroy();
    const emptyFailure = await surface
      .apply(renderResult({ entries: [], uploads: [], externalUploads: [], evictedKeys: [] }))
      .catch((error: unknown) => error);
    const firstReleaseFailure = new Error("first destroyed upload release failed");
    const first = externalRaster(firstReleaseFailure);
    const second = externalRaster(new Error("second destroyed upload release failed"));
    const firstCommit = externalCommit("destroyed-first", 1, 0, first.raster);
    const secondCommit = externalCommit("destroyed-second", 1, 1, second.raster);

    const rejected = await surface
      .apply(
        renderResult({
          entries: [...firstCommit.entries, ...secondCommit.entries],
          uploads: [],
          externalUploads: [...firstCommit.externalUploads, ...secondCommit.externalUploads],
          evictedKeys: [],
        }),
      )
      .catch((error: unknown) => error);

    expect(rejected).toBe(emptyFailure);
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
    surface.destroy();
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
  });

  test("retries the latest replacement after concurrent copies settle out of order", async () => {
    const firstCopy = deferred<boolean>();
    const replacementCopy = deferred<boolean>();
    const backend = new FakeBackend([firstCopy.promise, replacementCopy.promise, true]);
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend,
    });
    const first = externalRaster();
    const replacement = externalRaster();

    const pendingFirst = surface.apply(
      renderResult(externalCommit("concurrent", 1, 0, first.raster)),
    );
    const pendingReplacement = surface.apply(
      renderResult(externalCommit("concurrent", 2, 0, replacement.raster)),
    );
    expect(backend.copies).toHaveLength(2);
    expect(first.releases()).toBe(0);

    firstCopy.resolve(true);
    await pendingFirst;
    expect(first.releases()).toBe(1);
    replacementCopy.resolve(false);
    await expect(pendingReplacement).rejects.toThrow(
      "Renderer cannot import an external color glyph atlas",
    );
    await surface.apply(
      renderResult({ entries: [], uploads: [], externalUploads: [], evictedKeys: [] }),
    );

    expect(backend.copies).toHaveLength(3);
    expect(backend.copies[2]?.source).toBe(replacement.raster.source);
    surface.destroy();
    expect(first.releases()).toBe(1);
    expect(replacement.releases()).toBe(1);
  });

  test("releases every unadopted external upload once and reports the first callback fault", () => {
    const firstError = new Error("first unadopted release failed");
    const first = externalRaster(firstError);
    const second = externalRaster(new Error("second unadopted release failed"));
    const firstCommit = externalCommit("first", 1, 0, first.raster);
    const secondCommit = externalCommit("second", 1, 1, second.raster);

    expect(() =>
      releaseAtlasCommitExternalUploads({
        entries: [...firstCommit.entries, ...secondCommit.entries],
        uploads: [],
        externalUploads: [...firstCommit.externalUploads, ...secondCommit.externalUploads],
        evictedKeys: [],
      }),
    ).toThrow(firstError);
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
  });

  test("detaches every copy reference before release callbacks report a fault", async () => {
    const copy = deferred<boolean>();
    const backend = new FakeBackend([copy.promise]);
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend,
    });
    const firstError = new Error("first copy release failed");
    const first = externalRaster(firstError);
    const second = externalRaster(new Error("second copy release failed"));
    const firstCommit = externalCommit("first", 1, 0, first.raster);
    const secondCommit = externalCommit("second", 1, 1, second.raster);
    const pending = surface.apply(
      renderResult({
        entries: [...firstCommit.entries, ...secondCommit.entries],
        uploads: [],
        externalUploads: [...firstCommit.externalUploads, ...secondCommit.externalUploads],
        evictedKeys: [],
      }),
    );
    expect(backend.copies).toHaveLength(1);

    await surface.apply(
      renderResult({
        entries: [],
        uploads: [],
        externalUploads: [],
        evictedKeys: ["first", "second"],
      }),
    );
    copy.resolve(true);
    await expect(pending).rejects.toBe(firstError);
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);

    surface.destroy();
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
  });

  test("destroys the backend after every retained upload cleanup and preserves the first fault", async () => {
    const backendError = new Error("backend destroy failed");
    const backend = new FakeBackend([], undefined, backendError);
    const surface = new RenderSurface({} as Renderer, {} as Container, {} as RenderCoordinator, {
      backend,
    });
    const firstError = new Error("first retained release failed");
    const first = externalRaster(firstError);
    const second = externalRaster(new Error("second retained release failed"));
    const firstCommit = externalCommit("first", 1, 0, first.raster);
    const secondCommit = externalCommit("second", 1, 1, second.raster);
    await surface.apply(
      renderResult({
        entries: [...firstCommit.entries, ...secondCommit.entries],
        uploads: [],
        externalUploads: [...firstCommit.externalUploads, ...secondCommit.externalUploads],
        evictedKeys: [],
      }),
    );

    expect(() => surface.destroy()).toThrow(firstError);
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
    expect(backend.destroyCalls).toBe(1);
    expect(() => surface.destroy()).not.toThrow();
    expect(first.releases()).toBe(1);
    expect(second.releases()).toBe(1);
    expect(backend.destroyCalls).toBe(1);
  });

  test("replays a post-commit external upload into the render surface after retry", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const instances = new OneShotFaultingInstances({ initialCapacity: 4 });
    const external = externalRaster();
    const coordinator = new RenderCoordinator({
      registry,
      instances,
      layoutEngine: {
        layout() {
          return harfBuzzRun();
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return external.raster as unknown as GlyphRaster;
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });
    const writeFailure = new Error("injected instance write failure");
    instances.failNextSet = writeFailure;
    const changes = [{ slot: 0, mask: CONTENT | STYLE, snapshot: renderSnapshot(16) }] as const;

    await expect(coordinator.commit(1, changes)).rejects.toBe(writeFailure);
    expect(external.releases()).toBe(0);
    const retry = await coordinator.commit(1, changes);
    expect(retry.atlasCommit.externalUploads).toHaveLength(1);

    const backend = new FakeBackend();
    const surface = new RenderSurface({} as Renderer, {} as Container, coordinator, { backend });
    await surface.apply(retry);
    expect(backend.copies).toHaveLength(1);
    expect(backend.copies[0]?.source).toBe(external.raster.source);
    expect(external.releases()).toBe(0);

    surface.destroy();
    expect(external.releases()).toBe(1);
    await coordinator.destroy();
    instances.destroy();
    registry.destroy();
    expect(external.releases()).toBe(1);
  });
});

async function outlineCoordinator(
  glyphMode: "auto" | "outline",
  projectedHeightPx: number,
): Promise<{
  readonly coordinator: RenderCoordinator;
  readonly registry: FontRegistry;
  readonly outline: FakeOutlinePlugin;
  readonly providerRequests: RasterGlyphRequest[];
  readonly result: Readonly<RenderCommitResult>;
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture" });
  const outline = new FakeOutlinePlugin();
  const providerRequests: RasterGlyphRequest[] = [];
  const coordinator = new RenderCoordinator({
    registry,
    glyphMode,
    outline,
    layoutEngine: {
      layout: () => Promise.resolve(harfBuzzRun()),
      destroy() {},
    },
    glyphProvider: {
      rasterize(request): Promise<GlyphRaster> {
        providerRequests.push(request);
        return Promise.resolve({
          mode: request.mode,
          width: 4,
          height: 4,
          pixels: new Uint8Array(64).fill(255),
        });
      },
      destroy() {},
    },
    atlasOptions: { pageWidth: 512, pageHeight: 512, maxBytes: 512 * 512 * 4 },
  });
  const result = await coordinator.commit(1, [
    {
      slot: 0,
      mask: CONTENT | STYLE,
      snapshot: renderSnapshot(projectedHeightPx),
    },
  ]);
  return { coordinator, registry, outline, providerRequests, result };
}

class FakeOutlinePlugin implements OutlineRenderingPlugin {
  readonly capability = {
    status: "supported" as const,
    maxTextureDimension2D: 8_192,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65_535,
  };
  readonly projectedSizeThresholdPx = 128;
  readonly requests: OutlineRenderingRasterRequest[] = [];

  route(projectedHeightPx: number) {
    return projectedHeightPx >= this.projectedSizeThresholdPx
      ? ({ path: "outline" } as const)
      : ({ path: "atlas", reason: "below-projected-threshold" } as const);
  }

  rasterPixelHeight(projectedHeightPx: number): number {
    let bucket = 1;
    while (bucket < projectedHeightPx) bucket *= 2;
    return bucket;
  }

  rasterize(request: Readonly<OutlineRenderingRasterRequest>) {
    this.requests.push(request);
    return Promise.resolve({ status: "ready" as const, raster: externalRaster().raster });
  }

  destroy(): void {}
}

function externalRaster(releaseError?: Error): {
  readonly raster: OutlineExternalColorRaster & ExternalColorGlyphRaster;
  readonly releases: () => number;
} {
  let releases = 0;
  const raster = {
    mode: "color" as const,
    width: 4,
    height: 4,
    source: {
      texture: {} as GPUTexture,
      format: "rgba8unorm" as const,
      width: 4,
      height: 4,
    },
    sourceX: 0,
    sourceY: 0,
    padding: 0,
    scale: 1,
    quad: { minX: 0, minY: 0, maxX: 4, maxY: 4, width: 4, height: 4 },
    metrics: { bearingX: 0, bearingY: 4, advance: 4, rasterScale: 1 },
    release: () => {
      releases += 1;
      if (releaseError !== undefined) throw releaseError;
    },
  };
  return { raster, releases: () => releases };
}

function harfBuzzRun(): Readonly<PositionedRun> {
  return Object.freeze({
    source: "harfbuzz" as const,
    text: "A",
    fontFamily: "Fixture",
    fontFamilies: Object.freeze(["Fixture"]),
    fontRevision: 1,
    glyphCount: 1,
    direction: "ltr" as const,
    glyphIds: new Uint32Array([65]),
    clusters: new Uint32Array([0]),
    clusterEnds: new Uint32Array([1]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([4]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    glyphKeys: Object.freeze(["A"]),
    bounds: Object.freeze({ x: 0, y: -4, width: 4, height: 4 }),
  });
}

function renderSnapshot(projectedHeightPx: number) {
  return Object.freeze({
    sourceRevision: 1,
    text: "A",
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    zIndex: 0,
    order: 0,
    blendMode: "normal" as const,
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style: { fontFamily: "Fixture", fontSize: 16 } satisfies Readonly<TextStyleOptions>,
    projectedHeightPx,
  });
}

function externalCommit(
  key: string,
  generation: number,
  page: number,
  raster: ExternalColorGlyphRaster,
): Readonly<AtlasCommit> {
  const entry = atlasEntry(key, generation, page);
  return {
    entries: [entry],
    uploads: [],
    externalUploads: [
      {
        entry,
        source: raster.source,
        sourceX: raster.sourceX,
        sourceY: raster.sourceY,
        release: raster.release,
      },
    ],
    evictedKeys: [],
  };
}

function atlasEntry(key: string, generation: number, page: number) {
  return {
    key,
    generation,
    page,
    layer: page,
    mode: "color" as const,
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    u0: 0,
    v0: 0,
    u1: 0.25,
    v1: 0.25,
  };
}

function renderResult(atlasCommit: Readonly<AtlasCommit>): Readonly<RenderCommitResult> {
  return {
    revision: 1,
    stale: false,
    appliedLabels: 1,
    glyphs: 1,
    atlasUploads: atlasCommit.uploads.length + atlasCommit.externalUploads.length,
    atlasCommit,
    drawOrderChanged: false,
  };
}

class FakeBackend implements PixiRendererBackend {
  readonly copies: Array<{
    readonly source: Readonly<RenderColorAtlasSource>;
    readonly copies: readonly Readonly<RenderColorAtlasCopy>[];
  }> = [];
  readonly stats: Readonly<RenderSurfaceStats> = {
    adapter: "webgpu",
    cullPath: "cpu-grid",
    palettePath: "texture",
    meshes: 0,
    atlasTextures: 0,
    submittedGlyphs: 0,
    atlasUploadBytes: 0,
    instanceUploadBytes: 0,
    transformUploadBytes: 0,
    instanceWrites: 0,
    transformWrites: 0,
    pageRebuilds: 0,
    lastUploadMs: 0,
  };
  readonly #copyResults: Array<boolean | Promise<boolean>>;
  readonly #applyError: Error | undefined;
  readonly #destroyError: Error | undefined;
  destroyCalls = 0;

  constructor(
    copyResults: readonly (boolean | Promise<boolean>)[] = [],
    applyError?: Error,
    destroyError?: Error,
  ) {
    this.#copyResults = [...copyResults];
    this.#applyError = applyError;
    this.#destroyError = destroyError;
  }

  prepareCullPath() {
    return "cpu-grid" as const;
  }
  preparePalettePath() {
    return "texture" as const;
  }
  queuePaletteMoves(): void {}
  bindOriginColumns(): void {}
  dropIdleMeshes(): void {}
  refreshComputeCull(): "cpu-grid" {
    return "cpu-grid";
  }
  rebuildCpuCull(): void {}
  flushPaletteStorage(): void {}
  readSubmittedGlyphs(): Promise<number> {
    return Promise.resolve(0);
  }
  copyColorAtlasToArray(
    source: Readonly<RenderColorAtlasSource>,
    copies: readonly Readonly<RenderColorAtlasCopy>[],
  ): Promise<boolean> {
    this.copies.push({ source, copies });
    return Promise.resolve(this.#copyResults.shift() ?? true);
  }
  apply(_result: Readonly<RenderCommitResult>, _compute?: Readonly<RenderComputeCullUpdate>): void {
    if (this.#applyError !== undefined) throw this.#applyError;
  }
  destroy(): void {
    this.destroyCalls += 1;
    if (this.#destroyError !== undefined) throw this.#destroyError;
  }
}

class OneShotFaultingInstances extends GlyphInstanceStore {
  failNextSet: Error | undefined;

  override set(...args: Parameters<GlyphInstanceStore["set"]>): boolean {
    const failure = this.failNextSet;
    this.failNextSet = undefined;
    if (failure !== undefined) throw failure;
    return super.set(...args);
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
