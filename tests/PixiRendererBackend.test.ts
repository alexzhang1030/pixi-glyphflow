import { describe, expect, test } from "bun:test";

import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  Texture,
  type Renderer,
  type WebGPURenderer,
} from "pixi.js";

import { ComputeCullPass } from "../src/render/ComputeCullPass";
import { planResidentCullDraw } from "../src/render/GlyphDrawPlanner";
import { GlyphMesh } from "../src/render/GlyphMesh";
import { writePrototypeGlyphs } from "../src/render/pack";
import {
  paletteMoveDispatchBytes,
  paletteTransformDispatchBytes,
} from "../src/render/paletteStorage";
import { PaletteStoragePass } from "../src/render/PaletteStoragePass";
import {
  createPixiRendererPlatform,
  DefaultPixiRendererBackend,
  glyphShaderVariantForCull,
  planGlyphDrawBytes,
} from "../src/render/PixiRendererBackend";
import { createAtlasArray } from "../src/render/PixiRendererResources";
import {
  WebGPURendererBackendAdapter,
  type WebGpuRendererPassFactories,
} from "../src/render/WebGPURendererBackend";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

const COMPUTE_FALLBACK_LIMITS = Object.freeze({
  maxTextureDimension2D: 8_192,
  maxStorageBuffersInVertexStage: 0,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 128 * 1024 * 1024,
  maxStorageBuffersPerShaderStage: 8,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupsPerDimension: 65_535,
});
const COMPUTE_PASS_LIMITS = Object.freeze({
  maxStorageBuffersPerShaderStage: 8,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
});

describe("PixiRendererBackend platform seam", () => {
  test("plans compact draw bytes inside safe integer and indirect-count bounds", () => {
    expect(planGlyphDrawBytes(50_000)).toBe(400_000);
    expect(planGlyphDrawBytes(0xffff_ffff)).toBe(0xffff_ffff * 8);
    expect(planGlyphDrawBytes(0x1_0000_0000)).toBeUndefined();
    expect(planGlyphDrawBytes(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(planGlyphDrawBytes(-1)).toBeUndefined();
  });

  test("selects the fill-only shader only for resident storage draws", () => {
    const resident = {
      records: new ArrayBuffer(32),
      recordCount: 1,
      recordDirty: "all" as const,
      drawInstanceCount: 1,
      localBounds: new Float32Array([0, 0, 8, 10]),
      localBoundsCount: 1,
      localBoundsDirty: "all" as const,
      viewport: { x: 0, y: 0, width: 100, height: 100, padding: 0 },
    };
    const ordinary = {
      records: resident.records,
      recordCount: resident.recordCount,
      recordDirty: resident.recordDirty,
      viewport: resident.viewport,
    };

    expect(glyphShaderVariantForCull(resident, "storage", { offset: 4, count: 1 })).toBe(
      "resident-fill-single",
    );
    for (const count of [2, 5, 8]) {
      expect(glyphShaderVariantForCull(resident, "storage", { offset: 4, count })).toBe(
        "resident-fill-run",
      );
    }
    expect(glyphShaderVariantForCull(resident, "storage", { offset: 4, count: 9 })).toBe(
      "resident-fill",
    );
    expect(glyphShaderVariantForCull(resident, "storage")).toBe("resident-fill");
    expect(glyphShaderVariantForCull(resident, "texture")).toBe("general");
    expect(glyphShaderVariantForCull(ordinary, "storage")).toBe("general");
    expect(glyphShaderVariantForCull(undefined, "storage")).toBe("general");
  });

  test("expands same-prototype resident records into per-label palette spans", () => {
    const records = new ArrayBuffer(3 * 32);
    writeResidentRecord(records, 0, [0, 0, 8, 10], 4, 2, 10);
    writeResidentRecord(records, 1, [20, 0, 28, 10], 4, 2, 11);
    writeResidentRecord(records, 2, [200, 0, 208, 10], 4, 2, 12);

    const draw = planResidentCullDraw(
      records,
      { x: 0, y: 0, width: 100, height: 100, padding: 0 },
      3,
    );

    expect(draw).toEqual({
      segments: [
        {
          zIndex: 0,
          blendMode: "normal",
          spans: [
            { offset: 4, count: 2, paletteIndex: 10 },
            { offset: 4, count: 2, paletteIndex: 11 },
          ],
          count: 4,
        },
      ],
      naturalOrder: false,
      count: 4,
    });
  });

  test("preserves resident record order across heterogeneous prototype ranges and tombstones", () => {
    const records = new ArrayBuffer(4 * 32);
    writeResidentRecord(records, 0, [0, 0, 8, 10], 1, 2, 7);
    writeResidentRecord(records, 1, [10, 0, 18, 10], 20, 3, 8);
    writeResidentRecord(records, 2, [20, 0, 28, 10], 99, 0, 9);
    writeResidentRecord(records, 3, [30, 0, 38, 10], 30, 1, 10);

    const draw = planResidentCullDraw(
      records,
      { x: 0, y: 0, width: 100, height: 100, padding: 0 },
      4,
    );
    const sequence = draw.segments.flatMap((segment) =>
      segment.spans.map(
        (span) => `${String(span.offset)}:${String(span.count)}:${String(span.paletteIndex)}`,
      ),
    );

    expect(sequence).toEqual(["1:2:7", "20:3:8", "30:1:10"]);
    expect(draw).toMatchObject({ count: 6, naturalOrder: true });
    expect(() =>
      planResidentCullDraw(
        records.slice(0, 32),
        { x: 0, y: 0, width: 1, height: 1, padding: 0 },
        2,
      ),
    ).toThrow(RangeError);
  });

  test("selects the WebGL2 adapter and initializes mesh buffers through Pixi", () => {
    const initialized: unknown[] = [];
    const renderer = {
      gl: {
        MAX_TEXTURE_SIZE: 0x0d33,
        getParameter(parameter: number): number {
          expect(parameter).toBe(this.MAX_TEXTURE_SIZE);
          return 4096;
        },
      },
      buffer: {
        updateBuffer(buffer: unknown): void {
          initialized.push(buffer);
        },
      },
    } as unknown as Renderer;
    const platform = createPixiRendererPlatform(renderer);
    const instanceBuffer = { label: "webgl-instances" };

    platform.initializeMesh({ instanceBuffer } as never);

    expect(platform.kind).toBe("webgl");
    expect(platform.maxTextureSize).toBe(4096);
    expect(initialized).toEqual([instanceBuffer]);
  });

  test("prefers live palette slots over multi-megabyte WebGL dirty bands", () => {
    const platform = createPixiRendererPlatform(fakeWebGlRenderer());

    expect(platform.planPaletteTextureWidth(2_097_152, 1_024)).toBe(512);
    expect(
      platform.planPaletteTextureRanges([{ offset: 0, length: 20_000_000 }], [4, 500_000], 0),
    ).toEqual([
      { offset: 128, length: 32 },
      { offset: 16_000_000, length: 32 },
    ]);
  });

  test("selects the WebGPU adapter and reads device limits once at the seam", () => {
    const initialized: unknown[] = [];
    const renderer = {
      gpu: {
        device: {
          limits: { maxTextureDimension2D: 8192 },
        },
      },
      buffer: {
        updateBuffer(buffer: unknown): void {
          initialized.push(buffer);
        },
      },
    } as unknown as Renderer;
    const platform = createPixiRendererPlatform(renderer);
    const instanceBuffer = { label: "webgpu-instances" };

    platform.initializeMesh({ instanceBuffer } as never);

    expect(platform.kind).toBe("webgpu");
    expect(platform.maxTextureSize).toBe(8192);
    expect(initialized).toEqual([instanceBuffer]);
  });

  test("releases partially constructed renderer resources and restores WebGPU hooks", () => {
    const constructionError = new Error("injected rgba atlas construction failure");
    const cleanupError = new Error("injected atlas cleanup failure");
    const destroyed: string[] = [];
    const retiredSources: Array<{ readonly destroyed: boolean }> = [];
    const originalUint8ArrayDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array");
    const originalTextureDestroy = Object.getOwnPropertyDescriptor(Texture.prototype, "destroy");
    const originalUint8Array = globalThis.Uint8Array;
    const faultingUint8Array = new Proxy(originalUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === 4) throw constructionError;
        return Reflect.construct(target, args, newTarget);
      },
    });
    const originalRenderStart = (): void => {};
    const originalPostrender = (): void => {};
    const encoder = {
      commandEncoder: null,
      draw(): void {},
      renderStart: originalRenderStart,
      postrender: originalPostrender,
    };
    const renderer = {
      gpu: { device: { limits: { maxTextureDimension2D: 8192 } } },
      buffer: { updateBuffer(): void {} },
      encoder,
    } as unknown as Renderer;

    Object.defineProperty(globalThis, "Uint8Array", {
      configurable: true,
      value: faultingUint8Array,
      writable: true,
    });
    Object.defineProperty(Texture.prototype, "destroy", {
      configurable: true,
      value: function (this: Texture, destroySource?: boolean): void {
        const label = this.source.label;
        destroyed.push(label);
        retiredSources.push(this.source);
        if (label === "pixi-glyphflow-atlas-r") throw cleanupError;
        originalTextureDestroy?.value.call(this, destroySource);
      },
      writable: true,
    });
    try {
      let caught: unknown;
      try {
        new DefaultPixiRendererBackend(
          renderer,
          { addChild(): void {} } as never,
          {
            transforms: {
              data: new Float32Array(8),
              stats: { textureWidth: 2, effectBase: 4 },
            },
          } as never,
        );
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBe(constructionError);
      expect(destroyed).toEqual([
        "pixi-glyphflow-atlas-r",
        "pixi-glyphflow-prototypes",
        "pixi-glyphflow-transforms",
      ]);
      expect(retiredSources.map((source) => source.destroyed)).toEqual([true, true, true]);
      expect(encoder.renderStart).toBe(originalRenderStart);
      expect(encoder.postrender).toBe(originalPostrender);
    } finally {
      if (originalUint8ArrayDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "Uint8Array");
      } else {
        Object.defineProperty(globalThis, "Uint8Array", originalUint8ArrayDescriptor);
      }
      if (originalTextureDestroy !== undefined) {
        Object.defineProperty(Texture.prototype, "destroy", originalTextureDestroy);
      }
    }
  });

  test("scatters 32K active palette slots from a million-slot WebGPU table", () => {
    const activeLabels = 32_768;
    const commandWrites: number[] = [];
    const gpuTransforms = { label: "gpu-transforms" };
    const device = {
      limits: {
        maxTextureDimension2D: 8192,
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: 64 * 1_024 * 1_024,
        maxBufferSize: 64 * 1_024 * 1_024,
      },
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: ({ label }: { label: string }) => ({ label, destroy() {} }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setBindGroup() {},
          setPipeline() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (
          buffer: { label: string },
          _offset: number,
          _source: AllowSharedBufferSource,
          _sourceOffset?: number,
          size?: number,
        ) => {
          if (buffer.label === "pixi-glyphflow-palette-transform-commands") {
            commandWrites.push(size ?? 0);
          }
        },
        submit() {},
      },
    };
    const renderer = {
      gpu: { device },
      buffer: {
        updateBuffer() {},
        getGPUBuffer: () => gpuTransforms,
      },
    } as unknown as Renderer;
    const drawStates = Array.from({ length: activeLabels }, (_, slot) => ({
      slot,
      zIndex: 0,
      order: slot,
      blendMode: "normal",
    }));
    const transforms = {
      data: new Float32Array(1_000_000 * 8),
      stats: { textureWidth: 1024, effectBase: 0 },
      refreshOrigins: () => 0,
    };
    const restoreGpuGlobals = installRendererGpuGlobals();
    try {
      const backend = new DefaultPixiRendererBackend(
        renderer,
        { addChild() {} } as never,
        { transforms, getDrawStates: () => drawStates } as never,
      );

      backend.flushPaletteStorage();

      expect(commandWrites).toEqual([activeLabels * 64]);
      expect(backend.stats).toMatchObject({
        adapter: "webgpu",
        palettePath: "storage",
        transformUploadBytes: paletteTransformDispatchBytes(activeLabels),
        transformWrites: 1,
      });
      backend.destroy();
    } finally {
      restoreGpuGlobals();
    }
  });

  test("counts the two accepted mover writes when bind-group creation fails", () => {
    let failNextBindGroup = false;
    const gpuTransforms = { label: "gpu-transforms" };
    const device = {
      limits: {
        maxTextureDimension2D: 8192,
        maxStorageBuffersInVertexStage: 1,
        maxStorageBuffersPerShaderStage: 8,
        maxStorageBufferBindingSize: 1_048_576,
        maxBufferSize: 1_048_576,
        maxComputeWorkgroupsPerDimension: 65_535,
      },
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: ({ label, size, usage }: { label: string; size: number; usage: number }) => ({
        label,
        size,
        usage,
        destroy() {},
      }),
      createBindGroup: () => {
        if (failNextBindGroup) {
          failNextBindGroup = false;
          throw new Error("injected mover bind-group failure");
        }
        return {};
      },
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setBindGroup() {},
          setPipeline() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer() {},
        submit() {},
      },
    };
    const renderer = {
      gpu: { device },
      buffer: {
        updateBuffer() {},
        getGPUBuffer: () => gpuTransforms,
      },
    } as unknown as Renderer;
    const transforms = {
      data: new Float32Array(8),
      stats: { textureWidth: 1, effectBase: 0 },
      refreshOrigins: () => 0,
    };
    const restoreGpuGlobals = installRendererGpuGlobals();
    try {
      const backend = new DefaultPixiRendererBackend(
        renderer,
        { addChild() {} } as never,
        {
          transforms,
          getDrawStates: () => [{ slot: 0, zIndex: 0, order: 0, blendMode: "normal" }],
        } as never,
      );
      backend.flushPaletteStorage();
      const baseline = backend.stats;

      failNextBindGroup = true;
      backend.queuePaletteMoves({
        mode: "dense",
        baseSlot: 0,
        commands: new Float32Array([10, 20]).buffer,
        count: 1,
      });
      backend.flushPaletteStorage();

      expect(backend.stats.transformUploadBytes - baseline.transformUploadBytes).toBe(
        paletteMoveDispatchBytes("dense", 1),
      );
      expect(backend.stats.transformWrites - baseline.transformWrites).toBe(2);
      backend.destroy();
    } finally {
      restoreGpuGlobals();
    }
  });

  test("keeps capability fallback inside the WebGPU adapter", () => {
    const renderer = {
      gpu: {
        device: {
          limits: {
            maxTextureDimension2D: 8192,
            maxStorageBuffersInVertexStage: 0,
            maxStorageBufferBindingSize: 64 * 1024,
          },
        },
      },
      buffer: { updateBuffer(): void {} },
    } as unknown as Renderer;
    const platform = createPixiRendererPlatform(renderer);

    expect(platform.prepareComputeCull(false, true)).toBeUndefined();
    expect(platform.prepareComputeCull("auto", false)).toBeUndefined();
    expect(platform.preparePaletteStorage(1024)).toBeUndefined();
  });

  test("falls back to the CPU grid when compute capacity allocation fails", () => {
    let createBufferCalls = 0;
    const device = {
      limits: COMPUTE_FALLBACK_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: () => {
        createBufferCalls += 1;
        throw new Error("injected compute capacity failure");
      },
      queue: { writeBuffer() {}, submit() {} },
    };
    const renderer = {
      gpu: { device },
      buffer: { updateBuffer() {} },
      encoder: { draw(): void {} },
    } as unknown as Renderer;
    const coordinator = computeFallbackCoordinator();
    const restoreGlobals = installRendererBrowserGlobals();
    try {
      const backend = computeFallbackBackend(renderer, coordinator);
      const records = new ArrayBuffer(32);
      const floats = new Float32Array(records);
      floats.set([0, 0, 10, 10]);

      expect(
        backend.refreshComputeCull({
          records,
          recordCount: 1,
          recordDirty: "all",
          viewport: { x: 0, y: 0, width: 20, height: 20, padding: 0 },
        }),
      ).toBe("cpu-grid");
      expect(createBufferCalls).toBe(1);
      expect(backend.stats.cullPath).toBe("cpu-grid");
      backend.destroy();
    } finally {
      restoreGlobals();
    }
  });

  test("falls back to the CPU grid when a compute record upload fails", () => {
    const gpuBuffers: DestroyTrackedGpuBuffer[] = [];
    const device = {
      limits: COMPUTE_FALLBACK_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: trackedBufferFactory(gpuBuffers),
      queue: {
        writeBuffer(buffer: { label?: string }) {
          if (buffer.label === "pixi-glyphflow-cull-records") {
            throw new Error("injected compute record upload failure");
          }
        },
        submit() {},
      },
    };
    const renderer = {
      gpu: { device },
      buffer: { updateBuffer() {} },
      encoder: { draw(): void {} },
    } as unknown as Renderer;
    const coordinator = computeFallbackCoordinator();
    const restoreGlobals = installRendererBrowserGlobals();
    try {
      const backend = computeFallbackBackend(renderer, coordinator);
      const records = new ArrayBuffer(32);
      new Float32Array(records).set([0, 0, 10, 10]);

      expect(
        backend.refreshComputeCull({
          records,
          recordCount: 1,
          recordDirty: "all",
          viewport: { x: 0, y: 0, width: 20, height: 20, padding: 0 },
        }),
      ).toBe("cpu-grid");
      expect(backend.stats.cullPath).toBe("cpu-grid");
      expect(gpuBuffers.length).toBeGreaterThan(0);
      expect(gpuBuffers.map((buffer) => buffer.destroyCalls)).toEqual(gpuBuffers.map(() => 0));

      backend.destroy();
      expect(gpuBuffers.map((buffer) => buffer.destroyCalls)).toEqual(gpuBuffers.map(() => 1));
    } finally {
      restoreGlobals();
    }
  });

  test("contains compute dispatch preparation faults across refresh and apply, then recovers", () => {
    const gpuBuffers: DestroyTrackedGpuBuffer[] = [];
    let failureStage: "indirect" | "uniform" | undefined = "uniform";
    const device = {
      limits: COMPUTE_FALLBACK_LIMITS,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: trackedBufferFactory(gpuBuffers),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setBindGroup() {},
          setPipeline() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer(buffer: { label?: string }) {
          if (failureStage === "uniform" && buffer.label === "pixi-glyphflow-cull-uniforms") {
            throw new Error("injected backend uniform failure");
          }
        },
        submit() {},
      },
    };
    const renderer = {
      gpu: { device },
      texture: { getGpuSource: () => ({}) },
      buffer: {
        updateBuffer() {},
        getGPUBuffer() {
          if (failureStage === "indirect") {
            throw new Error("injected backend indirect failure");
          }
          return {};
        },
      },
      encoder: { draw(): void {} },
    } as unknown as Renderer;
    const coordinator = computeFallbackCoordinator(true);
    const restoreGlobals = installRendererBrowserGlobals();
    try {
      const backend = computeFallbackBackend(renderer, coordinator);
      const records = new ArrayBuffer(32);
      new Float32Array(records).set([0, 0, 10, 10]);
      const update = {
        records,
        recordCount: 1,
        recordDirty: "all" as const,
        viewport: { x: 0, y: 0, width: 20, height: 20, padding: 0 },
      };

      expect(() => backend.refreshComputeCull(update)).not.toThrow();
      expect(backend.stats.cullPath).toBe("cpu-grid");

      failureStage = undefined;
      expect(backend.refreshComputeCull(update)).toBe("compute-cull");
      failureStage = "indirect";
      expect(() =>
        backend.apply(renderCommit(), {
          ...update,
          recordDirty: "none",
          viewport: { ...update.viewport, x: 1 },
        }),
      ).not.toThrow();
      expect(backend.stats.cullPath).toBe("cpu-grid");

      failureStage = undefined;
      expect(backend.refreshComputeCull(update)).toBe("compute-cull");
      backend.destroy();
      expect(gpuBuffers.map((buffer) => buffer.destroyCalls)).toEqual(gpuBuffers.map(() => 1));
    } finally {
      restoreGlobals();
    }
  });

  test("retires one failed compute pass and remembers the capability failure until reattach", () => {
    const events: string[] = [];
    const renderer = fakeWebGpuCapabilityRenderer();
    failingShaderModule(renderer, events);
    const factories: WebGpuRendererPassFactories = {
      createComputeCullPass: (target) => {
        events.push("create");
        const pass = new ComputeCullPass(target);
        pass.indirectBuffer.on("destroy", () => events.push("destroy"));
        return pass;
      },
      createPaletteStoragePass: () => {
        throw new Error("Palette factory is outside this test");
      },
    };
    const platform = new WebGPURendererBackendAdapter(renderer, factories);

    expect(platform.prepareComputeCull(true, true)).toBeUndefined();
    expect(platform.prepareComputeCull(true, true)).toBeUndefined();
    expect(events).toEqual(["create", "initialize", "destroy"]);

    const reattached = new WebGPURendererBackendAdapter(renderer, factories);
    expect(reattached.prepareComputeCull(true, true)).toBeUndefined();
    expect(events).toEqual(["create", "initialize", "destroy", "create", "initialize", "destroy"]);
  });

  test("reuses the compute pass after a failed device is replaced", () => {
    const deviceA = {
      limits: COMPUTE_PASS_LIMITS,
    };
    const deviceB = {
      limits: COMPUTE_PASS_LIMITS,
    };
    const rendererState = {
      gpu: { device: deviceA },
      buffer: { updateBuffer(): void {} },
      encoder: { draw(): void {} },
    };
    let initializeCalls = 0;
    let initializeResult = true;
    let factoryCalls = 0;
    const pass = {
      initialize(): boolean {
        initializeCalls += 1;
        return initializeResult;
      },
      destroy(): void {},
    } as unknown as ComputeCullPass;
    const platform = new WebGPURendererBackendAdapter(rendererState as unknown as WebGPURenderer, {
      createComputeCullPass: () => {
        factoryCalls += 1;
        return pass;
      },
      createPaletteStoragePass: () => {
        throw new Error("Palette factory is outside this test");
      },
    });

    expect(platform.prepareComputeCull(true, true)).toBe(pass);
    initializeResult = false;
    expect(platform.prepareComputeCull(true, true)).toBeUndefined();
    expect(platform.prepareComputeCull(true, true)).toBeUndefined();
    expect(initializeCalls).toBe(2);

    rendererState.gpu.device = deviceB;
    initializeResult = true;
    expect(platform.prepareComputeCull(true, true)).toBe(pass);
    expect(factoryCalls).toBe(1);
    expect(initializeCalls).toBe(3);
  });

  test("retries a transient compute hook failure on the same device after one microtask", async () => {
    const device = {
      limits: COMPUTE_PASS_LIMITS,
    };
    const renderer = {
      gpu: { device },
      buffer: { updateBuffer(): void {} },
      encoder: { draw(): void {} },
    } as unknown as WebGPURenderer;
    let initializeCalls = 0;
    let hookHealthy = true;
    const pass = {
      get initializationFailureKind() {
        return hookHealthy ? undefined : "hook-transient";
      },
      initialize(): boolean {
        initializeCalls += 1;
        return hookHealthy;
      },
      destroy(): void {},
    } as unknown as ComputeCullPass;
    const platform = new WebGPURendererBackendAdapter(renderer, {
      createComputeCullPass: () => pass,
      createPaletteStoragePass: () => {
        throw new Error("Palette factory is outside this test");
      },
    });

    expect(platform.prepareComputeCull(true, true)).toBe(pass);
    hookHealthy = false;
    expect(platform.prepareComputeCull(true, true)).toBeUndefined();
    expect(platform.prepareComputeCull(true, true)).toBeUndefined();
    expect(initializeCalls).toBe(2);

    hookHealthy = true;
    await Promise.resolve();
    expect(platform.prepareComputeCull(true, true)).toBe(pass);
    expect(initializeCalls).toBe(3);
  });

  test("retires one failed palette pass and remembers the capability failure until reattach", () => {
    const events: string[] = [];
    const renderer = fakeWebGpuCapabilityRenderer();
    failingShaderModule(renderer, events);
    const factories: WebGpuRendererPassFactories = {
      createComputeCullPass: () => {
        throw new Error("Compute factory is outside this test");
      },
      createPaletteStoragePass: (target) => {
        events.push("create");
        const pass = new PaletteStoragePass(target);
        pass.transformBuffer.on("destroy", () => events.push("destroy"));
        return pass;
      },
    };
    const platform = new WebGPURendererBackendAdapter(renderer, factories);

    expect(platform.preparePaletteStorage(1_024)).toBeUndefined();
    expect(platform.preparePaletteStorage(1_024)).toBeUndefined();
    expect(events).toEqual(["create", "initialize", "destroy"]);

    const reattached = new WebGPURendererBackendAdapter(renderer, factories);
    expect(reattached.preparePaletteStorage(1_024)).toBeUndefined();
    expect(events).toEqual(["create", "initialize", "destroy", "create", "initialize", "destroy"]);
  });

  test("reuses the palette pass after a transient failure when the WebGPU device changes", () => {
    const deviceA = {
      limits: {
        maxTextureDimension2D: 8_192,
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
      },
    };
    const deviceB = {
      limits: {
        maxTextureDimension2D: 8_192,
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
      },
    };
    const rendererState = {
      gpu: { device: deviceA },
      buffer: { updateBuffer(): void {} },
      encoder: { draw(): void {} },
    };
    let initializeCalls = 0;
    let initializeResult = true;
    let factoryCalls = 0;
    const pass = {
      initialize(): boolean {
        initializeCalls += 1;
        return initializeResult;
      },
      ensureTransforms: () => ({ ok: true, replaced: false }),
      destroy(): void {},
    } as unknown as PaletteStoragePass;
    const platform = new WebGPURendererBackendAdapter(rendererState as unknown as WebGPURenderer, {
      createComputeCullPass: () => {
        throw new Error("Compute factory is outside this test");
      },
      createPaletteStoragePass: () => {
        factoryCalls += 1;
        return pass;
      },
    });

    expect(platform.preparePaletteStorage(1_024)?.pass).toBe(pass);
    initializeResult = false;
    expect(platform.preparePaletteStorage(1_024)).toBeUndefined();
    expect(platform.preparePaletteStorage(1_024)).toBeUndefined();
    expect(initializeCalls).toBe(2);

    rendererState.gpu.device = deviceB;
    initializeResult = true;
    expect(platform.preparePaletteStorage(1_024)?.pass).toBe(pass);
    expect(factoryCalls).toBe(1);
    expect(initializeCalls).toBe(3);
  });

  test("copies an opt-in outline source into the requested WebGPU color-array layer", async () => {
    const events: unknown[] = [];
    const sourceTexture = { label: "outline-source" } as unknown as GPUTexture;
    const destinationTexture = { label: "color-array" };
    const commandBuffer = { label: "copy-command" };
    const renderer = {
      gpu: {
        device: {
          limits: { maxTextureDimension2D: 8192 },
          createCommandEncoder: () => ({
            copyTextureToTexture: (source: unknown, destination: unknown, size: unknown) =>
              events.push({ source, destination, size }),
            finish: () => commandBuffer,
          }),
          queue: {
            submit: (commands: unknown) => events.push({ submit: commands }),
            onSubmittedWorkDone: async () => {
              events.push("complete");
            },
          },
        },
      },
      texture: { getGpuSource: () => destinationTexture },
      buffer: { updateBuffer(): void {} },
    } as unknown as Renderer;
    const platform = createPixiRendererPlatform(renderer);

    expect(
      await platform.copyColorAtlasToArray(sourceTexture, [
        {
          destination: {
            info: { layer: 3 },
            array: { source: {} },
          } as never,
          sourceX: 4,
          sourceY: 8,
          destinationX: 16,
          destinationY: 32,
          width: 64,
          height: 96,
        },
      ]),
    ).toBe(true);
    expect(events).toEqual([
      {
        source: { texture: sourceTexture, origin: { x: 4, y: 8, z: 0 } },
        destination: {
          texture: destinationTexture,
          origin: { x: 16, y: 32, z: 3 },
        },
        size: { width: 64, height: 96, depthOrArrayLayers: 1 },
      },
      { submit: [commandBuffer] },
      "complete",
    ]);
  });

  test("migrates live WebGPU atlas layers before retiring a replaced array", async () => {
    const events: unknown[] = [];
    const previousGpuTexture = { label: "previous-array" };
    const nextGpuTexture = { label: "next-array" };
    const previousSource = { label: "previous-source" };
    const nextSource = { label: "next-source" };
    const command = { label: "migration-command" };
    const renderer = {
      gpu: {
        device: {
          limits: { maxTextureDimension2D: 8192 },
          createCommandEncoder: () => ({
            copyTextureToTexture: (source: unknown, destination: unknown, size: unknown) =>
              events.push({ source, destination, size }),
            finish: () => command,
          }),
          queue: {
            submit: (commands: unknown) => events.push({ submit: commands }),
            onSubmittedWorkDone: async () => events.push("complete"),
          },
        },
      },
      texture: {
        getGpuSource: (source: unknown) =>
          source === previousSource ? previousGpuTexture : nextGpuTexture,
      },
      buffer: { updateBuffer(): void {} },
    } as unknown as Renderer;
    const platform = createPixiRendererPlatform(renderer);
    const previousTexture = { destroy: () => events.push("retire") };

    expect(
      platform.migrateAtlasArray(
        {
          width: 64,
          height: 32,
          layerCount: 2,
          initialized: true,
          dummy: false,
          source: previousSource,
          texture: previousTexture,
        } as never,
        { width: 64, height: 32, source: nextSource } as never,
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(events).toEqual([
      {
        source: { texture: previousGpuTexture, origin: { x: 0, y: 0, z: 0 } },
        destination: { texture: nextGpuTexture, origin: { x: 0, y: 0, z: 0 } },
        size: { width: 64, height: 32, depthOrArrayLayers: 1 },
      },
      {
        source: { texture: previousGpuTexture, origin: { x: 0, y: 0, z: 1 } },
        destination: { texture: nextGpuTexture, origin: { x: 0, y: 0, z: 1 } },
        size: { width: 64, height: 32, depthOrArrayLayers: 1 },
      },
      { submit: [command] },
      "complete",
      "retire",
    ]);
  });

  test("reads the compute indirect instance count only when telemetry requests it", async () => {
    const events: unknown[] = [];
    const indirect = { label: "indirect" };
    const command = { label: "readback-command" };
    const mapped = new Uint32Array([259_605]);
    const readback = {
      mapAsync: async (mode: number) => events.push({ map: mode }),
      getMappedRange: () => mapped.buffer,
      unmap: () => {
        events.push("unmap");
        throw new Error("injected readback unmap failure");
      },
      destroy: () => {
        events.push("destroy");
        throw new Error("injected readback destroy failure");
      },
    };
    const renderer = {
      gpu: {
        device: {
          limits: { maxStorageBuffersPerShaderStage: 8 },
          createShaderModule: () => ({}),
          createBindGroupLayout: () => ({}),
          createPipelineLayout: () => ({}),
          createComputePipeline: () => ({}),
          createBuffer: () => readback,
          createCommandEncoder: () => ({
            copyBufferToBuffer: (...copy: unknown[]) => events.push({ copy }),
            finish: () => command,
          }),
          queue: { submit: (commands: unknown) => events.push({ submit: commands }) },
        },
      },
      buffer: { getGPUBuffer: () => indirect },
      encoder: { draw(): void {} },
    } as unknown as WebGPURenderer;
    const restoreGpuGlobals = installWebGpuGlobals({
      GPUShaderStage: { COMPUTE: 4 },
    });
    try {
      const pass = new ComputeCullPass(renderer);

      expect(pass.initialize()).toBe(true);
      expect(pass.indirectBuffer.descriptor.usage & BufferUsage.COPY_SRC).toBe(
        BufferUsage.COPY_SRC,
      );
      expect(await pass.readInstanceCount()).toBe(259_605);
      expect(events).toEqual([
        { copy: [indirect, 4, readback, 0, 4] },
        { submit: [command] },
        { map: 1 },
        "unmap",
        "destroy",
      ]);
    } finally {
      restoreGpuGlobals();
    }
  });

  test("destroys meshes before texture resources through the selected adapter", () => {
    for (const renderer of [fakeWebGlRenderer(), fakeWebGpuRenderer()]) {
      const events: string[] = [];
      const platform = createPixiRendererPlatform(renderer);
      const mesh = {
        removeFromParent: () => events.push("mesh:remove"),
        destroy: () => events.push("mesh:destroy"),
        geometry: {},
      };
      const texture = (name: string) =>
        ({ destroy: () => events.push(name) }) as unknown as Texture;

      platform.destroy({
        meshes: [mesh as never],
        atlasTextures: [texture("atlas:r"), texture("atlas:rgba")],
        paletteTexture: texture("palette"),
        prototypeTexture: texture("prototype"),
      });

      expect(events).toEqual([
        "mesh:remove",
        "mesh:destroy",
        "atlas:r",
        "atlas:rgba",
        "palette",
        "prototype",
      ]);
    }
  });

  test("continues adapter cleanup after multiple resource faults and reports the first error", () => {
    for (const renderer of [fakeWebGlRenderer(), fakeWebGpuRenderer()]) {
      const platform = createPixiRendererPlatform(renderer);
      const firstError = new Error(`${platform.kind}: first mesh removal failed`);
      const events: string[] = [];
      const mesh = (name: string, removeError?: Error, destroyError?: Error) => ({
        geometry: {},
        removeFromParent(): void {
          events.push(`${name}:remove`);
          if (removeError !== undefined) throw removeError;
        },
        destroy(): void {
          events.push(`${name}:destroy`);
          if (destroyError !== undefined) throw destroyError;
        },
      });
      const texture = (name: string, error?: Error) =>
        ({
          destroy(): void {
            events.push(name);
            if (error !== undefined) throw error;
          },
        }) as unknown as Texture;
      let caught: unknown;
      const resources = {
        meshes: [
          mesh("first", firstError) as never,
          mesh("second", undefined, new Error("second mesh destroy failed")) as never,
        ],
        atlasTextures: [
          texture("atlas:r", new Error("atlas r cleanup failed")),
          texture("atlas:rgba"),
        ],
        paletteTexture: texture("palette", new Error("palette cleanup failed")),
        prototypeTexture: texture("prototype"),
      };

      try {
        platform.destroy(resources);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBe(firstError);
      expect(events).toEqual([
        "first:remove",
        "first:destroy",
        "second:remove",
        "second:destroy",
        "atlas:r",
        "atlas:rgba",
        "palette",
        "prototype",
      ]);
      expect(() => platform.destroy(resources)).not.toThrow();
      expect(events).toHaveLength(8);
    }
  });

  test("detaches WebGPU passes and restores lifecycle hooks before faulting retirement", () => {
    const events: string[] = [];
    const originalRenderStart = (): void => {};
    const originalPostrender = (): void => {};
    const renderer = {
      gpu: {
        device: {
          limits: {
            maxTextureDimension2D: 8192,
            maxStorageBuffersInVertexStage: 1,
            maxStorageBufferBindingSize: 128 * 1024 * 1024,
          },
        },
      },
      buffer: { updateBuffer(): void {} },
      encoder: {
        commandEncoder: null,
        draw(): void {},
        renderStart: originalRenderStart,
        postrender: originalPostrender,
      },
    } as unknown as WebGPURenderer;
    const computePass = {
      initialize: () => true,
      untrackGeometry: () => events.push("compute:untrack"),
      destroy(): void {
        events.push("compute:destroy");
        throw new Error("compute cleanup failed");
      },
    } as unknown as ComputeCullPass;
    const palettePass = {
      initialize: () => true,
      ensureTransforms: () => ({ ok: true, replaced: false }),
      destroy(): void {
        events.push("palette-pass:destroy");
        throw new Error("palette pass cleanup failed");
      },
    } as unknown as PaletteStoragePass;
    const platform = new WebGPURendererBackendAdapter(renderer, {
      createComputeCullPass: () => computePass,
      createPaletteStoragePass: () => palettePass,
    });
    const texture = (name: string) =>
      ({
        destroy(): void {
          events.push(name);
          throw new Error(`${name} cleanup failed`);
        },
      }) as unknown as Texture;
    const mesh = {
      geometry: {},
      removeFromParent: () => events.push("mesh:remove"),
      destroy: () => events.push("mesh:destroy"),
    };

    expect(platform.prepareComputeCull(true, true)).toBe(computePass);
    expect(platform.preparePaletteStorage(1_024)?.pass).toBe(palettePass);
    platform.destroy({
      meshes: [mesh as never],
      atlasTextures: [texture("atlas")],
      paletteTexture: texture("palette"),
      prototypeTexture: texture("prototype"),
    });

    expect(platform.computeCullPass).toBeUndefined();
    expect(platform.paletteStoragePass).toBeUndefined();
    expect(renderer.encoder.renderStart).toBe(originalRenderStart);
    expect(renderer.encoder.postrender).toBe(originalPostrender);
    expect(events).toEqual([
      "compute:untrack",
      "mesh:remove",
      "mesh:destroy",
      "compute:destroy",
      "palette-pass:destroy",
      "atlas",
      "palette",
      "prototype",
    ]);
  });

  test("makes top-level destroy exact-once after adapter cleanup faults", () => {
    const firstError = new Error("top-level atlas cleanup failed");
    const destroyed: string[] = [];
    const originalTextureDestroy = Object.getOwnPropertyDescriptor(Texture.prototype, "destroy");
    const backend = new DefaultPixiRendererBackend(
      fakeWebGlRenderer(),
      { addChild(): void {} } as never,
      {
        transforms: {
          data: new Float32Array(8),
          stats: { textureWidth: 2, effectBase: 4 },
        },
      } as never,
    );
    Object.defineProperty(Texture.prototype, "destroy", {
      configurable: true,
      value: function (this: Texture, destroySource?: boolean): void {
        const label = this.source.label;
        destroyed.push(label);
        originalTextureDestroy?.value.call(this, destroySource);
        if (label === "pixi-glyphflow-atlas-r") throw firstError;
        if (label === "pixi-glyphflow-prototypes") {
          throw new Error("top-level prototype cleanup failed");
        }
      },
      writable: true,
    });
    try {
      expect(() => backend.destroy()).toThrow(firstError);
      expect(backend.stats).toMatchObject({ meshes: 0, atlasTextures: 0, submittedGlyphs: 0 });
      expect(() => backend.destroy()).not.toThrow();
      expect(destroyed).toEqual([
        "pixi-glyphflow-atlas-r",
        "pixi-glyphflow-atlas-rgba",
        "pixi-glyphflow-transforms",
        "pixi-glyphflow-prototypes",
      ]);
    } finally {
      if (originalTextureDestroy !== undefined) {
        Object.defineProperty(Texture.prototype, "destroy", originalTextureDestroy);
      }
    }
  });

  test("releases an atlas source when Texture construction faults", () => {
    const constructionError = new Error("injected atlas Texture construction failure");
    const originalOnDescriptor = Object.getOwnPropertyDescriptor(BufferImageSource.prototype, "on");
    const originalOn = BufferImageSource.prototype.on;
    const candidates: BufferImageSource[] = [];
    Object.defineProperty(BufferImageSource.prototype, "on", {
      configurable: true,
      value: function (this: BufferImageSource, ...args: unknown[]): unknown {
        if (this.label === "pixi-glyphflow-atlas-r" && args[0] === "resize") {
          candidates.push(this);
          throw constructionError;
        }
        return Reflect.apply(originalOn, this, args);
      },
      writable: true,
    });
    try {
      let caught: unknown;
      try {
        createAtlasArray("r", 4, 4, 1, false);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBe(constructionError);
      expect(candidates[0]?.destroyed).toBe(true);
    } finally {
      restoreOwnDescriptor(BufferImageSource.prototype, "on", originalOnDescriptor);
    }
  });

  test("rolls back a failed atlas migration and recovers from the retained array", () => {
    const migrationError = new Error("injected atlas migration failure");
    const originalMigrate = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "migrateAtlasArray",
    );
    const calls: Array<{
      previous: { source: BufferImageSource };
      next: ReturnType<typeof createAtlasArray>;
    }> = [];
    let fault = false;
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "migrateAtlasArray", {
      configurable: true,
      value(
        previous: { source: BufferImageSource },
        next: ReturnType<typeof createAtlasArray>,
      ): boolean {
        calls.push({ previous, next });
        if (fault) throw migrationError;
        return false;
      },
      writable: true,
    });
    const fixture = backendFixture(0);
    fixture.pages.set(0, atlasPage(0, 0));
    fixture.pages.set(1, atlasPage(1, 1));
    const backend = new DefaultPixiRendererBackend(
      fixture.renderer,
      {
        addChild<T>(child: T): T {
          return child;
        },
      } as never,
      fixture.coordinator as never,
    );
    try {
      backend.apply(renderCommit([atlasUpload(0, 0)]));
      expect(calls).toHaveLength(1);
      const retained = calls[0]?.next;
      expect(retained).toBeDefined();

      fault = true;
      let caught: unknown;
      try {
        backend.apply(renderCommit([atlasUpload(1, 1)]));
      } catch (error: unknown) {
        caught = error;
      }
      const failedCandidate = calls[1]?.next;
      expect(caught).toBe(migrationError);
      expect(calls[1]?.previous).toBe(retained);
      expect(failedCandidate?.texture.destroyed).toBe(true);
      expect(failedCandidate?.source.destroyed).toBe(true);
      expect(retained?.source.destroyed).toBe(false);
      expect(backend.stats).toMatchObject({ atlasTextures: 1, pageRebuilds: 1 });

      fault = false;
      backend.apply(renderCommit());
      expect(calls[2]?.previous).toBe(retained);
      expect(calls[2]?.next).not.toBe(failedCandidate);
      expect(backend.stats).toMatchObject({ atlasTextures: 2, pageRebuilds: 2 });
    } finally {
      backend.destroy();
      restoreOwnDescriptor(
        WebGPURendererBackendAdapter.prototype,
        "migrateAtlasArray",
        originalMigrate,
      );
    }
  });

  test("replays every staged atlas upload after an Nth upload fault on an empty commit", () => {
    const uploadError = new Error("injected second atlas upload failure");
    const originalUpload = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "uploadAtlas",
    );
    const calls: Array<{
      x: number;
      width: number;
      height: number;
      pixels: number[];
    }> = [];
    let callCount = 0;
    let faultAt: number | undefined;
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "uploadAtlas", {
      configurable: true,
      value(
        this: WebGPURendererBackendAdapter,
        page: Parameters<WebGPURendererBackendAdapter["uploadAtlas"]>[0],
        x: number,
        y: number,
        width: number,
        height: number,
        pixels: Uint8Array,
      ): void {
        callCount += 1;
        calls.push({ x, width, height, pixels: Array.from(pixels) });
        if (callCount === faultAt) throw uploadError;
        originalUpload?.value.call(this, page, x, y, width, height, pixels);
      },
      writable: true,
    });
    const fixture = backendFixture(0);
    fixture.pages.set(0, atlasPage(0, 0));
    const backend = fixtureBackend(fixture);
    try {
      backend.apply(renderCommit([atlasUpload(0, 0)]));
      calls.length = 0;
      callCount = 0;
      faultAt = 2;

      let caught: unknown;
      try {
        backend.apply(renderCommit([atlasUpload(0, 0, 0, 17), atlasUpload(0, 0, 1, 29)]));
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(uploadError);
      expect(calls.map((call) => call.x)).toEqual([0, 1]);

      faultAt = undefined;
      calls.length = 0;
      backend.apply(renderCommit());
      expect(calls).toEqual([
        {
          x: 0,
          width: 4,
          height: 4,
          pixels: [17, 29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
      ]);

      calls.length = 0;
      backend.apply(renderCommit());
      expect(calls).toHaveLength(0);
    } finally {
      backend.destroy();
      restoreOwnDescriptor(WebGPURendererBackendAdapter.prototype, "uploadAtlas", originalUpload);
    }
  });

  test("replays consumed palette and prototype dirties in full on an empty commit", () => {
    const paletteError = new Error("injected palette upload failure");
    const prototypeError = new Error("injected prototype upload failure");
    const originalUpload = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "uploadFloatTextureRanges",
    );
    const calls: Array<{
      label: string;
      ranges: Array<{ offset: number; length: number }>;
      float0: number;
      word0: number;
    }> = [];
    let faultLabel: string | undefined;
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "uploadFloatTextureRanges", {
      configurable: true,
      value(
        this: WebGPURendererBackendAdapter,
        source: BufferImageSource,
        data: Float32Array,
        textureWidth: number,
        ranges: readonly Readonly<{ offset: number; length: number }>[],
      ): Readonly<{ bytes: number; writes: number }> {
        const label = source.label;
        calls.push({
          label,
          ranges: ranges.map((range) => ({ ...range })),
          float0: data[0] ?? 0,
          word0: new Uint32Array(data.buffer, data.byteOffset, data.length)[0] ?? 0,
        });
        if (label === faultLabel) {
          throw label === "pixi-glyphflow-transforms" ? paletteError : prototypeError;
        }
        return originalUpload?.value.call(this, source, data, textureWidth, ranges);
      },
      writable: true,
    });
    const fixture = backendFixture(1);
    fixture.transformRanges = [{ offset: 0, length: fixture.transforms.data.byteLength }];
    const backend = fixtureBackend(fixture);
    try {
      backend.apply(renderCommit());
      calls.length = 0;
      fixture.transforms.data.set([123.5]);
      fixture.transformRanges = [{ offset: 0, length: 16 }];
      const firstPrototypeWord = 0x1234_5678;
      new Uint32Array(fixture.instances.buffer)[0] = firstPrototypeWord;
      fixture.instanceRanges = [{ offset: 0, length: 24 }];
      faultLabel = "pixi-glyphflow-transforms";

      let caught: unknown;
      try {
        backend.apply(renderCommit());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(paletteError);
      expect(calls.map((call) => call.label)).toEqual(["pixi-glyphflow-transforms"]);

      faultLabel = undefined;
      calls.length = 0;
      backend.apply(renderCommit());
      const recoveredPalette = calls.find((call) => call.label === "pixi-glyphflow-transforms");
      const recoveredPrototype = calls.find((call) => call.label === "pixi-glyphflow-prototypes");
      expect(recoveredPalette).toMatchObject({
        ranges: [{ offset: 0, length: fixture.transforms.data.byteLength }],
        float0: 123.5,
      });
      expect(recoveredPrototype).toMatchObject({
        ranges: [{ offset: 0, length: 32 }],
        word0: firstPrototypeWord,
      });

      const secondPrototypeWord = 0x0102_0304;
      new Uint32Array(fixture.instances.buffer)[0] = secondPrototypeWord;
      fixture.instanceRanges = [{ offset: 0, length: 24 }];
      faultLabel = "pixi-glyphflow-prototypes";
      calls.length = 0;
      caught = undefined;
      try {
        backend.apply(renderCommit());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(prototypeError);
      expect(calls.map((call) => call.label)).toEqual(["pixi-glyphflow-prototypes"]);

      faultLabel = undefined;
      calls.length = 0;
      backend.apply(renderCommit());
      expect(calls.find((call) => call.label === "pixi-glyphflow-transforms")?.ranges).toEqual([
        { offset: 0, length: fixture.transforms.data.byteLength },
      ]);
      expect(calls.find((call) => call.label === "pixi-glyphflow-prototypes")).toMatchObject({
        ranges: [{ offset: 0, length: 32 }],
        word0: secondPrototypeWord,
      });

      calls.length = 0;
      backend.apply(renderCommit());
      expect(calls).toHaveLength(0);
    } finally {
      backend.destroy();
      restoreOwnDescriptor(
        WebGPURendererBackendAdapter.prototype,
        "uploadFloatTextureRanges",
        originalUpload,
      );
    }
  });

  test("rebuilds appended draw segments after mesh initialization and binding faults", () => {
    const initializeError = new Error("injected second mesh initialization failure");
    const bindError = new Error("injected second mesh binding failure");
    const originalInitialize = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "initializeMesh",
    );
    const originalBind = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "bindMesh",
    );
    let initializeCalls = 0;
    let initializeFaultAt: number | undefined;
    const boundMeshes: object[] = [];
    let bindCalls = 0;
    let bindFaultAt: number | undefined;
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "initializeMesh", {
      configurable: true,
      value(this: WebGPURendererBackendAdapter, mesh: object): void {
        initializeCalls += 1;
        if (initializeCalls === initializeFaultAt) throw initializeError;
        originalInitialize?.value.call(this, mesh);
      },
      writable: true,
    });
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "bindMesh", {
      configurable: true,
      value(
        this: WebGPURendererBackendAdapter,
        mesh: object,
        bindings: Parameters<WebGPURendererBackendAdapter["bindMesh"]>[1],
      ): void {
        bindCalls += 1;
        boundMeshes.push(mesh);
        if (bindCalls === bindFaultAt) throw bindError;
        originalBind?.value.call(this, mesh, bindings);
      },
      writable: true,
    });
    const fixture = backendFixture(1);
    fixture.transformRanges = [{ offset: 0, length: fixture.transforms.data.byteLength }];
    const backend = fixtureBackend(fixture);
    try {
      backend.apply(renderCommit());
      fixture.drawStates.push({ slot: 1, zIndex: 1, order: 1, blendMode: "normal" });
      fixture.instances.buffer = instanceBuffer(2, 2);
      fixture.instances.stats.activeInstances = 2;
      fixture.instances.stats.highWater = 2;
      fixture.instances.segmentEpoch += 1;
      fixture.instanceRanges = [{ offset: 24, length: 24 }];
      fixture.coordinator.drawListEpoch += 1;
      initializeCalls = 0;
      initializeFaultAt = 2;

      let caught: unknown;
      try {
        backend.apply(renderCommit([], true));
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(initializeError);
      expect(initializeCalls).toBe(2);
      expect(backend.stats.meshes).toBe(2);

      initializeFaultAt = undefined;
      initializeCalls = 0;
      backend.apply(renderCommit());
      expect(initializeCalls).toBe(2);
      expect(backend.stats).toMatchObject({ meshes: 2, submittedGlyphs: 2 });

      initializeCalls = 0;
      backend.apply(renderCommit());
      expect(initializeCalls).toBe(0);

      bindCalls = 0;
      boundMeshes.length = 0;
      bindFaultAt = 2;
      caught = undefined;
      try {
        backend.apply(renderCommit());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(bindError);
      expect(bindCalls).toBe(2);

      bindFaultAt = undefined;
      bindCalls = 0;
      boundMeshes.length = 0;
      initializeCalls = 0;
      backend.apply(renderCommit());
      expect(initializeCalls).toBe(2);
      expect(new Set(boundMeshes).size).toBe(2);
      expect(backend.stats).toMatchObject({ meshes: 2, submittedGlyphs: 2 });

      initializeCalls = 0;
      backend.apply(renderCommit());
      expect(initializeCalls).toBe(0);
    } finally {
      backend.destroy();
      restoreOwnDescriptor(
        WebGPURendererBackendAdapter.prototype,
        "initializeMesh",
        originalInitialize,
      );
      restoreOwnDescriptor(WebGPURendererBackendAdapter.prototype, "bindMesh", originalBind);
    }
  });

  test("refreshes a single-prototype resident uniform when same-slot geometry changes", () => {
    const residentPasses = installResidentBackendPasses();
    const fixture = backendFixture(1);
    const words = new Uint32Array(fixture.instances.buffer);
    words.set([0x3c00_3800, 0x4000_3c00, 0x4000_2000, 0x6000_4000]);
    const metadata = words[5];
    fixture.instanceRanges = [{ offset: 0, length: 24 }];
    const update = residentCullUpdate();
    const restoreDocument = installRendererDocument();
    const backend = fixtureBackend(fixture, { computeCull: true });
    try {
      backend.apply(renderCommit(), update);
      const mesh = fixture.addedMeshes.at(-1) as GlyphMesh;
      const firstPrototype = packedPrototype(fixture.instances.buffer);
      expect(residentUniform(mesh)).toEqual(Array.from(firstPrototype));

      words.set([0x4400_4200, 0x4800_4600, 0x7000_1000, 0x5000_3000]);
      fixture.instanceRanges = [{ offset: 0, length: 16 }];
      backend.apply(renderCommit(), {
        ...update,
        recordDirty: "none",
        localBoundsDirty: "none",
      });

      const currentMesh = fixture.addedMeshes.at(-1) as GlyphMesh;
      const secondPrototype = packedPrototype(fixture.instances.buffer);
      expect(Array.from(secondPrototype)).not.toEqual(Array.from(firstPrototype));
      expect(words[5]).toBe(metadata);
      expect(residentUniform(currentMesh)).toEqual(Array.from(secondPrototype));
    } finally {
      backend.destroy();
      residentPasses.restore();
      restoreDocument();
    }
  });

  test("refreshes every prototype in a five-glyph resident run uniform in place", () => {
    const residentPasses = installResidentBackendPasses();
    const fixture = backendFixture(1);
    configureResidentPrototypeRun(fixture, 5);
    writePrototypeWords(fixture.instances.buffer, 0x1000);
    fixture.instanceRanges = [{ offset: 0, length: fixture.instances.buffer.byteLength }];
    const update = residentCullUpdate(5);
    const restoreDocument = installRendererDocument();
    const backend = fixtureBackend(fixture, { computeCull: true });
    try {
      backend.apply(renderCommit(), update);
      const mesh = fixture.addedMeshes.at(-1) as GlyphMesh;
      const first = packedPrototypeRun(fixture.instances.buffer, 5);
      expect(residentRunUniform(mesh, 5)).toEqual(Array.from(first));

      writePrototypeWords(fixture.instances.buffer, 0x5000);
      fixture.instanceRanges = [{ offset: 0, length: fixture.instances.buffer.byteLength }];
      backend.apply(renderCommit(), {
        ...update,
        recordDirty: "none",
        localBoundsDirty: "none",
      });

      const currentMesh = fixture.addedMeshes.at(-1) as GlyphMesh;
      const second = packedPrototypeRun(fixture.instances.buffer, 5);
      expect(currentMesh).toBe(mesh);
      expect(Array.from(second)).not.toEqual(Array.from(first));
      expect(residentRunUniform(currentMesh, 5)).toEqual(Array.from(second));
      expect(currentMesh.shader?.resources.glyphUniforms.uniforms.uResidentProtoBase).toBe(0);
    } finally {
      backend.destroy();
      residentPasses.restore();
      restoreDocument();
    }
  });

  test("retries resident run uniform update and binding faults", () => {
    const updateError = new Error("injected resident prototype uniform update failure");
    const bindError = new Error("injected resident prototype binding failure");
    const originalBind = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "bindMesh",
    );
    let updateFault = false;
    let updateCalls = 0;
    let bindFault = false;
    let uniformGroup: { update(): void } | undefined;
    let originalUniformUpdate: PropertyDescriptor | undefined;
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "bindMesh", {
      configurable: true,
      value(
        this: WebGPURendererBackendAdapter,
        mesh: GlyphMesh,
        bindings: Parameters<WebGPURendererBackendAdapter["bindMesh"]>[1],
      ): void {
        if (bindFault) {
          bindFault = false;
          throw bindError;
        }
        originalBind?.value.call(this, mesh, bindings);
      },
      writable: true,
    });
    const residentPasses = installResidentBackendPasses();
    const fixture = backendFixture(1);
    configureResidentPrototypeRun(fixture, 5);
    writePrototypeWords(fixture.instances.buffer, 0x1000);
    fixture.instanceRanges = [{ offset: 0, length: fixture.instances.buffer.byteLength }];
    const update = residentCullUpdate(5);
    const retryUpdate = {
      ...update,
      recordDirty: "none" as const,
      localBoundsDirty: "none" as const,
    };
    const restoreDocument = installRendererDocument();
    const backend = fixtureBackend(fixture, { computeCull: true });
    try {
      backend.apply(renderCommit(), update);
      const mesh = fixture.addedMeshes.at(-1) as GlyphMesh;
      const shader = mesh.shader;
      if (shader === null) throw new Error("Resident mesh shader is unavailable");
      const residentUniformGroup = shader.resources.glyphUniforms as { update(): void };
      uniformGroup = residentUniformGroup;
      originalUniformUpdate = Object.getOwnPropertyDescriptor(residentUniformGroup, "update");
      const inheritedUniformUpdate = residentUniformGroup.update;
      Object.defineProperty(residentUniformGroup, "update", {
        configurable: true,
        value(this: { update(): void }): void {
          updateCalls += 1;
          if (updateFault) throw updateError;
          inheritedUniformUpdate.call(this);
        },
        writable: true,
      });
      writePrototypeWords(fixture.instances.buffer, 0x3000);
      fixture.instanceRanges = [{ offset: 0, length: fixture.instances.buffer.byteLength }];
      updateFault = true;

      let caught: unknown;
      try {
        backend.apply(renderCommit(), retryUpdate);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(updateError);
      expect(updateCalls).toBe(1);
      expect(residentRunUniform(mesh, 5)).toEqual(
        Array.from(packedPrototypeRun(fixture.instances.buffer, 5)),
      );

      updateFault = false;
      backend.apply(renderCommit(), retryUpdate);
      expect(updateCalls).toBe(2);
      expect(residentRunUniform(mesh, 5)).toEqual(
        Array.from(packedPrototypeRun(fixture.instances.buffer, 5)),
      );

      writePrototypeWords(fixture.instances.buffer, 0x5000);
      fixture.instanceRanges = [{ offset: 0, length: fixture.instances.buffer.byteLength }];
      bindFault = true;
      caught = undefined;
      try {
        backend.apply(renderCommit(), retryUpdate);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(bindError);
      expect(residentRunUniform(mesh, 5)).toEqual(
        Array.from(packedPrototypeRun(fixture.instances.buffer, 5)),
      );

      backend.apply(renderCommit(), retryUpdate);
      expect(residentRunUniform(mesh, 5)).toEqual(
        Array.from(packedPrototypeRun(fixture.instances.buffer, 5)),
      );
      expect(backend.stats).toMatchObject({ cullPath: "compute-cull", meshes: 1 });
    } finally {
      backend.destroy();
      residentPasses.restore();
      restoreOwnDescriptor(WebGPURendererBackendAdapter.prototype, "bindMesh", originalBind);
      if (uniformGroup !== undefined) {
        restoreOwnDescriptor(uniformGroup, "update", originalUniformUpdate);
      }
      restoreDocument();
    }
  });

  test("keeps palette state live across a Texture constructor fault and retry", () => {
    const constructionError = new Error("injected palette Texture construction failure");
    const originalBind = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "bindMesh",
    );
    const originalOnDescriptor = Object.getOwnPropertyDescriptor(BufferImageSource.prototype, "on");
    const originalOn = BufferImageSource.prototype.on;
    const palettes: Texture[] = [];
    let fault = false;
    const failedSources: BufferImageSource[] = [];
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "bindMesh", {
      configurable: true,
      value(mesh: never, bindings: { paletteTexture: Texture }): void {
        palettes.push(bindings.paletteTexture);
        originalBind?.value.call(this, mesh, bindings);
      },
      writable: true,
    });
    Object.defineProperty(BufferImageSource.prototype, "on", {
      configurable: true,
      value: function (this: BufferImageSource, ...args: unknown[]): unknown {
        if (fault && this.label === "pixi-glyphflow-transforms" && args[0] === "resize") {
          fault = false;
          failedSources.push(this);
          throw constructionError;
        }
        return Reflect.apply(originalOn, this, args);
      },
      writable: true,
    });
    const fixture = backendFixture(2);
    const backend = fixtureBackend(fixture);
    try {
      backend.apply(renderCommit());
      const oldPalette = palettes.at(-1);
      expect(oldPalette).toBeDefined();
      const oldPaletteSource = oldPalette?.source;
      const bindsBeforeFault = palettes.length;
      fixture.transforms.data = new Float32Array(32);
      fixture.transformRanges = [{ offset: 0, length: fixture.transforms.data.byteLength }];
      fault = true;

      let caught: unknown;
      try {
        backend.apply(renderCommit());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(constructionError);
      expect(failedSources[0]?.destroyed).toBe(true);
      expect(palettes).toHaveLength(bindsBeforeFault);
      expect(oldPaletteSource?.destroyed).toBe(false);

      backend.apply(renderCommit());
      const recoveredPalette = palettes.at(-1);
      expect(recoveredPalette).toBeDefined();
      expect(recoveredPalette).not.toBe(oldPalette);
      expect(recoveredPalette?.source.resource).toBe(fixture.transforms.data);
      expect(oldPaletteSource?.destroyed).toBe(true);
    } finally {
      backend.destroy();
      restoreOwnDescriptor(WebGPURendererBackendAdapter.prototype, "bindMesh", originalBind);
      restoreOwnDescriptor(BufferImageSource.prototype, "on", originalOnDescriptor);
    }
  });

  test("rolls back an Nth prototype bind fault and recovers on the next commit", () => {
    const bindError = new Error("injected second prototype bind failure");
    const originalBind = Object.getOwnPropertyDescriptor(
      WebGPURendererBackendAdapter.prototype,
      "bindMesh",
    );
    const prototypes: Texture[] = [];
    let oldPrototype: Texture | undefined;
    let failedCandidate: Texture | undefined;
    let failedCandidateSource: BufferImageSource | undefined;
    let candidateBinds = 0;
    let fault = false;
    Object.defineProperty(WebGPURendererBackendAdapter.prototype, "bindMesh", {
      configurable: true,
      value(mesh: never, bindings: { prototypeTexture: Texture }): void {
        prototypes.push(bindings.prototypeTexture);
        if (fault && bindings.prototypeTexture !== oldPrototype) {
          failedCandidate = bindings.prototypeTexture;
          failedCandidateSource = bindings.prototypeTexture.source as BufferImageSource;
          candidateBinds += 1;
          if (candidateBinds === 2) throw bindError;
        }
        originalBind?.value.call(this, mesh, bindings);
      },
      writable: true,
    });
    const fixture = backendFixture(2);
    const backend = fixtureBackend(fixture);
    try {
      backend.apply(renderCommit());
      oldPrototype = prototypes.at(-1);
      expect(oldPrototype).toBeDefined();
      const expectedOldPrototype = oldPrototype;
      if (expectedOldPrototype === undefined) throw new Error("Prototype binding was not observed");
      const expectedOldPrototypeSource = expectedOldPrototype.source;
      fixture.instances.buffer = instanceBuffer(513, 2);
      fixture.instances.stats.highWater = 513;
      fixture.instanceRanges = [{ offset: 0, length: fixture.instances.buffer.byteLength }];
      fault = true;

      let caught: unknown;
      try {
        backend.apply(renderCommit());
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(bindError);
      expect(candidateBinds).toBe(2);
      expect(failedCandidate?.destroyed).toBe(true);
      expect(failedCandidateSource?.destroyed).toBe(true);
      expect(expectedOldPrototypeSource.destroyed).toBe(false);
      expect(prototypes.slice(-2)).toEqual([expectedOldPrototype, expectedOldPrototype]);

      fault = false;
      backend.apply(renderCommit());
      const recoveredPrototype = prototypes.at(-1);
      expect(recoveredPrototype).toBeDefined();
      expect(recoveredPrototype).not.toBe(expectedOldPrototype);
      expect(recoveredPrototype).not.toBe(failedCandidate);
      expect(expectedOldPrototypeSource.destroyed).toBe(true);
    } finally {
      backend.destroy();
      restoreOwnDescriptor(WebGPURendererBackendAdapter.prototype, "bindMesh", originalBind);
    }
  });

  test("retires a mesh when owner admission faults and preserves the admission error", () => {
    const admissionError = new Error("injected owner admission failure");
    const events: string[] = [];
    const fixture = backendFixture(1);
    const backend = new DefaultPixiRendererBackend(
      fixture.renderer,
      {
        addChild(mesh: object): never {
          Object.defineProperty(mesh, "removeFromParent", {
            configurable: true,
            value(): void {
              events.push("remove");
              throw new Error("injected admission rollback removal failure");
            },
          });
          Object.defineProperty(mesh, "destroy", {
            configurable: true,
            value(): void {
              events.push("destroy");
              throw new Error("injected admission rollback destroy failure");
            },
          });
          throw admissionError;
        },
      } as never,
      fixture.coordinator as never,
    );
    try {
      let caught: unknown;
      try {
        backend.apply(renderCommit());
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBe(admissionError);
      expect(events).toEqual(["remove", "destroy"]);
      expect(backend.stats.meshes).toBe(0);
      backend.destroy();
      expect(events).toEqual(["remove", "destroy"]);
    } finally {
      backend.destroy();
    }
  });

  test("detaches every live mesh before faulting idle cleanup", () => {
    const firstError = new Error("injected first idle mesh removal failure");
    const events: string[] = [];
    const fixture = backendFixture(2);
    const backend = fixtureBackend(fixture);
    try {
      backend.apply(renderCommit());
      const meshes = Array.from(new Set(fixture.addedMeshes));
      expect(meshes).toHaveLength(2);
      for (const [index, mesh] of meshes.entries()) {
        Object.defineProperty(mesh, "removeFromParent", {
          configurable: true,
          value(): void {
            events.push(`${String(index)}:remove`);
            if (index === 0) throw firstError;
          },
        });
        Object.defineProperty(mesh, "destroy", {
          configurable: true,
          value(): void {
            events.push(`${String(index)}:destroy`);
            throw new Error(`injected mesh ${String(index)} destroy failure`);
          },
        });
      }
      fixture.drawStates.length = 0;

      let caught: unknown;
      try {
        backend.dropIdleMeshes();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(firstError);
      expect(events).toEqual(["0:remove", "0:destroy", "1:remove", "1:destroy"]);
      expect(backend.stats.meshes).toBe(0);
      backend.destroy();
      expect(events).toHaveLength(4);
    } finally {
      backend.destroy();
    }
  });

  test("consumes resolved and rejected WebGPU atlas retirement faults", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      const textureError = new Error(`${outcome} texture retirement failure`);
      const queueError = new Error(`${outcome} queue completion failure`);
      const events: string[] = [];
      const previousSource = {
        destroyed: false,
        destroy(): void {
          events.push("source");
          this.destroyed = true;
          throw new Error(`${outcome} source retirement failure`);
        },
      };
      const previousTexture = {
        destroy(): void {
          events.push("texture");
          throw textureError;
        },
      };
      const renderer = {
        gpu: {
          device: {
            limits: { maxTextureDimension2D: 8192 },
            createCommandEncoder: () => ({
              copyTextureToTexture(): void {},
              finish: () => ({}),
            }),
            queue: {
              submit(): void {},
              onSubmittedWorkDone: () =>
                outcome === "resolve" ? Promise.resolve() : Promise.reject(queueError),
            },
          },
        },
        texture: { getGpuSource: () => ({}) },
        buffer: { updateBuffer(): void {} },
      } as unknown as WebGPURenderer;
      const platform = new WebGPURendererBackendAdapter(renderer);

      expect(
        platform.migrateAtlasArray(
          {
            dummy: false,
            initialized: true,
            layerCount: 1,
            width: 4,
            height: 4,
            source: previousSource,
            texture: previousTexture,
          } as never,
          { width: 4, height: 4, source: {} } as never,
        ),
      ).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toEqual(["texture", "source"]);
      expect(previousSource.destroyed).toBe(true);
    }
  });
});

interface DestroyTrackedGpuBuffer {
  readonly label: string;
  readonly size: number;
  readonly usage: number;
  destroyCalls: number;
  destroy(): void;
}

function trackedBufferFactory(buffers: DestroyTrackedGpuBuffer[]) {
  return ({ label, size, usage }: { label: string; size: number; usage: number }) => {
    const buffer: DestroyTrackedGpuBuffer = {
      label,
      size,
      usage,
      destroyCalls: 0,
      destroy() {
        this.destroyCalls += 1;
      },
    };
    buffers.push(buffer);
    return buffer;
  };
}

function writeResidentRecord(
  records: ArrayBuffer,
  index: number,
  bounds: readonly [number, number, number, number],
  instanceOffset: number,
  instanceCount: number,
  paletteIndex: number,
): void {
  const view = new DataView(records);
  const base = index * 32;
  for (let word = 0; word < bounds.length; word += 1) {
    view.setFloat32(base + word * 4, bounds[word] ?? 0, true);
  }
  view.setUint32(base + 16, instanceOffset, true);
  view.setUint32(base + 20, instanceCount, true);
  view.setUint32(base + 24, paletteIndex, true);
}

function computeFallbackCoordinator(trackDirty = false) {
  const dirtyConsumer = trackDirty ? { consumeDirty: () => [] } : {};
  return {
    drawListEpoch: 1,
    instances: {
      buffer: instanceBuffer(1, 1),
      segmentEpoch: 1,
      stats: { activeInstances: 1, highWater: 1 },
      getRange: () => ({ offset: 0, count: 1, capacity: 1 }),
      ...dirtyConsumer,
    },
    transforms: {
      data: new Float32Array(16),
      stats: { textureWidth: 4, effectBase: 8 },
      refreshOrigins: () => 0,
      ...dirtyConsumer,
    },
    getDrawStates: () => [{ slot: 0, zIndex: 0, order: 0, blendMode: "normal" as const }],
  };
}

function computeFallbackBackend(
  renderer: Renderer,
  coordinator: ReturnType<typeof computeFallbackCoordinator>,
): DefaultPixiRendererBackend {
  return new DefaultPixiRendererBackend(
    renderer,
    { addChild() {} } as never,
    coordinator as never,
    { computeCull: true },
  );
}

function backendFixture(drawCount: number) {
  const drawStates = Array.from({ length: drawCount }, (_, slot) => ({
    slot,
    zIndex: slot,
    order: slot,
    blendMode: "normal" as const,
  }));
  const addedMeshes: object[] = [];
  const pages = new Map<number, ReturnType<typeof atlasPage>>();
  const ranges: {
    transform: Array<{ offset: number; length: number }>;
    instance: Array<{ offset: number; length: number }>;
  } = { transform: [], instance: [] };
  const transforms = {
    data: new Float32Array(16),
    stats: { textureWidth: 4, effectBase: 8 },
    consumeDirty() {
      const dirty = ranges.transform;
      ranges.transform = [];
      return dirty;
    },
    refreshOrigins: () => 0,
  };
  const instances = {
    buffer: instanceBuffer(Math.max(1, drawCount), drawCount),
    segmentEpoch: 1,
    stats: { activeInstances: drawCount, highWater: drawCount },
    getRange(slot: number) {
      return slot < drawStates.length ? { offset: slot, count: 1, capacity: 1 } : undefined;
    },
    consumeDirty() {
      const dirty = ranges.instance;
      ranges.instance = [];
      return dirty;
    },
  };
  const renderer = {
    gpu: {
      device: {
        limits: {
          maxTextureDimension2D: 8192,
          maxStorageBuffersInVertexStage: 0,
          maxStorageBufferBindingSize: 128 * 1024 * 1024,
        },
        queue: {
          writeTexture(): void {},
          submit(): void {},
          onSubmittedWorkDone: async (): Promise<void> => {},
        },
      },
    },
    texture: { getGpuSource: (source: unknown) => ({ source }) },
    buffer: { updateBuffer(): void {} },
  } as unknown as Renderer;
  const owner = {
    addChild<T extends object>(child: T): T {
      addedMeshes.push(child);
      return child;
    },
  };
  const coordinator = {
    drawListEpoch: 1,
    atlas: { getPage: (pageId: number) => pages.get(pageId) },
    transforms,
    instances,
    getDrawStates: () => drawStates,
  };
  return {
    addedMeshes,
    coordinator,
    drawStates,
    instances,
    owner,
    pages,
    renderer,
    transforms,
    get transformRanges() {
      return ranges.transform;
    },
    set transformRanges(value: Array<{ offset: number; length: number }>) {
      ranges.transform = value;
    },
    get instanceRanges() {
      return ranges.instance;
    },
    set instanceRanges(value: Array<{ offset: number; length: number }>) {
      ranges.instance = value;
    },
  };
}

function fixtureBackend(
  fixture: ReturnType<typeof backendFixture>,
  options?: ConstructorParameters<typeof DefaultPixiRendererBackend>[3],
): DefaultPixiRendererBackend {
  return new DefaultPixiRendererBackend(
    fixture.renderer,
    fixture.owner as never,
    fixture.coordinator as never,
    options,
  );
}

function instanceBuffer(highWater: number, active: number): ArrayBuffer {
  const buffer = new ArrayBuffer(highWater * 24);
  const view = new DataView(buffer);
  for (let index = 0; index < active; index += 1) {
    view.setUint32(index * 24 + 20, 0x8000_0000, true);
  }
  return buffer;
}

function atlasPage(id: number, layer: number) {
  return { id, mode: "alpha" as const, layer, width: 4, height: 4, bytes: 16 };
}

function atlasUpload(page: number, layer: number, x = 0, value = 255) {
  return {
    entry: {
      key: `page-${String(page)}-${String(x)}`,
      generation: 1,
      page,
      layer,
      mode: "alpha" as const,
      x,
      y: 0,
      width: 1,
      height: 1,
      u0: x / 4,
      v0: 0,
      u1: (x + 1) / 4,
      v1: 0.25,
    },
    pixels: new Uint8Array([value]),
  };
}

function renderCommit(uploads: ReturnType<typeof atlasUpload>[] = [], drawOrderChanged = false) {
  return {
    revision: 1,
    stale: false,
    appliedLabels: 0,
    glyphs: 0,
    atlasUploads: uploads.length,
    atlasCommit: { entries: [], uploads, externalUploads: [], evictedKeys: [] },
    drawOrderChanged,
  };
}

function residentCullUpdate(drawInstanceCount = 1) {
  return {
    records: new ArrayBuffer(32),
    recordCount: 1,
    recordDirty: "all" as const,
    drawInstanceCount,
    localBounds: new Float32Array([0, 0, 8, 10]),
    localBoundsCount: 1,
    localBoundsDirty: "all" as const,
    viewport: { x: 0, y: 0, width: 100, height: 100, padding: 0 },
  };
}

function packedPrototype(store: ArrayBuffer): Float32Array {
  const prototype = new Float32Array(8);
  writePrototypeGlyphs(prototype, store, 0, 1);
  return prototype;
}

function configureResidentPrototypeRun(
  fixture: ReturnType<typeof backendFixture>,
  glyphCount: number,
): void {
  fixture.instances.buffer = instanceBuffer(glyphCount, glyphCount);
  fixture.instances.stats.activeInstances = glyphCount;
  fixture.instances.stats.highWater = glyphCount;
  fixture.instances.getRange = (slot: number) =>
    slot === 0 ? { offset: 0, count: glyphCount, capacity: glyphCount } : undefined;
}

function writePrototypeWords(store: ArrayBuffer, seed: number): void {
  const words = new Uint32Array(store);
  const glyphs = store.byteLength / 24;
  for (let glyph = 0; glyph < glyphs; glyph += 1) {
    const base = glyph * 6;
    words[base] = 0x3c00_3800 + seed + glyph;
    words[base + 1] = 0x4000_3c00 + seed + glyph;
    words[base + 2] = 0x4000_2000 + seed + glyph;
    words[base + 3] = 0x6000_4000 + seed + glyph;
  }
}

function packedPrototypeRun(store: ArrayBuffer, glyphCount: number): Float32Array {
  const prototypes = new Float32Array(glyphCount * 8);
  writePrototypeGlyphs(prototypes, store, 0, glyphCount);
  return prototypes;
}

function residentUniform(mesh: GlyphMesh): number[] {
  const shader = mesh.shader;
  if (shader === null) throw new Error("Resident mesh shader is unavailable");
  const uniforms = shader.resources.glyphUniforms.uniforms;
  return [
    ...Array.from(uniforms.uResidentProto0 as Float32Array),
    ...Array.from(uniforms.uResidentProto1 as Float32Array),
  ];
}

function residentRunUniform(mesh: GlyphMesh, glyphCount: number): number[] {
  const shader = mesh.shader;
  if (shader === null) throw new Error("Resident mesh shader is unavailable");
  const protos = shader.resources.glyphUniforms.uniforms.uResidentProtos as Float32Array;
  return Array.from(protos.subarray(0, glyphCount * 8));
}

function installResidentBackendPasses(): { restore(): void } {
  const prototype = WebGPURendererBackendAdapter.prototype;
  const originalComputeGetter = Object.getOwnPropertyDescriptor(prototype, "computeCullPass");
  const originalPaletteGetter = Object.getOwnPropertyDescriptor(prototype, "paletteStoragePass");
  const originalPrepareCompute = Object.getOwnPropertyDescriptor(prototype, "prepareComputeCull");
  const originalPreparePalette = Object.getOwnPropertyDescriptor(
    prototype,
    "preparePaletteStorage",
  );
  const paletteBuffer = new Buffer({
    size: 64,
    usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    label: "pixi-glyphflow-test-resident-palette",
  });
  const computePass = {
    synced: true,
    requiresFullSync: false,
    lastRecordUploadBytes: 0,
    trackGeometry(): void {},
    untrackGeometry(): void {},
    invalidateSync(): void {},
    ensureCapacity(): boolean {
      return true;
    },
    uploadRecords(): void {},
    getResidentRecords() {
      return { ok: true as const, buffer: {}, epoch: 1, byteLength: 32, recordCount: 1 };
    },
    dispatch(): boolean {
      return true;
    },
  } as unknown as ComputeCullPass;
  const palettePass = {
    requiresFullSync: false,
    hasGpuTransforms: true,
    transformBuffer: paletteBuffer,
    acknowledgeFullSync(): void {},
    uploadAllTransforms(): number {
      return 0;
    },
    ensureResidentLocalBounds() {
      return { ok: true, replaced: false, uploadedBytes: 0, epoch: 1 };
    },
    bindResidentCullRecords() {
      return { ok: true, changed: false };
    },
  } as unknown as PaletteStoragePass;
  Object.defineProperty(prototype, "computeCullPass", {
    configurable: true,
    get: () => computePass,
  });
  Object.defineProperty(prototype, "paletteStoragePass", {
    configurable: true,
    get: () => palettePass,
  });
  Object.defineProperty(prototype, "prepareComputeCull", {
    configurable: true,
    value: () => computePass,
    writable: true,
  });
  Object.defineProperty(prototype, "preparePaletteStorage", {
    configurable: true,
    value: () => ({ pass: palettePass, replaced: false }),
    writable: true,
  });
  return {
    restore(): void {
      paletteBuffer.destroy();
      restoreOwnDescriptor(prototype, "computeCullPass", originalComputeGetter);
      restoreOwnDescriptor(prototype, "paletteStoragePass", originalPaletteGetter);
      restoreOwnDescriptor(prototype, "prepareComputeCull", originalPrepareCompute);
      restoreOwnDescriptor(prototype, "preparePaletteStorage", originalPreparePalette);
    },
  };
}

function restoreOwnDescriptor(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
}

function installRendererDocument(): () => void {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  });
  return () => restoreOwnDescriptor(globalThis, "document", documentDescriptor);
}

function installRendererGpuGlobals(): () => void {
  return installWebGpuGlobals({
    GPUShaderStage: { COMPUTE: 4 },
    GPUBufferUsage: {
      STORAGE: 0x0080,
      COPY_SRC: 0x0004,
      COPY_DST: 0x0008,
      VERTEX: 0x0020,
      UNIFORM: 0x0040,
    },
  });
}

function installRendererBrowserGlobals(): () => void {
  const restoreDocument = installRendererDocument();
  try {
    const restoreGpuGlobals = installRendererGpuGlobals();
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

function fakeWebGlRenderer(): Renderer {
  return {
    gl: { MAX_TEXTURE_SIZE: 0x0d33, getParameter: () => 4096 },
    buffer: { updateBuffer(): void {} },
  } as unknown as Renderer;
}

function fakeWebGpuRenderer(): Renderer {
  return {
    gpu: { device: { limits: { maxTextureDimension2D: 8192 } } },
    buffer: { updateBuffer(): void {} },
  } as unknown as Renderer;
}

function fakeWebGpuCapabilityRenderer(): WebGPURenderer {
  return {
    gpu: {
      device: {
        limits: {
          maxTextureDimension2D: 8192,
          maxStorageBuffersInVertexStage: 1,
          maxStorageBufferBindingSize: 128 * 1024 * 1024,
          maxBufferSize: 128 * 1024 * 1024,
        },
      },
    },
    buffer: { updateBuffer(): void {} },
    encoder: { draw(): void {} },
  } as unknown as WebGPURenderer;
}

function failingShaderModule(renderer: WebGPURenderer, events: string[]): void {
  const device = renderer.gpu.device as GPUDevice & {
    createShaderModule(): GPUShaderModule;
  };
  device.createShaderModule = (): GPUShaderModule => {
    events.push("initialize");
    throw new Error("Injected shader module failure");
  };
}
