import { describe, expect, test } from "bun:test";

import { measureOutlineComputeRasterizer } from "../benchmarks/browser/outline";
import type {
  OutlineColorAtlas,
  OutlineComputeRasterizer,
  OutlineComputeRasterResult,
} from "../src/render/outline";

describe("outline browser benchmark helper", () => {
  test("separates cold compile from repeat raster samples and retires every atlas", async () => {
    let calls = 0;
    let destroys = 0;
    const rasterizer: OutlineComputeRasterizer = {
      capability: {
        status: "supported",
        maxTextureDimension2D: 8_192,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxComputeWorkgroupsPerDimension: 65_535,
      },
      rasterize: async (): Promise<Readonly<OutlineComputeRasterResult>> => {
        calls += 1;
        return { status: "ready", atlas: fakeAtlas(() => (destroys += 1)) };
      },
      destroy: () => {},
    };

    const result = await measureOutlineComputeRasterizer(rasterizer, [], {
      warmupIterations: 2,
      sampleIterations: 3,
    });

    expect(calls).toBe(6);
    expect(destroys).toBe(6);
    expect(result.timings.samplesMs).toHaveLength(3);
    expect(result.timings.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(
      true,
    );
    expect(result.counters).toEqual({ entryCount: 2, atlasPixels: 64 });
  });
});

function fakeAtlas(onDestroy: () => void): OutlineColorAtlas {
  return {
    texture: {} as GPUTexture,
    format: "rgba8unorm",
    width: 8,
    height: 8,
    entries: [
      {
        requestIndex: 0,
        x: 0,
        y: 0,
        width: 4,
        height: 8,
        contentWidth: 4,
        contentHeight: 8,
        padding: 0,
        scale: 1,
        quad: { minX: 0, minY: 0, maxX: 4, maxY: 8, width: 4, height: 8 },
      },
      {
        requestIndex: 1,
        x: 4,
        y: 0,
        width: 4,
        height: 8,
        contentWidth: 4,
        contentHeight: 8,
        padding: 0,
        scale: 1,
        quad: { minX: 0, minY: 0, maxX: 4, maxY: 8, width: 4, height: 8 },
      },
    ],
    destroy: onDestroy,
  };
}
