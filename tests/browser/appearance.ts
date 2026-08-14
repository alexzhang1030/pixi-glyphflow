import { Application } from "pixi.js";

import { TextLayer } from "../../src";
import { measurePixelProfile, type PixelProfile } from "./pixels";

interface AppearanceFixtureState {
  done: boolean;
  error?: string;
  result?: {
    rendererAdapter: string;
    base: PixelProfile;
    effects: PixelProfile;
    transformed: PixelProfile;
    translucent: PixelProfile;
    hidden: PixelProfile;
  };
}

declare global {
  interface Window {
    __glyphflowAppearance: AppearanceFixtureState;
  }
}

window.__glyphflowAppearance = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowAppearance.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflowAppearance.done = true;
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
  const id = layer.create({
    text: "W",
    x: 24,
    y: 102,
    style: { fontFamily: "Arial", fontSize: 64, fill: 0xffffff },
  });
  await layer.commit();
  app.render();
  const base = await measurePixelProfile(app, layer);

  layer.update(id, {
    alpha: 0.5,
    style: {
      fontFamily: "Arial",
      fontSize: 64,
      fill: { color: 0xff0000, alpha: 0.7 },
      stroke: { color: 0x00ff00, width: 3, alpha: 1 },
      dropShadow: { color: 0x0000ff, alpha: 0.8, angle: 0, distance: 6, blur: 2 },
    },
  });
  await layer.commit();
  app.render();
  const effects = await measurePixelProfile(app, layer);

  layer.update(id, {
    x: 160,
    y: 90,
    scale: { x: 1.5, y: 0.8 },
    rotation: 0.35,
    anchor: 0.5,
    alpha: 1,
    style: { fontFamily: "Arial", fontSize: 64, fill: 0xffffff },
  });
  await layer.commit();
  app.render();
  const transformed = await measurePixelProfile(app, layer);

  layer.update(id, {
    x: 24,
    y: 102,
    scale: 1,
    rotation: 0,
    anchor: 0,
    alpha: 0.25,
  });
  await layer.commit();
  app.render();
  const translucent = await measurePixelProfile(app, layer);

  layer.update(id, { visible: false });
  await layer.commit();
  app.render();
  const hidden = await measurePixelProfile(app, layer);

  window.__glyphflowAppearance.result = {
    rendererAdapter: layer.stats.rendererAdapter,
    base,
    effects,
    transformed,
    translucent,
    hidden,
  };
  window.__glyphflowAppearance.done = true;
}
