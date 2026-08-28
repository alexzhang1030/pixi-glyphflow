<script setup lang="ts">
import { MSDF } from "@zappar/msdf-generator";
import msdfWasmUrl from "@zappar/msdf-generator/msdfgen_wasm.wasm?url";
import msdfWorkerUrl from "@zappar/msdf-generator/worker.js?worker&url";
import {
  requestComputeCullGpu,
  TextLayer,
  type CullPath,
  type PalettePath,
  type TextId,
  type TextLabelSpec,
  type TextShapingOptions,
} from "pixi-glyphflow";
import { charsetSdfPrebuilt, mergePrebuilt } from "pixi-glyphflow/prebuilt";
import { bindViewport, type ViewportBinding } from "pixi-glyphflow/viewport";
import { Viewport } from "pixi-viewport";
import { Application, type Container, type TextStyleOptions } from "pixi.js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  cameraHome,
  CHUNK_SIZE,
  COLUMNS,
  CULLING_PADDING,
  CUSTOM_FONTS,
  DEMO_CHARSETS,
  FALLBACK_FILL,
  FIELD_FILL,
  FIELD_FONT_SIZE,
  gridIndicesInWorldBounds,
  HERO_FONT_SIZE,
  INITIAL_ZOOM,
  isMoverIndex,
  LABEL_COUNT,
  labelPosition,
  LANGUAGE_SAMPLES,
  MOVING_COUNT,
  MULTILINGUAL_STACK,
  resolveLanguageSample,
  STORM_INTERVAL_MS,
  SYSTEM_FONT_FAMILIES,
  workingSetExpand,
  worldHeight,
  worldWidth,
  type LanguageSample,
} from "../utils/demoScene";

interface LoadedFontAsset {
  readonly family: string;
  readonly bytes: Uint8Array;
}

const numberFormat = new Intl.NumberFormat("en-US");
/** Debug hold so Playwright can screenshot ready before the first storm apply. */
const STORM_HOLD_MS = 4_000;

type RendererBackend = "webgl" | "webgpu";
type WebGpuCapability = "checking" | "available" | "unavailable";

function resolveDemoBackend(
  query: RendererBackend | undefined,
  capability: Exclude<WebGpuCapability, "checking">,
): RendererBackend {
  if (query !== undefined) return query;
  return capability === "available" ? "webgpu" : "webgl";
}

const canvasHost = ref<HTMLElement>();
const state = ref<"booting" | "ready" | "error">("booting");
const firstFrameReady = ref(false);
const tickerFrames = ref(0);
const errorMessage = ref("");
const loadedPercent = ref(0);
const bootStage = ref("Loading type");
const requestedBackend = ref<RendererBackend>("webgl");
const activeBackend = ref<RendererBackend>();
const webGpuCapability = ref<WebGpuCapability>("checking");
const stormEnabled = ref(true);
const stormPhase = ref<"idle" | "hold" | "active">("idle");
const stormCommits = ref(0);
const allVisible = ref(true);
const visibilityPending = ref(false);
const rotationDegrees = ref(0);
const resident = ref("0");
const visible = ref("0");
const pendingGlyphs = ref(0);
const revision = ref("0");
const glyphs = ref("0");
const drawCalls = ref(0);
const atlasTextures = ref(0);
const updateDuration = ref("0.00 ms");
const visibilityDuration = ref("0.00 ms");
const viewportDuration = ref("0.00 ms");
const fps = ref("0");
const fontStatus = ref("Loading custom fonts");
const fontFootprint = ref("0 KiB");
const cullPath = ref<CullPath>("cpu-grid");
const palettePath = ref<PalettePath>("texture");
const rendererName = computed(() => formatRenderer(activeBackend.value ?? requestedBackend.value));

const webGpuCapabilityLabel = computed(() => {
  switch (webGpuCapability.value) {
    case "available":
      return "WebGPU available";
    case "unavailable":
      return "WebGPU unavailable";
    case "checking":
      return "Checking WebGPU";
    default: {
      const _exhaustive: never = webGpuCapability.value;
      return _exhaustive;
    }
  }
});

const stateLabel = computed(() => {
  if (state.value === "ready") return `${rendererName.value} live`;
  if (state.value === "error") return "Error";
  return `${bootStage.value} · ${loadedPercent.value}%`;
});

const bootChip = computed(() => {
  if (state.value === "error") return errorMessage.value;
  if (!firstFrameReady.value) return bootStage.value;
  return `${bootStage.value} · ${loadedPercent.value}%`;
});

let app: Application | undefined;
let computeCullGpuDevice: GPUDevice | undefined;
let viewport: Viewport | undefined;
let layer: TextLayer | undefined;
let binding: ViewportBinding | undefined;
let resizeObserver: ResizeObserver | undefined;
let intersectionObserver: IntersectionObserver | undefined;
let stormTimer: number | undefined;
let stormHoldTimer: number | undefined;
let movingIds: Float64Array | undefined;
let firstPositions: Float32Array | undefined;
let secondPositions: Float32Array | undefined;
let useSecondPositions = true;
let stormPending = false;
let demoVisible = true;
let destroyed = false;
let rendererRun = 0;
let customFontsPromise: Promise<readonly Readonly<LoadedFontAsset>[]> | undefined;

onMounted(async () => {
  stormEnabled.value = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const query = readRendererQuery();
  if (query === "webgl") {
    void probeWebGpu();
    void restartRenderer(resolveDemoBackend(query, "unavailable"));
    return;
  }
  await probeWebGpu();
  if (destroyed) return;
  const capability = webGpuCapability.value;
  if (capability === "checking") return;
  void restartRenderer(resolveDemoBackend(query, capability));
});

onBeforeUnmount(() => {
  destroyed = true;
  rendererRun += 1;
  cleanup();
});

function selectBackend(backend: RendererBackend): void {
  if (state.value === "booting") return;
  if (backend === requestedBackend.value && state.value === "ready") return;
  if (backend === "webgpu" && webGpuCapability.value !== "available") return;
  updateRendererQuery(backend);
  void restartRenderer(backend);
}

async function restartRenderer(backend: RendererBackend): Promise<void> {
  const runId = rendererRun + 1;
  rendererRun = runId;
  cleanup();
  requestedBackend.value = backend;
  activeBackend.value = undefined;
  state.value = "booting";
  errorMessage.value = "";
  resetHud();

  try {
    await initialize(backend, runId);
  } catch (error: unknown) {
    if (isStale(runId)) return;
    cleanup();
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

async function probeWebGpu(): Promise<void> {
  const gpu = navigator.gpu;
  if (gpu === undefined) {
    webGpuCapability.value = "unavailable";
    return;
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (destroyed) return;
    webGpuCapability.value =
      adapter === null && activeBackend.value !== "webgpu" ? "unavailable" : "available";
  } catch {
    if (!destroyed && activeBackend.value !== "webgpu") {
      webGpuCapability.value = "unavailable";
    }
  }
}

function readRendererQuery(): RendererBackend | undefined {
  const value = new URL(window.location.href).searchParams.get("renderer");
  switch (value) {
    case "webgl":
    case "webgpu":
      return value;
    default:
      return undefined;
  }
}

function updateRendererQuery(backend: RendererBackend): void {
  const url = new URL(window.location.href);
  url.searchParams.set("renderer", backend);
  window.history.replaceState(window.history.state, "", url);
}

function resetHud(): void {
  firstFrameReady.value = false;
  tickerFrames.value = 0;
  loadedPercent.value = 0;
  bootStage.value = "Loading type";
  resident.value = "0";
  visible.value = "0";
  pendingGlyphs.value = 0;
  revision.value = "0";
  glyphs.value = "0";
  drawCalls.value = 0;
  atlasTextures.value = 0;
  updateDuration.value = "0.00 ms";
  visibilityDuration.value = "0.00 ms";
  viewportDuration.value = "0.00 ms";
  fps.value = "0";
  fontStatus.value = "Loading custom fonts";
  fontFootprint.value = "0 KiB";
  cullPath.value = "cpu-grid";
  palettePath.value = "texture";
  allVisible.value = true;
  visibilityPending.value = false;
  rotationDegrees.value = 0;
  stormPhase.value = "idle";
  stormCommits.value = 0;
}

function isStale(runId: number): boolean {
  return destroyed || runId !== rendererRun;
}

async function initialize(backend: RendererBackend, runId: number): Promise<void> {
  const host = canvasHost.value;
  if (host === undefined) throw new Error("Demo canvas host is unavailable");

  const gpu =
    backend === "webgpu"
      ? await requestComputeCullGpu({ powerPreference: "high-performance" })
      : undefined;
  if (backend === "webgpu" && gpu === undefined) {
    throw new Error("WebGPU device is unavailable");
  }

  const nextApp = new Application();
  const appOptions = {
    width: Math.max(host.clientWidth, 320),
    height: Math.max(host.clientHeight, 320),
    preference: [backend],
    preferWebGLVersion: 2 as const,
    powerPreference: "high-performance" as const,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    background: "#080d12",
  };
  try {
    if (gpu === undefined) await nextApp.init(appOptions);
    else await nextApp.init({ ...appOptions, gpu });
  } catch (error: unknown) {
    gpu?.device.destroy();
    throw error;
  }
  if (isStale(runId)) {
    nextApp.destroy(true);
    gpu?.device.destroy();
    return;
  }
  computeCullGpuDevice = gpu?.device;
  app = nextApp;
  nextApp.stop();
  nextApp.canvas.className = "demo-canvas-element";
  nextApp.canvas.setAttribute("role", "img");
  nextApp.canvas.setAttribute(
    "aria-label",
    "One million interactive multilingual glyph labels rendered with custom CJKV and system fallback fonts",
  );
  host.appendChild(nextApp.canvas);
  // #region agent log
  (
    globalThis as typeof globalThis & {
      __GLYPHFLOW_AGENT_DEBUG?: boolean;
      __GLYPHFLOW_BIND_LOGS?: number;
      __GLYPHFLOW_RANGE_LOGS?: number;
      __GLYPHFLOW_POS_LOGS?: number;
      __GLYPHFLOW_WORK_LOGS?: number;
    }
  ).__GLYPHFLOW_AGENT_DEBUG = true;
  (globalThis as typeof globalThis & { __GLYPHFLOW_BIND_LOGS?: number }).__GLYPHFLOW_BIND_LOGS = 0;
  (globalThis as typeof globalThis & { __GLYPHFLOW_RANGE_LOGS?: number }).__GLYPHFLOW_RANGE_LOGS =
    0;
  (globalThis as typeof globalThis & { __GLYPHFLOW_POS_LOGS?: number }).__GLYPHFLOW_POS_LOGS = 0;
  (globalThis as typeof globalThis & { __GLYPHFLOW_WORK_LOGS?: number }).__GLYPHFLOW_WORK_LOGS = 0;
  nextApp.canvas.addEventListener("webglcontextlost", (event) => {
    const lost = event as WebGLContextEvent;
    agentLog("A", "GlyphflowDemo.client.vue:webglcontextlost", "webglcontextlost", {
      statusMessage: lost.statusMessage,
    });
  });
  nextApp.canvas.addEventListener("webglcontextrestored", () => {
    agentLog("A", "GlyphflowDemo.client.vue:webglcontextrestored", "webglcontextrestored", {});
  });
  // #endregion

  const nextWorldWidth = worldWidth();
  const nextWorldHeight = worldHeight();
  const home = cameraHome();
  const nextViewport = new Viewport({
    screenWidth: nextApp.screen.width,
    screenHeight: nextApp.screen.height,
    worldWidth: nextWorldWidth,
    worldHeight: nextWorldHeight,
    passiveWheel: false,
    events: nextApp.renderer.events,
  });
  viewport = nextViewport;
  nextViewport
    .drag()
    .decelerate({ friction: 0.95, minSpeed: 0.01 })
    .pinch()
    .wheel({
      smooth: 3,
      keyToPress: ["ControlLeft", "MetaLeft"],
      trackpadPinch: true,
    })
    .clampZoom({ minScale: 0.08, maxScale: 3 });
  nextViewport.setZoom(INITIAL_ZOOM, true);
  nextViewport.moveCenter(home.x, home.y);
  nextApp.stage.addChild(nextViewport);

  bootStage.value = "Baking sample glyphs";
  const customFontAssets = await loadCustomFonts();
  await installDemoFaces(customFontAssets);
  const prebuilt = mergePrebuilt(
    ...(await Promise.all(
      DEMO_CHARSETS.map((entry) =>
        charsetSdfPrebuilt({
          family: entry.family,
          charset: entry.charset,
          fontSize: 14,
          fontWeight: "500",
          distanceFieldMinFontSize: 48,
        }),
      ),
    )),
  );
  const nextLayer = new TextLayer({
    renderer: nextApp.renderer,
    initialCapacity: LABEL_COUNT,
    rendering: {
      transformOptions: { initialCapacity: LABEL_COUNT },
      rasterizerOptions: {
        tinySdf: true,
        distanceFieldMinFontSize: 48,
        prebuilt,
        createMsdfGenerator: () =>
          Promise.resolve(new MSDF({ workerUrl: msdfWorkerUrl, wasmUrl: msdfWasmUrl })),
      },
    },
    culling: {
      bounds: { x: 0, y: 0, width: nextApp.screen.width, height: nextApp.screen.height },
      padding: CULLING_PADDING,
      computeCull: "auto",
    },
  });
  layer = nextLayer;
  const customFonts = await Promise.all(
    customFontAssets.map((asset) =>
      nextLayer.fonts.register({ family: asset.family, source: asset.bytes }),
    ),
  );
  nextLayer.fonts.registerFallback(MULTILINGUAL_STACK, [
    ...CUSTOM_FONTS.map((font) => font.family),
    ...SYSTEM_FONT_FAMILIES,
  ]);
  fontStatus.value = "5 custom fonts ready";
  fontFootprint.value = `${Math.round(
    customFonts.reduce((total, font) => total + font.bytes, 0) / 1_024,
  ).toString()} KiB`;
  const nextBinding = bindViewport(nextLayer, nextViewport, {
    addChild: true,
    immediate: true,
    onError: (error: unknown) => console.error(error),
  });
  binding = nextBinding;
  await nextBinding.whenIdle();
  if (isStale(runId)) return;

  const styles = createLabelStyles();
  movingIds = new Float64Array(MOVING_COUNT);
  firstPositions = new Float32Array(MOVING_COUNT * 2);
  secondPositions = new Float32Array(MOVING_COUNT * 2);
  let movingIndex = 0;

  bootStage.value = "Drawing the first view";
  const visibleBounds = nextViewport.getVisibleBounds();
  let firstView = gridIndicesInWorldBounds(
    visibleBounds,
    workingSetExpand(visibleBounds, CULLING_PADDING),
  );
  if (firstView.length === 0) {
    firstView = gridIndicesInWorldBounds(
      { x: home.x - 800, y: home.y - 400, width: 1_600, height: 800 },
      CULLING_PADDING,
    );
  } else if (firstView.length > 20_000) {
    firstView = gridIndicesInWorldBounds(visibleBounds);
  }
  const firstViewSet = new Set(firstView);
  movingIndex = admitLabelIndices(nextLayer, firstView, styles, movingIndex);
  loadedPercent.value = Math.round((firstView.length / LABEL_COUNT) * 100);
  await nextLayer.commit();
  nextViewport.emit("frame-end", nextViewport);
  await nextBinding.whenIdle();
  if (isStale(runId)) return;
  nextApp.render();
  firstFrameReady.value = true;
  updateHud(0);
  console.info("[demo-stats-first]", JSON.stringify(nextLayer.stats));
  // #region agent log
  logDemoSnapshot("A", "first-render", nextApp, nextViewport, nextLayer);
  // #endregion
  // Experiment E: keep the ticker running after the first present. Do not issue a
  // second stopped-ticker app.render() after the million commit.
  nextApp.start();
  startRuntime(nextApp, nextViewport, nextWorldWidth, nextWorldHeight, runId);

  bootStage.value = "Filling the million";
  for (let start = 0; start < LABEL_COUNT; start += CHUNK_SIZE) {
    if (isStale(runId)) return;
    const end = Math.min(LABEL_COUNT, start + CHUNK_SIZE);
    const chunk: number[] = [];
    for (let index = start; index < end; index += 1) {
      if (firstViewSet.has(index)) continue;
      chunk.push(index);
    }
    if (chunk.length > 0) {
      movingIndex = admitLabelIndices(nextLayer, chunk, styles, movingIndex);
    }
    loadedPercent.value = Math.round((end / LABEL_COUNT) * 100);
    await nextFrame();
  }
  // #region agent log
  logDemoSnapshot("A", "after-million-alloc", nextApp, nextViewport, nextLayer);
  // #endregion

  bootStage.value = "Publishing the resident set";
  const initialCommit = nextLayer.commit();
  resident.value = numberFormat.format(nextLayer.stats.labelCount);
  visible.value = numberFormat.format(nextLayer.stats.visibleLabelCount);
  const glyphProgress = window.setInterval(() => {
    const pending = nextLayer.stats.pendingGlyphCount;
    pendingGlyphs.value = pending;
    if (pending > 0) bootStage.value = `Rasterizing ${numberFormat.format(pending)} unique glyphs`;
  }, 250);
  try {
    await initialCommit;
  } finally {
    window.clearInterval(glyphProgress);
  }
  pendingGlyphs.value = nextLayer.stats.pendingGlyphCount;
  nextViewport.emit("frame-end", nextViewport);
  await nextBinding.whenIdle();
  if (isStale(runId)) return;
  // #region agent log
  logDemoSnapshot("E", "post-million-skipped-second-render", nextApp, nextViewport, nextLayer);
  // #endregion
  console.info("[demo-stats-second]", JSON.stringify(nextLayer.stats));

  const rendererAdapter = nextLayer.stats.rendererAdapter;
  if (rendererAdapter !== backend) {
    throw new Error(
      `${formatRenderer(backend)} was requested and PixiJS selected ${formatRenderer(rendererAdapter)}`,
    );
  }
  activeBackend.value = backend;
  if (backend === "webgpu") webGpuCapability.value = "available";
  state.value = "ready";
  updateHud(0);
  // Experiment H: hold the first storm so a ready screenshot can beat the 100ms interval.
  stormPhase.value = "hold";
  // #region agent log
  logDemoSnapshot("H", "ready-before-storm", nextApp, nextViewport, nextLayer);
  // #endregion
  stormHoldTimer = window.setTimeout(() => {
    if (isStale(runId)) return;
    stormPhase.value = "active";
    // #region agent log
    agentLog("H", "GlyphflowDemo.client.vue:storm-hold-released", "storm-hold-released", {
      holdMs: STORM_HOLD_MS,
    });
    // #endregion
    stormTimer = window.setInterval(() => void runPositionStorm(runId), STORM_INTERVAL_MS);
    void runPositionStorm(runId);
  }, STORM_HOLD_MS);
}

function createLabelStyles(): Readonly<{
  hero: readonly Readonly<TextStyleOptions>[];
  field: Readonly<TextStyleOptions>;
  fallback: Readonly<TextStyleOptions>;
}> {
  return Object.freeze({
    hero: Object.freeze(
      LANGUAGE_SAMPLES.map((entry) =>
        Object.freeze({
          fontFamily: MULTILINGUAL_STACK,
          fontSize: HERO_FONT_SIZE,
          fontWeight: "500",
          fill: entry.fill,
        }),
      ),
    ),
    field: Object.freeze({
      fontFamily: MULTILINGUAL_STACK,
      fontSize: FIELD_FONT_SIZE,
      fontWeight: "500",
      fill: FIELD_FILL,
    }),
    fallback: Object.freeze({
      fontFamily: MULTILINGUAL_STACK,
      fontSize: FIELD_FONT_SIZE,
      fontWeight: "500",
      fill: FALLBACK_FILL,
    }),
  });
}

function admitLabelIndices(
  nextLayer: TextLayer,
  indices: readonly number[],
  styles: ReturnType<typeof createLabelStyles>,
  movingIndex: number,
): number {
  if (indices.length === 0) return movingIndex;
  const specs = indices.map((index) => labelSpec(index, styles));
  const ids = nextLayer.createMany(specs);
  for (let localIndex = 0; localIndex < ids.length; localIndex += 1) {
    const index = indices[localIndex];
    const id = ids[localIndex];
    if (index === undefined || id === undefined || !isMoverIndex(index)) continue;
    if (movingIndex >= MOVING_COUNT) continue;
    captureMovingLabel(id, index, movingIndex);
    movingIndex += 1;
  }
  return movingIndex;
}

function labelSpec(index: number, styles: ReturnType<typeof createLabelStyles>): TextLabelSpec {
  const { sample, showcase, hero } = resolveLanguageSample(index);
  const position = labelPosition(index);
  return {
    text: sample.text,
    x: position.x,
    y: position.y,
    style: resolveLabelStyle(sample, hero, styles),
    ...(hero || showcase ? shapingFor(sample) : {}),
  };
}

function resolveLabelStyle(
  sample: Readonly<LanguageSample>,
  hero: boolean,
  styles: ReturnType<typeof createLabelStyles>,
): Readonly<TextStyleOptions> {
  if (!hero) return sample.custom ? styles.field : styles.fallback;
  const languageIndex = LANGUAGE_SAMPLES.indexOf(sample);
  return styles.hero[languageIndex] ?? styles.field;
}

function shapingFor(
  sample: Readonly<LanguageSample>,
): Readonly<{ shaping: Readonly<TextShapingOptions> }> | Record<string, never> {
  if (sample.shaping === undefined) return {};
  return { shaping: sample.shaping };
}

function captureMovingLabel(id: TextId, labelIndex: number, movingIndex: number): void {
  const ids = movingIds;
  const first = firstPositions;
  const second = secondPositions;
  if (ids === undefined || first === undefined || second === undefined) return;
  const position = labelPosition(labelIndex);
  ids[movingIndex] = id;
  first[movingIndex * 2] = position.x;
  first[movingIndex * 2 + 1] = position.y;
  second[movingIndex * 2] = position.x + Math.sin(movingIndex * 0.17) * 110;
  second[movingIndex * 2 + 1] = position.y + Math.cos(movingIndex * 0.11) * 72;
}

function startRuntime(
  nextApp: Application,
  nextViewport: Viewport,
  nextWorldWidth: number,
  nextWorldHeight: number,
  runId: number,
): void {
  let frameCount = 0;
  let debugTicks = 0;
  let lastFpsSample = performance.now();
  let lastHudUpdate = 0;

  nextApp.ticker.add(() => {
    nextViewport.emit("frame-end", nextViewport);
    frameCount += 1;
    // #region agent log
    debugTicks += 1;
    tickerFrames.value = debugTicks;
    const nextLayer = layer;
    if (debugTicks <= 5 && nextLayer !== undefined) {
      logDemoSnapshot("E", `ticker-${String(debugTicks)}`, nextApp, nextViewport, nextLayer);
    }
    // #endregion
    const now = performance.now();
    if (now - lastFpsSample >= 500) {
      fps.value = Math.round((frameCount * 1_000) / (now - lastFpsSample)).toString();
      frameCount = 0;
      lastFpsSample = now;
    }
    if (now - lastHudUpdate >= 200) {
      updateHud();
      lastHudUpdate = now;
    }
  });

  resizeObserver = new ResizeObserver(() => {
    window.requestAnimationFrame(() => {
      const host = canvasHost.value;
      if (isStale(runId) || host === undefined) return;
      nextApp.renderer.resize(Math.max(host.clientWidth, 320), Math.max(host.clientHeight, 320));
      nextViewport.resize(
        nextApp.screen.width,
        nextApp.screen.height,
        nextWorldWidth,
        nextWorldHeight,
      );
      nextViewport.emit("frame-end", nextViewport);
    });
  });
  if (canvasHost.value !== undefined) resizeObserver.observe(canvasHost.value);

  intersectionObserver = new IntersectionObserver(
    ([entry]) => {
      if (isStale(runId)) return;
      demoVisible = entry?.isIntersecting ?? true;
      if (demoVisible) nextApp.start();
      else nextApp.stop();
    },
    { rootMargin: "160px" },
  );
  if (canvasHost.value !== undefined) intersectionObserver.observe(canvasHost.value);
}

async function runPositionStorm(runId: number): Promise<void> {
  const nextLayer = layer;
  const ids = movingIds;
  const first = firstPositions;
  const second = secondPositions;
  if (
    state.value !== "ready" ||
    isStale(runId) ||
    !stormEnabled.value ||
    !demoVisible ||
    stormPending ||
    nextLayer === undefined ||
    ids === undefined ||
    first === undefined ||
    second === undefined
  ) {
    return;
  }
  stormPending = true;
  const startedAt = performance.now();
  try {
    nextLayer.updatePositions(ids, useSecondPositions ? second : first);
    useSecondPositions = !useSecondPositions;
    await nextLayer.commit();
    stormCommits.value += 1;
    updateDuration.value = `${(performance.now() - startedAt).toFixed(2)} ms`;
    // #region agent log
    if (
      (stormCommits.value === 1 || stormCommits.value === 2) &&
      app !== undefined &&
      viewport !== undefined
    ) {
      logDemoSnapshot(
        "O",
        stormCommits.value === 1 ? "first-held-storm" : "storm-plus-1",
        app,
        viewport,
        nextLayer,
      );
    }
    // #endregion
  } finally {
    if (!isStale(runId)) stormPending = false;
  }
}

function updateHud(overrideViewportDuration?: number): void {
  const nextLayer = layer;
  const nextBinding = binding;
  if (nextLayer === undefined || nextBinding === undefined) return;
  const stats = nextLayer.stats;
  resident.value = numberFormat.format(stats.labelCount);
  visible.value = numberFormat.format(stats.visibleLabelCount);
  revision.value = numberFormat.format(Number(stats.revision));
  glyphs.value = numberFormat.format(stats.submittedGlyphs);
  drawCalls.value = stats.drawCalls;
  atlasTextures.value = stats.atlasTextureCount;
  cullPath.value = stats.cullPath;
  palettePath.value = stats.palettePath;
  viewportDuration.value = `${(
    overrideViewportDuration ?? nextBinding.stats.lastDurationMs
  ).toFixed(2)} ms`;
}

function toggleStorm(): void {
  stormEnabled.value = !stormEnabled.value;
}

async function toggleAllVisibility(): Promise<void> {
  const nextLayer = layer;
  if (state.value !== "ready" || visibilityPending.value || nextLayer === undefined) return;
  const runId = rendererRun;
  const show = !allVisible.value;
  visibilityPending.value = true;
  const startedAt = performance.now();
  try {
    if (show) nextLayer.showAll();
    else nextLayer.hideAll();
    await nextLayer.commit();
    if (isStale(runId) || layer !== nextLayer) return;
    allVisible.value = show;
    visibilityDuration.value = `${(performance.now() - startedAt).toFixed(2)} ms`;
    updateHud();
  } finally {
    if (!isStale(runId)) visibilityPending.value = false;
  }
}

function applyRotation(): void {
  const nextViewport = viewport;
  if (nextViewport === undefined) return;
  nextViewport.rotation = (rotationDegrees.value * Math.PI) / 180;
  emitCameraChange(nextViewport, true);
}

function resetCamera(): void {
  const nextViewport = viewport;
  if (nextViewport === undefined) return;
  const home = cameraHome();
  nextViewport.rotation = 0;
  rotationDegrees.value = 0;
  nextViewport.setZoom(INITIAL_ZOOM, true);
  nextViewport.moveCenter(home.x, home.y);
  emitCameraChange(nextViewport, true);
}

function handleKeyboard(event: KeyboardEvent): void {
  const nextViewport = viewport;
  if (nextViewport === undefined) return;
  const panStep = 52;
  let zoomed = false;
  switch (event.key) {
    case "ArrowLeft":
      nextViewport.position.x += panStep;
      break;
    case "ArrowRight":
      nextViewport.position.x -= panStep;
      break;
    case "ArrowUp":
      nextViewport.position.y += panStep;
      break;
    case "ArrowDown":
      nextViewport.position.y -= panStep;
      break;
    case "+":
    case "=":
      nextViewport.setZoom(Math.min(nextViewport.scale.x * 1.15, 3), true);
      zoomed = true;
      break;
    case "-":
      nextViewport.setZoom(Math.max(nextViewport.scale.x / 1.15, 0.08), true);
      zoomed = true;
      break;
    case "0":
      resetCamera();
      event.preventDefault();
      return;
    default:
      return;
  }
  event.preventDefault();
  emitCameraChange(nextViewport, zoomed);
}

function emitCameraChange(nextViewport: Viewport, zoomed: boolean): void {
  nextViewport.emit("moved", { viewport: nextViewport, type: "drag" });
  if (zoomed) nextViewport.emit("zoomed", { viewport: nextViewport, type: "wheel" });
  nextViewport.emit("frame-end", nextViewport);
}

function cleanup(): void {
  if (stormTimer !== undefined) window.clearInterval(stormTimer);
  if (stormHoldTimer !== undefined) window.clearTimeout(stormHoldTimer);
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  binding?.destroy();
  layer?.destroy();
  viewport?.destroy({ children: true });
  app?.destroy(true);
  computeCullGpuDevice?.destroy();
  stormTimer = undefined;
  stormHoldTimer = undefined;
  resizeObserver = undefined;
  intersectionObserver = undefined;
  binding = undefined;
  layer = undefined;
  viewport = undefined;
  app = undefined;
  computeCullGpuDevice = undefined;
  movingIds = undefined;
  firstPositions = undefined;
  secondPositions = undefined;
  useSecondPositions = true;
  stormPending = false;
  demoVisible = true;
}

function formatRenderer(value: string): string {
  if (value === "webgpu") return "WebGPU";
  if (value === "webgl") return "WebGL 2";
  return value;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function agentLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  const entry = {
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
  const line = JSON.stringify(entry);
  console.info("__AGENT_LOG__", line);
  if (typeof fetch !== "function") return;
  const send = (url: string): void => {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line,
      keepalive: true,
      mode: "cors",
    }).catch(() => undefined);
  };
  send("http://127.0.0.1:7733/");
  send("/agent-debug-log");
}

function sampleFramebuffer(nextApp: Application): Record<string, unknown> {
  const renderer = nextApp.renderer;
  if (!("gl" in renderer)) return { adapter: "not-webgl" };
  const gl = (renderer as { gl: WebGL2RenderingContext }).gl;
  if (gl.isContextLost()) return { lost: true };
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const center = new Uint8Array(4);
  const corner = new Uint8Array(4);
  gl.readPixels(
    Math.floor(width / 2),
    Math.floor(height / 2),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    center,
  );
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, corner);
  const glError = gl.getError();
  gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  return {
    lost: false,
    width,
    height,
    center: [center[0], center[1], center[2], center[3]],
    corner: [corner[0], corner[1], corner[2], corner[3]],
    glError,
  };
}

function meshSnapshot(child: Container): Record<string, unknown> {
  const mesh = child as Container & {
    isRenderable?: boolean;
    culled?: boolean;
    localDisplayStatus?: number;
    groupAlpha?: number;
    geometry?: {
      instanceCount?: number;
      bounds?: { x: number; y: number; width: number; height: number };
    };
    shader?: {
      resources?: { uPrototype?: { uid?: number }; uTransformTexture?: { uid?: number } };
      groups?: Record<string, { resources: unknown }>;
    };
  };
  const bounds = mesh.geometry?.bounds;
  return {
    label: child.label,
    destroyed: child.destroyed,
    parent: child.parent?.label,
    visible: child.visible,
    worldVisible: child.worldVisible,
    renderable: child.renderable,
    isRenderable: mesh.isRenderable,
    culled: mesh.culled,
    localDisplayStatus: mesh.localDisplayStatus,
    groupAlpha: mesh.groupAlpha,
    wt: {
      tx: child.worldTransform.tx,
      ty: child.worldTransform.ty,
      a: child.worldTransform.a,
      d: child.worldTransform.d,
    },
    instanceCount: mesh.geometry?.instanceCount,
    bounds:
      bounds === undefined
        ? undefined
        : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    protoUid: mesh.shader?.resources?.uPrototype?.uid,
    paletteUid: mesh.shader?.resources?.uTransformTexture?.uid,
    group99Null: mesh.shader?.groups?.[99]?.resources == null,
  };
}

function logDemoSnapshot(
  hypothesisId: string,
  phase: string,
  nextApp: Application,
  nextViewport: Viewport,
  nextLayer: TextLayer,
): void {
  const bounds = nextViewport.getVisibleBounds();
  const meshes = nextLayer.children.map((child) => meshSnapshot(child));
  const stats = nextLayer.stats;
  agentLog(hypothesisId, `GlyphflowDemo.client.vue:${phase}`, phase, {
    contextLost:
      "gl" in nextApp.renderer
        ? (nextApp.renderer as { gl: WebGL2RenderingContext }).gl.isContextLost()
        : "not-webgl",
    pixels: sampleFramebuffer(nextApp),
    viewport: {
      centerX: nextViewport.center.x,
      centerY: nextViewport.center.y,
      scale: nextViewport.scale.x,
      rotation: nextViewport.rotation,
      x: nextViewport.position.x,
      y: nextViewport.position.y,
      visible: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
    },
    layer: {
      parent: nextLayer.parent?.label,
      inViewport: nextLayer.parent === nextViewport,
      childCount: nextLayer.children.length,
      visible: nextLayer.visible,
      worldVisible: nextLayer.worldVisible,
      renderable: nextLayer.renderable,
      wt: {
        tx: nextLayer.worldTransform.tx,
        ty: nextLayer.worldTransform.ty,
        a: nextLayer.worldTransform.a,
        d: nextLayer.worldTransform.d,
      },
    },
    meshes,
    stageChildren: nextApp.stage.children.map((child) => child.label),
    viewportChildCount: nextViewport.children.length,
    lastObjectRendered: nextApp.renderer.lastObjectRendered?.label,
    tickerStarted: nextApp.ticker.started,
    canvasConnected: nextApp.canvas.isConnected,
    canvasParentIsHost: nextApp.canvas.parentElement === canvasHost.value,
    stats: {
      labelCount: stats.labelCount,
      visible: stats.visibleLabelCount,
      submittedGlyphs: stats.submittedGlyphs,
      drawCalls: stats.drawCalls,
      lastUploadMs: stats.lastUploadMs,
      transformUploadBytes: stats.transformUploadBytes,
      instanceUploadBytes: stats.instanceUploadBytes,
      lastCommitDirtyLabels: stats.lastCommitDirtyLabels,
    },
  });
}

async function installDemoFaces(fonts: readonly Readonly<LoadedFontAsset>[]): Promise<void> {
  await Promise.all(
    fonts.map(async (font) => {
      const copy = new Uint8Array(font.bytes.byteLength);
      copy.set(font.bytes);
      const face = new FontFace(font.family, copy);
      await face.load();
      document.fonts.add(face);
    }),
  );
}

async function loadCustomFonts(): Promise<readonly Readonly<LoadedFontAsset>[]> {
  customFontsPromise ??= Promise.all(
    CUSTOM_FONTS.map(async (font) => {
      const response = await fetch(font.url);
      if (!response.ok) {
        throw new Error(
          `Custom font request failed with ${String(response.status)} ${response.statusText}: ${font.family}`,
        );
      }
      return Object.freeze({
        family: font.family,
        bytes: new Uint8Array(await response.arrayBuffer()),
      });
    }),
  ).then((fonts) => Object.freeze(fonts));
  return customFontsPromise;
}
</script>

<template>
  <section
    class="demo-shell"
    data-testid="glyphflow-demo"
    :data-demo-state="state"
    :data-demo-error="state === 'error' ? errorMessage : ''"
    :data-renderer-backend="activeBackend"
    :data-cull-path="cullPath"
    :data-palette-path="palettePath"
    :data-first-frame="firstFrameReady"
    :data-storm-phase="stormPhase"
    :data-storm-commits="stormCommits"
    :data-storm-hold-ms="STORM_HOLD_MS"
    :data-ticker-frames="tickerFrames"
    :data-pending-glyphs="pendingGlyphs"
    :data-draw-calls="drawCalls"
    :data-atlas-textures="atlasTextures"
    :data-all-visible="allVisible"
    aria-labelledby="demo-title"
  >
    <header class="demo-header">
      <div>
        <p class="demo-kicker">WEBGL · WEBGPU</p>
        <h2 id="demo-title">A million labels, live</h2>
      </div>
      <div class="demo-header-actions">
        <fieldset class="renderer-picker">
          <legend class="sr-only">Renderer backend</legend>
          <div class="renderer-picker-options">
            <button
              type="button"
              data-testid="backend-webgl"
              :aria-pressed="requestedBackend === 'webgl'"
              :disabled="state === 'booting'"
              @click="selectBackend('webgl')"
            >
              WebGL 2
            </button>
            <button
              type="button"
              data-testid="backend-webgpu"
              :aria-pressed="requestedBackend === 'webgpu'"
              :disabled="state === 'booting' || webGpuCapability !== 'available'"
              @click="selectBackend('webgpu')"
            >
              WebGPU
            </button>
          </div>
          <span class="renderer-capability" data-testid="webgpu-capability">
            {{ webGpuCapabilityLabel }}
          </span>
        </fieldset>
        <span class="live-state" :class="{ ready: state === 'ready', failed: state === 'error' }">
          <span aria-hidden="true" />
          <span aria-live="polite">{{ stateLabel }}</span>
        </span>
      </div>
    </header>

    <div
      ref="canvasHost"
      class="demo-canvas"
      role="group"
      tabindex="0"
      aria-label="Interactive glyph viewport. Use arrow keys to pan, plus and minus to zoom, and zero to reset."
      @keydown="handleKeyboard"
    >
      <div v-if="state === 'error'" class="demo-loading">
        <p>Renderer setup failed</p>
        <span>{{ errorMessage }}</span>
      </div>
      <div v-else-if="!firstFrameReady" class="demo-loading demo-loading-quiet">
        <p>{{ bootStage }}</p>
        <span>Placing the first labels</span>
      </div>
      <div v-else-if="state === 'booting'" class="demo-boot-chip" aria-live="polite">
        {{ bootChip }}
      </div>
      <div class="canvas-corner-label" aria-hidden="true">DRAG · ⌘/CTRL + WHEEL · PINCH</div>
    </div>

    <div class="demo-readout">
      <dl class="demo-metrics demo-metrics-primary">
        <div>
          <dt>Resident</dt>
          <dd data-testid="resident-count">{{ resident }}</dd>
        </div>
        <div>
          <dt>Visible</dt>
          <dd data-testid="visible-count">{{ visible }}</dd>
        </div>
        <div>
          <dt>Storm</dt>
          <dd data-testid="storm-commit">{{ updateDuration }}</dd>
        </div>
        <div>
          <dt>Renderer</dt>
          <dd data-testid="renderer-adapter">{{ rendererName }}</dd>
        </div>
        <div>
          <dt>Cull path</dt>
          <dd data-testid="cull-path">{{ cullPath }}</dd>
        </div>
        <div>
          <dt>Palette path</dt>
          <dd data-testid="palette-path">{{ palettePath }}</dd>
        </div>
        <div>
          <dt>FPS</dt>
          <dd data-testid="demo-fps">{{ fps }}</dd>
        </div>
      </dl>

      <details class="demo-engine">
        <summary>More engine stats</summary>
        <dl class="demo-metrics demo-metrics-secondary">
          <div>
            <dt>Moving / 100 ms</dt>
            <dd>{{ numberFormat.format(MOVING_COUNT) }}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd data-testid="revision-count">{{ revision }}</dd>
          </div>
          <div>
            <dt>Show / hide commit</dt>
            <dd data-testid="visibility-duration">{{ visibilityDuration }}</dd>
          </div>
          <div>
            <dt>Viewport commit</dt>
            <dd>{{ viewportDuration }}</dd>
          </div>
          <div>
            <dt>Submitted glyphs</dt>
            <dd>{{ glyphs }}</dd>
          </div>
          <div>
            <dt>Draw calls / atlas</dt>
            <dd>
              <span data-testid="draw-call-count">{{ numberFormat.format(drawCalls) }}</span>
              /
              <span data-testid="atlas-texture-count">{{
                numberFormat.format(atlasTextures)
              }}</span>
            </dd>
          </div>
          <div>
            <dt>Font pipeline</dt>
            <dd data-testid="custom-font-status">{{ fontStatus }}</dd>
          </div>
          <div>
            <dt>Font / samples</dt>
            <dd>{{ fontFootprint }} · {{ LANGUAGE_SAMPLES.length }} samples</dd>
          </div>
        </dl>
      </details>

      <div class="demo-controls">
        <button type="button" :aria-pressed="stormEnabled" @click="toggleStorm">
          {{ stormEnabled ? "Pause movement" : "Start movement" }}
        </button>
        <button
          type="button"
          :aria-label="allVisible ? 'Hide all labels' : 'Show all labels'"
          :disabled="state !== 'ready' || visibilityPending"
          @click="toggleAllVisibility"
        >
          {{ allVisible ? "Hide all" : "Show all" }}
        </button>
        <button type="button" @click="resetCamera">Reset camera</button>
        <label>
          <span>Rotation</span>
          <input
            v-model.number="rotationDegrees"
            type="range"
            min="-35"
            max="35"
            step="1"
            @input="applyRotation"
          />
          <output>{{ rotationDegrees }}°</output>
        </label>
      </div>
    </div>
  </section>
</template>
