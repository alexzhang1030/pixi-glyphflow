import { Viewport } from "pixi-viewport";
import { Application, type TextStyleOptions } from "pixi.js";

import { TextLayer, type TextId, type TextLabelSpec } from "../../dist/index.js";
import { bindViewport } from "../../dist/viewport/index.js";

const COLUMNS = 1_000;
const SPACING = 18;
const CHUNK_SIZE = 8_192;
const STORM_INTERVAL_MS = 100;
const numberFormat = new Intl.NumberFormat("en-US");

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
  const app = new Application();
  await app.init({
    resizeTo: scene,
    preference: "webgl",
    preferWebGLVersion: 2,
    antialias: false,
    background: 0x070b14,
  });
  app.stop();
  scene.prepend(app.canvas);

  const viewport = new Viewport({
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    worldWidth,
    worldHeight,
    events: app.renderer.events,
  });
  viewport
    .drag()
    .decelerate({ friction: 0.95, minSpeed: 0.01 })
    .wheel({ smooth: 3 })
    .pinch()
    .clampZoom({ minScale: 0.05, maxScale: 32 });
  app.stage.addChild(viewport);

  const layer = new TextLayer({
    renderer: app.renderer,
    initialCapacity: labelCount,
    culling: {
      bounds: { x: 0, y: 0, width: app.screen.width, height: app.screen.height },
      padding: 24,
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
  state.textContent = "Live";
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

  app.ticker.add(() => {
    viewport.emit("frame-end", viewport);
    const now = performance.now();
    if (now - lastHudUpdate < 200) return;
    lastHudUpdate = now;
    updateHud(layer, binding.stats.lastDurationMs, movingCount, lastStormMs);
  });
  updateHud(layer, binding.stats.lastDurationMs, movingCount, performance.now() - setupStart);

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
): void {
  const stats = layer.stats;
  write("resident", numberFormat.format(stats.labelCount));
  write("visible", numberFormat.format(stats.visibleLabelCount));
  write("moving", numberFormat.format(movingCount));
  write("revision", numberFormat.format(Number(stats.revision)));
  write("storm-time", `${stormDurationMs.toFixed(2)} ms`);
  write("viewport-time", `${viewportDurationMs.toFixed(2)} ms`);
  write("draws", numberFormat.format(stats.drawCalls));
  write("glyphs", numberFormat.format(stats.submittedGlyphs));
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
