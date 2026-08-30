import { Application } from "pixi.js";

import { measureOutlineComputeRasterizer } from "../../benchmarks/browser/outline";
import { requestComputeCullGpu, TextLayer, type PositionedRun } from "../../src";
import {
  createOutlineRendering,
  createOutlineComputeRasterizer,
  OUTLINE_FRAGMENT_WGSL,
  prepareOutlineGlyph,
  rasterizeOutlineCpu,
  type OutlineComputeRasterRequest,
  type PreparedOutlineGlyph,
} from "../../src/render/outline";
import { packedRectangle, readRgba8Texture } from "../fixtures/outlineFixtures";
import { measureVisiblePixels } from "./pixels";

interface OutlineComputeFixtureResult {
  readonly capability: "supported" | "unsupported";
  readonly status: "ready" | "unsupported";
  readonly entryCount: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly visiblePixels: number;
  readonly mismatchedChannels: number;
  readonly maxChannelDelta: number;
  readonly coldRasterMs: number;
  readonly rasterP50Ms: number;
  readonly rasterP95Ms: number;
  readonly fragmentCompiled: boolean;
  readonly outlineSourceCalls: number;
  readonly sharedBatchTexture: boolean;
  readonly productionPixels: number;
  readonly productionAdapter: "webgpu" | "unknown";
  readonly productionGlyphs: number;
  readonly productionAtlasUploadBytes: number;
}

interface OutlineComputeFixtureState {
  done: boolean;
  error?: string;
  result?: Readonly<OutlineComputeFixtureResult>;
}

interface HbGpuArtifact {
  readonly corpora: readonly {
    readonly id: string;
    readonly glyphs: readonly {
      readonly glyphId: number;
      readonly blobHex: string;
      readonly extents: {
        readonly xBearing: number;
        readonly yBearing: number;
        readonly width: number;
        readonly height: number;
      };
    }[];
  }[];
}

declare global {
  interface Window {
    __glyphflowOutlineCompute: OutlineComputeFixtureState;
  }
}

window.__glyphflowOutlineCompute = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowOutlineCompute = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  const gpu = await requestComputeCullGpu();
  const device = gpu?.device;
  const rasterizer = createOutlineComputeRasterizer(device);
  if (rasterizer.capability.status === "unsupported") {
    window.__glyphflowOutlineCompute = {
      done: true,
      result: {
        capability: "unsupported",
        status: "unsupported",
        entryCount: 0,
        atlasWidth: 0,
        atlasHeight: 0,
        visiblePixels: 0,
        mismatchedChannels: 0,
        maxChannelDelta: 0,
        coldRasterMs: 0,
        rasterP50Ms: 0,
        rasterP95Ms: 0,
        fragmentCompiled: false,
        outlineSourceCalls: 0,
        sharedBatchTexture: false,
        productionPixels: 0,
        productionAdapter: "unknown",
        productionGlyphs: 0,
        productionAtlasUploadBytes: 0,
      },
    };
    return;
  }
  if (device === undefined) throw new Error("supported outline compute lacks a GPU device");
  await assertShaderCompiles(device, OUTLINE_FRAGMENT_WGSL);

  const artifact = (await fetch("/benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json").then(
    (response) => response.json(),
  )) as HbGpuArtifact;
  const arabic = artifact.corpora.find((corpus) => corpus.id === "arabic");
  const glyphRecord = arabic?.glyphs.find((glyph) => glyph.glyphId === 4);
  if (glyphRecord === undefined) throw new Error("Arabic glyph 4 is absent from the HB artifact");
  const glyphs = [
    requirePrepared(
      prepareOutlineGlyph({
        extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
        packedCurveBlob: packedRectangle(),
      }),
    ),
    requirePrepared(
      prepareOutlineGlyph({
        extents: glyphRecord.extents,
        packedCurveBlob: decodeHex(glyphRecord.blobHex),
      }),
    ),
  ] as const;
  const requests = [
    { glyph: glyphs[0], pixelHeight: 32, padding: 2, color: [1, 0.5, 0.25, 1] },
    { glyph: glyphs[1], pixelHeight: 64, padding: 2, color: [0.2, 0.6, 1, 0.8] },
  ] as const satisfies readonly OutlineComputeRasterRequest[];
  let outlineSourceCalls = 0;
  const plugin = createOutlineRendering({
    projectedSizeThresholdPx: 16,
    padding: 2,
    rasterizer,
    source: ({ glyphId }) => {
      outlineSourceCalls += 1;
      if (glyphId === 1) {
        return {
          extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
          packedCurveBlob: packedRectangle(),
        };
      }
      if (glyphId === glyphRecord.glyphId) {
        return {
          extents: glyphRecord.extents,
          packedCurveBlob: decodeHex(glyphRecord.blobHex),
        };
      }
      return undefined;
    },
  });
  const rendered = await Promise.all([
    plugin.rasterize({
      family: "outline-fixture",
      fontRevision: 1,
      glyphId: 1,
      fontSize: 4,
      projectedHeightPx: 32,
      rasterPixelHeight: 32,
      color: [1, 0.5, 0.25, 1],
    }),
    plugin.rasterize({
      family: "outline-fixture",
      fontRevision: 1,
      glyphId: glyphRecord.glyphId,
      fontSize: 1_000,
      projectedHeightPx: 64,
      rasterPixelHeight: 64,
      color: [0.2, 0.6, 1, 0.8],
    }),
  ]);
  if (rendered.some((result) => result.status !== "ready")) {
    throw new Error(`outline plugin returned ${rendered.map((result) => result.status).join(",")}`);
  }
  const rasters = rendered.map((result) => {
    if (result.status !== "ready") throw new Error(`unexpected ${result.status} outline result`);
    return result.raster;
  });
  const firstRaster = rasters[0];
  if (firstRaster === undefined) throw new Error("outline plugin returned no raster");
  const sharedBatchTexture = rasters.every(
    (raster) => raster.source.texture === firstRaster.source.texture,
  );
  const gpuPixels = await readRgba8Texture(
    device,
    firstRaster.source.texture,
    firstRaster.source.width,
    firstRaster.source.height,
  );
  let visiblePixels = 0;
  let mismatchedChannels = 0;
  let maxChannelDelta = 0;
  rasters.forEach((entry, index) => {
    const request = requests[index];
    if (request === undefined) throw new Error("outline atlas entry lacks a request");
    const cpu = rasterizeOutlineCpu(request.glyph, request);
    if (cpu.width !== entry.width || cpu.height !== entry.height) {
      throw new Error("CPU and compute atlas entry geometry differ");
    }
    for (let y = 0; y < entry.height; y += 1) {
      for (let x = 0; x < entry.width; x += 1) {
        const cpuOffset = (y * entry.width + x) * 4;
        const gpuOffset = (entry.sourceY + y) * gpuPixels.bytesPerRow + (entry.sourceX + x) * 4;
        if ((cpu.pixels[cpuOffset + 3] ?? 0) > 0) visiblePixels += 1;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs(
            (cpu.pixels[cpuOffset + channel] ?? 0) - (gpuPixels.pixels[gpuOffset + channel] ?? 0),
          );
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          if (delta > 2) mismatchedChannels += 1;
        }
      }
    }
  });
  for (const raster of rasters) raster.release();
  if (gpu === undefined) throw new Error("supported outline compute lacks a Pixi WebGPU context");
  const production = await renderProductionOutline(gpu, plugin);
  plugin.destroy();
  const benchmarkRasterizer = createOutlineComputeRasterizer(device);
  const benchmark = await measureOutlineComputeRasterizer(benchmarkRasterizer, requests, {
    warmupIterations: 3,
    sampleIterations: 20,
  });
  benchmarkRasterizer.destroy();

  window.__glyphflowOutlineCompute = {
    done: true,
    result: {
      capability: "supported",
      status: "ready",
      entryCount: rasters.length,
      atlasWidth: firstRaster.source.width,
      atlasHeight: firstRaster.source.height,
      visiblePixels,
      mismatchedChannels,
      maxChannelDelta,
      coldRasterMs: benchmark.timings.coldMs,
      rasterP50Ms: benchmark.timings.p50Ms,
      rasterP95Ms: benchmark.timings.p95Ms,
      fragmentCompiled: true,
      outlineSourceCalls,
      sharedBatchTexture,
      productionPixels: production.pixels,
      productionAdapter: production.adapter,
      productionGlyphs: production.glyphs,
      productionAtlasUploadBytes: production.atlasUploadBytes,
    },
  };
}

async function renderProductionOutline(
  gpu: NonNullable<Awaited<ReturnType<typeof requestComputeCullGpu>>>,
  plugin: ReturnType<typeof createOutlineRendering>,
): Promise<
  Readonly<{
    pixels: number;
    adapter: "webgpu" | "unknown";
    glyphs: number;
    atlasUploadBytes: number;
  }>
> {
  const app = new Application();
  await app.init({
    width: 160,
    height: 96,
    background: "#000000",
    antialias: false,
    preference: "webgpu",
    preserveDrawingBuffer: true,
    gpu,
  });
  document.body.appendChild(app.canvas);
  const layer = new TextLayer({
    renderer: app.renderer,
    culling: false,
    rendering: {
      glyphMode: "outline",
      outline: plugin,
      layoutEngine: {
        layout: () => productionRun(),
        destroy() {},
      },
      glyphProvider: {
        rasterize: () => Promise.reject(new Error("production outline took the atlas fallback")),
        destroy() {},
      },
    },
  });
  app.stage.addChild(layer);
  layer.create({
    text: "A",
    x: 24,
    y: 68,
    style: { fontFamily: "outline-fixture", fontSize: 32, fill: 0x38bdf8 },
  });
  await layer.commit();
  app.render();
  const measure = await measureVisiblePixels(app, layer, 160, 96);
  const result = {
    pixels: measure.count,
    adapter: layer.stats.rendererAdapter === "webgpu" ? "webgpu" : "unknown",
    glyphs: layer.stats.glyphCount,
    atlasUploadBytes: layer.stats.atlasUploadBytes,
  } as const;
  layer.destroy();
  app.destroy();
  return result;
}

function productionRun(): Readonly<PositionedRun> {
  return Object.freeze({
    source: "harfbuzz" as const,
    text: "A",
    fontFamily: "outline-fixture",
    fontRevision: 1,
    glyphCount: 1,
    direction: "ltr" as const,
    glyphIds: new Uint32Array([1]),
    clusters: new Uint32Array([0]),
    clusterEnds: new Uint32Array([1]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([32]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    glyphKeys: Object.freeze(["A"]),
    bounds: Object.freeze({ x: 0, y: -32, width: 32, height: 32 }),
  });
}

async function assertShaderCompiles(device: GPUDevice, source: string): Promise<void> {
  const module = device.createShaderModule({
    label: "outline fragment compile fixture",
    code: source,
  });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === "error");
  if (errors.length > 0) throw new Error(errors.map((message) => message.message).join("\n"));
}

function requirePrepared(
  result: ReturnType<typeof prepareOutlineGlyph>,
): Readonly<PreparedOutlineGlyph> {
  if (result.status !== "ready") throw new Error(`unexpected ${result.status} outline`);
  return result.glyph;
}

function decodeHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
