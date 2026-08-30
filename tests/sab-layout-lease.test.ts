import { describe, expect, test } from "bun:test";

import type { GlyphRaster } from "../src/atlas/types";
import { FontRegistry } from "../src/FontRegistry";
import { LayoutEngine } from "../src/layout/LayoutEngine";
import {
  isLeasedPositionedRun,
  leasePositionedRun,
  ownedPositionedRun,
  releasePositionedRun,
  retainPositionedRun,
} from "../src/layout/PositionedRunLease";
import type { PositionedRun } from "../src/layout/types";
import { RenderCoordinator, type GlyphProviderLike } from "../src/render/RenderCoordinator";
import { SabShapeTransport, type ShapeResultResponse } from "../src/worker/SabShapeTransport";

const CONTENT = 1;
const STYLE = 4;

describe("leased positioned runs", () => {
  test("shares one owned copy across retained borrowers and settles the final release", () => {
    let releases = 0;
    const leased = leasePositionedRun(shapeResult(1).run, () => {
      releases += 1;
    });
    const retained = retainPositionedRun(leased);

    expect(ownedPositionedRun(retained)).toBe(ownedPositionedRun(leased));
    releasePositionedRun(leased);
    expect(releases).toBe(0);
    releasePositionedRun(retained);
    expect(releases).toBe(1);
  });

  test("rejects first materialization after a released SAB slot is reused", () => {
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    expect(producer.tryWrite(shapeResult(1, "A"))).toBe(true);
    const firstLease = consumer.tryRead();
    if (firstLease === undefined) throw new Error("Expected the first SAB shape result");
    const first = leasePositionedRun(firstLease.result.run, () => firstLease.release());

    releasePositionedRun(first);
    expect(producer.tryWrite(shapeResult(2, "B"))).toBe(true);
    const secondLease = consumer.tryRead();
    if (secondLease === undefined) throw new Error("Expected the reused SAB shape result");
    try {
      expect(() => ownedPositionedRun(first)).toThrow(
        "Positioned-run lease has already been released",
      );
    } finally {
      secondLease.release();
      producer.destroy();
    }
  });

  test("returns a pre-materialized owned copy after its SAB slot is reused", () => {
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    expect(producer.tryWrite(shapeResult(1, "A"))).toBe(true);
    const firstLease = consumer.tryRead();
    if (firstLease === undefined) throw new Error("Expected the first SAB shape result");
    const first = leasePositionedRun(firstLease.result.run, () => firstLease.release());
    const owned = ownedPositionedRun(first);
    expect(owned.glyphIds.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...owned.glyphIds]).toEqual([65]);

    releasePositionedRun(first);
    expect(producer.tryWrite(shapeResult(2, "B"))).toBe(true);
    const secondLease = consumer.tryRead();
    if (secondLease === undefined) throw new Error("Expected the reused SAB shape result");
    try {
      expect([...first.glyphIds]).toEqual([66]);
      expect(ownedPositionedRun(first)).toBe(owned);
      expect([...owned.glyphIds]).toEqual([65]);
    } finally {
      secondLease.release();
      producer.destroy();
    }
  });

  test("keeps only an owned copy in the layout cache while the caller holds the SAB lease", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    expect(producer.tryWrite(shapeResult(1))).toBe(true);
    let shapeCalls = 0;
    const engine = new LayoutEngine(registry, {
      harfbuzzShaper: {
        async shape() {
          shapeCalls += 1;
          const lease = consumer.tryRead();
          if (lease === undefined) throw new Error("Expected a published SAB shape result");
          return leasePositionedRun(lease.result.run, () => lease.release());
        },
      },
    });

    const first = await engine.layout(7, 1, layoutInput());
    expect(isLeasedPositionedRun(first)).toBe(true);
    expect(first.glyphIds.buffer).toBe(producer.buffer);
    expect(ownedPositionedRun(first).yAdvance[0]).toBe(16);
    const cachedResult = engine.layout(8, 1, layoutInput());
    expect(cachedResult).not.toBeInstanceOf(Promise);
    const cached = await cachedResult;
    expect(shapeCalls).toBe(1);
    expect(isLeasedPositionedRun(cached)).toBe(false);
    expect(cached.glyphIds.buffer).toBeInstanceOf(ArrayBuffer);
    expect(cached.yAdvance[0]).toBe(16);

    expect(producer.tryWrite(shapeResult(2))).toBe(false);
    releasePositionedRun(first);
    expect(producer.tryWrite(shapeResult(2))).toBe(true);
    consumer.tryRead()?.release();
    engine.destroy();
    producer.destroy();
    registry.destroy();
  });

  test("preserves a bitmap layout failure while missing-run release also fails", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Binary", source: new Uint8Array([1]) });
    await registry.register({ family: "System" });
    const layoutFailure = new Error("bitmap layout failed");
    const releaseFailure = new Error("missing-run release failed");
    let releases = 0;
    const engine = new LayoutEngine(registry, {
      bitmapAdapter: {
        layout() {
          throw layoutFailure;
        },
      },
      harfbuzzShaper: {
        async shape() {
          return leasedLayoutRun(0, () => {
            releases += 1;
            throw releaseFailure;
          });
        },
      },
    });

    await expect(
      engine.layout(7, 1, {
        text: "A",
        style: { fontFamily: ["Binary", "System"], fontSize: 16 },
      }),
    ).rejects.toBe(layoutFailure);
    expect(releases).toBe(1);

    engine.destroy();
    registry.destroy();
  });

  test("preserves a writing-mode failure while the selected-run release also fails", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Binary", source: new Uint8Array([1]) });
    const writingFailure = new Error("writing-mode failed");
    const releaseFailure = new Error("selected-run release failed");
    let releases = 0;
    const lineIndices = {
      get 0(): number {
        throw writingFailure;
      },
      length: 1,
      *[Symbol.iterator](): IterableIterator<number> {
        yield 0;
      },
    } as unknown as Uint32Array<ArrayBuffer>;
    const engine = new LayoutEngine(registry, {
      harfbuzzShaper: {
        async shape() {
          return leasedLayoutRun(
            65,
            () => {
              releases += 1;
              throw releaseFailure;
            },
            lineIndices,
          );
        },
      },
    });

    await expect(
      engine.layout(7, 1, {
        text: "A",
        style: { fontFamily: "Binary", fontSize: 16 },
        writingMode: "vertical-rl",
      }),
    ).rejects.toBe(writingFailure);
    expect(releases).toBe(1);

    engine.destroy();
    registry.destroy();
  });

  test("releases every leased run after the first cleanup failure", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Missing", source: new Uint8Array([1]) });
    await registry.register({ family: "Complete", source: new Uint8Array([2]) });
    const firstReleaseFailure = new Error("first release failed");
    const releaseCounts: [number, number] = [0, 0];
    const engine = new LayoutEngine(registry, {
      harfbuzzShaper: {
        async shape(_labelId, _sourceRevision, input) {
          if (input.family === "Missing") {
            return leasedLayoutRun(0, () => {
              releaseCounts[0] += 1;
              throw firstReleaseFailure;
            });
          }
          return leasedLayoutRun(65, () => {
            releaseCounts[1] += 1;
            throw new Error("second release failed");
          });
        },
      },
    });

    await expect(
      engine.layout(7, 1, {
        text: "A",
        style: { fontFamily: ["Missing", "Complete"], fontSize: 16 },
      }),
    ).rejects.toBe(firstReleaseFailure);
    expect(releaseCounts).toEqual([1, 1]);

    engine.destroy();
    registry.destroy();
  });

  test("returns the selected lease after releasing the missing run exactly once", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Missing", source: new Uint8Array([1]) });
    await registry.register({ family: "Complete", source: new Uint8Array([2]) });
    const releaseCounts: [number, number] = [0, 0];
    const engine = new LayoutEngine(registry, {
      harfbuzzShaper: {
        async shape(_labelId, _sourceRevision, input) {
          const index = input.family === "Missing" ? 0 : 1;
          return leasedLayoutRun(index === 0 ? 0 : 65, () => {
            releaseCounts[index] += 1;
          });
        },
      },
    });

    const selected = await engine.layout(7, 1, {
      text: "A",
      style: { fontFamily: ["Missing", "Complete"], fontSize: 16 },
    });
    expect(isLeasedPositionedRun(selected)).toBe(true);
    expect(releaseCounts).toEqual([1, 0]);
    releasePositionedRun(selected);
    releasePositionedRun(selected);
    expect(releaseCounts).toEqual([1, 1]);

    engine.destroy();
    registry.destroy();
  });

  test("releases after raster and instance consumption, then persists an owned run", async () => {
    const fixture = await createCoordinatorFixture();
    const commit = fixture.coordinator.commit(1, [renderChange(1)]);
    await fixture.raster.started;

    expect(fixture.producer.tryWrite(shapeResult(2))).toBe(false);
    fixture.raster.resolve(alphaRaster());
    expect(await commit).toMatchObject({ stale: false, appliedLabels: 1 });
    const persisted = fixture.coordinator.getRun(0);
    expect(persisted).toBeDefined();
    expect(isLeasedPositionedRun(persisted!)).toBe(false);
    expect(persisted!.glyphIds.buffer).toBeInstanceOf(ArrayBuffer);
    expect(fixture.producer.tryWrite(shapeResult(2))).toBe(true);

    fixture.consumer.tryRead()?.release();
    fixture.destroy();
  });

  test("releases a SAB lease when raster consumption throws", async () => {
    const fixture = await createCoordinatorFixture();
    const commit = fixture.coordinator.commit(1, [renderChange(1)]);
    await fixture.raster.started;
    fixture.raster.reject(new Error("raster failed"));

    await expect(commit).rejects.toThrow("raster failed");
    expect(fixture.producer.tryWrite(shapeResult(2))).toBe(true);
    fixture.consumer.tryRead()?.release();
    fixture.destroy();
  });

  test("releases stale and destroyed render scopes exactly once", async () => {
    const stale = await createCoordinatorFixture();
    const oldCommit = stale.coordinator.commit(1, [renderChange(1)]);
    await stale.raster.started;
    expect(await stale.coordinator.commit(2, [])).toMatchObject({ stale: false });
    stale.raster.resolve(alphaRaster());
    expect(await oldCommit).toMatchObject({ stale: true, appliedLabels: 0 });
    expect(stale.producer.tryWrite(shapeResult(2))).toBe(true);
    stale.consumer.tryRead()?.release();
    stale.destroy();

    const destroyed = await createCoordinatorFixture();
    const pending = destroyed.coordinator.commit(1, [renderChange(1)]);
    await destroyed.raster.started;
    destroyed.coordinator.destroy();
    expect(destroyed.producer.tryWrite(shapeResult(2))).toBe(true);
    destroyed.consumer.tryRead()?.release();
    destroyed.raster.resolve(alphaRaster());
    expect(await pending).toMatchObject({ stale: true, appliedLabels: 0 });
    destroyed.producer.destroy();
    destroyed.registry.destroy();
  });

  test("commits two uncached same-family texts while both SAB leases remain live", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    let requestId = 1;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        async layout(_labelId, _sourceRevision, input): Promise<Readonly<PositionedRun>> {
          const currentRequestId = requestId;
          requestId += 1;
          await producer.write(shapeResult(currentRequestId, input.text));
          const lease = await consumer.read();
          return leasePositionedRun(lease.result.run, () => lease.release());
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize() {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
      instanceOptions: { initialCapacity: 2 },
      transformOptions: { initialCapacity: 2, textureWidth: 2 },
    });

    try {
      const result = await withTimeout(
        coordinator.commit(1, [renderChange(1, 0, "A"), renderChange(1, 1, "B")]),
        1_000,
      );
      expect(result).toMatchObject({ stale: false, appliedLabels: 2 });
      expect([coordinator.getRun(0)?.text, coordinator.getRun(1)?.text]).toEqual(["A", "B"]);
      expect(coordinator.getRun(0)?.glyphIds.buffer).toBeInstanceOf(ArrayBuffer);
      expect(coordinator.getRun(1)?.glyphIds.buffer).toBeInstanceOf(ArrayBuffer);
      expect(producer.tryWrite(shapeResult(3, "C"))).toBe(true);
      consumer.tryRead()?.release();
    } finally {
      coordinator.destroy();
      producer.destroy();
      registry.destroy();
    }
  });
});

async function createCoordinatorFixture(): Promise<{
  readonly registry: FontRegistry;
  readonly producer: SabShapeTransport;
  readonly consumer: SabShapeTransport;
  readonly raster: DeferredRasterProvider;
  readonly coordinator: RenderCoordinator;
  readonly destroy: () => void;
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture" });
  const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
  const consumer = SabShapeTransport.attach(producer.buffer);
  producer.tryWrite(shapeResult(1));
  const raster = new DeferredRasterProvider();
  const coordinator = new RenderCoordinator({
    registry,
    layoutEngine: {
      async layout(): Promise<Readonly<PositionedRun>> {
        const lease = consumer.tryRead();
        if (lease === undefined) throw new Error("Expected a published SAB shape result");
        return leasePositionedRun(lease.result.run, () => lease.release());
      },
      destroy() {},
    },
    glyphProvider: raster,
    atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    instanceOptions: { initialCapacity: 2 },
    transformOptions: { initialCapacity: 2, textureWidth: 2 },
  });
  return {
    registry,
    producer,
    consumer,
    raster,
    coordinator,
    destroy() {
      coordinator.destroy();
      producer.destroy();
      registry.destroy();
    },
  };
}

class DeferredRasterProvider implements GlyphProviderLike {
  readonly started: Promise<void>;
  readonly #start: () => void;
  readonly #result: Promise<Readonly<GlyphRaster>>;
  readonly resolve: (value: Readonly<GlyphRaster>) => void;
  readonly reject: (error: Error) => void;

  constructor() {
    let start = (): void => undefined;
    this.started = new Promise((resolve) => {
      start = resolve;
    });
    this.#start = start;
    let resolveResult = (_value: Readonly<GlyphRaster>): void => undefined;
    let rejectResult = (_error: Error): void => undefined;
    this.#result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.resolve = resolveResult;
    this.reject = rejectResult;
  }

  rasterize(): Promise<Readonly<GlyphRaster>> {
    this.#start();
    return this.#result;
  }

  destroy(): void {}
}

function layoutInput() {
  return {
    text: "A",
    style: { fontFamily: "Fixture", fontSize: 16 },
    writingMode: "vertical-rl" as const,
  };
}

function renderChange(sourceRevision: number, slot = 0, text = "A") {
  return {
    slot,
    mask: CONTENT | STYLE,
    snapshot: {
      sourceRevision,
      text,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      zIndex: 0,
      order: slot + 1,
      blendMode: "normal" as const,
      alpha: 1,
      visible: true,
      anchorX: 0,
      anchorY: 0,
      style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
    },
  };
}

function shapeResult(requestId: number, text = "A"): Readonly<ShapeResultResponse> {
  const glyphId = text.codePointAt(0) ?? 0;
  return {
    type: "shape-result",
    requestId,
    labelId: 7,
    sourceRevision: 1,
    fontRevision: 1,
    run: {
      source: "harfbuzz",
      text,
      fontFamily: "Fixture",
      fontRevision: 1,
      glyphCount: 1,
      direction: "ltr",
      glyphIds: new Uint32Array([glyphId]),
      clusters: new Uint32Array([0]),
      clusterEnds: new Uint32Array([1]),
      x: new Float32Array([0]),
      y: new Float32Array([0]),
      xAdvance: new Float32Array([8]),
      yAdvance: new Float32Array([0]),
      lineIndices: new Uint32Array([0]),
      bounds: { x: 0, y: -6, width: 8, height: 8 },
    },
  };
}

function leasedLayoutRun(
  glyphId: number,
  release: () => void,
  lineIndices = new Uint32Array([0]),
): Readonly<PositionedRun> {
  const run = shapeResult(glyphId + 1).run;
  return leasePositionedRun(
    Object.freeze({
      ...run,
      glyphIds: new Uint32Array([glyphId]),
      lineIndices,
    }),
    release,
  );
}

function alphaRaster(): Readonly<GlyphRaster> {
  return {
    mode: "alpha",
    width: 2,
    height: 2,
    pixels: new Uint8Array(4).fill(255),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SAB coordinator commit timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
