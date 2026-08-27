/** Live CPU/GPU store record. The published ceiling stays 32 until new artifacts exist. */
export const GLYPH_INSTANCE_STRIDE = 24;
/** Draw instance: store glyph index + palette index. Shaders fetch rect, UV, and metadata. */
export const GLYPH_DRAW_STRIDE = 8;
/** Published 1.1.0 instance budget. Do not fail CI below this until a Chrome rerun. */
export const GLYPH_INSTANCE_STRIDE_CEILING = 32;
/** RGBA32F texels per store glyph in the prototype texture (24 bytes + 8 pad). */
export const GLYPH_PROTO_TEXELS_PER_GLYPH = 2;
/** Default prototype texture width. Grow only when height would exceed the device max. */
export const GLYPH_PROTO_TEXTURE_WIDTH = 1024;
/** Atlas array textures bound per glyph draw: R8 (sdf/alpha) and RGBA8 (msdf/color). */
export const GLYPH_TEXTURE_BANK_SIZE = 2;
export { GLYPH_ATLAS_ARRAY_LAYERS } from "../atlas/types";

export interface DirtyByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface GlyphInstanceBatch {
  /** Packed x, y, width, and height values. */
  readonly positions: Float32Array;
  /** Packed normalized u0, v0, u1, and v1 values. */
  readonly uvs: Float32Array;
  readonly paletteIndices: Uint32Array;
  /** Atlas array layer (same-format page index), packed into instance metadata. */
  readonly pages: Uint16Array;
  /** 0=MSDF, 1=SDF, 2=alpha, 3=color. */
  readonly modes: Uint8Array;
  /** Physical atlas pixels per logical layout unit. Defaults to 1. */
  readonly rasterScales?: Float32Array;
}

export interface GlyphInstanceRange {
  readonly offset: number;
  readonly count: number;
  readonly capacity: number;
}

export interface GlyphInstanceStoreOptions {
  readonly initialCapacity?: number;
  readonly maxCapacity?: number;
}

export interface GlyphInstanceStoreStats {
  readonly labels: number;
  readonly activeInstances: number;
  readonly capacity: number;
  readonly highWater: number;
  readonly freeInstances: number;
  readonly allocatedBytes: number;
  readonly pendingDirtyRanges: number;
}

export interface GlyphInstanceCompactionResult {
  readonly beforeCapacity: number;
  readonly afterCapacity: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly releasedBytes: number;
}

export interface UploadBatchResult {
  readonly uploadedBytes: number;
  readonly writes: number;
  readonly deferred: readonly Readonly<DirtyByteRange>[];
}

export interface WebGLUploadContext {
  readonly ARRAY_BUFFER: number;
  readonly DYNAMIC_DRAW: number;
  bindBuffer(target: number, buffer: unknown): void;
  bufferData(target: number, data: ArrayBufferView, usage: number): void;
  bufferSubData(target: number, offset: number, data: ArrayBufferView): void;
}

export interface WebGLAdapterStats {
  readonly allocatedBytes: number;
  readonly fullUploads: number;
  readonly partialUploads: number;
  readonly uploadedBytes: number;
}

export interface WebGPUBufferLike {
  readonly size: number;
}

export interface WebGPUQueueLike {
  writeBuffer(
    buffer: WebGPUBufferLike,
    bufferOffset: number,
    data: ArrayBuffer,
    dataOffset: number,
    size: number,
  ): void;
}

export interface WebGPUAdapterOptions {
  readonly maxWriteBytes?: number;
}

export interface WebGPUAdapterStats {
  readonly frames: number;
  readonly writes: number;
  readonly uploadedBytes: number;
  readonly deferredBytes: number;
  readonly maxWriteBytes: number;
}

export interface TransformPaletteInput {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly alpha: number;
  readonly visible: boolean;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fill?: unknown;
  readonly stroke?: unknown;
  readonly dropShadow?: unknown;
}

export interface TransformRunBounds {
  readonly width: number;
  readonly height: number;
}

export interface TransformPaletteOptions {
  readonly initialCapacity?: number;
  readonly textureWidth?: number;
  readonly maxCapacity?: number;
}

export interface TransformPaletteStats {
  readonly capacity: number;
  readonly activeLabels: number;
  readonly allocatedBytes: number;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly pendingDirtyRanges: number;
  readonly coreStride: number;
  readonly effectBase: number;
}
