import { describe, expect, test } from "bun:test";

import type { Renderer } from "pixi.js";

import { TextLayer, type PositionedRun } from "../src";
import { RenderCoordinator } from "../src/advanced";
import { compactVisibleInstances } from "../src/culling/computeCull";
import { GpuResidentScene } from "../src/render/GpuResidentScene";
import { packF16, unpackF16 } from "../src/render/pack";
import { packResidentRotation, writeResidentRotatedAabbF32 } from "../src/render/paletteStorage";
import { RenderSurface } from "../src/render/RenderSurface";
import { TextStore } from "../src/store/TextStore";
import { TextDirty } from "../src/store/types";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

const RUN = repeatedRun(1);
const TWO_GLYPH_RUN = repeatedRun(2);
const CAPACITY_LIMIT_RUN = repeatedRun(4_097);
const F32_EDGE_RUN: Readonly<PositionedRun> = Object.freeze({
  ...RUN,
  bounds: Object.freeze({ x: 2.25, y: 0, width: 9, height: 10 }),
});

describe("TextLayer GPU-resident scene", () => {
  test("keeps viewport residency as the default public contract", () => {
    const layer = new TextLayer({ rendering: false });

    expect(layer.stats).toMatchObject({
      residencyRequested: "viewport",
      residencyActive: "viewport",
      gpuResidentLabels: 0,
      gpuScenePrototypeCount: 0,
      gpuScenePaintCount: 0,
      gpuScenePerLabelObjectCount: 0,
      deferredSpatialLabels: 0,
      cullRecordUploadBytes: 0,
      lastSceneSetupMs: 0,
    });
    expect(layer.stats.residencyFallbackReason).toBeUndefined();

    layer.destroy();
  });

  test("reports an unavailable renderer when GPU scene is requested while detached", () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { residency: "gpu-scene" },
    });

    expect(layer.stats).toMatchObject({
      residencyRequested: "gpu-scene",
      residencyActive: "viewport",
      residencyFallbackReason: "renderer-unavailable",
    });

    layer.destroy();
  });

  test("reports that GPU scene requires WebGPU on a WebGL renderer", () => {
    const layer = new TextLayer({
      renderer: fakeWebGlRenderer(),
      culling: { residency: "gpu-scene" },
    });

    expect(layer.stats).toMatchObject({
      residencyRequested: "gpu-scene",
      residencyActive: "viewport",
      residencyFallbackReason: "webgpu-required",
    });

    layer.destroy();
  });

  test("reports collision eligibility before renderer capability", () => {
    const layer = new TextLayer({
      renderer: fakeWebGlRenderer(),
      culling: { residency: "gpu-scene", collision: {} },
    });

    expect(layer.stats).toMatchObject({
      residencyActive: "viewport",
      residencyFallbackReason: "collision-enabled",
    });

    layer.destroy();
  });

  test("re-evaluates renderer fallback across detach and reattach", () => {
    const webgl = fakeWebGlRenderer();
    const layer = new TextLayer({
      renderer: webgl,
      culling: { residency: "gpu-scene" },
    });

    expect(layer.stats.residencyFallbackReason).toBe("webgpu-required");
    layer.detach();
    expect(layer.stats.residencyFallbackReason).toBe("renderer-unavailable");
    layer.attach(webgl);
    expect(layer.stats.residencyFallbackReason).toBe("webgpu-required");

    layer.destroy();
  });

  test("reports an unavailable compute pipeline on WebGPU", () => {
    const renderer = {
      gpu: {
        device: {
          limits: { maxTextureDimension2D: 8_192 },
          createShaderModule(): never {
            throw new Error("fixture compute pipeline failure");
          },
        },
      },
      buffer: { updateBuffer(): void {} },
      encoder: { draw(): void {} },
    } as unknown as Renderer;
    const layer = new TextLayer({
      renderer,
      culling: { residency: "gpu-scene" },
    });

    expect(layer.stats).toMatchObject({
      residencyActive: "viewport",
      residencyFallbackReason: "compute-cull-unavailable",
    });

    layer.destroy();
  });

  test("reports an unavailable storage palette after compute succeeds", () => {
    let shaderModules = 0;
    const renderer = {
      gpu: {
        device: {
          limits: {
            maxTextureDimension2D: 8_192,
            maxStorageBuffersInVertexStage: 1,
            maxStorageBufferBindingSize: 128 * 1_024 * 1_024,
            maxBufferSize: 128 * 1_024 * 1_024,
          },
          createShaderModule() {
            shaderModules += 1;
            if (shaderModules === 2) throw new Error("fixture palette pipeline failure");
            return {};
          },
          createBindGroupLayout: () => ({}),
          createPipelineLayout: () => ({}),
          createComputePipeline: () => ({}),
        },
      },
      buffer: { updateBuffer(): void {} },
      encoder: { draw(): void {} },
    } as unknown as Renderer;
    const restoreGpuGlobals = installWebGpuGlobals({
      GPUShaderStage: { COMPUTE: 4 },
    });
    try {
      const layer = new TextLayer({
        renderer,
        culling: { residency: "gpu-scene" },
      });

      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "storage-palette-unavailable",
      });

      layer.destroy();
    } finally {
      restoreGpuGlobals();
    }
  });

  test("keeps camera and position waves on the active GPU scene", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: residentCulling(),
        rendering: {
          layoutEngine: { layout: () => TWO_GLYPH_RUN, destroy() {} },
          glyphProvider: {
            async rasterize() {
              return alphaRaster();
            },
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      const ids = layer.createMany([
        { text: "g", x: 1, y: 1 },
        { text: "g", x: 20, y: 20 },
        { text: "g", x: 40, y: 40 },
      ]);

      await layer.commit();
      const compact = fixture.buffers.find(
        (buffer) => buffer.label === "pixi-glyphflow-cull-instances-out",
      );
      expect(compact?.size).toBeGreaterThanOrEqual(ids.length * 2 * 8);
      expect(layer.stats).toMatchObject({
        residencyRequested: "gpu-scene",
        residencyActive: "gpu-scene",
        gpuResidentLabels: 3,
        gpuScenePrototypeCount: 1,
        gpuScenePerLabelObjectCount: 0,
        visibleLabelCount: 3,
        cullPath: "compute-cull",
        palettePath: "storage",
      });
      expect(layer.stats.residencyFallbackReason).toBeUndefined();
      expect(layer.stats.lastSceneSetupMs).toBeGreaterThan(0);
      const setupMs = layer.stats.lastSceneSetupMs;
      const cameraBefore = layer.stats;

      layer.setViewportBounds({ x: 0.25, y: 0, width: 100, height: 100 });
      await layer.commit();
      expect(layer.stats.cullingQueries - cameraBefore.cullingQueries).toBe(0);
      expect(layer.stats.offscreenInspectedLabels).toBe(0);
      expect(layer.stats.offscreenMaterializedLabels).toBe(0);
      expect(layer.stats.lastRenderCoordinatorMs).toBe(0);
      expect(layer.stats.cullRecordUploadBytes - cameraBefore.cullRecordUploadBytes).toBe(0);
      expect(layer.stats.lastSceneSetupMs).toBe(setupMs);

      const first = ids[0];
      const third = ids[2];
      if (first === undefined || third === undefined) throw new Error("Fixture ids missing");
      const initialBounds = layer.getBoundsFor(first);
      if (initialBounds === undefined) throw new Error("Fixture bounds missing");
      const positionBefore = layer.stats;
      const eventStart = fixture.submits.length;
      layer.updatePositions(new Float64Array([first, third]), new Float32Array([10, 11, 50, 51]));
      expect(layer.stats.deferredSpatialLabels).toBe(2);
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        deferredSpatialLabels: 2,
      });
      expect(layer.stats.cullingQueries - positionBefore.cullingQueries).toBe(0);
      expect(layer.stats.cullRecordUploadBytes - positionBefore.cullRecordUploadBytes).toBe(0);
      expect(layer.stats.transformUploadBytes - positionBefore.transformUploadBytes).toBe(40);
      expect(fixture.submits.slice(eventStart)).toEqual([
        "pixi-glyphflow-fused-resident-move-patch",
        "pixi-glyphflow-compute-cull",
      ]);
      expect(layer.getBoundsFor(first)).toMatchObject({
        x: 10,
        y: 11,
        width: initialBounds.width,
        height: initialBounds.height,
      });
      expect(layer.stats.deferredSpatialLabels).toBe(0);

      layer.destroy();
    } finally {
      restore();
    }
  });

  test("keeps interleaved strings and canonical fills in one GPU-resident scene", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: residentCulling(200, 200),
        rendering: {
          layoutEngine: {
            layout(_slot, _revision, input) {
              return heterogeneousRun(input.text);
            },
            destroy() {},
          },
          glyphProvider: {
            async rasterize() {
              return alphaRaster();
            },
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      const red = Object.freeze({ fontFamily: "sans-serif", fontSize: 16, fill: 0xff0000 });
      const green = Object.freeze({ fontFamily: "sans-serif", fontSize: 16, fill: "#00ff00" });
      const specs = Array.from({ length: 8 }, (_, slot) => ({
        text: slot % 4 < 2 ? "A" : "B",
        x: slot * 10,
        y: slot * 10,
        style: slot % 2 === 0 ? red : green,
      }));
      layer.createMany(specs);

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 8,
        gpuScenePrototypeCount: 2,
        gpuScenePaintCount: 2,
        drawCalls: 1,
      });
      expect(layer.stats.residencyFallbackReason).toBeUndefined();

      layer.create({ text: "A", x: 100, y: 100, style: { ...red, fill: "#ff0000" } });
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 9,
        gpuScenePrototypeCount: 2,
        gpuScenePaintCount: 2,
        drawCalls: 1,
      });

      layer.destroy();
    } finally {
      restore();
    }
  });

  test("falls back in the same commit when exact prototype cardinality reaches 65", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createHeterogeneousResidentLayer(fixture.renderer);
      layer.createMany(
        Array.from({ length: 65 }, (_, index) => ({
          text: String.fromCodePoint(0x400 + index),
          x: index,
          y: index,
        })),
      );

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
        gpuResidentLabels: 0,
        gpuScenePrototypeCount: 0,
        gpuScenePaintCount: 0,
        visibleLabelCount: 65,
      });
      expect(layer.stats.submittedGlyphs).toBe(65);

      layer.destroy();
    } finally {
      restore();
    }
  });

  test("falls back in the same commit when canonical paint cardinality reaches 9", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createHeterogeneousResidentLayer(fixture.renderer);
      layer.createMany(
        Array.from({ length: 9 }, (_, index) => ({
          text: "A",
          x: index * 10,
          y: index * 10,
          style: { fontFamily: "sans-serif", fontSize: 16, fill: index + 1 },
        })),
      );

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
        gpuResidentLabels: 0,
        gpuScenePrototypeCount: 0,
        gpuScenePaintCount: 0,
        visibleLabelCount: 9,
      });
      expect(layer.stats.submittedGlyphs).toBe(9);

      layer.destroy();
    } finally {
      restore();
    }
  });

  test("preflights prototype and paint overflow before offscreen layout or raster work", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    let layoutCalls = 0;
    let rasterCalls = 0;
    try {
      const layer = createHeterogeneousResidentLayer(fixture.renderer, {
        onLayout: () => {
          layoutCalls += 1;
        },
        onRaster: () => {
          rasterCalls += 1;
        },
      });
      layer.createMany(
        Array.from({ length: 65 }, (_, index) => ({
          text: String.fromCodePoint(0x500 + index),
          x: 10_000 + index,
          y: 10_000 + index,
          style: {
            fontFamily: `Fixture-${String(index)}`,
            fontSize: 16,
            fill: 0xffffff,
          },
        })),
      );

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
        visibleLabelCount: 0,
      });
      expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 0, rasterCalls: 0 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("groups fresh render-equivalent styles with zero resident snapshot allocation", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const snapshotAt = TextStore.prototype.snapshotAt;
    let snapshotCalls = 0;
    let layoutCalls = 0;
    TextStore.prototype.snapshotAt = function (slot) {
      snapshotCalls += 1;
      return snapshotAt.call(this, slot);
    };
    try {
      const layer = createHeterogeneousResidentLayer(fixture.renderer, {
        onLayout: () => {
          layoutCalls += 1;
        },
      });
      layer.createMany(
        Array.from({ length: 80 }, (_, index) => ({
          text: "A",
          x: index % 20,
          y: Math.floor(index / 20),
          style: {
            fontFamily: "sans-serif",
            fontSize: 16,
            fill: index % 8,
          },
        })),
      );
      snapshotCalls = 0;

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 80,
        gpuScenePrototypeCount: 1,
        gpuScenePaintCount: 8,
      });
      expect({ snapshotCalls, layoutCalls }).toEqual({ snapshotCalls: 0, layoutCalls: 1 });
      layer.destroy();
    } finally {
      TextStore.prototype.snapshotAt = snapshotAt;
      restore();
    }
  });

  test("coalesces duplicate resident movers before commit and preserves precommit queries", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const ids = layer.createMany([
        { text: "g", x: 1, y: 1 },
        { text: "g", x: 20, y: 20 },
      ]);
      await layer.commit();
      const first = ids[0];
      const second = ids[1];
      if (first === undefined || second === undefined) throw new Error("Fixture ids missing");
      const writesBefore = fixture.writes.length;
      const uploadBefore = layer.stats.transformUploadBytes;

      expect(layer.updatePositions([first], new Float32Array([10, 11]))).toBe(1);
      expect(
        layer.updatePositions(
          new Float64Array([first, second, first]),
          new Float64Array([30, 31, 40, 41, 50, 51]),
        ),
      ).toBe(3);
      expect(layer.stats.deferredSpatialLabels).toBe(2);
      expect(layer.getBoundsFor(first)).toMatchObject({ x: 50, y: 51 });
      expect(layer.stats.deferredSpatialLabels).toBe(0);
      expect(layer.updatePositions([first], new Float32Array([60, 61]))).toBe(1);
      expect(layer.stats.deferredSpatialLabels).toBe(1);
      expect(layer.hitTest({ x: 61, y: 62 })).toBe(first);
      expect(layer.stats.deferredSpatialLabels).toBe(0);

      await layer.commit();
      const commandWrites = fixture.writes
        .slice(writesBefore)
        .filter((write) => write.buffer.label === "pixi-glyphflow-palette-move-commands");
      expect(commandWrites).toHaveLength(1);
      const command = commandWrites[0];
      if (command === undefined) throw new Error("Resident mover command write is missing");
      const words = new Uint32Array(command.bytes.slice().buffer);
      const floats = new Float32Array(command.bytes.slice().buffer);
      expect([words[0], floats[1], floats[2]]).toEqual([0, 60, 61]);
      expect([words[3], floats[4], floats[5]]).toEqual([1, 40, 41]);
      expect(layer.stats.transformUploadBytes - uploadBefore).toBe(40);
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        lastCommitDirtyLabels: 2,
        lastCommitTransformLabels: 2,
      });

      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rebinds grown TextStore origins before resident append and later moves", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer, 1);
      layer.create({ text: "g", x: 1, y: 2 });
      await layer.commit();
      const appended = layer.create({ text: "g", x: 20, y: 30 });
      await layer.commit();

      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 2,
      });
      expect(layer.updatePositions(new Float64Array([appended]), new Float32Array([70, 80]))).toBe(
        1,
      );
      await layer.commit();
      expect(layer.getBoundsFor(appended)).toMatchObject({ x: 70, y: 80, width: 8, height: 10 });
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("resets and rebuilds resident state around compacted origin columns", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer, 64);
      const id = layer.create({ text: "g", x: 1, y: 2 });
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");

      expect(layer.compact()).toMatchObject({ beforeCapacity: 64, afterCapacity: 16 });
      expect(layer.stats).toMatchObject({
        residencyRequested: "gpu-scene",
        residencyActive: "viewport",
        residencyFallbackReason: undefined,
      });
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      expect(layer.updatePositions(new Float64Array([id]), new Float32Array([40, 50]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 50 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rebuilds the same commit CPU selection after a resident palette move write failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      expect(layer.stats.submittedGlyphs).toBe(1);

      expect(layer.updatePositions(new Float64Array([id]), new Float32Array([150, 10]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      await layer.commit();

      expect(layer.getBoundsFor(id)).toMatchObject({ x: 150, y: 10, width: 8, height: 10 });
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        cullPath: "cpu-grid",
        submittedGlyphs: 0,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("uploads the current CPU palette position during resident move failure recovery", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      const writeStart = fixture.writes.length;

      expect(layer.updatePositions(new Float64Array([id]), new Float32Array([40, 50]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      await layer.commit();

      const recoveryWrite = fixture.writes.slice(writeStart).find((write) => {
        return write.bytes.byteLength === 16 && containsPosition(write.bytes, 40, 50, 8);
      });
      expect(recoveryWrite).toBeDefined();
      expect(recoveryWrite?.bufferOffset).toBe(0);
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 50 });
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        cullPath: "cpu-grid",
        submittedGlyphs: 1,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("releases an over-limit mover lease through CPU recovery and later GPU rebuild", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();

      fixture.controls.maxComputeWorkgroupsPerDimension = 0;
      expect(layer.updatePositions([id], new Float32Array([40, 50]))).toBe(1);
      await expect(layer.commit()).resolves.toBeDefined();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 50 });
      expect(layer.hitTest({ x: 41, y: 51 })).toBe(id);
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        cullPath: "cpu-grid",
        pendingDirtyLabels: 0,
      });

      fixture.controls.maxComputeWorkgroupsPerDimension = 65_535;
      layer.detach();
      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      expect(layer.updatePositions([id], new Float32Array([60, 70]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 60, y: 70 });
      expect(layer.stats.pendingDirtyLabels).toBe(0);
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("leases overlapping resident commits independently", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();
      const writesBefore = fixture.writes.length;

      expect(layer.updatePositions([id], new Float32Array([10, 11]))).toBe(1);
      const firstCommit = layer.commit();
      expect(layer.updatePositions([id], new Float32Array([20, 21]))).toBe(1);
      const secondCommit = layer.commit();
      await Promise.all([firstCommit, secondCommit]);

      const commandWrites = fixture.writes
        .slice(writesBefore)
        .filter((write) => write.buffer.label === "pixi-glyphflow-palette-move-commands");
      expect(commandWrites).toHaveLength(2);
      expect(commandWrites.map((write) => write.bytes.byteLength)).toEqual([8, 8]);
      expect(
        Array.from(new Float32Array(commandWrites[0]!.bytes.slice().buffer).subarray(0, 2)),
      ).toEqual([10, 11]);
      expect(
        Array.from(new Float32Array(commandWrites[1]!.bytes.slice().buffer).subarray(0, 2)),
      ).toEqual([20, 21]);
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 20, y: 21 });

      layer.destroy();
    } finally {
      restore();
    }
  });

  test("publishes the latest overlapping resident lease after an earlier palette failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      const writeStart = fixture.writes.length;

      expect(layer.updatePositions([id], new Float32Array([150, 10]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      const firstCommit = layer.commit();
      expect(layer.updatePositions([id], new Float32Array([40, 50]))).toBe(1);
      const secondCommit = layer.commit();
      const settled = await Promise.allSettled([firstCommit, secondCommit]);

      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 50, width: 8, height: 10 });
      expect(layer.hitTest({ x: 41, y: 51 })).toBe(id);
      expect(layer.hitTest({ x: 151, y: 11 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        visibleLabelCount: 1,
        submittedGlyphs: 1,
        pendingDirtyLabels: 0,
      });
      let latestPaletteWrite: (typeof fixture.writes)[number] | undefined;
      for (let index = fixture.writes.length - 1; index >= writeStart; index -= 1) {
        const write = fixture.writes[index];
        if (write === undefined || write.bytes.byteLength !== 16) continue;
        if (containsPosition(write.bytes, 40, 50, 8)) {
          latestPaletteWrite = write;
          break;
        }
      }
      expect(latestPaletteWrite).toBeDefined();

      expect(layer.updatePositions([id], new Float32Array([60, 70]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 60, y: 70 });
      expect(layer.stats.pendingDirtyLabels).toBe(0);

      layer.detach();
      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      const secondWriteStart = fixture.writes.length;

      expect(layer.updatePositions([id], new Float32Array([160, 10]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      const thirdCommit = layer.commit();
      expect(layer.updatePositions([id], new Float32Array([30, 40]))).toBe(1);
      const fourthCommit = layer.commit();
      expect(layer.updatePositions([id], new Float32Array([70, 80]))).toBe(1);
      const fifthCommit = layer.commit();
      const secondSettled = await Promise.allSettled([thirdCommit, fourthCommit, fifthCommit]);

      expect(secondSettled.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 70, y: 80, width: 8, height: 10 });
      expect(layer.hitTest({ x: 71, y: 81 })).toBe(id);
      expect(layer.hitTest({ x: 161, y: 11 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        visibleLabelCount: 1,
        submittedGlyphs: 1,
        pendingDirtyLabels: 0,
      });
      let finalPaletteWrite: (typeof fixture.writes)[number] | undefined;
      for (let index = fixture.writes.length - 1; index >= secondWriteStart; index -= 1) {
        const write = fixture.writes[index];
        if (write === undefined || write.bytes.byteLength !== 16) continue;
        if (containsPosition(write.bytes, 70, 80, 8)) {
          finalPaletteWrite = write;
          break;
        }
      }
      expect(finalPaletteWrite).toBeDefined();

      expect(layer.updatePositions([id], new Float32Array([90, 91]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 90, y: 91, width: 8, height: 10 });
      expect(layer.stats.pendingDirtyLabels).toBe(0);
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("publishes disjoint resident leases queued behind a failed mover", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const first = layer.create({ text: "g", x: 10, y: 10 });
      const second = layer.create({ text: "g", x: 30, y: 30 });
      await layer.commit();
      const writeStart = fixture.writes.length;

      expect(layer.updatePositions([first], new Float32Array([150, 10]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      const failedOwner = layer.commit();
      expect(layer.updatePositions([first], new Float32Array([40, 50]))).toBe(1);
      const firstFollower = layer.commit();
      expect(layer.updatePositions([second], new Float32Array([70, 80]))).toBe(1);
      const secondFollower = layer.commit();
      const settled = await Promise.allSettled([failedOwner, firstFollower, secondFollower]);

      expect(settled.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);
      expect(layer.getBoundsFor(first)).toMatchObject({ x: 40, y: 50 });
      expect(layer.getBoundsFor(second)).toMatchObject({ x: 70, y: 80 });
      expect(layer.hitTest({ x: 41, y: 51 })).toBe(first);
      expect(layer.hitTest({ x: 71, y: 81 })).toBe(second);
      expect(layer.hitTest({ x: 151, y: 11 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        visibleLabelCount: 2,
        submittedGlyphs: 2,
        pendingDirtyLabels: 0,
      });
      const recoveredPositions = new Set<string>();
      for (const write of fixture.writes.slice(writeStart)) {
        const values = float32View(write.bytes);
        for (let offset = 0; offset + 1 < values.length; offset += 8) {
          recoveredPositions.add(`${String(values[offset])},${String(values[offset + 1])}`);
        }
      }
      expect(recoveredPositions.has("40,50")).toBe(true);
      expect(recoveredPositions.has("70,80")).toBe(true);

      layer.detach();
      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.updatePositions([first, second], new Float32Array([20, 25, 60, 65]))).toBe(2);
      await layer.commit();
      expect(layer.getBoundsFor(first)).toMatchObject({ x: 20, y: 25 });
      expect(layer.getBoundsFor(second)).toMatchObject({ x: 60, y: 65 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("publishes an overlapping ordinary mover after an earlier resident palette failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      const writeStart = fixture.writes.length;
      const textureWriteStart = fixture.textureWrites.length;

      expect(layer.updatePositions([id], new Float32Array([150, 10]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      const firstCommit = layer.commit();
      expect(layer.update(id, { x: 40, y: 50 })).toBe(true);
      const secondCommit = layer.commit();
      const settled = await Promise.allSettled([firstCommit, secondCommit]);

      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 50 });
      expect(layer.hitTest({ x: 41, y: 51 })).toBe(id);
      expect(layer.hitTest({ x: 151, y: 11 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        visibleLabelCount: 1,
        submittedGlyphs: 1,
        pendingDirtyLabels: 0,
      });
      let latestPaletteWrite: (typeof fixture.writes)[number] | undefined;
      for (let index = fixture.writes.length - 1; index >= writeStart; index -= 1) {
        const write = fixture.writes[index];
        if (write === undefined) continue;
        if (containsPosition(write.bytes, 40, 50, 8)) latestPaletteWrite = write;
        if (latestPaletteWrite !== undefined) break;
      }
      const latestPaletteTextureWrite = fixture.textureWrites
        .slice(textureWriteStart)
        .find((write) => {
          if (write.texture.label !== "pixi-glyphflow-transforms") return false;
          return containsPosition(write.bytes, 40, 50, 4);
        });
      expect(latestPaletteWrite ?? latestPaletteTextureWrite).toBeDefined();

      expect(layer.update(id, { x: 60, y: 70 })).toBe(true);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 60, y: 70 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("publishes an overlapping resident append after an earlier palette failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const first = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      const writeStart = fixture.writes.length;
      const textureWriteStart = fixture.textureWrites.length;

      expect(layer.updatePositions([first], new Float32Array([20, 20]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      const firstCommit = layer.commit();
      const appended = layer.create({ text: "g", x: 40, y: 50 });
      const secondCommit = layer.commit();
      const settled = await Promise.allSettled([firstCommit, secondCommit]);

      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(layer.getBoundsFor(appended)).toMatchObject({ x: 40, y: 50 });
      expect(layer.hitTest({ x: 41, y: 51 })).toBe(appended);
      expect(layer.stats).toMatchObject({
        visibleLabelCount: 2,
        submittedGlyphs: 2,
        pendingDirtyLabels: 0,
      });
      const appendedPaletteWrite = fixture.writes.slice(writeStart).find((write) => {
        return containsPosition(write.bytes, 40, 50, 8);
      });
      const appendedPaletteTextureWrite = fixture.textureWrites
        .slice(textureWriteStart)
        .find((write) => {
          if (write.texture.label !== "pixi-glyphflow-transforms") return false;
          return containsPosition(write.bytes, 40, 50, 4);
        });
      expect(appendedPaletteWrite ?? appendedPaletteTextureWrite).toBeDefined();

      expect(layer.updatePositions([appended], new Float32Array([60, 70]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(appended)).toMatchObject({ x: 60, y: 70 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("publishes an overlapping resident removal after an earlier palette failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const first = layer.create({ text: "g", x: 10, y: 10 });
      const removed = layer.create({ text: "g", x: 40, y: 50 });
      await layer.commit();
      const writeStart = fixture.writes.length;
      const textureWriteStart = fixture.textureWrites.length;

      expect(layer.updatePositions([first], new Float32Array([20, 20]))).toBe(1);
      fixture.controls.failNextPaletteMoveWrite = true;
      const firstCommit = layer.commit();
      expect(layer.updatePositions([removed], new Float32Array([60, 70]))).toBe(1);
      expect(layer.remove(removed)).toBe(true);
      const secondCommit = layer.commit();
      const settled = await Promise.allSettled([firstCommit, secondCommit]);

      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(layer.get(removed)).toBeUndefined();
      expect(layer.getBoundsFor(first)).toMatchObject({ x: 20, y: 20 });
      expect(layer.hitTest({ x: 21, y: 21 })).toBe(first);
      expect(layer.hitTest({ x: 41, y: 51 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        visibleLabelCount: 1,
        submittedGlyphs: 1,
        pendingDirtyLabels: 0,
      });
      const currentPaletteWrite = fixture.writes.slice(writeStart).find((write) => {
        return containsPosition(write.bytes, 20, 20, 8);
      });
      const currentPaletteTextureWrite = fixture.textureWrites
        .slice(textureWriteStart)
        .find((write) => {
          if (write.texture.label !== "pixi-glyphflow-transforms") return false;
          return containsPosition(write.bytes, 20, 20, 4);
        });
      expect(currentPaletteWrite ?? currentPaletteTextureWrite).toBeDefined();

      expect(layer.updatePositions([first], new Float32Array([30, 30]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(first)).toMatchObject({ x: 30, y: 30 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("lets removal win when one resident commit moves and removes the same label", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();

      expect(layer.updatePositions([id], new Float32Array([100, 200]))).toBe(1);
      expect(layer.remove(id)).toBe(true);
      await expect(layer.commit()).resolves.toBeDefined();

      expect(layer.get(id)).toBeUndefined();
      expect(layer.hitTest({ x: 101, y: 201 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 0,
        visibleLabelCount: 0,
        pendingDirtyLabels: 0,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("keeps one dense move lease when the middle label is removed in the same commit", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const { layer, ids } = await createThreeResidentLabels(fixture.renderer);
      const writeStart = fixture.writes.length;
      const uploadStart = layer.stats.transformUploadBytes;

      expect(layer.updatePositions(ids, new Float32Array([100, 110, 200, 210, 300, 310]))).toBe(3);
      expect(layer.remove(ids[1]!)).toBe(true);
      await layer.commit();

      expectThreeLabelMoveWrite(fixture.writes, writeStart);
      expect(layer.stats.transformUploadBytes - uploadStart).toBe(40);
      expect(layer.getBoundsFor(ids[0]!)).toMatchObject({ x: 100, y: 110 });
      expect(layer.get(ids[1]!)).toBeUndefined();
      expect(layer.hitTest({ x: 201, y: 211 })).toBeUndefined();
      expect(layer.getBoundsFor(ids[2]!)).toMatchObject({ x: 300, y: 310 });
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 2,
        visibleLabelCount: 2,
        pendingDirtyLabels: 0,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("keeps one dense move lease when every moved label is removed in the same commit", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const { layer, ids } = await createThreeResidentLabels(fixture.renderer);
      const writeStart = fixture.writes.length;
      const uploadStart = layer.stats.transformUploadBytes;

      expect(layer.updatePositions(ids, new Float32Array([100, 110, 200, 210, 300, 310]))).toBe(3);
      expect(ids.map((id) => layer.remove(id))).toEqual([true, true, true]);
      await layer.commit();

      expectThreeLabelMoveWrite(fixture.writes, writeStart);
      expect(layer.stats.transformUploadBytes - uploadStart).toBe(40);
      expect(ids.map((id) => layer.get(id))).toEqual([undefined, undefined, undefined]);
      expect(layer.hitTest({ x: 101, y: 111 })).toBeUndefined();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 0,
        visibleLabelCount: 0,
        pendingDirtyLabels: 0,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("keeps f32 AABB edges identical for resident hit tests and CPU fallback", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: {
          bounds: { x: 16_777_216, y: 0, width: 1, height: 10 },
          residency: "gpu-scene",
        },
        rendering: {
          layoutEngine: { layout: () => F32_EDGE_RUN, destroy() {} },
          glyphProvider: {
            async rasterize() {
              return alphaRaster();
            },
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      const id = layer.create({ text: "g", x: 16_777_206, y: 0 });
      await layer.commit();

      expect(layer.getBoundsFor(id)).toMatchObject({ x: 16_777_208, width: 9 });
      expect(layer.hitTest({ x: 16_777_216, y: 1 })).toBe(id);
      expect(layer.hitTest({ x: 16_777_217, y: 1 })).toBeUndefined();

      expect(layer.update(id, { alpha: 0.5 })).toBe(true);
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
      });
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 16_777_208, width: 9 });
      expect(layer.hitTest({ x: 16_777_216, y: 1 })).toBe(id);
      expect(layer.hitTest({ x: 16_777_217, y: 1 })).toBeUndefined();
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("preserves final values across resident mover fallback, slot reuse, and detach", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();

      expect(layer.updatePositions([id], new Float64Array([50.5, 60.25]))).toBe(1);
      expect(
        layer.update(id, { text: "x", alpha: 0.5, style: { fill: 0xff00ff, fontSize: 8 } }),
      ).toBe(true);
      expect(layer.stats).toMatchObject({
        pendingDirtyLabels: 1,
        pendingDirtyMask: TextDirty.Content | TextDirty.Style | TextDirty.Transform,
      });
      await layer.commit();
      expect(layer.get(id)).toMatchObject({ text: "x", x: 50.5, y: 60.25 });
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
      });

      layer.detach();
      layer.update(id, { alpha: 1 });
      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.get(id)).toMatchObject({ text: "x", x: 50.5, y: 60.25 });
      expect(layer.stats.residencyActive).toBe("gpu-scene");

      expect(layer.updatePositions([id], new Float32Array([70, 80]))).toBe(1);
      expect(layer.remove(id)).toBe(true);
      const reused = layer.create({ text: "g", x: 90, y: 91 });
      expect(reused).not.toBe(id);
      await layer.commit();
      expect(layer.get(id)).toBeUndefined();
      expect(layer.get(reused)).toMatchObject({ text: "g", x: 90, y: 91 });
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("settles an in-flight resident mover lease after destroy", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();

      expect(layer.updatePositions([id], new Float32Array([10, 11]))).toBe(1);
      const pending = layer.commit();
      layer.destroy();
      await expect(pending).resolves.toBeDefined();
    } finally {
      restore();
    }
  });

  test("releases an in-flight resident mover lease across detach and rebuilds on attach", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();

      expect(layer.updatePositions([id], new Float32Array([30, 31]))).toBe(1);
      const pending = layer.commit();
      layer.detach();
      await expect(pending).resolves.toBeDefined();
      expect(layer.get(id)).toMatchObject({ x: 30, y: 31 });

      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 30, y: 31, width: 8, height: 10 });
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        pendingDirtyLabels: 0,
      });
      expect(layer.updatePositions([id], new Float32Array([40, 41]))).toBe(1);
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 41, width: 8, height: 10 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("reconciles resident mover records after an aborted Pixi submission", async () => {
    const fixture = fakeResidentWebGpuRenderer({ frameTransactions: true });
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const id = layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();
      fixture.renderFrame();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        frameTransactionFusedSubmissions: 1,
        frameTransactionStandaloneSubmissions: 0,
      });

      expect(layer.updatePositions(new Float64Array([id]), new Float32Array([150, 12]))).toBe(1);
      await layer.commit();
      fixture.controls.failNextFrameSubmit = true;
      expect(() => fixture.renderFrame()).toThrow("injected resident frame submit failure");

      const beforeRecoveryBytes = layer.stats.cullRecordUploadBytes;
      await layer.commit();
      const recordWrites = fixture.writes.filter(
        (write) => write.buffer.label === "pixi-glyphflow-cull-records",
      );
      const recovered = recordWrites.at(-1);
      expect(recovered).toBeDefined();
      if (recovered === undefined) throw new Error("Recovered resident record upload is missing");
      const recoveredRecords = recovered.bytes.slice().buffer;
      const recoveredFloats = new Float32Array(recoveredRecords);
      expect(Array.from(recoveredFloats.subarray(0, 4))).toEqual([150, 12, 158, 22]);
      expect(
        compactVisibleInstances(recoveredRecords, 1, new ArrayBuffer(8), {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          padding: 0,
        }).instanceCount,
      ).toBe(0);
      expect(layer.stats.cullRecordUploadBytes - beforeRecoveryBytes).toBe(32);

      fixture.renderFrame();
      await layer.commit();
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 150, y: 12, width: 8, height: 10 });
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        residencyFallbackReason: undefined,
        frameTransactionFusedSubmissions: 2,
        frameTransactionStandaloneSubmissions: 0,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rebuilds resident records and local bounds on a replacement device before later movers", async () => {
    const fixture = fakeResidentWebGpuRenderer({ frameTransactions: true });
    const replacement = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const ids = [
        layer.create({ text: "g", x: 1, y: 1 }),
        layer.create({ text: "g", x: 20, y: 1 }),
        layer.create({ text: "g", x: 40, y: 1 }),
      ];
      await layer.commit();
      fixture.renderFrame();
      const cullBytes = layer.stats.cullRecordUploadBytes;
      const replacementDevice = (replacement.renderer as unknown as { gpu: { device: GPUDevice } })
        .gpu.device;
      (fixture.renderer as unknown as { gpu: { device: GPUDevice } }).gpu.device =
        replacementDevice;

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        cullPath: "compute-cull",
      });
      expect(layer.stats.cullRecordUploadBytes - cullBytes).toBe(3 * 32);
      expect(
        replacement.writes.some(
          (write) => write.buffer.label === "pixi-glyphflow-resident-local-bounds",
        ),
      ).toBe(true);
      fixture.renderFrame();
      await layer.commit();

      const denseStart = layer.stats.transformUploadBytes;
      expect(layer.updatePositions([ids[0]!, ids[1]!], new Float32Array([10, 11, 30, 31]))).toBe(2);
      await layer.commit();
      expect(layer.stats.transformUploadBytes - denseStart).toBe(32);
      expect(layer.stats).toMatchObject({ residencyActive: "gpu-scene", cullPath: "compute-cull" });
      fixture.renderFrame();

      const indexedStart = layer.stats.transformUploadBytes;
      expect(layer.updatePositions([ids[2]!, ids[0]!], new Float32Array([50, 51, 12, 13]))).toBe(2);
      await layer.commit();
      expect(layer.stats.transformUploadBytes - indexedStart).toBe(40);
      expect(layer.stats).toMatchObject({ residencyActive: "gpu-scene", cullPath: "compute-cull" });
      fixture.renderFrame();
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("acknowledges synchronous device recovery after one resident local-bounds upload", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const replacement = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const ids = [
        layer.create({ text: "g", x: 1, y: 1 }),
        layer.create({ text: "g", x: 20, y: 1 }),
      ];
      await layer.commit();
      const cullBytes = layer.stats.cullRecordUploadBytes;
      const replacementDevice = (replacement.renderer as unknown as { gpu: { device: GPUDevice } })
        .gpu.device;
      (fixture.renderer as unknown as { gpu: { device: GPUDevice } }).gpu.device =
        replacementDevice;

      expect(layer.updatePositions([ids[0]!], new Float32Array([10, 11]))).toBe(1);
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        cullPath: "compute-cull",
      });
      expect(layer.stats.cullRecordUploadBytes - cullBytes).toBe(2 * 32);
      const recoveredBoundsWrites = replacement.writes.filter(
        (write) => write.buffer.label === "pixi-glyphflow-resident-local-bounds",
      ).length;
      expect(recoveredBoundsWrites).toBe(1);

      expect(layer.updatePositions([ids[1]!], new Float32Array([30, 31]))).toBe(1);
      await layer.commit();
      expect(
        replacement.writes.filter(
          (write) => write.buffer.label === "pixi-glyphflow-resident-local-bounds",
        ),
      ).toHaveLength(recoveredBoundsWrites);
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        cullPath: "compute-cull",
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rebuilds an earlier resident owner when a later owner cull aborts the frame", async () => {
    const fixture = fakeResidentWebGpuRenderer({ frameTransactions: true });
    const restore = installFakeGpuGlobals();
    try {
      const first = createResidentLayer(fixture.renderer);
      const second = createResidentLayer(fixture.renderer);
      const firstId = first.create({ text: "g", x: 1, y: 1 });
      second.create({ text: "g", x: 20, y: 20 });
      await first.commit();
      await second.commit();
      fixture.renderFrame();

      expect(first.updatePositions(new Float64Array([firstId]), new Float32Array([150, 12]))).toBe(
        1,
      );
      await first.commit();
      second.setViewportBounds({ x: 0.5, y: 0, width: 100, height: 100 });
      await second.commit();
      fixture.controls.failComputePassAt = fixture.controls.computePassCount + 3;
      expect(() => fixture.renderFrame()).toThrow("injected later owner cull failure");
      expect(first.stats.frameTransactionFusedSubmissions).toBe(1);

      await first.commit();
      const recovered = fixture.writes
        .filter((write) => write.buffer.label === "pixi-glyphflow-cull-records")
        .at(-1);
      expect(recovered).toBeDefined();
      if (recovered === undefined) throw new Error("Cross-owner recovery upload is missing");
      expect(Array.from(new Float32Array(recovered.bytes.slice().buffer).subarray(0, 4))).toEqual([
        150, 12, 158, 22,
      ]);

      fixture.renderFrame();
      await first.commit();
      expect(first.stats).toMatchObject({
        residencyActive: "gpu-scene",
        frameTransactionFusedSubmissions: 2,
        frameTransactionStandaloneSubmissions: 0,
      });
      first.destroy();
      second.destroy();
    } finally {
      restore();
    }
  });

  test("falls back to viewport residency when compact output exceeds the device limit", async () => {
    const fixture = fakeResidentWebGpuRenderer({
      maxStorageBufferBindingSize: 32 * 1_024,
      maxBufferSize: 32 * 1_024,
    });
    const restore = installFakeGpuGlobals();
    let rasterCalls = 0;
    try {
      const layer = createCapacityLimitLayer(fixture.renderer, () => {
        rasterCalls += 1;
      });
      layer.create({ text: "g", x: 1, y: 1 });

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyRequested: "gpu-scene",
        residencyActive: "viewport",
        residencyFallbackReason: "device-limit",
        cullPath: "cpu-grid",
        visibleLabelCount: 1,
        submittedGlyphs: 4_097,
      });
      expect(rasterCalls).toBe(1);

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "device-limit",
        visibleLabelCount: 1,
        submittedGlyphs: 4_097,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rejects a 4097-glyph offscreen scene before resident raster allocation", async () => {
    const fixture = fakeResidentWebGpuRenderer({
      maxStorageBufferBindingSize: 32 * 1_024,
      maxBufferSize: 32 * 1_024,
    });
    const restore = installFakeGpuGlobals();
    let rasterCalls = 0;
    try {
      const layer = createCapacityLimitLayer(fixture.renderer, () => {
        rasterCalls += 1;
      });
      layer.create({ text: "g", x: 10_000, y: 10_000 });

      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "device-limit",
        visibleLabelCount: 0,
        submittedGlyphs: 0,
      });
      expect(rasterCalls).toBe(0);
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rejects an active resident raster failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const failure = new Error("resident raster failed");
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: residentCulling(),
        rendering: {
          layoutEngine: { layout: () => RUN, destroy() {} },
          glyphProvider: {
            rasterize: () => Promise.reject(failure),
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      layer.create({ text: "g", x: 1, y: 1 });

      await expectResidentSetupFailure(layer, failure);
    } finally {
      restore();
    }
  });

  test("rejects an active resident surface upload failure", async () => {
    const failure = new Error("resident atlas upload failed");
    const fixture = fakeResidentWebGpuRenderer({ writeTextureError: failure });
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      layer.create({ text: "g", x: 1, y: 1 });

      await expectResidentSetupFailure(layer, failure);
    } finally {
      restore();
    }
  });

  test("keeps monotonic append and remove resident, then falls back on slot reuse", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      const ids = layer.createMany([
        { text: "g", x: 1, y: 1 },
        { text: "g", x: 20, y: 20 },
      ]);
      await layer.commit();
      expect(layer.stats).toMatchObject({ residencyActive: "gpu-scene", gpuResidentLabels: 2 });

      const appended = layer.create({ text: "g", x: 40, y: 40 });
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 3,
        gpuScenePrototypeCount: 1,
      });

      expect(layer.remove(appended)).toBe(true);
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 2,
        gpuScenePrototypeCount: 1,
      });

      const reused = layer.create({ text: "g", x: 60, y: 60 });
      expect(reused).not.toBe(appended);
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
        gpuResidentLabels: 0,
        gpuScenePrototypeCount: 0,
        visibleLabelCount: 3,
      });
      expect(layer.get(ids[0]!)).toBeDefined();
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("keeps a newer heterogeneous fallback authoritative while resident setup is pending", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    let releaseRaster = (): void => {};
    let rasterStarted = false;
    const rasterGate = new Promise<void>((resolve) => {
      releaseRaster = resolve;
    });
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: residentCulling(),
        rendering: {
          layoutEngine: { layout: () => RUN, destroy() {} },
          glyphProvider: {
            async rasterize() {
              rasterStarted = true;
              await rasterGate;
              return alphaRaster();
            },
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      const ids = layer.createMany([
        { text: "g", x: 1, y: 1 },
        { text: "g", x: 20, y: 20 },
      ]);
      const firstCommit = layer.commit();
      await waitFor(() => rasterStarted);
      layer.update(ids[0]!, { text: "x", alpha: 0.5 });
      const fallbackCommit = layer.commit();

      releaseRaster();
      await Promise.all([firstCommit, fallbackCommit]);

      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
        gpuResidentLabels: 0,
      });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("replays a camera commit queued while resident setup is pending", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const pending = createGatedResidentLayer(fixture.renderer);
    try {
      pending.layer.createMany([
        { text: "g", x: 1, y: 1 },
        { text: "g", x: 20, y: 20 },
      ]);
      const setupCommit = pending.layer.commit();
      await pending.rasterStarted;

      pending.layer.setViewportBounds({ x: 10, y: 10, width: 80, height: 80 });
      const cameraCommit = pending.layer.commit();
      pending.releaseRaster();

      expect((await Promise.all([setupCommit, cameraCommit])).map(Number)).toEqual([1, 1]);
      expect(pending.layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        residencyFallbackReason: undefined,
        gpuResidentLabels: 2,
      });
      pending.layer.destroy();
    } finally {
      if (!pending.layer.destroyed) pending.layer.destroy();
      restore();
    }
  });

  test("replays a position commit queued while resident setup is pending", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const pending = createGatedResidentLayer(fixture.renderer);
    try {
      const id = pending.layer.create({ text: "g", x: 1, y: 1 });
      const setupCommit = pending.layer.commit();
      await pending.rasterStarted;

      expect(pending.layer.updatePositions([id], new Float32Array([40, 50]))).toBe(1);
      const moverCommit = pending.layer.commit();
      pending.releaseRaster();

      expect((await Promise.all([setupCommit, moverCommit])).map(Number)).toEqual([1, 2]);
      expect(pending.layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        residencyFallbackReason: undefined,
        gpuResidentLabels: 1,
      });
      expect(pending.layer.getBoundsFor(id)).toMatchObject({ x: 40, y: 50, width: 8, height: 10 });
      pending.layer.destroy();
    } finally {
      if (!pending.layer.destroyed) pending.layer.destroy();
      restore();
    }
  });

  test("replays a monotonic append queued while resident setup is pending", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const pending = createGatedResidentLayer(fixture.renderer);
    try {
      pending.layer.create({ text: "g", x: 1, y: 1 });
      const setupCommit = pending.layer.commit();
      await pending.rasterStarted;

      pending.layer.create({ text: "g", x: 20, y: 20 });
      const appendCommit = pending.layer.commit();
      pending.releaseRaster();

      expect((await Promise.all([setupCommit, appendCommit])).map(Number)).toEqual([1, 2]);
      expect(pending.layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        residencyFallbackReason: undefined,
        gpuResidentLabels: 2,
        gpuScenePrototypeCount: 1,
      });
      pending.layer.destroy();
    } finally {
      if (!pending.layer.destroyed) pending.layer.destroy();
      restore();
    }
  });

  test("rebuilds the resident scene after detach and reattach", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createResidentLayer(fixture.renderer);
      layer.createMany([
        { text: "g", x: 1, y: 1 },
        { text: "g", x: 20, y: 20 },
      ]);
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");

      layer.detach();
      expect(layer.stats).toMatchObject({
        residencyActive: "viewport",
        residencyFallbackReason: "renderer-unavailable",
        gpuResidentLabels: 0,
      });
      layer.attach(fixture.renderer);
      expect(layer.stats.residencyFallbackReason).toBeUndefined();
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 2,
        gpuScenePrototypeCount: 1,
      });

      expect(() => layer.destroy()).not.toThrow();
    } finally {
      restore();
    }
  });

  test("fully releases a resident renderer after scene and surface teardown faults", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const sceneFailure = new Error("resident scene release failed");
    const surfaceFailure = new Error("resident surface release failed");
    const calls = { scene: 0, surface: 0, coordinator: 0 };
    const sceneDestroy = GpuResidentScene.prototype.destroy;
    const surfaceDestroy = RenderSurface.prototype.destroy;
    const coordinatorDestroy = RenderCoordinator.prototype.destroy;
    const layer = createResidentLayer(fixture.renderer);
    try {
      layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");

      GpuResidentScene.prototype.destroy = function (): void {
        calls.scene += 1;
        sceneDestroy.call(this);
        throw sceneFailure;
      };
      RenderSurface.prototype.destroy = function (): void {
        calls.surface += 1;
        surfaceDestroy.call(this);
        throw surfaceFailure;
      };
      RenderCoordinator.prototype.destroy = function (): Promise<void> {
        calls.coordinator += 1;
        return coordinatorDestroy.call(this);
      };

      expect(() => layer.detach()).toThrow(sceneFailure);
      await expect(layer.whenRendererReleased()).rejects.toBe(sceneFailure);
      expect(calls).toEqual({ scene: 1, surface: 1, coordinator: 1 });
      expect(layer.stats).toMatchObject({
        attached: false,
        residencyActive: "viewport",
        residencyFallbackReason: "renderer-unavailable",
        gpuResidentLabels: 0,
      });

      expect(() => layer.detach()).not.toThrow();
      await expect(layer.whenRendererReleased()).rejects.toBe(sceneFailure);
      expect(calls).toEqual({ scene: 1, surface: 1, coordinator: 1 });

      GpuResidentScene.prototype.destroy = sceneDestroy;
      RenderSurface.prototype.destroy = surfaceDestroy;
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.stats).toMatchObject({
        attached: true,
        residencyActive: "gpu-scene",
        gpuResidentLabels: 1,
      });
      layer.destroy();
    } finally {
      GpuResidentScene.prototype.destroy = sceneDestroy;
      RenderSurface.prototype.destroy = surfaceDestroy;
      RenderCoordinator.prototype.destroy = coordinatorDestroy;
      if (!layer.destroyed) layer.destroy();
      restore();
    }
  });

  test("publishes viewport state before a resident-scene deactivation fault", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const sceneFailure = new Error("resident fallback release failed");
    const sceneDestroy = GpuResidentScene.prototype.destroy;
    const layer = createResidentLayer(fixture.renderer);
    let sceneDestroyCalls = 0;
    try {
      const id = layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");

      GpuResidentScene.prototype.destroy = function (): void {
        sceneDestroyCalls += 1;
        sceneDestroy.call(this);
        throw sceneFailure;
      };
      layer.update(id, { text: "x", alpha: 0.5 });

      expect(() => layer.commit()).toThrow(sceneFailure);
      expect(sceneDestroyCalls).toBe(1);
      expect(layer.stats).toMatchObject({
        attached: true,
        residencyActive: "viewport",
        residencyFallbackReason: "unsupported-scene",
        gpuResidentLabels: 0,
      });

      GpuResidentScene.prototype.destroy = sceneDestroy;
      await layer.commit();
      expect(layer.get(id)?.text).toBe("x");
      layer.destroy();
    } finally {
      GpuResidentScene.prototype.destroy = sceneDestroy;
      if (!layer.destroyed) layer.destroy();
      restore();
    }
  });

  test("isolates a reattached resident scene from an old renderer failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    let rejectOldRaster = (_error: Error): void => {};
    let rasterCalls = 0;
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: residentCulling(),
        rendering: {
          layoutEngine: { layout: () => RUN, destroy() {} },
          glyphProvider: {
            rasterize() {
              rasterCalls += 1;
              if (rasterCalls > 1) return Promise.resolve(alphaRaster());
              return new Promise((_, reject) => {
                rejectOldRaster = reject;
              });
            },
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      layer.create({ text: "g", x: 1, y: 1 });
      const oldCommit = layer.commit();
      await waitFor(() => rasterCalls === 1);

      layer.detach();
      layer.attach(fixture.renderer);
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");

      rejectOldRaster(new Error("old renderer raster failed"));
      await oldCommit;

      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 1,
      });
      expect(layer.stats.residencyFallbackReason).toBeUndefined();
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("rebinds resident content while retaining shared prototype geometry", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    try {
      const layer = createHeterogeneousResidentLayer(fixture.renderer);
      const id = layer.create({ text: "A", x: 1, y: 1 });
      const unchanged = layer.create({ text: "A", x: 20, y: 20 });
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      const setup = layer.stats;

      layer.update(id, { text: "B" });
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 2,
        gpuScenePrototypeCount: 2,
        visibleLabelCount: 2,
      });
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 4, y: 1, width: 8, height: 10 });
      expect(layer.getBoundsFor(unchanged)).toMatchObject({ x: 20, y: 20, width: 8, height: 10 });
      expect(layer.stats.cullRecordUploadBytes - setup.cullRecordUploadBytes).toBe(32);
      const rebound = layer.stats;
      layer.update(id, { text: "A" });
      await layer.commit();
      expect(layer.stats.gpuScenePrototypeCount).toBe(2);
      expect(layer.stats.instanceUploadBytes).toBe(rebound.instanceUploadBytes);
      expect(layer.getBoundsFor(id)).toMatchObject({ x: 1, y: 1, width: 8, height: 10 });
      layer.destroy();
    } finally {
      restore();
    }
  });

  test("keeps rotated labels resident across sparse positions and mixed rigid-transform waves", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const layer = createResidentLayer(fixture.renderer);
    try {
      const ids = layer.createMany([
        { text: "g", x: 20, y: 20, rotation: 0.25 },
        { text: "g", x: 40, y: 40 },
        { text: "g", x: 60, y: 60, rotation: -0.5 },
      ]);
      await layer.commit();
      const setup = layer.stats;
      expect(setup.residencyActive).toBe("gpu-scene");
      expectRotatedBounds(layer, ids[0]!, RUN.bounds);
      expectRotatedBounds(layer, ids[2]!, RUN.bounds);

      layer.updatePositions([ids[0]!, ids[2]!], new Float32Array([25, 26, 65, 66]));
      await layer.commit();
      expect(layer.stats.transformUploadBytes - setup.transformUploadBytes).toBe(2 * 12 + 16);
      expect(layer.stats.cullRecordUploadBytes).toBe(setup.cullRecordUploadBytes);
      expectRotatedBounds(layer, ids[0]!, RUN.bounds);
      expectRotatedBounds(layer, ids[2]!, RUN.bounds);

      const before = layer.stats;
      const writeStart = fixture.writes.length;
      layer.updatePositions(ids, new Float32Array([30, 31, 50, 51, 70, 71]));
      layer.update(ids[1]!, { rotation: 0.7 });
      await layer.commit();
      const command = fixture.writes
        .slice(writeStart)
        .find((write) => write.buffer.label === "pixi-glyphflow-palette-move-commands");
      expect(command?.bytes.byteLength).toBe(3 * 12);
      const words = new Uint32Array(command!.bytes.slice().buffer);
      const floats = new Float32Array(words.buffer);
      for (let index = 0; index < ids.length; index += 1) {
        const label = layer.get(ids[index]!)!;
        expect([floats[index * 3], floats[index * 3 + 1]]).toEqual([label.x, label.y]);
        expect(words[index * 3 + 2]).toBe(packResidentRotation(label.rotation));
        expectRotatedBounds(layer, ids[index]!, RUN.bounds);
      }
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuScenePrototypeCount: 1,
      });
      expect(layer.stats.transformUploadBytes - before.transformUploadBytes).toBe(3 * 12 + 16);
      expect(layer.stats.cullRecordUploadBytes).toBe(before.cullRecordUploadBytes);
      expect(layer.stats.instanceUploadBytes).toBe(before.instanceUploadBytes);

      const sparseStart = fixture.writes.length;
      layer.updateMany([
        { id: ids[0]!, patch: { x: 35, rotation: -0.8 } },
        { id: ids[2]!, patch: { y: 75, rotation: 1.2 } },
      ]);
      await layer.commit();
      const sparse = fixture.writes
        .slice(sparseStart)
        .find((write) => write.buffer.label === "pixi-glyphflow-palette-move-commands");
      expect(sparse?.bytes.byteLength).toBe(2 * 16);
      expectRotatedBounds(layer, ids[0]!, RUN.bounds);
      expectRotatedBounds(layer, ids[2]!, RUN.bounds);

      expect(
        layer.updateTransforms(
          ids,
          new Float32Array([25, 25, 50, 50, 75, 75]),
          new Float32Array([0.25, 0.5, 0.75]),
        ),
      ).toBe(3);
      expectRotatedBounds(layer, ids[0]!, RUN.bounds);
      await layer.commit();
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      expectRotatedBounds(layer, ids[2]!, RUN.bounds);
    } finally {
      layer.destroy();
      restore();
    }
  });

  test("recovers position and rotation together after a compact transform write failure", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const layer = createResidentLayer(fixture.renderer);
    try {
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      const writeStart = fixture.writes.length;
      layer.update(id, { x: 50, y: 60, rotation: 0.75 });
      fixture.controls.failNextPaletteMoveWrite = true;
      await layer.commit();
      const rotation = packResidentRotation(layer.get(id)!.rotation);
      const restored = fixture.writes.slice(writeStart).some((write) => {
        const floats = float32View(write.bytes);
        const words = new Uint32Array(write.bytes.buffer, write.bytes.byteOffset, floats.length);
        return floats[0] === 50 && floats[1] === 60 && words[4] === rotation;
      });
      expect(restored).toBe(true);
      expect(layer.stats.residencyActive).toBe("viewport");
      expectRotatedBounds(layer, id, RUN.bounds);
      const bounds = layer.getBoundsFor(id)!;
      expect(
        layer.hitTest({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
      ).toBe(id);
    } finally {
      layer.destroy();
      restore();
    }
  });

  for (const recovery of ["aborted-frame", "replacement-device"] as const) {
    test(`restores packed rotation and cull bounds after ${recovery}`, async () => {
      const fixture = fakeResidentWebGpuRenderer({ frameTransactions: true });
      const replacement = fakeResidentWebGpuRenderer();
      const restore = installFakeGpuGlobals();
      const layer = createResidentLayer(fixture.renderer);
      try {
        const id = layer.create({ text: "g", x: 10, y: 10, rotation: 0.25 });
        await layer.commit();
        fixture.renderFrame();
        layer.updateTransforms([id], new Float32Array([50, 60]), new Float32Array([0.75]));
        await layer.commit();
        if (recovery === "aborted-frame") {
          fixture.controls.failNextFrameSubmit = true;
          expect(() => fixture.renderFrame()).toThrow("injected resident frame submit failure");
        } else {
          fixture.renderFrame();
          (fixture.renderer as unknown as { gpu: { device: GPUDevice } }).gpu.device = (
            replacement.renderer as unknown as { gpu: { device: GPUDevice } }
          ).gpu.device;
        }
        const writes = recovery === "aborted-frame" ? fixture.writes : replacement.writes;
        const start = writes.length;
        await layer.commit();
        const rotation = packResidentRotation(layer.get(id)!.rotation);
        expect(
          writes.slice(start).some((write) => {
            const floats = float32View(write.bytes);
            const words = new Uint32Array(
              write.bytes.buffer,
              write.bytes.byteOffset,
              floats.length,
            );
            return floats[0] === 50 && floats[1] === 60 && words[4] === rotation;
          }),
        ).toBe(true);
        const records = writes
          .slice(start)
          .find((write) => write.buffer.label === "pixi-glyphflow-cull-records");
        expect(records).toBeDefined();
        const expected = new Float32Array(4);
        writeResidentRotatedAabbF32(
          expected,
          0,
          50,
          60,
          RUN.bounds.x,
          RUN.bounds.y,
          RUN.bounds.width,
          RUN.bounds.height,
          rotation,
        );
        expect(float32View(records!.bytes).subarray(0, 4)).toEqual(expected);
        fixture.renderFrame();
        expectRotatedBounds(layer, id, RUN.bounds);
        expect(layer.stats.residencyActive).toBe("gpu-scene");
      } finally {
        layer.destroy();
        restore();
      }
    });
  }

  test("publishes overlapping rigid transforms in commit order", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const layer = createResidentLayer(fixture.renderer);
    try {
      const id = layer.create({ text: "g", x: 10, y: 10 });
      await layer.commit();
      const start = fixture.writes.length;
      layer.updateTransforms([id], new Float32Array([20, 30]), new Float32Array([0.5]));
      const first = layer.commit();
      layer.updateTransforms([id], new Float32Array([40, 50]), new Float32Array([-0.75]));
      const second = layer.commit();
      await Promise.all([first, second]);
      const commands = fixture.writes
        .slice(start)
        .filter((write) => write.buffer.label === "pixi-glyphflow-palette-move-commands");
      expect(commands).toHaveLength(2);
      for (const [index, [x, y, rotation]] of [
        [20, 30, 0.5],
        [40, 50, -0.75],
      ].entries()) {
        const bytes = commands[index]!.bytes.slice();
        expect(Array.from(float32View(bytes).subarray(0, 2))).toEqual([x!, y!]);
        expect(new Uint32Array(bytes.buffer)[2]).toBe(packResidentRotation(rotation!));
      }
      expectRotatedBounds(layer, id, RUN.bounds);
      expect(layer.stats.pendingDirtyLabels).toBe(0);
    } finally {
      layer.destroy();
      restore();
    }
  });

  test("reuses bounded wrap and newline prototypes while moving and rotating labels", async () => {
    const fixture = fakeResidentWebGpuRenderer();
    const restore = installFakeGpuGlobals();
    const seen: Array<{ text: string; width: unknown; writingMode: unknown }> = [];
    const layer = new TextLayer({
      renderer: fixture.renderer,
      culling: residentCulling(),
      rendering: {
        layoutEngine: {
          layout(_slot, _revision, input) {
            seen.push({
              text: input.text,
              width: input.style.wordWrapWidth,
              writingMode: input.writingMode,
            });
            return wrappedRun(input.text, Number(input.style.wordWrapWidth) || 32);
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return alphaRaster();
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    try {
      const ids = layer.createMany([
        { text: "gggg", x: 10, y: 10, style: { wordWrap: true, wordWrapWidth: 32 } },
        { text: "gggg", x: 50, y: 50, style: { wordWrap: true, wordWrapWidth: 32 } },
      ]);
      await layer.commit();
      const before = layer.stats;
      layer.updatePositions(ids, new Float32Array([20, 20, 60, 60]));
      layer.update(ids[0]!, { rotation: 0.4, style: { wordWrap: true, wordWrapWidth: 16 } });
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyActive: "gpu-scene",
        gpuResidentLabels: 2,
        gpuScenePrototypeCount: 2,
      });
      expectRotatedBounds(layer, ids[0]!, { x: 0, y: 0, width: 16, height: 20 });
      expect(layer.getBoundsFor(ids[1]!)).toMatchObject({ x: 60, y: 60, width: 32, height: 10 });
      expect(layer.stats.cullRecordUploadBytes - before.cullRecordUploadBytes).toBe(32);
      const wrapped = layer.stats;

      layer.update(ids[0]!, { text: "gg\ngg", style: { wordWrap: true, wordWrapWidth: 32 } });
      await layer.commit();
      expect(layer.stats.gpuScenePrototypeCount).toBe(2);
      expect(layer.stats.instanceUploadBytes).toBe(wrapped.instanceUploadBytes);
      expect(seen).toContainEqual({ text: "gg\ngg", width: 32, writingMode: undefined });
      expectRotatedBounds(layer, ids[0]!, { x: 0, y: 0, width: 16, height: 20 });

      layer.update(ids[0]!, { text: "gggg", rotation: 0, layout: { writingMode: "vertical-rl" } });
      await layer.commit();
      expect(seen.at(-1)?.writingMode).toBe("vertical-rl");
      expect(layer.stats.residencyActive).toBe("gpu-scene");
      expect(layer.getBoundsFor(ids[0]!)).toMatchObject({ x: 20, y: 20, width: 32, height: 10 });
    } finally {
      layer.destroy();
      restore();
    }
  });

  test("keeps viewport compute culling on the texture palette", async () => {
    const fixture = fakeResidentWebGpuRenderer({ maxStorageBuffersInVertexStage: 0 });
    const restore = installFakeGpuGlobals();
    try {
      const layer = new TextLayer({
        renderer: fixture.renderer,
        culling: { bounds: { x: 0, y: 0, width: 100, height: 100 }, computeCull: true },
        rendering: {
          layoutEngine: { layout: () => RUN, destroy() {} },
          glyphProvider: {
            async rasterize() {
              return alphaRaster();
            },
            destroy() {},
          },
          atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
        },
      });
      layer.create({ text: "g", x: 1, y: 1 });
      await layer.commit();
      expect(layer.stats).toMatchObject({
        residencyRequested: "viewport",
        residencyActive: "viewport",
        cullPath: "compute-cull",
        palettePath: "texture",
      });
      layer.destroy();
    } finally {
      restore();
    }
  });
});

function fakeWebGlRenderer(): Renderer {
  return {
    gl: { MAX_TEXTURE_SIZE: 0x0d33, getParameter: () => 4_096 },
    buffer: { updateBuffer(): void {} },
  } as unknown as Renderer;
}

function fakeResidentWebGpuRenderer(
  options: {
    readonly maxStorageBuffersInVertexStage?: number;
    readonly maxStorageBufferBindingSize?: number;
    readonly maxBufferSize?: number;
    readonly writeTextureError?: Error;
    readonly frameTransactions?: boolean;
  } = {},
): {
  renderer: Renderer;
  submits: string[];
  buffers: FakeGpuBuffer[];
  writes: FakeGpuWrite[];
  textureWrites: FakeGpuTextureWrite[];
  controls: {
    failNextFrameSubmit: boolean;
    failNextPaletteMoveWrite: boolean;
    failComputePassAt: number;
    computePassCount: number;
    maxComputeWorkgroupsPerDimension: number;
  };
  renderFrame(): void;
} {
  const submits: string[] = [];
  const buffers: FakeGpuBuffer[] = [];
  const writes: FakeGpuWrite[] = [];
  const textureWrites: FakeGpuTextureWrite[] = [];
  const controls = {
    failNextFrameSubmit: false,
    failNextPaletteMoveWrite: false,
    failComputePassAt: Number.POSITIVE_INFINITY,
    computePassCount: 0,
    maxComputeWorkgroupsPerDimension: 65_535,
  };
  const gpuBuffers = new WeakMap<object, FakeGpuBuffer>();
  const device = {
    limits: {
      maxTextureDimension2D: 8_192,
      maxStorageBuffersInVertexStage: options.maxStorageBuffersInVertexStage ?? 1,
      maxStorageBuffersPerShaderStage: 8,
      maxStorageBufferBindingSize: options.maxStorageBufferBindingSize ?? 128 * 1_024 * 1_024,
      maxBufferSize: options.maxBufferSize ?? 256 * 1_024 * 1_024,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      get maxComputeWorkgroupsPerDimension() {
        return controls.maxComputeWorkgroupsPerDimension;
      },
    },
    createShaderModule: ({ label }: { label?: string }) => ({ label }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => ({
      entryPoint: compute.entryPoint,
    }),
    createBuffer: ({ label, size, usage }: { label?: string; size: number; usage: number }) => {
      const buffer = { label: label ?? "buffer", size, usage, destroy() {} };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => ({}),
    createCommandEncoder: ({ label }: { label?: string } = {}) => ({
      beginComputePass: () => {
        controls.computePassCount += 1;
        if (controls.computePassCount === controls.failComputePassAt) {
          controls.failComputePassAt = Number.POSITIVE_INFINITY;
          throw new Error("injected later owner cull failure");
        }
        return {
          setBindGroup() {},
          setPipeline() {},
          dispatchWorkgroups() {},
          end() {},
        };
      },
      copyTextureToTexture() {},
      finish: () => ({ label: label ?? "command" }),
    }),
    queue: {
      writeBuffer(
        buffer: FakeGpuBuffer,
        bufferOffset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset = 0,
        size?: number,
      ) {
        if (
          controls.failNextPaletteMoveWrite &&
          buffer.label === "pixi-glyphflow-palette-move-commands"
        ) {
          controls.failNextPaletteMoveWrite = false;
          throw new Error("injected palette move write failure");
        }
        const source = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        const length = size ?? source.byteLength - dataOffset;
        writes.push({
          buffer,
          bufferOffset,
          bytes: source.slice(dataOffset, dataOffset + length),
        });
      },
      writeTexture(
        destination: { readonly texture: FakeGpuTexture },
        data: ArrayBuffer | ArrayBufferView,
      ) {
        if (options.writeTextureError !== undefined) throw options.writeTextureError;
        const source = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        textureWrites.push({ texture: destination.texture, bytes: source.slice() });
      },
      submit(commands: readonly { readonly label?: string }[]) {
        if (controls.failNextFrameSubmit) {
          controls.failNextFrameSubmit = false;
          throw new Error("injected resident frame submit failure");
        }
        for (const command of commands) submits.push(command.label ?? "command");
      },
      async onSubmittedWorkDone() {},
    },
  };
  const lifecycleEncoder = {
    commandEncoder: null as ReturnType<typeof device.createCommandEncoder> | null,
    draw() {},
    renderStart() {
      this.commandEncoder = device.createCommandEncoder({ label: "pixi-frame" });
    },
    postrender() {
      const commandEncoder = this.commandEncoder;
      if (commandEncoder === null) throw new Error("missing resident frame encoder");
      device.queue.submit([commandEncoder.finish()]);
      this.commandEncoder = null;
    },
  };
  const renderer = {
    gpu: { device },
    buffer: {
      updateBuffer(buffer: object) {
        if (!gpuBuffers.has(buffer)) {
          gpuBuffers.set(buffer, {
            label: "pixi-buffer",
            size: 1_024,
            usage: 0xffff,
            destroy() {},
          });
        }
      },
      getGPUBuffer(buffer: object) {
        let gpu = gpuBuffers.get(buffer);
        if (gpu === undefined) {
          gpu = { label: "pixi-buffer", size: 1_024, usage: 0xffff, destroy() {} };
          gpuBuffers.set(buffer, gpu);
        }
        return gpu;
      },
    },
    texture: {
      getGpuSource: (source: { readonly label?: string }) => ({
        label: source.label ?? "texture",
      }),
    },
    encoder: options.frameTransactions === true ? lifecycleEncoder : { draw() {} },
  } as unknown as Renderer;
  return {
    renderer,
    submits,
    buffers,
    writes,
    textureWrites,
    controls,
    renderFrame() {
      lifecycleEncoder.renderStart();
      lifecycleEncoder.postrender();
    },
  };
}

function createResidentLayer(renderer: Renderer, initialCapacity?: number): TextLayer {
  return new TextLayer({
    renderer,
    ...(initialCapacity === undefined ? {} : { initialCapacity }),
    culling: residentCulling(),
    rendering: {
      layoutEngine: { layout: () => RUN, destroy() {} },
      glyphProvider: {
        async rasterize() {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
    },
  });
}

async function createThreeResidentLabels(renderer: Renderer) {
  const layer = createResidentLayer(renderer);
  const ids = layer.createMany([
    { text: "g", x: 10, y: 10 },
    { text: "g", x: 20, y: 20 },
    { text: "g", x: 30, y: 30 },
  ]);
  await layer.commit();
  return { layer, ids };
}

function createCapacityLimitLayer(renderer: Renderer, onRaster: () => void): TextLayer {
  return new TextLayer({
    renderer,
    culling: residentCulling(),
    rendering: {
      layoutEngine: { layout: () => CAPACITY_LIMIT_RUN, destroy() {} },
      glyphProvider: {
        async rasterize() {
          onRaster();
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
    },
  });
}

async function expectResidentSetupFailure(layer: TextLayer, failure: Error): Promise<void> {
  await expect(layer.commit()).rejects.toBe(failure);
  expect(layer.stats).toMatchObject({
    residencyActive: "viewport",
    residencyFallbackReason: "setup-failed",
    gpuResidentLabels: 0,
  });
  layer.destroy();
}

function createGatedResidentLayer(renderer: Renderer): {
  readonly layer: TextLayer;
  readonly rasterStarted: Promise<void>;
  readonly releaseRaster: () => void;
} {
  let notifyRasterStarted = (): void => {};
  let releaseRaster = (): void => {};
  const rasterStarted = new Promise<void>((resolve) => {
    notifyRasterStarted = resolve;
  });
  const rasterGate = new Promise<void>((resolve) => {
    releaseRaster = resolve;
  });
  const layer = new TextLayer({
    renderer,
    culling: residentCulling(),
    rendering: {
      layoutEngine: { layout: () => RUN, destroy() {} },
      glyphProvider: {
        async rasterize() {
          notifyRasterStarted();
          await rasterGate;
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
    },
  });
  return { layer, rasterStarted, releaseRaster };
}

function createHeterogeneousResidentLayer(
  renderer: Renderer,
  observers: {
    readonly onLayout?: () => void;
    readonly onRaster?: () => void;
  } = {},
): TextLayer {
  return new TextLayer({
    renderer,
    culling: residentCulling(200, 200),
    rendering: {
      layoutEngine: {
        layout(_slot, _revision, input) {
          observers.onLayout?.();
          return heterogeneousRun(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize() {
          observers.onRaster?.();
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 65_536 },
    },
  });
}

function residentCulling(width = 100, height = width) {
  return {
    bounds: { x: 0, y: 0, width, height },
    residency: "gpu-scene" as const,
  };
}

function repeatedRun(glyphCount: number): Readonly<PositionedRun> {
  const glyphIds = new Uint32Array(glyphCount);
  glyphIds.fill(103);
  const glyphKeys = Array<string>(glyphCount).fill("g");
  const x = new Float32Array(glyphCount);
  const y = new Float32Array(glyphCount);
  y.fill(8);
  const xAdvance = new Float32Array(glyphCount);
  xAdvance.fill(8);
  for (let index = 0; index < glyphCount; index += 1) x[index] = index * 8;
  return Object.freeze({
    source: "bitmap",
    text: "g",
    fontFamily: "sans-serif",
    fontRevision: 0,
    direction: "ltr",
    glyphCount,
    glyphIds,
    glyphKeys: Object.freeze(glyphKeys),
    clusters: new Uint32Array(glyphCount),
    x,
    y,
    xAdvance,
    yAdvance: new Float32Array(glyphCount),
    lineIndices: new Uint32Array(glyphCount),
    bounds: Object.freeze({ x: 0, y: 0, width: glyphCount * 8, height: 10 }),
  });
}

function wrappedRun(text: string, wrapWidth: number): Readonly<PositionedRun> {
  const run = repeatedRun(text.replaceAll("\n", "").length);
  const glyphX = new Float32Array(run.glyphCount);
  const glyphY = new Float32Array(run.glyphCount);
  const lineIndices = new Uint32Array(run.glyphCount);
  let index = 0;
  let line = 0;
  let x = 0;
  let width = 0;
  for (const char of text) {
    if (char === "\n" || x >= wrapWidth) {
      line += 1;
      x = 0;
    }
    if (char === "\n") continue;
    glyphX[index] = x;
    glyphY[index] = 8 + line * 10;
    lineIndices[index] = line;
    x += 8;
    width = Math.max(width, x);
    index += 1;
  }
  return {
    ...run,
    text,
    x: glyphX,
    y: glyphY,
    lineIndices,
    bounds: { x: 0, y: 0, width, height: (line + 1) * 10 },
  };
}

function expectRotatedBounds(
  layer: TextLayer,
  id: Parameters<TextLayer["get"]>[0],
  local: Readonly<PositionedRun>["bounds"],
): void {
  const label = layer.get(id)!;
  const edges = new Float32Array(4);
  writeResidentRotatedAabbF32(
    edges,
    0,
    label.x,
    label.y,
    local.x,
    local.y,
    local.width,
    local.height,
    packResidentRotation(unpackF16(packF16(label.rotation))),
  );
  const bounds = layer.getBoundsFor(id)!;
  expect(bounds.x).toBeCloseTo(edges[0]!, 4);
  expect(bounds.y).toBeCloseTo(edges[1]!, 4);
  expect(bounds.width).toBeCloseTo(edges[2]! - edges[0]!, 4);
  expect(bounds.height).toBeCloseTo(edges[3]! - edges[1]!, 4);
}

function heterogeneousRun(text: string): Readonly<PositionedRun> {
  const glyph = text.codePointAt(0) ?? 0xfffd;
  const shift = text === "B" ? 3 : 0;
  return Object.freeze({
    source: "bitmap",
    text,
    fontFamily: "sans-serif",
    fontRevision: 0,
    direction: "ltr",
    glyphCount: 1,
    glyphIds: new Uint32Array([glyph]),
    glyphKeys: Object.freeze([text]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([shift]),
    y: new Float32Array([8]),
    xAdvance: new Float32Array([8]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    bounds: Object.freeze({ x: shift, y: 0, width: 8, height: 10 }),
  });
}

function installFakeGpuGlobals(): () => void {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const restoreDocument = (): void => {
    if (documentDescriptor === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", documentDescriptor);
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  });
  try {
    const restoreGpuGlobals = installWebGpuGlobals({
      GPUShaderStage: { COMPUTE: 4 },
      GPUBufferUsage: {
        STORAGE: 0x0080,
        COPY_DST: 0x0008,
        VERTEX: 0x0020,
        UNIFORM: 0x0040,
      },
    });
    return () => {
      try {
        restoreGpuGlobals();
      } finally {
        restoreDocument();
      }
    };
  } catch (error) {
    restoreDocument();
    throw error;
  }
}

interface FakeGpuBuffer {
  readonly label: string;
  readonly size: number;
  readonly usage: number;
  destroy(): void;
}

interface FakeGpuWrite {
  readonly buffer: FakeGpuBuffer;
  readonly bufferOffset: number;
  readonly bytes: Uint8Array;
}

function expectThreeLabelMoveWrite(writes: readonly FakeGpuWrite[], writeStart: number): void {
  const commandWrites = writes
    .slice(writeStart)
    .filter((write) => write.buffer.label === "pixi-glyphflow-palette-move-commands");
  expect(commandWrites.map((write) => write.bytes.byteLength)).toEqual([24]);
  expect(Array.from(new Float32Array(commandWrites[0]!.bytes.slice().buffer))).toEqual([
    100, 110, 200, 210, 300, 310,
  ]);
}

interface FakeGpuTexture {
  readonly label: string;
}

interface FakeGpuTextureWrite {
  readonly texture: FakeGpuTexture;
  readonly bytes: Uint8Array;
}

function float32View(bytes: Uint8Array): Float32Array {
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function containsPosition(bytes: Uint8Array, x: number, y: number, stride: number): boolean {
  const values = float32View(bytes);
  for (let offset = 0; offset + 1 < values.length; offset += stride) {
    if (values[offset] === x && values[offset + 1] === y) return true;
  }
  return false;
}

function alphaRaster(): {
  readonly mode: "alpha";
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
} {
  return { mode: "alpha", width: 8, height: 10, pixels: new Uint8Array(80).fill(255) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Fixture condition did not settle");
}
