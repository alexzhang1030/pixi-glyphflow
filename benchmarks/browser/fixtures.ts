import { BitmapText, Container, HTMLText, Text, type Application } from "pixi.js";

import { TextLayer, type TextLabelSpec } from "../../src";
import { TRANSFORM_PALETTE_STRIDE } from "../../src/advanced";
import type {
  BrowserBenchmarkCounters,
  BrowserBenchmarkFixture,
  BrowserBenchmarkTimings,
} from "../schema";

export interface StaticHudFixtureOptions {
  readonly fixture: BrowserBenchmarkFixture;
  readonly labelCount: number;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
}

export interface BrowserFixtureResult {
  readonly timings: Readonly<BrowserBenchmarkTimings>;
  readonly counters: Readonly<BrowserBenchmarkCounters>;
  readonly invariants: Readonly<Record<string, boolean | number | string>>;
}

interface FixtureHandle {
  readonly container: Container;
  readonly counters: Readonly<BrowserBenchmarkCounters>;
  readonly prepare?: () => Promise<void>;
  readonly destroy: () => void;
}

const FONT_FAMILY = "Arial";
const FONT_SIZE = 12;
const COLUMNS = 40;
const CELL_WIDTH = 32;
const CELL_HEIGHT = 28;

export async function runStaticHudFixture(
  app: Application,
  options: StaticHudFixtureOptions,
): Promise<Readonly<BrowserFixtureResult>> {
  const content = buildStaticHudContent(options.labelCount);
  const setupStart = performance.now();
  const handle = await createFixture(app, options.fixture, content);
  app.stage.addChild(handle.container);
  renderAndFinish(app);
  await handle.prepare?.();
  renderAndFinish(app);
  const setupMs = performance.now() - setupStart;

  for (let frame = 0; frame < options.warmupFrames; frame += 1) renderAndFinish(app);
  const frameMs: number[] = [];
  for (let frame = 0; frame < options.sampleFrames; frame += 1) {
    const start = performance.now();
    renderAndFinish(app);
    frameMs.push(performance.now() - start);
  }
  const counters = handle.counters;
  handle.destroy();

  return Object.freeze({
    timings: Object.freeze({ setupMs, frameMs: Object.freeze(frameMs) }),
    counters,
    invariants: Object.freeze({
      exactLabelCount: counters.residentLabels === options.labelCount,
      exactSubmittedCount: counters.submittedLabels === options.labelCount,
      everyFrameMeasured:
        frameMs.length === options.sampleFrames &&
        frameMs.every((sample) => Number.isFinite(sample) && sample >= 0),
      equalContentKey: `${String(options.labelCount)}:${String(counters.visibleGlyphs)}`,
    }),
  });
}

async function createFixture(
  app: Application,
  fixture: BrowserBenchmarkFixture,
  content: readonly Readonly<TextLabelSpec>[],
): Promise<FixtureHandle> {
  if (fixture === "glyphflow") return createGlyphflowFixture(app, content);
  const container = new Container();
  const htmlLabels: HTMLText[] = [];
  for (const spec of content) {
    const style = {
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      fill: 0xffffff,
    };
    const label =
      fixture === "text"
        ? new Text({ text: spec.text, style })
        : fixture === "bitmap-text"
          ? new BitmapText({ text: spec.text, style })
          : new HTMLText({ text: spec.text, style });
    if (label instanceof HTMLText) htmlLabels.push(label);
    label.position.set(spec.x ?? 0, spec.y ?? 0);
    container.addChild(label);
  }
  const visibleGlyphs = countGlyphs(content);

  return {
    container,
    counters: Object.freeze({
      residentLabels: content.length,
      submittedLabels: content.length,
      visibleGlyphs,
      drawCalls: 0,
    }),
    ...(fixture === "html-text" ? { prepare: () => waitForHtmlTextures(app, htmlLabels) } : {}),
    destroy: () => container.destroy({ children: true }),
  };
}

async function createGlyphflowFixture(
  app: Application,
  content: readonly Readonly<TextLabelSpec>[],
): Promise<FixtureHandle> {
  const layer = new TextLayer({
    renderer: app.renderer,
    initialCapacity: content.length,
    culling: false,
  });
  layer.createMany(content);
  await layer.commit();
  const stats = layer.stats;

  return {
    container: layer,
    counters: Object.freeze({
      residentLabels: stats.labelCount,
      submittedLabels: stats.visibleLabelCount,
      visibleGlyphs: countGlyphs(content),
      drawCalls: stats.drawCalls,
      allocatedStoreBytes: stats.allocatedStoreBytes,
      instanceBytes: stats.glyphCount * 32,
      transformBytes: stats.capacity * TRANSFORM_PALETTE_STRIDE,
      labelRevision: Number(stats.revision),
      shapedLabels: stats.shapedLabels,
      transformOnlyLabels: stats.transformOnlyLabels,
    }),
    destroy: () => layer.destroy(),
  };
}

function buildStaticHudContent(labelCount: number): readonly Readonly<TextLabelSpec>[] {
  const style = Object.freeze({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fill: 0xffffff,
  });

  return Array.from({ length: labelCount }, (_, index) => ({
    text: `HUD ${String(index).padStart(4, "0")}`,
    x: (index % COLUMNS) * CELL_WIDTH,
    y: Math.floor(index / COLUMNS) * CELL_HEIGHT + FONT_SIZE,
    style,
  }));
}

function countGlyphs(content: readonly Readonly<TextLabelSpec>[]): number {
  let count = 0;
  for (const spec of content) count += Array.from(spec.text).length;

  return count;
}

function renderAndFinish(app: Application): void {
  app.render();
  if ("gl" in app.renderer) app.renderer.gl.finish();
}

async function waitForHtmlTextures(app: Application, labels: readonly HTMLText[]): Promise<void> {
  const rendererUid = app.renderer.uid;
  const promises = labels.map((label) => {
    const gpuData = (
      label as unknown as {
        _gpuData: Record<number, { texturePromise?: Promise<unknown> | null }>;
      }
    )._gpuData[rendererUid];
    return gpuData?.texturePromise ?? Promise.resolve();
  });
  await Promise.all(promises);
}
