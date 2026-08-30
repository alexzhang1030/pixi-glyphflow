import { describe, expect, test } from "bun:test";

import {
  prepareOutlineGlyph,
  createOutlineComputeRasterizer,
  inspectOutlineComputeCapability,
  rasterizeOutlineCpu,
  resolveOutlineRoute,
  type OutlineComputeCapability,
} from "../src/render/outline";
import { packedRectangle } from "./fixtures/outlineFixtures";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

describe("outline deep module", () => {
  test("turns one packed HarfBuzz outline into curve, spatial, and quad storage", () => {
    const result = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(`unexpected ${result.status} result`);

    expect(result.glyph.quad).toEqual({
      minX: 0,
      minY: 0,
      maxX: 4,
      maxY: 4,
      width: 4,
      height: 4,
    });
    expect(result.glyph.curveCount).toBe(4);
    expect(Array.from(result.glyph.curveStorage)).toEqual([
      0, 0, 0, 0, 4, 0, 0, 0, 4, 0, 4, 0, 4, 4, 0, 0, 4, 4, 4, 4, 0, 4, 0, 0, 0, 4, 0, 4, 0, 0, 0,
      0,
    ]);
    expect(Array.from(result.glyph.spatialLookup)).toEqual([
      1, 1, 4, 12, 2, 12, 14, 8, 2, 16, 18, 8, 1, 3, 3, 1, 2, 0, 0, 2,
    ]);
  });

  test("consumes the provenance-pinned HarfBuzz 14.4 packed artifact", async () => {
    const artifact = (await Bun.file(
      new URL("../benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json", import.meta.url),
    ).json()) as {
      readonly schemaVersion: number;
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
    };
    const glyph = artifact.corpora
      .find((corpus) => corpus.id === "arabic")
      ?.glyphs.find((candidate) => candidate.glyphId === 4);
    if (glyph === undefined) throw new Error("Arabic glyph 4 is absent from the HB GPU artifact");

    const result = prepareOutlineGlyph({
      extents: glyph.extents,
      packedCurveBlob: decodeHex(glyph.blobHex),
    });

    expect(artifact.schemaVersion).toBe(2);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(`unexpected ${result.status} result`);
    expect(result.glyph.quad).toEqual({
      minX: 72,
      minY: 0,
      maxX: 173,
      maxY: 714,
      width: 101,
      height: 714,
    });
    expect(result.glyph.horizontalBandCount).toBe(4);
    expect(result.glyph.verticalBandCount).toBe(4);
    expect(result.glyph.curveCount).toBe(4);
    expect(result.glyph.spatialLookup.length).toBe(72);
  });

  test("matches the CPU pixel golden for a packed rectangle", () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);

    const bitmap = rasterizeOutlineCpu(prepared.glyph, {
      pixelHeight: 8,
      padding: 1,
      color: [1, 0.5, 0.25, 1],
    });

    expect({ width: bitmap.width, height: bitmap.height, bytesPerRow: bitmap.bytesPerRow }).toEqual(
      {
        width: 10,
        height: 10,
        bytesPerRow: 40,
      },
    );
    expect(alphaMask(bitmap.pixels, bitmap.width, bitmap.height)).toEqual([
      "..........",
      ".########.",
      ".########.",
      ".########.",
      ".########.",
      ".########.",
      ".########.",
      ".########.",
      ".########.",
      "..........",
    ]);
    expect(Array.from(bitmap.pixels.slice(44, 48))).toEqual([255, 128, 64, 255]);
  });

  test("applies projected-size routing only to the opt-in outline mode", () => {
    const capability: OutlineComputeCapability = {
      status: "supported",
      maxTextureDimension2D: 8_192,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65_535,
    };

    expect(
      resolveOutlineRoute({
        mode: "auto",
        projectedHeightPx: 2_048,
        projectedSizeThresholdPx: 128,
        capability,
      }),
    ).toEqual({ path: "atlas", reason: "outline-disabled" });
    expect(
      resolveOutlineRoute({
        mode: "outline",
        projectedHeightPx: 127,
        projectedSizeThresholdPx: 128,
        capability,
      }),
    ).toEqual({ path: "atlas", reason: "below-projected-threshold" });
    expect(
      resolveOutlineRoute({
        mode: "outline",
        projectedHeightPx: 128,
        projectedSizeThresholdPx: 128,
        capability,
      }),
    ).toEqual({ path: "outline" });
    expect(
      resolveOutlineRoute({
        mode: "outline",
        projectedHeightPx: 256,
        projectedSizeThresholdPx: 128,
        capability: { status: "unsupported", reason: "webgpu-unavailable" },
      }),
    ).toEqual({ path: "atlas", reason: "capability-unavailable" });
  });

  test("reports WebGPU capability and keeps the unavailable path explicit", async () => {
    expect(inspectOutlineComputeCapability(undefined)).toEqual({
      status: "unsupported",
      reason: "webgpu-unavailable",
    });
    const rasterizer = createOutlineComputeRasterizer(undefined);
    expect(rasterizer.capability).toEqual({
      status: "unsupported",
      reason: "webgpu-unavailable",
    });
    expect(await rasterizer.rasterize([])).toEqual({
      status: "unsupported",
      capability: { status: "unsupported", reason: "webgpu-unavailable" },
    });
    rasterizer.destroy();
    rasterizer.destroy();
  });

  test("preflights aggregate storage before compiling the compute pipeline", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    let shaderModules = 0;
    const device = {
      limits: {
        maxStorageBuffersPerShaderStage: 8,
        maxComputeInvocationsPerWorkgroup: 256,
        maxComputeWorkgroupSizeX: 256,
        maxComputeWorkgroupSizeY: 256,
        maxComputeWorkgroupsPerDimension: 65_535,
        maxStorageBufferBindingSize: 96,
        maxTextureDimension2D: 8_192,
      },
      createShaderModule: () => {
        shaderModules += 1;
        throw new Error("storage preflight reached shader compilation");
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);

    expect(
      await rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]),
    ).toEqual({
      status: "unsupported",
      capability: { status: "unsupported", reason: "device-limits" },
    });
    expect(shaderModules).toBe(0);
    rasterizer.destroy();
  });

  test("returns destroyed when disposal wins during pipeline compilation", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    const compilation = deferred<GPUCompilationInfo>();
    let textureCreations = 0;
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({ getCompilationInfo: () => compilation.promise }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      createTexture: () => {
        textureCreations += 1;
        throw new Error("destroyed rasterization allocated a texture");
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const pending = rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]);

    rasterizer.destroy();
    compilation.resolve({ messages: [] } as unknown as GPUCompilationInfo);

    expect(await pending).toEqual({
      status: "failed",
      reason: "destroyed",
      message: "outline compute rasterizer has been destroyed",
    });
    expect(textureCreations).toBe(0);
  });

  test("destroys submitted resources once when disposal wins during queue completion", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    const submitted = deferred<void>();
    const completed = deferred<void>();
    let textureDestroys = 0;
    const bufferDestroys: number[] = [];
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({
        getCompilationInfo: async () => ({ messages: [] }),
      }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope: () => {},
      popErrorScope: async () => null,
      createBuffer: ({ size }: GPUBufferDescriptor) => {
        const index = bufferDestroys.push(0) - 1;
        const mapped = new ArrayBuffer(Number(size));
        return {
          getMappedRange: () => mapped,
          unmap: () => {},
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
          dispatchWorkgroups: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        submit: () => submitted.resolve(undefined),
        onSubmittedWorkDone: () => completed.promise,
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      const pending = rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]);

      await submitted.promise;
      rasterizer.destroy();
      rasterizer.destroy();
      completed.resolve(undefined);

      expect(await pending).toEqual({
        status: "failed",
        reason: "destroyed",
        message: "outline compute rasterizer has been destroyed",
      });
      expect(textureDestroys).toBe(1);
      expect(bufferDestroys).toEqual([1, 1, 1]);
    } finally {
      restoreUsageConstants();
    }
  });

  test("preserves validation failure when texture cleanup faults", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    const validationError = new Error("injected outline validation failure");
    const textureCleanupError = new Error("injected outline texture cleanup failure");
    let textureDestroys = 0;
    const bufferDestroys: number[] = [];
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope: () => {},
      popErrorScope: async () => validationError,
      createBuffer: ({ size }: GPUBufferDescriptor) => {
        const index = bufferDestroys.push(0) - 1;
        const mapped = new ArrayBuffer(Number(size));
        return {
          getMappedRange: () => mapped,
          unmap: () => {},
          destroy: () => {
            bufferDestroys[index] = (bufferDestroys[index] ?? 0) + 1;
          },
        };
      },
      createTexture: () => ({
        createView: () => ({}),
        destroy: () => {
          textureDestroys += 1;
          throw textureCleanupError;
        },
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          dispatchWorkgroups: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        submit: () => {},
        onSubmittedWorkDone: async () => {},
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      expect(
        await rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]),
      ).toEqual({
        status: "failed",
        reason: "device-error",
        message: validationError.message,
      });
      expect(textureDestroys).toBe(1);
      expect(bufferDestroys).toEqual([1, 1, 1]);

      rasterizer.destroy();
      expect(textureDestroys).toBe(1);
      expect(bufferDestroys).toEqual([1, 1, 1]);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("preserves a device failure while every buffer cleanup runs once", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    const primaryError = new Error("injected outline bind group failure");
    const bufferDestroys: number[] = [];
    let textureDestroys = 0;
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope: () => {},
      popErrorScope: async () => null,
      createBuffer: ({ size }: GPUBufferDescriptor) => {
        const index = bufferDestroys.push(0) - 1;
        const mapped = new ArrayBuffer(Number(size));
        return {
          getMappedRange: () => mapped,
          unmap: () => {},
          destroy: () => {
            bufferDestroys[index] = (bufferDestroys[index] ?? 0) + 1;
            if (index < 2) throw new Error(`injected buffer ${String(index + 1)} cleanup failure`);
          },
        };
      },
      createTexture: () => ({
        createView: () => ({}),
        destroy: () => {
          textureDestroys += 1;
        },
      }),
      createBindGroup: () => {
        throw primaryError;
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      expect(
        await rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]),
      ).toEqual({
        status: "failed",
        reason: "device-error",
        message: primaryError.message,
      });
      expect(textureDestroys).toBe(1);
      expect(bufferDestroys).toEqual([1, 1, 1]);

      rasterizer.destroy();
      expect(textureDestroys).toBe(1);
      expect(bufferDestroys).toEqual([1, 1, 1]);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("closes each validation scope before overlapping queue completions", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    const bothSubmitted = deferred<void>();
    const completions = [deferred<void>(), deferred<void>()];
    let submitCount = 0;
    let completionIndex = 0;
    let scopeDepth = 0;
    const poppedDepths: number[] = [];
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope: () => {
        scopeDepth += 1;
      },
      popErrorScope: async () => {
        poppedDepths.push(scopeDepth);
        scopeDepth -= 1;
        return null;
      },
      createBuffer: ({ size }: GPUBufferDescriptor) => {
        const mapped = new ArrayBuffer(Number(size));
        return {
          getMappedRange: () => mapped,
          unmap: () => {},
          destroy: () => {},
        };
      },
      createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          dispatchWorkgroups: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        submit: () => {
          submitCount += 1;
          if (submitCount === 2) bothSubmitted.resolve(undefined);
        },
        onSubmittedWorkDone: () => {
          const completion = completions[completionIndex];
          completionIndex += 1;
          if (completion === undefined) throw new Error("missing queue completion");
          return completion.promise;
        },
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      const first = rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]);
      const second = rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]);

      await bothSubmitted.promise;
      expect(scopeDepth).toBe(0);
      expect(poppedDepths).toEqual([1, 1]);

      completions[0]?.resolve(undefined);
      completions[1]?.resolve(undefined);
      expect((await first).status).toBe("ready");
      expect((await second).status).toBe("ready");
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("destroys the first upload once when the second upload fails", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    let bufferCreates = 0;
    let firstBufferDestroys = 0;
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope: () => {},
      popErrorScope: async () => null,
      createBuffer: ({ size }: GPUBufferDescriptor) => {
        bufferCreates += 1;
        if (bufferCreates === 2) throw new Error("second upload failed");
        const mapped = new ArrayBuffer(Number(size));
        return {
          getMappedRange: () => mapped,
          unmap: () => {},
          destroy: () => {
            firstBufferDestroys += 1;
          },
        };
      },
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      expect(
        await rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]),
      ).toMatchObject({
        status: "failed",
        reason: "device-error",
        message: "second upload failed",
      });
      expect(bufferCreates).toBe(2);
      expect(firstBufferDestroys).toBe(1);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("destroys a newly created upload once when mapped copy fails", async () => {
    const prepared = prepareOutlineGlyph({
      extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
      packedCurveBlob: packedRectangle(),
    });
    if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
    let bufferDestroys = 0;
    const device = {
      limits: supportedLimits(),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope: () => {},
      popErrorScope: async () => null,
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(0),
        unmap: () => {},
        destroy: () => {
          bufferDestroys += 1;
        },
      }),
    } as unknown as GPUDevice;
    const rasterizer = createOutlineComputeRasterizer(device);
    const restoreUsageConstants = installWebGpuUsageConstants();
    try {
      expect(
        await rasterizer.rasterize([{ glyph: prepared.glyph, pixelHeight: 8, padding: 1 }]),
      ).toMatchObject({ status: "failed", reason: "device-error" });
      expect(bufferDestroys).toBe(1);
    } finally {
      rasterizer.destroy();
      restoreUsageConstants();
    }
  });

  test("prepares every glyph in the five-corpus packed artifact", async () => {
    const artifact = (await Bun.file(
      new URL("../benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json", import.meta.url),
    ).json()) as {
      readonly corpora: readonly {
        readonly glyphs: readonly {
          readonly blobHex: string;
          readonly extents: {
            readonly xBearing: number;
            readonly yBearing: number;
            readonly width: number;
            readonly height: number;
          };
        }[];
      }[];
    };
    let ready = 0;
    let empty = 0;
    for (const corpus of artifact.corpora) {
      for (const glyph of corpus.glyphs) {
        const result = prepareOutlineGlyph({
          extents: glyph.extents,
          packedCurveBlob: decodeHex(glyph.blobHex),
        });
        if (result.status === "ready") ready += 1;
        else empty += 1;
      }
    }

    expect({ ready, empty }).toEqual({ ready: 109, empty: 5 });
  });

  test("reports packed outlines that exceed caller resource limits", () => {
    expect(
      prepareOutlineGlyph(
        {
          extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
          packedCurveBlob: packedRectangle(),
        },
        { maxCurveReferences: 7 },
      ),
    ).toEqual({
      status: "unsupported",
      reason: "resource-limits",
      limit: "curve-references",
    });
  });

  test("preserves the successful HarfBuzz no-ink state", () => {
    expect(
      prepareOutlineGlyph({
        extents: { xBearing: 0, yBearing: 0, width: 0, height: 0 },
        packedCurveBlob: new Uint8Array(),
      }),
    ).toEqual({
      status: "empty",
      quad: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
    });
  });

  test("rejects a packed spatial list that aliases the blob header", () => {
    const blob = packedRectangle();
    new DataView(blob.buffer).setInt16(2 * 8 + 2, -32_768, true);

    expect(() =>
      prepareOutlineGlyph({
        extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
        packedCurveBlob: blob,
      }),
    ).toThrow("curve list is outside the blob");
  });
});

function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError("hex must contain whole bytes");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function alphaMask(pixels: Uint8Array, width: number, height: number): readonly string[] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      pixels[(y * width + x) * 4 + 3] === 0 ? "." : "#",
    ).join(""),
  );
}

function supportedLimits() {
  return {
    maxStorageBuffersPerShaderStage: 8,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupsPerDimension: 65_535,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxTextureDimension2D: 8_192,
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function installWebGpuUsageConstants(): () => void {
  return installWebGpuGlobals({
    GPUBufferUsage: { STORAGE: 1 },
    GPUTextureUsage: { STORAGE_BINDING: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 },
  });
}
