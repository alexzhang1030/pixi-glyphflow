import { Buffer, BufferUsage, type WebGPURenderer } from "pixi.js";

import { planComputeCullStorageBytes } from "../culling/computeCull";
import { PALETTE_PATCH_WGSL } from "./palettePatch.wgsl";
import {
  PALETTE_MOVE_STRIDE,
  PALETTE_MOVE_UNIFORM_BYTES,
  PALETTE_PATCH_WORKGROUP,
  paletteMoveDispatchBytes,
  paletteMoveUploadBytes,
  type PaletteMoveUpload,
} from "./paletteStorage";
import type { DirtyByteRange } from "./types";

export type { PaletteMoveUpload };

export class PaletteStoragePass {
  readonly #renderer: WebGPURenderer;
  #device: GPUDevice | undefined;
  #pipeline: GPUComputePipeline | undefined;
  #bindGroupLayout: GPUBindGroupLayout | undefined;
  #transforms: GPUBuffer | undefined;
  #transformBuffer: Buffer;
  #commands: GPUBuffer | undefined;
  #uniform: GPUBuffer | undefined;
  #transformBytes = 0;
  #commandCapacity = 0;
  #ready = false;
  readonly #uniformScratch = new ArrayBuffer(PALETTE_MOVE_UNIFORM_BYTES);
  readonly #uniformInts = new Uint32Array(this.#uniformScratch);

  constructor(renderer: WebGPURenderer) {
    this.#renderer = renderer;
    this.#transformBuffer = createPaletteBuffer(16);
  }

  get transformBuffer(): Buffer {
    return this.#transformBuffer;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** True after `ensureTransforms` registered a GPU storage buffer with Pixi. */
  get hasGpuTransforms(): boolean {
    return this.#transforms !== undefined;
  }

  initialize(): boolean {
    if (this.#ready) return true;
    const device = this.#renderer.gpu?.device;
    if (device === undefined) return false;
    try {
      const module = device.createShaderModule({
        label: "pixi-glyphflow-palette-patch",
        code: PALETTE_PATCH_WGSL,
      });
      const bindGroupLayout = device.createBindGroupLayout({
        label: "pixi-glyphflow-palette-patch-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      this.#pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        compute: { module, entryPoint: "patch_xy" },
      });
      this.#bindGroupLayout = bindGroupLayout;
      this.#device = device;
      this.#ready = true;
      return true;
    } catch {
      this.#ready = false;
      return false;
    }
  }

  ensureTransforms(bytes: number): { readonly ok: boolean; readonly replaced: boolean } {
    const device = this.#device;
    if (device === undefined || !this.#ready) return { ok: false, replaced: false };
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const size = planComputeCullStorageBytes(Math.max(16, bytes), limit);
    if (size === undefined) return { ok: false, replaced: false };
    if (size <= this.#transformBytes && this.#transforms !== undefined) {
      return { ok: true, replaced: false };
    }
    const previous = this.#transformBuffer;
    this.#transformBuffer = createPaletteBuffer(size);
    this.#renderer.buffer.updateBuffer(this.#transformBuffer);
    this.#transforms = this.#renderer.buffer.getGPUBuffer(this.#transformBuffer);
    this.#transformBytes = size;
    previous.destroy();
    return { ok: this.#transforms !== undefined, replaced: true };
  }

  uploadTransforms(data: Float32Array, dirty: readonly Readonly<DirtyByteRange>[]): number {
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
    const device = this.#device;
    const buffer = this.#transforms;
    if (device === undefined || buffer === undefined) return 0;
    const bytes = Math.min(data.byteLength, this.#transformBytes);
    device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, bytes);
    return bytes;
  }

  dispatchMoves(move: PaletteMoveUpload): number {
    const device = this.#device;
    const layout = this.#bindGroupLayout;
    const pipeline = this.#pipeline;
    const transforms = this.#transforms;
    const commandBytes = paletteMoveUploadBytes(move.count);
    if (
      device === undefined ||
      layout === undefined ||
      pipeline === undefined ||
      transforms === undefined ||
      commandBytes <= 0 ||
      move.commands.byteLength < commandBytes
    ) {
      return 0;
    }
    if (!this.#ensureMoveBuffers(move.count)) return 0;
    const commands = this.#commands;
    const uniform = this.#uniform;
    if (commands === undefined || uniform === undefined) return 0;
    device.queue.writeBuffer(commands, 0, move.commands, 0, commandBytes);
    this.#uniformInts[0] = move.count;
    device.queue.writeBuffer(uniform, 0, this.#uniformScratch);
    const bindGroup = device.createBindGroup({
      label: "pixi-glyphflow-palette-patch-bind-group",
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: commands } },
        { binding: 2, resource: { buffer: transforms } },
      ],
    });
    const groups = Math.max(1, Math.ceil(move.count / PALETTE_PATCH_WORKGROUP));
    const encoder = device.createCommandEncoder({ label: "pixi-glyphflow-palette-patch" });
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(groups);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return paletteMoveDispatchBytes(move.count);
  }

  destroy(): void {
    this.#commands?.destroy();
    this.#uniform?.destroy();
    this.#transformBuffer.destroy();
    this.#transforms = undefined;
    this.#ready = false;
    this.#device = undefined;
  }

  #ensureMoveBuffers(commandCount: number): boolean {
    const device = this.#device;
    if (device === undefined) return false;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const commandBytes = planComputeCullStorageBytes(
      Math.max(PALETTE_MOVE_STRIDE, commandCount * PALETTE_MOVE_STRIDE),
      limit,
    );
    if (commandBytes === undefined) return false;
    if (commandCount > this.#commandCapacity || this.#commands === undefined) {
      this.#commands?.destroy();
      this.#commands = createBuffer(device, commandBytes, "pixi-glyphflow-palette-move-commands");
      this.#commandCapacity = commandBytes / PALETTE_MOVE_STRIDE;
    }
    if (this.#uniform === undefined) {
      this.#uniform = createBuffer(
        device,
        PALETTE_MOVE_UNIFORM_BYTES,
        "pixi-glyphflow-palette-move-uniforms",
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
    }
    return true;
  }
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
