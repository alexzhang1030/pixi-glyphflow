<script setup lang="ts">
import { TextLayer, type TextId, type TextLabelSpec } from "pixi-glyphflow";
import { bindViewport, type ViewportBinding } from "pixi-glyphflow/viewport";
import { Viewport } from "pixi-viewport";
import { Application, type TextStyleOptions } from "pixi.js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const LABEL_COUNT = 20_000;
const MOVING_COUNT = 2_000;
const COLUMNS = 200;
const COLUMN_SPACING = 44;
const ROW_SPACING = 26;
const CHUNK_SIZE = 2_000;
const STORM_INTERVAL_MS = 100;
const INITIAL_ZOOM = 0.24;
const numberFormat = new Intl.NumberFormat("en-US");

type RendererBackend = "webgl" | "webgpu";
type WebGpuCapability = "checking" | "available" | "unavailable";

const canvasHost = ref<HTMLElement>();
const state = ref<"booting" | "ready" | "error">("booting");
const errorMessage = ref("");
const loadedPercent = ref(0);
const requestedBackend = ref<RendererBackend>("webgl");
const activeBackend = ref<RendererBackend>();
const webGpuCapability = ref<WebGpuCapability>("checking");
const stormEnabled = ref(true);
const rotationDegrees = ref(0);
const resident = ref("0");
const visible = ref("0");
const revision = ref("0");
const glyphs = ref("0");
const updateDuration = ref("0.00 ms");
const viewportDuration = ref("0.00 ms");
const fps = ref("0");
const rendererName = computed(() => formatRenderer(activeBackend.value ?? requestedBackend.value));

const webGpuCapabilityLabel = computed(() => {
  if (webGpuCapability.value === "available") return "WebGPU available";
  if (webGpuCapability.value === "unavailable") return "WebGPU unavailable";
  return "Checking WebGPU";
});

const stateLabel = computed(() => {
  if (state.value === "ready") return `${rendererName.value} live`;
  if (state.value === "error") return "Error";
  return `Loading ${loadedPercent.value}%`;
});

let app: Application | undefined;
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

onMounted(() => {
  stormEnabled.value = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestedBackend.value = readInitialBackend();
  void probeWebGpu();
  void restartRenderer(requestedBackend.value);
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

function readInitialBackend(): RendererBackend {
  return new URL(window.location.href).searchParams.get("renderer") === "webgpu"
    ? "webgpu"
    : "webgl";
}

function updateRendererQuery(backend: RendererBackend): void {
  const url = new URL(window.location.href);
  url.searchParams.set("renderer", backend);
  window.history.replaceState(window.history.state, "", url);
}

function resetHud(): void {
  loadedPercent.value = 0;
  resident.value = "0";
  visible.value = "0";
  revision.value = "0";
  glyphs.value = "0";
  updateDuration.value = "0.00 ms";
  viewportDuration.value = "0.00 ms";
  fps.value = "0";
  rotationDegrees.value = 0;
}

function isStale(runId: number): boolean {
  return destroyed || runId !== rendererRun;
}

async function initialize(backend: RendererBackend, runId: number): Promise<void> {
  const host = canvasHost.value;
  if (host === undefined) throw new Error("Demo canvas host is unavailable");

  const nextApp = new Application();
  await nextApp.init({
    width: Math.max(host.clientWidth, 320),
    height: Math.max(host.clientHeight, 320),
    preference: [backend],
    preferWebGLVersion: 2,
    powerPreference: "high-performance",
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    background: "#080d12",
  });
  if (isStale(runId)) {
    nextApp.destroy(true);
    return;
  }
  app = nextApp;
  nextApp.stop();
  nextApp.canvas.className = "demo-canvas-element";
  nextApp.canvas.setAttribute("role", "img");
  nextApp.canvas.setAttribute("aria-label", "Twenty thousand interactive glyph labels");
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

  const nextLayer = new TextLayer({
    renderer: nextApp.renderer,
    initialCapacity: LABEL_COUNT,
    culling: {
      bounds: { x: 0, y: 0, width: nextApp.screen.width, height: nextApp.screen.height },
      padding: 48,
    },
  });
  layer = nextLayer;
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
  const words = ["FLOW", "NODE", "GLYPH", "24ms"] as const;
  const style: Readonly<TextStyleOptions> = Object.freeze({
    fontFamily: "Arial",
    fontSize: 12,
    fontWeight: "500",
    fill: 0xdde8f0,
  });
  let movingIndex = 0;

  for (let start = 0; start < LABEL_COUNT; start += CHUNK_SIZE) {
    if (isStale(runId)) return;
    const count = Math.min(CHUNK_SIZE, LABEL_COUNT - start);
    const specs = Array.from({ length: count }, (_, localIndex): TextLabelSpec => {
      const index = start + localIndex;
      return {
        text: words[index % words.length] ?? "FLOW",
        x: (index % COLUMNS) * COLUMN_SPACING,
        y: Math.floor(index / COLUMNS) * ROW_SPACING,
        style,
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

  await nextLayer.commit();
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
  viewportDuration.value = `${(
    overrideViewportDuration ?? nextBinding.stats.lastDurationMs
  ).toFixed(2)} ms`;
}

function toggleStorm(): void {
  stormEnabled.value = !stormEnabled.value;
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
  stormTimer = undefined;
  resizeObserver = undefined;
  intersectionObserver = undefined;
  binding = undefined;
  layer = undefined;
  viewport = undefined;
  app = undefined;
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
</script>

<template>
  <section
    class="demo-shell"
    data-testid="glyphflow-demo"
    :data-demo-state="state"
    :data-renderer-backend="activeBackend"
    aria-labelledby="demo-title"
  >
    <header class="demo-header">
      <div>
        <p class="demo-kicker">LIVE RENDER PATH</p>
        <h2 id="demo-title">Viewport pressure test</h2>
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
        <p>{{ state === "error" ? "Renderer setup failed" : "Building the scene" }}</p>
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
          <dd>{{ visible }}</dd>
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
          <dt>Viewport commit</dt>
          <dd>{{ viewportDuration }}</dd>
        </div>
        <div>
          <dt>Submitted glyphs</dt>
          <dd>{{ glyphs }}</dd>
        </div>
        <div>
          <dt>Renderer / FPS</dt>
          <dd>
            <span data-testid="renderer-adapter">{{ rendererName }}</span> · {{ fps }} FPS
          </dd>
        </div>
      </dl>

      <div class="demo-controls">
        <button type="button" :aria-pressed="stormEnabled" @click="toggleStorm">
          {{ stormEnabled ? "Pause movement" : "Start movement" }}
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
