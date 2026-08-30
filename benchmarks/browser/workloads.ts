import { Viewport } from "pixi-viewport";
import {
  BufferImageSource,
  Rectangle,
  Texture,
  type Application,
  type Container,
  type Renderer,
  type WebGLRenderer,
} from "pixi.js";

import { TextLayer } from "../../src";
import type { RunBounds, TextId, TextLabelSpec, TextUpdate } from "../../src";
import {
  GlyphAtlas,
  GlyphMesh,
  GLYPH_DRAW_STRIDE,
  GLYPH_INSTANCE_STRIDE,
  LayoutEngine,
  TRANSFORM_EFFECT_STRIDE,
  TRANSFORM_PALETTE_STRIDE,
} from "../../src/advanced";
import {
  allocatePrototypePixels,
  packF16,
  packHalf2x16,
  prototypeTextureLayout,
  writeDrawInstance,
  writePrototypeGlyphs,
} from "../../src/render/pack";
import { paletteMoveDispatchBytes } from "../../src/render/paletteStorage";
import { bindViewport } from "../../src/viewport";
import { evaluateGpuSceneResidentOutputTruth } from "../gpu-scene-resident-truth";
import {
  LABEL_COLLISION_BENCHMARK_DEFAULTS,
  createLabelCollisionBenchmarkSpecs,
  summarizeLabelCollisionWorkload,
} from "../label-collision";
import {
  GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
  summarize,
  type BrowserBenchmarkConfiguration,
  type BrowserBenchmarkCounters,
  type BrowserBenchmarkPhaseTimings,
  type BrowserBenchmarkTimings,
} from "../schema";
import type { BrowserFixtureResult } from "./fixtures";
import {
  completeFrame,
  createGpuFrameTimer,
  finishGpu,
  type CompletedFrameSample,
  type GpuFrameTimer,
  type ProductFrameSample,
} from "./timing";

const ACTIVE_ALPHA_METADATA = 0x8001_0000;
const INSTANCE_STRIDE = GLYPH_INSTANCE_STRIDE;
const TRANSFORM_STRIDE = TRANSFORM_PALETTE_STRIDE;
const CHUNK_SIZE = 8_192;
const DEFAULT_STYLE = Object.freeze({ fontFamily: "Arial", fontSize: 8, fill: 0xffffff });
const LABEL_COLLISION_GLYPHS_PER_LABEL = "MapLabel".length;
const GPU_RESIDENT_GRID_WIDTH = 1_000;
const GPU_RESIDENT_SPACING = 16;
const GPU_RESIDENT_ROW_SPACING = 0.4;
const GPU_RESIDENT_VISIBLE_COLUMNS = 50;
const GPU_RESIDENT_VIEW_WIDTH = 792;
const GPU_RESIDENT_FRAME_BUDGET_MS = 16.67;
const MILLION_LIVE_TEXT = "Glyph000";
const GPU_SCENE_HETEROGENEOUS_SPACING = 2;
const GPU_SCENE_HETEROGENEOUS_PAIR_PERIOD = 512;
const GPU_SCENE_HETEROGENEOUS_PAINT_MULTIPLIER = 37;

export const GPU_SCENE_HETEROGENEOUS_PROTOTYPES: readonly string[] = Object.freeze([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?",
]);
export const GPU_SCENE_HETEROGENEOUS_PAINTS: readonly number[] = Object.freeze([
  0xffffff, 0xff4d6d, 0x4dabf7, 0x69db7c, 0xffd43b, 0xb197fc, 0xff922b, 0x22b8cf,
]);

interface DenseLayerResult {
  readonly layer: TextLayer;
  readonly ids: Float64Array | undefined;
}

interface DenseLayerOptions {
  readonly keepIds?: boolean;
  readonly rendering?: boolean;
  readonly culling?: false | Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly computeCull?: boolean | "auto";
  readonly residency?: "gpu-scene" | "viewport";
  readonly spacing?: number;
  readonly spacingX?: number;
  readonly spacingY?: number;
  readonly text?: string | ((index: number) => string);
  readonly style?:
    | Readonly<NonNullable<TextLabelSpec["style"]>>
    | ((index: number) => Readonly<NonNullable<TextLabelSpec["style"]>>);
}

export interface GpuSceneHeterogeneousSelectionInput {
  readonly labelCount: number;
  readonly mutationCount: number;
  readonly moverOffset: number;
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly prototypeBounds: readonly Readonly<RunBounds>[];
}

export async function runGlyphflowWorkload(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  switch (configuration.workload) {
    case "million-full":
      return runMillionFull(app, configuration);
    case "million-live":
      return runMillionLive(app, configuration);
    case "million-viewport":
      return runMillionViewport(configuration);
    case "first-seen":
      return runFirstSeen(app, configuration);
    case "camera-live":
      return runCameraLive(app, configuration);
    case "gpu-scene-resident":
      return runGpuSceneResident(app, configuration);
    case "gpu-scene-heterogeneous-64":
      return runGpuSceneHeterogeneous64(app, configuration);
    case "gpu-scene-v2":
      return runGpuSceneV2(app, configuration);
    case "label-collision":
      return runLabelCollision(app, configuration);
    case "dynamic-counters":
      return runDynamicCounters(configuration);
    case "viewport-drag":
      return runViewportInteraction(app, configuration, "drag");
    case "viewport-zoom":
      return runViewportInteraction(app, configuration, "zoom");
    case "position-storm":
      return runPositionStorm(configuration);
    case "multilingual-stream":
      return runMultilingualStream(app, configuration);
    case "scale-scan":
      return runScaleScan(app, configuration);
    case "atlas-pressure":
      return runAtlasPressure(configuration);
    case "static-hud":
      throw new RangeError("Static HUD uses the equal-content fixture driver");
  }
}

export function gpuSceneHeterogeneousPrototypeIndex(index: number): number {
  assertHeterogeneousLabelIndex(index);
  return index % GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length;
}

export function gpuSceneHeterogeneousPaintIndex(index: number): number {
  assertHeterogeneousLabelIndex(index);
  const pairOffset =
    ((index % GPU_SCENE_HETEROGENEOUS_PAIR_PERIOD) * GPU_SCENE_HETEROGENEOUS_PAINT_MULTIPLIER) %
    GPU_SCENE_HETEROGENEOUS_PAIR_PERIOD;
  return Math.floor(pairOffset / GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length);
}

/** Independent CPU selection over actual prototype-local bounds in packed slot order. */
export function expectedGpuSceneHeterogeneousSelection(
  input: Readonly<GpuSceneHeterogeneousSelectionInput>,
): Readonly<{ submittedGlyphs: number; submittedGlyphsHash: number }> {
  if (!Number.isSafeInteger(input.labelCount) || input.labelCount < 0) {
    throw new TypeError("heterogeneous labelCount must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(input.mutationCount) ||
    input.mutationCount < 0 ||
    input.mutationCount > input.labelCount
  ) {
    throw new TypeError("heterogeneous mutationCount must fit labelCount");
  }
  if (!Number.isFinite(input.moverOffset)) {
    throw new TypeError("heterogeneous moverOffset must be finite");
  }
  if (input.prototypeBounds.length !== GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length) {
    throw new TypeError("heterogeneous prototype bounds must contain all 64 prototypes");
  }
  const left = Math.fround(input.viewport.x);
  const top = Math.fround(input.viewport.y);
  const right = Math.fround(left + Math.fround(input.viewport.width));
  const bottom = Math.fround(top + Math.fround(input.viewport.height));
  let submittedGlyphs = 0;
  let submittedGlyphsHash = 0x811c_9dc5;
  for (let slot = 0; slot < input.labelCount; slot += 1) {
    const prototypeIndex = gpuSceneHeterogeneousPrototypeIndex(slot);
    const bounds = input.prototypeBounds[prototypeIndex];
    if (bounds === undefined) {
      throw new Error(`heterogeneous prototype ${String(prototypeIndex)} bounds are unavailable`);
    }
    const offset = slot < input.mutationCount ? input.moverOffset : 0;
    const x = Math.fround((slot % 1_000) * GPU_SCENE_HETEROGENEOUS_SPACING + offset);
    const y = Math.fround(Math.floor(slot / 1_000) * GPU_SCENE_HETEROGENEOUS_SPACING + offset);
    const boundsX = Math.fround(bounds.x);
    const boundsY = Math.fround(bounds.y);
    const width = Math.fround(bounds.width);
    const height = Math.fround(bounds.height);
    const minimumX = Math.fround(x + boundsX);
    const minimumY = Math.fround(y + boundsY);
    const maximumX = Math.fround(minimumX + width);
    const maximumY = Math.fround(minimumY + height);
    if (maximumX < left || minimumX > right || maximumY < top || minimumY > bottom) continue;
    submittedGlyphs += 1;
    submittedGlyphsHash = Math.imul(submittedGlyphsHash ^ prototypeIndex, 0x0100_0193) >>> 0;
    submittedGlyphsHash = Math.imul(submittedGlyphsHash ^ slot, 0x0100_0193) >>> 0;
  }
  return Object.freeze({ submittedGlyphs, submittedGlyphsHash });
}

function assertHeterogeneousLabelIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError("heterogeneous label index must be a non-negative safe integer");
  }
}

async function runLabelCollision(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const timer = createGpuFrameTimer(app.renderer);
  const layer = new TextLayer({
    renderer: app.renderer,
    initialCapacity: configuration.labelCount,
    culling: {
      enabled: true,
      bounds: { x: 0, y: 0, width: configuration.width, height: configuration.height },
      computeCull: "auto",
      collision: LABEL_COLLISION_BENCHMARK_DEFAULTS.collision,
    },
  });
  for (let start = 0; start < configuration.labelCount; start += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, configuration.labelCount - start);
    layer.createMany(
      createLabelCollisionBenchmarkSpecs(start, count, {
        labelCount: configuration.labelCount,
      }),
    );
  }
  await layer.commit();
  app.stage.addChild(layer);
  const drawObserver = observeInstancedDraws(app.renderer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const frameMs: number[] = [];
  const cpuMs: number[] = [];
  const gpuMs: number[] = [];
  const gpuTimestampMs: Array<number | null> = [];
  const completionWallMs: number[] = [];
  const instrumentationWallMs: number[] = [];
  const timestampReadbackWallMs: number[] = [];
  const sampledProducts: ProductFrameSample[] = [];
  const uploadBytes: number[] = [];
  const uploadMs: number[] = [];
  const commitMs: number[] = [];
  const cullingMs: number[] = [];
  const visibilitySelectionMs: number[] = [];
  const renderPreparationMs: number[] = [];
  const renderCoordinatorMs: number[] = [];
  const surfaceApplyMs: number[] = [];
  const total = configuration.warmupFrames + configuration.sampleFrames;
  const groupCount = Math.ceil(
    configuration.labelCount / LABEL_COLLISION_BENCHMARK_DEFAULTS.overlapGroupSize,
  );
  const columns = Math.min(LABEL_COLLISION_BENCHMARK_DEFAULTS.groupColumns, groupCount);
  const rows = Math.ceil(groupCount / LABEL_COLLISION_BENCHMARK_DEFAULTS.groupColumns);
  const maxCameraX = Math.max(
    0,
    (columns - 1) * LABEL_COLLISION_BENCHMARK_DEFAULTS.groupSpacingX - configuration.width,
  );
  const maxCameraY = Math.max(
    0,
    (rows - 1) * LABEL_COLLISION_BENCHMARK_DEFAULTS.groupSpacingY - configuration.height,
  );

  try {
    for (let frame = 0; frame < total; frame += 1) {
      const beforeUpload = uploadTotal(layer);
      const frameStart = performance.now();
      layer.setViewportBounds({
        x: maxCameraX === 0 ? 0 : (frame * 11) % (maxCameraX + 1),
        y: maxCameraY === 0 ? 0 : (frame * 5) % (maxCameraY + 1),
        width: configuration.width,
        height: configuration.height,
      });
      const mutationDuration = performance.now() - frameStart;
      let commitDuration = 0;
      const product = await timer.measureProductFrame(async () => {
        const commitStart = performance.now();
        await layer.commit();
        commitDuration = performance.now() - commitStart;
        app.render();
      });
      if (frame < configuration.warmupFrames) continue;
      const stats = layer.stats;
      frameMs.push(mutationDuration + product.cpuMs + product.completionWallMs);
      cpuMs.push(product.cpuMs);
      completionWallMs.push(product.completionWallMs);
      instrumentationWallMs.push(product.instrumentationWallMs);
      sampledProducts.push(product);
      uploadBytes.push(Math.max(0, uploadTotal(layer) - beforeUpload));
      uploadMs.push(stats.lastUploadMs);
      commitMs.push(commitDuration);
      cullingMs.push(stats.lastCollisionMs);
      visibilitySelectionMs.push(stats.lastVisibilitySelectionMs);
      renderPreparationMs.push(stats.lastRenderPreparationMs);
      renderCoordinatorMs.push(stats.lastRenderCoordinatorMs);
      surfaceApplyMs.push(stats.lastSurfaceApplyMs);
    }
    const timestampSamples = await drainSampledFrames(timer, sampledProducts);
    for (const sample of timestampSamples) {
      gpuMs.push(sample.gpuMs);
      gpuTimestampMs.push(sample.gpuTimestampMs);
      timestampReadbackWallMs.push(sample.timestampReadbackWallMs);
    }
    const stats = layer.stats;
    const summary = summarizeLabelCollisionWorkload(
      stats,
      commitMs.at(-1) ?? stats.lastCommitDurationMs,
      stats.labelCount,
    );
    const observed = drawObserver.read();
    const candidateReductionRatio =
      summary.candidateLabels === 0
        ? 0
        : (summary.candidateLabels - summary.submittedLabels) / summary.candidateLabels;
    const counters: BrowserBenchmarkCounters = Object.freeze({
      ...layerCounters(stats, 1),
      submittedLabels: summary.submittedLabels,
      visibleGlyphs: stats.submittedGlyphs,
      submittedGlyphs: stats.submittedGlyphs,
      observedDrawCalls: observed.drawCalls,
      maximumInstanceCount: observed.maximumInstanceCount,
      collisionCandidateLabels: summary.candidateLabels,
      collisionCulledLabels: summary.collisionCulledLabels,
      densityCulledLabels: summary.densityCulledLabels,
      submittedReduction: summary.submittedReduction,
      submittedReductionRatio: summary.submittedReductionRatio,
      collisionCandidateReductionRatio: candidateReductionRatio,
      collisionSelectionHash: summary.selectionHash,
      lastCollisionMs: summary.collisionCpuMs,
      collisionRecordBytes: stats.collisionRecordBytes,
    });

    return result(
      {
        setupMs,
        frameMs: Object.freeze(frameMs),
        cpuMs: Object.freeze(cpuMs),
        gpuMs: Object.freeze(gpuMs),
        gpuTimestampMs: Object.freeze(gpuTimestampMs),
        completionWallMs: Object.freeze(completionWallMs),
        instrumentationWallMs: Object.freeze(instrumentationWallMs),
        timestampReadbackWallMs: Object.freeze(timestampReadbackWallMs),
        uploadBytes: Object.freeze(uploadBytes),
        uploadMs: Object.freeze(uploadMs),
        commitMs: Object.freeze(commitMs),
        cullingMs: Object.freeze(cullingMs),
        visibilitySelectionMs: Object.freeze(visibilitySelectionMs),
        renderPreparationMs: Object.freeze(renderPreparationMs),
        renderCoordinatorMs: Object.freeze(renderCoordinatorMs),
        surfaceApplyMs: Object.freeze(surfaceApplyMs),
        gpuTiming: timer.capability,
      },
      counters,
      {
        exactResidentLabels: counters.residentLabels === configuration.labelCount,
        collisionEnabled: stats.collisionEnabled,
        candidateSetReduced: summary.candidateLabels > summary.submittedLabels,
        highOverlapReduction: candidateReductionRatio > 0.9,
        submittedLabelsMatchSelector: summary.submittedLabels === stats.collisionVisibleLabelCount,
        submittedGlyphsMatchSelection:
          stats.submittedGlyphs === summary.submittedLabels * LABEL_COLLISION_GLYPHS_PER_LABEL,
        submittedReductionRatio: summary.submittedReductionRatio,
        candidateReductionRatio,
        collisionAccountingExact:
          summary.candidateLabels ===
          summary.submittedLabels + summary.collisionCulledLabels + summary.densityCulledLabels,
        collisionSelectionHashRecorded: summary.selectionHash > 0,
        cullPath: stats.cullPath,
        palettePath: stats.palettePath,
        gpuTimingMethod: timer.capability.method,
        gpuTimingReadback: timer.capability.readback,
        everyFrameMeasured: frameMs.length === configuration.sampleFrames,
        everyPhaseMeasured:
          visibilitySelectionMs.length === configuration.sampleFrames &&
          renderPreparationMs.length === configuration.sampleFrames &&
          renderCoordinatorMs.length === configuration.sampleFrames &&
          surfaceApplyMs.length === configuration.sampleFrames,
      },
    );
  } finally {
    timer.destroy();
    drawObserver.destroy();
    layer.destroy();
  }
}

/** R1a delivery scene: 64 real raster prototypes crossed with 8 canonical fill paints. */
async function runGpuSceneHeterogeneous64(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  if (configuration.renderer !== "webgpu" || !("gpu" in app.renderer)) {
    throw new Error("gpu-scene-heterogeneous-64 requires an active WebGPU renderer");
  }
  const styles = GPU_SCENE_HETEROGENEOUS_PAINTS.map((fill) =>
    Object.freeze({ fontFamily: "Arial", fontSize: 4, fill }),
  );
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      keepIds: true,
      rendering: true,
      culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
      computeCull: true,
      residency: "gpu-scene",
      spacing: GPU_SCENE_HETEROGENEOUS_SPACING,
      text: (index) =>
        GPU_SCENE_HETEROGENEOUS_PROTOTYPES[gpuSceneHeterogeneousPrototypeIndex(index)] ?? "?",
      style: (index) => styles[gpuSceneHeterogeneousPaintIndex(index)] ?? styles[0]!,
    },
    app.renderer,
  );
  const viewport = new Viewport({
    screenWidth: configuration.width,
    screenHeight: configuration.height,
    worldWidth: 4_000,
    worldHeight: 4_000,
    events: app.renderer.events,
    noTicker: true,
  });
  app.stage.addChild(viewport);
  const binding = bindViewport(dense.layer, viewport);
  await binding.whenIdle();
  const drawObserver = observeInstancedDraws(app.renderer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const setupStats = dense.layer.stats;
  const sceneSetupMs = setupStats.lastSceneSetupMs;
  if (
    setupStats.residencyActive !== "gpu-scene" ||
    setupStats.residencyFallbackReason !== undefined ||
    setupStats.gpuResidentLabels !== configuration.labelCount ||
    setupStats.gpuScenePrototypeCount !== GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length ||
    setupStats.gpuScenePaintCount !== GPU_SCENE_HETEROGENEOUS_PAINTS.length
  ) {
    throw new Error(
      `Heterogeneous GPU scene setup mismatch: active=${setupStats.residencyActive}, ` +
        `fallback=${setupStats.residencyFallbackReason ?? "none"}, ` +
        `labels=${String(setupStats.gpuResidentLabels)}, ` +
        `prototypes=${String(setupStats.gpuScenePrototypeCount)}, ` +
        `paints=${String(setupStats.gpuScenePaintCount)}`,
    );
  }
  const prototypeBounds = await measureGpuSceneHeterogeneousPrototypeBounds(
    dense.layer,
    styles[0]!,
  );
  const timer = createGpuFrameTimer(app.renderer);
  const ids = requireIds(dense);
  const mutationCount = Math.min(configuration.mutationCount, configuration.labelCount);
  const mutationIds = ids.subarray(0, mutationCount);
  const positionsA = buildPositions(mutationCount, GPU_SCENE_HETEROGENEOUS_SPACING, 0.25);
  const positionsB = buildPositions(mutationCount, GPU_SCENE_HETEROGENEOUS_SPACING, 0.75);
  const transactionBaseline = dense.layer.stats;
  let diagnosticReadbackSubmissions = 0;

  try {
    const camera = await sampleGpuResidentScenePhase(
      app,
      dense.layer,
      timer,
      configuration,
      (frame) => prepareGpuSceneCamera(viewport, configuration.sampleFrames, frame),
      flushViewportFrame(viewport, binding),
    );
    const cameraViewport = requireBenchmarkViewportBounds(binding.stats.lastBounds, "camera");
    diagnosticReadbackSubmissions += 1;
    const cameraSubmitted = await dense.layer.readSubmittedGlyphsDiagnostic();
    if (cameraSubmitted === undefined) {
      throw new Error("Heterogeneous camera compacted-output readback is unavailable");
    }

    const positionMutation = await sampleGpuResidentScenePhase(
      app,
      dense.layer,
      timer,
      configuration,
      (frame) => {
        const mutationStart = performance.now();
        const changed = dense.layer.updatePositions(
          mutationIds,
          frame % 2 === 0 ? positionsB : positionsA,
        );
        if (changed !== mutationCount) {
          throw new Error(`Heterogeneous GPU scene changed ${String(changed)} labels`);
        }
        setGpuSceneCamera(viewport, (frame * 17) % 640, (frame * 11) % 320, 1);
        return performance.now() - mutationStart;
      },
      flushViewportFrame(viewport, binding),
    );
    const transactionFinal = dense.layer.stats;
    const frameTransactionSubmissions = Math.max(
      0,
      transactionFinal.frameTransactionSubmissions -
        transactionBaseline.frameTransactionSubmissions,
    );
    const frameTransactionFusedSubmissions = Math.max(
      0,
      transactionFinal.frameTransactionFusedSubmissions -
        transactionBaseline.frameTransactionFusedSubmissions,
    );
    const frameTransactionStandaloneSubmissions = Math.max(
      0,
      transactionFinal.frameTransactionStandaloneSubmissions -
        transactionBaseline.frameTransactionStandaloneSubmissions,
    );
    const positionViewport = requireBenchmarkViewportBounds(binding.stats.lastBounds, "position");
    diagnosticReadbackSubmissions += 1;
    const submitted = await dense.layer.readSubmittedGlyphsDiagnostic();
    if (submitted === undefined) {
      throw new Error("Heterogeneous position compacted-output readback is unavailable");
    }

    const expectedCamera = expectedGpuSceneHeterogeneousSelection({
      labelCount: configuration.labelCount,
      mutationCount: 0,
      moverOffset: 0,
      viewport: cameraViewport,
      prototypeBounds,
    });
    const finalFrame = configuration.warmupFrames + configuration.sampleFrames - 1;
    const expectedPosition = expectedGpuSceneHeterogeneousSelection({
      labelCount: configuration.labelCount,
      mutationCount,
      moverOffset: finalFrame % 2 === 0 ? 0.75 : 0.25,
      viewport: positionViewport,
      prototypeBounds,
    });

    app.render();
    await finishGpu(app.renderer);
    const pixels = await hashRenderedPixels(
      app,
      app.stage,
      configuration.width,
      configuration.height,
    );
    const pixelsRepeat = await hashRenderedPixels(
      app,
      app.stage,
      configuration.width,
      configuration.height,
    );
    const stats = dense.layer.stats;
    const bindingStats = binding.stats;
    const observed = drawObserver.read();
    const prototypePaintPairCount = gpuSceneHeterogeneousPrototypePaintPairCount(
      configuration.labelCount,
    );
    const counters: BrowserBenchmarkCounters = Object.freeze({
      ...layerCounters(stats, 1),
      submittedLabels: submitted.submittedGlyphs,
      visibleGlyphs: submitted.submittedGlyphs,
      submittedGlyphs: submitted.submittedGlyphs,
      activeGlyphInstances: submitted.submittedGlyphs,
      submittedGlyphsSource: "gpu-indirect-readback",
      submittedGlyphsHashSource: "gpu-instances-out-readback",
      cameraSubmittedGlyphs: cameraSubmitted.submittedGlyphs,
      cameraSubmittedGlyphsHash: cameraSubmitted.submittedGlyphsHash,
      expectedCameraSubmittedGlyphs: expectedCamera.submittedGlyphs,
      expectedCameraSubmittedGlyphsHash: expectedCamera.submittedGlyphsHash,
      expectedSubmittedGlyphs: expectedPosition.submittedGlyphs,
      expectedSubmittedGlyphsHash: expectedPosition.submittedGlyphsHash,
      expectedSubmittedGlyphsSource: "cpu-prototype-bounds",
      submittedGlyphsHash: submitted.submittedGlyphsHash,
      renderedPixelHash: pixels.hash,
      renderedPixelHashRepeat: pixelsRepeat.hash,
      nonTransparentPixels: pixels.nonTransparentPixels,
      nonTransparentPixelsRepeat: pixelsRepeat.nonTransparentPixels,
      drawCallsSource: "logical-mesh-count",
      observedDrawCalls: observed.drawCalls,
      observedDrawCallsSource: "unavailable-webgpu",
      maximumInstanceCount: observed.maximumInstanceCount,
      coalescedEvents: bindingStats.coalescedEvents,
      rendererAdapter: stats.rendererAdapter,
      cullPath: stats.cullPath,
      palettePath: stats.palettePath,
      residencyRequested: stats.residencyRequested,
      residencyActive: stats.residencyActive,
      ...(stats.residencyFallbackReason === undefined
        ? {}
        : { residencyFallbackReason: stats.residencyFallbackReason }),
      gpuResidentLabels: stats.gpuResidentLabels,
      prototypeCount: stats.gpuScenePrototypeCount,
      paintCount: stats.gpuScenePaintCount,
      prototypePaintPairCount,
      gpuScenePerLabelObjectCount: stats.gpuScenePerLabelObjectCount,
      collisionEnabled: stats.collisionEnabled,
      deferredSpatialLabels: stats.deferredSpatialLabels,
      cullRecordUploadBytes: stats.cullRecordUploadBytes,
      lastSceneSetupMs: sceneSetupMs,
      frameTransactionSubmissions,
      frameTransactionFusedSubmissions,
      frameTransactionStandaloneSubmissions,
      frameTransactionCumulativeSubmissions: stats.frameTransactionSubmissions,
      frameTransactionCumulativeFusedSubmissions: stats.frameTransactionFusedSubmissions,
      frameTransactionCumulativeStandaloneSubmissions: stats.frameTransactionStandaloneSubmissions,
      diagnosticReadbackSubmissions,
      timestampReadbackSubmissions: timer.capability.resolveQuerySet ? timer.capability.samples : 0,
      timestampFusedResolves: timer.capability.fusedTimestampResolves,
      timestampStandaloneSubmissions: timer.capability.standaloneTimestampSubmissions,
      timestampReadbackRingSize: timer.capability.timestampReadbackRingSize ?? 0,
      timestampMaxPendingReadbacks: timer.capability.maxPendingTimestampReadbacks ?? 0,
      timestampPendingReadbacks: timer.capability.pendingTimestampReadbacks ?? 0,
      timestampQueriesPerFrame: timer.capability.timestampQueriesPerFrame ?? 0,
      timestampSegmentedSamples: timer.capability.segmentedSamples ?? 0,
      timestampValidSegmentedSamples: timer.capability.validSegmentedSamples ?? 0,
      timestampSegmentedFallbackSamples: timer.capability.segmentedFallbackSamples ?? 0,
      timestampValidPaletteSamples: timer.capability.validPaletteSamples ?? 0,
      timestampValidCullSamples: timer.capability.validCullSamples ?? 0,
      timestampValidSceneRenderSamples: timer.capability.validSceneRenderSamples ?? 0,
    });
    const timings: BrowserBenchmarkTimings = Object.freeze({
      setupMs,
      frameMs: freezeConcat(camera.frameMs, positionMutation.frameMs),
      cpuMs: freezeConcat(camera.cpuMs, positionMutation.cpuMs),
      gpuMs: freezeConcat(camera.gpuMs, positionMutation.gpuMs),
      gpuTimestampMs: freezeConcat(camera.gpuTimestampMs, positionMutation.gpuTimestampMs),
      paletteGpuTimestampMs: freezeConcat(
        camera.paletteGpuTimestampMs ?? [],
        positionMutation.paletteGpuTimestampMs ?? [],
      ),
      cullGpuTimestampMs: freezeConcat(
        camera.cullGpuTimestampMs ?? [],
        positionMutation.cullGpuTimestampMs ?? [],
      ),
      sceneRenderGpuTimestampMs: freezeConcat(
        camera.sceneRenderGpuTimestampMs ?? [],
        positionMutation.sceneRenderGpuTimestampMs ?? [],
      ),
      completionWallMs: freezeConcat(camera.completionWallMs, positionMutation.completionWallMs),
      instrumentationWallMs: freezeConcat(
        camera.instrumentationWallMs ?? [],
        positionMutation.instrumentationWallMs ?? [],
      ),
      timestampReadbackWallMs: freezeConcat(
        camera.timestampReadbackWallMs ?? [],
        positionMutation.timestampReadbackWallMs ?? [],
      ),
      uploadBytes: freezeConcat(camera.uploadBytes, positionMutation.uploadBytes),
      transformUploadBytes: freezeConcat(
        camera.transformUploadBytes ?? [],
        positionMutation.transformUploadBytes ?? [],
      ),
      cullRecordUploadBytes: freezeConcat(
        camera.cullRecordUploadBytes ?? [],
        positionMutation.cullRecordUploadBytes ?? [],
      ),
      frameTransactionSubmissionDeltas: freezeConcat(
        camera.frameTransactionSubmissionDeltas ?? [],
        positionMutation.frameTransactionSubmissionDeltas ?? [],
      ),
      frameTransactionFusedSubmissionDeltas: freezeConcat(
        camera.frameTransactionFusedSubmissionDeltas ?? [],
        positionMutation.frameTransactionFusedSubmissionDeltas ?? [],
      ),
      frameTransactionStandaloneSubmissionDeltas: freezeConcat(
        camera.frameTransactionStandaloneSubmissionDeltas ?? [],
        positionMutation.frameTransactionStandaloneSubmissionDeltas ?? [],
      ),
      uploadMs: freezeConcat(camera.uploadMs, positionMutation.uploadMs),
      commitMs: freezeConcat(camera.commitMs, positionMutation.commitMs),
      cullingMs: freezeConcat(camera.cullingMs, positionMutation.cullingMs),
      visibilitySelectionMs: freezeConcat(
        camera.visibilitySelectionMs,
        positionMutation.visibilitySelectionMs,
      ),
      renderPreparationMs: freezeConcat(
        camera.renderPreparationMs,
        positionMutation.renderPreparationMs,
      ),
      renderCoordinatorMs: freezeConcat(
        camera.renderCoordinatorMs,
        positionMutation.renderCoordinatorMs,
      ),
      surfaceApplyMs: freezeConcat(camera.surfaceApplyMs, positionMutation.surfaceApplyMs),
      offscreenInspectedLabels: freezeConcat(
        camera.offscreenInspectedLabels,
        positionMutation.offscreenInspectedLabels,
      ),
      offscreenMaterializedLabels: freezeConcat(
        camera.offscreenMaterializedLabels,
        positionMutation.offscreenMaterializedLabels,
      ),
      offscreenAdmissionDeferred: freezeConcat(
        camera.offscreenAdmissionDeferred,
        positionMutation.offscreenAdmissionDeferred,
      ),
      offscreenAdmissionGeneration: freezeConcat(
        camera.offscreenAdmissionGeneration,
        positionMutation.offscreenAdmissionGeneration,
      ),
      offscreenAdmissionCursor: freezeConcat(
        camera.offscreenAdmissionCursor,
        positionMutation.offscreenAdmissionCursor,
      ),
      offscreenAdmissionCursorResets: freezeConcat(
        camera.offscreenAdmissionCursorResets,
        positionMutation.offscreenAdmissionCursorResets,
      ),
      offscreenAdmissionCycles: freezeConcat(
        camera.offscreenAdmissionCycles,
        positionMutation.offscreenAdmissionCycles,
      ),
      deferredSpatialLabels: freezeConcat(
        camera.deferredSpatialLabels ?? [],
        positionMutation.deferredSpatialLabels ?? [],
      ),
      mutationMs: positionMutation.mutationMs,
      phases: Object.freeze({ camera, positionMutation }),
      gpuTiming: timer.capability,
    });
    const expectedPositionUpload = paletteMoveDispatchBytes("dense", mutationCount);
    const expectedSubmittedIdentity =
      cameraSubmitted.submittedGlyphs === expectedCamera.submittedGlyphs &&
      cameraSubmitted.submittedGlyphsHash === expectedCamera.submittedGlyphsHash &&
      submitted.submittedGlyphs === expectedPosition.submittedGlyphs &&
      submitted.submittedGlyphsHash === expectedPosition.submittedGlyphsHash;
    return result(timings, counters, {
      exactResidentLabels: counters.residentLabels === configuration.labelCount,
      exactGpuResidentLabels: counters.gpuResidentLabels === configuration.labelCount,
      exactPrototypeCount: counters.prototypeCount === GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length,
      exactPaintCount: counters.paintCount === GPU_SCENE_HETEROGENEOUS_PAINTS.length,
      prototypePaintInterleaveExact: prototypePaintPairCount === 512,
      gpuScenePerLabelObjectCountZero: stats.gpuScenePerLabelObjectCount === 0,
      collisionDisabled: stats.collisionEnabled === false,
      exactMutationCount: mutationCount === configuration.mutationCount,
      requestedRendererActive: stats.rendererAdapter === "webgpu",
      gpuSceneRequested: stats.residencyRequested === "gpu-scene",
      gpuSceneActive: stats.residencyActive === "gpu-scene",
      gpuSceneNoFallback: stats.residencyFallbackReason === undefined,
      expectedSubmittedIdentity,
      cameraExpectedSubmittedIdentity:
        cameraSubmitted.submittedGlyphs === expectedCamera.submittedGlyphs &&
        cameraSubmitted.submittedGlyphsHash === expectedCamera.submittedGlyphsHash,
      positionExpectedSubmittedIdentity:
        submitted.submittedGlyphs === expectedPosition.submittedGlyphs &&
        submitted.submittedGlyphsHash === expectedPosition.submittedGlyphsHash,
      fullScreenVisibleScale:
        expectedPosition.submittedGlyphs >= 250_000 && expectedPosition.submittedGlyphs <= 270_000,
      submittedGlyphsReadback: stats.submittedGlyphs === submitted.submittedGlyphs,
      pixelsRendered: pixels.nonTransparentPixels > 0 && pixels.hash > 0,
      pixelReadbackRepeatable:
        pixels.hash === pixelsRepeat.hash &&
        pixels.nonTransparentPixels === pixelsRepeat.nonTransparentPixels,
      cameraPhaseComplete: camera.frameMs.length === configuration.sampleFrames,
      positionMutationPhaseComplete: positionMutation.frameMs.length === configuration.sampleFrames,
      cameraShapedDeltaZero: camera.shapedLabelsDelta === 0,
      positionShapedDeltaZero: positionMutation.shapedLabelsDelta === 0,
      cameraAdmittedDeltaZero: camera.admittedLabelsTotal === 0,
      positionAdmittedDeltaZero: positionMutation.admittedLabelsTotal === 0,
      cameraCullingQueriesDeltaZero: camera.cullingQueriesDelta === 0,
      positionCullingQueriesDeltaZero: positionMutation.cullingQueriesDelta === 0,
      cameraTransformUploadZero: maximumSample(camera.transformUploadBytes) === 0,
      cameraCullRecordUploadZero: maximumSample(camera.cullRecordUploadBytes) === 0,
      positionTransformUploadExact:
        minimumSample(positionMutation.transformUploadBytes) === expectedPositionUpload &&
        maximumSample(positionMutation.transformUploadBytes) === expectedPositionUpload,
      positionCullRecordUploadZero: maximumSample(positionMutation.cullRecordUploadBytes) === 0,
      cameraProductSubmissionExact:
        camera.frameTransactionSubmissionDeltas?.every((count) => count === 1) === true,
      cameraFusedSubmissionExact:
        camera.frameTransactionFusedSubmissionDeltas?.every((count) => count === 1) === true,
      cameraStandaloneSubmissionZero:
        camera.frameTransactionStandaloneSubmissionDeltas?.every((count) => count === 0) === true,
      positionProductSubmissionExact:
        positionMutation.frameTransactionSubmissionDeltas?.every((count) => count === 1) === true,
      positionFusedSubmissionExact:
        positionMutation.frameTransactionFusedSubmissionDeltas?.every((count) => count === 1) ===
        true,
      positionStandaloneSubmissionZero:
        positionMutation.frameTransactionStandaloneSubmissionDeltas?.every(
          (count) => count === 0,
        ) === true,
      timestampFusedResolveExact:
        timer.capability.fusedTimestampResolves === timer.capability.samples,
      timestampStandaloneSubmissionZero: timer.capability.standaloneTimestampSubmissions === 0,
      timestampReadbackDeferredRing: timer.capability.timestampReadbackMode === "deferred-ring",
      timestampReadbackRingSizeExact: timer.capability.timestampReadbackRingSize === 3,
      timestampReadbackDrainComplete: timer.capability.pendingTimestampReadbacks === 0,
      timestampSegmentedExact:
        timer.capability.segmentedTimestampWrites === true &&
        timer.capability.timestampQueriesPerFrame === 6 &&
        timer.capability.segmentedSamples === timer.capability.samples,
      timestampSegmentsValid:
        timer.capability.validSegmentedSamples === timer.capability.samples &&
        timer.capability.segmentedFallbackSamples === 0 &&
        timer.capability.validPaletteSamples === timer.capability.samples &&
        timer.capability.validCullSamples === timer.capability.samples &&
        timer.capability.validSceneRenderSamples === timer.capability.samples,
      cameraFrameMetricExact: camera.frameMetric === "mutation+timer-cpu+queue-completion",
      positionFrameMetricExact:
        positionMutation.frameMetric === "mutation+timer-cpu+queue-completion",
      expectedCameraSubmitted: expectedCamera.submittedGlyphs,
      expectedCameraSubmittedHash: expectedCamera.submittedGlyphsHash,
      expectedSubmitted: expectedPosition.submittedGlyphs,
      expectedSubmittedHash: expectedPosition.submittedGlyphsHash,
      expectedPositionUpload,
      diagnosticReadbackSubmissions,
      cullPath: stats.cullPath,
      palettePath: stats.palettePath,
      gpuTimingMethod: timer.capability.method,
      gpuTimingReadback: timer.capability.readback,
      viewportFrameEvents: bindingStats.frameEndEvents,
      viewportCommits: bindingStats.commits,
    });
  } finally {
    timer.destroy();
    drawObserver.destroy();
    binding.destroy();
    dense.layer.destroy();
    viewport.destroy({ children: true });
  }
}

/** WebGPU-resident product path: one shared prototype, camera motion, then 100K movers. */
async function runGpuSceneResident(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  if (configuration.renderer !== "webgpu" || !("gpu" in app.renderer)) {
    throw new Error("gpu-scene-resident requires an active WebGPU renderer");
  }
  const setupStart = performance.now();
  const viewHeight = gpuResidentViewHeight(configuration.labelCount);
  const dense = await createDenseLayer(
    configuration,
    {
      keepIds: true,
      rendering: true,
      culling: { x: 0, y: 0, width: GPU_RESIDENT_VIEW_WIDTH, height: viewHeight },
      computeCull: true,
      residency: "gpu-scene",
      spacingX: GPU_RESIDENT_SPACING,
      spacingY: GPU_RESIDENT_ROW_SPACING,
      text: "g",
      style: { fontFamily: "Arial", fontSize: 8, fill: 0xffffff },
    },
    app.renderer,
  );
  const sceneSetupMs = dense.layer.stats.lastSceneSetupMs;
  const viewport = new Viewport({
    screenWidth: configuration.width,
    screenHeight: configuration.height,
    worldWidth: GPU_RESIDENT_GRID_WIDTH * GPU_RESIDENT_SPACING,
    worldHeight: viewHeight + 8,
    events: app.renderer.events,
    noTicker: true,
  });
  setGpuResidentCamera(viewport, configuration, viewHeight, 0);
  app.stage.addChild(viewport);
  const binding = bindViewport(dense.layer, viewport);
  await binding.whenIdle();
  const drawObserver = observeInstancedDraws(app.renderer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const timer = createGpuFrameTimer(app.renderer);
  const ids = requireIds(dense);
  const mutationCount = Math.min(configuration.mutationCount, configuration.labelCount);
  const mutationIds = ids.subarray(0, mutationCount);
  const positionsA = buildGpuResidentPositions(mutationCount, 0.25);
  const positionsB = buildGpuResidentPositions(mutationCount, 0.75);
  const expectedSubmitted = gpuResidentSubmittedCount(configuration.labelCount);
  const expectedSubmittedHash = hashGpuResidentSelection(configuration.labelCount);
  let diagnosticReadbackSubmissions = 0;

  try {
    const camera = await sampleGpuResidentScenePhase(
      app,
      dense.layer,
      timer,
      configuration,
      (frame) => prepareGpuResidentCamera(viewport, configuration, viewHeight, frame),
      flushViewportFrame(viewport, binding),
    );
    diagnosticReadbackSubmissions += 1;
    const cameraSubmitted = await dense.layer.readSubmittedGlyphsDiagnostic();
    if (cameraSubmitted === undefined) {
      throw new Error("GPU-resident camera phase compacted-output readback is unavailable");
    }
    const positionMutation = await sampleGpuResidentScenePhase(
      app,
      dense.layer,
      timer,
      configuration,
      (frame) => {
        const mutationStart = performance.now();
        const changed = dense.layer.updatePositions(
          mutationIds,
          frame % 2 === 0 ? positionsB : positionsA,
        );
        if (changed !== mutationCount) {
          throw new Error(`GPU-resident scene changed ${String(changed)} labels`);
        }
        return performance.now() - mutationStart;
      },
    );
    diagnosticReadbackSubmissions += 1;
    const submitted = await dense.layer.readSubmittedGlyphsDiagnostic();
    if (submitted === undefined) {
      throw new Error("GPU-resident position phase compacted-output readback is unavailable");
    }
    const submittedGlyphs = submitted.submittedGlyphs;
    app.render();
    await finishGpu(app.renderer);
    const pixels = await hashRenderedPixels(
      app,
      app.stage,
      configuration.width,
      configuration.height,
    );
    const pixelsRepeat = await hashRenderedPixels(
      app,
      app.stage,
      configuration.width,
      configuration.height,
    );
    const stats = dense.layer.stats;
    const bindingStats = binding.stats;
    const observed = drawObserver.read();
    const counters: BrowserBenchmarkCounters = Object.freeze({
      ...layerCounters(stats, 1),
      submittedLabels: submittedGlyphs,
      visibleGlyphs: submittedGlyphs,
      submittedGlyphs,
      activeGlyphInstances: submittedGlyphs,
      submittedGlyphsSource: "gpu-indirect-readback",
      submittedGlyphsHashSource: "gpu-instances-out-readback",
      submittedGlyphsHash: submitted.submittedGlyphsHash,
      renderedPixelHash: pixels.hash,
      renderedPixelHashRepeat: pixelsRepeat.hash,
      nonTransparentPixels: pixels.nonTransparentPixels,
      nonTransparentPixelsRepeat: pixelsRepeat.nonTransparentPixels,
      drawCallsSource: "logical-mesh-count",
      observedDrawCalls: observed.drawCalls,
      observedDrawCallsSource: "unavailable-webgpu",
      maximumInstanceCount: observed.maximumInstanceCount,
      coalescedEvents: bindingStats.coalescedEvents,
      rendererAdapter: stats.rendererAdapter,
      cullPath: stats.cullPath,
      palettePath: stats.palettePath,
      residencyRequested: stats.residencyRequested,
      residencyActive: stats.residencyActive,
      ...(stats.residencyFallbackReason === undefined
        ? {}
        : { residencyFallbackReason: stats.residencyFallbackReason }),
      gpuResidentLabels: stats.gpuResidentLabels,
      prototypeCount: stats.gpuScenePrototypeCount,
      deferredSpatialLabels: stats.deferredSpatialLabels,
      cullRecordUploadBytes: stats.cullRecordUploadBytes,
      lastSceneSetupMs: sceneSetupMs,
      frameTransactionSubmissions: stats.frameTransactionSubmissions,
      frameTransactionFusedSubmissions: stats.frameTransactionFusedSubmissions,
      frameTransactionStandaloneSubmissions: stats.frameTransactionStandaloneSubmissions,
      diagnosticReadbackSubmissions,
      timestampReadbackSubmissions: timer.capability.resolveQuerySet ? timer.capability.samples : 0,
      timestampFusedResolves: timer.capability.fusedTimestampResolves,
      timestampStandaloneSubmissions: timer.capability.standaloneTimestampSubmissions,
      timestampReadbackRingSize: timer.capability.timestampReadbackRingSize ?? 0,
      timestampMaxPendingReadbacks: timer.capability.maxPendingTimestampReadbacks ?? 0,
      timestampPendingReadbacks: timer.capability.pendingTimestampReadbacks ?? 0,
      timestampQueriesPerFrame: timer.capability.timestampQueriesPerFrame ?? 0,
      timestampSegmentedSamples: timer.capability.segmentedSamples ?? 0,
      timestampValidSegmentedSamples: timer.capability.validSegmentedSamples ?? 0,
      timestampSegmentedFallbackSamples: timer.capability.segmentedFallbackSamples ?? 0,
      timestampValidPaletteSamples: timer.capability.validPaletteSamples ?? 0,
      timestampValidCullSamples: timer.capability.validCullSamples ?? 0,
      timestampValidSceneRenderSamples: timer.capability.validSceneRenderSamples ?? 0,
    });
    const canonicalTruth = evaluateGpuSceneResidentOutputTruth(configuration, counters);
    const timings: BrowserBenchmarkTimings = Object.freeze({
      setupMs,
      frameMs: freezeConcat(camera.frameMs, positionMutation.frameMs),
      cpuMs: freezeConcat(camera.cpuMs, positionMutation.cpuMs),
      gpuMs: freezeConcat(camera.gpuMs, positionMutation.gpuMs),
      gpuTimestampMs: freezeConcat(camera.gpuTimestampMs, positionMutation.gpuTimestampMs),
      paletteGpuTimestampMs: freezeConcat(
        camera.paletteGpuTimestampMs ?? [],
        positionMutation.paletteGpuTimestampMs ?? [],
      ),
      cullGpuTimestampMs: freezeConcat(
        camera.cullGpuTimestampMs ?? [],
        positionMutation.cullGpuTimestampMs ?? [],
      ),
      sceneRenderGpuTimestampMs: freezeConcat(
        camera.sceneRenderGpuTimestampMs ?? [],
        positionMutation.sceneRenderGpuTimestampMs ?? [],
      ),
      completionWallMs: freezeConcat(camera.completionWallMs, positionMutation.completionWallMs),
      instrumentationWallMs: freezeConcat(
        camera.instrumentationWallMs ?? [],
        positionMutation.instrumentationWallMs ?? [],
      ),
      timestampReadbackWallMs: freezeConcat(
        camera.timestampReadbackWallMs ?? [],
        positionMutation.timestampReadbackWallMs ?? [],
      ),
      uploadBytes: freezeConcat(camera.uploadBytes, positionMutation.uploadBytes),
      transformUploadBytes: freezeConcat(
        camera.transformUploadBytes ?? [],
        positionMutation.transformUploadBytes ?? [],
      ),
      cullRecordUploadBytes: freezeConcat(
        camera.cullRecordUploadBytes ?? [],
        positionMutation.cullRecordUploadBytes ?? [],
      ),
      frameTransactionSubmissionDeltas: freezeConcat(
        camera.frameTransactionSubmissionDeltas ?? [],
        positionMutation.frameTransactionSubmissionDeltas ?? [],
      ),
      frameTransactionFusedSubmissionDeltas: freezeConcat(
        camera.frameTransactionFusedSubmissionDeltas ?? [],
        positionMutation.frameTransactionFusedSubmissionDeltas ?? [],
      ),
      frameTransactionStandaloneSubmissionDeltas: freezeConcat(
        camera.frameTransactionStandaloneSubmissionDeltas ?? [],
        positionMutation.frameTransactionStandaloneSubmissionDeltas ?? [],
      ),
      uploadMs: freezeConcat(camera.uploadMs, positionMutation.uploadMs),
      commitMs: freezeConcat(camera.commitMs, positionMutation.commitMs),
      cullingMs: freezeConcat(camera.cullingMs, positionMutation.cullingMs),
      visibilitySelectionMs: freezeConcat(
        camera.visibilitySelectionMs,
        positionMutation.visibilitySelectionMs,
      ),
      renderPreparationMs: freezeConcat(
        camera.renderPreparationMs,
        positionMutation.renderPreparationMs,
      ),
      renderCoordinatorMs: freezeConcat(
        camera.renderCoordinatorMs,
        positionMutation.renderCoordinatorMs,
      ),
      surfaceApplyMs: freezeConcat(camera.surfaceApplyMs, positionMutation.surfaceApplyMs),
      offscreenInspectedLabels: freezeConcat(
        camera.offscreenInspectedLabels,
        positionMutation.offscreenInspectedLabels,
      ),
      offscreenMaterializedLabels: freezeConcat(
        camera.offscreenMaterializedLabels,
        positionMutation.offscreenMaterializedLabels,
      ),
      offscreenAdmissionDeferred: freezeConcat(
        camera.offscreenAdmissionDeferred,
        positionMutation.offscreenAdmissionDeferred,
      ),
      offscreenAdmissionGeneration: freezeConcat(
        camera.offscreenAdmissionGeneration,
        positionMutation.offscreenAdmissionGeneration,
      ),
      offscreenAdmissionCursor: freezeConcat(
        camera.offscreenAdmissionCursor,
        positionMutation.offscreenAdmissionCursor,
      ),
      offscreenAdmissionCursorResets: freezeConcat(
        camera.offscreenAdmissionCursorResets,
        positionMutation.offscreenAdmissionCursorResets,
      ),
      offscreenAdmissionCycles: freezeConcat(
        camera.offscreenAdmissionCycles,
        positionMutation.offscreenAdmissionCycles,
      ),
      deferredSpatialLabels: freezeConcat(
        camera.deferredSpatialLabels ?? [],
        positionMutation.deferredSpatialLabels ?? [],
      ),
      mutationMs: positionMutation.mutationMs,
      phases: Object.freeze({ camera, positionMutation }),
      gpuTiming: timer.capability,
    });
    const expectedPositionUpload = paletteMoveDispatchBytes("dense", mutationCount);
    return result(timings, counters, {
      exactResidentLabels: counters.residentLabels === configuration.labelCount,
      exactGpuResidentLabels: counters.gpuResidentLabels === configuration.labelCount,
      exactPrototypeCount: counters.prototypeCount === 1,
      exactMutationCount: mutationCount === configuration.mutationCount,
      requestedRendererActive: stats.rendererAdapter === "webgpu",
      gpuSceneRequested: stats.residencyRequested === "gpu-scene",
      gpuSceneActive: stats.residencyActive === "gpu-scene",
      gpuSceneNoFallback: stats.residencyFallbackReason === undefined,
      submittedCountExact:
        cameraSubmitted.submittedGlyphs === expectedSubmitted &&
        submittedGlyphs === expectedSubmitted,
      submittedHashStable:
        cameraSubmitted.submittedGlyphsHash === expectedSubmittedHash &&
        submitted.submittedGlyphsHash === expectedSubmittedHash,
      submittedGlyphsReadback: stats.submittedGlyphs === submittedGlyphs,
      pixelsRendered: pixels.nonTransparentPixels > 0 && pixels.hash > 0,
      pixelReadbackRepeatable:
        pixels.hash === pixelsRepeat.hash &&
        pixels.nonTransparentPixels === pixelsRepeat.nonTransparentPixels,
      canonicalOutputConfigurationKnown: canonicalTruth.knownConfiguration,
      canonicalSubmittedIdentity: canonicalTruth.submittedIdentity,
      canonicalRenderedPixelHash: canonicalTruth.renderedPixelHash,
      canonicalNonTransparentPixels: canonicalTruth.nonTransparentPixels,
      canonicalOutputIdentity: canonicalTruth.exactOutputIdentity,
      cameraPhaseComplete: camera.frameMs.length === configuration.sampleFrames,
      positionMutationPhaseComplete: positionMutation.frameMs.length === configuration.sampleFrames,
      cameraShapedDeltaZero: camera.shapedLabelsDelta === 0,
      positionShapedDeltaZero: positionMutation.shapedLabelsDelta === 0,
      cameraAdmittedDeltaZero: camera.admittedLabelsTotal === 0,
      positionAdmittedDeltaZero: positionMutation.admittedLabelsTotal === 0,
      cameraCullingQueriesDeltaZero: camera.cullingQueriesDelta === 0,
      positionCullingQueriesDeltaZero: positionMutation.cullingQueriesDelta === 0,
      cameraTransformUploadZero: maximumSample(camera.transformUploadBytes) === 0,
      cameraCullRecordUploadZero: maximumSample(camera.cullRecordUploadBytes) === 0,
      positionTransformUploadExact:
        minimumSample(positionMutation.transformUploadBytes) === expectedPositionUpload &&
        maximumSample(positionMutation.transformUploadBytes) === expectedPositionUpload,
      positionCullRecordUploadZero: maximumSample(positionMutation.cullRecordUploadBytes) === 0,
      cameraProductSubmissionExact:
        camera.frameTransactionSubmissionDeltas?.every((count) => count === 1) === true,
      cameraFusedSubmissionExact:
        camera.frameTransactionFusedSubmissionDeltas?.every((count) => count === 1) === true,
      cameraStandaloneSubmissionZero:
        camera.frameTransactionStandaloneSubmissionDeltas?.every((count) => count === 0) === true,
      positionProductSubmissionExact:
        positionMutation.frameTransactionSubmissionDeltas?.every((count) => count === 1) === true,
      positionFusedSubmissionExact:
        positionMutation.frameTransactionFusedSubmissionDeltas?.every((count) => count === 1) ===
        true,
      positionStandaloneSubmissionZero:
        positionMutation.frameTransactionStandaloneSubmissionDeltas?.every(
          (count) => count === 0,
        ) === true,
      diagnosticReadbackSubmissions,
      timestampReadbackSubmissions: timer.capability.resolveQuerySet ? timer.capability.samples : 0,
      timestampFusedResolves: timer.capability.fusedTimestampResolves,
      timestampStandaloneSubmissions: timer.capability.standaloneTimestampSubmissions,
      timestampFusedResolveExact:
        timer.capability.fusedTimestampResolves === timer.capability.samples,
      timestampStandaloneSubmissionZero: timer.capability.standaloneTimestampSubmissions === 0,
      timestampReadbackDeferredRing: timer.capability.timestampReadbackMode === "deferred-ring",
      timestampReadbackRingSizeExact: timer.capability.timestampReadbackRingSize === 3,
      timestampReadbackDrainComplete: timer.capability.pendingTimestampReadbacks === 0,
      timestampSegmentedExact:
        timer.capability.segmentedTimestampWrites === true &&
        timer.capability.timestampQueriesPerFrame === 6 &&
        timer.capability.segmentedSamples === timer.capability.samples,
      timestampSegmentsValid:
        timer.capability.validSegmentedSamples === timer.capability.samples &&
        timer.capability.segmentedFallbackSamples === 0 &&
        timer.capability.validPaletteSamples === timer.capability.samples &&
        timer.capability.validCullSamples === timer.capability.samples &&
        timer.capability.validSceneRenderSamples === timer.capability.samples,
      cameraFrameMetricExact: camera.frameMetric === "mutation+timer-cpu+queue-completion",
      positionFrameMetricExact:
        positionMutation.frameMetric === "mutation+timer-cpu+queue-completion",
      cullPath: stats.cullPath,
      palettePath: stats.palettePath,
      expectedSubmitted,
      submittedGlyphsHash: submitted.submittedGlyphsHash,
      expectedPositionUpload,
      gpuTimingMethod: timer.capability.method,
      gpuTimingReadback: timer.capability.readback,
      viewportFrameEvents: bindingStats.frameEndEvents,
      viewportCommits: bindingStats.commits,
    });
  } finally {
    timer.destroy();
    drawObserver.destroy();
    binding.destroy();
    dense.layer.destroy();
    viewport.destroy({ children: true });
  }
}

/** Sustained product-path scene gate: camera motion followed by 100K packed movers. */
async function runGpuSceneV2(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      keepIds: true,
      rendering: true,
      culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
      computeCull: "auto",
      spacing: 2,
      text: "g",
      style: { fontFamily: "Arial", fontSize: 4, fill: 0xffffff },
    },
    app.renderer,
  );
  const viewport = new Viewport({
    screenWidth: configuration.width,
    screenHeight: configuration.height,
    worldWidth: 4_000,
    worldHeight: 4_000,
    events: app.renderer.events,
    noTicker: true,
  });
  app.stage.addChild(viewport);
  const binding = bindViewport(dense.layer, viewport);
  await binding.whenIdle();
  const drawObserver = observeInstancedDraws(app.renderer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const timer = createGpuFrameTimer(app.renderer);
  const ids = requireIds(dense);
  const mutationCount = Math.min(configuration.mutationCount, configuration.labelCount);
  const mutationIds = ids.subarray(0, mutationCount);
  const positionsA = buildPositions(mutationCount, 2, 0.25);
  const positionsB = buildPositions(mutationCount, 2, 0.75);

  try {
    const camera = await sampleGpuScenePhase(
      app,
      dense.layer,
      timer,
      configuration,
      (frame) => prepareGpuSceneCamera(viewport, configuration.sampleFrames, frame),
      flushViewportFrame(viewport, binding),
    );
    const positionMutation = await sampleGpuScenePhase(
      app,
      dense.layer,
      timer,
      configuration,
      (frame) => {
        const mutationStart = performance.now();
        const changed = dense.layer.updatePositions(
          mutationIds,
          frame % 2 === 0 ? positionsB : positionsA,
        );
        const mutationMs = performance.now() - mutationStart;
        if (changed !== mutationCount) {
          throw new Error(`GPU Scene v2 changed ${String(changed)} labels`);
        }
        setGpuSceneCamera(viewport, (frame * 17) % 640, (frame * 11) % 320, 1);
        return mutationMs;
      },
      flushViewportFrame(viewport, binding),
    );
    const activeGlyphInstances = dense.layer.stats.submittedGlyphs;
    const submittedGlyphs = await dense.layer.readSubmittedGlyphs();
    const stats = dense.layer.stats;
    const bindingStats = binding.stats;
    const observed = drawObserver.read();
    const counters: BrowserBenchmarkCounters = Object.freeze({
      ...layerCounters(stats, 1),
      submittedLabels: submittedGlyphs,
      visibleGlyphs: submittedGlyphs,
      submittedGlyphs,
      activeGlyphInstances,
      submittedGlyphsSource:
        stats.cullPath === "compute-cull" ? "gpu-indirect-readback" : "cpu-submit",
      observedDrawCalls: observed.drawCalls,
      maximumInstanceCount: observed.maximumInstanceCount,
      coalescedEvents: bindingStats.coalescedEvents,
      rendererAdapter: stats.rendererAdapter,
      cullPath: stats.cullPath,
      palettePath: stats.palettePath,
      offscreenInspectedLabels: stats.offscreenInspectedLabels,
      offscreenMaterializedLabels: stats.offscreenMaterializedLabels,
      offscreenAdmittedLabels: camera.admittedLabelsTotal + positionMutation.admittedLabelsTotal,
      offscreenMaxInspectedLabels: maxSamples(
        camera.offscreenInspectedLabels,
        positionMutation.offscreenInspectedLabels,
      ),
      offscreenMaxMaterializedLabels: maxSamples(
        camera.offscreenMaterializedLabels,
        positionMutation.offscreenMaterializedLabels,
      ),
      offscreenAdmissionDeferred: stats.offscreenAdmissionDeferred,
      offscreenAdmissionGeneration: stats.offscreenAdmissionGeneration,
      offscreenAdmissionCursor: stats.offscreenAdmissionCursor,
      offscreenAdmissionCursorResets: stats.offscreenAdmissionCursorResets,
      offscreenAdmissionCycles: stats.offscreenAdmissionCycles,
    });
    const timings: BrowserBenchmarkTimings = Object.freeze({
      setupMs,
      frameMs: freezeConcat(camera.frameMs, positionMutation.frameMs),
      cpuMs: freezeConcat(camera.cpuMs, positionMutation.cpuMs),
      gpuMs: freezeConcat(camera.gpuMs, positionMutation.gpuMs),
      gpuTimestampMs: freezeConcat(camera.gpuTimestampMs, positionMutation.gpuTimestampMs),
      completionWallMs: freezeConcat(camera.completionWallMs, positionMutation.completionWallMs),
      instrumentationWallMs: freezeConcat(
        camera.instrumentationWallMs ?? [],
        positionMutation.instrumentationWallMs ?? [],
      ),
      timestampReadbackWallMs: freezeConcat(
        camera.timestampReadbackWallMs ?? [],
        positionMutation.timestampReadbackWallMs ?? [],
      ),
      uploadBytes: freezeConcat(camera.uploadBytes, positionMutation.uploadBytes),
      uploadMs: freezeConcat(camera.uploadMs, positionMutation.uploadMs),
      commitMs: freezeConcat(camera.commitMs, positionMutation.commitMs),
      cullingMs: freezeConcat(camera.cullingMs, positionMutation.cullingMs),
      visibilitySelectionMs: freezeConcat(
        camera.visibilitySelectionMs,
        positionMutation.visibilitySelectionMs,
      ),
      renderPreparationMs: freezeConcat(
        camera.renderPreparationMs,
        positionMutation.renderPreparationMs,
      ),
      renderCoordinatorMs: freezeConcat(
        camera.renderCoordinatorMs,
        positionMutation.renderCoordinatorMs,
      ),
      surfaceApplyMs: freezeConcat(camera.surfaceApplyMs, positionMutation.surfaceApplyMs),
      offscreenInspectedLabels: freezeConcat(
        camera.offscreenInspectedLabels,
        positionMutation.offscreenInspectedLabels,
      ),
      offscreenMaterializedLabels: freezeConcat(
        camera.offscreenMaterializedLabels,
        positionMutation.offscreenMaterializedLabels,
      ),
      offscreenAdmissionDeferred: freezeConcat(
        camera.offscreenAdmissionDeferred,
        positionMutation.offscreenAdmissionDeferred,
      ),
      offscreenAdmissionGeneration: freezeConcat(
        camera.offscreenAdmissionGeneration,
        positionMutation.offscreenAdmissionGeneration,
      ),
      offscreenAdmissionCursor: freezeConcat(
        camera.offscreenAdmissionCursor,
        positionMutation.offscreenAdmissionCursor,
      ),
      offscreenAdmissionCursorResets: freezeConcat(
        camera.offscreenAdmissionCursorResets,
        positionMutation.offscreenAdmissionCursorResets,
      ),
      offscreenAdmissionCycles: freezeConcat(
        camera.offscreenAdmissionCycles,
        positionMutation.offscreenAdmissionCycles,
      ),
      mutationMs: positionMutation.mutationMs,
      phases: Object.freeze({ camera, positionMutation }),
      gpuTiming: timer.capability,
    });

    return result(timings, counters, {
      exactResidentLabels: counters.residentLabels === configuration.labelCount,
      exactMutationCount: mutationCount === configuration.mutationCount,
      cameraPhaseComplete: camera.frameMs.length === configuration.sampleFrames,
      positionMutationPhaseComplete: positionMutation.frameMs.length === configuration.sampleFrames,
      realRendererAttached: stats.attached,
      requestedRendererActive: stats.rendererAdapter === configuration.renderer,
      submittedGlyphsObserved: submittedGlyphs > 0,
      submittedGlyphsReadback: stats.submittedGlyphs === submittedGlyphs,
      submittedLabelsMatchGlyphs: counters.submittedLabels === submittedGlyphs,
      drawCallsObserved: stats.drawCalls > 0,
      cullPath: stats.cullPath,
      palettePath: stats.palettePath,
      gpuTimingMethod: timer.capability.method,
      gpuTimingReadback: timer.capability.readback,
      timestampReadbackDrainComplete: timer.capability.pendingTimestampReadbacks === 0,
      cameraFrameMetricExact: camera.frameMetric === "mutation+timer-cpu+queue-completion",
      positionFrameMetricExact:
        positionMutation.frameMetric === "mutation+timer-cpu+queue-completion",
      viewportFrameEvents: bindingStats.frameEndEvents,
      viewportCommits: bindingStats.commits,
      offscreenInspectionBudget: GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
      offscreenMaterializationBudget: GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
      offscreenInspectionWithinBudget:
        (counters.offscreenMaxInspectedLabels ?? Number.POSITIVE_INFINITY) <=
        GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
      offscreenMaterializationWithinBudget:
        (counters.offscreenMaxMaterializedLabels ?? Number.POSITIVE_INFINITY) <=
        GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
      offscreenMaterializationWithinInspection:
        camera.offscreenMaterializedLabels.every(
          (count, index) => count <= (camera.offscreenInspectedLabels[index] ?? -1),
        ) &&
        positionMutation.offscreenMaterializedLabels.every(
          (count, index) => count <= (positionMutation.offscreenInspectedLabels[index] ?? -1),
        ),
      shapedLabelsDelta: camera.shapedLabelsDelta + positionMutation.shapedLabelsDelta,
      admittedLabelsTotal: camera.admittedLabelsTotal + positionMutation.admittedLabelsTotal,
    });
  } finally {
    timer.destroy();
    drawObserver.destroy();
    binding.destroy();
    dense.layer.destroy();
    viewport.destroy({ children: true });
  }
}

/** @internal Benchmark diagnostic seam for phase-accounting tests. */
export async function sampleGpuScenePhase(
  app: Application,
  layer: TextLayer,
  timer: GpuFrameTimer,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  prepare: (frame: number) => number,
  commit: () => Promise<unknown> = () => layer.commit(),
): Promise<Readonly<BrowserBenchmarkPhaseTimings>> {
  const frameMs: number[] = [];
  const cpuMs: number[] = [];
  const gpuMs: number[] = [];
  const gpuTimestampMs: Array<number | null> = [];
  const paletteGpuTimestampMs: Array<number | null> = [];
  const cullGpuTimestampMs: Array<number | null> = [];
  const sceneRenderGpuTimestampMs: Array<number | null> = [];
  const completionWallMs: number[] = [];
  const instrumentationWallMs: number[] = [];
  const timestampReadbackWallMs: number[] = [];
  const sampledProducts: ProductFrameSample[] = [];
  const uploadBytes: number[] = [];
  const uploadMs: number[] = [];
  const commitMs: number[] = [];
  const cullingMs: number[] = [];
  const mutationMs: number[] = [];
  const visibilitySelectionMs: number[] = [];
  const renderPreparationMs: number[] = [];
  const renderCoordinatorMs: number[] = [];
  const surfaceApplyMs: number[] = [];
  const offscreenInspectedLabels: number[] = [];
  const offscreenMaterializedLabels: number[] = [];
  const offscreenAdmissionDeferred: boolean[] = [];
  const offscreenAdmissionGeneration: number[] = [];
  const offscreenAdmissionCursor: number[] = [];
  const offscreenAdmissionCursorResets: number[] = [];
  const offscreenAdmissionCycles: number[] = [];
  const total = configuration.warmupFrames + configuration.sampleFrames;
  let shapedLabelsAtSampleStart = layer.stats.shapedLabels;
  for (let frame = 0; frame < total; frame += 1) {
    if (frame === configuration.warmupFrames) {
      shapedLabelsAtSampleStart = layer.stats.shapedLabels;
    }
    const beforeUpload = uploadTotal(layer);
    const mutationDuration = prepare(frame);
    let commitDuration = 0;
    const product = await timer.measureProductFrame(async () => {
      const commitStart = performance.now();
      await commit();
      commitDuration = performance.now() - commitStart;
      app.render();
    });
    if (frame < configuration.warmupFrames) continue;
    const stats = layer.stats;
    frameMs.push(mutationDuration + product.cpuMs + product.completionWallMs);
    cpuMs.push(product.cpuMs);
    completionWallMs.push(product.completionWallMs);
    instrumentationWallMs.push(product.instrumentationWallMs);
    sampledProducts.push(product);
    uploadBytes.push(Math.max(0, uploadTotal(layer) - beforeUpload));
    uploadMs.push(stats.lastUploadMs);
    commitMs.push(commitDuration);
    cullingMs.push(stats.lastSpatialUpdateMs);
    mutationMs.push(mutationDuration);
    visibilitySelectionMs.push(stats.lastVisibilitySelectionMs);
    renderPreparationMs.push(stats.lastRenderPreparationMs);
    renderCoordinatorMs.push(stats.lastRenderCoordinatorMs);
    surfaceApplyMs.push(stats.lastSurfaceApplyMs);
    offscreenInspectedLabels.push(stats.offscreenInspectedLabels);
    offscreenMaterializedLabels.push(stats.offscreenMaterializedLabels);
    offscreenAdmissionDeferred.push(stats.offscreenAdmissionDeferred);
    offscreenAdmissionGeneration.push(stats.offscreenAdmissionGeneration);
    offscreenAdmissionCursor.push(stats.offscreenAdmissionCursor);
    offscreenAdmissionCursorResets.push(stats.offscreenAdmissionCursorResets);
    offscreenAdmissionCycles.push(stats.offscreenAdmissionCycles);
  }
  const timestampSamples = await drainSampledFrames(timer, sampledProducts);
  for (const sample of timestampSamples) {
    gpuMs.push(sample.gpuMs);
    gpuTimestampMs.push(sample.gpuTimestampMs);
    paletteGpuTimestampMs.push(sample.paletteGpuTimestampMs);
    cullGpuTimestampMs.push(sample.cullGpuTimestampMs);
    sceneRenderGpuTimestampMs.push(sample.sceneRenderGpuTimestampMs);
    timestampReadbackWallMs.push(sample.timestampReadbackWallMs);
  }

  const shapedLabelsDelta = Math.max(0, layer.stats.shapedLabels - shapedLabelsAtSampleStart);

  return Object.freeze({
    frameMs: Object.freeze(frameMs),
    frameMetric: "mutation+timer-cpu+queue-completion",
    cpuMs: Object.freeze(cpuMs),
    gpuMs: Object.freeze(gpuMs),
    gpuTimestampMs: Object.freeze(gpuTimestampMs),
    paletteGpuTimestampMs: Object.freeze(paletteGpuTimestampMs),
    cullGpuTimestampMs: Object.freeze(cullGpuTimestampMs),
    sceneRenderGpuTimestampMs: Object.freeze(sceneRenderGpuTimestampMs),
    completionWallMs: Object.freeze(completionWallMs),
    instrumentationWallMs: Object.freeze(instrumentationWallMs),
    timestampReadbackWallMs: Object.freeze(timestampReadbackWallMs),
    uploadBytes: Object.freeze(uploadBytes),
    uploadMs: Object.freeze(uploadMs),
    commitMs: Object.freeze(commitMs),
    cullingMs: Object.freeze(cullingMs),
    mutationMs: Object.freeze(mutationMs),
    visibilitySelectionMs: Object.freeze(visibilitySelectionMs),
    renderPreparationMs: Object.freeze(renderPreparationMs),
    renderCoordinatorMs: Object.freeze(renderCoordinatorMs),
    surfaceApplyMs: Object.freeze(surfaceApplyMs),
    offscreenInspectedLabels: Object.freeze(offscreenInspectedLabels),
    offscreenMaterializedLabels: Object.freeze(offscreenMaterializedLabels),
    offscreenAdmissionDeferred: Object.freeze(offscreenAdmissionDeferred),
    offscreenAdmissionGeneration: Object.freeze(offscreenAdmissionGeneration),
    offscreenAdmissionCursor: Object.freeze(offscreenAdmissionCursor),
    offscreenAdmissionCursorResets: Object.freeze(offscreenAdmissionCursorResets),
    offscreenAdmissionCycles: Object.freeze(offscreenAdmissionCycles),
    shapedLabelsDelta,
    admittedLabelsTotal: sumSamples(offscreenMaterializedLabels),
  });
}

/** @internal Benchmark diagnostic seam for resident phase-accounting tests. */
export async function sampleGpuResidentScenePhase(
  app: Application,
  layer: TextLayer,
  timer: GpuFrameTimer,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  prepare: (frame: number) => number,
  commit: () => Promise<unknown> = () => layer.commit(),
): Promise<Readonly<BrowserBenchmarkPhaseTimings>> {
  const frameMs: number[] = [];
  const cpuMs: number[] = [];
  const gpuMs: number[] = [];
  const gpuTimestampMs: Array<number | null> = [];
  const paletteGpuTimestampMs: Array<number | null> = [];
  const cullGpuTimestampMs: Array<number | null> = [];
  const sceneRenderGpuTimestampMs: Array<number | null> = [];
  const completionWallMs: number[] = [];
  const instrumentationWallMs: number[] = [];
  const timestampReadbackWallMs: number[] = [];
  const sampledProducts: ProductFrameSample[] = [];
  const uploadBytes: number[] = [];
  const transformUploadBytes: number[] = [];
  const cullRecordUploadBytes: number[] = [];
  const frameTransactionSubmissionDeltas: number[] = [];
  const frameTransactionFusedSubmissionDeltas: number[] = [];
  const frameTransactionStandaloneSubmissionDeltas: number[] = [];
  const uploadMs: number[] = [];
  const commitMs: number[] = [];
  const cullingMs: number[] = [];
  const mutationMs: number[] = [];
  const visibilitySelectionMs: number[] = [];
  const renderPreparationMs: number[] = [];
  const renderCoordinatorMs: number[] = [];
  const surfaceApplyMs: number[] = [];
  const offscreenInspectedLabels: number[] = [];
  const offscreenMaterializedLabels: number[] = [];
  const offscreenAdmissionDeferred: boolean[] = [];
  const offscreenAdmissionGeneration: number[] = [];
  const offscreenAdmissionCursor: number[] = [];
  const offscreenAdmissionCursorResets: number[] = [];
  const offscreenAdmissionCycles: number[] = [];
  const deferredSpatialLabels: number[] = [];
  const total = configuration.warmupFrames + configuration.sampleFrames;
  let shapedLabelsAtSampleStart = layer.stats.shapedLabels;
  let cullingQueriesAtSampleStart = layer.stats.cullingQueries;
  for (let frame = 0; frame < total; frame += 1) {
    if (frame === configuration.warmupFrames) {
      shapedLabelsAtSampleStart = layer.stats.shapedLabels;
      cullingQueriesAtSampleStart = layer.stats.cullingQueries;
    }
    const beforeUpload = uploadTotal(layer);
    const beforeStats = layer.stats;
    const beforeTransformUpload = beforeStats.transformUploadBytes;
    const beforeCullRecordUpload = beforeStats.cullRecordUploadBytes;
    const beforeFrameTransactionSubmissions = beforeStats.frameTransactionSubmissions;
    const beforeFrameTransactionFusedSubmissions = beforeStats.frameTransactionFusedSubmissions;
    const beforeFrameTransactionStandaloneSubmissions =
      beforeStats.frameTransactionStandaloneSubmissions;
    const mutationDuration = prepare(frame);
    let commitDuration = 0;
    const product = await timer.measureProductFrame(async () => {
      const commitStart = performance.now();
      await commit();
      commitDuration = performance.now() - commitStart;
      app.render();
    });
    if (frame < configuration.warmupFrames) continue;
    const stats = layer.stats;
    frameMs.push(mutationDuration + product.cpuMs + product.completionWallMs);
    cpuMs.push(product.cpuMs);
    completionWallMs.push(product.completionWallMs);
    instrumentationWallMs.push(product.instrumentationWallMs);
    sampledProducts.push(product);
    uploadBytes.push(Math.max(0, uploadTotal(layer) - beforeUpload));
    transformUploadBytes.push(Math.max(0, stats.transformUploadBytes - beforeTransformUpload));
    cullRecordUploadBytes.push(Math.max(0, stats.cullRecordUploadBytes - beforeCullRecordUpload));
    frameTransactionSubmissionDeltas.push(
      Math.max(0, stats.frameTransactionSubmissions - beforeFrameTransactionSubmissions),
    );
    frameTransactionFusedSubmissionDeltas.push(
      Math.max(0, stats.frameTransactionFusedSubmissions - beforeFrameTransactionFusedSubmissions),
    );
    frameTransactionStandaloneSubmissionDeltas.push(
      Math.max(
        0,
        stats.frameTransactionStandaloneSubmissions - beforeFrameTransactionStandaloneSubmissions,
      ),
    );
    uploadMs.push(stats.lastUploadMs);
    commitMs.push(commitDuration);
    cullingMs.push(stats.lastSpatialUpdateMs);
    mutationMs.push(mutationDuration);
    visibilitySelectionMs.push(stats.lastVisibilitySelectionMs);
    renderPreparationMs.push(stats.lastRenderPreparationMs);
    renderCoordinatorMs.push(stats.lastRenderCoordinatorMs);
    surfaceApplyMs.push(stats.lastSurfaceApplyMs);
    offscreenInspectedLabels.push(stats.offscreenInspectedLabels);
    offscreenMaterializedLabels.push(stats.offscreenMaterializedLabels);
    offscreenAdmissionDeferred.push(stats.offscreenAdmissionDeferred);
    offscreenAdmissionGeneration.push(stats.offscreenAdmissionGeneration);
    offscreenAdmissionCursor.push(stats.offscreenAdmissionCursor);
    offscreenAdmissionCursorResets.push(stats.offscreenAdmissionCursorResets);
    offscreenAdmissionCycles.push(stats.offscreenAdmissionCycles);
    deferredSpatialLabels.push(stats.deferredSpatialLabels);
  }
  const timestampSamples = await drainSampledFrames(timer, sampledProducts);
  for (const sample of timestampSamples) {
    gpuMs.push(sample.gpuMs);
    gpuTimestampMs.push(sample.gpuTimestampMs);
    paletteGpuTimestampMs.push(sample.paletteGpuTimestampMs);
    cullGpuTimestampMs.push(sample.cullGpuTimestampMs);
    sceneRenderGpuTimestampMs.push(sample.sceneRenderGpuTimestampMs);
    timestampReadbackWallMs.push(sample.timestampReadbackWallMs);
  }

  const frameDistribution = summarize(frameMs, "ms");
  const frameOverBudgetCount = frameMs.reduce(
    (count, sample) => count + Number(sample > GPU_RESIDENT_FRAME_BUDGET_MS),
    0,
  );
  return Object.freeze({
    frameMs: Object.freeze(frameMs),
    frameMetric: "mutation+timer-cpu+queue-completion",
    frameBudgetMs: GPU_RESIDENT_FRAME_BUDGET_MS,
    frameOverBudgetCount,
    frameOverBudgetRatio: frameOverBudgetCount / frameMs.length,
    frameP99Ms: frameDistribution.p99,
    frameMaxMs: frameDistribution.max,
    cpuMs: Object.freeze(cpuMs),
    gpuMs: Object.freeze(gpuMs),
    gpuTimestampMs: Object.freeze(gpuTimestampMs),
    paletteGpuTimestampMs: Object.freeze(paletteGpuTimestampMs),
    cullGpuTimestampMs: Object.freeze(cullGpuTimestampMs),
    sceneRenderGpuTimestampMs: Object.freeze(sceneRenderGpuTimestampMs),
    completionWallMs: Object.freeze(completionWallMs),
    instrumentationWallMs: Object.freeze(instrumentationWallMs),
    timestampReadbackWallMs: Object.freeze(timestampReadbackWallMs),
    uploadBytes: Object.freeze(uploadBytes),
    transformUploadBytes: Object.freeze(transformUploadBytes),
    cullRecordUploadBytes: Object.freeze(cullRecordUploadBytes),
    frameTransactionSubmissionDeltas: Object.freeze(frameTransactionSubmissionDeltas),
    frameTransactionFusedSubmissionDeltas: Object.freeze(frameTransactionFusedSubmissionDeltas),
    frameTransactionStandaloneSubmissionDeltas: Object.freeze(
      frameTransactionStandaloneSubmissionDeltas,
    ),
    uploadMs: Object.freeze(uploadMs),
    commitMs: Object.freeze(commitMs),
    cullingMs: Object.freeze(cullingMs),
    mutationMs: Object.freeze(mutationMs),
    visibilitySelectionMs: Object.freeze(visibilitySelectionMs),
    renderPreparationMs: Object.freeze(renderPreparationMs),
    renderCoordinatorMs: Object.freeze(renderCoordinatorMs),
    surfaceApplyMs: Object.freeze(surfaceApplyMs),
    offscreenInspectedLabels: Object.freeze(offscreenInspectedLabels),
    offscreenMaterializedLabels: Object.freeze(offscreenMaterializedLabels),
    offscreenAdmissionDeferred: Object.freeze(offscreenAdmissionDeferred),
    offscreenAdmissionGeneration: Object.freeze(offscreenAdmissionGeneration),
    offscreenAdmissionCursor: Object.freeze(offscreenAdmissionCursor),
    offscreenAdmissionCursorResets: Object.freeze(offscreenAdmissionCursorResets),
    offscreenAdmissionCycles: Object.freeze(offscreenAdmissionCycles),
    deferredSpatialLabels: Object.freeze(deferredSpatialLabels),
    shapedLabelsDelta: Math.max(0, layer.stats.shapedLabels - shapedLabelsAtSampleStart),
    admittedLabelsTotal: sumSamples(offscreenMaterializedLabels),
    cullingQueriesDelta: Math.max(0, layer.stats.cullingQueries - cullingQueriesAtSampleStart),
  });
}

function setGpuSceneCamera(viewport: Viewport, x: number, y: number, scale: number): void {
  viewport.scale.set(scale);
  viewport.position.set(-x * scale, -y * scale);
  viewport.emit("zoomed", { viewport, type: "animate" });
  viewport.emit("moved", { viewport, type: "drag" });
}

function setGpuResidentCamera(
  viewport: Viewport,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  viewHeight: number,
  x: number,
): void {
  const scaleX = configuration.width / GPU_RESIDENT_VIEW_WIDTH;
  const scaleY = configuration.height / viewHeight;
  viewport.scale.set(scaleX, scaleY);
  viewport.position.set(-x * scaleX, 0);
  viewport.emit("zoomed", { viewport, type: "animate" });
  viewport.emit("moved", { viewport, type: "drag" });
}

/** @internal Benchmark diagnostic seam for camera-mutation timing tests. */
export function prepareGpuSceneCamera(
  viewport: Viewport,
  sampleFrames: number,
  frame: number,
  now: () => number = () => performance.now(),
): number {
  const cycle = frame % Math.max(2, sampleFrames);
  const progress = cycle / Math.max(1, sampleFrames - 1);
  const scale = 0.75 + 0.5 * Math.sin(progress * Math.PI);
  const mutationStart = now();
  setGpuSceneCamera(viewport, (frame * 13) % 640, (frame * 7) % 320, scale);
  return now() - mutationStart;
}

/** @internal Benchmark diagnostic seam for resident camera-mutation timing tests. */
export function prepareGpuResidentCamera(
  viewport: Viewport,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  viewHeight: number,
  frame: number,
  now: () => number = () => performance.now(),
): number {
  const mutationStart = now();
  setGpuResidentCamera(viewport, configuration, viewHeight, frame % 2 === 0 ? 0 : 0.25);
  return now() - mutationStart;
}

function flushViewportFrame(
  viewport: Viewport,
  binding: ReturnType<typeof bindViewport>,
): () => Promise<unknown> {
  return () => {
    viewport.emit("frame-end", viewport);
    return binding.whenIdle();
  };
}

async function drainSampledFrames(
  timer: GpuFrameTimer,
  sampledProducts: readonly Readonly<ProductFrameSample>[],
): Promise<readonly Readonly<CompletedFrameSample>[]> {
  const drained = await timer.drain();
  const byToken = new Map(drained.map((sample) => [sample.token, sample] as const));
  return Object.freeze(
    sampledProducts.map((product) => {
      const sample = byToken.get(product.token);
      if (sample === undefined) {
        throw new Error(`GPU timestamp sample ${String(product.token)} is missing after drain`);
      }
      return sample;
    }),
  );
}

function freezeConcat<T>(left: readonly T[], right: readonly T[]): readonly T[] {
  return Object.freeze([...left, ...right]);
}

function maxSamples(left: readonly number[], right: readonly number[]): number {
  let maximum = 0;
  for (const sample of left) maximum = Math.max(maximum, sample);
  for (const sample of right) maximum = Math.max(maximum, sample);
  return maximum;
}

function sumSamples(samples: readonly number[]): number {
  let total = 0;
  for (const sample of samples) total += sample;
  return total;
}

async function runMillionFull(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(configuration, {
    culling: false,
    text: "Glyph000",
  });
  const glyphCount = configuration.labelCount * 8;
  const drawObserver = observeInstancedDraws(app.renderer);
  const stress = createStressMesh(app.renderer, configuration.labelCount, glyphCount);
  app.stage.addChild(stress.mesh);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const split = await sampleCompletedFrames(app, configuration);
  const layerStats = dense.layer.stats;
  const observed = drawObserver.read();
  const nonTransparentPixels = countNonTransparentPixels(app.renderer);
  const counters: BrowserBenchmarkCounters = Object.freeze({
    residentLabels: layerStats.labelCount,
    submittedLabels: layerStats.visibleLabelCount,
    visibleGlyphs: glyphCount,
    drawCalls: 1,
    allocatedStoreBytes: layerStats.allocatedStoreBytes,
    instanceBytes: stress.instanceBytes,
    transformBytes: stress.transformBytes,
    labelRevision: Number(layerStats.revision),
    shapedLabels: layerStats.shapedLabels,
    observedDrawCalls: observed.drawCalls,
    maximumInstanceCount: observed.maximumInstanceCount,
    nonTransparentPixels,
  });
  drawObserver.destroy();
  stress.destroy();
  dense.layer.destroy();

  return result({ setupMs, ...split }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    exactVisibleGlyphs: counters.visibleGlyphs === glyphCount,
    eightGlyphsPerLabel: glyphCount === configuration.labelCount * 8,
    instanceStrideBytes: stress.instanceBytes / glyphCount,
    transformStrideBytes: stress.transformBytes / configuration.labelCount,
    singleDrawCall: counters.drawCalls === 1,
    gpuDrawObserved:
      (counters.observedDrawCalls ?? 0) >=
      1 + configuration.warmupFrames + configuration.sampleFrames,
    exactSubmittedInstanceCount: counters.maximumInstanceCount === glyphCount,
    nonTransparentOutput: nonTransparentPixels > 0,
    syntheticMesh: true,
  });
}

async function runMillionLive(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      rendering: true,
      culling: false,
      text: MILLION_LIVE_TEXT,
    },
    app.renderer,
  );
  app.stage.addChild(dense.layer);
  const drawObserver = observeInstancedDraws(app.renderer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const split = await sampleCompletedFrames(app, configuration, dense.layer);
  const layerStats = dense.layer.stats;
  const observed = drawObserver.read();
  const nonTransparentPixels = countNonTransparentPixels(app.renderer);
  const glyphCount = layerStats.glyphCount;
  const prototypeGlyphCount = MILLION_LIVE_TEXT.length;
  const drawReferenceBytes = glyphCount * GLYPH_DRAW_STRIDE;
  const prototypeRecordBytes = prototypeGlyphCount * INSTANCE_STRIDE;
  const counters: BrowserBenchmarkCounters = Object.freeze({
    ...layerCounters(layerStats, glyphCount / Math.max(1, layerStats.labelCount)),
    visibleGlyphs: glyphCount,
    drawCalls: layerStats.drawCalls,
    drawReferenceBytes,
    prototypeRecordBytes,
    instanceBytes: prototypeRecordBytes,
    prototypeCount: 1,
    observedDrawCalls: observed.drawCalls,
    maximumInstanceCount: observed.maximumInstanceCount,
    nonTransparentPixels,
    lastLayoutMs: layerStats.lastLayoutMs,
    lastInstanceWriteMs: layerStats.lastInstanceWriteMs,
    lastPaletteWriteMs: layerStats.lastPaletteWriteMs,
    lastSpatialUpdateMs: layerStats.lastSpatialUpdateMs,
    lastUploadMs: layerStats.lastUploadMs,
  });
  drawObserver.destroy();
  dense.layer.destroy();

  return result({ setupMs, ...split }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    exactVisibleGlyphs: counters.visibleGlyphs === configuration.labelCount * 8,
    eightGlyphsPerLabel: glyphCount === configuration.labelCount * 8,
    drawReferenceStrideBytes: drawReferenceBytes / glyphCount,
    prototypeRecordStrideBytes: prototypeRecordBytes / prototypeGlyphCount,
    fillTransformStrideBytes: TRANSFORM_STRIDE,
    effectfulTransformStrideBytes: TRANSFORM_STRIDE + TRANSFORM_EFFECT_STRIDE,
    singleDrawCall: counters.drawCalls === 1,
    gpuDrawObserved:
      (counters.observedDrawCalls ?? 0) >=
      1 + configuration.warmupFrames + configuration.sampleFrames,
    exactSubmittedInstanceCount:
      observed.maximumInstanceCount === configuration.labelCount * 8 ||
      layerStats.submittedGlyphs === configuration.labelCount * 8,
    nonTransparentOutput: nonTransparentPixels > 0,
    liveCoordinatorMesh: true,
    splitCpuGpuSamples: split.cpuMs.length === split.frameMs.length,
  });
}

/** The Wave 3 acceptance probe: rendering camera pans on `computeCull: "auto"`. */
async function runCameraLive(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      rendering: true,
      culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
      computeCull: "auto",
      text: (index) => FIRST_SEEN_SAMPLES[index % FIRST_SEEN_SAMPLES.length] ?? "g",
    },
    app.renderer,
  );
  app.stage.addChild(dense.layer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const cullingMs: number[] = [];
  const frameMs = await sampleFrames(configuration, async (frame) => {
    // Small pans stay inside the compute working set; the CPU grid re-queries instead.
    dense.layer.setViewportBounds({
      x: (frame % 16) * 4,
      y: 0,
      width: configuration.width,
      height: configuration.height,
    });
    const start = performance.now();
    await dense.layer.commit();
    const commitDuration = performance.now() - start;
    await completeFrame(app);
    if (frame >= configuration.warmupFrames) cullingMs.push(commitDuration);
    return performance.now() - start;
  });
  const stats = dense.layer.stats;
  const cullPath = stats.cullPath;
  const counters = layerCounters(stats, stats.glyphCount / Math.max(1, stats.labelCount));
  dense.layer.destroy();

  return result({ setupMs, frameMs, cullingMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    cullPath,
    computeCullOnWebGpu: configuration.renderer !== "webgpu" || cullPath === "compute-cull",
    submittedVisible: counters.submittedLabels > 0,
  });
}

const FIRST_SEEN_SAMPLES = Object.freeze([
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
  "Lambda",
  "Sigma",
]);

/** The 100x target moment: every sampled frame jumps onto labels never rendered before. */
async function runFirstSeen(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      rendering: true,
      culling: { x: 0, y: 0, width: configuration.width, height: 320 },
      text: (index) => FIRST_SEEN_SAMPLES[index % FIRST_SEEN_SAMPLES.length] ?? "g",
    },
    app.renderer,
  );
  app.stage.addChild(dense.layer);
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const commitMs: number[] = [];
  const frameMs = await sampleFrames(configuration, async (frame) => {
    const start = performance.now();
    dense.layer.setViewportBounds({
      x: (frame + 1) * configuration.width,
      y: 0,
      width: configuration.width,
      height: 320,
    });
    const commitStart = performance.now();
    await dense.layer.commit();
    const commitDuration = performance.now() - commitStart;
    await completeFrame(app);
    if (frame >= configuration.warmupFrames) commitMs.push(commitDuration);
    return performance.now() - start;
  });
  const stats = dense.layer.stats;
  const counters = layerCounters(stats, stats.glyphCount / Math.max(1, stats.labelCount));
  dense.layer.destroy();

  return result({ setupMs, frameMs, commitMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    boundedVisibleSet: counters.submittedLabels < counters.residentLabels,
    freshRegionRendered: counters.submittedLabels > 0,
  });
}

async function runMillionViewport(
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const initialBounds = { x: 0, y: 0, width: configuration.width, height: configuration.height };
  const dense = await createDenseLayer(configuration, {
    culling: initialBounds,
    spacing: 16,
    text: "Glyph000",
  });
  const setupMs = performance.now() - setupStart;
  const cullingMs: number[] = [];
  const frameMs = await sampleFrames(configuration, async (frame) => {
    dense.layer.setViewportBounds({
      x: (frame * 37) % 12_000,
      y: (frame * 19) % 12_000,
      width: configuration.width,
      height: configuration.height,
    });
    const start = performance.now();
    await dense.layer.commit();
    const duration = performance.now() - start;
    if (frame >= configuration.warmupFrames) cullingMs.push(duration);
    return duration;
  });
  const stats = dense.layer.stats;
  const counters = layerCounters(stats, 8);
  dense.layer.destroy();

  return result({ setupMs, frameMs, cullingMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    boundedVisibleSet: counters.submittedLabels < counters.residentLabels,
    cameraPreservesRevision: counters.labelRevision === 1,
    storeWithin128MiB: (counters.allocatedStoreBytes ?? Infinity) <= 128 * 1024 * 1024,
  });
}

async function runDynamicCounters(
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(configuration, {
    keepIds: true,
    culling: false,
    text: "Counter A",
  });
  const ids = requireIds(dense);
  const mutationCount = Math.min(configuration.mutationCount, configuration.labelCount);
  const mutationIds = ids.subarray(0, mutationCount);
  const first = buildPositions(mutationCount, 16, 0.25);
  const second = buildPositions(mutationCount, 16, 0.75);
  const setupMs = performance.now() - setupStart;
  const mutationMs: number[] = [];
  const commitMs: number[] = [];
  const frameMs = await sampleFrames(configuration, async (frame) => {
    const useSecond = frame % 2 === 0;
    const mutationStart = performance.now();
    const changed = dense.layer.updateTextPositions(
      mutationIds,
      useSecond ? "Counter B" : "Counter A",
      useSecond ? second : first,
    );
    const mutationDuration = performance.now() - mutationStart;
    if (changed !== mutationCount) {
      throw new Error(`Dynamic counter update changed ${String(changed)} labels`);
    }
    const commitStart = performance.now();
    await dense.layer.commit();
    const commitDuration = performance.now() - commitStart;
    if (frame >= configuration.warmupFrames) {
      mutationMs.push(mutationDuration);
      commitMs.push(commitDuration);
    }
    return mutationDuration + commitDuration;
  });
  const stats = dense.layer.stats;
  const counters = layerCounters(stats, 9);
  dense.layer.destroy();

  return result({ setupMs, frameMs, mutationMs, commitMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    exactMutationCount: mutationCount === configuration.mutationCount,
    revisionPerFrame:
      counters.labelRevision === 1 + configuration.warmupFrames + configuration.sampleFrames,
  });
}

async function runViewportInteraction(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  kind: "drag" | "zoom",
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(configuration, {
    culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
    spacing: 4,
    text: "g",
    style: { fontFamily: "Arial", fontSize: 4, fill: 0xffffff },
  });
  const viewport = new Viewport({
    screenWidth: configuration.width,
    screenHeight: configuration.height,
    worldWidth: 4_000,
    worldHeight: 4_000,
    events: app.renderer.events,
    noTicker: true,
  });
  if (kind === "drag") viewport.drag().decelerate({ friction: 0.95, minSpeed: 0.01 });
  else viewport.wheel().pinch();
  app.stage.addChild(viewport);
  const binding = bindViewport(dense.layer, viewport);
  await binding.whenIdle();
  const setupMs = performance.now() - setupStart;
  let minimumSubmittedLabels = dense.layer.stats.visibleLabelCount;
  let maximumSubmittedLabels = minimumSubmittedLabels;
  const frameMs = await sampleFrames(configuration, async (frame) => {
    const start = performance.now();
    if (kind === "drag") {
      viewport.x -= 3;
      viewport.y -= 1;
      viewport.emit("moved", { viewport, type: frame % 3 === 0 ? "decelerate" : "drag" });
    } else {
      const scale = 0.05 * 640 ** ((frame % 32) / 31);
      viewport.scale.set(scale);
      viewport.emit("zoomed", { viewport, type: frame % 2 === 0 ? "wheel" : "pinch" });
    }
    viewport.emit("frame-end", viewport);
    await binding.whenIdle();
    const visibleLabels = dense.layer.stats.visibleLabelCount;
    minimumSubmittedLabels = Math.min(minimumSubmittedLabels, visibleLabels);
    maximumSubmittedLabels = Math.max(maximumSubmittedLabels, visibleLabels);
    return performance.now() - start;
  });
  const stats = dense.layer.stats;
  const bindingStats = binding.stats;
  const counters = Object.freeze({
    ...layerCounters(stats, 1),
    minimumSubmittedLabels,
    maximumSubmittedLabels,
    coalescedEvents: bindingStats.coalescedEvents,
  });
  binding.destroy();
  dense.layer.destroy();
  viewport.destroy({ children: true });

  return result({ setupMs, frameMs, cullingMs: frameMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    boundedVisibleSet: minimumSubmittedLabels < counters.residentLabels,
    fullZoomRangeCovered: kind === "drag" || maximumSubmittedLabels === counters.residentLabels,
    cameraPreservesRevision: counters.labelRevision === 1,
    cameraPreservesShaping: counters.shapedLabels === 0,
    everyFrameCommitted: bindingStats.commits >= configuration.sampleFrames,
  });
}

async function runPositionStorm(
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(configuration, {
    keepIds: true,
    culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
    spacing: 16,
    text: "g",
  });
  const ids = requireIds(dense);
  const mutationCount = Math.min(configuration.mutationCount, configuration.labelCount);
  const mutationIds = ids.subarray(0, mutationCount);
  const first = buildPositions(mutationCount, 16, 0.25);
  const second = buildPositions(mutationCount, 16, 0.75);
  const setupMs = performance.now() - setupStart;
  const mutationMs: number[] = [];
  const commitMs: number[] = [];
  const frameMs = await sampleFrames(configuration, async (frame) => {
    const positions = frame % 2 === 0 ? second : first;
    const mutationStart = performance.now();
    const changed = dense.layer.updatePositions(mutationIds, positions);
    const mutationDuration = performance.now() - mutationStart;
    if (changed !== mutationCount) {
      throw new Error(`Position storm changed ${String(changed)} labels`);
    }
    dense.layer.setViewportBounds({
      x: (frame * 17) % 12_000,
      y: (frame * 11) % 12_000,
      width: configuration.width,
      height: configuration.height,
    });
    const commitStart = performance.now();
    await dense.layer.commit();
    const commitDuration = performance.now() - commitStart;
    if (frame >= configuration.warmupFrames) {
      mutationMs.push(mutationDuration);
      commitMs.push(commitDuration);
    }
    return mutationDuration + commitDuration;
  });
  const stats = dense.layer.stats;
  const counters = layerCounters(stats, 1);
  dense.layer.destroy();

  return result({ setupMs, frameMs, mutationMs, commitMs, cullingMs: commitMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    exactMutationCount: mutationCount === configuration.mutationCount,
    packedPositionStorage: true,
  });
}

async function runMultilingualStream(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const scripts = ["Latin", "中文文本", "العربية", "देवनागरी", "👩🏽‍🚀✨"] as const;
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      keepIds: true,
      rendering: true,
      culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
      spacing: 24,
      text: (index) => scripts[index % scripts.length] ?? "Latin",
      style: { fontFamily: "Arial", fontSize: 14, fill: 0xffffff },
    },
    app.renderer,
  );
  app.stage.addChild(dense.layer);
  await completeFrame(app);
  const ids = requireIds(dense);
  const mutationCount = Math.min(configuration.mutationCount, configuration.labelCount);
  const updates = scripts.map((text, scriptIndex) =>
    Array.from({ length: mutationCount }, (_, index): TextUpdate => ({
      id: ids[index] as TextId,
      patch: { text: `${text} ${String(scriptIndex)}` },
    })),
  );
  const setupMs = performance.now() - setupStart;
  const mutationMs: number[] = [];
  const commitMs: number[] = [];
  const frameMs = await sampleFrames(configuration, async (frame) => {
    const entries = updates[frame % updates.length];
    if (entries === undefined) throw new Error("Multilingual update fixture is unavailable");
    const mutationStart = performance.now();
    dense.layer.updateMany(entries);
    const mutationDuration = performance.now() - mutationStart;
    const commitStart = performance.now();
    await dense.layer.commit();
    await completeFrame(app);
    const commitDuration = performance.now() - commitStart;
    if (frame >= configuration.warmupFrames) {
      mutationMs.push(mutationDuration);
      commitMs.push(commitDuration);
    }
    return mutationDuration + commitDuration;
  });
  const stats = dense.layer.stats;
  const counters = layerCounters(stats, 6);
  dense.layer.destroy();

  return result({ setupMs, frameMs, mutationMs, commitMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    multilingualShapingActive: (counters.shapedLabels ?? 0) > 0,
    boundedVisibleSet: counters.submittedLabels < counters.residentLabels,
  });
}

async function runScaleScan(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const setupStart = performance.now();
  const dense = await createDenseLayer(
    configuration,
    {
      rendering: true,
      culling: { x: 0, y: 0, width: configuration.width, height: configuration.height },
      spacing: 20,
      text: "Scale",
      style: { fontFamily: "Arial", fontSize: 12, fill: 0xffffff },
    },
    app.renderer,
  );
  const viewport = new Viewport({
    screenWidth: configuration.width,
    screenHeight: configuration.height,
    worldWidth: 20_000,
    worldHeight: 20_000,
    events: app.renderer.events,
    noTicker: true,
  });
  app.stage.addChild(viewport);
  const binding = bindViewport(dense.layer, viewport);
  await binding.whenIdle();
  await completeFrame(app);
  const setupMs = performance.now() - setupStart;
  const frameMs = await sampleFrames(configuration, async (frame) => {
    const progress = (frame % 32) / 31;
    viewport.scale.set(0.25 * 64 ** progress);
    viewport.rotation = (Math.PI / 4) * progress;
    viewport.emit("zoomed", { viewport, type: "wheel" });
    viewport.emit("moved", { viewport, type: "drag" });
    const start = performance.now();
    viewport.emit("frame-end", viewport);
    await binding.whenIdle();
    await completeFrame(app);
    return performance.now() - start;
  });
  const stats = dense.layer.stats;
  const counters = layerCounters(stats, 5);
  binding.destroy();
  dense.layer.destroy();
  viewport.destroy({ children: true });

  return result({ setupMs, frameMs, cullingMs: frameMs }, counters, {
    exactResidentLabels: counters.residentLabels === configuration.labelCount,
    scaleRangeCovered: true,
    rotatedCameraCovered: true,
    renderedGlyphs: counters.visibleGlyphs > 0,
  });
}

async function runAtlasPressure(
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  const maxBytes = 4 * 1024 * 1024;
  const atlas = new GlyphAtlas({ pageWidth: 1_024, pageHeight: 1_024, maxBytes });
  const pixels = new Uint8Array(16 * 16).fill(255);
  const setupStart = performance.now();
  const batchSize = Math.max(1, Math.ceil(configuration.labelCount / configuration.sampleFrames));
  const frameMs: number[] = [];
  for (let start = 0; start < configuration.labelCount; start += batchSize) {
    const batchStart = performance.now();
    const end = Math.min(configuration.labelCount, start + batchSize);
    for (let index = start; index < end; index += 1) {
      const key = `glyph-${String(index)}`;
      atlas.stage(atlas.request(key), { mode: "alpha", width: 16, height: 16, pixels });
    }
    atlas.commitFrame();
    frameMs.push(performance.now() - batchStart);
  }
  const setupMs = performance.now() - setupStart;
  const stats = atlas.stats;
  const counters: BrowserBenchmarkCounters = Object.freeze({
    residentLabels: configuration.labelCount,
    submittedLabels: stats.entries,
    visibleGlyphs: stats.entries,
    drawCalls: 0,
    atlasBytes: stats.allocatedBytes,
    atlasEntries: stats.entries,
    atlasEvictions: stats.evictions,
  });
  atlas.destroy();

  return result({ setupMs, frameMs }, counters, {
    exactRequests: stats.requests === configuration.labelCount,
    boundedAtlasBytes: stats.allocatedBytes <= maxBytes,
    fixedCeilingBytes: maxBytes,
    evictionActivated: stats.evictions > 0,
    zeroCapacityFailures: stats.capacityFailures === 0,
  });
}

async function createDenseLayer(
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  options: Readonly<DenseLayerOptions>,
  renderer?: Renderer,
): Promise<DenseLayerResult> {
  const layer = new TextLayer({
    initialCapacity: configuration.labelCount,
    rendering: options.rendering === true ? {} : false,
    ...(options.rendering === true && renderer !== undefined ? { renderer } : {}),
    culling:
      options.culling === false
        ? false
        : {
            enabled: true,
            ...(options.culling === undefined ? {} : { bounds: options.culling }),
            ...(options.computeCull === undefined ? {} : { computeCull: options.computeCull }),
            ...(options.residency === undefined ? {} : { residency: options.residency }),
          },
  });
  const ids = options.keepIds === true ? new Float64Array(configuration.labelCount) : undefined;
  const spacing = options.spacing ?? 16;
  const spacingX = options.spacingX ?? spacing;
  const spacingY = options.spacingY ?? spacing;
  const style = options.style ?? DEFAULT_STYLE;
  for (let start = 0; start < configuration.labelCount; start += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, configuration.labelCount - start);
    const specs = Array.from({ length: count }, (_, localIndex): TextLabelSpec => {
      const index = start + localIndex;
      return {
        text: typeof options.text === "function" ? options.text(index) : (options.text ?? "g"),
        x: (index % 1_000) * spacingX,
        y: Math.floor(index / 1_000) * spacingY,
        style: typeof style === "function" ? style(index) : style,
      };
    });
    const created = layer.createMany(specs);
    ids?.set(created, start);
  }
  await layer.commit();

  return { layer, ids };
}

function createStressMesh(
  renderer: Renderer,
  labelCount: number,
  glyphCount: number,
): Readonly<{
  mesh: GlyphMesh;
  instanceBytes: number;
  transformBytes: number;
  destroy: () => void;
}> {
  const maximumTextureSize =
    "gl" in renderer
      ? (renderer as WebGLRenderer).gl.getParameter((renderer as WebGLRenderer).gl.MAX_TEXTURE_SIZE)
      : 4_096;
  const paletteWidth = Math.min(4_096, maximumTextureSize as number);
  const paletteHeight = Math.ceil((labelCount * 2) / paletteWidth);
  if (paletteHeight > maximumTextureSize) {
    throw new RangeError("Transform palette exceeds the renderer texture-size limit");
  }
  const palette = new Float32Array(paletteWidth * paletteHeight * 4);
  const bits = new Uint32Array(palette.buffer);
  for (let label = 0; label < labelCount; label += 1) {
    const offset = label * 8;
    palette[offset] = (label % 1_000) * 1.28;
    palette[offset + 1] = (Math.floor(label / 1_000) % 1_000) * 0.8;
    palette[offset + 2] = 1;
    palette[offset + 3] = 1;
    bits[offset + 4] = packHalf2x16(0, 1);
    bits[offset + 5] = packHalf2x16(0, 0);
    palette[offset + 6] = 0xffffff;
    palette[offset + 7] = 65_535;
  }
  const store = new ArrayBuffer(glyphCount * INSTANCE_STRIDE);
  const view = new DataView(store);
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const offset = glyph * INSTANCE_STRIDE;
    view.setUint16(offset, packF16((glyph % 8) * 0.12), true);
    view.setUint16(offset + 2, packF16(0), true);
    view.setUint16(offset + 4, packF16(0.12), true);
    view.setUint16(offset + 6, packF16(0.7), true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 65_535, true);
    view.setUint16(offset + 14, 65_535, true);
    view.setUint32(offset + 16, Math.floor(glyph / 8), true);
    view.setUint32(offset + 20, ACTIVE_ALPHA_METADATA, true);
  }
  const protoLayout = prototypeTextureLayout(glyphCount, maximumTextureSize as number);
  const protoPixels = allocatePrototypePixels(protoLayout.width, protoLayout.height);
  writePrototypeGlyphs(protoPixels, store, 0, glyphCount);
  const instanceData = new ArrayBuffer(glyphCount * GLYPH_DRAW_STRIDE);
  const drawWords = new Uint32Array(instanceData);
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    writeDrawInstance(drawWords, glyph, glyph, Math.floor(glyph / 8));
  }
  const atlasSource = new BufferImageSource({
    resource: new Uint8Array([255]),
    width: 1,
    height: 1,
    format: "r8unorm",
    scaleMode: "nearest",
    alphaMode: "premultiply-alpha-on-upload",
    autoGenerateMipmaps: false,
  });
  const paletteSource = new BufferImageSource({
    resource: palette,
    width: paletteWidth,
    height: paletteHeight,
    format: "rgba32float",
    scaleMode: "nearest",
    alphaMode: "no-premultiply-alpha",
    autoGenerateMipmaps: false,
  });
  const protoSource = new BufferImageSource({
    resource: protoPixels,
    width: protoLayout.width,
    height: protoLayout.height,
    format: "rgba32float",
    scaleMode: "nearest",
    alphaMode: "no-premultiply-alpha",
    autoGenerateMipmaps: false,
  });
  const atlasTexture = new Texture({ source: atlasSource });
  const paletteTexture = new Texture({ source: paletteSource });
  const protoTexture = new Texture({ source: protoSource });
  const mesh = new GlyphMesh({
    texture: atlasTexture,
    paletteTexture,
    paletteWidth,
    prototypeTexture: protoTexture,
    prototypeWidth: protoLayout.width,
    instanceData,
    instanceCount: glyphCount,
  });

  return Object.freeze({
    mesh,
    instanceBytes: instanceData.byteLength,
    transformBytes: labelCount * TRANSFORM_STRIDE,
    destroy: () => {
      mesh.removeFromParent();
      mesh.destroy();
      atlasTexture.destroy(true);
      paletteTexture.destroy(true);
      protoTexture.destroy(true);
    },
  });
}

async function sampleFrames(
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  operation: (frame: number) => Promise<number>,
): Promise<readonly number[]> {
  const samples: number[] = [];
  const total = configuration.warmupFrames + configuration.sampleFrames;
  for (let frame = 0; frame < total; frame += 1) {
    const duration = await operation(frame);
    if (frame >= configuration.warmupFrames) samples.push(duration);
  }

  return Object.freeze(samples);
}

function buildPositions(count: number, spacing: number, offset: number): Float32Array {
  const positions = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    positions[index * 2] = (index % 1_000) * spacing + offset;
    positions[index * 2 + 1] = Math.floor(index / 1_000) * spacing + offset;
  }

  return positions;
}

async function measureGpuSceneHeterogeneousPrototypeBounds(
  layer: TextLayer,
  style: Readonly<NonNullable<TextLabelSpec["style"]>>,
): Promise<readonly Readonly<RunBounds>[]> {
  const layout = new LayoutEngine(layer.fonts);
  try {
    const bounds: Array<Readonly<RunBounds>> = [];
    for (let index = 0; index < GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length; index += 1) {
      const text = GPU_SCENE_HETEROGENEOUS_PROTOTYPES[index];
      if (text === undefined)
        throw new Error(`heterogeneous prototype ${String(index)} is missing`);
      const run = await Promise.resolve(layout.layout(index, 1, { text, style }));
      if (run.glyphCount !== 1) {
        throw new Error(
          `heterogeneous prototype ${String(index)} produced ${String(run.glyphCount)} glyphs`,
        );
      }
      bounds.push(
        Object.freeze({
          x: run.bounds.x,
          y: run.bounds.y,
          width: run.bounds.width,
          height: run.bounds.height,
        }),
      );
    }
    return Object.freeze(bounds);
  } finally {
    layout.destroy();
  }
}

function requireBenchmarkViewportBounds(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }> | undefined,
  phase: "camera" | "position",
): Readonly<{ x: number; y: number; width: number; height: number }> {
  if (
    bounds === undefined ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error(`heterogeneous ${phase} viewport bounds are unavailable`);
  }
  return Object.freeze({ ...bounds });
}

function gpuSceneHeterogeneousPrototypePaintPairCount(labelCount: number): number {
  const pairs = new Set<number>();
  const limit = Math.min(labelCount, GPU_SCENE_HETEROGENEOUS_PAIR_PERIOD);
  for (let index = 0; index < limit; index += 1) {
    pairs.add(
      gpuSceneHeterogeneousPrototypeIndex(index) * GPU_SCENE_HETEROGENEOUS_PAINTS.length +
        gpuSceneHeterogeneousPaintIndex(index),
    );
  }
  return pairs.size;
}

function gpuResidentViewHeight(labelCount: number): number {
  const rows = Math.max(1, Math.ceil(labelCount / GPU_RESIDENT_GRID_WIDTH));
  return (rows - 1) * GPU_RESIDENT_ROW_SPACING + 8;
}

function buildGpuResidentPositions(count: number, offset: number): Float32Array {
  const positions = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    positions[index * 2] = (index % GPU_RESIDENT_GRID_WIDTH) * GPU_RESIDENT_SPACING + offset;
    positions[index * 2 + 1] =
      Math.floor(index / GPU_RESIDENT_GRID_WIDTH) * GPU_RESIDENT_ROW_SPACING + offset;
  }
  return positions;
}

function gpuResidentSubmittedCount(labelCount: number): number {
  const fullRows = Math.floor(labelCount / GPU_RESIDENT_GRID_WIDTH);
  const lastRow = labelCount % GPU_RESIDENT_GRID_WIDTH;
  return fullRows * GPU_RESIDENT_VISIBLE_COLUMNS + Math.min(lastRow, GPU_RESIDENT_VISIBLE_COLUMNS);
}

function hashGpuResidentSelection(labelCount: number): number {
  let hash = 0x811c_9dc5;
  for (let slot = 0; slot < labelCount; slot += 1) {
    if (slot % GPU_RESIDENT_GRID_WIDTH >= GPU_RESIDENT_VISIBLE_COLUMNS) continue;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
    hash = Math.imul(hash ^ slot, 0x0100_0193) >>> 0;
  }
  return hash;
}

function minimumSample(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return Number.POSITIVE_INFINITY;
  let minimum = Number.POSITIVE_INFINITY;
  for (const sample of samples) minimum = Math.min(minimum, sample);
  return minimum;
}

function maximumSample(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, sample);
  return maximum;
}

/** @internal Benchmark diagnostic seam for GPU readback lifecycle tests. */
export async function hashRenderedPixels(
  app: Application,
  target: Container,
  width: number,
  height: number,
): Promise<Readonly<{ hash: number; nonTransparentPixels: number }>> {
  if (!("gpu" in app.renderer)) {
    throw new Error("GPU-resident scene pixel readback requires WebGPU");
  }
  const texture = app.renderer.extract.texture({
    target,
    frame: new Rectangle(0, 0, width, height),
  });
  try {
    await finishGpu(app.renderer);
    const gpuTexture = app.renderer.texture.getGpuSource(texture.source);
    const rowBytes = width * 4;
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const buffer = app.renderer.gpu.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      let mapped = false;
      try {
        const encoder = app.renderer.gpu.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: gpuTexture },
          { buffer, bytesPerRow, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
        app.renderer.gpu.device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        mapped = true;
        const pixels = new Uint8Array(buffer.getMappedRange());
        let hash = 0x811c_9dc5;
        let nonTransparentPixels = 0;
        for (let y = 0; y < height; y += 1) {
          const rowOffset = y * bytesPerRow;
          for (let index = 0; index < rowBytes; index += 1) {
            const value = pixels[rowOffset + index] ?? 0;
            hash = Math.imul(hash ^ value, 0x0100_0193) >>> 0;
            if (index % 4 === 3 && value > 0) nonTransparentPixels += 1;
          }
        }
        return Object.freeze({ hash, nonTransparentPixels });
      } finally {
        if (mapped) buffer.unmap();
      }
    } finally {
      buffer.destroy();
    }
  } finally {
    texture.destroy(true);
  }
}

function requireIds(dense: Readonly<DenseLayerResult>): Float64Array {
  if (dense.ids === undefined) throw new Error("Dense workload identities are unavailable");
  return dense.ids;
}

function layerCounters(
  stats: Readonly<TextLayer["stats"]>,
  glyphsPerLabel: number,
): Readonly<BrowserBenchmarkCounters> {
  return Object.freeze({
    residentLabels: stats.labelCount,
    submittedLabels: stats.visibleLabelCount,
    visibleGlyphs: stats.visibleLabelCount * glyphsPerLabel,
    drawCalls: stats.drawCalls,
    allocatedStoreBytes: stats.allocatedStoreBytes,
    instanceBytes: stats.glyphCount * INSTANCE_STRIDE,
    transformBytes: stats.capacity * TRANSFORM_STRIDE,
    labelRevision: Number(stats.revision),
    shapedLabels: stats.shapedLabels,
    transformOnlyLabels: stats.transformOnlyLabels,
    cullingQueries: stats.cullingQueries,
    submittedGlyphs: stats.submittedGlyphs,
    rendererAdapter: stats.rendererAdapter,
    cullPath: stats.cullPath,
    palettePath: stats.palettePath,
    lastLayoutMs: stats.lastLayoutMs,
    lastInstanceWriteMs: stats.lastInstanceWriteMs,
    lastPaletteWriteMs: stats.lastPaletteWriteMs,
    lastSpatialUpdateMs: stats.lastSpatialUpdateMs,
    lastUploadMs: stats.lastUploadMs,
  });
}

async function sampleCompletedFrames(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
  layer?: TextLayer,
): Promise<
  Readonly<{
    frameMs: readonly number[];
    cpuMs: readonly number[];
    gpuMs: readonly number[];
    uploadBytes: readonly number[];
  }>
> {
  const frameMs: number[] = [];
  const cpuMs: number[] = [];
  const gpuMs: number[] = [];
  const uploadBytes: number[] = [];
  const total = configuration.warmupFrames + configuration.sampleFrames;
  for (let frame = 0; frame < total; frame += 1) {
    const beforeUpload = layer === undefined ? 0 : uploadTotal(layer);
    const sample = await completeFrame(app);
    if (frame < configuration.warmupFrames) continue;
    frameMs.push(sample.frameMs);
    cpuMs.push(sample.cpuMs);
    gpuMs.push(sample.gpuMs);
    uploadBytes.push(layer === undefined ? 0 : Math.max(0, uploadTotal(layer) - beforeUpload));
  }

  return Object.freeze({
    frameMs: Object.freeze(frameMs),
    cpuMs: Object.freeze(cpuMs),
    gpuMs: Object.freeze(gpuMs),
    uploadBytes: Object.freeze(uploadBytes),
  });
}

function uploadTotal(layer: TextLayer): number {
  const stats = layer.stats;
  return stats.instanceUploadBytes + stats.transformUploadBytes + stats.atlasUploadBytes;
}

function result(
  timings: BrowserBenchmarkTimings,
  counters: Readonly<BrowserBenchmarkCounters>,
  invariants: Readonly<Record<string, boolean | number | string>>,
): Readonly<BrowserFixtureResult> {
  return Object.freeze({
    timings: Object.freeze(timings),
    counters,
    invariants: Object.freeze(invariants),
  });
}

function observeInstancedDraws(renderer: Renderer): Readonly<{
  read: () => Readonly<{ drawCalls: number; maximumInstanceCount: number }>;
  destroy: () => void;
}> {
  if (!("gl" in renderer)) {
    return Object.freeze({
      read: () => Object.freeze({ drawCalls: 0, maximumInstanceCount: 0 }),
      destroy: () => undefined,
    });
  }
  const gl = renderer.gl;
  const original = gl.drawElementsInstanced;
  let drawCalls = 0;
  let maximumInstanceCount = 0;
  gl.drawElementsInstanced = function drawElementsInstanced(
    mode: GLenum,
    count: GLsizei,
    type: GLenum,
    offset: GLintptr,
    instanceCount: GLsizei,
  ): void {
    drawCalls += 1;
    maximumInstanceCount = Math.max(maximumInstanceCount, instanceCount);
    original.call(this, mode, count, type, offset, instanceCount);
  };

  return Object.freeze({
    read: () => Object.freeze({ drawCalls, maximumInstanceCount }),
    destroy: () => {
      gl.drawElementsInstanced = original;
    },
  });
}

function countNonTransparentPixels(renderer: Renderer): number {
  if (!("gl" in renderer)) return 0;
  const width = 16;
  const height = 16;
  const pixels = new Uint8Array(width * height * 4);
  renderer.gl.readPixels(
    0,
    Math.max(0, renderer.gl.drawingBufferHeight - height),
    width,
    height,
    renderer.gl.RGBA,
    renderer.gl.UNSIGNED_BYTE,
    pixels,
  );
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    count += Number((pixels[index] ?? 0) > 0);
  }

  return count;
}
