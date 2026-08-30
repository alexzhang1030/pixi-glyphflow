import { describe, expect, test } from "bun:test";

import { TRANSFORM_PALETTE_STRIDE } from "../src/advanced";
import { packCullRecords } from "../src/culling/computeCull";
import { computeCullDeviceLimits } from "../src/culling/requestComputeCullGpu";
import {
  PALETTE_DENSE_PATCH_WGSL,
  PALETTE_PATCH_WGSL,
  PALETTE_TRANSFORM_SCATTER_WGSL,
} from "../src/render/palettePatch.wgsl";
import {
  applyPaletteMoves,
  applyResidentPaletteMoves,
  applyPaletteTransforms,
  PALETTE_DENSE_MOVE_STRIDE,
  PALETTE_DENSE_MOVE_WORDS,
  PALETTE_INDEXED_MOVE_STRIDE,
  PALETTE_MOVE_STRIDE,
  PALETTE_MOVE_UNIFORM_BYTES,
  PALETTE_MOVE_WORDS,
  PALETTE_ORIGIN_FLOATS,
  PALETTE_TRANSFORM_COMMAND_STRIDE,
  PALETTE_TRANSFORM_SCATTER_MAX_LABELS,
  packPaletteTransforms,
  packPaletteMoves,
  paletteMoveDispatchBytes,
  paletteMoveUploadBytes,
  paletteTransformDispatchBytes,
  planPaletteTransformUpload,
  refreshPaletteOrigins,
  readyPalettePath,
  residentLocalBoundsBytes,
  resolvePalettePath,
  shouldWriteCpuPalettePositions,
} from "../src/render/paletteStorage";
import { PaletteStoragePass } from "../src/render/PaletteStoragePass";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

const WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

describe("palette storage path", () => {
  test("keeps WebGL and devices without vertex storage on the texture palette", () => {
    expect(
      resolvePalettePath({
        adapter: "webgl",
        maxStorageBuffersInVertexStage: 8,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 32,
      }),
    ).toBe("texture");
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 0,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 32,
      }),
    ).toBe("texture");
    expect(
      resolvePalettePath({
        adapter: "unknown",
        maxStorageBuffersInVertexStage: 8,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 32,
      }),
    ).toBe("texture");
    expect(shouldWriteCpuPalettePositions("texture")).toBe(true);
    expect(shouldWriteCpuPalettePositions("storage")).toBe(false);
    expect(readyPalettePath("storage", true)).toBe("storage");
    expect(readyPalettePath("storage", false)).toBe("texture");
    expect(readyPalettePath("texture", true)).toBe("texture");
    expect(readyPalettePath("texture", false)).toBe("texture");
  });

  test("selects a storage palette when the vertex stage can bind the table", () => {
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 1_000_000 * TRANSFORM_PALETTE_STRIDE,
      }),
    ).toBe("storage");
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: 1024,
        paletteBytes: 2048,
      }),
    ).toBe("texture");
    expect(
      resolvePalettePath({
        adapter: "webgpu",
        maxStorageBuffersInVertexStage: 1,
        maxStorageBufferBindingSize: WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
        paletteBytes: 0,
      }),
    ).toBe("texture");
  });

  test("requests vertex storage only when the adapter exposes it", () => {
    expect(
      computeCullDeviceLimits({
        limits: {
          maxStorageBufferBindingSize: 256,
          maxBufferSize: 512,
        },
      }),
    ).toEqual({
      maxStorageBufferBindingSize: 256,
      maxBufferSize: 512,
    });
    expect(
      computeCullDeviceLimits({
        limits: {
          maxStorageBufferBindingSize: 256,
          maxBufferSize: 512,
          maxStorageBuffersInVertexStage: 8,
        },
      }),
    ).toEqual({
      maxStorageBufferBindingSize: 256,
      maxBufferSize: 512,
      maxStorageBuffersInVertexStage: 8,
    });
  });

  test("patches only x/y in a 32-byte fill record from packed commands", () => {
    const data = new Float32Array(PALETTE_ORIGIN_FLOATS * 2);
    data.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const commands = new ArrayBuffer(PALETTE_MOVE_STRIDE);
    const originX = new Float32Array([0, 40]);
    const originY = new Float32Array([0, 50]);
    expect(packPaletteMoves(commands, 0, new Uint32Array([1]), 1, originX, originY)).toBe(1);

    expect(applyPaletteMoves(data, { mode: "indexed", commands, count: 1 })).toBe(1);
    expect(Array.from(data.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(data.subarray(8, 16))).toEqual([40, 50, 11, 12, 13, 14, 15, 16]);
    expect(applyPaletteMoves(data, { mode: "indexed", commands, count: 1 })).toBe(0);
  });

  test("accounts dense 8-byte and indexed 12-byte mover uploads exactly", () => {
    const denseCount = 100_000;
    const denseBytes = paletteMoveUploadBytes("dense", denseCount);
    expect(PALETTE_DENSE_MOVE_STRIDE).toBe(8);
    expect(PALETTE_DENSE_MOVE_WORDS).toBe(2);
    expect(denseBytes).toBe(800_000);
    expect(paletteMoveDispatchBytes("dense", 10_000)).toBe(80_016);
    expect(paletteMoveDispatchBytes("dense", denseCount)).toBe(800_016);
    expect(paletteMoveDispatchBytes("dense", 0)).toBe(0);

    const indexedBytes = paletteMoveUploadBytes("indexed", denseCount);
    expect(PALETTE_INDEXED_MOVE_STRIDE).toBe(12);
    expect(PALETTE_MOVE_STRIDE).toBe(12);
    expect(PALETTE_MOVE_WORDS).toBe(3);
    expect(indexedBytes).toBe(denseCount * PALETTE_MOVE_STRIDE);
    expect(paletteMoveDispatchBytes("indexed", denseCount)).toBe(1_200_016);
    expect(denseBytes).toBeLessThan(denseCount * TRANSFORM_PALETTE_STRIDE);
    expect(paletteMoveDispatchBytes("dense", denseCount)).toBe(
      denseBytes + PALETTE_MOVE_UNIFORM_BYTES,
    );

    const originColumnSpanBytes = 1_000_000 * Float32Array.BYTES_PER_ELEMENT * 2;
    const sparseCount = 2;
    const sparseBytes = paletteMoveUploadBytes("indexed", sparseCount);
    expect(sparseBytes).toBe(sparseCount * PALETTE_MOVE_STRIDE);
    expect(sparseBytes).toBeLessThan(originColumnSpanBytes);
    expect(paletteMoveDispatchBytes("indexed", sparseCount)).toBeLessThan(originColumnSpanBytes);

    const originX = new Float32Array(1_000_000);
    const originY = new Float32Array(1_000_000);
    originX[0] = 11;
    originY[0] = 12;
    originX[999_999] = 21;
    originY[999_999] = 22;
    const commands = new ArrayBuffer(sparseCount * PALETTE_MOVE_STRIDE);
    expect(
      packPaletteMoves(commands, 0, new Uint32Array([0, 999_999]), sparseCount, originX, originY),
    ).toBe(2);
    const uints = new Uint32Array(commands);
    const floats = new Float32Array(commands);
    expect(uints[0]).toBe(0);
    expect(floats[1]).toBe(11);
    expect(floats[2]).toBe(12);
    expect(uints[3]).toBe(999_999);
    expect(floats[4]).toBe(21);
    expect(floats[5]).toBe(22);
    expect(commands.byteLength).toBe(sparseBytes);
    expect(commands.byteLength).not.toBe(originColumnSpanBytes);
  });

  test("patches dense contiguous transforms from baseSlot plus exact-f32 pairs", () => {
    const data = new Float32Array(PALETTE_ORIGIN_FLOATS * 5).fill(-1);
    const commands = new Float32Array([
      Math.fround(Math.PI),
      Math.fround(-Math.E),
      Math.fround(1 / 3),
      Math.fround(-1 / 7),
    ]);
    const move = { mode: "dense", baseSlot: 2, commands: commands.buffer, count: 2 } as const;

    expect(applyPaletteMoves(data, move)).toBe(2);
    expect(
      Array.from(data.subarray(PALETTE_ORIGIN_FLOATS * 2, PALETTE_ORIGIN_FLOATS * 2 + 2)),
    ).toEqual(Array.from(commands.subarray(0, 2)));
    expect(
      Array.from(data.subarray(PALETTE_ORIGIN_FLOATS * 3, PALETTE_ORIGIN_FLOATS * 3 + 2)),
    ).toEqual(Array.from(commands.subarray(2, 4)));
    expect(data[PALETTE_ORIGIN_FLOATS]).toBe(-1);
  });

  test("rewrites absolute resident AABBs from indexed local bounds", () => {
    const transforms = new Float32Array(PALETTE_ORIGIN_FLOATS * 2);
    const records = packCullRecords([
      {
        minX: -2,
        minY: -3,
        maxX: 6,
        maxY: 6,
        instanceOffset: 0,
        instanceCount: 1,
        paletteIndex: 0,
        localBoundsIndex: 0,
      },
      {
        minX: 10,
        minY: 20,
        maxX: 14,
        maxY: 25,
        instanceOffset: 0,
        instanceCount: 0,
        paletteIndex: 1,
        localBoundsIndex: 1,
      },
    ]);
    const localBounds = new Float32Array([-2, -3, 8, 9, 10, 20, 4, 5]);
    expect(residentLocalBoundsBytes(2)).toBe(32);
    const commands = new ArrayBuffer(PALETTE_MOVE_STRIDE * 2);
    const commandWords = new Uint32Array(commands);
    const commandFloats = new Float32Array(commands);
    commandWords[0] = 0;
    commandFloats[1] = 100;
    commandFloats[2] = 200;
    commandWords[3] = 1;
    commandFloats[4] = -30;
    commandFloats[5] = 40;

    expect(
      applyResidentPaletteMoves({
        mode: "indexed",
        transforms,
        records,
        recordCount: 2,
        localBounds,
        localBoundsCount: 2,
        commands,
        count: 2,
      }),
    ).toEqual({ transformsPatched: 2, recordsPatched: 2, cullRecordUploadBytes: 0 });
    expect(Array.from(transforms.subarray(0, 2))).toEqual([100, 200]);
    expect(
      Array.from(transforms.subarray(PALETTE_ORIGIN_FLOATS, PALETTE_ORIGIN_FLOATS + 2)),
    ).toEqual([-30, 40]);
    const recordFloats = new Float32Array(records);
    const recordWords = new Uint32Array(records);
    expect(Array.from(recordFloats.subarray(0, 4))).toEqual([98, 197, 106, 206]);
    expect(Array.from(recordFloats.subarray(8, 12))).toEqual([-20, 60, -16, 65]);
    expect(recordWords[5]).toBe(1);
    expect(recordWords[13]).toBe(0);
  });

  test("rewrites dense resident AABBs at baseSlot with exact f32 bounds arithmetic", () => {
    const transforms = new Float32Array(PALETTE_ORIGIN_FLOATS * 3);
    const records = packCullRecords([
      {
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        instanceOffset: 0,
        instanceCount: 0,
        localBoundsIndex: 0,
      },
      {
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        instanceOffset: 0,
        instanceCount: 1,
        localBoundsIndex: 0,
      },
      {
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        instanceOffset: 0,
        instanceCount: 1,
        localBoundsIndex: 1,
      },
    ]);
    const localBounds = new Float32Array([0.25, -0.5, 8, 9, -2, 3, 4, 5]);
    const commands = new Float32Array([
      Math.fround(16_777_000.25),
      Math.fround(-8_388_000.5),
      Math.fround(-1 / 7),
      Math.fround(1 / 3),
    ]);

    expect(
      applyResidentPaletteMoves({
        mode: "dense",
        baseSlot: 1,
        transforms,
        records,
        recordCount: 3,
        localBounds,
        localBoundsCount: 2,
        commands: commands.buffer,
        count: 2,
      }),
    ).toEqual({ transformsPatched: 2, recordsPatched: 2, cullRecordUploadBytes: 0 });
    const recordFloats = new Float32Array(records);
    expect(Array.from(recordFloats.subarray(8, 12))).toEqual([
      Math.fround(commands[0]! + 0.25),
      Math.fround(commands[1]! - 0.5),
      Math.fround(Math.fround(commands[0]! + 0.25) + 8),
      Math.fround(Math.fround(commands[1]! - 0.5) + 9),
    ]);
    expect(Array.from(recordFloats.subarray(16, 20))).toEqual([
      Math.fround(commands[2]! - 2),
      Math.fround(commands[3]! + 3),
      Math.fround(Math.fround(commands[2]! - 2) + 4),
      Math.fround(Math.fround(commands[3]! + 3) + 5),
    ]);
  });

  test("matches the two-step f32 max edge bit-for-bit and preserves a tombstone", () => {
    const transforms = new Float32Array(PALETTE_ORIGIN_FLOATS);
    const records = packCullRecords([
      {
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
        instanceOffset: 0,
        instanceCount: 0,
        localBoundsIndex: 0,
      },
    ]);

    expect(
      applyResidentPaletteMoves({
        mode: "dense",
        baseSlot: 0,
        transforms,
        records,
        recordCount: 1,
        localBounds: new Float32Array([2.25, 0, 9, 1]),
        localBoundsCount: 1,
        commands: new Float32Array([16_777_206, 0]).buffer,
        count: 1,
      }),
    ).toEqual({ transformsPatched: 1, recordsPatched: 1, cullRecordUploadBytes: 0 });

    const recordFloats = new Float32Array(records);
    const recordWords = new Uint32Array(records);
    expect(Array.from(recordFloats.subarray(0, 4))).toEqual([16_777_208, 0, 16_777_216, 1]);
    expect(recordWords[0]).toBe(0x4b7ffff8);
    expect(recordWords[2]).toBe(0x4b800000);
    expect(recordWords[5]).toBe(0);
  });

  test("keeps repeated oscillation and large-coordinate moves drift-free", () => {
    const transforms = new Float32Array(PALETTE_ORIGIN_FLOATS);
    const records = packCullRecords([
      {
        minX: 0.25,
        minY: -0.5,
        maxX: 8.25,
        maxY: 8.5,
        instanceOffset: 0,
        instanceCount: 1,
        localBoundsIndex: 0,
      },
    ]);
    const localBounds = new Float32Array([0.25, -0.5, 8, 9]);
    const commands = new ArrayBuffer(PALETTE_MOVE_STRIDE);
    const commandFloats = new Float32Array(commands);
    for (let index = 0; index < 10_000; index += 1) {
      commandFloats[1] = index % 2 === 0 ? 16_777_000 : -16_777_000;
      commandFloats[2] = index % 2 === 0 ? -8_388_000 : 8_388_000;
      applyResidentPaletteMoves({
        mode: "indexed",
        transforms,
        records,
        recordCount: 1,
        localBounds,
        localBoundsCount: 1,
        commands,
        count: 1,
      });
    }
    const recordFloats = new Float32Array(records);
    expect(Array.from(recordFloats.subarray(0, 4))).toEqual([
      Math.fround(-16_777_000 + 0.25),
      Math.fround(8_388_000 - 0.5),
      Math.fround(-16_777_000 + 8.25),
      Math.fround(8_388_000 + 8.5),
    ]);
  });

  test("packs lane and content movers into one command buffer", () => {
    const originX = new Float32Array([1, 2, 3]);
    const originY = new Float32Array([4, 5, 6]);
    const commands = new ArrayBuffer(3 * PALETTE_MOVE_STRIDE);
    const lane = packPaletteMoves(commands, 0, new Uint32Array([0, 2]), 2, originX, originY);
    const content = packPaletteMoves(commands, lane, new Uint32Array([1]), 1, originX, originY);
    expect(lane).toBe(2);
    expect(content).toBe(1);
    const uints = new Uint32Array(commands);
    const floats = new Float32Array(commands);
    expect(uints[0]).toBe(0);
    expect(floats[1]).toBe(1);
    expect(uints[3]).toBe(2);
    expect(floats[4]).toBe(3);
    expect(uints[6]).toBe(1);
    expect(floats[7]).toBe(2);
    expect(() =>
      packPaletteMoves(
        new ArrayBuffer(PALETTE_MOVE_STRIDE),
        0,
        new Uint32Array([0, 1]),
        2,
        originX,
        originY,
      ),
    ).toThrow(RangeError);
  });

  test("scatters out-of-order active core, alpha, and effect texels", () => {
    const capacity = 3;
    const effectBase = capacity * 2;
    const data = new Float32Array(capacity * PALETTE_ORIGIN_FLOATS + capacity * 4);
    for (let index = 0; index < data.length; index += 1) data[index] = index + 0.25;
    const commands = new ArrayBuffer(2 * PALETTE_TRANSFORM_COMMAND_STRIDE);

    expect(packPaletteTransforms(commands, data, new Uint32Array([2, 0]), 2, effectBase)).toBe(2);
    const destination = new Float32Array(data.length).fill(-1);
    expect(applyPaletteTransforms(destination, commands, 2, effectBase)).toBe(2);

    expect(Array.from(destination.subarray(0, PALETTE_ORIGIN_FLOATS))).toEqual(
      Array.from(data.subarray(0, PALETTE_ORIGIN_FLOATS)),
    );
    expect(
      Array.from(destination.subarray(PALETTE_ORIGIN_FLOATS, PALETTE_ORIGIN_FLOATS * 2)),
    ).toEqual(Array.from(new Float32Array(PALETTE_ORIGIN_FLOATS).fill(-1)));
    expect(
      Array.from(destination.subarray(PALETTE_ORIGIN_FLOATS * 2, PALETTE_ORIGIN_FLOATS * 3)),
    ).toEqual(Array.from(data.subarray(PALETTE_ORIGIN_FLOATS * 2, PALETTE_ORIGIN_FLOATS * 3)));
    expect(Array.from(destination.subarray(effectBase * 4, effectBase * 4 + 4))).toEqual(
      Array.from(data.subarray(effectBase * 4, effectBase * 4 + 4)),
    );
    expect(Array.from(destination.subarray(effectBase * 4 + 4, effectBase * 4 + 8))).toEqual([
      -1, -1, -1, -1,
    ]);
    expect(Array.from(destination.subarray(effectBase * 4 + 8, effectBase * 4 + 12))).toEqual(
      Array.from(data.subarray(effectBase * 4 + 8, effectBase * 4 + 12)),
    );
  });

  test("reactivates an omitted slot with live origin, alpha, and effect values", () => {
    const capacity = 3;
    const effectBase = capacity * 2;
    const data = new Float32Array(capacity * PALETTE_ORIGIN_FLOATS + capacity * 4);
    const slot = 1;
    const coreBase = slot * PALETTE_ORIGIN_FLOATS;
    const effectOffset = effectBase * 4 + slot * 4;
    data.set([10, 20, 1, 0, 0, 1, 0, 0.85], coreBase);
    data.set([0.25, 0.5, 0.75, 1], effectOffset);
    const originsX = new Float32Array([0, 120, 0]);
    const originsY = new Float32Array([0, 240, 0]);
    const commands = new ArrayBuffer(PALETTE_TRANSFORM_COMMAND_STRIDE);

    expect(
      packPaletteTransforms(
        commands,
        data,
        new Uint32Array([slot]),
        1,
        effectBase,
        originsX,
        originsY,
      ),
    ).toBe(1);
    const destination = new Float32Array(data.length).fill(-1);
    expect(applyPaletteTransforms(destination, commands, 1, effectBase)).toBe(1);

    const expectedCore = Array.from(data.subarray(coreBase, coreBase + PALETTE_ORIGIN_FLOATS));
    expectedCore[0] = 120;
    expectedCore[1] = 240;
    expect(Array.from(destination.subarray(coreBase, coreBase + PALETTE_ORIGIN_FLOATS))).toEqual(
      expectedCore,
    );
    expect(Array.from(destination.subarray(effectOffset, effectOffset + 4))).toEqual([
      0.25, 0.5, 0.75, 1,
    ]);
    expect(Array.from(destination.subarray(0, PALETTE_ORIGIN_FLOATS))).toEqual(
      Array.from(new Float32Array(PALETTE_ORIGIN_FLOATS).fill(-1)),
    );
  });

  test("chooses active scatter only when it beats dirty-range upload cost", () => {
    expect(paletteTransformDispatchBytes(512)).toBe(32_784);
    expect(planPaletteTransformUpload([{ offset: 0, length: 16_810_240 }], 512)).toMatchObject({
      mode: "scatter",
      dirtyBytes: 16_810_240,
      scatterUploadBytes: 32_784,
    });
    expect(planPaletteTransformUpload([{ offset: 32, length: 32 }], 1).mode).toBe("ranges");
    expect(planPaletteTransformUpload([{ offset: 0, length: 20_000_000 }], 32_768)).toMatchObject({
      mode: "scatter",
      scatterUploadBytes: 2_097_168,
    });
    expect(
      planPaletteTransformUpload(
        [{ offset: 0, length: 32_000_000 }],
        PALETTE_TRANSFORM_SCATTER_MAX_LABELS + 1,
      ).mode,
    ).toBe("ranges");
  });

  test("rebinds grown storage before dispatching one packed active-transform upload", () => {
    const writes: Array<{ label: string; bytes: number }> = [];
    const entries: string[] = [];
    const bindEntryCounts: number[] = [];
    const submits: unknown[] = [];
    const uniformHeaders: number[][] = [];
    const gpuTransforms = { label: "gpu-transforms", size: 1_024, usage: 0x0080 };
    const device = {
      limits: { maxStorageBufferBindingSize: 1_048_576, maxBufferSize: 1_048_576 },
      createShaderModule: ({ label }: { label: string }) => ({ label }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => {
        entries.push(compute.entryPoint);
        return { entryPoint: compute.entryPoint };
      },
      createBuffer: ({ label, size, usage }: { label: string; size: number; usage: number }) => ({
        label,
        size,
        usage,
        destroy() {},
      }),
      createBindGroup: ({ entries: bindings }: { entries: readonly unknown[] }) => {
        bindEntryCounts.push(bindings.length);
        return {};
      },
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setBindGroup() {},
          setPipeline() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        finish: () => ({ label: "scatter-command" }),
      }),
      queue: {
        writeBuffer: (
          buffer: { label: string },
          _offset: number,
          source: AllowSharedBufferSource,
          _sourceOffset?: number,
          size?: number,
        ) => {
          writes.push({ label: buffer.label, bytes: size ?? 0 });
          if (buffer.label === "pixi-glyphflow-palette-move-uniforms") {
            const bytes = ArrayBuffer.isView(source)
              ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
              : new Uint8Array(source);
            uniformHeaders.push(Array.from(new Uint32Array(bytes.slice().buffer)));
          }
        },
        submit: (commands: unknown) => submits.push(commands),
      },
    };
    const renderer = {
      gpu: { device },
      buffer: {
        updateBuffer() {},
        getGPUBuffer: () => gpuTransforms,
      },
    } as never;
    const restoreGpuGlobals = installWebGpuGlobals({
      GPUShaderStage: { COMPUTE: 4 },
      GPUBufferUsage: { STORAGE: 0x0080, COPY_DST: 0x0008 },
    });
    try {
      const pass = new PaletteStoragePass(renderer);
      const rebound: unknown[] = [];
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64, (buffer) => rebound.push(buffer))).toEqual({
        ok: true,
        replaced: true,
      });
      expect(pass.ensureTransforms(256, (buffer) => rebound.push(buffer))).toEqual({
        ok: true,
        replaced: true,
      });
      const data = new Float32Array(64);
      data[7] = 0.75;
      expect(pass.dispatchTransforms(data, new Uint32Array([3, 0]), 2, 0)).toBe(
        paletteTransformDispatchBytes(2),
      );

      const recordsA = { label: "records-a", size: 8_192, usage: 0x0080, destroy() {} };
      expect(pass.bindResidentCullRecords(residentRecordBinding(recordsA, 1, 2))).toEqual({
        ok: true,
        changed: true,
      });
      expect(pass.ensureResidentLocalBounds(new Float32Array([0, 0, 8, 9]), 1)).toEqual({
        ok: true,
        replaced: true,
        uploadedBytes: 16,
        epoch: 1,
      });
      const moveCommands = new ArrayBuffer(PALETTE_MOVE_STRIDE * 2);
      new Uint32Array(moveCommands)[3] = 1;
      const move = pass.dispatchMovesDetailed({
        mode: "indexed",
        commands: moveCommands,
        count: 2,
      });
      expect(move).toEqual({
        ok: true,
        mode: "fused-resident",
        uploadBytes: 2 * PALETTE_MOVE_STRIDE + PALETTE_MOVE_UNIFORM_BYTES,
        uploadWrites: 2,
        cullRecordUploadBytes: 0,
        patchedCullRecords: 2,
      });
      expect(pass.bindResidentCullRecords(residentRecordBinding(recordsA, 1, 2))).toEqual({
        ok: true,
        changed: false,
      });
      expect(pass.bindResidentCullRecords(undefined)).toEqual({ ok: true, changed: true });
      expect(
        pass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 8,
          commands: new ArrayBuffer(PALETTE_DENSE_MOVE_STRIDE * 2),
          count: 2,
        }),
      ).toEqual({
        ok: true,
        mode: "palette-only",
        uploadBytes: 2 * PALETTE_DENSE_MOVE_STRIDE + PALETTE_MOVE_UNIFORM_BYTES,
        uploadWrites: 2,
        cullRecordUploadBytes: 0,
        patchedCullRecords: 0,
      });

      const recordsB = { label: "records-b", size: 16_384, usage: 0x0080, destroy() {} };
      expect(pass.bindResidentCullRecords(residentRecordBinding(recordsB, 2, 257))).toEqual({
        ok: true,
        changed: true,
      });

      expect(entries).toEqual([
        "patch_xy",
        "patch_xy_and_cull",
        "patch_xy_dense",
        "patch_xy_and_cull_dense",
        "scatter_transform",
      ]);
      expect(rebound).toHaveLength(2);
      expect(writes).toContainEqual({
        label: "pixi-glyphflow-palette-transform-commands",
        bytes: 2 * PALETTE_TRANSFORM_COMMAND_STRIDE,
      });
      expect(bindEntryCounts).toEqual([3, 5, 3]);
      expect(uniformHeaders).toContainEqual([0, 2, 2, 1]);
      expect(uniformHeaders).toContainEqual([8, 2, 0, 0]);
      expect(submits).toHaveLength(3);
    } finally {
      restoreGpuGlobals();
    }
  });

  test("rolls back failed transform, local-bounds, and command allocations", () => {
    const gpuBuffers: Array<{
      readonly label: string;
      readonly size: number;
      readonly usage: number;
      destroyError: Error | undefined;
      destroyCalls: number;
      destroy(): void;
    }> = [];
    const transformBuffers: Array<{ on(type: string, listener: () => void): void }> = [];
    const transformDestroyCalls: number[] = [];
    const writeTargets: unknown[] = [];
    let deviceCreateCalls = 0;
    let failCreateAt = Number.POSITIVE_INFINITY;
    let failNextBoundsUpload = false;
    let failNextTransformCleanup = false;
    const gpuCleanupFaults = new Map<string, Error>();
    const device = {
      limits: { maxStorageBufferBindingSize: 1_048_576, maxBufferSize: 1_048_576 },
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
      createBuffer: ({ label, size, usage }: { label: string; size: number; usage: number }) => {
        deviceCreateCalls += 1;
        if (deviceCreateCalls === failCreateAt) {
          throw new Error("injected palette allocation failure");
        }
        const buffer = {
          label,
          size,
          usage,
          destroyError: gpuCleanupFaults.get(label),
          destroyCalls: 0,
          destroy() {
            this.destroyCalls += 1;
            if (this.destroyError !== undefined) throw this.destroyError;
          },
        };
        gpuCleanupFaults.delete(label);
        gpuBuffers.push(buffer);
        return buffer;
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setBindGroup() {},
          setPipeline() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: { label?: string }) => {
          writeTargets.push(buffer);
          if (failNextBoundsUpload && buffer.label === "pixi-glyphflow-resident-local-bounds") {
            failNextBoundsUpload = false;
            throw new Error("injected local-bounds upload failure");
          }
        },
        submit() {},
      },
    };
    const renderer = {
      gpu: { device },
      buffer: {
        updateBuffer(buffer: { on(type: string, listener: () => void): void }) {
          const index = transformBuffers.length;
          const cleanupFault = failNextTransformCleanup;
          failNextTransformCleanup = false;
          transformBuffers.push(buffer);
          transformDestroyCalls.push(0);
          buffer.on("destroy", () => {
            transformDestroyCalls[index] = (transformDestroyCalls[index] ?? 0) + 1;
            if (cleanupFault) throw new Error("injected transform cleanup failure");
          });
        },
        getGPUBuffer() {
          return { label: "gpu-transform", size: 1_024, usage: 0x0080, destroy() {} };
        },
      },
    } as never;
    const restoreGpuGlobals = installPaletteGpuGlobals();
    try {
      const pass = new PaletteStoragePass(renderer);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64)).toEqual({ ok: true, replaced: true });
      const liveTransform = pass.transformBuffer;
      failNextTransformCleanup = true;
      const rebindError = new Error("injected transform rebind failure");
      const rebindTargets: unknown[] = [];
      expect(
        pass.ensureTransforms(256, (buffer) => {
          rebindTargets.push(buffer);
          if (rebindTargets.length === 1) throw rebindError;
          throw new Error("injected transform rollback rebind failure");
        }),
      ).toEqual({ ok: false, replaced: false });
      expect(pass.transformBuffer).toBe(liveTransform);
      expect(pass.failureReason).toContain(rebindError.message);
      expect(rebindTargets).toEqual([transformBuffers[1], liveTransform]);
      expect(transformDestroyCalls).toEqual([0, 1]);
      liveTransform.on("destroy", () => {
        throw new Error("injected retired transform cleanup failure");
      });
      expect(pass.ensureTransforms(256)).toEqual({ ok: true, replaced: true });
      const replacementTransform = pass.transformBuffer;
      expect(replacementTransform).not.toBe(liveTransform);
      expect(pass.failureReason).toBeUndefined();
      expect(transformDestroyCalls).toEqual([1, 1, 0]);

      expect(pass.ensureResidentLocalBounds(new Float32Array([0, 0, 8, 9]), 1)).toMatchObject({
        ok: true,
        replaced: true,
        epoch: 1,
      });
      const liveBounds = gpuBuffers.at(-1);
      failNextBoundsUpload = true;
      gpuCleanupFaults.set(
        "pixi-glyphflow-resident-local-bounds",
        new Error("injected failed bounds cleanup failure"),
      );
      expect(
        pass.ensureResidentLocalBounds(new Float32Array([0, 0, 8, 9, 1, 1, 4, 5]), 2),
      ).toMatchObject({
        ok: false,
        replaced: false,
        epoch: 1,
        reason: expect.stringContaining("injected local-bounds upload failure"),
      });
      const failedBounds = gpuBuffers.at(-1);
      expect(liveBounds?.destroyCalls).toBe(0);
      expect(failedBounds?.destroyCalls).toBe(1);
      liveBounds!.destroyError = new Error("injected retired bounds cleanup failure");
      expect(
        pass.ensureResidentLocalBounds(new Float32Array([0, 0, 8, 9, 1, 1, 4, 5]), 2),
      ).toMatchObject({ ok: true, replaced: true, epoch: 2 });
      const replacementBounds = gpuBuffers.at(-1);
      expect(pass.ensureResidentLocalBounds(new Float32Array([0, 0, 8, 9]), 1)).toMatchObject({
        ok: true,
        replaced: false,
        epoch: 2,
      });
      expect(writeTargets.at(-1)).toBe(replacementBounds);

      failCreateAt = deviceCreateCalls + 2;
      gpuCleanupFaults.set(
        "pixi-glyphflow-palette-move-commands",
        new Error("injected failed command cleanup failure"),
      );
      const commands = new ArrayBuffer(PALETTE_MOVE_STRIDE);
      expect(pass.dispatchMovesDetailed({ mode: "indexed", commands, count: 1 })).toMatchObject({
        ok: false,
        mode: "unavailable",
        reason: "palette move command allocation failed",
      });
      const failedCommands = gpuBuffers.at(-1);
      expect(failedCommands?.label).toBe("pixi-glyphflow-palette-move-commands");
      expect(failedCommands?.destroyCalls).toBe(1);
      failCreateAt = Number.POSITIVE_INFINITY;
      expect(pass.dispatchMovesDetailed({ mode: "indexed", commands, count: 1 })).toMatchObject({
        ok: true,
        mode: "palette-only",
      });
      const retiredCommands = [...gpuBuffers]
        .reverse()
        .find(
          (buffer) =>
            buffer.label === "pixi-glyphflow-palette-move-commands" && buffer.destroyCalls === 0,
        );
      retiredCommands!.destroyError = new Error("injected retired command cleanup failure");
      expect(
        pass.dispatchMovesDetailed({
          mode: "indexed",
          commands: new ArrayBuffer(PALETTE_MOVE_STRIDE * 4),
          count: 4,
        }),
      ).toMatchObject({ ok: true, mode: "palette-only" });

      const firstDestroyError = new Error("injected live command cleanup failure");
      const liveCommands = [...gpuBuffers]
        .reverse()
        .find(
          (buffer) =>
            buffer.label === "pixi-glyphflow-palette-move-commands" && buffer.destroyCalls === 0,
        );
      liveCommands!.destroyError = firstDestroyError;
      replacementBounds!.destroyError = new Error("injected live bounds cleanup failure");
      replacementTransform.on("destroy", () => {
        throw new Error("injected live transform cleanup failure");
      });

      expect(() => pass.destroy()).toThrow(firstDestroyError);
      expect(transformDestroyCalls).toEqual([1, 1, 1]);
      expect(liveBounds?.destroyCalls).toBe(1);
      expect(replacementBounds?.destroyCalls).toBe(1);
      expect(failedBounds?.destroyCalls).toBe(1);
      expect(failedCommands?.destroyCalls).toBe(1);
      expect(gpuBuffers.map((buffer) => buffer.destroyCalls)).toEqual(gpuBuffers.map(() => 1));
      expect(() => pass.destroy()).not.toThrow();
      expect(gpuBuffers.map((buffer) => buffer.destroyCalls)).toEqual(gpuBuffers.map(() => 1));
    } finally {
      restoreGpuGlobals();
    }
  });

  test("retires one device epoch and rebuilds after replacement or loss", async () => {
    const restore = installPaletteGpuGlobals();
    try {
      const transaction = trackedPaletteTransaction();
      const first = trackedPaletteDevice("first");
      const renderer = trackedPaletteRenderer(first.device);
      const pass = new PaletteStoragePass(renderer.renderer, transaction.value as never);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      expect(pass.ensureResidentLocalBounds(new Float32Array([0, 0, 8, 10]), 1).ok).toBe(true);
      expect(
        pass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new Float32Array([10, 20]).buffer,
          count: 1,
        }).ok,
      ).toBe(true);
      expect(transaction.works).toHaveLength(1);

      const second = trackedPaletteDevice("second");
      renderer.gpu.device = second.device;
      expect(pass.initialize()).toBe(true);
      expect(transaction.works).toHaveLength(0);
      expect(first.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        first.buffers.map(() => 1),
      );
      expect(renderer.transformDestroyCalls).toEqual([1]);
      expect(pass.ready).toBe(true);
      expect(pass.requiresFullSync).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      expect(pass.ensureResidentLocalBounds(new Float32Array([1, 2, 3, 4]), 1).ok).toBe(true);

      first.resolveLost();
      await settlePromises();
      expect(pass.ready).toBe(true);
      expect(second.buffers.every((buffer) => buffer.destroyCalls === 0)).toBe(true);

      second.resolveLost();
      await settlePromises();
      expect(pass.ready).toBe(false);
      expect(pass.requiresFullSync).toBe(true);
      expect(second.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        second.buffers.map(() => 1),
      );
      expect(renderer.transformDestroyCalls).toEqual([1, 1]);
      expect(pass.initialize()).toBe(false);

      const third = trackedPaletteDevice("third");
      renderer.gpu.device = third.device;
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      pass.acknowledgeFullSync();
      expect(pass.requiresFullSync).toBe(false);

      pass.destroy();
      expect(third.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        third.buffers.map(() => 1),
      );
      expect(renderer.transformDestroyCalls).toEqual([1, 1, 1]);
    } finally {
      restore();
    }
  });

  test("keeps old encoded palette callbacks scoped to their captured device epoch", async () => {
    const restore = installPaletteGpuGlobals();
    try {
      const transaction = trackedPaletteTransaction();
      const first = trackedPaletteDevice("race-first");
      const renderer = trackedPaletteRenderer(first.device);
      const pass = new PaletteStoragePass(renderer.renderer, transaction.value as never);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      expect(
        pass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new Float32Array([10, 20]).buffer,
          count: 1,
        }),
      ).toMatchObject({ ok: true, uploadWrites: 2 });
      const oldWork = transaction.works.shift();
      if (oldWork === undefined) throw new Error("Expected one queued palette work item");
      oldWork.encode?.(first.device.createCommandEncoder());

      first.resolveLost();
      await settlePromises();
      expect(pass.requiresFullSync).toBe(true);

      const second = trackedPaletteDevice("race-second");
      renderer.gpu.device = second.device;
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      const current = pass.dispatchMovesDetailed({
        mode: "dense",
        baseSlot: 0,
        commands: new Float32Array([30, 40]).buffer,
        count: 1,
      });
      expect(current).toMatchObject({ ok: true, uploadWrites: 2 });
      const currentWork = transaction.works.shift();
      if (currentWork === undefined) throw new Error("Expected current palette work item");
      pass.acknowledgeFullSync();

      oldWork.complete?.();
      oldWork.cancel?.("failed");
      oldWork.fail?.(new Error("stale palette frame failure"));
      expect(pass.requiresFullSync).toBe(false);
      expect(pass.failureReason).toBeUndefined();
      expect(pass.lastMoveDispatch).toEqual(current);
      expect(first.buffers.map((buffer) => buffer.destroyCalls)).toEqual(
        first.buffers.map(() => 1),
      );

      currentWork.fail?.(new Error("current palette frame failure"));
      expect(pass.requiresFullSync).toBe(true);
      expect(pass.failureReason).toContain("current palette frame failure");
      pass.destroy();
    } finally {
      restore();
    }
  });

  test("keeps old encoded transform callbacks scoped to their captured device epoch", async () => {
    const restore = installPaletteGpuGlobals();
    try {
      const transaction = trackedPaletteTransaction();
      const first = trackedPaletteDevice("transform-race-first");
      const renderer = trackedPaletteRenderer(first.device);
      const pass = new PaletteStoragePass(renderer.renderer, transaction.value as never);
      const data = new Float32Array(8);
      data.set([1, 2, 1, 1, 0, 0, 1, 1]);
      const slots = new Uint32Array([0]);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      expect(pass.dispatchTransforms(data, slots, 1, 0)).toBe(paletteTransformDispatchBytes(1));
      const oldWork = transaction.works.shift();
      if (oldWork === undefined) throw new Error("Expected one queued transform work item");
      oldWork.encode?.(first.device.createCommandEncoder());

      first.resolveLost();
      await settlePromises();
      expect(pass.requiresFullSync).toBe(true);

      const second = trackedPaletteDevice("transform-race-second");
      renderer.gpu.device = second.device;
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      expect(pass.dispatchTransforms(data, slots, 1, 0)).toBe(paletteTransformDispatchBytes(1));
      const currentWork = transaction.works.shift();
      if (currentWork === undefined) throw new Error("Expected current transform work item");
      pass.acknowledgeFullSync();

      oldWork.complete?.();
      oldWork.cancel?.("failed");
      oldWork.fail?.(new Error("stale transform frame failure"));
      expect(pass.requiresFullSync).toBe(false);
      expect(pass.failureReason).toBeUndefined();

      currentWork.fail?.(new Error("current transform frame failure"));
      expect(pass.requiresFullSync).toBe(true);
      expect(pass.failureReason).toContain("current transform frame failure");
      pass.destroy();
    } finally {
      restore();
    }
  });

  test("reports every accepted mover write across each synchronous failure stage", () => {
    const restore = installPaletteGpuGlobals();
    try {
      const cases = [
        { stage: "command-write", uploadBytes: 0, uploadWrites: 0 },
        {
          stage: "uniform-write",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2,
          uploadWrites: 1,
        },
        {
          stage: "bind-group",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "create-encoder",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "begin-pass",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "set-bind-group",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "set-pipeline",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "dispatch",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "end-pass",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "finish",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
        {
          stage: "submit",
          uploadBytes: PALETTE_DENSE_MOVE_STRIDE * 2 + PALETTE_MOVE_UNIFORM_BYTES,
          uploadWrites: 2,
        },
      ] as const;
      for (const expectation of cases) {
        const device = trackedPaletteDevice(expectation.stage);
        const renderer = trackedPaletteRenderer(device.device);
        const pass = new PaletteStoragePass(renderer.renderer);
        expect(pass.initialize()).toBe(true);
        expect(pass.ensureTransforms(64).ok).toBe(true);
        device.controls.failureStage = expectation.stage;

        expect(
          pass.dispatchMovesDetailed({
            mode: "dense",
            baseSlot: 0,
            commands: new Float32Array([1, 2, 3, 4]).buffer,
            count: 2,
          }),
        ).toMatchObject({
          ok: false,
          mode: "unavailable",
          uploadBytes: expectation.uploadBytes,
          uploadWrites: expectation.uploadWrites,
          patchedCullRecords: 0,
        });
        expect(device.acceptedWrites).toHaveLength(expectation.uploadWrites);
        pass.destroy();
      }
    } finally {
      restore();
    }
  });

  test("reports accepted writes when transaction queueing or deferred encoding fails", () => {
    const restore = installPaletteGpuGlobals();
    try {
      const device = trackedPaletteDevice("transaction");
      const renderer = trackedPaletteRenderer(device.device);
      const rejected = trackedPaletteTransaction();
      rejected.queueAccepted = false;
      const rejectedPass = new PaletteStoragePass(renderer.renderer, rejected.value as never);
      expect(rejectedPass.initialize()).toBe(true);
      expect(rejectedPass.ensureTransforms(64).ok).toBe(true);
      expect(
        rejectedPass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new Float32Array([1, 2]).buffer,
          count: 1,
        }),
      ).toMatchObject({
        ok: false,
        uploadBytes: PALETTE_DENSE_MOVE_STRIDE + PALETTE_MOVE_UNIFORM_BYTES,
        uploadWrites: 2,
      });
      rejectedPass.destroy();

      const queued = trackedPaletteTransaction();
      const queuedPass = new PaletteStoragePass(renderer.renderer, queued.value as never);
      expect(queuedPass.initialize()).toBe(true);
      expect(queuedPass.ensureTransforms(64).ok).toBe(true);
      expect(
        queuedPass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new Float32Array([3, 4]).buffer,
          count: 1,
        }),
      ).toMatchObject({ ok: true, uploadWrites: 2 });
      queued.works[0]?.fail?.(new Error("injected deferred encode failure"));
      expect(queuedPass.lastMoveDispatch).toMatchObject({
        ok: false,
        uploadBytes: PALETTE_DENSE_MOVE_STRIDE + PALETTE_MOVE_UNIFORM_BYTES,
        uploadWrites: 2,
        reason: expect.stringContaining("injected deferred encode failure"),
      });
      expect(queuedPass.requiresFullSync).toBe(true);
      queuedPass.destroy();
    } finally {
      restore();
    }
  });

  test("accepts zero movers as a GPU-free no-op and enforces the live workgroup limit", () => {
    const restore = installPaletteGpuGlobals();
    try {
      const device = trackedPaletteDevice("limits");
      const renderer = trackedPaletteRenderer(device.device);
      const pass = new PaletteStoragePass(renderer.renderer);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);

      expect(
        pass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new ArrayBuffer(0),
          count: 0,
        }),
      ).toEqual({
        ok: true,
        mode: "palette-only",
        uploadBytes: 0,
        uploadWrites: 0,
        cullRecordUploadBytes: 0,
        patchedCullRecords: 0,
      });
      expect(device.acceptedWrites).toHaveLength(0);
      expect(device.dispatchGroups).toHaveLength(0);

      const boundaryCount = 65_535 * 256;
      expect(
        pass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new ArrayBuffer(0),
          count: boundaryCount,
        }),
      ).toMatchObject({
        ok: false,
        uploadBytes: 0,
        uploadWrites: 0,
        reason: "palette move dispatch resources are unavailable",
      });
      expect(
        pass.dispatchMovesDetailed({
          mode: "dense",
          baseSlot: 0,
          commands: new ArrayBuffer(0),
          count: boundaryCount + 1,
        }),
      ).toMatchObject({
        ok: false,
        uploadBytes: 0,
        uploadWrites: 0,
        reason: "palette move dispatch requires 65536 workgroups; the device limit is 65535",
      });
      pass.destroy();
    } finally {
      restore();
    }
  });

  test("bounds idle dispatch storage after overlapping submit, cancel, and failure bursts", () => {
    const restore = installPaletteGpuGlobals();
    try {
      for (const releaseMode of ["complete", "cancel", "fail"] as const) {
        const device = trackedPaletteDevice(releaseMode);
        const renderer = trackedPaletteRenderer(device.device);
        const transaction = trackedPaletteTransaction();
        const pass = new PaletteStoragePass(renderer.renderer, transaction.value as never);
        expect(pass.initialize()).toBe(true);
        expect(pass.ensureTransforms(64).ok).toBe(true);
        const commands = new ArrayBuffer(100_000 * PALETTE_DENSE_MOVE_STRIDE);

        for (let index = 0; index < 100; index += 1) {
          expect(
            pass.dispatchMovesDetailed({
              mode: "dense",
              baseSlot: index * 100_000,
              commands,
              count: 100_000,
            }),
          ).toMatchObject({ ok: true, uploadWrites: 2 });
        }
        expect(liveBuffers(device.buffers, "pixi-glyphflow-palette-move-commands")).toHaveLength(
          100,
        );
        expect(liveBuffers(device.buffers, "pixi-glyphflow-palette-move-uniforms")).toHaveLength(
          100,
        );

        transaction.releaseAll(releaseMode);
        const idleCommands = liveBuffers(device.buffers, "pixi-glyphflow-palette-move-commands");
        const idleUniforms = liveBuffers(device.buffers, "pixi-glyphflow-palette-move-uniforms");
        expect(idleCommands).toHaveLength(3);
        expect(idleUniforms).toHaveLength(3);
        expect(idleCommands.reduce((sum, buffer) => sum + buffer.size, 0)).toBeLessThanOrEqual(
          3 * 1_048_576,
        );
        expect(device.buffers.every((buffer) => buffer.destroyCalls <= 1)).toBe(true);

        const createCalls = device.buffers.length;
        expect(
          pass.dispatchMovesDetailed({
            mode: "dense",
            baseSlot: 0,
            commands: new Float32Array([1, 2]).buffer,
            count: 1,
          }).ok,
        ).toBe(true);
        expect(device.buffers).toHaveLength(createCalls);
        transaction.releaseAll("complete");

        expect(
          pass.dispatchMovesDetailed({
            mode: "dense",
            baseSlot: 0,
            commands: new ArrayBuffer(150_000 * PALETTE_DENSE_MOVE_STRIDE),
            count: 150_000,
          }).ok,
        ).toBe(true);
        expect(device.buffers).toHaveLength(createCalls + 1);
        transaction.releaseAll("complete");
        expect(liveBuffers(device.buffers, "pixi-glyphflow-palette-move-commands")).toHaveLength(3);

        pass.destroy();
        expect(device.buffers.every((buffer) => buffer.destroyCalls === 1)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  test("refreshes occupied origins without touching empty slots", () => {
    const data = new Float32Array(PALETTE_ORIGIN_FLOATS * 3);
    data.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    data.set([9, 10, 11, 12, 13, 14, 15, 16], PALETTE_ORIGIN_FLOATS);
    const occupied = new Uint8Array([1, 0, 1]);
    const originX = new Float32Array([100, 200, 300]);
    const originY = new Float32Array([101, 201, 301]);

    expect(refreshPaletteOrigins(data, occupied, originX, originY, 3)).toBe(2);
    expect(Array.from(data.subarray(0, 2))).toEqual([100, 101]);
    expect(Array.from(data.subarray(PALETTE_ORIGIN_FLOATS, PALETTE_ORIGIN_FLOATS + 2))).toEqual([
      9, 10,
    ]);
  });

  test("patches live x/y from packed commands, not origin-column lookups", () => {
    expect(PALETTE_PATCH_WGSL).not.toMatch(/\blet from\b/);
    expect(PALETTE_PATCH_WGSL).not.toMatch(/\blet to\b/);
    expect(PALETTE_PATCH_WGSL).toContain("fn patch_xy");
    expect(PALETTE_PATCH_WGSL).toContain("struct MoveCommand");
    expect(PALETTE_PATCH_WGSL).not.toContain("_pad: u32");
    expect(PALETTE_PATCH_WGSL).toContain("commands[id.x]");
    expect(PALETTE_PATCH_WGSL).toContain("texel.x = command.x");
    expect(PALETTE_PATCH_WGSL).toContain("texel.y = command.y");
    expect(PALETTE_PATCH_WGSL).toContain("transforms[base] = texel");
    expect(PALETTE_PATCH_WGSL).toContain("fn patch_xy_and_cull");
    expect(PALETTE_PATCH_WGSL).toContain("local_bounds[record.local_bounds_index]");
    expect(PALETTE_PATCH_WGSL).toContain("let min_x = command.x + bounds.x");
    expect(PALETTE_PATCH_WGSL).toContain("record.min_x = min_x");
    expect(PALETTE_PATCH_WGSL).toContain("record.max_x = min_x + bounds.z");
    expect(PALETTE_PATCH_WGSL).toContain("@group(0) @binding(3) var<storage, read_write> records");
    expect(PALETTE_PATCH_WGSL).toContain("@group(0) @binding(4) var<storage, read> local_bounds");
    expect(PALETTE_PATCH_WGSL).not.toContain("origin_x");
    expect(PALETTE_PATCH_WGSL).not.toContain("origin_y");
    expect(PALETTE_PATCH_WGSL).not.toContain("array<u32>");
    expect(PALETTE_PATCH_WGSL).toContain("@group(0) @binding(1) var<storage, read> commands");
    expect(PALETTE_PATCH_WGSL).toContain(
      "@group(0) @binding(2) var<storage, read_write> transforms",
    );
    expect(PALETTE_TRANSFORM_SCATTER_WGSL).toContain("fn scatter_transform");
    expect(PALETTE_TRANSFORM_SCATTER_WGSL).toContain("transforms[base] = command.core0");
    expect(PALETTE_TRANSFORM_SCATTER_WGSL).toContain("transforms[base + 1u] = command.core1");
    expect(PALETTE_TRANSFORM_SCATTER_WGSL).toContain("params.effectBase");
    expect(PALETTE_TRANSFORM_SCATTER_WGSL).toContain("command.effect");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("fn patch_xy_dense");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("fn patch_xy_and_cull_dense");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("struct DenseMoveCommand");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("params.base_slot + id.x");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("commands[id.x]");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("let min_x = command.x + bounds.x");
    expect(PALETTE_DENSE_PATCH_WGSL).toContain("record.max_x = min_x + bounds.z");
  });
});

type PaletteFailureStage =
  | "command-write"
  | "uniform-write"
  | "bind-group"
  | "create-encoder"
  | "begin-pass"
  | "set-bind-group"
  | "set-pipeline"
  | "dispatch"
  | "end-pass"
  | "finish"
  | "submit";

interface TrackedPaletteBuffer {
  readonly label: string;
  readonly size: number;
  readonly usage: number;
  destroyCalls: number;
  destroy(): void;
}

interface TrackedPaletteWork {
  encode?(encoder: unknown): void;
  complete?(): void;
  cancel?(reason: "superseded" | "stale" | "destroyed" | "failed"): void;
  fail?(error: unknown): void;
}

function trackedPaletteDevice(name: string): {
  readonly device: GPUDevice;
  readonly buffers: TrackedPaletteBuffer[];
  readonly acceptedWrites: Array<{ readonly label: string; readonly bytes: number }>;
  readonly dispatchGroups: number[];
  readonly controls: { failureStage: PaletteFailureStage | undefined };
  resolveLost(): void;
} {
  const buffers: TrackedPaletteBuffer[] = [];
  const acceptedWrites: Array<{ readonly label: string; readonly bytes: number }> = [];
  const dispatchGroups: number[] = [];
  const controls: { failureStage: PaletteFailureStage | undefined } = {
    failureStage: undefined,
  };
  let resolveLostPromise = (_info: unknown): void => {};
  const lost = new Promise<unknown>((resolve) => {
    resolveLostPromise = resolve;
  });
  const fail = (stage: PaletteFailureStage): void => {
    if (controls.failureStage === stage) throw new Error(`injected ${stage} failure`);
  };
  const device = {
    name,
    lost,
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxStorageBuffersInVertexStage: 1,
      maxStorageBufferBindingSize: 128 * 1_024 * 1_024,
      maxBufferSize: 128 * 1_024 * 1_024,
      maxComputeWorkgroupsPerDimension: 65_535,
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({}),
    createBuffer: ({ label, size, usage }: { label: string; size: number; usage: number }) => {
      const buffer: TrackedPaletteBuffer = {
        label,
        size,
        usage,
        destroyCalls: 0,
        destroy() {
          this.destroyCalls += 1;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => {
      fail("bind-group");
      return {};
    },
    createCommandEncoder: () => {
      fail("create-encoder");
      return {
        beginComputePass: () => {
          fail("begin-pass");
          return {
            setBindGroup() {
              fail("set-bind-group");
            },
            setPipeline() {
              fail("set-pipeline");
            },
            dispatchWorkgroups(groups: number) {
              fail("dispatch");
              dispatchGroups.push(groups);
            },
            end() {
              fail("end-pass");
            },
          };
        },
        finish: () => {
          fail("finish");
          return {};
        },
      };
    },
    queue: {
      writeBuffer(
        buffer: TrackedPaletteBuffer,
        _bufferOffset: number,
        source: ArrayBuffer | ArrayBufferView,
        sourceOffset = 0,
        size?: number,
      ) {
        if (buffer.label === "pixi-glyphflow-palette-move-commands") fail("command-write");
        if (buffer.label === "pixi-glyphflow-palette-move-uniforms") fail("uniform-write");
        acceptedWrites.push({
          label: buffer.label,
          bytes: size ?? source.byteLength - sourceOffset,
        });
      },
      submit() {
        fail("submit");
      },
    },
  } as unknown as GPUDevice;
  return {
    device,
    buffers,
    acceptedWrites,
    dispatchGroups,
    controls,
    resolveLost(): void {
      resolveLostPromise({ reason: "unknown", message: `${name} lost` });
    },
  };
}

function trackedPaletteRenderer(initialDevice: GPUDevice): {
  readonly renderer: never;
  readonly gpu: { device: GPUDevice };
  readonly transformDestroyCalls: number[];
} {
  const gpu = { device: initialDevice };
  const transformDestroyCalls: number[] = [];
  return {
    gpu,
    transformDestroyCalls,
    renderer: {
      gpu,
      buffer: {
        updateBuffer(buffer: { on(type: string, listener: () => void): void }) {
          const index = transformDestroyCalls.length;
          transformDestroyCalls.push(0);
          buffer.on("destroy", () => {
            transformDestroyCalls[index] = (transformDestroyCalls[index] ?? 0) + 1;
          });
        },
        getGPUBuffer(buffer: { size?: number }) {
          return {
            label: "tracked-palette-transform",
            size: buffer.size ?? 0,
            usage: 0x0080,
            destroy() {},
          };
        },
      },
    } as never,
  };
}

function trackedPaletteTransaction(): {
  readonly value: object;
  readonly works: TrackedPaletteWork[];
  queueAccepted: boolean;
  releaseAll(mode: "complete" | "cancel" | "fail"): void;
} {
  const fixture = {
    works: [] as TrackedPaletteWork[],
    queueAccepted: true,
    epoch: 0,
    releaseAll(mode: "complete" | "cancel" | "fail"): void {
      const pending = fixture.works.splice(0);
      for (const work of pending) {
        if (mode === "complete") work.complete?.();
        else if (mode === "cancel") work.cancel?.("stale");
        else work.fail?.(new Error("injected queued palette failure"));
      }
    },
  };
  const value = {
    get currentEpoch() {
      return fixture.epoch;
    },
    queue(_stage: string, _epoch: number, work: TrackedPaletteWork): boolean {
      if (!fixture.queueAccepted) return false;
      fixture.works.push(work);
      return true;
    },
    cancelEpoch(): number {
      const cancelled = fixture.works.length;
      fixture.releaseAll("cancel");
      if (cancelled > 0) fixture.epoch += 1;
      return cancelled;
    },
    flush() {
      return { ok: true, submitted: false, encodedWork: 0 };
    },
  };
  return {
    value,
    works: fixture.works,
    get queueAccepted() {
      return fixture.queueAccepted;
    },
    set queueAccepted(value: boolean) {
      fixture.queueAccepted = value;
    },
    releaseAll: fixture.releaseAll,
  };
}

function liveBuffers(
  buffers: readonly TrackedPaletteBuffer[],
  label: string,
): TrackedPaletteBuffer[] {
  return buffers.filter((buffer) => buffer.label === label && buffer.destroyCalls === 0);
}

function residentRecordBinding(
  buffer: { readonly size: number },
  epoch: number,
  recordCount: number,
) {
  return {
    buffer: buffer as unknown as GPUBuffer,
    epoch,
    byteLength: buffer.size,
    recordCount,
  };
}

function installPaletteGpuGlobals(): () => void {
  return installWebGpuGlobals({
    GPUShaderStage: { COMPUTE: 4 },
    GPUBufferUsage: { STORAGE: 0x0080, COPY_DST: 0x0008, UNIFORM: 0x0040 },
  });
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
