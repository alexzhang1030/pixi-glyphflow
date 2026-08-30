import type { TextStyleFontWeight } from "pixi.js";

export type GlyphMode = "msdf" | "sdf" | "alpha" | "color";

/** Max layers per same-format atlas array. WebGL 2 guarantees at least 256. */
export const GLYPH_ATLAS_ARRAY_LAYERS: number = 256;

/** R8 pages (sdf/alpha) and RGBA pages (msdf/color) cannot share one texture array. */
export function atlasArrayKind(mode: GlyphMode): "r" | "rgba" {
  return mode === "alpha" || mode === "sdf" ? "r" : "rgba";
}

/** Atlas cache identity. Live-path keys are packed integers; strings remain valid. */
export type GlyphCacheKey = string | number;

export interface GlyphRequest {
  readonly key: GlyphCacheKey;
  readonly generation: number;
}

/** Internal render lifetime shared by every glyph request prepared by one coordinator ticket. */
export interface RenderTokenScope {
  readonly lifecycleEpoch: number;
  readonly commitTicket: number;
  readonly fontRegistryRevision: number;
  readonly destinationIdentity: object;
}

/** Internal value object carried from raster continuation through the atlas frame boundary. */
export interface RenderToken extends GlyphRequest, RenderTokenScope {
  readonly sourceRevision: number;
}

/** @internal Signals provider disposal while an owning render lifetime is retiring. */
export class RasterProviderDisposedError extends Error {
  constructor(message = "RasterGlyphProvider has been destroyed") {
    super(message);
  }
}

/** @internal Exact identity for one coordinator frame boundary. */
export function sameRenderScope(
  left: Readonly<RenderTokenScope>,
  right: Readonly<RenderTokenScope>,
): boolean {
  return (
    left.lifecycleEpoch === right.lifecycleEpoch &&
    left.commitTicket === right.commitTicket &&
    left.fontRegistryRevision === right.fontRegistryRevision &&
    left.destinationIdentity === right.destinationIdentity
  );
}

export interface GlyphRaster {
  readonly mode: GlyphMode;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly metrics?: Readonly<GlyphMetrics>;
}

/** WebGPU-owned RGBA source whose sub-rectangle is copied into a color atlas page. */
export interface ExternalColorGlyphRaster {
  readonly mode: "color";
  readonly width: number;
  readonly height: number;
  readonly source: Readonly<{
    readonly texture: GPUTexture;
    readonly format: "rgba8unorm";
    readonly width: number;
    readonly height: number;
  }>;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly metrics?: Readonly<GlyphMetrics>;
  /** Idempotent ownership release supplied by the producing rasterizer. */
  release(): void;
}

/** CPU rasters and opt-in GPU color rasters accepted by the atlas staging seam. */
export type AtlasGlyphRaster = GlyphRaster | ExternalColorGlyphRaster;

export interface GlyphMetrics {
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
  readonly fieldRange?: number;
  /** Physical atlas pixels per logical layout unit. Defaults to 1. */
  readonly rasterScale?: number;
}

export interface AtlasEntry {
  readonly key: GlyphCacheKey;
  readonly generation: number;
  readonly page: number;
  /** Layer among same-format pages. Packed into instance metadata for the array shader. */
  readonly layer: number;
  readonly mode: GlyphMode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly metrics?: Readonly<GlyphMetrics>;
}

export interface AtlasUpload {
  readonly entry: Readonly<AtlasEntry>;
  readonly pixels: Uint8Array;
}

/** Ownership transfers to the atlas-commit consumer until eviction or surface destruction. */
export interface AtlasExternalUpload {
  readonly entry: Readonly<AtlasEntry>;
  readonly source: Readonly<ExternalColorGlyphRaster["source"]>;
  readonly sourceX: number;
  readonly sourceY: number;
  release(): void;
}

export interface AtlasPageInfo {
  readonly id: number;
  readonly mode: GlyphMode;
  readonly layer: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface AtlasCommit {
  readonly entries: readonly Readonly<AtlasEntry>[];
  readonly uploads: readonly Readonly<AtlasUpload>[];
  readonly externalUploads: readonly Readonly<AtlasExternalUpload>[];
  readonly evictedKeys: readonly GlyphCacheKey[];
}

export interface GlyphAtlasOptions {
  readonly pageWidth?: number;
  readonly pageHeight?: number;
  readonly maxBytes?: number;
  /** Bound for request-generation identities retained across atlas lifetimes. */
  readonly requestGenerationCacheEntries?: number;
}

export interface GlyphAtlasStats {
  readonly entries: number;
  readonly pendingEntries: number;
  readonly pages: number;
  readonly allocatedBytes: number;
  readonly pinnedEntries: number;
  readonly requestGenerationEntries: number;
  readonly requestGenerationProtectedEntries: number;
  readonly requestGenerationTombstones: number;
  readonly requestGenerationEvictions: number;
  readonly requests: number;
  readonly stagedResults: number;
  readonly staleResults: number;
  readonly evictions: number;
  readonly capacityFailures: number;
  readonly commits: number;
}

export interface PrebuiltGlyphPage {
  readonly id: string;
  readonly mode: GlyphMode;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface PrebuiltGlyphRecord {
  readonly key: string;
  readonly pageId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly metrics?: Readonly<GlyphMetrics>;
}

export interface PrebuiltGlyphProviderOptions {
  readonly pages: readonly PrebuiltGlyphPage[];
  readonly glyphs: readonly PrebuiltGlyphRecord[];
  readonly materializationCacheEntries?: number;
  readonly materializationCacheBytes?: number;
  readonly materializationCachePolicy?: "lru" | "fifo";
}

export interface PrebuiltGlyphProviderStats {
  readonly glyphs: number;
  readonly pages: number;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly cacheEvictions: number;
  readonly cacheEvictedBytes: number;
  readonly hits: number;
  readonly misses: number;
}

export interface RasterGlyphRequest {
  readonly family: string;
  /** Ordered CSS family stack used by alpha/color canvas rasterization. */
  readonly fontFamilies?: readonly string[];
  readonly fontRevision: number;
  readonly glyphId: number;
  readonly glyphText: string;
  /** Canonical sorted OpenType variation-axis identity from shaping. */
  readonly variationKey?: string;
  readonly fontSize: number;
  readonly fontWeight?: TextStyleFontWeight;
  readonly mode: GlyphMode;
}

export interface MsdfGlyphInfoLike {
  readonly char: string;
  readonly atlasPosition: readonly [number, number];
  readonly atlasSize: readonly [number, number];
  readonly bounds: Readonly<{
    left: number;
    bottom: number;
    right: number;
    top: number;
  }>;
  readonly advance: number;
}

export interface MsdfAtlasLike {
  readonly texture: Readonly<{
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
  }>;
  readonly glyphs: readonly MsdfGlyphInfoLike[];
  readonly fieldRange: number;
}

export interface MsdfGeneratorLike {
  initialize?(): Promise<void>;
  generateAtlas(options: Readonly<Record<string, unknown>>): Promise<MsdfAtlasLike>;
  dispose(): Promise<void>;
}

export interface RasterGlyphProviderOptions {
  readonly cacheSize?: number;
  /** Parallel lazy MSDF workers. Browser defaults use up to four hardware threads. */
  readonly generatorConcurrency?: number;
  /**
   * Minimum MSDF/SDF rasterization size. Defaults to 48px for small-glyph detail. Logical sizes
   * that clamp to the same physical size intern one field and store `rasterScale` per request.
   */
  readonly distanceFieldMinFontSize?: number;
  readonly canvasRasterizer?: (request: RasterGlyphRequest) => Promise<GlyphRaster>;
  readonly createMsdfGenerator?: () => Promise<MsdfGeneratorLike>;
  /**
   * Use a local TinySDF field for HarfBuzz glyphs instead of `@zappar/msdf-generator`. Changes
   * pixels (MSDF → SDF). Default is false.
   */
  readonly tinySdf?: boolean;
  /**
   * Serve known glyphs from packed pages before TinySDF or MSDF. Record keys use `prebuiltGlyphKey`
   * and omit font revision. A miss with a non-zero glyph id retries `glyphId: 0` when `glyphText`
   * is a single Unicode scalar so a family page can ignore HarfBuzz ids. A later miss whose
   * physical size (`max(fontSize, distanceFieldMinFontSize)`) matches a baked field's `fontSize *
   * (rasterScale ?? 1)` crops that field and interns it. Sizes above the minimum still generate.
   */
  readonly prebuilt?: PrebuiltGlyphProviderOptions;
}

export interface RasterGlyphProviderStats {
  readonly cacheEntries: number;
  readonly pending: number;
  readonly hits: number;
  readonly misses: number;
  readonly canvasRasters: number;
  readonly distanceFieldRasters: number;
  readonly tinySdfRasters: number;
  readonly prebuiltHits: number;
  readonly generatorStarts: number;
}
