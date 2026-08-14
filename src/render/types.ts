export const GLYPH_INSTANCE_STRIDE = 32;

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
  readonly pages: Uint16Array;
  /** 0=MSDF, 1=SDF, 2=alpha, 3=color. */
  readonly modes: Uint8Array;
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
