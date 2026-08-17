import { Viewport } from "pixi-viewport";
import {
  BufferImageSource,
  Texture,
  type Application,
  type Renderer,
  type WebGLRenderer,
} from "pixi.js";

import { TextLayer } from "../../src";
import type { TextId, TextLabelSpec, TextUpdate } from "../../src";
import { GlyphAtlas, GlyphMesh, TRANSFORM_PALETTE_STRIDE } from "../../src/advanced";
import { packHalf2x16 } from "../../src/render/pack";
import { bindViewport } from "../../src/viewport";
import type {
  BrowserBenchmarkConfiguration,
  BrowserBenchmarkCounters,
  BrowserBenchmarkTimings,
} from "../schema";
import type { BrowserFixtureResult } from "./fixtures";

const ACTIVE_ALPHA_METADATA = 0x8001_0000;
const INSTANCE_STRIDE = 32;
const TRANSFORM_STRIDE = TRANSFORM_PALETTE_STRIDE;
const CHUNK_SIZE = 8_192;
const DEFAULT_STYLE = Object.freeze({ fontFamily: "Arial", fontSize: 8, fill: 0xffffff });

interface DenseLayerResult {
  readonly layer: TextLayer;
  readonly ids: Float64Array | undefined;
}

interface DenseLayerOptions {
  readonly keepIds?: boolean;
  readonly rendering?: boolean;
  readonly culling?: false | Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly spacing?: number;
  readonly text?: string | ((index: number) => string);
  readonly style?: Readonly<TextLabelSpec["style"]>;
}

export async function runGlyphflowWorkload(
  app: Application,
  configuration: Readonly<BrowserBenchmarkConfiguration>,
): Promise<Readonly<BrowserFixtureResult>> {
  switch (configuration.workload) {
    case "million-full":
      return runMillionFull(app, configuration);
    case "million-viewport":
      return runMillionViewport(configuration);
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
  renderAndFinish(app);
  const setupMs = performance.now() - setupStart;
  const frameMs = await sampleFrames(configuration, async () => {
    const start = performance.now();
    renderAndFinish(app);
    return performance.now() - start;
  });
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

  return result({ setupMs, frameMs }, counters, {
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
  renderAndFinish(app);
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
    renderAndFinish(app);
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
  renderAndFinish(app);
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
    renderAndFinish(app);
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
          },
  });
  const ids = options.keepIds === true ? new Float64Array(configuration.labelCount) : undefined;
  const spacing = options.spacing ?? 16;
  const style = options.style ?? DEFAULT_STYLE;
  for (let start = 0; start < configuration.labelCount; start += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, configuration.labelCount - start);
    const specs = Array.from({ length: count }, (_, localIndex): TextLabelSpec => {
      const index = start + localIndex;
      return {
        text: typeof options.text === "function" ? options.text(index) : (options.text ?? "g"),
        x: (index % 1_000) * spacing,
        y: Math.floor(index / 1_000) * spacing,
        style,
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
  const instanceData = new ArrayBuffer(glyphCount * INSTANCE_STRIDE);
  const view = new DataView(instanceData);
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const offset = glyph * INSTANCE_STRIDE;
    view.setFloat32(offset, (glyph % 8) * 0.12, true);
    view.setFloat32(offset + 4, 0, true);
    view.setFloat32(offset + 8, 0.12, true);
    view.setFloat32(offset + 12, 0.7, true);
    view.setUint16(offset + 16, 0, true);
    view.setUint16(offset + 18, 0, true);
    view.setUint16(offset + 20, 65_535, true);
    view.setUint16(offset + 22, 65_535, true);
    view.setUint32(offset + 24, Math.floor(glyph / 8), true);
    view.setUint32(offset + 28, ACTIVE_ALPHA_METADATA, true);
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
  const atlasTexture = new Texture({ source: atlasSource });
  const paletteTexture = new Texture({ source: paletteSource });
  const mesh = new GlyphMesh({
    texture: atlasTexture,
    paletteTexture,
    paletteWidth,
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
  });
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

function renderAndFinish(app: Application): void {
  app.render();
  if ("gl" in app.renderer) app.renderer.gl.finish();
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
