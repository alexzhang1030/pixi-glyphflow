import { Buffer, BufferUsage, type Geometry, type Shader, type WebGPURenderer } from "pixi.js";

import {
  CULL_RECORD_STRIDE,
  CULL_WORKGROUP,
  type CullRecordDirty,
  type CullViewport,
  createIndirectArgs,
  planComputeCullDispatch,
  planComputeCullStorageBytes,
} from "../culling/computeCull";
import { COMPUTE_CULL_WGSL } from "../culling/computeCull.wgsl";
import { cleanupBestEffort, cleanupBestEffortOrThrow } from "./cleanup";
import type { WebGPUFrameTransaction } from "./WebGPUFrameTransaction";

const UNIFORM_BYTES = 32;
const INDIRECT_INSTANCE_COUNT_OFFSET = Uint32Array.BYTES_PER_ELEMENT;
const INDIRECT_INSTANCE_COUNT_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const DRAW_INSTANCE_UINTS = 2;
const DRAW_INSTANCE_BYTES = DRAW_INSTANCE_UINTS * Uint32Array.BYTES_PER_ELEMENT;
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_MAP_MODE_READ = 0x0001;
const REQUIRED_COMPUTE_STORAGE_BUFFERS = 8;

export interface ComputeCullSubmittedGlyphsDiagnostic {
  readonly submittedGlyphs: number;
  readonly submittedGlyphsHash: number;
}

/** Hash the ordered `prototypeIndex, paletteIndex` words consumed by the indirect draw. */
export function hashComputeCullDrawInstances(words: Uint32Array, instanceCount: number): number {
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0) {
    throw new RangeError("compute-cull diagnostic instance count must be a non-negative integer");
  }
  const wordCount = instanceCount * DRAW_INSTANCE_UINTS;
  if (wordCount > words.length) {
    throw new RangeError("compute-cull diagnostic instance count exceeds the compacted output");
  }
  let hash = 0x811c_9dc5;
  for (let index = 0; index < wordCount; index += 1) {
    hash = Math.imul(hash ^ (words[index] ?? 0), 0x0100_0193) >>> 0;
  }
  return hash;
}

export interface ComputeCullResidentRecords {
  readonly buffer: GPUBuffer;
  readonly epoch: number;
  readonly byteLength: number;
  readonly recordCount: number;
}

export type ComputeCullResidentRecordsResult =
  | ({ readonly ok: true } & Readonly<ComputeCullResidentRecords>)
  | { readonly ok: false; readonly reason: string };

export type ComputeCullInitializationFailureKind = "device-fatal" | "hook-transient";

type EncoderDraw = WebGPURenderer["encoder"]["draw"];
type EncoderDrawOptions = Parameters<EncoderDraw>[0];

interface EncoderHookState {
  readonly passes: Set<ComputeCullPass>;
  readonly encoder: WebGPURenderer["encoder"];
  readonly snapshot: EncoderDrawHookSnapshot;
  readonly hook: EncoderDraw;
  installedOwnDescriptor: PropertyDescriptor | undefined;
  external: EncoderDraw | undefined;
  managed: boolean;
  status: "installing" | "active" | "retired" | "restored";
}

interface EncoderDrawHookSnapshot {
  readonly original: EncoderDraw;
  readonly ownDescriptor: PropertyDescriptor | undefined;
}

interface ShaderBindEncoder {
  _setShaderBindGroups(shader: Shader, skipSync?: boolean): void;
}

const encoderHooks = new WeakMap<WebGPURenderer, EncoderHookState>();

export class ComputeCullPass {
  readonly #renderer: WebGPURenderer;
  readonly #frameTransaction: WebGPUFrameTransaction | undefined;
  readonly #geometries = new Set<Geometry>();
  #device: GPUDevice | undefined;
  #deviceEpoch = 0;
  #failedDevice: GPUDevice | undefined;
  #encoder: WebGPURenderer["encoder"] | undefined;
  #pipelineMark: GPUComputePipeline | undefined;
  #pipelineScan: GPUComputePipeline | undefined;
  #pipelineScanGroups: GPUComputePipeline | undefined;
  #pipelineScanGroupBlocks: GPUComputePipeline | undefined;
  #pipelineAddGroupOffsets: GPUComputePipeline | undefined;
  #pipelineScatter: GPUComputePipeline | undefined;
  #bindGroupLayout: GPUBindGroupLayout | undefined;
  #records: GPUBuffer | undefined;
  #counts: GPUBuffer | undefined;
  #prefix: GPUBuffer | undefined;
  #groupSums: GPUBuffer | undefined;
  #groupBlockSums: GPUBuffer | undefined;
  #instancesOut: GPUBuffer | undefined;
  #uniform: GPUBuffer | undefined;
  #indirectBuffer: Buffer | undefined;
  #labelCapacity = 0;
  #recordBytes = 0;
  #recordsEpoch = 0;
  #drawBytes = 0;
  #recordCount = 0;
  #bindGroup: GPUBindGroup | undefined;
  #recordsSynced = false;
  #requiresFullSync = false;
  #boundTransforms: GPUBuffer | undefined;
  readonly #uniformScratch = new ArrayBuffer(UNIFORM_BYTES);
  readonly #uniformFloats = new Float32Array(this.#uniformScratch);
  readonly #uniformInts = new Uint32Array(this.#uniformScratch);
  #ready = false;
  #failureReason: string | undefined;
  #initializationFailureKind: ComputeCullInitializationFailureKind | undefined;
  #lastRecordUploadBytes = 0;
  #recordUploadBytes = 0;
  #recordWrites = 0;
  #destroyed = false;

  constructor(renderer: WebGPURenderer, frameTransaction?: WebGPUFrameTransaction) {
    this.#renderer = renderer;
    this.#frameTransaction = frameTransaction;
    this.#indirectBuffer = createCullIndirectBuffer();
  }

  get indirectBuffer(): Buffer {
    const buffer = this.#indirectBuffer;
    if (buffer === undefined) throw new Error("compute-cull pass is destroyed");
    return buffer;
  }

  get ready(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#ready;
  }

  get synced(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#recordsSynced;
  }

  get requiresFullSync(): boolean {
    this.#synchronizeRendererIdentity();
    return this.#requiresFullSync;
  }

  get failureReason(): string | undefined {
    return this.#failureReason;
  }

  get initializationFailureKind(): ComputeCullInitializationFailureKind | undefined {
    return this.#initializationFailureKind;
  }

  get lastRecordUploadBytes(): number {
    return this.#lastRecordUploadBytes;
  }

  get recordUploadBytes(): number {
    return this.#recordUploadBytes;
  }

  get recordWrites(): number {
    return this.#recordWrites;
  }

  trackGeometry(geometry: Geometry): void {
    this.#geometries.add(geometry);
  }

  untrackGeometry(geometry: Geometry): void {
    this.#geometries.delete(geometry);
  }

  initialize(): boolean {
    if (this.#destroyed) return false;
    const device = this.#renderer.gpu?.device;
    if (this.#device !== undefined && this.#device !== device) {
      this.#retireDeviceEpoch("compute-cull WebGPU device was replaced", this.#device);
    }
    if (this.#ready && this.#device === device) {
      return this.#synchronizeEncoderIdentity();
    }
    if (device === undefined) {
      this.#failureReason = "compute-cull WebGPU device is unavailable";
      this.#initializationFailureKind = "device-fatal";
      return false;
    }
    if (this.#failedDevice === device) return false;
    const capabilityFailure = computeCullCapabilityFailure(device.limits);
    if (capabilityFailure !== undefined) {
      this.#failedDevice = device;
      this.#failureReason = capabilityFailure;
      this.#initializationFailureKind = "device-fatal";
      return false;
    }
    const indirectBuffer = this.#indirectBuffer ?? createCullIndirectBuffer();
    const createdIndirect = this.#indirectBuffer === undefined;
    let installingHook = false;
    try {
      const module = device.createShaderModule({
        label: "pixi-glyphflow-compute-cull",
        code: COMPUTE_CULL_WGSL,
      });
      const bindGroupLayout = device.createBindGroupLayout({
        label: "pixi-glyphflow-compute-cull-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
      const pipelineMark = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "mark_visible" },
      });
      const pipelineScan = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scan_counts" },
      });
      const pipelineScanGroups = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scan_group_sums" },
      });
      const pipelineScanGroupBlocks = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scan_group_blocks" },
      });
      const pipelineAddGroupOffsets = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "add_group_offsets" },
      });
      const pipelineScatter = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scatter" },
      });
      installingHook = true;
      installEncoderHook(this.#renderer, this);
      this.#pipelineMark = pipelineMark;
      this.#pipelineScan = pipelineScan;
      this.#pipelineScanGroups = pipelineScanGroups;
      this.#pipelineScanGroupBlocks = pipelineScanGroupBlocks;
      this.#pipelineAddGroupOffsets = pipelineAddGroupOffsets;
      this.#pipelineScatter = pipelineScatter;
      this.#bindGroupLayout = bindGroupLayout;
      this.#indirectBuffer = indirectBuffer;
      this.#device = device;
      this.#deviceEpoch += 1;
      this.#failedDevice = undefined;
      this.#encoder = this.#renderer.encoder;
      this.#ready = true;
      this.#failureReason = undefined;
      this.#initializationFailureKind = undefined;
      this.#watchDeviceLoss(device, this.#deviceEpoch);
      return true;
    } catch (error: unknown) {
      if (createdIndirect) cleanupBestEffort([() => indirectBuffer.destroy()]);
      if (!installingHook) this.#failedDevice = device;
      this.#ready = false;
      this.#failureReason = diagnosticMessage("compute-cull initialization failed", error);
      this.#initializationFailureKind = installingHook ? "hook-transient" : "device-fatal";
      return false;
    }
  }

  ensureCapacity(labelCount: number, drawInstanceBytes: number): boolean {
    this.#synchronizeRendererIdentity();
    const capacity = this.#planCapacity(labelCount, drawInstanceBytes);
    const device = this.#device;
    if (capacity === undefined || device === undefined) return false;
    const { recordBytes, drawBytes: bytes } = capacity;
    const labels = recordBytes / CULL_RECORD_STRIDE;
    const growLabels = labels > this.#labelCapacity;
    const growDraw = bytes > this.#drawBytes;
    if ((growLabels || growDraw) && this.#frameTransaction !== undefined) {
      const flushed = this.#frameTransaction.flush();
      if (!flushed.ok) {
        this.#failureReason = `compute-cull capacity flush failed: ${flushed.reason ?? "unknown error"}`;
        return false;
      }
    }
    const candidates: GPUBuffer[] = [];
    let recordBuffers:
      | {
          readonly records: GPUBuffer;
          readonly counts: GPUBuffer;
          readonly prefix: GPUBuffer;
          readonly groupSums: GPUBuffer;
          readonly groupBlockSums: GPUBuffer;
        }
      | undefined;
    let instancesOut: GPUBuffer | undefined;
    let uniform: GPUBuffer | undefined;
    try {
      if (growLabels) {
        const records = createBuffer(
          device,
          recordBytes,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          "pixi-glyphflow-cull-records",
        );
        candidates.push(records);
        const counts = createBuffer(
          device,
          labels * Uint32Array.BYTES_PER_ELEMENT,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          "pixi-glyphflow-cull-counts",
        );
        candidates.push(counts);
        const prefix = createBuffer(
          device,
          labels * Uint32Array.BYTES_PER_ELEMENT,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          "pixi-glyphflow-cull-prefix",
        );
        candidates.push(prefix);
        const groupSums = createBuffer(
          device,
          Math.ceil(labels / CULL_WORKGROUP) * Uint32Array.BYTES_PER_ELEMENT,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          "pixi-glyphflow-cull-group-sums",
        );
        candidates.push(groupSums);
        const groupBlockSums = createBuffer(
          device,
          Math.max(
            Uint32Array.BYTES_PER_ELEMENT,
            Math.ceil(Math.ceil(labels / CULL_WORKGROUP) / CULL_WORKGROUP) *
              Uint32Array.BYTES_PER_ELEMENT,
          ),
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          "pixi-glyphflow-cull-group-block-sums",
        );
        candidates.push(groupBlockSums);
        recordBuffers = { records, counts, prefix, groupSums, groupBlockSums };
      }
      if (growDraw) {
        instancesOut = createBuffer(
          device,
          bytes,
          GPUBufferUsage.STORAGE |
            GPUBufferUsage.COPY_SRC |
            GPUBufferUsage.COPY_DST |
            GPUBufferUsage.VERTEX,
          "pixi-glyphflow-cull-instances-out",
        );
        candidates.push(instancesOut);
      }
      if (this.#uniform === undefined) {
        uniform = createBuffer(
          device,
          UNIFORM_BYTES,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          "pixi-glyphflow-cull-uniforms",
        );
        candidates.push(uniform);
      }
      this.#renderer.buffer.updateBuffer(this.indirectBuffer);
    } catch (error: unknown) {
      cleanupBestEffort(candidates.map((candidate) => () => candidate.destroy()));
      this.#failureReason = diagnosticMessage("compute-cull capacity allocation failed", error);
      return false;
    }
    const retired: GPUBuffer[] = [];
    if (recordBuffers !== undefined) {
      const previous = [
        this.#records,
        this.#counts,
        this.#prefix,
        this.#groupSums,
        this.#groupBlockSums,
      ];
      this.#records = recordBuffers.records;
      this.#counts = recordBuffers.counts;
      this.#prefix = recordBuffers.prefix;
      this.#groupSums = recordBuffers.groupSums;
      this.#groupBlockSums = recordBuffers.groupBlockSums;
      this.#labelCapacity = labels;
      this.#recordBytes = recordBytes;
      this.#recordsEpoch += 1;
      this.#recordsSynced = false;
      this.#bindGroup = undefined;
      for (const buffer of previous) {
        if (buffer !== undefined) retired.push(buffer);
      }
    }
    if (instancesOut !== undefined) {
      const previous = this.#instancesOut;
      this.#instancesOut = instancesOut;
      this.#drawBytes = bytes;
      this.#bindGroup = undefined;
      if (previous !== undefined) retired.push(previous);
    }
    if (uniform !== undefined) this.#uniform = uniform;
    cleanupBestEffort(retired.map((buffer) => () => buffer.destroy()));
    this.#failureReason = undefined;
    return true;
  }

  /** Pure capacity gate used before resident raster, atlas, and CPU record allocation. */
  canFitCapacity(labelCount: number, drawInstanceBytes: number): boolean {
    this.#synchronizeRendererIdentity();
    return this.#planCapacity(labelCount, drawInstanceBytes) !== undefined;
  }

  #planCapacity(labelCount: number, drawInstanceBytes: number) {
    const device = this.#device;
    if (device === undefined || !this.#ready) {
      this.#failureReason ??= "compute-cull pass is unavailable";
      return undefined;
    }
    let dispatchPlan;
    try {
      dispatchPlan = planComputeCullDispatch(labelCount);
    } catch (error: unknown) {
      this.#failureReason = diagnosticMessage("compute-cull capacity planning failed", error);
      return undefined;
    }
    if (dispatchPlan.dispatchRecordGroups > device.limits.maxComputeWorkgroupsPerDimension) {
      this.#failureReason = `compute-cull requires ${String(dispatchPlan.dispatchRecordGroups)} workgroups; the device limit is ${String(device.limits.maxComputeWorkgroupsPerDimension)}`;
      return undefined;
    }
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const recordBytes = planComputeCullStorageBytes(
      Math.max(CULL_WORKGROUP, labelCount) * CULL_RECORD_STRIDE,
      limit,
    );
    const drawBytes = planComputeCullStorageBytes(Math.max(8, drawInstanceBytes), limit);
    if (recordBytes === undefined || drawBytes === undefined) {
      this.#failureReason = `compute-cull storage exceeds the ${String(limit)}-byte device binding limit`;
      return undefined;
    }
    return { recordBytes, drawBytes };
  }

  /** `records` must always be the complete packed buffer so a resync can upload it whole. */
  uploadRecords(records: ArrayBuffer, recordCount: number, dirty: CullRecordDirty): boolean {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    this.#recordCount = recordCount;
    this.#lastRecordUploadBytes = 0;
    if (device === undefined || this.#records === undefined || recordCount === 0) return false;
    if (recordCount * CULL_RECORD_STRIDE > this.#recordBytes) {
      this.#failureReason = "compute-cull record upload exceeds the resident buffer";
      return false;
    }
    if (!this.#recordsSynced || dirty === "all") {
      const bytes = recordCount * CULL_RECORD_STRIDE;
      try {
        device.queue.writeBuffer(this.#records, 0, records, 0, bytes);
      } catch (error: unknown) {
        this.#recordsSynced = false;
        this.#requiresFullSync = true;
        this.#failureReason = diagnosticMessage("compute-cull record upload failed", error);
        return false;
      }
      this.#recordsSynced = true;
      this.#recordWrite(bytes);
      return true;
    }
    if (dirty === "none" || dirty.length === 0) return false;
    try {
      for (const range of dirty) {
        device.queue.writeBuffer(this.#records, range.offset, records, range.offset, range.length);
        this.#recordWrite(range.length);
      }
    } catch (error: unknown) {
      this.#recordsSynced = false;
      this.#requiresFullSync = true;
      this.#failureReason = diagnosticMessage("compute-cull record upload failed", error);
      return false;
    }
    return true;
  }

  getResidentRecords(): Readonly<ComputeCullResidentRecordsResult> {
    this.#synchronizeRendererIdentity();
    const buffer = this.#records;
    if (!this.#ready || buffer === undefined) {
      return Object.freeze({
        ok: false,
        reason: this.#failureReason ?? "compute-cull resident records are unavailable",
      });
    }
    return Object.freeze({
      ok: true,
      buffer,
      epoch: this.#recordsEpoch,
      byteLength: this.#recordBytes,
      recordCount: this.#recordCount,
    });
  }

  /** The GPU mirrors go stale while another cull path runs; force full uploads on re-entry. */
  invalidateSync(): void {
    this.#recordsSynced = false;
  }

  dispatch(
    viewport: CullViewport,
    options: { readonly transforms?: GPUBuffer; readonly useGpuOrigin?: boolean } = {},
  ): boolean {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    const layout = this.#bindGroupLayout;
    const useGpuOrigin = options.useGpuOrigin === true;
    const transforms = useGpuOrigin ? options.transforms : this.#records;
    if (
      !this.#ready ||
      device === undefined ||
      layout === undefined ||
      this.#pipelineMark === undefined ||
      this.#pipelineScan === undefined ||
      this.#pipelineScanGroups === undefined ||
      this.#pipelineScanGroupBlocks === undefined ||
      this.#pipelineAddGroupOffsets === undefined ||
      this.#pipelineScatter === undefined ||
      !this.#recordsSynced ||
      this.#records === undefined ||
      this.#counts === undefined ||
      this.#prefix === undefined ||
      this.#groupSums === undefined ||
      this.#groupBlockSums === undefined ||
      this.#instancesOut === undefined ||
      this.#uniform === undefined ||
      transforms === undefined
    ) {
      this.#requiresFullSync = true;
      this.#recordsSynced = false;
      this.#failureReason ??= "compute-cull dispatch resources are unavailable";
      return false;
    }
    let dispatchPlan;
    try {
      dispatchPlan = planComputeCullDispatch(this.#recordCount);
    } catch (error: unknown) {
      this.#failDispatch(error, "compute-cull dispatch planning failed");
      return false;
    }
    try {
      const indirect = this.#renderer.buffer.getGPUBuffer(this.indirectBuffer);
      const floats = this.#uniformFloats;
      floats[0] = viewport.x;
      floats[1] = viewport.y;
      floats[2] = viewport.width;
      floats[3] = viewport.height;
      floats[4] = viewport.padding;
      this.#uniformInts[5] = this.#recordCount;
      this.#uniformInts[6] = Number(useGpuOrigin);
      this.#uniformInts[7] = dispatchPlan.recordGroups;
      device.queue.writeBuffer(this.#uniform, 0, this.#uniformScratch);
      if (this.#boundTransforms !== transforms) {
        this.#bindGroup = undefined;
        this.#boundTransforms = transforms;
      }
      const bindGroup =
        this.#bindGroup ??
        device.createBindGroup({
          label: "pixi-glyphflow-compute-cull-bind-group",
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.#uniform } },
            { binding: 1, resource: { buffer: this.#records } },
            { binding: 2, resource: { buffer: this.#counts } },
            { binding: 3, resource: { buffer: this.#prefix } },
            { binding: 4, resource: { buffer: this.#groupSums } },
            { binding: 5, resource: { buffer: this.#groupBlockSums } },
            { binding: 6, resource: { buffer: this.#instancesOut } },
            { binding: 7, resource: { buffer: transforms } },
            { binding: 8, resource: { buffer: indirect } },
          ],
        });
      this.#bindGroup = bindGroup;
      const pipelineMark = this.#pipelineMark;
      const pipelineScan = this.#pipelineScan;
      const pipelineScanGroups = this.#pipelineScanGroups;
      const pipelineScanGroupBlocks = this.#pipelineScanGroupBlocks;
      const pipelineAddGroupOffsets = this.#pipelineAddGroupOffsets;
      const pipelineScatter = this.#pipelineScatter;
      const encode = (
        encoder: GPUCommandEncoder,
        timestampWrites?: GPUComputePassTimestampWrites,
      ): void => {
        // WebGPU orders dispatches within one pass, so the pipeline stages need no pass boundaries.
        const pass = encoder.beginComputePass(
          timestampWrites === undefined ? undefined : { timestampWrites },
        );
        pass.setBindGroup(0, bindGroup);
        pass.setPipeline(pipelineMark);
        pass.dispatchWorkgroups(dispatchPlan.dispatchRecordGroups);
        pass.setPipeline(pipelineScan);
        pass.dispatchWorkgroups(dispatchPlan.dispatchRecordGroups);
        pass.setPipeline(pipelineScanGroups);
        pass.dispatchWorkgroups(dispatchPlan.dispatchGroupBlocks);
        pass.setPipeline(pipelineScanGroupBlocks);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(pipelineAddGroupOffsets);
        pass.dispatchWorkgroups(dispatchPlan.dispatchGroupBlocks);
        pass.setPipeline(pipelineScatter);
        pass.dispatchWorkgroups(dispatchPlan.dispatchRecordGroups);
        pass.end();
      };
      const deviceEpoch = this.#deviceEpoch;
      const isCurrentDeviceEpoch = (): boolean =>
        this.#ready && this.#device === device && this.#deviceEpoch === deviceEpoch;
      const transaction = this.#frameTransaction;
      if (transaction !== undefined) {
        let queueFailureRecorded = false;
        const queued = transaction.queue("cull", transaction.currentEpoch, {
          encode,
          complete: () => {
            if (!isCurrentDeviceEpoch()) return;
            this.#requiresFullSync = false;
            this.#failureReason = undefined;
          },
          cancel: (reason) => {
            if (reason !== "failed" || !isCurrentDeviceEpoch()) return;
            this.#requiresFullSync = true;
            this.#failureReason = "compute-cull frame transaction aborted";
            this.#recordsSynced = false;
          },
          fail: (error) => {
            if (!isCurrentDeviceEpoch()) return;
            queueFailureRecorded = true;
            this.#failDispatch(error);
          },
        });
        if (!queued) {
          if (!queueFailureRecorded) {
            this.#failDispatch("compute-cull frame transaction is unavailable");
          }
          return false;
        }
        this.#failureReason = undefined;
        return true;
      }
      const encoder = device.createCommandEncoder({ label: "pixi-glyphflow-compute-cull" });
      encode(encoder);
      device.queue.submit([encoder.finish()]);
      this.#requiresFullSync = false;
      this.#failureReason = undefined;
      return true;
    } catch (error: unknown) {
      this.#failDispatch(error);
      return false;
    }
  }

  /** Explicit diagnostic readback. The render hot path performs no mapping work. */
  async readInstanceCount(): Promise<number | undefined> {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    if (device === undefined || !this.#ready) return undefined;
    const flushed = this.#frameTransaction?.flush();
    if (flushed !== undefined && !flushed.ok) return undefined;
    let mapped = false;
    let readback: GPUBuffer | undefined;
    try {
      readback = device.createBuffer({
        label: "pixi-glyphflow-cull-instance-count-readback",
        size: INDIRECT_INSTANCE_COUNT_BYTES,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      });
      const encoder = device.createCommandEncoder({
        label: "pixi-glyphflow-cull-instance-count-readback",
      });
      encoder.copyBufferToBuffer(
        this.#renderer.buffer.getGPUBuffer(this.indirectBuffer),
        INDIRECT_INSTANCE_COUNT_OFFSET,
        readback,
        0,
        INDIRECT_INSTANCE_COUNT_BYTES,
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPU_MAP_MODE_READ);
      mapped = true;
      return new Uint32Array(readback.getMappedRange(), 0, 1)[0];
    } catch {
      return undefined;
    } finally {
      cleanupReadback(readback, mapped);
    }
  }

  /**
   * Explicit diagnostic readback of the indirect count and the ordered compacted draw instances.
   * One copy submission keeps both values at the same GPU queue point.
   */
  async readSubmittedGlyphsDiagnostic(): Promise<
    Readonly<ComputeCullSubmittedGlyphsDiagnostic> | undefined
  > {
    this.#synchronizeRendererIdentity();
    const device = this.#device;
    const compact = this.#instancesOut;
    if (device === undefined || compact === undefined || !this.#ready || this.#drawBytes === 0) {
      return undefined;
    }
    const flushed = this.#frameTransaction?.flush();
    if (flushed !== undefined && !flushed.ok) return undefined;
    const compactOffset = INDIRECT_INSTANCE_COUNT_BYTES;
    const readbackBytes = compactOffset + this.#drawBytes;
    let mapped = false;
    let readback: GPUBuffer | undefined;
    try {
      readback = device.createBuffer({
        label: "pixi-glyphflow-cull-submitted-glyphs-readback",
        size: readbackBytes,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      });
      const encoder = device.createCommandEncoder({
        label: "pixi-glyphflow-cull-submitted-glyphs-readback",
      });
      encoder.copyBufferToBuffer(
        this.#renderer.buffer.getGPUBuffer(this.indirectBuffer),
        INDIRECT_INSTANCE_COUNT_OFFSET,
        readback,
        0,
        INDIRECT_INSTANCE_COUNT_BYTES,
      );
      encoder.copyBufferToBuffer(compact, 0, readback, compactOffset, this.#drawBytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPU_MAP_MODE_READ);
      mapped = true;
      const words = new Uint32Array(readback.getMappedRange());
      const submittedGlyphs = words[0] ?? 0;
      if (submittedGlyphs > this.#drawBytes / DRAW_INSTANCE_BYTES) return undefined;
      return Object.freeze({
        submittedGlyphs,
        submittedGlyphsHash: hashComputeCullDrawInstances(words.subarray(1), submittedGlyphs),
      });
    } catch {
      return undefined;
    } finally {
      cleanupReadback(readback, mapped);
    }
  }

  tryIndirectDraw(options: EncoderDrawOptions): boolean {
    this.#synchronizeRendererIdentity();
    const compact = this.#instancesOut;
    const encoder = this.#renderer.encoder;
    if (
      !this.#ready ||
      compact === undefined ||
      !this.#geometries.has(options.geometry) ||
      encoder.renderPassEncoder === undefined
    ) {
      return false;
    }
    encoder.setPipelineFromGeometryProgramAndState(
      options.geometry,
      options.shader.gpuProgram,
      options.state,
      options.topology,
    );
    encoder.setGeometry(options.geometry, options.shader.gpuProgram);
    (encoder as unknown as ShaderBindEncoder)._setShaderBindGroups(
      options.shader,
      options.skipSync,
    );
    const names = this.#renderer.pipeline.getBufferNamesToBind(
      options.geometry,
      options.shader.gpuProgram,
    );
    const instanceBuffer = options.geometry.attributes.aProtoIndex?.buffer;
    for (const [slot, attributeName] of Object.entries(names)) {
      const attribute = options.geometry.attributes[attributeName];
      if (instanceBuffer !== undefined && attribute?.buffer === instanceBuffer) {
        encoder.renderPassEncoder.setVertexBuffer(Number(slot), compact);
      }
    }
    encoder.renderPassEncoder.drawIndexedIndirect(
      this.#renderer.buffer.getGPUBuffer(this.indirectBuffer),
      0,
    );
    return true;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#deviceEpoch += 1;
    const transaction = this.#frameTransaction;
    const records = this.#records;
    const counts = this.#counts;
    const prefix = this.#prefix;
    const groupSums = this.#groupSums;
    const groupBlockSums = this.#groupBlockSums;
    const instancesOut = this.#instancesOut;
    const uniform = this.#uniform;
    const indirectBuffer = this.#indirectBuffer;
    this.#records = undefined;
    this.#counts = undefined;
    this.#prefix = undefined;
    this.#groupSums = undefined;
    this.#groupBlockSums = undefined;
    this.#instancesOut = undefined;
    this.#uniform = undefined;
    this.#boundTransforms = undefined;
    this.#indirectBuffer = undefined;
    this.#pipelineMark = undefined;
    this.#pipelineScan = undefined;
    this.#pipelineScanGroups = undefined;
    this.#pipelineScanGroupBlocks = undefined;
    this.#pipelineAddGroupOffsets = undefined;
    this.#pipelineScatter = undefined;
    this.#bindGroupLayout = undefined;
    this.#bindGroup = undefined;
    this.#recordsSynced = false;
    this.#requiresFullSync = false;
    this.#geometries.clear();
    this.#ready = false;
    this.#device = undefined;
    this.#failedDevice = undefined;
    this.#initializationFailureKind = undefined;
    this.#encoder = undefined;
    this.#failureReason = "compute-cull pass is destroyed";
    this.#destroyed = true;
    cleanupBestEffortOrThrow([
      () => {
        if (transaction !== undefined) transaction.cancelEpoch(transaction.currentEpoch);
      },
      () => uninstallEncoderHook(this.#renderer, this),
      () => records?.destroy(),
      () => counts?.destroy(),
      () => prefix?.destroy(),
      () => groupSums?.destroy(),
      () => groupBlockSums?.destroy(),
      () => instancesOut?.destroy(),
      () => uniform?.destroy(),
      () => indirectBuffer?.destroy(),
    ]);
  }

  #synchronizeRendererIdentity(): void {
    if (this.#destroyed) return;
    const device = this.#renderer.gpu?.device;
    if (this.#device !== undefined && this.#device !== device) {
      this.#retireDeviceEpoch("compute-cull WebGPU device was replaced", this.#device);
      return;
    }
    if (this.#ready && this.#device === device) this.#synchronizeEncoderIdentity();
  }

  #synchronizeEncoderIdentity(): boolean {
    try {
      const encoder = this.#renderer.encoder;
      if (this.#encoder === encoder) return true;
      installEncoderHook(this.#renderer, this);
      this.#encoder = encoder;
      this.#failureReason = undefined;
      this.#initializationFailureKind = undefined;
      return true;
    } catch (error: unknown) {
      this.#ready = false;
      this.#requiresFullSync = true;
      this.#recordsSynced = false;
      this.#failureReason = diagnosticMessage("compute-cull encoder migration failed", error);
      this.#initializationFailureKind = "hook-transient";
      return false;
    }
  }

  #watchDeviceLoss(device: GPUDevice, epoch: number): void {
    const lost = device.lost;
    if (lost === undefined || typeof lost.then !== "function") return;
    void lost.then(
      (info) => {
        if (this.#destroyed || this.#device !== device || this.#deviceEpoch !== epoch) return;
        const message = info.message.length > 0 ? `: ${info.message}` : "";
        this.#retireDeviceEpoch(`compute-cull WebGPU device was lost${message}`, device);
      },
      (error: unknown) => {
        if (this.#destroyed || this.#device !== device || this.#deviceEpoch !== epoch) return;
        this.#retireDeviceEpoch(
          diagnosticMessage("compute-cull device loss failed", error),
          device,
        );
      },
    );
  }

  #retireDeviceEpoch(reason: string, failedDevice: GPUDevice): void {
    const transaction = this.#frameTransaction;
    let transactionEpoch: number | undefined;
    try {
      transactionEpoch = transaction?.currentEpoch;
    } catch {
      transactionEpoch = undefined;
    }
    const records = this.#records;
    const counts = this.#counts;
    const prefix = this.#prefix;
    const groupSums = this.#groupSums;
    const groupBlockSums = this.#groupBlockSums;
    const instancesOut = this.#instancesOut;
    const uniform = this.#uniform;
    const indirectBuffer = this.#indirectBuffer;
    this.#deviceEpoch += 1;
    this.#device = undefined;
    this.#failedDevice = failedDevice;
    this.#initializationFailureKind = "device-fatal";
    this.#encoder = undefined;
    this.#pipelineMark = undefined;
    this.#pipelineScan = undefined;
    this.#pipelineScanGroups = undefined;
    this.#pipelineScanGroupBlocks = undefined;
    this.#pipelineAddGroupOffsets = undefined;
    this.#pipelineScatter = undefined;
    this.#bindGroupLayout = undefined;
    this.#records = undefined;
    this.#counts = undefined;
    this.#prefix = undefined;
    this.#groupSums = undefined;
    this.#groupBlockSums = undefined;
    this.#instancesOut = undefined;
    this.#uniform = undefined;
    this.#boundTransforms = undefined;
    this.#indirectBuffer = undefined;
    this.#labelCapacity = 0;
    this.#recordBytes = 0;
    this.#drawBytes = 0;
    this.#recordCount = 0;
    this.#bindGroup = undefined;
    this.#recordsSynced = false;
    this.#requiresFullSync = true;
    this.#ready = false;
    this.#lastRecordUploadBytes = 0;
    this.#failureReason = reason;
    cleanupBestEffort([
      () => uninstallEncoderHook(this.#renderer, this),
      () => {
        if (transaction !== undefined && transactionEpoch !== undefined) {
          transaction.cancelEpoch(transactionEpoch);
        }
      },
      () => records?.destroy(),
      () => counts?.destroy(),
      () => prefix?.destroy(),
      () => groupSums?.destroy(),
      () => groupBlockSums?.destroy(),
      () => instancesOut?.destroy(),
      () => uniform?.destroy(),
      () => indirectBuffer?.destroy(),
    ]);
  }

  #recordWrite(bytes: number): void {
    this.#lastRecordUploadBytes += bytes;
    this.#recordUploadBytes += bytes;
    this.#recordWrites += 1;
  }

  #failDispatch(error: unknown, context = "compute-cull dispatch failed"): void {
    this.#requiresFullSync = true;
    this.#recordsSynced = false;
    this.#failureReason = typeof error === "string" ? error : diagnosticMessage(context, error);
  }
}

function cleanupReadback(readback: GPUBuffer | undefined, mapped: boolean): void {
  cleanupBestEffort([
    () => {
      if (mapped) readback?.unmap();
    },
    () => readback?.destroy(),
  ]);
}

function installEncoderHook(renderer: WebGPURenderer, pass: ComputeCullPass): void {
  let state = encoderHooks.get(renderer);
  let migratedPasses: Set<ComputeCullPass> | undefined;
  if (state !== undefined && state.encoder !== renderer.encoder) {
    migratedPasses = new Set(state.passes);
    retireEncoderHookState(renderer, state);
    state = undefined;
  }
  if (state === undefined) {
    const encoder = renderer.encoder;
    const original = Reflect.get(encoder, "draw") as unknown;
    if (typeof original !== "function") {
      throw new TypeError("Pixi encoder draw hook must be a function");
    }
    const snapshot: EncoderDrawHookSnapshot = {
      original: original as EncoderDraw,
      ownDescriptor: Object.getOwnPropertyDescriptor(encoder, "draw"),
    };
    let mutable: EncoderHookState;
    const hook: EncoderDraw = function (this: typeof encoder, options): void {
      const active = encoderHooks.get(renderer);
      if (renderer.encoder !== encoder) {
        if (active === mutable) retireEncoderHookState(renderer, mutable);
        snapshot.original.call(this, options);
        return;
      }
      if (mutable.status === "active" && active === mutable) {
        for (const candidate of mutable.passes) {
          if (candidate.tryIndirectDraw(options)) return;
        }
      } else if (mutable.status === "retired") {
        restoreRetiredEncoderHookIfCurrent(encoder, mutable);
      }
      snapshot.original.call(this, options);
    };
    mutable = {
      passes: migratedPasses ?? new Set(),
      encoder,
      snapshot,
      hook,
      installedOwnDescriptor: undefined,
      external: undefined,
      managed: false,
      status: "installing",
    };
    try {
      if (!Reflect.set(encoder, "draw", hook) || Reflect.get(encoder, "draw") !== hook) {
        throw new TypeError("Pixi encoder draw hook is not writable");
      }
      mutable.installedOwnDescriptor = Object.getOwnPropertyDescriptor(encoder, "draw");
      installManagedEncoderDrawHook(encoder, mutable);
      mutable.passes.add(pass);
      encoderHooks.set(renderer, mutable);
      mutable.status = "active";
    } catch (error: unknown) {
      mutable.status = "restored";
      restoreEncoderDrawHook(encoder, snapshot);
      throw error;
    }
    return;
  }
  state.passes.add(pass);
}

function uninstallEncoderHook(renderer: WebGPURenderer, pass: ComputeCullPass): void {
  const state = encoderHooks.get(renderer);
  if (state === undefined) return;
  state.passes.delete(pass);
  if (state.passes.size > 0) return;
  retireEncoderHookState(renderer, state);
}

function retireEncoderHookState(renderer: WebGPURenderer, state: EncoderHookState): void {
  state.status = "retired";
  if (encoderHooks.get(renderer) === state) encoderHooks.delete(renderer);
  const encoder = state.encoder;
  let current: unknown;
  let currentOwnDescriptor: PropertyDescriptor | undefined;
  try {
    current = Reflect.get(encoder, "draw");
    currentOwnDescriptor = Object.getOwnPropertyDescriptor(encoder, "draw");
  } catch {
    return;
  }
  if (
    !sameEncoderDrawHookPlacement(currentOwnDescriptor, state.installedOwnDescriptor) ||
    (state.managed ? state.external !== undefined : current !== state.hook)
  ) {
    return;
  }
  state.status = "restored";
  restoreEncoderDrawHook(encoder, state.snapshot);
}

function installManagedEncoderDrawHook(
  encoder: WebGPURenderer["encoder"],
  state: EncoderHookState,
): void {
  const assignedDescriptor = state.installedOwnDescriptor;
  if (assignedDescriptor === undefined || assignedDescriptor.configurable !== true) return;
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: assignedDescriptor.enumerable ?? false,
    get(): EncoderDraw {
      if (state.status === "retired" && state.external === undefined) {
        state.status = "restored";
        restoreEncoderDrawHook(encoder, state.snapshot);
        return state.snapshot.original;
      }
      return state.external ?? state.hook;
    },
    set(value: EncoderDraw): void {
      if (typeof value !== "function") {
        throw new TypeError("Pixi encoder draw hook must be a function");
      }
      state.external =
        value === state.hook || value === state.snapshot.original ? undefined : value;
      if (state.status === "retired" && state.external === undefined) {
        state.status = "restored";
        restoreEncoderDrawHook(encoder, state.snapshot);
      }
    },
  };
  Object.defineProperty(encoder, "draw", descriptor);
  if (Reflect.get(encoder, "draw") !== state.hook) {
    throw new TypeError("Pixi encoder draw hook is not writable");
  }
  state.managed = true;
  state.installedOwnDescriptor = Object.getOwnPropertyDescriptor(encoder, "draw");
}

function restoreRetiredEncoderHookIfCurrent(
  encoder: WebGPURenderer["encoder"],
  state: EncoderHookState,
): void {
  let current: unknown;
  let descriptor: PropertyDescriptor | undefined;
  try {
    current = Reflect.get(encoder, "draw");
    descriptor = Object.getOwnPropertyDescriptor(encoder, "draw");
  } catch {
    return;
  }
  if (
    current !== state.hook ||
    !sameEncoderDrawHookPlacement(descriptor, state.installedOwnDescriptor)
  ) {
    return;
  }
  state.status = "restored";
  restoreEncoderDrawHook(encoder, state.snapshot);
}

function restoreEncoderDrawHook(
  encoder: WebGPURenderer["encoder"],
  snapshot: EncoderDrawHookSnapshot,
): void {
  const descriptor = snapshot.ownDescriptor;
  if (descriptor === undefined) {
    try {
      Reflect.deleteProperty(encoder, "draw");
    } catch {
      // The original inherited placement may already be visible.
    }
    try {
      Reflect.set(encoder, "draw", snapshot.original);
    } catch {
      // A mutate-then-throw setter can still restore its backing function.
    }
    try {
      Reflect.deleteProperty(encoder, "draw");
    } catch {
      // Hook installation and teardown retain their primary lifecycle result.
    }
    return;
  }
  try {
    Object.defineProperty(encoder, "draw", descriptor);
  } catch {
    // Accessor cleanup below still gets a chance to restore its backing function.
  }
  if (!("value" in descriptor)) {
    try {
      Reflect.set(encoder, "draw", snapshot.original);
    } catch {
      // A mutate-then-throw setter can still restore its backing function.
    }
    try {
      Object.defineProperty(encoder, "draw", descriptor);
    } catch {
      // Hook installation and teardown retain their primary lifecycle result.
    }
  }
}

function sameEncoderDrawHookPlacement(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftIsData = "value" in left;
  const rightIsData = "value" in right;
  if (leftIsData !== rightIsData) return false;
  if (left.configurable !== right.configurable || left.enumerable !== right.enumerable)
    return false;
  if (leftIsData) return left.writable === right.writable;
  return left.get === right.get && left.set === right.set;
}

function computeCullCapabilityFailure(limits: GPUSupportedLimits): string | undefined {
  const storageBuffers = limits.maxStorageBuffersPerShaderStage;
  if (typeof storageBuffers === "number" && storageBuffers < REQUIRED_COMPUTE_STORAGE_BUFFERS) {
    return `compute-cull requires ${String(REQUIRED_COMPUTE_STORAGE_BUFFERS)} storage buffers per compute stage; the device exposes ${String(storageBuffers)}`;
  }
  const invocations = limits.maxComputeInvocationsPerWorkgroup;
  if (typeof invocations === "number" && invocations < CULL_WORKGROUP) {
    return `compute-cull requires ${String(CULL_WORKGROUP)} invocations per workgroup; the device exposes ${String(invocations)}`;
  }
  const workgroupSizeX = limits.maxComputeWorkgroupSizeX;
  if (typeof workgroupSizeX === "number" && workgroupSizeX < CULL_WORKGROUP) {
    return `compute-cull requires workgroup size X ${String(CULL_WORKGROUP)}; the device exposes ${String(workgroupSizeX)}`;
  }
  return undefined;
}

function diagnosticMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : `${prefix}: ${String(error)}`;
}

function createCullIndirectBuffer(): Buffer {
  return new Buffer({
    data: createIndirectArgs(0),
    usage: BufferUsage.INDIRECT | BufferUsage.COPY_SRC | BufferUsage.COPY_DST | BufferUsage.STORAGE,
    label: "pixi-glyphflow-cull-indirect",
    shrinkToFit: false,
  });
}

function createBuffer(
  device: GPUDevice,
  size: number,
  usage: GPUBufferUsageFlags,
  label: string,
): GPUBuffer {
  return device.createBuffer({
    size: Math.max(Uint32Array.BYTES_PER_ELEMENT, size),
    usage,
    label,
  });
}
