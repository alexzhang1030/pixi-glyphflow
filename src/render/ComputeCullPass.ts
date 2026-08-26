import { Buffer, BufferUsage, type Geometry, type Shader, type WebGPURenderer } from "pixi.js";

import {
  CULL_RECORD_STRIDE,
  CULL_WORKGROUP,
  type CullRecordDirty,
  type CullViewport,
  createIndirectArgs,
  planComputeCullStorageBytes,
} from "../culling/computeCull";
import { COMPUTE_CULL_WGSL } from "../culling/computeCull.wgsl";

const UNIFORM_BYTES = 32;

type EncoderDraw = WebGPURenderer["encoder"]["draw"];
type EncoderDrawOptions = Parameters<EncoderDraw>[0];

interface EncoderHookState {
  readonly passes: Set<ComputeCullPass>;
  readonly original: EncoderDraw;
}

interface ShaderBindEncoder {
  _setShaderBindGroups(shader: Shader, skipSync?: boolean): void;
}

const encoderHooks = new WeakMap<WebGPURenderer, EncoderHookState>();

export class ComputeCullPass {
  readonly #renderer: WebGPURenderer;
  readonly #geometries = new Set<Geometry>();
  #device: GPUDevice | undefined;
  #pipelineMark: GPUComputePipeline | undefined;
  #pipelineScan: GPUComputePipeline | undefined;
  #pipelineScanGroups: GPUComputePipeline | undefined;
  #pipelineScatter: GPUComputePipeline | undefined;
  #bindGroupLayout: GPUBindGroupLayout | undefined;
  #records: GPUBuffer | undefined;
  #counts: GPUBuffer | undefined;
  #prefix: GPUBuffer | undefined;
  #groupSums: GPUBuffer | undefined;
  #instancesOut: GPUBuffer | undefined;
  #uniform: GPUBuffer | undefined;
  readonly indirectBuffer: Buffer;
  #labelCapacity = 0;
  #drawBytes = 0;
  #recordCount = 0;
  #bindGroup: GPUBindGroup | undefined;
  #recordsSynced = false;
  readonly #uniformScratch = new ArrayBuffer(UNIFORM_BYTES);
  readonly #uniformFloats = new Float32Array(this.#uniformScratch);
  readonly #uniformInts = new Uint32Array(this.#uniformScratch);
  #ready = false;

  constructor(renderer: WebGPURenderer) {
    this.#renderer = renderer;
    this.indirectBuffer = new Buffer({
      data: createIndirectArgs(0),
      usage: BufferUsage.INDIRECT | BufferUsage.COPY_DST | BufferUsage.STORAGE,
      label: "pixi-glyphflow-cull-indirect",
      shrinkToFit: false,
    });
  }

  get ready(): boolean {
    return this.#ready;
  }

  get synced(): boolean {
    return this.#recordsSynced;
  }

  trackGeometry(geometry: Geometry): void {
    this.#geometries.add(geometry);
  }

  untrackGeometry(geometry: Geometry): void {
    this.#geometries.delete(geometry);
  }

  initialize(): boolean {
    if (this.#ready) return true;
    const device = this.#renderer.gpu?.device;
    if (device === undefined) return false;
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
        ],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
      this.#pipelineMark = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "mark_visible" },
      });
      this.#pipelineScan = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scan_counts" },
      });
      this.#pipelineScanGroups = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scan_group_sums" },
      });
      this.#pipelineScatter = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: "scatter" },
      });
      this.#bindGroupLayout = bindGroupLayout;
      this.#device = device;
      this.#ready = true;
      installEncoderHook(this.#renderer, this);
      return true;
    } catch {
      this.#ready = false;
      return false;
    }
  }

  ensureCapacity(labelCount: number, drawInstanceBytes: number): boolean {
    const device = this.#device;
    if (device === undefined || !this.#ready) return false;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const recordBytes = planComputeCullStorageBytes(
      Math.max(CULL_WORKGROUP, labelCount) * CULL_RECORD_STRIDE,
      limit,
    );
    const bytes = planComputeCullStorageBytes(Math.max(8, drawInstanceBytes), limit);
    if (recordBytes === undefined || bytes === undefined) return false;
    const labels = recordBytes / CULL_RECORD_STRIDE;
    if (labels > this.#labelCapacity) {
      this.#bindGroup = undefined;
      this.#recordsSynced = false;
      this.#records?.destroy();
      this.#counts?.destroy();
      this.#prefix?.destroy();
      this.#groupSums?.destroy();
      this.#records = createBuffer(
        device,
        recordBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        "pixi-glyphflow-cull-records",
      );
      this.#counts = createBuffer(
        device,
        labels * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        "pixi-glyphflow-cull-counts",
      );
      this.#prefix = createBuffer(
        device,
        labels * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        "pixi-glyphflow-cull-prefix",
      );
      this.#groupSums = createBuffer(
        device,
        Math.ceil(labels / CULL_WORKGROUP) * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        "pixi-glyphflow-cull-group-sums",
      );
      this.#labelCapacity = labels;
    }
    if (bytes > this.#drawBytes) {
      this.#bindGroup = undefined;
      this.#instancesOut?.destroy();
      this.#instancesOut = createBuffer(
        device,
        bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
        "pixi-glyphflow-cull-instances-out",
      );
      this.#drawBytes = bytes;
    }
    if (this.#uniform === undefined) {
      this.#uniform = createBuffer(
        device,
        UNIFORM_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        "pixi-glyphflow-cull-uniforms",
      );
    }
    this.#renderer.buffer.updateBuffer(this.indirectBuffer);
    return true;
  }

  /** `records` must always be the complete packed buffer so a resync can upload it whole. */
  uploadRecords(records: ArrayBuffer, recordCount: number, dirty: CullRecordDirty): boolean {
    const device = this.#device;
    this.#recordCount = recordCount;
    if (device === undefined || this.#records === undefined || recordCount === 0) return false;
    if (!this.#recordsSynced || dirty === "all") {
      device.queue.writeBuffer(this.#records, 0, records, 0, recordCount * CULL_RECORD_STRIDE);
      this.#recordsSynced = true;
      return true;
    }
    if (dirty === "none" || dirty.length === 0) return false;
    for (const range of dirty) {
      device.queue.writeBuffer(this.#records, range.offset, records, range.offset, range.length);
    }
    return true;
  }

  /** The GPU mirrors go stale while another cull path runs; force full uploads on re-entry. */
  invalidateSync(): void {
    this.#recordsSynced = false;
  }

  dispatch(viewport: CullViewport): boolean {
    const device = this.#device;
    const layout = this.#bindGroupLayout;
    if (
      device === undefined ||
      layout === undefined ||
      this.#pipelineMark === undefined ||
      this.#pipelineScan === undefined ||
      this.#pipelineScanGroups === undefined ||
      this.#pipelineScatter === undefined ||
      this.#records === undefined ||
      this.#counts === undefined ||
      this.#prefix === undefined ||
      this.#groupSums === undefined ||
      this.#instancesOut === undefined ||
      this.#uniform === undefined
    ) {
      return false;
    }
    const indirect = this.#renderer.buffer.getGPUBuffer(this.indirectBuffer);
    const floats = this.#uniformFloats;
    floats[0] = viewport.x;
    floats[1] = viewport.y;
    floats[2] = viewport.width;
    floats[3] = viewport.height;
    floats[4] = viewport.padding;
    this.#uniformInts[5] = this.#recordCount;
    device.queue.writeBuffer(this.#uniform, 0, this.#uniformScratch);
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
          { binding: 5, resource: { buffer: this.#instancesOut } },
          { binding: 6, resource: { buffer: indirect } },
        ],
      });
    this.#bindGroup = bindGroup;
    const groups = Math.max(1, Math.ceil(this.#recordCount / CULL_WORKGROUP));
    const encoder = device.createCommandEncoder({ label: "pixi-glyphflow-compute-cull" });
    // WebGPU orders dispatches within one pass, so the pipeline stages need no pass boundaries.
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(this.#pipelineMark);
    pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.#pipelineScan);
    pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.#pipelineScanGroups);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.#pipelineScatter);
    pass.dispatchWorkgroups(groups);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return true;
  }

  tryIndirectDraw(options: EncoderDrawOptions): boolean {
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
    uninstallEncoderHook(this.#renderer, this);
    this.#records?.destroy();
    this.#counts?.destroy();
    this.#prefix?.destroy();
    this.#groupSums?.destroy();
    this.#instancesOut?.destroy();
    this.#uniform?.destroy();
    this.#bindGroup = undefined;
    this.#recordsSynced = false;
    this.indirectBuffer.destroy();
    this.#geometries.clear();
    this.#ready = false;
    this.#device = undefined;
  }
}

function installEncoderHook(renderer: WebGPURenderer, pass: ComputeCullPass): void {
  let state = encoderHooks.get(renderer);
  if (state === undefined) {
    const encoder = renderer.encoder;
    state = {
      passes: new Set(),
      original: encoder.draw,
    };
    encoderHooks.set(renderer, state);
    encoder.draw = (options): void => {
      const active = encoderHooks.get(renderer);
      if (active !== undefined) {
        for (const candidate of active.passes) {
          if (candidate.tryIndirectDraw(options)) return;
        }
        active.original.call(encoder, options);
      }
    };
  }
  state.passes.add(pass);
}

function uninstallEncoderHook(renderer: WebGPURenderer, pass: ComputeCullPass): void {
  const state = encoderHooks.get(renderer);
  if (state === undefined) return;
  state.passes.delete(pass);
  if (state.passes.size > 0) return;
  renderer.encoder.draw = state.original;
  encoderHooks.delete(renderer);
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
