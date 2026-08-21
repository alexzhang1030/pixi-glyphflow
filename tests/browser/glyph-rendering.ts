import { Application } from "pixi.js";

import { TextLayer } from "../../src";
import { measureVisiblePixels } from "./pixels";

interface BrowserFixtureState {
  done: boolean;
  error?: string;
  result?: {
    initialPixels: number;
    movedPixels: number;
    reattachedPixels: number;
    initialCentroidX: number;
    movedCentroidX: number;
    reattachedCentroidX: number;
    initialStats: Readonly<Record<string, unknown>>;
    movedStats: Readonly<Record<string, unknown>>;
    reattachedStats: Readonly<Record<string, unknown>>;
  };
}

declare global {
  interface Window {
    __glyphflow: BrowserFixtureState;
  }
}

window.__glyphflow = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflow.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflow.done = true;
});

async function run(): Promise<void> {
  const requestedRenderer =
    new URL(window.location.href).searchParams.get("renderer") === "webgpu" ? "webgpu" : "webgl";
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    background: "#10131a",
    antialias: false,
    preference: requestedRenderer,
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  document.body.appendChild(app.canvas);
  const layer = new TextLayer({
    renderer: app.renderer,
    culling: { bounds: { x: 0, y: 0, width: 320, height: 180 } },
  });
  app.stage.addChild(layer);
  const ids = layer.createMany([
    {
      text: "GlyphFlow",
      x: 20,
      y: 55,
      style: { fontFamily: "Arial", fontSize: 32, fill: 0xffffff },
    },
    {
      text: "Viewport",
      x: 20,
      y: 115,
      style: { fontFamily: "Arial", fontSize: 28, fill: 0x38bdf8 },
    },
  ]);

  await layer.commit();
  app.render();
  const initialMeasure = await measureVisiblePixels(app, layer);
  const initialStats = { ...layer.stats };

  layer.updatePositions(new Float64Array([ids[0] ?? 0]), new Float32Array([90, 55]));
  await layer.commit();
  app.render();
  const movedMeasure = await measureVisiblePixels(app, layer);
  const movedStats = { ...layer.stats };

  layer.detach();
  layer.attach(app.renderer);
  await layer.commit();
  app.render();
  const reattachedMeasure = await measureVisiblePixels(app, layer);
  const reattachedStats = { ...layer.stats };

  window.__glyphflow.result = {
    initialPixels: initialMeasure.count,
    movedPixels: movedMeasure.count,
    reattachedPixels: reattachedMeasure.count,
    initialCentroidX: initialMeasure.centroidX,
    movedCentroidX: movedMeasure.centroidX,
    reattachedCentroidX: reattachedMeasure.centroidX,
    initialStats,
    movedStats,
    reattachedStats,
  };
  window.__glyphflow.done = true;
}
