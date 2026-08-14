import { Application, Rectangle } from "pixi.js";

import { TextLayer } from "../../src";

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

interface PixelMeasure {
  readonly count: number;
  readonly centroidX: number;
}

async function measureVisiblePixels(app: Application, layer: TextLayer): Promise<PixelMeasure> {
  if ("gpu" in app.renderer) {
    const texture = app.renderer.extract.texture({
      target: layer,
      frame: new Rectangle(0, 0, 320, 180),
    });
    const gpuTexture = app.renderer.texture.getGpuSource(texture.source);
    const width = 320;
    const height = 180;
    const rowBytes = width * 4;
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const buffer = app.renderer.gpu.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = app.renderer.gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: gpuTexture },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    app.renderer.gpu.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    let count = 0;
    let xSum = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((pixels[y * bytesPerRow + x * 4 + 3] ?? 0) > 0) {
          count += 1;
          xSum += x;
        }
      }
    }
    buffer.unmap();
    buffer.destroy();
    texture.destroy(true);
    return { count, centroidX: count === 0 ? 0 : xSum / count };
  }
  const { pixels, width } = app.renderer.extract.pixels({
    target: layer,
    frame: new Rectangle(0, 0, 320, 180),
  });
  let count = 0;
  let xSum = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) > 0) {
      count += 1;
      xSum += Math.floor(index / 4) % width;
    }
  }

  return { count, centroidX: count === 0 ? 0 : xSum / count };
}
