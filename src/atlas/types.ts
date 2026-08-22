import type { TextStyleFontWeight } from "pixi.js";

export type GlyphMode = "msdf" | "sdf" | "alpha" | "color";

/** Atlas cache identity. Live-path keys are packed integers; strings remain valid. */
export type GlyphCacheKey = string | number;

export interface GlyphRequest {
  readonly key: GlyphCacheKey;
  readonly generation: number;
}

export interface GlyphRaster {
  readonly mode: GlyphMode;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly metrics?: Readonly<GlyphMetrics>;
}

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

export interface AtlasPageInfo {
  readonly id: number;
  readonly mode: GlyphMode;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface AtlasCommit {
  readonly entries: readonly Readonly<AtlasEntry>[];
  readonly uploads: readonly Readonly<AtlasUpload>[];
  readonly evictedKeys: readonly GlyphCacheKey[];
}

export interface GlyphAtlasOptions {
  readonly pageWidth?: number;
  readonly pageHeight?: number;
  readonly maxBytes?: number;
}

export interface GlyphAtlasStats {
  readonly entries: number;
  readonly pendingEntries: number;
  readonly pages: number;
  readonly allocatedBytes: number;
  readonly pinnedEntries: number;
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
}

export interface PrebuiltGlyphProviderStats {
  readonly glyphs: number;
  readonly pages: number;
  readonly cacheEntries: number;
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
  /** Minimum MSDF/SDF rasterization size. Defaults to 48px for small-glyph detail. */
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
   * and omit font revision.
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
