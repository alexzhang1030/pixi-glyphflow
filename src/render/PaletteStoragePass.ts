import { Buffer, BufferUsage, type WebGPURenderer } from "pixi.js";

import { CULL_RECORD_STRIDE, planComputeCullStorageBytes } from "../culling/computeCull";
import { cleanupBestEffort, cleanupBestEffortOrThrow } from "./cleanup";
import type { ComputeCullResidentRecords } from "./ComputeCullPass";
import {
  PALETTE_DENSE_PATCH_WGSL,
  PALETTE_PATCH_WGSL,
  PALETTE_TRANSFORM_SCATTER_WGSL,
} from "./palettePatch.wgsl";
import {
  PALETTE_DENSE_MOVE_STRIDE,
  PALETTE_MOVE_UNIFORM_BYTES,
  PALETTE_PATCH_WORKGROUP,
  PALETTE_TRANSFORM_COMMAND_STRIDE,
  packPaletteTransforms,
  paletteMoveUploadBytes,
  paletteTransformDispatchBytes,
  residentLocalBoundsBytes,
  type PaletteMoveUpload,
} from "./paletteStorage";
import type { DirtyByteRange } from "./types";
import type { WebGPUFrameTransaction } from "./WebGPUFrameTransaction";

export type { PaletteMoveUpload };

export type PaletteMoveDispatchMode = "palette-only" | "fused-resident" | "unavailable";

export interface PaletteMoveDispatchResult {
  readonly ok: boolean;
  readonly mode: PaletteMoveDispatchMode;
  readonly uploadBytes: number;
  readonly uploadWrites: number;
  readonly cullRecordUploadBytes: 0;
  readonly patchedCullRecords: number;
  readonly reason?: string;
}

export interface ResidentCullRecordBindResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly reason?: string;
}

export interface ResidentLocalBoundsUploadResult {
  readonly ok: boolean;
  readonly replaced: boolean;
  readonly uploadedBytes: number;
  readonly epoch: number;
  readonly reason?: string;
}

interface PaletteDispatchSlice {
  commands: GPUBuffer | undefined;
  uniform: GPUBuffer | undefined;
  commandCapacityBytes: number;
  busy: boolean;
}

interface PaletteDispatchLease {
  readonly commands: GPUBuffer;
  readonly uniform: GPUBuffer;
  readonly release: () => void;
}

type PaletteDispatchEncode = (
  encoder: GPUCommandEncoder,
  timestampWrites?: GPUComputePassTimestampWrites,
) => void;

interface PaletteDispatchLifecycle {
  readonly encoderLabel: string;
  readonly encode: PaletteDispatchEncode;
  readonly onAbort: () => void;
  readonly onFailure: (error: unknown) => void;
}

const MAX_IDLE_DISPATCH_SLICES = 3;

export class PaletteStoragePass {
  readonly #renderer: WebGPURenderer;
  readonly #frameTransaction: WebGPUFrameTransaction | undefined;
  #device: GPUDevice | undefined;
  #deviceEpoch = 0;
  #failedDevice: GPUDevice | undefined;
  #pipeline: GPUComputePipeline | undefined;
  #fusedPipeline: GPUComputePipeline | undefined;
  #densePipeline: GPUComputePipeline | undefined;
  #denseFusedPipeline: GPUComputePipeline | undefined;
  #transformPipeline: GPUComputePipeline | undefined;
  #bindGroupLayout: GPUBindGroupLayout | undefined;
  #fusedBindGroupLayout: GPUBindGroupLayout | undefined;
  #transforms: GPUBuffer | undefined;
  #transformBuffer: Buffer | undefined;
  #rebindTransformsBeforeRetire: (buffer: Buffer) => void = () => {};
  readonly #dispatchSlices: PaletteDispatchSlice[] = [];
  #residentRecords: Readonly<ComputeCullResidentRecords> | undefined;
  #localBounds: GPUBuffer | undefined;
  #localBoundsBytes = 0;
  #localBoundsCount = 0;
  #localBoundsEpoch = 0;
  #transformBytes = 0;
  #ready = false;
  #requiresFullSync = false;
  #failureReason: string | undefined;
  readonly #uniformScratch = new ArrayBuffer(PALETTE_MOVE_UNIFORM_BYTES);
  readonly #uniformInts = new Uint32Array(this.#uniformScratch);
  #transformScratch = new ArrayBuffer(0);
  #lastMoveDispatch: Readonly<PaletteMoveDispatchResult> = Object.freeze({
    ok: true,
    mode: "palette-only",
    uploadBytes: 0,
    uploadWrites: 0,
    cullRecordUploadBytes: 0,
    patchedCullRecords: 0,
  });
  #destroyed = false;

  constructor(renderer: WebGPURenderer, frameTransaction?: WebGPUFrameTransaction) {
    this.#renderer = renderer;
    this.#frameTransaction = frameTransaction;
    this.#transformBuffer = createPaletteBuffer(16);
  }

  get transformBuffer(): Buffer {
    const buffer = this.#transformBuffer;
    if (buffer === undefined) throw new Error("palette storage pass is destroyed");
    return buffer;
  }

  get ready(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#ready;
  }

  /** True after `ensureTransforms` registered a GPU storage buffer with Pixi. */
  get hasGpuTransforms(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#transforms !== undefined;
  }

  /** Live palette table. Compute-cull reads origin from the same buffer. */
  get gpuTransforms(): GPUBuffer | undefined {
    this.#synchronizeRendererIdentity();
    return this.#transforms;
  }

  /** True when fused resident movers can read local bounds from the current device epoch. */
  get hasResidentLocalBounds(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#localBounds !== undefined && this.#localBoundsCount > 0;
  }

  get failureReason(): string | undefined {
    return this.#failureReason;
  }

  get requiresFullSync(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#requiresFullSync;
  }

  acknowledgeFullSync(): void {
    this.#requiresFullSync = false;
    this.#failureReason = undefined;
  }

  get lastMoveDispatch(): Readonly<PaletteMoveDispatchResult> {
    return this.#lastMoveDispatch;
  }

  initialize(): boolean {
    if (this.#destroyed) return false;
    const device = this.#renderer.gpu?.device;
    if (this.#device !== undefined && this.#device !== device) {
      this.#retireDeviceEpoch("palette storage WebGPU device was replaced", this.#device);
    }
    if (this.#ready && this.#device === device) return true;
    if (device === undefined) {
      this.#failureReason = "palette storage WebGPU device is unavailable";
      return false;
    }
    if (this.#failedDevice === device) return false;
    const storageBuffers = device.limits.maxStorageBuffersPerShaderStage;
    if (typeof storageBuffers === "number" && storageBuffers < 4) {
      this.#failedDevice = device;
      this.#failureReason = `fused resident move patch requires 4 storage buffers; the device exposes ${String(storageBuffers)}`;
      return false;
    }
    try {
      const module = device.createShaderModule({
        label: "pixi-glyphflow-palette-patch",
        code: PALETTE_PATCH_WGSL,
      });
      const denseModule = device.createShaderModule({
        label: "pixi-glyphflow-palette-dense-patch",
        code: PALETTE_DENSE_PATCH_WGSL,
      });
      const transformModule = device.createShaderModule({
        label: "pixi-glyphflow-palette-transform-scatter",
        code: PALETTE_TRANSFORM_SCATTER_WGSL,
      });
      const bindGroupLayout = device.createBindGroupLayout({
        label: "pixi-glyphflow-palette-patch-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const fusedBindGroupLayout = device.createBindGroupLayout({
        label: "pixi-glyphflow-palette-resident-patch-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ],
      });
      this.#pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        compute: { module, entryPoint: "patch_xy" },
      });
      this.#fusedPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [fusedBindGroupLayout] }),
        compute: { module, entryPoint: "patch_xy_and_cull" },
      });
      this.#densePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        compute: { module: denseModule, entryPoint: "patch_xy_dense" },
      });
      this.#denseFusedPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [fusedBindGroupLayout] }),
        compute: { module: denseModule, entryPoint: "patch_xy_and_cull_dense" },
      });
      this.#transformPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        compute: { module: transformModule, entryPoint: "scatter_transform" },
      });
      this.#bindGroupLayout = bindGroupLayout;
      this.#fusedBindGroupLayout = fusedBindGroupLayout;
      this.#device = device;
      this.#deviceEpoch += 1;
      this.#failedDevice = undefined;
      this.#ready = true;
      this.#failureReason = undefined;
      this.#watchDeviceLoss(device, this.#deviceEpoch);
      return true;
    } catch (error: unknown) {
      this.#failedDevice = device;
      this.#ready = false;
      this.#failureReason = diagnosticMessage("palette storage initialization failed", error);
      return false;
    }
  }

  ensureTransforms(
    bytes: number,
    rebindBeforeRetire: (buffer: Buffer) => void = () => {},
  ): { readonly ok: boolean; readonly replaced: boolean } {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    if (device === undefined || !this.#ready) return { ok: false, replaced: false };
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const size = planComputeCullStorageBytes(Math.max(16, bytes), limit);
    if (size === undefined) return { ok: false, replaced: false };
    if (size <= this.#transformBytes && this.#transforms !== undefined) {
      return { ok: true, replaced: false };
    }
    const flushed = this.#frameTransaction?.flush();
    if (flushed !== undefined && !flushed.ok) {
      this.#failureReason = `palette transform capacity flush failed: ${flushed.reason ?? "unknown error"}`;
      return { ok: false, replaced: false };
    }
    const previous = this.#transformBuffer;
    let candidate: Buffer | undefined;
    let transforms: GPUBuffer;
    let rebindAttempted = false;
    try {
      candidate = createPaletteBuffer(size);
      this.#renderer.buffer.updateBuffer(candidate);
      transforms = this.#renderer.buffer.getGPUBuffer(candidate);
      rebindAttempted = true;
      rebindBeforeRetire(candidate);
    } catch (error: unknown) {
      if (candidate !== undefined) {
        const failedCandidate = candidate;
        cleanupBestEffort([
          () => {
            if (rebindAttempted && previous !== undefined) rebindBeforeRetire(previous);
          },
          () => failedCandidate.destroy(),
        ]);
      }
      this.#failureReason = diagnosticMessage("palette transform allocation failed", error);
      return { ok: false, replaced: false };
    }
    this.#transformBuffer = candidate;
    this.#transforms = transforms;
    this.#transformBytes = size;
    this.#rebindTransformsBeforeRetire = rebindBeforeRetire;
    cleanupBestEffort([() => previous?.destroy()]);
    this.#failureReason = undefined;
    return { ok: true, replaced: true };
  }

  uploadTransforms(data: Float32Array, dirty: readonly Readonly<DirtyByteRange>[]): number {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    const buffer = this.#transforms;
    if (device === undefined || buffer === undefined) return 0;
    if (dirty.length === 0) return 0;
    let uploaded = 0;
    for (const range of dirty) {
      if (range.length <= 0) continue;
      device.queue.writeBuffer(
        buffer,
        range.offset,
        data.buffer,
        data.byteOffset + range.offset,
        range.length,
      );
      uploaded += range.length;
    }
    return uploaded;
  }

  uploadAllTransforms(data: Float32Array): number {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    const buffer = this.#transforms;
    if (device === undefined || buffer === undefined) return 0;
    const bytes = Math.min(data.byteLength, this.#transformBytes);
    device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, bytes);
    return bytes;
  }

  ensureResidentLocalBounds(
    data: Float32Array,
    count: number,
  ): Readonly<ResidentLocalBoundsUploadResult> {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    if (device === undefined || !this.#ready) {
      return this.#localBoundsFailure("palette storage pass is unavailable");
    }
    if (!(data instanceof Float32Array)) {
      return this.#localBoundsFailure("resident local bounds must be a Float32Array");
    }
    let bytes;
    try {
      bytes = residentLocalBoundsBytes(count);
    } catch (error: unknown) {
      return this.#localBoundsFailure(
        diagnosticMessage("resident local-bounds size failed", error),
      );
    }
    if (data.byteLength < bytes) {
      return this.#localBoundsFailure("resident local bounds are shorter than count");
    }
    if (count === 0) {
      this.#localBoundsCount = 0;
      return Object.freeze({
        ok: true,
        replaced: false,
        uploadedBytes: 0,
        epoch: this.#localBoundsEpoch,
      });
    }
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const allocatedBytes = planComputeCullStorageBytes(Math.max(16, bytes), limit);
    if (allocatedBytes === undefined) {
      return this.#localBoundsFailure(
        `resident local bounds exceed the ${String(limit)}-byte device binding limit`,
      );
    }
    let replaced = false;
    if (allocatedBytes > this.#localBoundsBytes || this.#localBounds === undefined) {
      const flushed = this.#frameTransaction?.flush();
      if (flushed !== undefined && !flushed.ok) {
        return this.#localBoundsFailure(
          `resident local-bounds capacity flush failed: ${flushed.reason ?? "unknown error"}`,
        );
      }
      let candidate: GPUBuffer | undefined;
      try {
        candidate = createBuffer(device, allocatedBytes, "pixi-glyphflow-resident-local-bounds");
        device.queue.writeBuffer(candidate, 0, data.buffer, data.byteOffset, bytes);
      } catch (error: unknown) {
        cleanupBestEffort([() => candidate?.destroy()]);
        return this.#localBoundsFailure(
          diagnosticMessage("resident local-bounds allocation failed", error),
        );
      }
      const previous = this.#localBounds;
      this.#localBounds = candidate;
      this.#localBoundsBytes = allocatedBytes;
      this.#localBoundsEpoch += 1;
      replaced = true;
      cleanupBestEffort([() => previous?.destroy()]);
    } else {
      try {
        device.queue.writeBuffer(this.#localBounds, 0, data.buffer, data.byteOffset, bytes);
      } catch (error: unknown) {
        return this.#localBoundsFailure(
          diagnosticMessage("resident local-bounds upload failed", error),
        );
      }
    }
    this.#localBoundsCount = count;
    this.#failureReason = undefined;
    return Object.freeze({
      ok: true,
      replaced,
      uploadedBytes: bytes,
      epoch: this.#localBoundsEpoch,
    });
  }

  bindResidentCullRecords(
    binding: Readonly<ComputeCullResidentRecords> | undefined,
  ): Readonly<ResidentCullRecordBindResult> {
    this.#synchronizeRendererIdentity();
    if (binding === undefined) {
      const changed = this.#residentRecords !== undefined;
      this.#residentRecords = undefined;
      return Object.freeze({ ok: true, changed });
    }
    if (!this.#ready || this.#device === undefined) {
      return Object.freeze({
        ok: false,
        changed: false,
        reason: "palette storage pass is unavailable",
      });
    }
    if (binding.recordCount < 0 || binding.recordCount * CULL_RECORD_STRIDE > binding.byteLength) {
      return Object.freeze({
        ok: false,
        changed: false,
        reason: "resident cull record binding is shorter than recordCount",
      });
    }
    if ((binding.buffer.usage & GPUBufferUsage.STORAGE) === 0) {
      return Object.freeze({
        ok: false,
        changed: false,
        reason: "resident cull record buffer lacks STORAGE usage",
      });
    }
    const current = this.#residentRecords;
    const changed =
      current === undefined || current.buffer !== binding.buffer || current.epoch !== binding.epoch;
    this.#residentRecords = Object.freeze({ ...binding });
    this.#failureReason = undefined;
    return Object.freeze({ ok: true, changed });
  }

  dispatchMoves(move: PaletteMoveUpload): number {
    return this.dispatchMovesDetailed(move).uploadBytes;
  }

  dispatchMovesDetailed(move: PaletteMoveUpload): Readonly<PaletteMoveDispatchResult> {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    const transforms = this.#transforms;
    let commandBytes: number;
    try {
      commandBytes = paletteMoveUploadBytes(move.mode, move.count);
      if (
        move.mode === "dense" &&
        (!Number.isSafeInteger(move.baseSlot) ||
          move.baseSlot < 0 ||
          move.baseSlot + move.count > 0x1_0000_0000)
      ) {
        return this.#moveFailure("dense palette move slot range exceeds uint32 capacity");
      }
    } catch (error: unknown) {
      return this.#moveFailure(diagnosticMessage("palette move validation failed", error));
    }
    const resident = this.#residentRecords;
    if (commandBytes === 0) {
      const result = Object.freeze({
        ok: true,
        mode: resident === undefined ? ("palette-only" as const) : ("fused-resident" as const),
        uploadBytes: 0,
        uploadWrites: 0,
        cullRecordUploadBytes: 0 as const,
        patchedCullRecords: 0,
      });
      this.#lastMoveDispatch = result;
      this.#failureReason = undefined;
      return result;
    }
    if (device === undefined || transforms === undefined) {
      return this.#moveFailure("palette move dispatch resources are unavailable");
    }
    const groups = Math.max(1, Math.ceil(move.count / PALETTE_PATCH_WORKGROUP));
    const groupLimit = device.limits.maxComputeWorkgroupsPerDimension;
    if (typeof groupLimit === "number" && groups > groupLimit) {
      return this.#moveFailure(
        `palette move dispatch requires ${String(groups)} workgroups; the device limit is ${String(groupLimit)}`,
      );
    }
    if (move.commands.byteLength < commandBytes) {
      return this.#moveFailure("palette move dispatch resources are unavailable");
    }
    const slice = this.#acquireDispatchSlice(commandBytes, "pixi-glyphflow-palette-move-commands");
    if (slice === undefined) {
      return this.#moveFailure("palette move command allocation failed");
    }
    const lease = this.#leaseDispatchSlice(slice);
    if (lease === undefined) {
      return this.#moveFailure("palette move command buffers are unavailable");
    }
    const { commands, uniform } = lease;
    const fused = resident !== undefined;
    let layout = this.#bindGroupLayout;
    let pipeline = move.mode === "dense" ? this.#densePipeline : this.#pipeline;
    let mode: PaletteMoveDispatchMode = "palette-only";
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: commands } },
      { binding: 2, resource: { buffer: transforms } },
    ];
    if (fused) {
      if (
        this.#localBounds === undefined ||
        this.#localBoundsCount === 0 ||
        this.#fusedBindGroupLayout === undefined
      ) {
        lease.release();
        return this.#moveFailure("fused resident move patch lacks local-bounds resources");
      }
      layout = this.#fusedBindGroupLayout;
      pipeline = move.mode === "dense" ? this.#denseFusedPipeline : this.#fusedPipeline;
      entries.push(
        { binding: 3, resource: { buffer: resident.buffer } },
        { binding: 4, resource: { buffer: this.#localBounds } },
      );
      mode = "fused-resident";
    }
    if (layout === undefined || pipeline === undefined) {
      lease.release();
      return this.#moveFailure("palette move pipeline is unavailable");
    }
    let acceptedBytes = 0;
    let acceptedWrites = 0;
    try {
      device.queue.writeBuffer(commands, 0, move.commands, 0, commandBytes);
      acceptedBytes += commandBytes;
      acceptedWrites += 1;
      this.#uniformInts[0] = move.mode === "dense" ? move.baseSlot : 0;
      this.#uniformInts[1] = move.count;
      this.#uniformInts[2] = resident?.recordCount ?? 0;
      this.#uniformInts[3] = fused ? this.#localBoundsCount : 0;
      device.queue.writeBuffer(uniform, 0, this.#uniformScratch);
      acceptedBytes += PALETTE_MOVE_UNIFORM_BYTES;
      acceptedWrites += 1;
      const bindGroup = device.createBindGroup({
        label: `pixi-glyphflow-${mode}-move-bind-group`,
        layout,
        entries,
      });
      const result = Object.freeze({
        ok: true,
        mode,
        uploadBytes: acceptedBytes,
        uploadWrites: acceptedWrites,
        cullRecordUploadBytes: 0 as const,
        patchedCullRecords: fused ? move.count : 0,
      });
      const encode = (
        encoder: GPUCommandEncoder,
        timestampWrites?: GPUComputePassTimestampWrites,
      ): void => {
        const pass = encoder.beginComputePass(
          timestampWrites === undefined ? undefined : { timestampWrites },
        );
        pass.setBindGroup(0, bindGroup);
        pass.setPipeline(pipeline);
        pass.dispatchWorkgroups(groups);
        pass.end();
      };
      const queued = this.#submitDispatchLease(device, lease, {
        encoderLabel: `pixi-glyphflow-${mode}-move-patch`,
        encode,
        onAbort: () => {
          this.#moveFailure(
            "palette move frame transaction aborted",
            acceptedBytes,
            acceptedWrites,
          );
        },
        onFailure: (error) => {
          this.#moveFailure(
            diagnosticMessage("palette move dispatch failed", error),
            acceptedBytes,
            acceptedWrites,
          );
        },
      });
      if (!queued) {
        return this.#moveFailure(
          "palette move frame transaction is unavailable",
          acceptedBytes,
          acceptedWrites,
        );
      }
      this.#lastMoveDispatch = result;
      this.#failureReason = undefined;
      return result;
    } catch (error: unknown) {
      lease.release();
      return this.#moveFailure(
        diagnosticMessage("palette move dispatch failed", error),
        acceptedBytes,
        acceptedWrites,
      );
    }
  }

  /** Scatter complete active core/effect rows through one packed upload and compute dispatch. */
  dispatchTransforms(
    data: Float32Array,
    slots: Uint32Array,
    count: number,
    effectBase: number,
    originX?: Float32Array,
    originY?: Float32Array,
  ): number {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    const layout = this.#bindGroupLayout;
    const pipeline = this.#transformPipeline;
    const transforms = this.#transforms;
    const maximumBytes = count * PALETTE_TRANSFORM_COMMAND_STRIDE;
    if (
      device === undefined ||
      layout === undefined ||
      pipeline === undefined ||
      transforms === undefined ||
      maximumBytes <= 0
    ) {
      return 0;
    }
    this.#ensureTransformScratch(maximumBytes);
    const packed = packPaletteTransforms(
      this.#transformScratch,
      data,
      slots,
      count,
      effectBase,
      originX,
      originY,
    );
    if (packed <= 0) return 0;
    const commandBytes = packed * PALETTE_TRANSFORM_COMMAND_STRIDE;
    const slice = this.#acquireDispatchSlice(
      commandBytes,
      "pixi-glyphflow-palette-transform-commands",
    );
    if (slice === undefined) {
      return 0;
    }
    const lease = this.#leaseDispatchSlice(slice);
    if (lease === undefined) return 0;
    const { commands, uniform } = lease;
    try {
      device.queue.writeBuffer(commands, 0, this.#transformScratch, 0, commandBytes);
      this.#uniformInts[0] = packed;
      this.#uniformInts[1] = effectBase;
      device.queue.writeBuffer(uniform, 0, this.#uniformScratch);
      const bindGroup = device.createBindGroup({
        label: "pixi-glyphflow-palette-transform-scatter-bind-group",
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: commands } },
          { binding: 2, resource: { buffer: transforms } },
        ],
      });
      const groups = Math.max(1, Math.ceil(packed / PALETTE_PATCH_WORKGROUP));
      const encode: PaletteDispatchEncode = (encoder, timestampWrites): void => {
        const pass = encoder.beginComputePass(
          timestampWrites === undefined ? undefined : { timestampWrites },
        );
        pass.setBindGroup(0, bindGroup);
        pass.setPipeline(pipeline);
        pass.dispatchWorkgroups(groups);
        pass.end();
      };
      const queued = this.#submitDispatchLease(device, lease, {
        encoderLabel: "pixi-glyphflow-palette-transform-scatter",
        encode,
        onAbort: () => {
          this.#failureReason = "palette transform frame transaction aborted";
        },
        onFailure: (error) => {
          this.#failureReason = diagnosticMessage("palette transform dispatch failed", error);
        },
      });
      return queued ? paletteTransformDispatchBytes(packed) : 0;
    } catch (error: unknown) {
      lease.release();
      this.#failureReason = diagnosticMessage("palette transform dispatch failed", error);
      return 0;
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    const transaction = this.#frameTransaction;
    const slices = this.#dispatchSlices.map((slice) => ({
      commands: slice.commands,
      uniform: slice.uniform,
    }));
    for (const slice of this.#dispatchSlices) {
      slice.commands = undefined;
      slice.uniform = undefined;
      slice.busy = false;
    }
    this.#dispatchSlices.length = 0;
    const localBounds = this.#localBounds;
    const transformBuffer = this.#transformBuffer;
    this.#transforms = undefined;
    this.#transformBuffer = undefined;
    this.#pipeline = undefined;
    this.#fusedPipeline = undefined;
    this.#densePipeline = undefined;
    this.#denseFusedPipeline = undefined;
    this.#transformPipeline = undefined;
    this.#bindGroupLayout = undefined;
    this.#fusedBindGroupLayout = undefined;
    this.#ready = false;
    this.#device = undefined;
    this.#failedDevice = undefined;
    this.#deviceEpoch += 1;
    this.#residentRecords = undefined;
    this.#localBounds = undefined;
    this.#localBoundsBytes = 0;
    this.#localBoundsCount = 0;
    this.#requiresFullSync = false;
    this.#transformScratch = new ArrayBuffer(0);
    this.#destroyed = true;
    cleanupBestEffortOrThrow([
      () => {
        if (transaction !== undefined) transaction.cancelEpoch(transaction.currentEpoch);
      },
      ...slices.flatMap((slice) => [
        () => slice.commands?.destroy(),
        () => slice.uniform?.destroy(),
      ]),
      () => localBounds?.destroy(),
      () => transformBuffer?.destroy(),
    ]);
  }

  #acquireDispatchSlice(commandBytes: number, label: string): PaletteDispatchSlice | undefined {
    let reusable: PaletteDispatchSlice | undefined;
    let growable: PaletteDispatchSlice | undefined;
    for (const candidate of this.#dispatchSlices) {
      if (candidate.busy) continue;
      if (
        growable === undefined ||
        candidate.commandCapacityBytes > growable.commandCapacityBytes
      ) {
        growable = candidate;
      }
      if (
        candidate.commandCapacityBytes >= commandBytes &&
        (reusable === undefined || candidate.commandCapacityBytes < reusable.commandCapacityBytes)
      ) {
        reusable = candidate;
      }
    }
    let slice = reusable ?? growable;
    if (slice === undefined) {
      slice = {
        commands: undefined,
        uniform: undefined,
        commandCapacityBytes: 0,
        busy: false,
      };
      this.#dispatchSlices.push(slice);
    }
    slice.busy = true;
    if (!this.#ensureCommandBuffers(slice, commandBytes, label)) {
      slice.busy = false;
      return undefined;
    }
    return slice;
  }

  #leaseDispatchSlice(slice: PaletteDispatchSlice): Readonly<PaletteDispatchLease> | undefined {
    const commands = slice.commands;
    const uniform = slice.uniform;
    if (commands === undefined || uniform === undefined) {
      this.#releaseDispatchSlice(slice);
      return undefined;
    }
    let released = false;
    return {
      commands,
      uniform,
      release: () => {
        if (released) return;
        released = true;
        this.#releaseDispatchSlice(slice);
      },
    };
  }

  #submitDispatchLease(
    device: GPUDevice,
    lease: Readonly<PaletteDispatchLease>,
    lifecycle: Readonly<PaletteDispatchLifecycle>,
  ): boolean {
    const transaction = this.#frameTransaction;
    if (transaction !== undefined) {
      const deviceEpoch = this.#deviceEpoch;
      const isCurrentDeviceEpoch = (): boolean =>
        this.#ready && this.#device === device && this.#deviceEpoch === deviceEpoch;
      const queued = transaction.queue("palette", transaction.currentEpoch, {
        encode: lifecycle.encode,
        complete: lease.release,
        cancel: (reason) => {
          lease.release();
          if (reason === "failed" && isCurrentDeviceEpoch()) {
            this.#requiresFullSync = true;
            lifecycle.onAbort();
          }
        },
        fail: (error) => {
          lease.release();
          if (!isCurrentDeviceEpoch()) return;
          this.#requiresFullSync = true;
          lifecycle.onFailure(error);
        },
      });
      if (!queued) lease.release();
      return queued;
    }
    const encoder = device.createCommandEncoder({ label: lifecycle.encoderLabel });
    lifecycle.encode(encoder);
    device.queue.submit([encoder.finish()]);
    lease.release();
    return true;
  }

  #ensureCommandBuffers(slice: PaletteDispatchSlice, commandBytes: number, label: string): boolean {
    const device = this.#device;
    if (device === undefined) return false;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const allocatedBytes = planComputeCullStorageBytes(
      Math.max(PALETTE_DENSE_MOVE_STRIDE, commandBytes),
      limit,
    );
    if (allocatedBytes === undefined) return false;
    const replaceCommands =
      allocatedBytes > slice.commandCapacityBytes || slice.commands === undefined;
    let commands: GPUBuffer | undefined;
    let uniform: GPUBuffer | undefined;
    const candidates: GPUBuffer[] = [];
    try {
      if (replaceCommands) {
        commands = createBuffer(device, allocatedBytes, label);
        candidates.push(commands);
      }
      if (slice.uniform === undefined) {
        uniform = createBuffer(
          device,
          PALETTE_MOVE_UNIFORM_BYTES,
          "pixi-glyphflow-palette-move-uniforms",
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        );
        candidates.push(uniform);
      }
    } catch (error: unknown) {
      cleanupBestEffort(candidates.map((candidate) => () => candidate.destroy()));
      this.#failureReason = diagnosticMessage("palette command allocation failed", error);
      return false;
    }
    const retired: GPUBuffer[] = [];
    if (commands !== undefined) {
      const previous = slice.commands;
      slice.commands = commands;
      slice.commandCapacityBytes = allocatedBytes;
      if (previous !== undefined) retired.push(previous);
    }
    if (uniform !== undefined) slice.uniform = uniform;
    cleanupBestEffort(retired.map((buffer) => () => buffer.destroy()));
    return true;
  }

  #releaseDispatchSlice(slice: PaletteDispatchSlice): void {
    slice.busy = false;
    this.#trimIdleDispatchSlices();
  }

  #ensureTransformScratch(bytes: number): void {
    if (this.#transformScratch.byteLength >= bytes) return;
    let capacity = Math.max(
      PALETTE_TRANSFORM_COMMAND_STRIDE,
      this.#transformScratch.byteLength * 2,
    );
    while (capacity < bytes) capacity *= 2;
    this.#transformScratch = new ArrayBuffer(capacity);
  }

  #moveFailure(
    reason: string,
    uploadBytes = 0,
    uploadWrites = 0,
  ): Readonly<PaletteMoveDispatchResult> {
    const result = Object.freeze({
      ok: false,
      mode: "unavailable" as const,
      uploadBytes,
      uploadWrites,
      cullRecordUploadBytes: 0 as const,
      patchedCullRecords: 0,
      reason,
    });
    this.#lastMoveDispatch = result;
    this.#failureReason = reason;
    return result;
  }

  #trimIdleDispatchSlices(): void {
    const idle = this.#dispatchSlices
      .filter((slice) => !slice.busy)
      .sort((left, right) => right.commandCapacityBytes - left.commandCapacityBytes);
    for (let index = MAX_IDLE_DISPATCH_SLICES; index < idle.length; index += 1) {
      const slice = idle[index];
      if (slice !== undefined) this.#retireDispatchSlice(slice);
    }
  }

  #retireDispatchSlice(slice: PaletteDispatchSlice): void {
    const index = this.#dispatchSlices.indexOf(slice);
    if (index >= 0) this.#dispatchSlices.splice(index, 1);
    const commands = slice.commands;
    const uniform = slice.uniform;
    slice.commands = undefined;
    slice.uniform = undefined;
    slice.commandCapacityBytes = 0;
    slice.busy = false;
    cleanupBestEffort([() => commands?.destroy(), () => uniform?.destroy()]);
  }

  #watchDeviceLoss(device: GPUDevice, epoch: number): void {
    const lost = device.lost;
    if (lost === undefined || typeof lost.then !== "function") return;
    void lost.then(
      (info) => {
        if (this.#destroyed || this.#device !== device || this.#deviceEpoch !== epoch) return;
        const message = info.message.length > 0 ? `: ${info.message}` : "";
        this.#retireDeviceEpoch(`palette storage WebGPU device was lost${message}`, device);
      },
      (error: unknown) => {
        if (this.#destroyed || this.#device !== device || this.#deviceEpoch !== epoch) return;
        this.#retireDeviceEpoch(
          diagnosticMessage("palette storage device loss failed", error),
          device,
        );
      },
    );
  }

  #synchronizeRendererIdentity(): void {
    if (this.#destroyed) return;
    const device = this.#renderer.gpu?.device;
    if (this.#device !== undefined && this.#device !== device) {
      this.#retireDeviceEpoch("palette storage WebGPU device was replaced", this.#device);
    }
  }

  #retireDeviceEpoch(reason: string, failedDevice: GPUDevice): void {
    const transaction = this.#frameTransaction;
    let transactionEpoch: number | undefined;
    try {
      transactionEpoch = transaction?.currentEpoch;
    } catch {
      transactionEpoch = undefined;
    }
    const slices = this.#dispatchSlices.splice(0).map((slice) => {
      const resources = { commands: slice.commands, uniform: slice.uniform };
      slice.commands = undefined;
      slice.uniform = undefined;
      slice.commandCapacityBytes = 0;
      slice.busy = false;
      return resources;
    });
    const localBounds = this.#localBounds;
    const transformBuffer = this.#transformBuffer;
    let replacementTransformBuffer: Buffer | undefined;
    try {
      replacementTransformBuffer = createPaletteBuffer(16);
      this.#rebindTransformsBeforeRetire(replacementTransformBuffer);
    } catch {
      cleanupBestEffort([() => replacementTransformBuffer?.destroy()]);
      replacementTransformBuffer = undefined;
    }
    this.#device = undefined;
    this.#deviceEpoch += 1;
    this.#failedDevice = failedDevice;
    this.#pipeline = undefined;
    this.#fusedPipeline = undefined;
    this.#densePipeline = undefined;
    this.#denseFusedPipeline = undefined;
    this.#transformPipeline = undefined;
    this.#bindGroupLayout = undefined;
    this.#fusedBindGroupLayout = undefined;
    this.#transforms = undefined;
    this.#transformBuffer = replacementTransformBuffer;
    this.#transformBytes = 0;
    this.#residentRecords = undefined;
    this.#localBounds = undefined;
    this.#localBoundsBytes = 0;
    this.#localBoundsCount = 0;
    this.#ready = false;
    this.#requiresFullSync = true;
    this.#failureReason = reason;
    cleanupBestEffort([
      () => {
        if (transaction !== undefined && transactionEpoch !== undefined) {
          transaction.cancelEpoch(transactionEpoch);
        }
      },
      ...slices.flatMap((slice) => [
        () => slice.commands?.destroy(),
        () => slice.uniform?.destroy(),
      ]),
      () => localBounds?.destroy(),
      () => transformBuffer?.destroy(),
    ]);
  }

  #localBoundsFailure(reason: string): Readonly<ResidentLocalBoundsUploadResult> {
    this.#failureReason = reason;
    return Object.freeze({
      ok: false,
      replaced: false,
      uploadedBytes: 0,
      epoch: this.#localBoundsEpoch,
      reason,
    });
  }
}

function diagnosticMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : `${prefix}: ${String(error)}`;
}

function createPaletteBuffer(size: number): Buffer {
  return new Buffer({
    size,
    usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    label: "pixi-glyphflow-palette-storage",
    shrinkToFit: false,
  });
}

function createBuffer(
  device: GPUDevice,
  size: number,
  label: string,
  usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
): GPUBuffer {
  return device.createBuffer({
    size: Math.max(Uint32Array.BYTES_PER_ELEMENT, size),
    usage,
    label,
  });
}
