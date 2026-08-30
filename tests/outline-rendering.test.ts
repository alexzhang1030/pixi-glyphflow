import { describe, expect, test } from "bun:test";

import {
  createOutlineRendering,
  type OutlineColorAtlas,
  type OutlineComputeRasterizer,
  type OutlineComputeRasterResult,
  type OutlineComputeRasterRequest,
} from "../src/render/outline";
import { AtlasLease } from "../src/render/outline/rendering";
import { packedRectangle } from "./fixtures/outlineFixtures";

describe("outline rendering plugin", () => {
  test("routes below-threshold work before consulting the packed source", async () => {
    let sourceCalls = 0;
    const rasterizer = new FakeRasterizer();
    const plugin = createOutlineRendering({
      projectedSizeThresholdPx: 64,
      rasterizer,
      source: () => {
        sourceCalls += 1;
        return packedRecord();
      },
    });

    expect(plugin.route(63)).toEqual({ path: "atlas", reason: "below-projected-threshold" });
    expect(
      await plugin.rasterize({
        family: "fixture",
        fontRevision: 1,
        glyphId: 7,
        fontSize: 4,
        projectedHeightPx: 63,
      }),
    ).toEqual({ status: "fallback", reason: "below-projected-threshold" });
    expect(sourceCalls).toBe(0);
    expect(rasterizer.batchSizes).toEqual([]);

    plugin.destroy();
  });

  test("keeps capability, source, and preparation fallbacks explicit", async () => {
    let unavailableSourceCalls = 0;
    const unavailableRasterizer: OutlineComputeRasterizer = {
      capability: { status: "unsupported", reason: "webgpu-unavailable" },
      rasterize: async () => {
        throw new Error("capability fallback reached compute");
      },
      destroy: () => {},
    };
    const unavailable = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      rasterizer: unavailableRasterizer,
      source: () => {
        unavailableSourceCalls += 1;
        return packedRecord();
      },
    });
    const request = {
      family: "fixture",
      fontRevision: 1,
      glyphId: 7,
      fontSize: 4,
      projectedHeightPx: 8,
    } as const;

    expect(await unavailable.rasterize(request)).toEqual({
      status: "fallback",
      reason: "capability-unavailable",
    });
    expect(unavailableSourceCalls).toBe(0);
    unavailable.destroy();

    const missingRasterizer = new FakeRasterizer();
    const missing = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      rasterizer: missingRasterizer,
      source: () => undefined,
    });
    expect(await missing.rasterize(request)).toEqual({
      status: "fallback",
      reason: "packed-source-unavailable",
    });
    expect(missingRasterizer.batchSizes).toEqual([]);
    missing.destroy();

    const limited = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      prepareOptions: { maxBlobBytes: 8 },
      rasterizer: new FakeRasterizer(),
      source: packedRecord,
    });
    expect(await limited.rasterize(request)).toEqual({
      status: "fallback",
      reason: "resource-limits",
      limit: "blob-bytes",
    });
    limited.destroy();
  });

  test("batches one microtask, interns preparation, and releases its atlas by reference count", async () => {
    let sourceCalls = 0;
    const rasterizer = new FakeRasterizer();
    const plugin = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      padding: 1,
      rasterizer,
      source: () => {
        sourceCalls += 1;
        return packedRecord();
      },
    });
    const request = {
      family: "fixture",
      fontRevision: 1,
      glyphId: 7,
      fontSize: 4,
      projectedHeightPx: 8,
      rasterPixelHeight: 8,
      advance: 5,
    } as const;

    const [first, second] = await Promise.all([
      plugin.rasterize(request),
      plugin.rasterize({ ...request, color: [0.25, 0.5, 1, 0.75] }),
    ]);

    expect(sourceCalls).toBe(1);
    expect(rasterizer.batchSizes).toEqual([2]);
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") {
      throw new Error("outline fixture did not produce ready rasters");
    }
    expect(first.raster.source.texture).toBe(second.raster.source.texture);
    expect(first.raster).toMatchObject({
      mode: "color",
      width: 10,
      height: 10,
      sourceX: 0,
      sourceY: 0,
      metrics: {
        bearingX: -0.5,
        bearingY: 4.5,
        advance: 5,
        rasterScale: 2,
      },
    });
    expect(rasterizer.atlasDestroys).toBe(0);
    first.raster.release();
    first.raster.release();
    expect(rasterizer.atlasDestroys).toBe(0);
    second.raster.release();
    expect(rasterizer.atlasDestroys).toBe(1);

    plugin.destroy();
    expect(rasterizer.destroyCalls).toBe(1);
  });

  test("separates packed glyph tuples containing field delimiters", async () => {
    const sourceRequests: Array<{
      readonly family: string;
      readonly fontRevision: number;
      readonly glyphId: number;
      readonly variationKey?: string;
    }> = [];
    const rasterizer = new FakeRasterizer();
    const plugin = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      rasterizer,
      source: (request) => {
        sourceRequests.push({ ...request });
        return packedRecord();
      },
    });
    const shared = { fontSize: 4, projectedHeightPx: 8 } as const;

    const [first, second] = await Promise.all([
      plugin.rasterize({
        ...shared,
        family: "fixture",
        fontRevision: 1,
        glyphId: 2,
        variationKey: "3\0tail",
      }),
      plugin.rasterize({
        ...shared,
        family: "fixture\u00001",
        fontRevision: 2,
        glyphId: 3,
        variationKey: "tail",
      }),
    ]);

    expect(sourceRequests).toEqual([
      { family: "fixture", fontRevision: 1, glyphId: 2, variationKey: "3\0tail" },
      { family: "fixture\u00001", fontRevision: 2, glyphId: 3, variationKey: "tail" },
    ]);
    if (first.status === "ready") first.raster.release();
    if (second.status === "ready") second.raster.release();
    plugin.destroy();
  });

  test("destroy settles queued work and retires outstanding atlas leases", async () => {
    let resolveSource: ((record: ReturnType<typeof packedRecord>) => void) | undefined;
    const source = new Promise<ReturnType<typeof packedRecord>>((resolve) => {
      resolveSource = resolve;
    });
    const rasterizer = new FakeRasterizer();
    const plugin = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      rasterizer,
      source: () => source,
    });
    const pending = plugin.rasterize({
      family: "fixture",
      fontRevision: 1,
      glyphId: 7,
      fontSize: 4,
      projectedHeightPx: 8,
    });
    await Promise.resolve();

    plugin.destroy();
    expect(await pending).toEqual({
      status: "failed",
      reason: "destroyed",
      message: "outline rendering plugin has been destroyed",
    });
    resolveSource?.(packedRecord());
    await Promise.resolve();
    expect(rasterizer.batchSizes).toEqual([]);

    const liveRasterizer = new FakeRasterizer();
    const live = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      rasterizer: liveRasterizer,
      source: packedRecord,
    });
    const ready = await live.rasterize({
      family: "fixture",
      fontRevision: 1,
      glyphId: 7,
      fontSize: 4,
      projectedHeightPx: 8,
    });
    expect(ready.status).toBe("ready");
    live.destroy();
    expect(liveRasterizer.atlasDestroys).toBe(1);
    if (ready.status === "ready") ready.raster.release();
    expect(liveRasterizer.atlasDestroys).toBe(1);
  });

  test("detaches a lease before atlas cleanup and completes both faulting steps once", () => {
    const detachError = new Error("lease detach failed");
    const atlasError = new Error("atlas cleanup failed");
    const calls: string[] = [];
    const lease = new AtlasLease(
      {
        texture: {} as GPUTexture,
        format: "rgba8unorm",
        width: 1,
        height: 1,
        entries: [],
        destroy: () => {
          calls.push("atlas");
          throw atlasError;
        },
      },
      1,
      () => {
        calls.push("detach");
        throw detachError;
      },
    );

    let receivedError: unknown;
    try {
      lease.destroy();
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBe(detachError);
    expect(calls).toEqual(["detach", "atlas"]);
    expect(() => lease.destroy()).not.toThrow();
    expect(() => lease.release()).not.toThrow();
    expect(calls).toEqual(["detach", "atlas"]);
  });

  test("completes every lease and rasterizer cleanup once and rethrows the first failure", async () => {
    const firstAtlasError = new Error("first atlas cleanup failed");
    const secondAtlasError = new Error("second atlas cleanup failed");
    const rasterizerError = new Error("rasterizer cleanup failed");
    const rasterizer = new FakeRasterizer([firstAtlasError, secondAtlasError], rasterizerError);
    const plugin = createOutlineRendering({
      projectedSizeThresholdPx: 8,
      rasterizer,
      source: packedRecord,
    });
    const request = {
      family: "fixture",
      fontRevision: 1,
      fontSize: 4,
      projectedHeightPx: 8,
    } as const;
    const first = await plugin.rasterize({ ...request, glyphId: 7 });
    const second = await plugin.rasterize({ ...request, glyphId: 8 });
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");

    let receivedError: unknown;
    try {
      plugin.destroy();
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBe(firstAtlasError);
    expect(rasterizer.atlasDestroyCalls).toEqual([1, 1]);
    expect(rasterizer.destroyCalls).toBe(1);
    expect(() => plugin.destroy()).not.toThrow();
    if (first.status === "ready") first.raster.release();
    if (second.status === "ready") second.raster.release();
    expect(rasterizer.atlasDestroyCalls).toEqual([1, 1]);
    expect(rasterizer.destroyCalls).toBe(1);
  });
});

class FakeRasterizer implements OutlineComputeRasterizer {
  readonly capability = {
    status: "supported" as const,
    maxTextureDimension2D: 8_192,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65_535,
  };
  readonly batchSizes: number[] = [];
  readonly atlasDestroyCalls: number[] = [];
  readonly #atlasDestroyErrors: readonly unknown[];
  readonly #destroyError: unknown;
  atlasDestroys = 0;
  destroyCalls = 0;

  constructor(atlasDestroyErrors: readonly unknown[] = [], destroyError: unknown = undefined) {
    this.#atlasDestroyErrors = atlasDestroyErrors;
    this.#destroyError = destroyError;
  }

  async rasterize(
    requests: readonly Readonly<OutlineComputeRasterRequest>[],
  ): Promise<Readonly<OutlineComputeRasterResult>> {
    const atlasIndex = this.batchSizes.length;
    this.batchSizes.push(requests.length);
    let x = 0;
    const entries = requests.map((request, requestIndex) => {
      const padding = request.padding ?? 1;
      const scale = request.pixelHeight / request.glyph.quad.height;
      const width = Math.ceil(request.glyph.quad.width * scale) + padding * 2;
      const height = request.pixelHeight + padding * 2;
      const entry = {
        requestIndex,
        x,
        y: 0,
        width,
        height,
        contentWidth: width - padding * 2,
        contentHeight: height - padding * 2,
        padding,
        scale,
        quad: request.glyph.quad,
      };
      x += width;
      return entry;
    });
    const texture = {} as GPUTexture;
    const atlas: OutlineColorAtlas = {
      texture,
      format: "rgba8unorm",
      width: x,
      height: Math.max(...entries.map((entry) => entry.height)),
      entries,
      destroy: () => {
        this.atlasDestroys += 1;
        this.atlasDestroyCalls[atlasIndex] = (this.atlasDestroyCalls[atlasIndex] ?? 0) + 1;
        const error = this.#atlasDestroyErrors[atlasIndex];
        if (error !== undefined) throw error;
      },
    };
    return { status: "ready", atlas };
  }

  destroy(): void {
    this.destroyCalls += 1;
    if (this.#destroyError !== undefined) throw this.#destroyError;
  }
}

function packedRecord(): {
  readonly extents: {
    readonly xBearing: number;
    readonly yBearing: number;
    readonly width: number;
    readonly height: number;
  };
  readonly packedCurveBlob: Uint8Array;
} {
  return {
    extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
    packedCurveBlob: packedRectangle(),
  };
}
