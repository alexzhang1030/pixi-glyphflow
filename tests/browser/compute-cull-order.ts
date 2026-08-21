import { Application } from "pixi.js";

import { TextLayer } from "../../src";

interface BrowserFixtureState {
  done: boolean;
  error?: string;
  result?: {
    rendererAdapter: string;
    cullPath: string;
    drawCalls: number;
    submittedGlyphs: number;
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
  const ids = layer.createMany(
    ["Alpha", "Bravo", "Charlie", "Delta"].map((text, index) => ({
      text,
      x: 16 + index * 72,
      y: 64,
      style: { fontFamily: "Arial", fontSize: 22, fill: 0xffffff },
    })),
  );
  const late = [ids[1], ids[3]];
  if (late[0] === undefined || late[1] === undefined) {
    throw new Error("Late-allocated label identities are unavailable");
  }
  layer.update(late[0], { visible: false });
  layer.update(late[1], { visible: false });
  await layer.commit();
  layer.update(late[0], { visible: true });
  layer.update(late[1], { visible: true });
  await layer.commit();
  app.render();

  const stats = layer.stats;
  window.__glyphflow.result = {
    rendererAdapter: stats.rendererAdapter,
    cullPath: stats.cullPath,
    drawCalls: stats.drawCalls,
    submittedGlyphs: stats.submittedGlyphs,
  };
  window.__glyphflow.done = true;
}
