import { Viewport } from "pixi-viewport";
import { Application, type TextStyleOptions } from "pixi.js";

import {
  requestComputeCullGpu,
  TextLayer,
  type TextId,
  type TextLabelSpec,
} from "../../dist/index.js";
import { bindViewport } from "../../dist/viewport/index.js";

const COLUMNS = 1_000;
const SPACING = 18;
const CHUNK_SIZE = 8_192;
const STORM_INTERVAL_MS = 100;
const FRAME_SAMPLE_CAPACITY = 120;
const LIVE_FRAME_MISS_MS = 20;
const numberFormat = new Intl.NumberFormat("en-US");

interface FrameTelemetry {
  readonly fps: number;
  readonly p95Ms: number;
  readonly overBudget: number;
  readonly samples: number;
}

void main().catch((error: unknown) => {
  const state = element("state");
  state.textContent = "Error";
  state.classList.remove("ready");
  element("loading").textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});

async function main(): Promise<void> {
  const scene = element("scene");
  const labelCount = readCount("labels", 1_000_000, 1_000_000);
  const movingCount = Math.min(labelCount, readCount("moving", 100_000, 100_000));
  const worldWidth = COLUMNS * SPACING;
  const worldHeight = Math.ceil(labelCount / COLUMNS) * SPACING;
  const gpu = await requestComputeCullGpu({ powerPreference: "high-performance" });
  const app = new Application();
  const appOptions = {
    resizeTo: scene,
    preferWebGLVersion: 2 as const,
    powerPreference: "high-performance" as const,
    antialias: false,
    background: 0x070b14,
  };
  try {
    if (gpu === undefined) await app.init({ ...appOptions, preference: ["webgl"] });
    else await app.init({ ...appOptions, preference: ["webgpu"], gpu });
  } catch (error: unknown) {
    gpu?.device.destroy();
    throw error;
  }
  app.stop();
  app.canvas.setAttribute("role", "img");
  app.canvas.setAttribute("aria-label", "Interactive one-million-label GPU stress scene");
  scene.prepend(app.canvas);

  const viewport = new Viewport({
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    worldWidth,
    worldHeight,
    events: app.renderer.events,
  });
  const fitAllScale = Math.min(app.screen.width / worldWidth, app.screen.height / worldHeight);
  viewport
    .drag()
    .decelerate({ friction: 0.95, minSpeed: 0.01 })
    .wheel({ smooth: 3 })
    .pinch()
    .clampZoom({ minScale: fitAllScale, maxScale: 32 });
  app.stage.addChild(viewport);

  const layer = new TextLayer({
    renderer: app.renderer,
    initialCapacity: labelCount,
    culling: {
      bounds: { x: 0, y: 0, width: app.screen.width, height: app.screen.height },
      padding: 24,
      computeCull: "auto",
      residency: "gpu-scene",
    },
  });
  const binding = bindViewport(layer, viewport, {
    addChild: true,
    immediate: true,
    onError: console.error,
  });
  await binding.whenIdle();

  const movingIds = new Float64Array(movingCount);
  const style: Readonly<TextStyleOptions> = Object.freeze({
    fontFamily: "Arial",
    fontSize: 12,
    fill: 0xdbe5ff,
  });
  const loading = element("loading");
  const setupStart = performance.now();
  for (let start = 0; start < labelCount; start += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, labelCount - start);
    const specs = Array.from({ length: count }, (_, localIndex): TextLabelSpec => {
      const index = start + localIndex;
      return {
        text: "Glyph",
        x: (index % COLUMNS) * SPACING,
        y: Math.floor(index / COLUMNS) * SPACING,
        style,
      };
    });
    const ids = layer.createMany(specs);
    const captured = Math.max(0, Math.min(count, movingCount - start));
    for (let index = 0; index < captured; index += 1) {
      movingIds[start + index] = ids[index] as TextId;
    }
    if (start % (CHUNK_SIZE * 8) === 0) {
      loading.textContent = `Allocated ${numberFormat.format(Math.min(labelCount, start + count))} / ${numberFormat.format(labelCount)} labels`;
      await nextFrame();
    }
  }

  await layer.commit();
  viewport.emit("frame-end", viewport);
  await binding.whenIdle();
  app.start();
  loading.hidden = true;
  const state = element("state");
  state.textContent =
    layer.stats.residencyActive === "gpu-scene" ? "Live · GPU scene" : "Live · viewport";
  state.classList.add("ready");

  const firstPositions = buildPositions(movingCount, 0.25);
  const secondPositions = buildPositions(movingCount, 0.75);
  let useSecondPositions = true;
  let stormRunning = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let stormPending = false;
  let lastStormMs = 0;
  let lastHudUpdate = 0;

  const toggle = button("toggle-storm");
  const updateToggleLabel = (): void => {
    toggle.textContent = stormRunning ? "Pause position storm" : "Start position storm";
  };
  updateToggleLabel();
  toggle.addEventListener("click", () => {
    stormRunning = !stormRunning;
    updateToggleLabel();
  });

  const rotation = input("rotation");
  rotation.addEventListener("input", () => {
    viewport.rotation = (Number(rotation.value) * Math.PI) / 180;
    viewport.emit("moved", { viewport, type: "drag" });
    viewport.emit("frame-end", viewport);
  });

  button("reset-camera").addEventListener("click", () => {
    viewport.position.set(0, 0);
    viewport.scale.set(1);
    viewport.rotation = 0;
    rotation.value = "0";
    viewport.emit("moved", { viewport, type: "drag" });
    viewport.emit("zoomed", { viewport, type: "wheel" });
    viewport.emit("frame-end", viewport);
  });

  button("fit-all").addEventListener("click", () => {
    viewport.rotation = 0;
    rotation.value = "0";
    viewport.setZoom(fitAllScale, true);
    viewport.moveCenter(worldWidth / 2, worldHeight / 2);
    viewport.emit("moved", { viewport, type: "drag" });
    viewport.emit("zoomed", { viewport, type: "wheel" });
    viewport.emit("frame-end", viewport);
  });

  const runStorm = async (): Promise<void> => {
    if (!stormRunning || stormPending) return;
    stormPending = true;
    const start = performance.now();
    try {
      layer.updatePositions(movingIds, useSecondPositions ? secondPositions : firstPositions);
      useSecondPositions = !useSecondPositions;
      await layer.commit();
      lastStormMs = performance.now() - start;
    } finally {
      stormPending = false;
    }
  };
  const stormTimer = window.setInterval(() => void runStorm(), STORM_INTERVAL_MS);

  const frameSamples = new Float32Array(FRAME_SAMPLE_CAPACITY);
  let frameSampleCount = 0;
  let frameSampleCursor = 0;
  let lastFrameAt = performance.now();
  let frameTelemetry: FrameTelemetry = { fps: 0, p95Ms: 0, overBudget: 0, samples: 0 };
  app.ticker.add(() => {
    viewport.emit("frame-end", viewport);
    const now = performance.now();
    const frameMs = now - lastFrameAt;
    lastFrameAt = now;
    if (frameMs <= 1_000) {
      frameSamples[frameSampleCursor] = frameMs;
      frameSampleCursor = (frameSampleCursor + 1) % FRAME_SAMPLE_CAPACITY;
      frameSampleCount = Math.min(FRAME_SAMPLE_CAPACITY, frameSampleCount + 1);
    }
    if (now - lastHudUpdate < 200) return;
    lastHudUpdate = now;
    frameTelemetry = summarizeFrames(frameSamples, frameSampleCount);
    updateHud(layer, binding.stats.lastDurationMs, movingCount, lastStormMs, frameTelemetry);
  });
  updateHud(
    layer,
    binding.stats.lastDurationMs,
    movingCount,
    performance.now() - setupStart,
    frameTelemetry,
  );

  const resize = (): void => {
    viewport.resize(app.screen.width, app.screen.height, worldWidth, worldHeight);
    viewport.emit("frame-end", viewport);
  };
  window.addEventListener("resize", resize);
  window.addEventListener(
    "beforeunload",
    () => {
      window.clearInterval(stormTimer);
      window.removeEventListener("resize", resize);
      binding.destroy();
      layer.destroy();
      viewport.destroy({ children: true });
      app.destroy(true);
      gpu?.device.destroy();
    },
    { once: true },
  );
}

function buildPositions(count: number, offset: number): Float32Array {
  const positions = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    positions[index * 2] = (index % COLUMNS) * SPACING + offset;
    positions[index * 2 + 1] = Math.floor(index / COLUMNS) * SPACING + offset;
  }

  return positions;
}

function updateHud(
  layer: TextLayer,
  viewportDurationMs: number,
  movingCount: number,
  stormDurationMs: number,
  frameTelemetry: Readonly<FrameTelemetry>,
): void {
  const stats = layer.stats;
  write("resident", numberFormat.format(stats.labelCount));
  write("visible", numberFormat.format(stats.visibleLabelCount));
  write("moving", numberFormat.format(movingCount));
  write("fps", frameTelemetry.fps.toFixed(0));
  write("frame-p95", `${frameTelemetry.p95Ms.toFixed(2)} ms`);
  write(
    "frame-over-budget",
    `${numberFormat.format(frameTelemetry.overBudget)} / ${numberFormat.format(frameTelemetry.samples)}`,
  );
  write("revision", numberFormat.format(Number(stats.revision)));
  write("storm-time", `${stormDurationMs.toFixed(2)} ms`);
  write("viewport-time", `${viewportDurationMs.toFixed(2)} ms`);
  write("scene-setup", `${stats.lastSceneSetupMs.toFixed(2)} ms`);
  write("draws", numberFormat.format(stats.drawCalls));
  write("glyphs", numberFormat.format(stats.submittedGlyphs));
  write("renderer", formatRenderer(stats.rendererAdapter));
  write(
    "residency",
    stats.residencyFallbackReason === undefined
      ? stats.residencyActive
      : `${stats.residencyActive} · ${stats.residencyFallbackReason}`,
  );
  write("cull-path", stats.cullPath);
  write("palette-path", stats.palettePath);
}

function summarizeFrames(samples: Float32Array, count: number): FrameTelemetry {
  if (count === 0) return { fps: 0, p95Ms: 0, overBudget: 0, samples: 0 };
  const sorted = Array.from(samples.subarray(0, count)).sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    fps: (count * 1_000) / total,
    p95Ms: sorted[p95Index] ?? 0,
    overBudget: sorted.filter((sample) => sample > LIVE_FRAME_MISS_MS).length,
    samples: count,
  };
}

function formatRenderer(renderer: string): string {
  if (renderer === "webgpu") return "WebGPU";
  if (renderer === "webgl") return "WebGL 2";
  return renderer;
}

function readCount(name: string, fallback: number, maximum: number): number {
  const raw = new URL(window.location.href).searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) return fallback;

  return value;
}

function write(id: string, value: string): void {
  element(id).textContent = value;
}

function element(id: string): HTMLElement {
  const value = document.querySelector<HTMLElement>(`#${id}`);
  if (value === null) throw new Error(`Missing playground element #${id}`);

  return value;
}

function button(id: string): HTMLButtonElement {
  const value = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (value === null) throw new Error(`Missing playground button #${id}`);

  return value;
}

function input(id: string): HTMLInputElement {
  const value = document.querySelector<HTMLInputElement>(`#${id}`);
  if (value === null) throw new Error(`Missing playground input #${id}`);

  return value;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
