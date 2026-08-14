import { describe, expect, test } from "bun:test";

import {
  FontRegistry,
  RenderCoordinator,
  type GlyphRaster,
  type PositionedRun,
  type RasterGlyphRequest,
  type RenderChange,
} from "../src";

const CONTENT = 1;
const TRANSFORM = 2;
const STYLE = 4;

describe("RenderCoordinator", () => {
  test("atomically shapes, stages atlas glyphs, writes instances, and isolates transform updates", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    let rasterCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        async layout(_slot, _revision, input) {
          layoutCalls += 1;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(_request: RasterGlyphRequest): Promise<GlyphRaster> {
          rasterCalls += 1;
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 256 },
      instanceOptions: { initialCapacity: 4 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });
    const first = label(1, 10, 20);

    const initial = await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: first },
    ]);
    expect(initial).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2, atlasUploads: 2 });
    expect(coordinator.instances.getRange(0)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.transforms.stats.activeLabels).toBe(1);
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    coordinator.instances.consumeDirty();
    coordinator.transforms.consumeDirty();
    const instanceBytes = new Uint8Array(coordinator.instances.buffer).slice();

    const moved = await coordinator.commit(2, [
      { slot: 0, mask: TRANSFORM, snapshot: label(1, 100, 200) },
    ]);
    expect(moved).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2, atlasUploads: 0 });
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(coordinator.instances.consumeDirty()).toEqual([]);
    expect(new Uint8Array(coordinator.instances.buffer)).toEqual(instanceBytes);
    expect(coordinator.transforms.consumeDirty()).toEqual([{ offset: 0, length: 48 }]);

    await coordinator.commit(3, [{ slot: 0, mask: CONTENT, snapshot: undefined }]);
    expect(coordinator.instances.getRange(0)).toBeUndefined();
    expect(coordinator.transforms.stats.activeLabels).toBe(0);

    coordinator.destroy();
    registry.destroy();
  });

  test("keeps the newer label generation when asynchronous layouts resolve out of order", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const gates = new Map<string, () => void>();
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return new Promise<Readonly<PositionedRun>>((resolve) => {
            gates.set(input.text, () => resolve(run(input.text)));
          });
        },
        destroy() {},
      },
      glyphProvider: {
        rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          return Promise.resolve({
            mode: request.mode,
            width: 2,
            height: 2,
            pixels: new Uint8Array(request.mode === "color" ? 16 : 4).fill(255),
          });
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });

    const older = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0, "old") },
    ]);
    await waitForGate(gates, "old");
    const newer = coordinator.commit(2, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(2, 0, 0, "new") },
    ]);
    await waitForGate(gates, "new");
    gates.get("new")?.();
    expect(await newer).toMatchObject({ stale: false });
    gates.get("old")?.();
    expect(await older).toMatchObject({ stale: true, appliedLabels: 0 });
    expect(coordinator.getRun(0)?.text).toBe("new");

    coordinator.destroy();
    registry.destroy();
  });
});

function label(
  sourceRevision: number,
  x: number,
  y: number,
  text = "AB",
): NonNullable<RenderChange["snapshot"]> {
  return {
    sourceRevision,
    text,
    x,
    y,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
  };
}

function run(text: string): Readonly<PositionedRun> {
  return Object.freeze({
    source: "bitmap",
    text,
    fontFamily: "Fixture",
    fontRevision: 1,
    glyphCount: 2,
    direction: "ltr",
    glyphIds: new Uint32Array([65, 66]),
    clusters: new Uint32Array([0, 1]),
    x: new Float32Array([0, 5]),
    y: new Float32Array([0, 0]),
    xAdvance: new Float32Array([5, 5]),
    yAdvance: new Float32Array([0, 0]),
    lineIndices: new Uint32Array([0, 0]),
    glyphKeys: Object.freeze(["A", "B"]),
    bounds: Object.freeze({ x: 0, y: -5, width: 10, height: 6 }),
  });
}

async function waitForGate(gates: Map<string, () => void>, key: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (gates.has(key)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for layout gate: ${key}`);
}
