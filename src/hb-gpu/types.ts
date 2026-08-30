export const HB_GPU_DRAW_ABI_VERSION = 1 as const;
export const HB_GPU_DRAW_HARFBUZZ_VERSION = "14.4.0" as const;

export interface HbGpuGlyphExtents {
  readonly xBearing: number;
  readonly yBearing: number;
  readonly width: number;
  readonly height: number;
}

export interface HbGpuDrawEncodeRequest {
  /** Stable identity for one family, font revision, and variation tuple. */
  readonly fontKey: string;
  /** Required on the first request after registration or release for this key. */
  readonly fontBytes?: Uint8Array;
  readonly glyphId: number;
}

export interface HbGpuDrawEncodeResult {
  readonly packedCurveBlob: Uint8Array;
  readonly extents: Readonly<HbGpuGlyphExtents>;
  readonly upem: number;
}

export interface HbGpuDrawEncoder {
  encode(request: Readonly<HbGpuDrawEncodeRequest>): Promise<Readonly<HbGpuDrawEncodeResult>>;
  releaseFont(fontKey: string): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface HbGpuDrawEncoderStats {
  readonly workerStarts: number;
  readonly requests: number;
  readonly encodedGlyphs: number;
  readonly syncedFonts: number;
  readonly queueDepth: number;
  readonly activeRequests: number;
  readonly queuedRequests: number;
  readonly peakQueueDepth: number;
  readonly queueOverflows: number;
}
