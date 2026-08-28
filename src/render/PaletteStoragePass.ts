import { Buffer, BufferUsage, type WebGPURenderer } from "pixi.js";

import { planComputeCullStorageBytes } from "../culling/computeCull";
import { PALETTE_PATCH_WGSL } from "./palettePatch.wgsl";
import {
  originColumnUploadBytes,
  PALETTE_PATCH_WORKGROUP,
  paletteMoveRange,
  type PaletteMoveRange,
} from "./paletteStorage";
import type { DirtyByteRange } from "./types";

const UNIFORM_BYTES = 16;

export interface PaletteMoveUpload {
  readonly slots: Uint32Array;
  readonly count: number;
  readonly originX: Float32Array;
  readonly originY: Float32Array;
}

export class PaletteStoragePass {
  readonly #renderer: WebGPURenderer;
  #device: GPUDevice | undefined;
  #pipeline: GPUComputePipeline | undefined;
  #bindGroupLayout: GPUBindGroupLayout | undefined;
  #transforms: GPUBuffer | undefined;
  #transformBuffer: Buffer;
  #originX: GPUBuffer | undefined;
  #originY: GPUBuffer | undefined;
  #slots: GPUBuffer | undefined;
  #uniform: GPUBuffer | undefined;
  #transformBytes = 0;
  #originCapacity = 0;
  #slotCapacity = 0;
  #ready = false;
  readonly #uniformScratch = new ArrayBuffer(UNIFORM_BYTES);
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
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
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
    if (
      device === undefined ||
      layout === undefined ||
      pipeline === undefined ||
      transforms === undefined ||
      move.count <= 0
    ) {
      return 0;
    }
    const range = paletteMoveRange(move.slots, move.count, move.originX.length);
    if (range === undefined) return 0;
    if (!this.#ensureMoveBuffers(move.originX.length, move.count)) return 0;
    const originX = this.#originX;
    const originY = this.#originY;
    const slots = this.#slots;
    const uniform = this.#uniform;
    if (
      originX === undefined ||
      originY === undefined ||
      slots === undefined ||
      uniform === undefined
    ) {
      return 0;
    }
    this.#uploadOriginColumns(device, originX, originY, move, range);
    const slotBytes = move.count * Uint32Array.BYTES_PER_ELEMENT;
    device.queue.writeBuffer(slots, 0, move.slots.buffer, move.slots.byteOffset, slotBytes);
    this.#uniformInts[0] = move.count;
    device.queue.writeBuffer(uniform, 0, this.#uniformScratch);
    const bindGroup = device.createBindGroup({
      label: "pixi-glyphflow-palette-patch-bind-group",
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: slots } },
        { binding: 2, resource: { buffer: originX } },
        { binding: 3, resource: { buffer: originY } },
        { binding: 4, resource: { buffer: transforms } },
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
    return originColumnUploadBytes(range, move.count) + slotBytes + UNIFORM_BYTES;
  }

  destroy(): void {
    this.#originX?.destroy();
    this.#originY?.destroy();
    this.#slots?.destroy();
    this.#uniform?.destroy();
    this.#transformBuffer.destroy();
    this.#transforms = undefined;
    this.#ready = false;
    this.#device = undefined;
  }

  #uploadOriginColumns(
    device: GPUDevice,
    originX: GPUBuffer,
    originY: GPUBuffer,
    move: PaletteMoveUpload,
    range: PaletteMoveRange,
  ): void {
    const spanSlots = range.maxSlot - range.minSlot + 1;
    if (spanSlots <= move.count * 4) {
      const originOffset = range.minSlot * Float32Array.BYTES_PER_ELEMENT;
      const originBytes = spanSlots * Float32Array.BYTES_PER_ELEMENT;
      device.queue.writeBuffer(
        originX,
        originOffset,
        move.originX.buffer,
        move.originX.byteOffset + originOffset,
        originBytes,
      );
      device.queue.writeBuffer(
        originY,
        originOffset,
        move.originY.buffer,
        move.originY.byteOffset + originOffset,
        originBytes,
      );
      return;
    }
    for (let index = 0; index < move.count; index += 1) {
      const slot = move.slots[index] ?? 0;
      if (slot >= move.originX.length) continue;
      const originOffset = slot * Float32Array.BYTES_PER_ELEMENT;
      device.queue.writeBuffer(
        originX,
        originOffset,
        move.originX.buffer,
        move.originX.byteOffset + originOffset,
        Float32Array.BYTES_PER_ELEMENT,
      );
      device.queue.writeBuffer(
        originY,
        originOffset,
        move.originY.buffer,
        move.originY.byteOffset + originOffset,
        Float32Array.BYTES_PER_ELEMENT,
      );
    }
  }

  #ensureMoveBuffers(originCapacity: number, slotCount: number): boolean {
    const device = this.#device;
    if (device === undefined) return false;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const originBytes = planComputeCullStorageBytes(
      Math.max(4, originCapacity * Float32Array.BYTES_PER_ELEMENT),
      limit,
    );
    const slotBytes = planComputeCullStorageBytes(
      Math.max(4, slotCount * Uint32Array.BYTES_PER_ELEMENT),
      limit,
    );
    if (originBytes === undefined || slotBytes === undefined) return false;
    if (originCapacity > this.#originCapacity || this.#originX === undefined) {
      this.#originX?.destroy();
      this.#originY?.destroy();
      this.#originX = createBuffer(device, originBytes, "pixi-glyphflow-palette-origin-x");
      this.#originY = createBuffer(device, originBytes, "pixi-glyphflow-palette-origin-y");
      this.#originCapacity = originBytes / Float32Array.BYTES_PER_ELEMENT;
    }
    if (slotCount > this.#slotCapacity || this.#slots === undefined) {
      this.#slots?.destroy();
      this.#slots = createBuffer(device, slotBytes, "pixi-glyphflow-palette-move-slots");
      this.#slotCapacity = slotBytes / Uint32Array.BYTES_PER_ELEMENT;
    }
    if (this.#uniform === undefined) {
      this.#uniform = createBuffer(
        device,
        UNIFORM_BYTES,
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
