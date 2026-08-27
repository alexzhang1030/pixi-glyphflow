<script setup lang="ts">
import { MSDF } from "@zappar/msdf-generator";
import msdfWasmUrl from "@zappar/msdf-generator/msdfgen_wasm.wasm?url";
import msdfWorkerUrl from "@zappar/msdf-generator/worker.js?worker&url";
import {
  requestComputeCullGpu,
  TextLayer,
  type CullPath,
  type TextId,
  type TextLabelSpec,
  type TextShapingOptions,
} from "pixi-glyphflow";
import { charsetSdfPrebuilt, mergePrebuilt } from "pixi-glyphflow/prebuilt";
import { bindViewport, type ViewportBinding } from "pixi-glyphflow/viewport";
import { Viewport } from "pixi-viewport";
import { Application, type TextStyleOptions } from "pixi.js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const LABEL_COUNT = 1_000_000;
const MOVING_COUNT = 100_000;
const COLUMNS = 1_000;
const COLUMN_SPACING = 152;
const ROW_SPACING = 30;
const CHUNK_SIZE = 25_000;
const STORM_INTERVAL_MS = 100;
const INITIAL_ZOOM = 0.24;
const MULTILINGUAL_STACK = "Glyphflow multilingual";
const SHOWCASE_ROW_INTERVAL = 64;
const CUSTOM_FONTS = Object.freeze([
  { family: "Glyphflow CJKV Demo", url: "/fonts/noto-sans-cjkv-demo.ttf" },
  { family: "Glyphflow Arabic Demo", url: "/fonts/noto-sans-arabic-demo.ttf" },
  { family: "Glyphflow Devanagari Demo", url: "/fonts/noto-sans-devanagari-demo.ttf" },
  { family: "Glyphflow Hebrew Demo", url: "/fonts/noto-sans-hebrew-demo.ttf" },
  { family: "Glyphflow Thai Demo", url: "/fonts/noto-sans-thai-demo.ttf" },
]);
const SYSTEM_FONT_FAMILIES = Object.freeze([
  "system-ui",
  "PingFang SC",
  "Hiragino Sans",
  "Apple SD Gothic Neo",
  "Geeza Pro",
  "Kohinoor Devanagari",
  "Arial Hebrew",
  "Thonburi",
  "Arial Unicode MS",
  "sans-serif",
]);

interface LanguageSample {
  readonly text: string;
  readonly custom: boolean;
  readonly shaping?: Readonly<TextShapingOptions>;
}

interface LoadedFontAsset {
  readonly family: string;
  readonly bytes: Uint8Array;
}

const LANGUAGE_SAMPLES: readonly Readonly<LanguageSample>[] = Object.freeze([
  sample("简体中文 · 上海字流", true, "zh-CN", "Hans"),
  sample("繁體中文 · 臺北字型", true, "zh-TW", "Hant"),
  sample("日本語 · 東京テキスト", true, "ja", "Jpan"),
  sample("한국어 · 서울글리프", true, "ko", "Kore"),
  sample("Tiếng Việt · Hà Nội", true, "vi", "Latn"),
  sample("العربية · مرحبا", true, "ar", "Arab", "rtl"),
  sample("हिन्दी · नमस्ते", true, "hi", "Deva"),
  sample("עברית · שלום", true, "he", "Hebr", "rtl"),
  sample("ไทย · สวัสดี", true, "th", "Thai"),
  sample("Русский · Привет", true, "ru", "Cyrl"),
  sample("Ελληνικά · Γεια", true, "el", "Grek"),
  Object.freeze({ text: "Emoji · 🌏 ✦", custom: false }),
]);
const DEMO_CHARSETS: readonly Readonly<{ family: string; charset: string }>[] = Object.freeze([
  {
    family: "Glyphflow CJKV Demo",
    charset: [
      "简体中文 · 上海字流",
      "繁體中文 · 臺北字型",
      "日本語 · 東京テキスト",
      "한국어 · 서울글리프",
      "Tiếng Việt · Hà Nội",
      "Русский · Привет",
      "Ελληνικά · Γεια",
    ].join(""),
  },
  { family: "Glyphflow Arabic Demo", charset: "العربية · مرحبا" },
  { family: "Glyphflow Devanagari Demo", charset: "हिन्दी · नमस्ते" },
  { family: "Glyphflow Hebrew Demo", charset: "עברית · שלום" },
  { family: "Glyphflow Thai Demo", charset: "ไทย · สวัสดี" },
]);
const numberFormat = new Intl.NumberFormat("en-US");

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
const errorMessage = ref("");
const loadedPercent = ref(0);
const bootStage = ref("Allocating labels");
const requestedBackend = ref<RendererBackend>("webgl");
const activeBackend = ref<RendererBackend>();
const webGpuCapability = ref<WebGpuCapability>("checking");
const stormEnabled = ref(true);
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

let app: Application | undefined;
let computeCullGpuDevice: GPUDevice | undefined;
let viewport: Viewport | undefined;
let layer: TextLayer | undefined;
let binding: ViewportBinding | undefined;
let resizeObserver: ResizeObserver | undefined;
let intersectionObserver: IntersectionObserver | undefined;
let stormTimer: number | undefined;
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
  loadedPercent.value = 0;
  bootStage.value = "Allocating labels";
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
  allVisible.value = true;
  visibilityPending.value = false;
  rotationDegrees.value = 0;
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

  const worldWidth = COLUMNS * COLUMN_SPACING;
  const worldHeight = Math.ceil(LABEL_COUNT / COLUMNS) * ROW_SPACING;
  const nextViewport = new Viewport({
    screenWidth: nextApp.screen.width,
    screenHeight: nextApp.screen.height,
    worldWidth,
    worldHeight,
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
  nextViewport.moveCenter(worldWidth / 2, worldHeight / 2);
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
      padding: 48,
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

  movingIds = new Float64Array(MOVING_COUNT);
  firstPositions = new Float32Array(MOVING_COUNT * 2);
  secondPositions = new Float32Array(MOVING_COUNT * 2);
  const customStyle: Readonly<TextStyleOptions> = Object.freeze({
    fontFamily: MULTILINGUAL_STACK,
    fontSize: 14,
    fontWeight: "500",
    fill: 0xe8f6ff,
  });
  const fallbackStyle: Readonly<TextStyleOptions> = Object.freeze({
    fontFamily: MULTILINGUAL_STACK,
    fontSize: 13,
    fontWeight: "500",
    fill: 0x9fb3c0,
  });
  let movingIndex = 0;

  for (let start = 0; start < LABEL_COUNT; start += CHUNK_SIZE) {
    if (isStale(runId)) return;
    const count = Math.min(CHUNK_SIZE, LABEL_COUNT - start);
    const specs = Array.from({ length: count }, (_, localIndex): TextLabelSpec => {
      const index = start + localIndex;
      const { sample, showcase } = resolveLanguageSample(index);
      if (sample === undefined) throw new Error("Language sample list is empty");
      return {
        text: sample.text,
        x: (index % COLUMNS) * COLUMN_SPACING,
        y: Math.floor(index / COLUMNS) * ROW_SPACING,
        style: sample.custom ? customStyle : fallbackStyle,
        ...(showcase && sample.shaping !== undefined ? { shaping: sample.shaping } : {}),
      };
    });
    const ids = nextLayer.createMany(specs);
    for (let localIndex = 0; localIndex < ids.length; localIndex += 1) {
      const index = start + localIndex;
      if (index % (LABEL_COUNT / MOVING_COUNT) !== 0 || movingIndex >= MOVING_COUNT) continue;
      const id = ids[localIndex];
      if (id === undefined) continue;
      captureMovingLabel(id, index, movingIndex);
      movingIndex += 1;
    }
    loadedPercent.value = Math.round(((start + count) / LABEL_COUNT) * 100);
    await nextFrame();
  }

  bootStage.value = "Shaping visible labels";
  const initialCommit = nextLayer.commit();
  resident.value = numberFormat.format(nextLayer.stats.labelCount);
  visible.value = numberFormat.format(nextLayer.stats.visibleLabelCount);
  bootStage.value = `Rasterizing ${visible.value} visible labels`;
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
  nextApp.start();
  startRuntime(nextApp, nextViewport, worldWidth, worldHeight, runId);
}

function captureMovingLabel(id: TextId, labelIndex: number, movingIndex: number): void {
  const ids = movingIds;
  const first = firstPositions;
  const second = secondPositions;
  if (ids === undefined || first === undefined || second === undefined) return;
  const x = (labelIndex % COLUMNS) * COLUMN_SPACING;
  const y = Math.floor(labelIndex / COLUMNS) * ROW_SPACING;
  ids[movingIndex] = id;
  first[movingIndex * 2] = x;
  first[movingIndex * 2 + 1] = y;
  second[movingIndex * 2] = x + Math.sin(movingIndex * 0.17) * 110;
  second[movingIndex * 2 + 1] = y + Math.cos(movingIndex * 0.11) * 72;
}

function startRuntime(
  nextApp: Application,
  nextViewport: Viewport,
  worldWidth: number,
  worldHeight: number,
  runId: number,
): void {
  let frameCount = 0;
  let lastFpsSample = performance.now();
  let lastHudUpdate = 0;

  nextApp.ticker.add(() => {
    nextViewport.emit("frame-end", nextViewport);
    frameCount += 1;
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

  stormTimer = window.setInterval(() => void runPositionStorm(runId), STORM_INTERVAL_MS);
  resizeObserver = new ResizeObserver(() => {
    window.requestAnimationFrame(() => {
      const host = canvasHost.value;
      if (isStale(runId) || host === undefined) return;
      nextApp.renderer.resize(Math.max(host.clientWidth, 320), Math.max(host.clientHeight, 320));
      nextViewport.resize(nextApp.screen.width, nextApp.screen.height, worldWidth, worldHeight);
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
    updateDuration.value = `${(performance.now() - startedAt).toFixed(2)} ms`;
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
  nextViewport.rotation = 0;
  rotationDegrees.value = 0;
  nextViewport.setZoom(INITIAL_ZOOM, true);
  nextViewport.moveCenter(
    (COLUMNS * COLUMN_SPACING) / 2,
    (LABEL_COUNT / COLUMNS / 2) * ROW_SPACING,
  );
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
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  binding?.destroy();
  layer?.destroy();
  viewport?.destroy({ children: true });
  app?.destroy(true);
  computeCullGpuDevice?.destroy();
  stormTimer = undefined;
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

function sample(
  text: string,
  custom: boolean,
  language: string,
  script: string,
  direction: "ltr" | "rtl" = "ltr",
): Readonly<LanguageSample> {
  return Object.freeze({
    text,
    custom,
    shaping: Object.freeze({
      direction,
      language,
      script,
      features: Object.freeze(["kern", "liga"]),
      ...(custom ? { variations: Object.freeze({ wght: 560 }) } : {}),
    }),
  });
}

function resolveLanguageSample(
  index: number,
): Readonly<{ sample: Readonly<LanguageSample> | undefined; showcase: boolean }> {
  const row = Math.floor(index / COLUMNS);
  const column = index % COLUMNS;
  const showcaseStart = Math.floor((COLUMNS - LANGUAGE_SAMPLES.length) / 2);
  const showcaseIndex = column - showcaseStart;
  const showcase =
    row % SHOWCASE_ROW_INTERVAL === 0 &&
    showcaseIndex >= 0 &&
    showcaseIndex < LANGUAGE_SAMPLES.length;
  return Object.freeze({
    sample: showcase
      ? LANGUAGE_SAMPLES[showcaseIndex]
      : LANGUAGE_SAMPLES[index % LANGUAGE_SAMPLES.length],
    showcase,
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
    :data-renderer-backend="activeBackend"
    :data-cull-path="cullPath"
    :data-pending-glyphs="pendingGlyphs"
    :data-draw-calls="drawCalls"
    :data-atlas-textures="atlasTextures"
    :data-all-visible="allVisible"
    aria-labelledby="demo-title"
  >
    <header class="demo-header">
      <div>
        <p class="demo-kicker">LIVE WEBGL / WEBGPU · CUSTOM CJKV FONT</p>
        <h2 id="demo-title">Multilingual viewport pressure test</h2>
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
      <div v-if="state !== 'ready'" class="demo-loading">
        <p>{{ state === "error" ? "Renderer setup failed" : bootStage }}</p>
        <span>{{
          state === "error" ? errorMessage : `${loadedPercent}% of labels allocated`
        }}</span>
      </div>
      <div class="canvas-corner-label" aria-hidden="true">DRAG · ⌘/CTRL + WHEEL · PINCH</div>
    </div>

    <div class="demo-readout">
      <dl class="demo-metrics">
        <div>
          <dt>Resident</dt>
          <dd data-testid="resident-count">{{ resident }}</dd>
        </div>
        <div>
          <dt>Visible</dt>
          <dd data-testid="visible-count">{{ visible }}</dd>
        </div>
        <div>
          <dt>Moving / 100 ms</dt>
          <dd>{{ numberFormat.format(MOVING_COUNT) }}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd data-testid="revision-count">{{ revision }}</dd>
        </div>
        <div>
          <dt>Position commit</dt>
          <dd>{{ updateDuration }}</dd>
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
            <span data-testid="atlas-texture-count">{{ numberFormat.format(atlasTextures) }}</span>
          </dd>
        </div>
        <div>
          <dt>Renderer / FPS</dt>
          <dd>
            <span data-testid="renderer-adapter">{{ rendererName }}</span> · {{ fps }} FPS
          </dd>
        </div>
        <div>
          <dt>Cull path</dt>
          <dd data-testid="cull-path">{{ cullPath }}</dd>
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
