import { Application, Rectangle } from "pixi.js";

import { TextLayer } from "../../src";

interface BrowserFixtureState {
  done: boolean;
  error?: string;
  result?: {
    initialPixels: number;
    movedPixels: number;
    reattachedPixels: number;
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
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    background: "#10131a",
    antialias: false,
    preference: "webgl",
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  document.body.appendChild(app.canvas);
  const layer = new TextLayer({ renderer: app.renderer, culling: false });
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
  const initialPixels = countVisiblePixels(app, layer);
  const initialStats = { ...layer.stats };

  layer.updatePositions(new Float64Array([ids[0] ?? 0]), new Float32Array([90, 55]));
  await layer.commit();
  app.render();
  const movedPixels = countVisiblePixels(app, layer);
  const movedStats = { ...layer.stats };

  layer.detach();
  layer.attach(app.renderer);
  await layer.commit();
  app.render();
  const reattachedPixels = countVisiblePixels(app, layer);
  const reattachedStats = { ...layer.stats };

  window.__glyphflow.result = {
    initialPixels,
    movedPixels,
    reattachedPixels,
    initialStats,
    movedStats,
    reattachedStats,
  };
  window.__glyphflow.done = true;
}

function countVisiblePixels(app: Application, layer: TextLayer): number {
  const { pixels } = app.renderer.extract.pixels({
    target: layer,
    frame: new Rectangle(0, 0, 320, 180),
  });
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) > 0) count += 1;
  }

  return count;
}
