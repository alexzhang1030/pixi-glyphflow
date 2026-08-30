export interface OutlineGlyphExtents {
  readonly xBearing: number;
  readonly yBearing: number;
  readonly width: number;
  readonly height: number;
}

export interface OutlineQuadMetadata {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

export interface PackedOutlineGlyphInput {
  readonly extents: Readonly<OutlineGlyphExtents>;
  readonly packedCurveBlob: Uint8Array;
}

export interface OutlinePrepareOptions {
  readonly maxBlobBytes?: number;
  readonly maxBands?: number;
  readonly maxCurves?: number;
  readonly maxCurveReferences?: number;
}

export interface PreparedOutlineGlyph {
  readonly quad: Readonly<OutlineQuadMetadata>;
  readonly unitsPerEmX: number;
  readonly unitsPerEmY: number;
  readonly horizontalBandCount: number;
  readonly verticalBandCount: number;
  readonly curveCount: number;
  /** Eight f32 values per quadratic: p0, p1, p2, then two reserved values. */
  readonly curveStorage: Float32Array;
  /** Four-word header, four words per band, then ordered curve-index lists. */
  readonly spatialLookup: Int32Array;
}

export type OutlinePreparationResult =
  | Readonly<{ status: "ready"; glyph: Readonly<PreparedOutlineGlyph> }>
  | Readonly<{ status: "empty"; quad: Readonly<OutlineQuadMetadata> }>
  | Readonly<{
      status: "unsupported";
      reason: "resource-limits";
      limit: "blob-bytes" | "bands" | "curves" | "curve-references";
    }>;

export type OutlineColor = readonly [red: number, green: number, blue: number, alpha: number];

export interface OutlineRasterOptions {
  readonly pixelHeight: number;
  readonly padding?: number;
  readonly color?: OutlineColor;
}

export interface OutlineCpuBitmap {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly pixels: Uint8Array;
}

export type OutlineComputeUnsupportedReason =
  | "webgpu-unavailable"
  | "device-limits"
  | "atlas-too-large";

export type OutlineComputeCapability =
  | Readonly<{
      status: "supported";
      maxTextureDimension2D: number;
      maxStorageBufferBindingSize: number;
      maxComputeWorkgroupsPerDimension: number;
    }>
  | Readonly<{ status: "unsupported"; reason: OutlineComputeUnsupportedReason }>;

export interface OutlineRouteInput {
  readonly mode: "auto" | "outline";
  readonly projectedHeightPx: number;
  readonly projectedSizeThresholdPx: number;
  readonly capability: Readonly<OutlineComputeCapability>;
}

export type OutlineRoute =
  | Readonly<{ path: "outline" }>
  | Readonly<{
      path: "atlas";
      reason: "outline-disabled" | "below-projected-threshold" | "capability-unavailable";
    }>;

export interface OutlinePackedGlyphRequest {
  readonly family: string;
  readonly fontRevision: number;
  readonly glyphId: number;
  readonly variationKey?: string;
}

export type OutlinePackedGlyphSource = (
  request: Readonly<OutlinePackedGlyphRequest>,
) =>
  | Readonly<PackedOutlineGlyphInput>
  | undefined
  | PromiseLike<Readonly<PackedOutlineGlyphInput> | undefined>;

export interface OutlineRenderingOptions {
  readonly source: OutlinePackedGlyphSource;
  readonly device?: GPUDevice;
  /** A supplied rasterizer is owned and destroyed by the plugin. */
  readonly rasterizer?: OutlineComputeRasterizer;
  readonly projectedSizeThresholdPx?: number;
  readonly padding?: number;
  readonly color?: OutlineColor;
  readonly prepareOptions?: Readonly<OutlinePrepareOptions>;
  readonly preparedCacheEntries?: number;
}

export interface OutlineRenderingRasterRequest extends OutlinePackedGlyphRequest {
  /** Logical em size used to convert packed font units into layout units. */
  readonly fontSize: number;
  readonly projectedHeightPx: number;
  /**
   * Cacheable physical raster bucket. Defaults to the power-of-two bucket at or above
   * projectedHeightPx.
   */
  readonly rasterPixelHeight?: number;
  readonly padding?: number;
  readonly color?: OutlineColor;
  /** Positioned-run advance retained for generic GlyphMetrics compatibility. */
  readonly advance?: number;
}

export interface OutlineRasterMetrics {
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
  readonly rasterScale: number;
}

export interface OutlineExternalColorSource {
  readonly texture: GPUTexture;
  readonly format: "rgba8unorm";
  readonly width: number;
  readonly height: number;
}

/** One ref-counted view into a microtask-batched compute atlas. */
export interface OutlineExternalColorRaster {
  readonly mode: "color";
  readonly width: number;
  readonly height: number;
  readonly source: Readonly<OutlineExternalColorSource>;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly padding: number;
  readonly scale: number;
  readonly quad: Readonly<OutlineQuadMetadata>;
  readonly metrics: Readonly<OutlineRasterMetrics>;
  release(): void;
}

export type OutlineRenderingFallbackReason =
  | "below-projected-threshold"
  | "capability-unavailable"
  | "packed-source-unavailable"
  | "resource-limits"
  | "device-limits"
  | "atlas-too-large";

export type OutlineRenderingFailureReason =
  | "packed-source"
  | "invalid-packed-outline"
  | "shader-compilation"
  | "device-error"
  | "destroyed";

export type OutlineRenderingResult =
  | Readonly<{ status: "ready"; raster: Readonly<OutlineExternalColorRaster> }>
  | Readonly<{ status: "empty"; quad: Readonly<OutlineQuadMetadata> }>
  | Readonly<{
      status: "fallback";
      reason: OutlineRenderingFallbackReason;
      limit?: "blob-bytes" | "bands" | "curves" | "curve-references";
    }>
  | Readonly<{
      status: "failed";
      reason: OutlineRenderingFailureReason;
      message: string;
    }>;

export interface OutlineRenderingPlugin {
  readonly capability: Readonly<OutlineComputeCapability>;
  readonly projectedSizeThresholdPx: number;
  route(projectedHeightPx: number): Readonly<OutlineRoute>;
  /** Stable physical-size bucket used by cache identities and compute raster requests. */
  rasterPixelHeight(projectedHeightPx: number): number;
  rasterize(
    request: Readonly<OutlineRenderingRasterRequest>,
  ): Promise<Readonly<OutlineRenderingResult>>;
  destroy(): void;
}

export interface OutlineComputeRasterRequest extends OutlineRasterOptions {
  readonly glyph: Readonly<PreparedOutlineGlyph>;
}

export interface OutlineColorAtlasEntry {
  readonly requestIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly padding: number;
  readonly scale: number;
  readonly quad: Readonly<OutlineQuadMetadata>;
}

export interface OutlineColorAtlas {
  readonly texture: GPUTexture;
  readonly format: "rgba8unorm";
  readonly width: number;
  readonly height: number;
  readonly entries: readonly Readonly<OutlineColorAtlasEntry>[];
  destroy(): void;
}

export type OutlineComputeRasterResult =
  | Readonly<{ status: "ready"; atlas: OutlineColorAtlas }>
  | Readonly<{ status: "empty"; entries: readonly [] }>
  | Readonly<{
      status: "unsupported";
      capability: Readonly<Extract<OutlineComputeCapability, { status: "unsupported" }>>;
    }>
  | Readonly<{
      status: "failed";
      reason: "shader-compilation" | "device-error" | "destroyed";
      message: string;
    }>;

export interface OutlineComputeRasterizer {
  readonly capability: Readonly<OutlineComputeCapability>;
  rasterize(
    requests: readonly Readonly<OutlineComputeRasterRequest>[],
  ): Promise<Readonly<OutlineComputeRasterResult>>;
  destroy(): void;
}
