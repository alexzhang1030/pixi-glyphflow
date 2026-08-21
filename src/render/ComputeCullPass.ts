import { Buffer, BufferUsage, type Geometry, type Shader, type WebGPURenderer } from "pixi.js";

import {
  CULL_RECORD_STRIDE,
  CULL_WORKGROUP,
  type CullViewport,
  createIndirectArgs,
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
  #instancesIn: GPUBuffer | undefined;
  #instancesOut: GPUBuffer | undefined;
  #uniform: GPUBuffer | undefined;
  readonly indirectBuffer: Buffer;
  #labelCapacity = 0;
  #instanceBytes = 0;
  #recordCount = 0;
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
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
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

  ensureCapacity(labelCount: number, instanceBytes: number): void {
    const device = this.#device;
    if (device === undefined || !this.#ready) return;
    const labels = Math.max(CULL_WORKGROUP, nextPowerOfTwo(Math.max(1, labelCount)));
    const bytes = Math.max(24, nextPowerOfTwo(Math.max(24, instanceBytes)));
    if (labels > this.#labelCapacity) {
      this.#records?.destroy();
      this.#counts?.destroy();
      this.#prefix?.destroy();
      this.#groupSums?.destroy();
      this.#records = createBuffer(
        device,
        labels * CULL_RECORD_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      this.#counts = createBuffer(
        device,
        labels * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      this.#prefix = createBuffer(
        device,
        labels * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      this.#groupSums = createBuffer(
        device,
        Math.ceil(labels / CULL_WORKGROUP) * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      this.#labelCapacity = labels;
    }
    if (bytes > this.#instanceBytes) {
      this.#instancesIn?.destroy();
      this.#instancesOut?.destroy();
      this.#instancesIn = createBuffer(
        device,
        bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      this.#instancesOut = createBuffer(
        device,
        bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
      );
      this.#instanceBytes = bytes;
    }
    if (this.#uniform === undefined) {
      this.#uniform = createBuffer(
        device,
        UNIFORM_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
    }
    this.#renderer.buffer.updateBuffer(this.indirectBuffer);
  }

  uploadRecords(records: ArrayBuffer, recordCount: number): void {
    const device = this.#device;
    this.#recordCount = recordCount;
    if (device === undefined || this.#records === undefined || recordCount === 0) return;
    device.queue.writeBuffer(this.#records, 0, records, 0, recordCount * CULL_RECORD_STRIDE);
  }

  uploadInstances(instances: ArrayBuffer, byteLength: number): void {
    const device = this.#device;
    if (device === undefined || this.#instancesIn === undefined || byteLength === 0) return;
    device.queue.writeBuffer(this.#instancesIn, 0, instances, 0, byteLength);
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
      this.#instancesIn === undefined ||
      this.#instancesOut === undefined ||
      this.#uniform === undefined
    ) {
      return false;
    }
    const indirect = this.#renderer.buffer.getGPUBuffer(this.indirectBuffer);
    const uniforms = new ArrayBuffer(UNIFORM_BYTES);
    const floats = new Float32Array(uniforms);
    const ints = new Uint32Array(uniforms);
    floats[0] = viewport.x;
    floats[1] = viewport.y;
    floats[2] = viewport.width;
    floats[3] = viewport.height;
    floats[4] = viewport.padding;
    ints[5] = this.#recordCount;
    device.queue.writeBuffer(this.#uniform, 0, uniforms);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: { buffer: this.#records } },
        { binding: 2, resource: { buffer: this.#counts } },
        { binding: 3, resource: { buffer: this.#prefix } },
        { binding: 4, resource: { buffer: this.#groupSums } },
        { binding: 5, resource: { buffer: this.#instancesIn } },
        { binding: 6, resource: { buffer: this.#instancesOut } },
        { binding: 7, resource: { buffer: indirect } },
      ],
    });
    const groups = Math.max(1, Math.ceil(this.#recordCount / CULL_WORKGROUP));
    const encoder = device.createCommandEncoder({ label: "pixi-glyphflow-compute-cull" });
    const mark = encoder.beginComputePass();
    mark.setPipeline(this.#pipelineMark);
    mark.setBindGroup(0, bindGroup);
    mark.dispatchWorkgroups(groups);
    mark.end();
    const scan = encoder.beginComputePass();
    scan.setPipeline(this.#pipelineScan);
    scan.setBindGroup(0, bindGroup);
    scan.dispatchWorkgroups(groups);
    scan.end();
    const scanGroups = encoder.beginComputePass();
    scanGroups.setPipeline(this.#pipelineScanGroups);
    scanGroups.setBindGroup(0, bindGroup);
    scanGroups.dispatchWorkgroups(1);
    scanGroups.end();
    const scatter = encoder.beginComputePass();
    scatter.setPipeline(this.#pipelineScatter);
    scatter.setBindGroup(0, bindGroup);
    scatter.dispatchWorkgroups(groups);
    scatter.end();
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
    const instanceBuffer = options.geometry.attributes.aInstanceRect?.buffer;
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
    this.#instancesIn?.destroy();
    this.#instancesOut?.destroy();
    this.#uniform?.destroy();
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

function createBuffer(device: GPUDevice, size: number, usage: number): GPUBuffer {
  return device.createBuffer({
    size: Math.max(Uint32Array.BYTES_PER_ELEMENT, size),
    usage,
  });
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
