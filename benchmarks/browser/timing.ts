import type { Application, Renderer, WebGPURenderer } from "pixi.js";

import {
  observeWebGPUFrameTimestamps,
  type WebGPUFrameTimestampSummary,
} from "../../src/render/WebGPUFrameTransaction";
import type { BrowserGpuTimingCapability } from "../schema";

const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_SRC = 0x0004;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x0200;
const GPU_MAP_MODE_READ = 0x0001;
const TIMESTAMP_QUERY_COUNT = 6;
const TIMESTAMP_BUFFER_BYTES = TIMESTAMP_QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;
const TIMESTAMP_READBACK_RING_SIZE = 3;
const SCENE_START_QUERY = 0;
const SCENE_END_QUERY = 1;
const PALETTE_START_QUERY = 2;
const PALETTE_END_QUERY = 3;
const CULL_START_QUERY = 4;
const CULL_END_QUERY = 5;
const TIMESTAMP_HOOK_LINK = Symbol("glyphflow-benchmark-timestamp-hook");
const WEBGPU_OPTIONAL_FEATURES = [
  "texture-compression-bc",
  "texture-compression-astc",
  "texture-compression-etc2",
  "timestamp-query",
] as const;

interface WebGlTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

type TimestampHookableEncoder = WebGPURenderer["encoder"] & {
  commandEncoder: GPUCommandEncoder | null;
  finishRenderPass(): void;
  postrender(...args: unknown[]): void;
};

type TimestampHookName = "beginRenderPass" | "finishRenderPass";
type TimestampHookFunction = (...args: never[]) => unknown;

interface TimestampHookLink {
  readonly name: TimestampHookName;
  previous: TimestampHookFunction;
  previousOwnDescriptor: PropertyDescriptor | undefined;
}

type LinkedTimestampHook = TimestampHookFunction & {
  readonly [TIMESTAMP_HOOK_LINK]?: TimestampHookLink;
};

interface TimestampPostrenderHookState {
  readonly encoder: TimestampHookableEncoder;
  readonly base: TimestampHookFunction;
  readonly hook: TimestampHookFunction;
  readonly inheritedBase: boolean;
  readonly originalOwnDescriptor: PropertyDescriptor | undefined;
  readonly owners: Set<object>;
  external: TimestampHookFunction | undefined;
}

const timestampPostrenderHooks = new WeakMap<
  TimestampHookableEncoder,
  TimestampPostrenderHookState
>();

export interface BenchmarkWebGpu {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
}

export interface ProductFrameSample {
  readonly token: number;
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly completionWallMs: number;
  /** Timer-owned readback work paid before this product frame began. */
  readonly instrumentationWallMs: number;
}

export interface CompletedFrameSample extends ProductFrameSample {
  readonly gpuMs: number;
  readonly gpuTimestampMs: number | null;
  readonly paletteGpuTimestampMs: number | null;
  readonly cullGpuTimestampMs: number | null;
  readonly sceneRenderGpuTimestampMs: number | null;
  /** Wall time spent mapping, reading, and unmapping this frame's timestamp copy. */
  readonly timestampReadbackWallMs: number;
}

export interface GpuFrameTimer {
  readonly capability: Readonly<BrowserGpuTimingCapability>;
  measure(render: () => void | Promise<void>): Promise<Readonly<CompletedFrameSample>>;
  measureProductFrame(render: () => void | Promise<void>): Promise<Readonly<ProductFrameSample>>;
  drain(): Promise<readonly Readonly<CompletedFrameSample>[]>;
  destroy(): void;
}

/** Request the same compute-cull limits as production plus optional timestamp queries. */
export async function requestBenchmarkWebGpu(
  options: GPURequestAdapterOptions = {},
): Promise<BenchmarkWebGpu | undefined> {
  const gpu = globalThis.navigator?.gpu;
  if (gpu === undefined) return undefined;
  const adapter = await gpu.requestAdapter(options);
  if (adapter === null) return undefined;
  const requiredFeatures = WEBGPU_OPTIONAL_FEATURES.filter((feature) =>
    adapter.features.has(feature),
  );
  const requiredLimits: Record<string, number> = {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  };
  const vertexStorage = adapter.limits.maxStorageBuffersInVertexStage ?? 0;
  if (vertexStorage > 0) requiredLimits.maxStorageBuffersInVertexStage = vertexStorage;
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });

  return { adapter, device };
}

/** Render one frame and wait for GPU completion, reporting CPU and completion latency separately. */
export async function completeFrame(
  app: Application,
  timer?: GpuFrameTimer,
): Promise<CompletedFrameSample> {
  if (timer !== undefined) return timer.measure(() => app.render());
  const cpuStart = performance.now();
  app.render();
  const afterCpu = performance.now();
  await finishGpu(app.renderer);
  const afterGpu = performance.now();

  return Object.freeze({
    token: 0,
    cpuMs: afterCpu - cpuStart,
    gpuMs: afterGpu - afterCpu,
    gpuTimestampMs: null,
    paletteGpuTimestampMs: null,
    cullGpuTimestampMs: null,
    sceneRenderGpuTimestampMs: null,
    completionWallMs: afterGpu - afterCpu,
    frameMs: afterGpu - cpuStart,
    instrumentationWallMs: 0,
    timestampReadbackWallMs: 0,
  });
}

export function createGpuFrameTimer(renderer: Renderer): GpuFrameTimer {
  if ("gl" in renderer) return createWebGlFrameTimer(renderer.gl);
  const device = "gpu" in renderer ? (renderer as WebGPURenderer).gpu?.device : undefined;
  if (device === undefined) {
    return createCompletionTimer(renderer, capability("webgpu", "WebGPU device is unavailable"));
  }
  if (!device.features.has("timestamp-query")) {
    return createCompletionTimer(
      renderer,
      capability("webgpu", "timestamp-query feature is unavailable on the active device"),
    );
  }

  try {
    return createWebGpuTimestampTimer(renderer as WebGPURenderer, device);
  } catch (error: unknown) {
    return createCompletionTimer(
      renderer,
      capability(
        "webgpu",
        error instanceof Error ? error.message : "timestamp-query resource creation failed",
      ),
    );
  }
}

export async function finishGpu(renderer: Renderer): Promise<void> {
  if ("gl" in renderer) {
    renderer.gl.finish();
    return;
  }
  const device = "gpu" in renderer ? (renderer as WebGPURenderer).gpu?.device : undefined;
  if (device !== undefined) await device.queue.onSubmittedWorkDone();
}

function createWebGlFrameTimer(gl: WebGL2RenderingContext): GpuFrameTimer {
  const extension = gl.getExtension(
    "EXT_disjoint_timer_query_webgl2",
  ) as WebGlTimerQueryExtension | null;
  if (extension === null) {
    return createCompletionTimer(
      { gl } as never,
      capability("webgl", "EXT_disjoint_timer_query_webgl2 is unavailable"),
    );
  }
  let state: BrowserGpuTimingCapability = Object.freeze({
    ...capability("webgl"),
    method: "ext-disjoint-timer-query-webgl2",
    supported: true,
    timerQuery: true,
    timestampReadbackMode: "immediate",
    timestampReadbackRingSize: 1,
  });

  return createImmediateDrainTimer(
    () => state,
    async (token, render) => {
      const query = gl.createQuery();
      if (query === null) {
        const sample = await measureCompletion({ gl } as never, render, token);
        const samples = state.samples + 1;
        state = Object.freeze({
          ...state,
          ...timingQuality(state.validSamples, samples),
          samples,
          fallbackSamples: state.fallbackSamples + 1,
          reason: "WebGL timer query allocation failed",
        });
        return sample;
      }
      const frameStart = performance.now();
      let began = false;
      let ended = false;
      try {
        gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
        began = true;
        const cpuStart = performance.now();
        await render();
        const afterCpu = performance.now();
        gl.endQuery(extension.TIME_ELAPSED_EXT);
        ended = true;
        gl.finish();
        const readbackStart = performance.now();
        await waitForWebGlQuery(gl, query);
        const disjoint = Boolean(gl.getParameter(extension.GPU_DISJOINT_EXT));
        const elapsedNanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
        const validTimestamp =
          !disjoint && Number.isFinite(elapsedNanoseconds) && elapsedNanoseconds > 0;
        const samples = state.samples + 1;
        const validSamples = state.validSamples + Number(validTimestamp);
        state = Object.freeze({
          ...state,
          ...timingQuality(validSamples, samples),
          readback: true,
          disjoint: state.disjoint || disjoint,
          samples,
          validSamples,
          fallbackSamples: state.fallbackSamples + Number(!validTimestamp),
          ...(validTimestamp ? {} : { reason: "WebGL timer query returned an invalid sample" }),
        });
        const afterGpu = performance.now();

        return Object.freeze({
          token,
          frameMs: afterGpu - frameStart,
          cpuMs: afterCpu - cpuStart,
          gpuMs: validTimestamp ? elapsedNanoseconds / 1_000_000 : afterGpu - afterCpu,
          gpuTimestampMs: validTimestamp ? elapsedNanoseconds / 1_000_000 : null,
          paletteGpuTimestampMs: null,
          cullGpuTimestampMs: null,
          sceneRenderGpuTimestampMs: validTimestamp ? elapsedNanoseconds / 1_000_000 : null,
          completionWallMs: afterGpu - afterCpu,
          instrumentationWallMs: 0,
          timestampReadbackWallMs: afterGpu - readbackStart,
        });
      } finally {
        if (began && !ended) {
          gl.endQuery(extension.TIME_ELAPSED_EXT);
          gl.finish();
        }
        gl.deleteQuery(query);
      }
    },
    () => {},
  );
}

interface PendingWebGpuTimestampFrame {
  readonly product: Readonly<ProductFrameSample>;
  readonly resolveError?: string;
  readonly segmentedEncoded: boolean;
  readonly segmentedError?: string;
  readonly palettePasses: number;
  readonly cullPasses: number;
}

interface WebGpuTimestampSlot {
  readonly index: number;
  readonly querySet: GPUQuerySet;
  readonly readBuffer: GPUBuffer;
  readonly resolveBuffer: GPUBuffer;
  pending?: PendingWebGpuTimestampFrame;
  retiring?: Promise<void>;
}

function createWebGpuTimestampTimer(renderer: WebGPURenderer, device: GPUDevice): GpuFrameTimer {
  const encoderSystem = renderer.encoder as TimestampHookableEncoder;
  if (
    typeof encoderSystem.beginRenderPass !== "function" ||
    typeof encoderSystem.finishRenderPass !== "function" ||
    typeof encoderSystem.postrender !== "function"
  ) {
    throw new TypeError("WebGPU timestamp queries require Pixi encoder lifecycle hooks");
  }
  const slots = createWebGpuTimestampResourceRing(device);
  let destroyed = false;
  let armed = false;
  let used = false;
  let resolveEncoded = false;
  let resolveError: string | undefined;
  let segmentedError: string | undefined;
  let segmentedFrameObserved = false;
  let segmentedSummary: Readonly<WebGPUFrameTimestampSummary> | undefined;
  const readSegmentedSummary = (): Readonly<WebGPUFrameTimestampSummary> | undefined =>
    segmentedSummary;
  let activeSlot: WebGpuTimestampSlot | undefined;
  let nextToken = 0;
  let nextSlot = 0;
  let measuring = false;
  let completed: CompletedFrameSample[] = [];
  let draining: Promise<readonly Readonly<CompletedFrameSample>[]> | undefined;
  let state: BrowserGpuTimingCapability = Object.freeze({
    ...capability("webgpu"),
    method: "timestamp-query",
    supported: true,
    timestampWrites: true,
    resolveQuerySet: true,
    timestampReadbackMode: "deferred-ring",
    timestampReadbackRingSize: TIMESTAMP_READBACK_RING_SIZE,
    segmentedTimestampWrites: false,
    timestampQueriesPerFrame: TIMESTAMP_QUERY_COUNT,
    segmentedSamples: 0,
    validSegmentedSamples: 0,
    segmentedFallbackSamples: 0,
    validPaletteSamples: 0,
    validCullSamples: 0,
    validSceneRenderSamples: 0,
  });
  const postrenderOwner = {};
  let detachPostrender = (): void => {};
  let detachSegmentObserver = (): void => {};
  const segmentObserver = {
    beginFrame(encoder: GPUCommandEncoder) {
      if (!armed) return undefined;
      const slot = activeSlot;
      if (slot === undefined) throw new Error("WebGPU timestamp readback slot is unavailable");
      if (encoder !== encoderSystem.commandEncoder) {
        throw new Error("WebGPU frame transaction used a different product command encoder");
      }
      segmentedFrameObserved = true;
      return Object.freeze({
        querySet: slot.querySet,
        paletteStartQuery: PALETTE_START_QUERY,
        paletteEndQuery: PALETTE_END_QUERY,
        cullStartQuery: CULL_START_QUERY,
        cullEndQuery: CULL_END_QUERY,
      });
    },
    endFrame(summary: Readonly<WebGPUFrameTimestampSummary>): void {
      if (!armed) return;
      segmentedSummary = summary;
    },
    fail(error: unknown): void {
      if (!armed) return;
      segmentedError ??=
        error instanceof Error ? error.message : "WebGPU segmented timestamp write failed";
    },
  };
  const beginRenderPassLink: TimestampHookLink = {
    name: "beginRenderPass",
    previous: encoderSystem.beginRenderPass as TimestampHookFunction,
    previousOwnDescriptor: Object.getOwnPropertyDescriptor(encoderSystem, "beginRenderPass"),
  };
  const wrappedBeginRenderPass: typeof encoderSystem.beginRenderPass = (renderTarget) => {
    if (!armed || used) {
      (beginRenderPassLink.previous as typeof encoderSystem.beginRenderPass).call(
        encoderSystem,
        renderTarget,
      );
      return;
    }
    const slot = activeSlot;
    if (slot === undefined) {
      (beginRenderPassLink.previous as typeof encoderSystem.beginRenderPass).call(
        encoderSystem,
        renderTarget,
      );
      return;
    }
    const descriptor = renderTarget.descriptor;
    renderTarget.descriptor = {
      ...descriptor,
      timestampWrites: {
        querySet: slot.querySet,
        beginningOfPassWriteIndex: SCENE_START_QUERY,
        endOfPassWriteIndex: SCENE_END_QUERY,
      },
    };
    try {
      (beginRenderPassLink.previous as typeof encoderSystem.beginRenderPass).call(
        encoderSystem,
        renderTarget,
      );
      used = true;
    } finally {
      renderTarget.descriptor = descriptor;
    }
  };
  attachTimestampHookLink(wrappedBeginRenderPass, beginRenderPassLink);
  const encodeTimestampResolution = (): void => {
    if (resolveEncoded || resolveError !== undefined) return;
    try {
      const commandEncoder = encoderSystem.commandEncoder;
      if (commandEncoder === null) {
        throw new Error("Pixi postrender has no active WebGPU command encoder");
      }
      const slot = activeSlot;
      if (slot === undefined) throw new Error("WebGPU timestamp readback slot is unavailable");
      commandEncoder.resolveQuerySet(
        slot.querySet,
        0,
        TIMESTAMP_QUERY_COUNT,
        slot.resolveBuffer,
        0,
      );
      commandEncoder.copyBufferToBuffer(
        slot.resolveBuffer,
        0,
        slot.readBuffer,
        0,
        TIMESTAMP_BUFFER_BYTES,
      );
      resolveEncoded = true;
    } catch (error: unknown) {
      resolveError =
        error instanceof Error ? error.message : "WebGPU timestamp resolve encoding failed";
    }
  };
  const finishRenderPassLink: TimestampHookLink = {
    name: "finishRenderPass",
    previous: encoderSystem.finishRenderPass as TimestampHookFunction,
    previousOwnDescriptor: Object.getOwnPropertyDescriptor(encoderSystem, "finishRenderPass"),
  };
  const wrappedFinishRenderPass: typeof encoderSystem.finishRenderPass = function (
    this: TimestampHookableEncoder,
    ...args
  ): void {
    (finishRenderPassLink.previous as typeof encoderSystem.finishRenderPass).apply(this, args);
    if (!destroyed && used) encodeTimestampResolution();
  };
  attachTimestampHookLink(wrappedFinishRenderPass, finishRenderPassLink);
  let beginRenderPassAssignmentAttempted = false;
  let finishRenderPassAssignmentAttempted = false;
  try {
    detachSegmentObserver = observeWebGPUFrameTimestamps(renderer, segmentObserver);
    detachPostrender = attachTimestampPostrenderHook(encoderSystem, postrenderOwner);
    beginRenderPassAssignmentAttempted = true;
    encoderSystem.beginRenderPass = wrappedBeginRenderPass;
    finishRenderPassAssignmentAttempted = true;
    encoderSystem.finishRenderPass = wrappedFinishRenderPass;
  } catch (error: unknown) {
    cleanupBestEffort([
      ...(finishRenderPassAssignmentAttempted
        ? [() => unlinkTimestampHook(encoderSystem, "finishRenderPass", wrappedFinishRenderPass)]
        : []),
      ...(beginRenderPassAssignmentAttempted
        ? [() => unlinkTimestampHook(encoderSystem, "beginRenderPass", wrappedBeginRenderPass)]
        : []),
      detachPostrender,
      detachSegmentObserver,
      ...timestampSlotCleanupSteps(slots),
    ]);
    throw error;
  }

  const pendingCount = (): number =>
    slots.reduce((count, slot) => count + Number(slot.pending !== undefined), 0);
  const publishPendingCount = (): void => {
    const pendingTimestampReadbacks = pendingCount();
    state = Object.freeze({
      ...state,
      pendingTimestampReadbacks,
      maxPendingTimestampReadbacks: Math.max(
        state.maxPendingTimestampReadbacks ?? 0,
        pendingTimestampReadbacks,
      ),
    });
  };
  const retireSlot = (slot: WebGpuTimestampSlot): Promise<void> => {
    if (slot.retiring !== undefined) return slot.retiring;
    const pending = slot.pending;
    if (pending === undefined) return Promise.resolve();
    const retiring = (async (): Promise<void> => {
      const readbackStart = performance.now();
      let mapped = false;
      let productNanoseconds = Number.NaN;
      let paletteNanoseconds = Number.NaN;
      let cullNanoseconds = Number.NaN;
      let sceneRenderNanoseconds = Number.NaN;
      let segmentedValuesValid = false;
      let readbackError = pending.resolveError;
      try {
        await slot.readBuffer.mapAsync(GPU_MAP_MODE_READ);
        if (destroyed) return;
        mapped = true;
        const values = new BigUint64Array(slot.readBuffer.getMappedRange());
        sceneRenderNanoseconds = timestampDelta(values, SCENE_START_QUERY, SCENE_END_QUERY);
        segmentedValuesValid =
          pending.segmentedEncoded &&
          segmentedTimestampsOrdered(values, pending.palettePasses, pending.cullPasses);
        if (segmentedValuesValid) {
          const productStart = productStartTimestamp(
            values,
            pending.palettePasses,
            pending.cullPasses,
          );
          const sceneEnd = values[SCENE_END_QUERY];
          productNanoseconds =
            productStart === undefined || sceneEnd === undefined
              ? Number.NaN
              : Number(sceneEnd - productStart);
          paletteNanoseconds =
            pending.palettePasses === 0
              ? 0
              : timestampDelta(values, PALETTE_START_QUERY, PALETTE_END_QUERY, true);
          cullNanoseconds =
            pending.cullPasses === 0
              ? 0
              : timestampDelta(values, CULL_START_QUERY, CULL_END_QUERY, true);
          segmentedValuesValid =
            Number.isFinite(productNanoseconds) &&
            Number.isFinite(paletteNanoseconds) &&
            Number.isFinite(cullNanoseconds) &&
            Number.isFinite(sceneRenderNanoseconds);
        }
      } catch (error: unknown) {
        readbackError = error instanceof Error ? error.message : "WebGPU timestamp readback failed";
      } finally {
        if (mapped && !destroyed) {
          try {
            slot.readBuffer.unmap();
          } catch (error: unknown) {
            readbackError ??=
              error instanceof Error ? error.message : "WebGPU timestamp unmap failed";
            productNanoseconds = Number.NaN;
            paletteNanoseconds = Number.NaN;
            cullNanoseconds = Number.NaN;
            sceneRenderNanoseconds = Number.NaN;
            segmentedValuesValid = false;
          }
        }
      }
      if (destroyed) return;
      const timestampReadbackWallMs = performance.now() - readbackStart;
      const validSceneRenderTimestamp =
        readbackError === undefined &&
        Number.isFinite(sceneRenderNanoseconds) &&
        sceneRenderNanoseconds > 0;
      const validSegmentedTimestamp =
        readbackError === undefined && validSceneRenderTimestamp && segmentedValuesValid;
      const elapsedNanoseconds = validSegmentedTimestamp
        ? productNanoseconds
        : sceneRenderNanoseconds;
      const validTimestamp =
        readbackError === undefined &&
        Number.isFinite(elapsedNanoseconds) &&
        elapsedNanoseconds > 0;
      const samples = state.samples + 1;
      const validSamples = state.validSamples + Number(validTimestamp);
      const gpuTimestampMs = validTimestamp ? elapsedNanoseconds / 1_000_000 : null;
      const paletteGpuTimestampMs = validSegmentedTimestamp ? paletteNanoseconds / 1_000_000 : null;
      const cullGpuTimestampMs = validSegmentedTimestamp ? cullNanoseconds / 1_000_000 : null;
      const sceneRenderGpuTimestampMs = validSceneRenderTimestamp
        ? sceneRenderNanoseconds / 1_000_000
        : null;
      completed.push(
        Object.freeze({
          ...pending.product,
          gpuMs: gpuTimestampMs ?? pending.product.completionWallMs,
          gpuTimestampMs,
          paletteGpuTimestampMs,
          cullGpuTimestampMs,
          sceneRenderGpuTimestampMs,
          timestampReadbackWallMs,
        }),
      );
      delete slot.pending;
      const segmentedReason =
        pending.segmentedError ??
        readbackError ??
        (pending.segmentedEncoded
          ? "WebGPU segmented timestamp readback returned invalid boundaries"
          : "WebGPU frame transaction timestamp boundaries were not observed");
      state = Object.freeze({
        ...state,
        ...timingQuality(validSamples, samples),
        readback: true,
        samples,
        validSamples,
        fallbackSamples: state.fallbackSamples + Number(!validTimestamp),
        pendingTimestampReadbacks: pendingCount(),
        segmentedTimestampWrites:
          Boolean(state.segmentedTimestampWrites) || pending.segmentedEncoded,
        segmentedSamples: (state.segmentedSamples ?? 0) + 1,
        validSegmentedSamples: (state.validSegmentedSamples ?? 0) + Number(validSegmentedTimestamp),
        segmentedFallbackSamples:
          (state.segmentedFallbackSamples ?? 0) + Number(!validSegmentedTimestamp),
        validPaletteSamples:
          (state.validPaletteSamples ?? 0) + Number(paletteGpuTimestampMs !== null),
        validCullSamples: (state.validCullSamples ?? 0) + Number(cullGpuTimestampMs !== null),
        validSceneRenderSamples:
          (state.validSceneRenderSamples ?? 0) + Number(sceneRenderGpuTimestampMs !== null),
        ...(validSegmentedTimestamp ? {} : { segmentedReason }),
        ...(validTimestamp
          ? {}
          : {
              reason: readbackError ?? "WebGPU timestamp readback returned a non-positive delta",
            }),
      });
    })();
    slot.retiring = retiring.finally(() => {
      delete slot.retiring;
    });
    return slot.retiring;
  };

  const drain = async (): Promise<readonly Readonly<CompletedFrameSample>[]> => {
    if (destroyed) throw new Error("GPU frame timer is destroyed");
    if (measuring) throw new Error("GPU frame timer cannot drain during a product frame");
    if (draining !== undefined) return draining;
    draining = (async () => {
      await Promise.all(slots.map(retireSlot));
      if (destroyed) throw new Error("GPU frame timer is destroyed");
      const drained = Object.freeze([...completed].sort((left, right) => left.token - right.token));
      completed = [];
      return drained;
    })().finally(() => {
      draining = undefined;
    });
    return draining;
  };

  const measureProductFrame = async (
    render: () => void | Promise<void>,
  ): Promise<Readonly<ProductFrameSample>> => {
    if (destroyed) throw new Error("GPU frame timer is destroyed");
    if (measuring) throw new Error("GPU frame timer already has an active product frame");
    if (draining !== undefined) await draining;
    if (destroyed) throw new Error("GPU frame timer is destroyed");
    if (measuring) throw new Error("GPU frame timer already has an active product frame");
    measuring = true;
    const slot = slots[nextSlot]!;
    nextSlot = (nextSlot + 1) % slots.length;
    const instrumentationStart = performance.now();
    try {
      await retireSlot(slot);
      if (destroyed) throw new Error("GPU frame timer is destroyed");
      const instrumentationWallMs = performance.now() - instrumentationStart;
      const token = nextToken;
      used = false;
      resolveEncoded = false;
      resolveError = undefined;
      segmentedError = undefined;
      segmentedFrameObserved = false;
      segmentedSummary = undefined;
      activeSlot = slot;
      armed = true;
      const cpuStart = performance.now();
      let renderError: unknown;
      try {
        await render();
      } catch (error: unknown) {
        renderError = error;
      } finally {
        armed = false;
        activeSlot = undefined;
      }
      const afterCpu = performance.now();
      if (renderError !== undefined) {
        used = false;
        throw renderError;
      }
      await device.queue.onSubmittedWorkDone();
      if (destroyed) throw new Error("GPU frame timer is destroyed");
      const afterGpu = performance.now();
      const cpuMs = afterCpu - cpuStart;
      const completionWallMs = afterGpu - afterCpu;
      const product = Object.freeze({
        token,
        frameMs: cpuMs + completionWallMs,
        cpuMs,
        completionWallMs,
        instrumentationWallMs,
      });
      const summary = readSegmentedSummary();
      const segmentedEncoded =
        segmentedError === undefined && segmentedFrameObserved && summary !== undefined;
      nextToken += 1;
      if (!used || !resolveEncoded) {
        const reason = !used
          ? "WebGPU scene render pass was not observed"
          : (resolveError ?? "WebGPU timestamp resolve was not fused into the product submission");
        const samples = state.samples + 1;
        completed.push(
          Object.freeze({
            ...product,
            gpuMs: product.completionWallMs,
            gpuTimestampMs: null,
            paletteGpuTimestampMs: null,
            cullGpuTimestampMs: null,
            sceneRenderGpuTimestampMs: null,
            timestampReadbackWallMs: 0,
          }),
        );
        state = Object.freeze({
          ...state,
          ...timingQuality(state.validSamples, samples),
          samples,
          fallbackSamples: state.fallbackSamples + 1,
          segmentedSamples: (state.segmentedSamples ?? 0) + 1,
          segmentedFallbackSamples: (state.segmentedFallbackSamples ?? 0) + 1,
          segmentedReason: segmentedError ?? reason,
          reason,
        });
        return product;
      }
      state = Object.freeze({
        ...state,
        fusedTimestampResolves: state.fusedTimestampResolves + 1,
      });
      slot.pending = Object.freeze({
        product,
        segmentedEncoded,
        palettePasses: summary?.palettePasses ?? 0,
        cullPasses: summary?.cullPasses ?? 0,
        ...(segmentedError === undefined ? {} : { segmentedError }),
        ...(resolveError === undefined ? {} : { resolveError }),
      });
      publishPendingCount();
      return product;
    } finally {
      measuring = false;
    }
  };

  return Object.freeze({
    get capability() {
      return state;
    },
    async measure(render: () => void | Promise<void>) {
      const product = await measureProductFrame(render);
      const drained = await drain();
      const sample = drained.find((candidate) => candidate.token === product.token);
      if (sample === undefined) throw new Error("GPU timestamp sample was lost during drain");
      return sample;
    },
    measureProductFrame,
    drain,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      armed = false;
      used = false;
      const failure = cleanupBestEffort([
        () => unlinkTimestampHook(encoderSystem, "finishRenderPass", wrappedFinishRenderPass),
        () => unlinkTimestampHook(encoderSystem, "beginRenderPass", wrappedBeginRenderPass),
        detachPostrender,
        detachSegmentObserver,
        ...timestampSlotCleanupSteps(slots),
      ]);
      completed = [];
      for (const slot of slots) delete slot.pending;
      state = Object.freeze({ ...state, pendingTimestampReadbacks: 0 });
      if (failure !== undefined) throw failure.error;
    },
  });
}

function timestampDelta(
  values: BigUint64Array,
  startIndex: number,
  endIndex: number,
  allowZero = false,
): number {
  const start = values[startIndex];
  const end = values[endIndex];
  if (start === undefined || end === undefined || end < start || (!allowZero && end === start)) {
    return Number.NaN;
  }
  return Number(end - start);
}

function segmentedTimestampsOrdered(
  values: BigUint64Array,
  palettePasses: number,
  cullPasses: number,
): boolean {
  const sceneStart = values[SCENE_START_QUERY];
  const sceneEnd = values[SCENE_END_QUERY];
  if (sceneStart === undefined || sceneEnd === undefined || sceneEnd <= sceneStart) return false;

  let nextStageStart = sceneStart;
  if (cullPasses > 0) {
    const cullStart = values[CULL_START_QUERY];
    const cullEnd = values[CULL_END_QUERY];
    if (
      cullStart === undefined ||
      cullEnd === undefined ||
      cullEnd < cullStart ||
      cullEnd > nextStageStart
    ) {
      return false;
    }
    nextStageStart = cullStart;
  }
  if (palettePasses > 0) {
    const paletteStart = values[PALETTE_START_QUERY];
    const paletteEnd = values[PALETTE_END_QUERY];
    if (
      paletteStart === undefined ||
      paletteEnd === undefined ||
      paletteEnd < paletteStart ||
      paletteEnd > nextStageStart
    ) {
      return false;
    }
  }
  return true;
}

function productStartTimestamp(
  values: BigUint64Array,
  palettePasses: number,
  cullPasses: number,
): bigint | undefined {
  if (palettePasses > 0) return values[PALETTE_START_QUERY];
  if (cullPasses > 0) return values[CULL_START_QUERY];
  return values[SCENE_START_QUERY];
}

function createWebGpuTimestampResourceRing(device: GPUDevice): readonly WebGpuTimestampSlot[] {
  const slots: WebGpuTimestampSlot[] = [];
  const resources: Array<{ destroy(): void }> = [];
  try {
    for (let index = 0; index < TIMESTAMP_READBACK_RING_SIZE; index += 1) {
      const querySet = device.createQuerySet({ type: "timestamp", count: TIMESTAMP_QUERY_COUNT });
      resources.push(querySet);
      const resolveBuffer = device.createBuffer({
        size: TIMESTAMP_BUFFER_BYTES,
        usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
      });
      resources.push(resolveBuffer);
      const readBuffer = device.createBuffer({
        size: TIMESTAMP_BUFFER_BYTES,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
      });
      resources.push(readBuffer);
      slots.push({ index, querySet, readBuffer, resolveBuffer });
    }
    return Object.freeze(slots);
  } catch (error: unknown) {
    for (let index = resources.length - 1; index >= 0; index -= 1) {
      destroyGpuResource(resources[index]);
    }
    throw error;
  }
}

function timestampSlotCleanupSteps(slots: readonly WebGpuTimestampSlot[]): readonly (() => void)[] {
  return slots.flatMap((slot) => [
    () => slot.readBuffer.destroy(),
    () => slot.resolveBuffer.destroy(),
    () => slot.querySet.destroy(),
  ]);
}

function destroyGpuResource(resource: { destroy(): void } | undefined): void {
  try {
    resource?.destroy();
  } catch {
    // Preserve the allocation failure while releasing every resource that was created.
  }
}

function attachTimestampPostrenderHook(
  encoder: TimestampHookableEncoder,
  owner: object,
): () => void {
  let state = timestampPostrenderHooks.get(encoder);
  if (state === undefined) {
    const current = encoder.postrender as TimestampHookFunction;
    const inherited = findInheritedFunction(encoder, "postrender");
    const base = inherited ?? current;
    const owners = new Set<object>();
    const mutable: Omit<TimestampPostrenderHookState, "hook"> & {
      hook?: TimestampHookFunction;
    } = {
      encoder,
      base,
      inheritedBase: inherited !== undefined,
      originalOwnDescriptor: Object.getOwnPropertyDescriptor(encoder, "postrender"),
      owners,
      external: current === base ? undefined : current,
    };
    const hook: TimestampHookFunction = function (
      this: TimestampHookableEncoder,
      ...args
    ): unknown {
      return mutable.base.apply(this, args);
    };
    mutable.hook = hook;
    state = mutable as TimestampPostrenderHookState;
    Object.defineProperty(encoder, "postrender", {
      configurable: true,
      enumerable: mutable.originalOwnDescriptor?.enumerable ?? false,
      get() {
        return mutable.external ?? (mutable.owners.size > 0 ? hook : mutable.base);
      },
      set(value: TimestampHookFunction) {
        if (typeof value !== "function") {
          throw new TypeError("Pixi encoder postrender hook must be a function");
        }
        mutable.external = value === hook || value === mutable.base ? undefined : value;
        restoreTimestampPostrenderHookIfIdle(mutable as TimestampPostrenderHookState);
      },
    });
    timestampPostrenderHooks.set(encoder, state);
  }
  state.owners.add(owner);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    state?.owners.delete(owner);
    if (state !== undefined) restoreTimestampPostrenderHookIfIdle(state);
  };
}

function restoreTimestampPostrenderHookIfIdle(state: TimestampPostrenderHookState): void {
  if (state.owners.size > 0 || state.external !== undefined) return;
  timestampPostrenderHooks.delete(state.encoder);
  if (state.inheritedBase) {
    Reflect.deleteProperty(state.encoder, "postrender");
    return;
  }
  const descriptor = state.originalOwnDescriptor;
  if (descriptor === undefined) {
    Object.defineProperty(state.encoder, "postrender", {
      configurable: true,
      writable: true,
      value: state.base,
    });
  } else {
    Object.defineProperty(state.encoder, "postrender", descriptor);
  }
}

function findInheritedFunction(
  target: object,
  name: PropertyKey,
): TimestampHookFunction | undefined {
  let prototype = Object.getPrototypeOf(target) as object | null;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value === "function") {
      return descriptor.value as TimestampHookFunction;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return undefined;
}

function attachTimestampHookLink(hook: TimestampHookFunction, link: TimestampHookLink): void {
  Object.defineProperty(hook, TIMESTAMP_HOOK_LINK, { value: link });
}

function unlinkTimestampHook(
  encoder: TimestampHookableEncoder,
  name: TimestampHookName,
  hook: TimestampHookFunction,
): void {
  const fields = encoder as unknown as Record<TimestampHookName, TimestampHookFunction>;
  const hookLink = (hook as LinkedTimestampHook)[TIMESTAMP_HOOK_LINK];
  if (hookLink === undefined) return;
  let current = fields[name] as LinkedTimestampHook;
  if (current === hook) {
    restoreTimestampHook(encoder, name, hookLink);
    return;
  }
  const visited = new Set<TimestampHookFunction>();
  while (!visited.has(current)) {
    visited.add(current);
    const currentLink = current[TIMESTAMP_HOOK_LINK];
    if (currentLink === undefined || currentLink.name !== name) return;
    if (currentLink.previous === hook) {
      currentLink.previous = hookLink.previous;
      currentLink.previousOwnDescriptor = hookLink.previousOwnDescriptor;
      return;
    }
    current = currentLink.previous as LinkedTimestampHook;
  }
}

function restoreTimestampHook(
  encoder: TimestampHookableEncoder,
  name: TimestampHookName,
  link: TimestampHookLink,
): void {
  const descriptor = link.previousOwnDescriptor;
  if (descriptor === undefined) {
    if (!Reflect.deleteProperty(encoder, name)) {
      throw new TypeError(`Unable to restore inherited Pixi encoder ${name} hook`);
    }
    return;
  }
  if ("value" in descriptor || descriptor.set === undefined) {
    Object.defineProperty(encoder, name, descriptor);
    return;
  }
  const fields = encoder as unknown as Record<TimestampHookName, TimestampHookFunction>;
  const failure = cleanupBestEffort([
    () => {
      fields[name] = link.previous;
    },
    () => Object.defineProperty(encoder, name, descriptor),
  ]);
  if (failure !== undefined) throw failure.error;
}

function cleanupBestEffort(
  cleanupSteps: readonly (() => void)[],
): Readonly<{ error: unknown }> | undefined {
  let firstFailure: { error: unknown } | undefined;
  for (const cleanup of cleanupSteps) {
    try {
      cleanup();
    } catch (error: unknown) {
      firstFailure ??= { error };
    }
  }
  return firstFailure;
}

function createCompletionTimer(
  renderer: Renderer,
  initialState: Readonly<BrowserGpuTimingCapability>,
): GpuFrameTimer {
  let state = initialState;
  return createImmediateDrainTimer(
    () => state,
    async (token, render) => {
      const sample = await measureCompletion(renderer, render, token);
      const samples = state.samples + 1;
      state = Object.freeze({
        ...state,
        ...timingQuality(0, samples),
        samples,
        fallbackSamples: samples,
      });
      return sample;
    },
    () => {},
  );
}

async function measureCompletion(
  renderer: Renderer,
  render: () => void | Promise<void>,
  token: number,
): Promise<Readonly<CompletedFrameSample>> {
  const frameStart = performance.now();
  const cpuStart = performance.now();
  await render();
  const afterCpu = performance.now();
  await finishGpu(renderer);
  const afterGpu = performance.now();

  return Object.freeze({
    token,
    frameMs: afterGpu - frameStart,
    cpuMs: afterCpu - cpuStart,
    gpuMs: afterGpu - afterCpu,
    gpuTimestampMs: null,
    paletteGpuTimestampMs: null,
    cullGpuTimestampMs: null,
    sceneRenderGpuTimestampMs: null,
    completionWallMs: afterGpu - afterCpu,
    instrumentationWallMs: 0,
    timestampReadbackWallMs: 0,
  });
}

function createImmediateDrainTimer(
  getCapability: () => Readonly<BrowserGpuTimingCapability>,
  measureFrame: (
    token: number,
    render: () => void | Promise<void>,
  ) => Promise<Readonly<CompletedFrameSample>>,
  destroyTimer: () => void,
): GpuFrameTimer {
  let destroyed = false;
  let nextToken = 0;
  let completed: CompletedFrameSample[] = [];
  const measureProductFrame = async (
    render: () => void | Promise<void>,
  ): Promise<Readonly<ProductFrameSample>> => {
    if (destroyed) throw new Error("GPU frame timer is destroyed");
    const sample = await measureFrame(nextToken, render);
    nextToken += 1;
    completed.push(sample);
    return productFrame(sample);
  };
  const drain = async (): Promise<readonly Readonly<CompletedFrameSample>[]> => {
    if (destroyed) throw new Error("GPU frame timer is destroyed");
    const drained = Object.freeze([...completed].sort((left, right) => left.token - right.token));
    completed = [];
    return drained;
  };

  return Object.freeze({
    get capability() {
      return getCapability();
    },
    async measure(render: () => void | Promise<void>) {
      const product = await measureProductFrame(render);
      const drained = await drain();
      const sample = drained.find((candidate) => candidate.token === product.token);
      if (sample === undefined) throw new Error("GPU timing sample was lost during drain");
      return sample;
    },
    measureProductFrame,
    drain,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      completed = [];
      destroyTimer();
    },
  });
}

function productFrame(sample: Readonly<CompletedFrameSample>): Readonly<ProductFrameSample> {
  return Object.freeze({
    token: sample.token,
    frameMs: sample.frameMs,
    cpuMs: sample.cpuMs,
    completionWallMs: sample.completionWallMs,
    instrumentationWallMs: sample.instrumentationWallMs,
  });
}

async function waitForWebGlQuery(gl: WebGL2RenderingContext, query: WebGLQuery): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
    if (performance.now() >= deadline) throw new Error("WebGL timer query readback timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function capability(renderer: "webgl" | "webgpu", reason?: string): BrowserGpuTimingCapability {
  return Object.freeze({
    renderer,
    method: "completion-wall",
    gpuTimeSource: "completion-wall",
    quality: "unavailable",
    supported: false,
    timerQuery: false,
    timestampWrites: false,
    resolveQuerySet: false,
    readback: false,
    disjoint: false,
    samples: 0,
    validSamples: 0,
    fallbackSamples: 0,
    fusedTimestampResolves: 0,
    standaloneTimestampSubmissions: 0,
    timestampReadbackMode: "immediate",
    timestampReadbackRingSize: 0,
    pendingTimestampReadbacks: 0,
    maxPendingTimestampReadbacks: 0,
    segmentedTimestampWrites: false,
    timestampQueriesPerFrame: 0,
    segmentedSamples: 0,
    validSegmentedSamples: 0,
    segmentedFallbackSamples: 0,
    validPaletteSamples: 0,
    validCullSamples: 0,
    validSceneRenderSamples: 0,
    ...(reason === undefined ? {} : { reason }),
  });
}

function timingQuality(
  validSamples: number,
  samples: number,
): Pick<BrowserGpuTimingCapability, "gpuTimeSource" | "quality"> {
  if (samples === 0) return { gpuTimeSource: "completion-wall", quality: "unavailable" };
  if (validSamples === 0) return { gpuTimeSource: "completion-wall", quality: "fallback" };
  if (validSamples === samples) return { gpuTimeSource: "gpu-timestamp", quality: "valid" };
  return { gpuTimeSource: "mixed", quality: "mixed" };
}
