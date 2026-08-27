import { Application } from "pixi.js";

import { TextLayer } from "../../src";
import { measureVisiblePixels } from "./pixels";

interface MixedAtlasState {
  done: boolean;
  error?: string;
  result?: {
    rendererAdapter: string;
    pixels: number;
    atlasTextureCount: number;
    drawCalls: number;
  };
}

declare global {
  interface Window {
    __glyphflowMixedAtlas: MixedAtlasState;
  }
}

window.__glyphflowMixedAtlas = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowMixedAtlas.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflowMixedAtlas.done = true;
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
    culling: { enabled: true, padding: 0 },
    rendering: {
      // 256² pages overflow after a handful of 48px TinySDF glyphs, so one
      // commit grows the R array (dummy → 1 layer → 2). That used to
      // initialize a destroyed source and throw addressModeU.
      atlasOptions: { pageWidth: 256, pageHeight: 256 },
      rasterizerOptions: {
        tinySdf: true,
        distanceFieldMinFontSize: 48,
      },
    },
  });
  app.stage.addChild(layer);
  layer.setViewportBounds({ x: 0, y: 0, width: 320, height: 180 });
  await layer.commit();
  layer.createMany([
    {
      text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ字流",
      x: 8,
      y: 70,
      style: { fontFamily: "Arial", fontSize: 28, fill: 0xffffff },
    },
    {
      text: "Emoji · 🌏",
      x: 8,
      y: 120,
      style: { fontFamily: "Arial", fontSize: 22, fill: 0xe8f6ff },
    },
  ]);
  await layer.commit();
  app.render();
  const measure = await measureVisiblePixels(app, layer);
  window.__glyphflowMixedAtlas.result = {
    rendererAdapter: layer.stats.rendererAdapter,
    pixels: measure.count,
    atlasTextureCount: layer.stats.atlasTextureCount,
    drawCalls: layer.stats.drawCalls,
  };
  window.__glyphflowMixedAtlas.done = true;
}
