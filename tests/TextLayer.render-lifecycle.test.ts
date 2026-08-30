import { describe, expect, test } from "bun:test";

import { Container, type DestroyOptions, type Renderer } from "pixi.js";

import { TextLayer, type PositionedRun } from "../src";
import {
  GlyphAtlas,
  LabelCollisionSelector,
  RasterGlyphProvider,
  RenderCoordinator,
  SpatialIndex,
  type AtlasEntry,
  type AtlasExternalUpload,
  type GlyphRaster,
  type RasterGlyphRequest,
  type RenderCommitResult,
} from "../src/advanced";
import { RenderSurface } from "../src/render/RenderSurface";
import { TextStore } from "../src/store/TextStore";

describe("TextLayer render lifecycle", () => {
  for (const action of ["attach", "detach", "destroy"] as const) {
    test(`settles internally owned raster work after ${action}`, async () => {
      const fixture = await createOwnedFixture();
      fixture.layer.create({ text: "A" });
      const pendingCommit = fixture.layer.commit();
      await waitForGate(fixture.gates, "A");

      if (action === "attach") fixture.layer.attach({} as Renderer);
      else fixture.layer[action]();
      await Promise.resolve();
      fixture.gates.get("A")?.();

      expect(Number(await pendingCommit)).toBe(1);

      if (action !== "destroy") fixture.layer.destroy();
    });
  }

  test("settles internally owned TinySDF work after destroy", async () => {
    const fixture = await createOwnedFixture({ sdf: true });
    fixture.layer.create({ text: "A" });
    const pendingCommit = fixture.layer.commit();
    await waitForGate(fixture.gates, "A");

    fixture.layer.destroy();
    await Promise.resolve();
    fixture.gates.get("A")?.();

    expect(Number(await pendingCommit)).toBe(1);
  });

  test("settles default provider initialization after destroy", async () => {
    const fixture = await createOwnedFixture({
      sdf: true,
      canvasRasterizer() {
        return Promise.resolve(alphaRaster(8));
      },
    });
    fixture.layer.create({ text: "A" });
    const pendingCommit = fixture.layer.commit();

    await Promise.resolve();
    fixture.layer.destroy();

    expect(Number(await pendingCommit)).toBe(1);
  });

  test("propagates an active default rasterizer failure", async () => {
    const failure = new Error("fixture raster failed");
    const fixture = await createOwnedFixture({
      canvasRasterizer() {
        return Promise.reject(failure);
      },
    });
    fixture.layer.create({ text: "A" });

    await expect(fixture.layer.commit()).rejects.toBe(failure);

    fixture.layer.destroy();
  });

  test("starts work for a newly attached renderer while the old raster is pending", async () => {
    const fixture = createFixture();
    const id = fixture.layer.create({ text: "A" });
    const oldCommit = fixture.layer.commit();
    await waitForGate(fixture.gates, "A");

    fixture.layer.attach({} as Renderer);
    fixture.layer.update(id, { text: "B" });
    const currentCommit = fixture.layer.commit();
    await waitForGate(fixture.gates, "B");
    fixture.gates.get("B")?.();
    await currentCommit;
    fixture.gates.get("A")?.();
    await oldCommit;

    expect(fixture.layer.stats).toMatchObject({ attached: true, glyphCount: 1 });
    expect(fixture.atlas.commitFrame().uploads).toHaveLength(0);

    fixture.layer.destroy();
    fixture.atlas.destroy();
  });

  for (const action of ["attach", "detach"] as const) {
    test(`fully releases the old renderer when ${action} cleanup has multiple faults`, async () => {
      const oldRenderer = fakeWebGlRenderer();
      const nextRenderer = fakeWebGlRenderer();
      const layer = new TextLayer({ renderer: oldRenderer });
      const surfaceFailure = new Error("surface release failed");
      const coordinatorFailure = new Error("coordinator release failed");
      const calls = { surface: 0, coordinator: 0 };
      const surfaceDestroy = RenderSurface.prototype.destroy;
      const coordinatorDestroy = RenderCoordinator.prototype.destroy;

      RenderSurface.prototype.destroy = function (): void {
        calls.surface += 1;
        surfaceDestroy.call(this);
        throw surfaceFailure;
      };
      RenderCoordinator.prototype.destroy = function (): Promise<void> {
        calls.coordinator += 1;
        void coordinatorDestroy.call(this);
        throw coordinatorFailure;
      };

      try {
        expect(() => (action === "attach" ? layer.attach(nextRenderer) : layer.detach())).toThrow(
          surfaceFailure,
        );
        const release = layer.whenRendererReleased();
        await expect(release).rejects.toBe(surfaceFailure);
        expect(layer.stats.attached).toBe(false);
        expect(calls).toEqual({ surface: 1, coordinator: 1 });

        expect(() => layer.detach()).not.toThrow();
        expect(layer.whenRendererReleased()).toBe(release);
        await expect(layer.whenRendererReleased()).rejects.toBe(surfaceFailure);
        expect(calls).toEqual({ surface: 1, coordinator: 1 });

        layer.attach(nextRenderer);
        expect(layer.stats.attached).toBe(true);
      } finally {
        RenderSurface.prototype.destroy = surfaceDestroy;
        RenderCoordinator.prototype.destroy = coordinatorDestroy;
        layer.destroy();
      }
    });
  }

  test("rolls back a failed surface activation and retries the same renderer", async () => {
    const surfaceFailure = new Error("surface activation failed");
    const coordinatorFailure = new Error("activation coordinator teardown failed");
    let surfaceAttempts = 0;
    const renderer = {
      gl: {
        MAX_TEXTURE_SIZE: 0x0d33,
        getParameter() {
          surfaceAttempts += 1;
          if (surfaceAttempts === 1) throw surfaceFailure;
          return 4_096;
        },
      },
      buffer: { updateBuffer(): void {} },
    } as unknown as Renderer;
    const layer = new TextLayer();
    const coordinatorDestroy = RenderCoordinator.prototype.destroy;
    let coordinatorDestroyCalls = 0;
    let rejectCoordinator: ((reason: unknown) => void) | undefined;
    RenderCoordinator.prototype.destroy = function (): Promise<void> {
      coordinatorDestroyCalls += 1;
      void coordinatorDestroy.call(this);
      return new Promise((_resolve, reject) => {
        rejectCoordinator = reject;
      });
    };

    try {
      expect(() => layer.attach(renderer)).toThrow(surfaceFailure);
      const release = layer.whenRendererReleased();
      expect(layer.stats.attached).toBe(false);
      expect(surfaceAttempts).toBe(1);
      expect(coordinatorDestroyCalls).toBe(1);
      expect(layer.whenRendererReleased()).toBe(release);

      rejectCoordinator?.(coordinatorFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(release).rejects.toBe(surfaceFailure);

      layer.attach(renderer);
      expect(surfaceAttempts).toBe(2);
      expect(layer.stats).toMatchObject({ attached: true, rendererAdapter: "webgl" });
    } finally {
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
      layer.destroy();
    }
  });

  test("releases a coordinator when initial surface activation fails", () => {
    const surfaceFailure = new Error("initial surface activation failed");
    const coordinatorFailure = new Error("initial coordinator cleanup failed");
    const renderer = {
      gl: {
        MAX_TEXTURE_SIZE: 0x0d33,
        getParameter(): never {
          throw surfaceFailure;
        },
      },
      buffer: { updateBuffer(): void {} },
    } as unknown as Renderer;
    const coordinatorDestroy = RenderCoordinator.prototype.destroy;
    let coordinatorDestroyCalls = 0;
    RenderCoordinator.prototype.destroy = function (): Promise<void> {
      coordinatorDestroyCalls += 1;
      void coordinatorDestroy.call(this);
      throw coordinatorFailure;
    };

    try {
      expect(() => new TextLayer({ renderer })).toThrow(surfaceFailure);
      expect(coordinatorDestroyCalls).toBe(1);
    } finally {
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
    }
  });

  test("preserves an activation fault through surface and coordinator cleanup faults", async () => {
    const activationFailure = new Error("residency activation failed");
    const surfaceFailure = new Error("activation surface cleanup failed");
    const coordinatorFailure = new Error("activation coordinator cleanup failed");
    const renderer = {
      gpu: { device: { limits: { maxTextureDimension2D: 8_192 } } },
      buffer: { updateBuffer(): void {} },
    } as unknown as Renderer;
    const layer = new TextLayer({ culling: { residency: "gpu-scene" } });
    const prepareGpuScene = RenderSurface.prototype.prepareGpuScene;
    const surfaceDestroy = RenderSurface.prototype.destroy;
    const coordinatorDestroy = RenderCoordinator.prototype.destroy;
    const calls = { surface: 0, coordinator: 0 };
    let rejectCoordinator: ((reason: unknown) => void) | undefined;

    RenderSurface.prototype.prepareGpuScene = function (): never {
      throw activationFailure;
    };
    RenderSurface.prototype.destroy = function (): void {
      calls.surface += 1;
      surfaceDestroy.call(this);
      throw surfaceFailure;
    };
    RenderCoordinator.prototype.destroy = function (): Promise<void> {
      calls.coordinator += 1;
      void coordinatorDestroy.call(this);
      return new Promise((_resolve, reject) => {
        rejectCoordinator = reject;
      });
    };

    try {
      expect(() => layer.attach(renderer)).toThrow(activationFailure);
      const release = layer.whenRendererReleased();
      expect(layer.stats.attached).toBe(false);
      expect(calls).toEqual({ surface: 1, coordinator: 1 });

      rejectCoordinator?.(coordinatorFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(release).rejects.toBe(activationFailure);

      RenderSurface.prototype.prepareGpuScene = prepareGpuScene;
      RenderSurface.prototype.destroy = surfaceDestroy;
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
      layer.attach(renderer);
      expect(layer.stats).toMatchObject({ attached: true, rendererAdapter: "webgpu" });
    } finally {
      RenderSurface.prototype.prepareGpuScene = prepareGpuScene;
      RenderSurface.prototype.destroy = surfaceDestroy;
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
      layer.destroy();
    }
  });

  for (const action of ["detach", "destroy"] as const) {
    test(`settles a pending commit after ${action} with an empty atlas frame`, async () => {
      const fixture = createFixture();
      fixture.layer.create({ text: "A" });
      const pendingCommit = fixture.layer.commit();
      await waitForGate(fixture.gates, "A");

      fixture.layer[action]();
      fixture.gates.get("A")?.();

      expect(Number(await pendingCommit)).toBe(1);
      expect(fixture.atlas.commitFrame().uploads).toHaveLength(0);

      if (action === "detach") fixture.layer.destroy();
      fixture.atlas.destroy();
    });
  }

  test("continues every layer teardown after simultaneous surface, coordinator, and font faults", async () => {
    const layer = new TextLayer({
      renderer: fakeWebGlRenderer(),
      culling: { collision: {} },
      rendering: {
        layoutEngine: {
          layout(_slot, _revision, input) {
            return run(input.text);
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize(): Promise<GlyphRaster> {
            return alphaRaster(2);
          },
          destroy() {},
        },
      },
    });
    const surfaceFailure = new Error("surface teardown failed");
    const coordinatorFailure = new Error("coordinator teardown failed");
    const fontFailure = new Error("font teardown failed");
    const events: string[] = [];
    let detachedBeforeTeardown = false;
    let mutationRejectedBeforeTeardown = false;
    const surfaceDestroy = RenderSurface.prototype.destroy;
    const coordinatorDestroy = RenderCoordinator.prototype.destroy;
    const fontDestroy = layer.fonts.destroy;
    const collisionDestroy = LabelCollisionSelector.prototype.destroy;
    const spatialDestroy = SpatialIndex.prototype.destroy;
    const storeDispose = TextStore.prototype.dispose;
    const containerDestroy = Container.prototype.destroy;

    RenderSurface.prototype.destroy = function (): void {
      events.push("surface");
      detachedBeforeTeardown = layer.stats.attached === false;
      try {
        layer.create({ text: "late" });
      } catch {
        mutationRejectedBeforeTeardown = true;
      }
      surfaceDestroy.call(this);
      throw surfaceFailure;
    };
    RenderCoordinator.prototype.destroy = function () {
      events.push("coordinator");
      void coordinatorDestroy.call(this);
      throw coordinatorFailure;
    };
    layer.fonts.destroy = function (): void {
      events.push("fonts");
      fontDestroy.call(this);
      throw fontFailure;
    };
    LabelCollisionSelector.prototype.destroy = function (): void {
      events.push("collision");
      collisionDestroy.call(this);
    };
    SpatialIndex.prototype.destroy = function (): void {
      events.push("spatial");
      spatialDestroy.call(this);
    };
    TextStore.prototype.dispose = function (): void {
      events.push("store");
      storeDispose.call(this);
    };
    Container.prototype.destroy = function (options?: DestroyOptions): void {
      events.push("super");
      containerDestroy.call(this, options);
    };

    try {
      expect(() => layer.destroy()).toThrow(surfaceFailure);
      await expect(layer.whenDestroyed()).rejects.toBe(surfaceFailure);
      expect(events).toEqual([
        "surface",
        "coordinator",
        "fonts",
        "collision",
        "spatial",
        "store",
        "super",
      ]);
      expect(detachedBeforeTeardown).toBe(true);
      expect(mutationRejectedBeforeTeardown).toBe(true);
      expect(layer.destroyed).toBe(true);

      expect(() => layer.destroy()).not.toThrow();
      expect(events).toHaveLength(7);
    } finally {
      RenderSurface.prototype.destroy = surfaceDestroy;
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
      layer.fonts.destroy = fontDestroy;
      LabelCollisionSelector.prototype.destroy = collisionDestroy;
      SpatialIndex.prototype.destroy = spatialDestroy;
      TextStore.prototype.dispose = storeDispose;
      Container.prototype.destroy = containerDestroy;
    }
  });

  test("tracks an internally owned provider rejection without an unhandled rejection", async () => {
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          layout(_slot, _revision, input) {
            return run(input.text);
          },
          destroy() {},
        },
        rasterizerOptions: {
          canvasRasterizer: async () => alphaRaster(2),
        },
      },
    });
    layer.create({ text: "A" });
    await layer.commit();

    const providerFailure = new Error("provider teardown failed");
    let providerDestroyCalls = 0;
    let rejectProvider: ((reason: unknown) => void) | undefined;
    const providerDestroy = RasterGlyphProvider.prototype.destroy;
    RasterGlyphProvider.prototype.destroy = function (): Promise<void> {
      providerDestroyCalls += 1;
      return new Promise((_resolve, reject) => {
        rejectProvider = reject;
      });
    };

    try {
      const teardown = layer.whenDestroyed();
      layer.destroy();
      await waitFor(() => rejectProvider !== undefined, "provider destroy");
      layer.destroy();
      expect(providerDestroyCalls).toBe(1);
      rejectProvider?.(providerFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(layer.whenDestroyed()).toBe(teardown);
      await expect(teardown).rejects.toBe(providerFailure);
      expect(() => layer.destroy()).not.toThrow();
    } finally {
      RasterGlyphProvider.prototype.destroy = providerDestroy;
    }
  });

  test("tracks a detached renderer provider rejection without an unhandled rejection", async () => {
    const renderer = {} as Renderer;
    const layer = new TextLayer({
      renderer,
      rendering: {
        layoutEngine: {
          layout(_slot, _revision, input) {
            return run(input.text);
          },
          destroy() {},
        },
        rasterizerOptions: {
          canvasRasterizer: async () => alphaRaster(2),
        },
      },
    });
    layer.create({ text: "A" });
    await layer.commit();

    const providerFailure = new Error("detached provider teardown failed");
    let providerDestroyCalls = 0;
    let rejectProvider: ((reason: unknown) => void) | undefined;
    const providerDestroy = RasterGlyphProvider.prototype.destroy;
    RasterGlyphProvider.prototype.destroy = function (): Promise<void> {
      providerDestroyCalls += 1;
      return new Promise((_resolve, reject) => {
        rejectProvider = reject;
      });
    };

    try {
      layer.detach();
      const release = layer.whenRendererReleased();
      await waitFor(() => rejectProvider !== undefined, "detached provider destroy");
      layer.detach();
      expect(layer.whenRendererReleased()).toBe(release);
      expect(providerDestroyCalls).toBe(1);
      expect(layer.stats.attached).toBe(false);

      rejectProvider?.(providerFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(release).rejects.toBe(providerFailure);

      layer.attach(renderer);
      expect(layer.stats.attached).toBe(true);
    } finally {
      RasterGlyphProvider.prototype.destroy = providerDestroy;
      layer.destroy();
    }
  });

  test("replays completed CPU and external atlas parts after a later spatial fault", async () => {
    const spatialFailure = new Error("late spatial publication failed");
    const retained = layerRenderResult("retained", true);
    const empty = layerRenderResult("retry", false);
    const applied: Readonly<RenderCommitResult>[] = [];
    let commitCalls = 0;
    let contentCalls = 0;
    let phase: "baseline" | "fault" | "retry" = "baseline";
    let failSpatial = true;
    const coordinatorCommit = RenderCoordinator.prototype.commit;
    const coordinatorContent = RenderCoordinator.prototype.applyContentLane;
    const coordinatorGetRun = RenderCoordinator.prototype.getRun;
    const surfaceApply = RenderSurface.prototype.apply;
    const spatialSet = SpatialIndex.prototype.set;
    RenderCoordinator.prototype.commit = async function (): Promise<Readonly<RenderCommitResult>> {
      commitCalls += 1;
      return phase === "fault" ? retained.result : empty.result;
    };
    RenderCoordinator.prototype.applyContentLane = async function (): Promise<
      Readonly<RenderCommitResult>
    > {
      contentCalls += 1;
      return empty.result;
    };
    RenderCoordinator.prototype.getRun = function (): Readonly<PositionedRun> {
      return run("A");
    };
    RenderSurface.prototype.apply = async function (
      result: Readonly<RenderCommitResult>,
    ): Promise<void> {
      applied.push(result);
    };

    let layer: TextLayer | undefined;
    try {
      layer = replayLayer();
      const ids = layer.createMany([
        { text: "object", anchor: 0.5 },
        { text: "content", x: 12 },
      ]);
      await layer.commit();
      applied.length = 0;
      const objectId = ids[0];
      const contentId = ids[1];
      if (objectId === undefined || contentId === undefined) throw new Error("Fixture ids missing");
      layer.update(objectId, { text: "object-next" });
      layer.updateTextPositions([contentId], "content-next", new Float32Array([24, 0]));
      phase = "fault";
      SpatialIndex.prototype.set = function (...args: Parameters<SpatialIndex["set"]>): void {
        if (failSpatial) {
          failSpatial = false;
          throw spatialFailure;
        }
        spatialSet.apply(this, args);
      };

      await expect(layer.commit()).rejects.toBe(spatialFailure);
      expect(retained.releases()).toBe(0);
      expect(applied).toHaveLength(0);

      phase = "retry";
      await layer.commit();
      expect(commitCalls).toBe(3);
      expect(contentCalls).toBeGreaterThanOrEqual(1);
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatchObject({ drawOrderChanged: true, atlasUploads: 2 });
      expect(applied[0]?.atlasCommit.uploads).toHaveLength(1);
      expect(applied[0]?.atlasCommit.externalUploads).toHaveLength(1);
      applied[0]?.atlasCommit.externalUploads[0]?.release();
      expect(retained.releases()).toBe(1);

      layer.destroy();
      layer = undefined;
      expect(retained.releases()).toBe(1);
    } finally {
      RenderCoordinator.prototype.commit = coordinatorCommit;
      RenderCoordinator.prototype.applyContentLane = coordinatorContent;
      RenderCoordinator.prototype.getRun = coordinatorGetRun;
      RenderSurface.prototype.apply = surfaceApply;
      SpatialIndex.prototype.set = spatialSet;
      layer?.destroy();
    }
  });

  test("detaches every retained render part before release callbacks report faults", async () => {
    const spatialFailure = new Error("retained render spatial failure");
    const firstReleaseFailure = new Error("first retained render release failed");
    const first = layerRenderResult("first", true, firstReleaseFailure);
    const second = layerRenderResult(
      "second",
      true,
      new Error("second retained render release failed"),
    );
    const empty = layerRenderResult("baseline", false);
    let phase: "baseline" | "fault" = "baseline";
    let failSpatial = true;
    const coordinatorCommit = RenderCoordinator.prototype.commit;
    const coordinatorContent = RenderCoordinator.prototype.applyContentLane;
    const coordinatorGetRun = RenderCoordinator.prototype.getRun;
    const surfaceApply = RenderSurface.prototype.apply;
    const spatialSet = SpatialIndex.prototype.set;
    RenderCoordinator.prototype.commit = async function (): Promise<Readonly<RenderCommitResult>> {
      return phase === "fault" ? first.result : empty.result;
    };
    RenderCoordinator.prototype.applyContentLane = async function (): Promise<
      Readonly<RenderCommitResult>
    > {
      return phase === "fault" ? second.result : empty.result;
    };
    RenderCoordinator.prototype.getRun = function (): Readonly<PositionedRun> {
      return run("A");
    };
    RenderSurface.prototype.apply = async function (): Promise<void> {};

    let layer: TextLayer | undefined;
    try {
      layer = replayLayer();
      const ids = layer.createMany([
        { text: "object", anchor: 0.5 },
        { text: "content", x: 12 },
      ]);
      await layer.commit();
      const objectId = ids[0];
      const contentId = ids[1];
      if (objectId === undefined || contentId === undefined) throw new Error("Fixture ids missing");
      layer.update(objectId, { text: "object-next" });
      layer.updateTextPositions([contentId], "content-next", new Float32Array([24, 0]));
      phase = "fault";
      SpatialIndex.prototype.set = function (...args: Parameters<SpatialIndex["set"]>): void {
        if (failSpatial) {
          failSpatial = false;
          throw spatialFailure;
        }
        spatialSet.apply(this, args);
      };

      await expect(layer.commit()).rejects.toBe(spatialFailure);
      expect(first.releases()).toBe(0);
      expect(second.releases()).toBe(0);

      expect(() => layer?.detach()).toThrow(firstReleaseFailure);
      expect(first.releases()).toBe(1);
      expect(second.releases()).toBe(1);
      expect(() => layer?.detach()).not.toThrow();

      layer.destroy();
      layer = undefined;
      expect(first.releases()).toBe(1);
      expect(second.releases()).toBe(1);
    } finally {
      RenderCoordinator.prototype.commit = coordinatorCommit;
      RenderCoordinator.prototype.applyContentLane = coordinatorContent;
      RenderCoordinator.prototype.getRun = coordinatorGetRun;
      RenderSurface.prototype.apply = surfaceApply;
      SpatialIndex.prototype.set = spatialSet;
      layer?.destroy();
    }
  });
});

function replayLayer(): TextLayer {
  return new TextLayer({
    renderer: fakeWebGlRenderer(),
    rendering: {
      layoutEngine: {
        layout(_slot, _revision, input) {
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster(2);
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    },
  });
}

function layerRenderResult(
  name: string,
  includeUploads: boolean,
  releaseError?: Error,
): {
  readonly result: Readonly<RenderCommitResult>;
  readonly releases: () => number;
} {
  let releases = 0;
  if (!includeUploads) {
    return {
      result: {
        revision: 1,
        stale: false,
        appliedLabels: 1,
        glyphs: 1,
        atlasUploads: 0,
        atlasCommit: { entries: [], uploads: [], externalUploads: [], evictedKeys: [] },
        drawOrderChanged: false,
      },
      releases: () => releases,
    };
  }
  const cpuEntry: Readonly<AtlasEntry> = {
    key: `${name}-cpu`,
    generation: 1,
    page: 0,
    layer: 0,
    mode: "alpha",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
  };
  const externalEntry: Readonly<AtlasEntry> = {
    ...cpuEntry,
    key: `${name}-external`,
    page: 1,
    layer: 0,
    mode: "color",
  };
  const externalUpload: Readonly<AtlasExternalUpload> = {
    entry: externalEntry,
    source: {
      texture: {} as GPUTexture,
      format: "rgba8unorm",
      width: 1,
      height: 1,
    },
    sourceX: 0,
    sourceY: 0,
    release() {
      releases += 1;
      if (releaseError !== undefined) throw releaseError;
    },
  };
  return {
    result: {
      revision: 1,
      stale: false,
      appliedLabels: 1,
      glyphs: 1,
      atlasUploads: 2,
      atlasCommit: {
        entries: [cpuEntry, externalEntry],
        uploads: [{ entry: cpuEntry, pixels: new Uint8Array([255]) }],
        externalUploads: [externalUpload],
        evictedKeys: [],
      },
      drawOrderChanged: true,
    },
    releases: () => releases,
  };
}

async function createOwnedFixture(
  options: {
    readonly sdf?: boolean;
    readonly canvasRasterizer?: (request: RasterGlyphRequest) => Promise<GlyphRaster>;
  } = {},
): Promise<{
  readonly layer: TextLayer;
  readonly gates: Map<string, () => void>;
}> {
  const gates = new Map<string, () => void>();
  let fontRevision = 0;
  const layer = new TextLayer({
    renderer: {} as Renderer,
    rendering: {
      layoutEngine: {
        layout(_slot, _revision, input) {
          return options.sdf === true ? sdfRun(input.text, fontRevision) : run(input.text);
        },
        destroy() {},
      },
      rasterizerOptions: {
        tinySdf: options.sdf === true,
        canvasRasterizer:
          options.canvasRasterizer ??
          ((request) =>
            new Promise((resolve) => {
              gates.set(request.glyphText, () => {
                resolve({
                  mode: request.mode,
                  width: 2,
                  height: 2,
                  pixels: new Uint8Array(request.mode === "color" ? 16 : 4).fill(255),
                });
              });
            })),
      },
    },
  });
  if (options.sdf === true) {
    fontRevision = (await layer.fonts.register({ family: "Fixture" })).revision;
  }
  return { layer, gates };
}

function alphaRaster(size: number): GlyphRaster {
  return {
    mode: "alpha",
    width: size,
    height: size,
    pixels: new Uint8Array(size * size).fill(255),
  };
}

function createFixture(): {
  readonly layer: TextLayer;
  readonly atlas: GlyphAtlas;
  readonly gates: Map<string, () => void>;
} {
  const atlas = new GlyphAtlas({ pageWidth: 16, pageHeight: 16, maxBytes: 1_024 });
  const gates = new Map<string, () => void>();
  const layer = new TextLayer({
    renderer: {} as Renderer,
    rendering: {
      atlas,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          return new Promise((resolve) => {
            gates.set(request.glyphText, () => {
              resolve({
                mode: request.mode,
                width: 2,
                height: 2,
                pixels: new Uint8Array(request.mode === "color" ? 16 : 4).fill(255),
              });
            });
          });
        },
        destroy() {},
      },
    },
  });
  return { layer, atlas, gates };
}

function run(text: string): Readonly<PositionedRun> {
  const glyph = [...text][0] ?? "?";
  return Object.freeze({
    source: "bitmap" as const,
    text,
    fontFamily: "sans-serif",
    fontRevision: 0,
    glyphCount: 1,
    direction: "ltr" as const,
    glyphIds: new Uint32Array([glyph.codePointAt(0) ?? 0]),
    glyphKeys: Object.freeze([glyph]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([8]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    bounds: Object.freeze({ x: 0, y: 0, width: 8, height: 10 }),
  });
}

function sdfRun(text: string, fontRevision: number): Readonly<PositionedRun> {
  const glyph = [...text][0] ?? "?";
  return Object.freeze({
    source: "harfbuzz" as const,
    text,
    fontFamily: "Fixture",
    fontRevision,
    glyphCount: 1,
    direction: "ltr" as const,
    glyphIds: new Uint32Array([glyph.codePointAt(0) ?? 0]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([8]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    bounds: Object.freeze({ x: 0, y: 0, width: 8, height: 10 }),
  });
}

async function waitForGate(gates: Map<string, () => void>, key: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (gates.has(key)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for raster gate: ${key}`);
}

async function waitFor(predicate: () => boolean, name: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${name}`);
}

function fakeWebGlRenderer(): Renderer {
  return {
    gl: {
      MAX_TEXTURE_SIZE: 0x0d33,
      getParameter: () => 4_096,
    },
    buffer: { updateBuffer() {} },
  } as unknown as Renderer;
}
