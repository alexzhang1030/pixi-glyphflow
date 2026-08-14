import { Application } from "pixi.js";

import { TextLayer } from "../../src";
import { measureCanvasPixelProfile, type PixelProfile } from "./pixels";

interface CompositingFixtureState {
  done: boolean;
  error?: string;
  result?: {
    rendererAdapter: string;
    blueOnTop: PixelProfile;
    redOnTop: PixelProfile;
    additive: PixelProfile;
    initialDrawCalls: number;
    raisedDrawCalls: number;
    additiveDrawCalls: number;
  };
}

declare global {
  interface Window {
    __glyphflowCompositing: CompositingFixtureState;
  }
}

window.__glyphflowCompositing = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowCompositing.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflowCompositing.done = true;
});

async function run(): Promise<void> {
  const renderer =
    new URL(window.location.href).searchParams.get("renderer") === "webgpu" ? "webgpu" : "webgl";
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: renderer,
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  document.body.appendChild(app.canvas);

  const layer = new TextLayer({ renderer: app.renderer, culling: false });
  app.stage.addChild(layer);
  const bottom = layer.create({
    text: "M",
    x: 100,
    y: 130,
    zIndex: 0,
    style: { fontFamily: "Arial", fontSize: 96, fill: 0xff0000 },
  });
  const top = layer.create({
    text: "M",
    x: 100,
    y: 130,
    zIndex: 0,
    style: { fontFamily: "Arial", fontSize: 96, fill: 0x0000ff },
  });
  await layer.commit();
  app.render();
  const blueOnTop = await measureCanvasPixelProfile(app.canvas);
  const initialDrawCalls = layer.stats.drawCalls;

  layer.update(bottom, { zIndex: 2 });
  await layer.commit();
  app.render();
  const redOnTop = await measureCanvasPixelProfile(app.canvas);
  const raisedDrawCalls = layer.stats.drawCalls;

  layer.updateMany([
    { id: bottom, patch: { zIndex: 0 } },
    { id: top, patch: { blendMode: "add" } },
  ]);
  await layer.commit();
  app.render();
  const additive = await measureCanvasPixelProfile(app.canvas);
  const additiveDrawCalls = layer.stats.drawCalls;

  window.__glyphflowCompositing.result = {
    rendererAdapter: layer.stats.rendererAdapter,
    blueOnTop,
    redOnTop,
    additive,
    initialDrawCalls,
    raisedDrawCalls,
    additiveDrawCalls,
  };
  window.__glyphflowCompositing.done = true;
}
