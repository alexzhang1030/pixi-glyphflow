import { describe, expect, test } from "bun:test";

import { SPARSE_STRIP_COMPUTE_WGSL } from "../src/render/outline/sparseStrip.wgsl";
import {
  SPARSE_STRIP_COMPUTE_LAYOUT,
  createSparseStripComputeRasterizer,
  inspectSparseStripComputeCapability,
  packSparseStripComputeBatch,
  preflightSparseStripComputePacking,
  type SparseStripComputeBatch,
} from "../src/render/outline/sparseStripCompute";
import { encodeSparseStripGlyph, type SparseStripGlyph } from "../src/render/outline/sparseStrips";
import type { OutlineCpuBitmap } from "../src/render/outline/types";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

describe("sparse strip compute adapter", () => {
  test("packs v1 headers, per-glyph row bounds, records, and little-endian coverage", () => {
    const first = encodeSparseStripGlyph(
      bitmap(12, 8, (x, y) => {
        if (y < 4 && x < 4) return x + y === 0 ? 128 : 255;
        if (y < 4 && x < 8) return 255;
        if (y >= 4 && x >= 4 && x < 8) return x === 4 && y === 4 ? 96 : 255;
        if (y >= 4 && x >= 8) return 255;
        return 0;
      }),
    );
    const second = encodeSparseStripGlyph(bitmap(4, 4, () => 255));
    const packed = packSparseStripComputeBatch(batch([first, second]));
    const secondBase = SPARSE_STRIP_COMPUTE_LAYOUT.glyphWords;

    expect(Array.from(packed.glyphs.slice(0, 12))).toEqual(Array.from(first.header));
    expect(Array.from(packed.glyphs.slice(secondBase, secondBase + 12))).toEqual(
      Array.from(second.header),
    );
    expect(Array.from(packed.rows)).toEqual([0, 2, 4, 0, 1]);
    expect(packed.glyphs[SPARSE_STRIP_COMPUTE_LAYOUT.metadata.recordWordOffset]).toBe(0);
    expect(packed.glyphs[secondBase + SPARSE_STRIP_COMPUTE_LAYOUT.metadata.recordWordOffset]).toBe(
      first.strips.length,
    );
    expect(
      packed.glyphs[secondBase + SPARSE_STRIP_COMPUTE_LAYOUT.metadata.coverageByteOffset],
    ).toBe(first.coverage.byteLength);
    expect(Array.from(packed.strips)).toEqual([...first.strips, ...second.strips]);
    expect(packed.coverage[0]).toBe(
      ((first.coverage[0] ?? 0) |
        ((first.coverage[1] ?? 0) << 8) |
        ((first.coverage[2] ?? 0) << 16) |
        ((first.coverage[3] ?? 0) << 24)) >>>
        0,
    );
    expect(packed.entries).toHaveLength(2);
    expect(packed.entries[1]).toMatchObject({
      requestIndex: 1,
      x: first.width,
      width: second.width,
      height: second.height,
    });
    expect(packed.dispatches).toEqual([
      {
        glyphBase: 0,
        glyphCount: 1,
        workgroupsX: 2,
        workgroupsY: 1,
        invocationCount: 128,
        effectivePixelCount: 96,
      },
      {
        glyphBase: 1,
        glyphCount: 1,
        workgroupsX: 1,
        workgroupsY: 1,
        invocationCount: 64,
        effectivePixelCount: 16,
      },
    ]);
    expect(packed.stats.dispatchInvocationCount).toBe(192);
    expect(packed.stats.effectivePixelCount).toBe(112);
  });

  test("bounds every pixel search to one glyph tile row", () => {
    expect(SPARSE_STRIP_COMPUTE_WGSL).toContain("let row_start = row_offsets[row_base + tile_y]");
    expect(SPARSE_STRIP_COMPUTE_WGSL).toContain(
      "let row_end = row_offsets[row_base + tile_y + 1u]",
    );
    expect(SPARSE_STRIP_COMPUTE_WGSL).toContain(
      "for (var record = row_start; record < row_end; record += 1u)",
    );
    expect(SPARSE_STRIP_COMPUTE_WGSL).toContain("@compute @workgroup_size(8, 8, 1)");
    expect(SPARSE_STRIP_COMPUTE_WGSL).toContain("texture_storage_2d<rgba8unorm, write>");
    expect(SPARSE_STRIP_COMPUTE_WGSL).toContain("dispatch_metadata.glyph_base + invocation.z");
  });

  test("preflights exact u32 metadata and typed-allocation boundaries", () => {
    const maxU32 = 0xffff_ffff;
    const maxRequestCount = Math.floor(maxU32 / SPARSE_STRIP_COMPUTE_LAYOUT.glyphWords);
    expect(
      preflightSparseStripComputePacking({
        requestCount: maxRequestCount,
        rowWordCount: maxU32,
        stripWordCount: maxU32,
        coverageByteLength: maxU32 - 3,
      }),
    ).toMatchObject({
      glyphWordCount: maxRequestCount * SPARSE_STRIP_COMPUTE_LAYOUT.glyphWords,
      rowWordCount: maxU32,
      stripWordCount: maxU32,
      coverageByteLength: maxU32 - 3,
      coverageBufferByteLength: maxU32 - 3,
    });
    expect(() =>
      preflightSparseStripComputePacking({
        requestCount: maxRequestCount + 1,
        rowWordCount: 1,
        stripWordCount: 1,
        coverageByteLength: 0,
      }),
    ).toThrow("glyph word count exceeds u32 storage");
    expect(() =>
      preflightSparseStripComputePacking({
        requestCount: 1,
        rowWordCount: maxU32 + 1,
        stripWordCount: 1,
        coverageByteLength: 0,
      }),
    ).toThrow("row word count must be a u32 integer");
    expect(() =>
      preflightSparseStripComputePacking({
        requestCount: 1,
        rowWordCount: 1,
        stripWordCount: 1,
        coverageByteLength: maxU32 - 2,
      }),
    ).toThrow("coverage buffer byte length exceeds u32 storage");

    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));
    const original = batch([glyph]);
    const boundaryPlacement = {
      ...original.requests[0]!.placement,
      x: maxU32 - glyph.width,
    };
    const packed = packSparseStripComputeBatch({
      width: maxU32,
      height: glyph.height,
      requests: [{ ...original.requests[0]!, placement: boundaryPlacement }],
    });
    expect(packed.glyphs[SPARSE_STRIP_COMPUTE_LAYOUT.metadata.atlasX]).toBe(maxU32 - glyph.width);
    expect(() =>
      packSparseStripComputeBatch({
        width: maxU32,
        height: glyph.height,
        requests: [
          {
            ...original.requests[0]!,
            placement: { ...original.requests[0]!.placement, x: maxU32 + 1 },
          },
        ],
      }),
    ).toThrow("placement x must be a u32 integer");
    expect(() =>
      packSparseStripComputeBatch({
        ...original,
        width: maxU32 + 1,
      }),
    ).toThrow("atlas width must be a u32 integer");
  });

  test("reports capability and rejects storage pressure before shader compilation", async () => {
    expect(inspectSparseStripComputeCapability(undefined)).toEqual({
      status: "unsupported",
      reason: "webgpu-unavailable",
    });
    expect(
      inspectSparseStripComputeCapability({
        limits: { ...supportedLimits(), maxStorageBuffersPerShaderStage: 3 },
      } as unknown as GPUDevice),
    ).toEqual({ status: "unsupported", reason: "device-limits" });

    let shaderModules = 0;
    const device = {
      limits: { ...supportedLimits(), maxStorageBufferBindingSize: 128 },
      createShaderModule: () => {
        shaderModules += 1;
        throw new Error("preflight reached shader compilation");
      },
    } as unknown as GPUDevice;
    const rasterizer = createSparseStripComputeRasterizer(device);
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));

    expect(await rasterizer.rasterize(batch([glyph, glyph]))).toEqual({
      status: "unsupported",
      capability: { status: "unsupported", reason: "device-limits" },
    });
    expect(shaderModules).toBe(0);
    rasterizer.destroy();
  });

  test("surfaces shader compilation failure before allocating GPU resources", async () => {
    let buffers = 0;
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({
        getCompilationInfo: async () => ({
          messages: [{ type: "error", message: "injected sparse shader failure" }],
        }),
      }),
      createBuffer: () => {
        buffers += 1;
        throw new Error("shader failure allocated a buffer");
      },
    } as unknown as GPUDevice;
    const rasterizer = createSparseStripComputeRasterizer(device);
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));

    expect(await rasterizer.rasterize(batch([glyph]))).toEqual({
      status: "failed",
      reason: "shader-compilation",
      message: "injected sparse shader failure",
    });
    expect(buffers).toBe(0);
    rasterizer.destroy();
  });

  test("packs an owned snapshot before deferred pipeline compilation", async () => {
    const compilation = deferred<void>();
    const fixture = fakeDevice({ compilation });
    const rasterizer = createSparseStripComputeRasterizer(fixture.device);
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, (x, y) => (x === 0 && y === 0 ? 128 : 0)));
    const color = [0.25, 0.5, 1, 0.75] as [number, number, number, number];
    const quad = { minX: 0, minY: 0, maxX: 4, maxY: 4, width: 4, height: 4 };
    const placement = {
      x: 0,
      y: 0,
      padding: 0,
      contentWidth: 4,
      contentHeight: 4,
      scale: 1,
      quad,
    };
    const mutableBatch: SparseStripComputeBatch = {
      width: 4,
      height: 4,
      requests: [{ glyph, color, placement }],
    };
    const originalHeaderWidth = glyph.header[3];
    const originalStripTileY = glyph.strips[0];
    const originalCoverage = glyph.coverage[0];
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      const pending = rasterizer.rasterize(mutableBatch);
      glyph.header[3] = 1;
      glyph.strips[0] = 7;
      glyph.coverage[0] = 255;
      color[0] = 1;
      placement.x = 3;
      quad.maxX = 99;
      compilation.resolve(undefined);

      const result = await pending;
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error(`unexpected ${result.status} result`);
      const glyphUpload = requireUpload(fixture.uploads, "sparse strip glyph headers");
      const uploadedGlyphWords = new Uint32Array(
        glyphUpload.bytes.buffer,
        glyphUpload.bytes.byteOffset,
        glyphUpload.bytes.byteLength / Uint32Array.BYTES_PER_ELEMENT,
      );
      expect(uploadedGlyphWords[3]).toBe(originalHeaderWidth);
      expect(uploadedGlyphWords[SPARSE_STRIP_COMPUTE_LAYOUT.metadata.atlasX]).toBe(0);
      expect(uploadedGlyphWords[SPARSE_STRIP_COMPUTE_LAYOUT.metadata.colorR]).toBe(f32Bits(0.25));
      const stripUpload = requireUpload(fixture.uploads, "sparse strip records");
      expect(new Uint32Array(stripUpload.bytes.buffer)[0]).toBe(originalStripTileY);
      const coverageUpload = requireUpload(fixture.uploads, "sparse strip boundary coverage");
      expect(coverageUpload.bytes[0]).toBe(originalCoverage);
      expect(result.atlas.entries[0]).toMatchObject({ x: 0, quad: { maxX: 4 } });
      result.atlas.destroy();
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("keeps 8k overlap validation near N log N and dispatches by exact size", () => {
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));
    const packed4k = packSparseStripComputeBatch(gridBatch(glyph, 4_096, 64));
    const packed8k = packSparseStripComputeBatch(gridBatch(glyph, 8_192, 64));

    expect(packed4k.dispatches).toHaveLength(1);
    expect(packed8k.dispatches).toEqual([
      {
        glyphBase: 0,
        glyphCount: 8_192,
        workgroupsX: 1,
        workgroupsY: 1,
        invocationCount: 8_192 * 64,
        effectivePixelCount: 8_192 * 16,
      },
    ]);
    expect(packed8k.stats.overlapValidationOperations).toBeLessThan(
      packed4k.stats.overlapValidationOperations * 2.7,
    );
    expect(packed8k.stats.dispatchInvocationCount).toBe(8_192 * 64);
    expect(packed8k.stats.effectivePixelCount).toBe(8_192 * 16);
  });

  test("returns an OutlineColorAtlas seam and owns every GPU resource exactly once", async () => {
    const fixture = fakeDevice();
    const rasterizer = createSparseStripComputeRasterizer(fixture.device);
    const glyph = encodeSparseStripGlyph(bitmap(9, 6, (x, y) => (x <= y ? 255 : 0)));
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      const result = await rasterizer.rasterize(batch([glyph]));

      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error(`unexpected ${result.status} result`);
      expect(result.atlas).toMatchObject({
        format: "rgba8unorm",
        width: glyph.width,
        height: glyph.height,
        entries: [{ requestIndex: 0, x: 0, y: 0, width: 9, height: 6 }],
      });
      expect(fixture.dispatches).toEqual([[2, 1, 1]]);
      expect(fixture.bufferDestroys).toEqual([1, 1, 1, 1, 1]);
      expect(fixture.textureDestroys()).toBe(0);
      result.atlas.destroy();
      result.atlas.destroy();
      expect(fixture.textureDestroys()).toBe(1);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("settles queue failure and destroy races with exact-once cleanup", async () => {
    const submitted = deferred<void>();
    const completed = deferred<void>();
    const fixture = fakeDevice({ submitted, completed });
    const rasterizer = createSparseStripComputeRasterizer(fixture.device);
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      const pending = rasterizer.rasterize(batch([glyph]));
      await submitted.promise;
      rasterizer.destroy();
      rasterizer.destroy();
      completed.resolve(undefined);

      expect(await pending).toEqual({
        status: "failed",
        reason: "destroyed",
        message: "sparse strip compute rasterizer has been destroyed",
      });
      expect(fixture.bufferDestroys).toEqual([1, 1, 1, 1, 1]);
      expect(fixture.textureDestroys()).toBe(1);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("keeps queue rejection primary while releasing the batch", async () => {
    const queueError = new Error("injected sparse queue failure");
    const fixture = fakeDevice({ completionError: queueError });
    const rasterizer = createSparseStripComputeRasterizer(fixture.device);
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      expect(await rasterizer.rasterize(batch([glyph]))).toEqual({
        status: "failed",
        reason: "device-error",
        message: queueError.message,
      });
      expect(fixture.bufferDestroys).toEqual([1, 1, 1, 1, 1]);
      expect(fixture.textureDestroys()).toBe(1);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("validates placement geometry and disjoint atlas writes", () => {
    const glyph = encodeSparseStripGlyph(bitmap(4, 4, () => 255));
    const overlapping = batch([glyph, glyph]);
    const requests = overlapping.requests.map((request) => ({
      ...request,
      placement: { ...request.placement, x: 0 },
    }));

    expect(() => packSparseStripComputeBatch({ ...overlapping, requests })).toThrow(
      "placements must be disjoint",
    );
    expect(() =>
      packSparseStripComputeBatch({
        ...overlapping,
        requests: [
          {
            ...overlapping.requests[0]!,
            placement: { ...overlapping.requests[0]!.placement, contentWidth: 3 },
          },
        ],
      }),
    ).toThrow("content and padding must match");
  });
});

function batch(glyphs: readonly Readonly<SparseStripGlyph>[]): Readonly<SparseStripComputeBatch> {
  let x = 0;
  const requests = glyphs.map((glyph) => {
    const placement = Object.freeze({
      x,
      y: 0,
      padding: 0,
      contentWidth: glyph.width,
      contentHeight: glyph.height,
      scale: 1,
      quad: Object.freeze({
        minX: 0,
        minY: 0,
        maxX: glyph.width,
        maxY: glyph.height,
        width: glyph.width,
        height: glyph.height,
      }),
    });
    x += glyph.width;
    return Object.freeze({ glyph, color: [0.25, 0.5, 1, 0.75] as const, placement });
  });
  return Object.freeze({
    width: x,
    height: Math.max(...glyphs.map((glyph) => glyph.height)),
    requests: Object.freeze(requests),
  });
}

function gridBatch(
  glyph: Readonly<SparseStripGlyph>,
  count: number,
  columns: number,
): Readonly<SparseStripComputeBatch> {
  const requests = Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return Object.freeze({
      glyph,
      color: [0.25, 0.5, 1, 0.75] as const,
      placement: Object.freeze({
        x: column * glyph.width,
        y: row * glyph.height,
        padding: 0,
        contentWidth: glyph.width,
        contentHeight: glyph.height,
        scale: 1,
        quad: Object.freeze({
          minX: 0,
          minY: 0,
          maxX: glyph.width,
          maxY: glyph.height,
          width: glyph.width,
          height: glyph.height,
        }),
      }),
    });
  });
  return Object.freeze({
    width: columns * glyph.width,
    height: Math.ceil(count / columns) * glyph.height,
    requests: Object.freeze(requests),
  });
}

function bitmap(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): Readonly<OutlineCpuBitmap> {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = alphaAt(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = alpha;
      pixels[offset + 1] = alpha;
      pixels[offset + 2] = alpha;
      pixels[offset + 3] = alpha;
    }
  }
  return Object.freeze({ width, height, bytesPerRow: width * 4, pixels });
}

function supportedLimits(): GPUDevice["limits"] {
  return {
    maxStorageBuffersPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupsPerDimension: 65_535,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxUniformBufferBindingSize: 64 * 1024,
    maxBufferSize: 256 * 1024 * 1024,
    minUniformBufferOffsetAlignment: 256,
    maxTextureDimension2D: 8_192,
  } as GPUDevice["limits"];
}

interface FakeDeviceOptions {
  readonly compilation?: ReturnType<typeof deferred<void>>;
  readonly submitted?: ReturnType<typeof deferred<void>>;
  readonly completed?: ReturnType<typeof deferred<void>>;
  readonly completionError?: Error;
}

function fakeDevice(options: Readonly<FakeDeviceOptions> = {}): {
  readonly device: GPUDevice;
  readonly bufferDestroys: number[];
  readonly dispatches: number[][];
  readonly uploads: readonly Readonly<{ label: string; bytes: Uint8Array }>[];
  readonly textureDestroys: () => number;
} {
  const bufferDestroys: number[] = [];
  const dispatches: number[][] = [];
  const uploads: Array<Readonly<{ label: string; bytes: Uint8Array }>> = [];
  let textureDestroys = 0;
  const device = {
    limits: supportedLimits(),
    createShaderModule: () => ({
      getCompilationInfo: async () => {
        if (options.compilation !== undefined) await options.compilation.promise;
        return { messages: [] };
      },
    }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    pushErrorScope: () => {},
    popErrorScope: async () => null,
    createBuffer: ({ label, size }: GPUBufferDescriptor) => {
      const index = bufferDestroys.push(0) - 1;
      const mapped = new ArrayBuffer(Number(size));
      return {
        getMappedRange: () => mapped,
        unmap: () => {
          uploads.push(
            Object.freeze({ label: String(label ?? ""), bytes: new Uint8Array(mapped).slice() }),
          );
        },
        destroy: () => {
          bufferDestroys[index] = (bufferDestroys[index] ?? 0) + 1;
        },
      };
    },
    createTexture: () => ({
      createView: () => ({}),
      destroy: () => {
        textureDestroys += 1;
      },
    }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: (x: number, y: number, z: number) => dispatches.push([x, y, z]),
        end: () => {},
      }),
      finish: () => ({}),
    }),
    queue: {
      submit: () => options.submitted?.resolve(undefined),
      onSubmittedWorkDone: () => {
        if (options.completed !== undefined) return options.completed.promise;
        if (options.completionError !== undefined) return Promise.reject(options.completionError);
        return Promise.resolve();
      },
    },
  } as unknown as GPUDevice;
  return {
    device,
    bufferDestroys,
    dispatches,
    uploads,
    textureDestroys: () => textureDestroys,
  };
}

function installWebGpuUsageConstants(): () => void {
  return installWebGpuGlobals({
    GPUBufferUsage: { STORAGE: 1, UNIFORM: 2 },
    GPUTextureUsage: { STORAGE_BINDING: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 },
  });
}

function requireUpload(
  uploads: readonly Readonly<{ label: string; bytes: Uint8Array }>[],
  label: string,
): Readonly<{ label: string; bytes: Uint8Array }> {
  const upload = uploads.find((candidate) => candidate.label === label);
  if (upload === undefined) throw new Error(`missing upload ${label}`);
  return upload;
}

function f32Bits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}
