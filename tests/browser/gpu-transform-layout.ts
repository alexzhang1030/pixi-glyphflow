import { Application } from "pixi.js";

import {
  completeFrame,
  createGpuFrameTimer,
  requestBenchmarkWebGpu,
} from "../../benchmarks/browser/timing";
import { summarize } from "../../benchmarks/schema";
import { TextLayer, type TextId, type TextLabelSpec, type TextUpdate } from "../../src";
import { readTargetPixels } from "./pixels";

interface FrameComparison {
  readonly phase: string;
  readonly differentBytes: number;
  readonly nonTransparentPixels: number;
  readonly residency: string;
  readonly prototypes: number;
  readonly transformBytes: number;
  readonly recordBytes: number;
  readonly instanceBytes: number;
}

interface StressPhase {
  readonly phase: string;
  readonly mutationsPerFrame: number;
  readonly frameMs: ReturnType<typeof summarize>;
  readonly mutationMs: ReturnType<typeof summarize>;
  readonly commitMs: ReturnType<typeof summarize>;
  readonly gpuMs: ReturnType<typeof summarize> | null;
  readonly sceneGpuMs: ReturnType<typeof summarize> | null;
  readonly gpuTiming: string;
  readonly transformBytes: readonly number[];
  readonly recordBytes: readonly number[];
  readonly submittedGlyphs: number;
  readonly residency: string;
}

export interface TransformLayoutFixtureState {
  readonly done: boolean;
  readonly error?: string;
  readonly comparisons?: readonly FrameComparison[];
  readonly stress?: { readonly labels: number; readonly phases: readonly StressPhase[] };
}

declare global {
  interface Window {
    __gpuTransformLayout: TransformLayoutFixtureState;
  }
}

window.__gpuTransformLayout = { done: false };
void run().catch((error: unknown) => {
  publish({
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
});

async function run(): Promise<void> {
  const query = new URLSearchParams(location.search);
  if (query.has("probe")) {
    publish({ done: true });
    return;
  }
  const gpu = await requestBenchmarkWebGpu({ powerPreference: "high-performance" });
  if (gpu === undefined) throw new Error("WebGPU adapter unavailable");
  const app = new Application();
  const stress = query.has("stress");
  await app.init({
    width: stress ? 1280 : 320,
    height: stress ? 800 : 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: "webgpu",
    gpu,
  });
  app.stop();
  app.canvas.style.background = "#111827";
  document.body.prepend(app.canvas);
  if (stress) {
    const labels = boundedCount(query, "labels", 100_000, 1_000_000);
    const movers = boundedCount(query, "movers", Math.min(labels, 10_000), labels);
    const frames = boundedCount(query, "frames", 120, 600);
    publish({
      done: true,
      stress: { labels, phases: await runStress(app, labels, movers, frames) },
    });
  } else {
    publish({ done: true, comparisons: await compareFrames(app, query.get("variant") ?? "run") });
  }
}

async function compareFrames(app: Application, variant: string): Promise<FrameComparison[]> {
  const layers = ["gpu-scene", "viewport"].map(
    (residency) =>
      new TextLayer({
        renderer: app.renderer,
        culling: {
          residency: residency as "gpu-scene" | "viewport",
          computeCull: residency === "gpu-scene",
          bounds: { x: 0, y: 0, width: 320, height: 180 },
          padding: 0,
        },
      }),
  );
  const resident = layers[0]!;
  app.stage.addChild(resident);
  const specs: TextLabelSpec[] = [0, 1, 2].map((index) => ({
    text: variant === "single" ? "R" : variant === "run" ? "Rotate" : ["Atlas", "Map", "R"][index]!,
    x: 50 + index * 85,
    y: 35 + index * 40,
    rotation: [-0.4, 0.7, 2.5][index]!,
    style: { fontFamily: "Arial", fontSize: 18, fill: index === 1 ? 0x4dabf7 : 0xffffff },
  }));
  const ids = layers.map((layer) => layer.createMany(specs));
  const comparisons: FrameComparison[] = [];
  let before = resident.stats;
  const capture = async (phase: string): Promise<void> => {
    for (const layer of layers) await layer.commit();
    app.render();
    const actual = await readTargetPixels(app, resident, 320, 180);
    const reference = await readTargetPixels(app, layers[1]!, 320, 180);
    let differentBytes = 0;
    let nonTransparentPixels = 0;
    for (let index = 0; index < actual.pixels.length; index += 1) {
      if (actual.pixels[index] !== reference.pixels[index]) differentBytes += 1;
      if (index % 4 === 3 && actual.pixels[index]! > 0) nonTransparentPixels += 1;
    }
    const stats = resident.stats;
    comparisons.push({
      phase,
      differentBytes,
      nonTransparentPixels,
      residency: stats.residencyActive,
      prototypes: stats.gpuScenePrototypeCount,
      transformBytes: stats.transformUploadBytes - before.transformUploadBytes,
      recordBytes: stats.cullRecordUploadBytes - before.cullRecordUploadBytes,
      instanceBytes: stats.instanceUploadBytes - before.instanceUploadBytes,
    });
    before = stats;
  };
  const mutate = (action: (layer: TextLayer, ids: readonly TextId[]) => void): void => {
    layers.forEach((layer, index) => action(layer, ids[index]!));
  };
  await capture("setup-rotation");
  mutate((layer, ids) =>
    layer.updateTransforms(
      ids,
      new Float32Array([60, 45, 145, 85, 230, 125]),
      new Float32Array([0.5, -0.6, 2.8]),
    ),
  );
  await capture("packed-transform");
  mutate((layer, ids) =>
    layer.updatePositions([ids[0]!, ids[2]!], new Float32Array([55, 40, 235, 120])),
  );
  await capture("sparse-position");
  mutate((layer, ids) => {
    layer.updatePositions(ids, new Float32Array([60, 40, 145, 80, 235, 120]));
    layer.update(ids[1]!, { rotation: 0.2 });
  });
  await capture("mixed-position-rotation");
  mutate((layer, ids) =>
    layer.update(ids[0]!, {
      text: "wide words wrap",
      rotation: -0.2,
      style: {
        fontFamily: "Arial",
        fontSize: 18,
        fill: 0xffffff,
        wordWrap: true,
        wordWrapWidth: 65,
      },
    }),
  );
  await capture("word-wrap");
  mutate((layer, ids) => layer.update(ids[0]!, { text: "wide\nwords\nwrap" }));
  await capture("explicit-newline");
  mutate((layer, ids) => layer.update(ids[0]!, { text: "wide words wrap" }));
  await capture("cached-wrap-return");
  mutate((layer, ids) =>
    layer.update(ids[0]!, { layout: { writingMode: "vertical-rl" }, rotation: 0.2 }),
  );
  await capture("writing-flow");
  mutate((layer, ids) =>
    layer.updatePositions(ids, new Float32Array([-1000, 40, -1000, 80, -1000, 120])),
  );
  await capture("offscreen");
  mutate((layer, ids) => layer.updatePositions(ids, new Float32Array([60, 40, 145, 80, 235, 120])));
  await capture("return");
  layers[1]!.destroy();
  app.render();
  return comparisons;
}

async function runStress(
  app: Application,
  count: number,
  movers: number,
  frames: number,
): Promise<StressPhase[]> {
  const columns = 1000;
  const rows = Math.ceil(count / columns);
  const layer = new TextLayer({
    renderer: app.renderer,
    initialCapacity: count,
    culling: {
      residency: "gpu-scene",
      padding: 0,
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
    },
  });
  app.stage.addChild(layer);
  const ids = new Float64Array(movers);
  const style = Object.freeze({ fontFamily: "Arial", fontSize: 8, fill: 0xffffff });
  for (let start = 0; start < count; start += 25_000) {
    const specs: TextLabelSpec[] = [];
    for (let index = start; index < Math.min(start + 25_000, count); index += 1) {
      specs.push({
        text: "g",
        x: 16 + (index % columns) * 1.2,
        y: 16 + Math.floor(index / columns) * (740 / rows),
        style,
      });
    }
    const created = layer.createMany(specs);
    const retained = Math.min(created.length, Math.max(0, movers - start));
    for (let index = 0; index < retained; index += 1) ids[start + index] = created[index]!;
  }
  await layer.commit();
  app.render();
  const xy = new Float32Array(movers * 2);
  const rotations = new Float32Array(movers);
  const wrapCount = Math.min(movers, 1000);
  const wrapUpdates: TextUpdate[][] = [24, 5].map((wordWrapWidth) =>
    Array.from({ length: wrapCount }, (_, index) => ({
      id: ids[index]! as TextId,
      patch: { text: "g g", style: { ...style, wordWrap: true, wordWrapWidth, breakWords: true } },
    })),
  );
  const phases: StressPhase[] = [];
  const timer = createGpuFrameTimer(app.renderer);
  try {
    for (const phase of ["position", "rotation", "wrap"] as const) {
      const frameMs: number[] = [];
      const mutationMs: number[] = [];
      const commitMs: number[] = [];
      const gpuMs: number[] = [];
      const sceneGpuMs: number[] = [];
      const transformBytes: number[] = [];
      const recordBytes: number[] = [];
      for (let frame = 0; frame < frames + 10; frame += 1) {
        const before = layer.stats;
        const start = performance.now();
        const direction = frame % 2 === 0 ? 1 : -1;
        for (let index = 0; phase !== "wrap" && index < movers; index += 1) {
          xy[index * 2] = 16 + (index % columns) * 1.2 + direction * 2;
          xy[index * 2 + 1] = 16 + Math.floor(index / columns) * (740 / rows) + direction;
          rotations[index] = direction * 0.4;
        }
        if (phase === "position") layer.updatePositions(ids, xy);
        else if (phase === "rotation") layer.updateTransforms(ids, xy, rotations);
        else layer.updateMany(wrapUpdates[frame % 2]!);
        const mutated = performance.now();
        await layer.commit();
        const committed = performance.now();
        const rendered = await completeFrame(app, timer);
        if (frame < 10) continue;
        frameMs.push(performance.now() - start);
        mutationMs.push(mutated - start);
        commitMs.push(committed - mutated);
        if (rendered.gpuTimestampMs !== null) gpuMs.push(rendered.gpuTimestampMs);
        if (rendered.sceneRenderGpuTimestampMs !== null)
          sceneGpuMs.push(rendered.sceneRenderGpuTimestampMs);
        transformBytes.push(layer.stats.transformUploadBytes - before.transformUploadBytes);
        recordBytes.push(layer.stats.cullRecordUploadBytes - before.cullRecordUploadBytes);
      }
      phases.push({
        phase,
        mutationsPerFrame: phase === "wrap" ? wrapCount : movers,
        frameMs: summarize(frameMs, "ms"),
        mutationMs: summarize(mutationMs, "ms"),
        commitMs: summarize(commitMs, "ms"),
        gpuMs: gpuMs.length === 0 ? null : summarize(gpuMs, "ms"),
        sceneGpuMs: sceneGpuMs.length === 0 ? null : summarize(sceneGpuMs, "ms"),
        gpuTiming: timer.capability.method,
        transformBytes,
        recordBytes,
        submittedGlyphs: await layer.readSubmittedGlyphs(),
        residency: layer.stats.residencyActive,
      });
    }
    return phases;
  } finally {
    timer.destroy();
  }
}

function boundedCount(
  query: URLSearchParams,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = Number(query.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`Invalid ${name}`);
  return value;
}

function publish(state: TransformLayoutFixtureState): void {
  window.__gpuTransformLayout = state;
  document.querySelector("#result")!.textContent = JSON.stringify(state, null, 2);
}
