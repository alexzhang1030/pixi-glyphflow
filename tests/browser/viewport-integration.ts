import { Viewport } from "pixi-viewport";
import { Application, Point, type FederatedPointerEvent } from "pixi.js";

import { TextLayer, type TextId } from "../../src";
import { bindViewport } from "../../src/viewport";

interface ViewportIntegrationState {
  done: boolean;
  error?: string;
  result?: {
    labelCount: number;
    initialRevision: number;
    cameraRevision: number;
    positionRevision: number;
    initialVisible: number;
    finalVisible: number;
    stormEvents: number;
    coalescedEvents: number;
    positionUpdates: number;
    positionUpdateDurationMs: number;
    pluginEvents: Readonly<Record<string, number>>;
    listenerCounts: {
      plugins: number[];
      baseline: number[];
      bound: number[];
      destroyed: number[];
      released: number[];
    };
    rotatedBoundsFinite: boolean;
    layerRemoved: boolean;
    pluginsInstalled: string[];
  };
}

declare global {
  interface Window {
    __glyphflowViewport: ViewportIntegrationState;
  }
}

window.__glyphflowViewport = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowViewport.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflowViewport.done = true;
});

async function run(): Promise<void> {
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: "webgl",
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  app.stop();
  document.body.append(app.canvas);

  const viewport = new Viewport({
    screenWidth: 320,
    screenHeight: 180,
    worldWidth: 10_000,
    worldHeight: 4_000,
    events: app.renderer.events,
    noTicker: true,
    passiveWheel: false,
  });
  viewport.drag().decelerate({ friction: 0.92, minSpeed: 0.01 }).wheel().pinch();
  app.stage.addChild(viewport);

  const labelCount = 100_000;
  const layer = new TextLayer({
    rendering: false,
    initialCapacity: labelCount,
    culling: { enabled: true, padding: 16 },
  });
  const specs = Array.from({ length: labelCount }, (_, index) => ({
    text: "g",
    x: (index % 500) * 20,
    y: Math.floor(index / 500) * 20,
    style: { fontSize: 12 },
  }));
  const ids = layer.createMany(specs);
  await layer.commit();
  const initialRevision = Number(layer.stats.revision);

  const pluginEvents: Record<string, number> = {};
  const recordMoved = (event: unknown): void => recordPluginEvent(pluginEvents, event);
  const recordZoomed = (event: unknown): void => recordPluginEvent(pluginEvents, event);
  const plugins = listenerCounts(viewport);
  viewport.on("moved", recordMoved);
  viewport.on("zoomed", recordZoomed);
  const baseline = listenerCounts(viewport);
  const binding = bindViewport(layer, viewport, { removeOnDestroy: true });
  const bound = listenerCounts(viewport);
  await binding.whenIdle();
  const initialVisible = layer.stats.visibleLabelCount;

  await performDrag(app.canvas);
  viewport.update(16.67);
  await binding.whenIdle();

  app.canvas.dispatchEvent(
    new WheelEvent("wheel", {
      clientX: 160,
      clientY: 90,
      deltaY: -180,
      bubbles: true,
      cancelable: true,
    }),
  );
  viewport.update(16.67);
  await binding.whenIdle();

  await performPinch(viewport);
  viewport.update(16.67);
  await binding.whenIdle();

  const decelerate = viewport.plugins.get("decelerate");
  decelerate?.activate({ x: 6, y: 3 });
  for (let frame = 0; frame < 24; frame += 1) viewport.update(16.67);
  await binding.whenIdle();

  const beforeStormEvents = binding.stats.inputEvents;
  for (let index = 0; index < 1_000; index += 1) {
    viewport.x -= 0.25;
    viewport.emit("moved", { viewport, type: "drag" });
    viewport.scale.set(viewport.scale.x * 1.000_01);
    viewport.emit("zoomed", { viewport, type: "wheel" });
  }
  viewport.emit("frame-end", viewport);
  await binding.whenIdle();
  const stormEvents = binding.stats.inputEvents - beforeStormEvents;

  viewport.rotation = Math.PI / 10;
  viewport.emit("moved", { viewport, type: "drag" });
  viewport.emit("frame-end", viewport);
  await binding.whenIdle();
  const rotatedBounds = binding.stats.lastBounds;
  const rotatedBoundsFinite =
    rotatedBounds !== undefined &&
    Number.isFinite(rotatedBounds.x) &&
    Number.isFinite(rotatedBounds.y) &&
    Number.isFinite(rotatedBounds.width) &&
    Number.isFinite(rotatedBounds.height) &&
    rotatedBounds.width > 0 &&
    rotatedBounds.height > 0;
  const cameraRevision = Number(layer.stats.revision);

  const positions = new Float32Array(labelCount * 2);
  for (let index = 0; index < labelCount; index += 1) {
    positions[index * 2] = ((index % 500) * 20 + 1) as number;
    positions[index * 2 + 1] = (Math.floor(index / 500) * 20 + 1) as number;
  }
  const positionStart = performance.now();
  const positionUpdates = layer.updatePositions(ids as readonly TextId[], positions);
  await layer.commit();
  const positionUpdateDurationMs = performance.now() - positionStart;
  const positionRevision = Number(layer.stats.revision);
  const finalVisible = layer.stats.visibleLabelCount;

  binding.destroy();
  const destroyed = listenerCounts(viewport);
  viewport.off("moved", recordMoved);
  viewport.off("zoomed", recordZoomed);
  const released = listenerCounts(viewport);
  const layerRemoved = layer.parent === null;
  const pluginsInstalled = ["drag", "decelerate", "wheel", "pinch"].filter(
    (name) => viewport.plugins.get(name) !== undefined,
  );

  window.__glyphflowViewport.result = {
    labelCount,
    initialRevision,
    cameraRevision,
    positionRevision,
    initialVisible,
    finalVisible,
    stormEvents,
    coalescedEvents: binding.stats.coalescedEvents,
    positionUpdates,
    positionUpdateDurationMs,
    pluginEvents,
    listenerCounts: { plugins, baseline, bound, destroyed, released },
    rotatedBoundsFinite,
    layerRemoved,
    pluginsInstalled,
  };
  window.__glyphflowViewport.done = true;
}

async function performDrag(canvas: HTMLCanvasElement): Promise<void> {
  dispatchPointer(canvas, "pointerdown", 1, "mouse", 180, 100, 1, true);
  for (let step = 1; step <= 8; step += 1) {
    dispatchPointer(canvas, "pointermove", 1, "mouse", 180 - step * 8, 100 - step * 3, 1, true);
    await nextFrame();
  }
  dispatchPointer(canvas, "pointerup", 1, "mouse", 116, 76, 0, true);
  await nextFrame();
}

async function performPinch(viewport: Viewport): Promise<void> {
  viewport.input.clear();
  viewport.input.down(pointerEvent(11, 120, 90));
  viewport.input.down(pointerEvent(12, 200, 90));
  await nextFrame();
  viewport.input.move(pointerEvent(11, 120, 90));
  viewport.input.move(pointerEvent(12, 200, 90));
  viewport.input.move(pointerEvent(11, 96, 90));
  viewport.input.move(pointerEvent(12, 224, 90));
  await nextFrame();
  viewport.input.up(pointerEvent(11, 96, 90));
  viewport.input.up(pointerEvent(12, 224, 90));
  await nextFrame();
}

function pointerEvent(pointerId: number, x: number, y: number): FederatedPointerEvent {
  const event = {
    pointerId,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    global: new Point(x, y),
    data: { pointerId },
    stopPropagation: () => undefined,
  } as unknown as FederatedPointerEvent;

  return event;
}

function dispatchPointer(
  canvas: HTMLCanvasElement,
  type: string,
  pointerId: number,
  pointerType: string,
  clientX: number,
  clientY: number,
  buttons: number,
  isPrimary: boolean,
): void {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      pointerType,
      isPrimary,
      clientX,
      clientY,
      button: buttons === 0 ? 0 : -1,
      buttons,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function recordPluginEvent(target: Record<string, number>, event: unknown): void {
  const type = (event as { type?: unknown }).type;
  if (typeof type === "string") target[type] = (target[type] ?? 0) + 1;
}

function listenerCounts(viewport: Viewport): number[] {
  return [
    viewport.listenerCount("moved"),
    viewport.listenerCount("zoomed"),
    viewport.listenerCount("frame-end"),
  ];
}
