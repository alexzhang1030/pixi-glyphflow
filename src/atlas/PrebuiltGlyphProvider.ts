import type {
  GlyphMetrics,
  GlyphMode,
  GlyphRaster,
  PrebuiltGlyphPage,
  PrebuiltGlyphProviderOptions,
  PrebuiltGlyphProviderStats,
  PrebuiltGlyphRecord,
  RasterGlyphRequest,
} from "./types";

interface GlyphSource {
  readonly page: PrebuiltGlyphPage;
  readonly record: PrebuiltGlyphRecord;
  readonly family?: string;
  readonly glyphId?: number;
  readonly glyphText?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string;
  readonly mode?: GlyphMode;
  readonly physicalSize?: number;
}

export class PrebuiltGlyphProvider {
  readonly #pages = new Map<string, PrebuiltGlyphPage>();
  readonly #glyphs = new Map<string, GlyphSource>();
  readonly #byIdentity = new Map<string, GlyphSource[]>();
  readonly #cache = new Map<string, Readonly<GlyphRaster>>();
  #hits = 0;
  #misses = 0;
  #destroyed = false;

  constructor(options: PrebuiltGlyphProviderOptions) {
    for (const page of options.pages) {
      validatePage(page);
      if (this.#pages.has(page.id)) {
        throw new RangeError(`Duplicate prebuilt page id: ${page.id}`);
      }
      this.#pages.set(page.id, page);
    }
    for (const record of options.glyphs) {
      validateRecord(record);
      if (this.#glyphs.has(record.key)) {
        throw new RangeError(`Duplicate prebuilt glyph key: ${record.key}`);
      }
      const page = this.#pages.get(record.pageId);
      if (page === undefined) {
        throw new RangeError(`Prebuilt glyph page is unavailable: ${record.pageId}`);
      }
      if (record.x + record.width > page.width || record.y + record.height > page.height) {
        throw new RangeError(`Prebuilt glyph falls outside page bounds: ${record.key}`);
      }
      const parsed = parsePrebuiltGlyphKey(record.key);
      const source: GlyphSource =
        parsed === undefined
          ? { page, record }
          : {
              page,
              record,
              family: parsed.family,
              glyphId: parsed.glyphId,
              glyphText: parsed.glyphText,
              fontSize: parsed.fontSize,
              fontWeight: parsed.fontWeight,
              mode: parsed.mode,
              physicalSize: parsed.fontSize * (record.metrics?.rasterScale ?? 1),
            };
      this.#glyphs.set(record.key, source);
      if (parsed === undefined) continue;
      const identity = prebuiltIdentityKey(parsed);
      const bucket = this.#byIdentity.get(identity);
      if (bucket === undefined) this.#byIdentity.set(identity, [source]);
      else bucket.push(source);
    }
  }

  lookup(key: string): Readonly<GlyphRaster> | undefined {
    this.#assertActive();
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#hits += 1;
      return cached;
    }
    const source = this.#glyphs.get(key);
    if (source === undefined) return undefined;
    return this.#materialize(source, key, source.record.metrics);
  }

  /**
   * Crop a page whose physical field matches `physicalFontSize`. `charsetSdfPrebuilt` keys the bake
   * logical size (14) while TinySDF intern is `max(fontSize, 48)`. A 13px or 32px first sight of
   * that glyph is still that field.
   */
  lookupPhysical(
    request: Pick<
      RasterGlyphRequest,
      "family" | "glyphId" | "glyphText" | "fontSize" | "fontWeight" | "mode"
    >,
    physicalFontSize: number,
  ): Readonly<GlyphRaster> | undefined {
    this.#assertActive();
    const cacheKey = prebuiltGlyphKey(request);
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      this.#hits += 1;
      return cached;
    }
    const identities = [prebuiltIdentityKey(request)];
    if (request.glyphId !== 0 && isSingleUnicodeScalar(request.glyphText)) {
      identities.push(prebuiltIdentityKey({ ...request, glyphId: 0 }));
    }
    const want = Math.round(physicalFontSize);
    for (const identity of identities) {
      const bucket = this.#byIdentity.get(identity);
      if (bucket === undefined) continue;
      for (const source of bucket) {
        if (source.mode !== request.mode) continue;
        if (source.physicalSize === undefined || Math.round(source.physicalSize) !== want) {
          continue;
        }
        if (source.fontSize === undefined) continue;
        return this.#materialize(
          source,
          cacheKey,
          scaleRecordMetrics(source.record.metrics, source.fontSize, request.fontSize, want),
        );
      }
    }
    return undefined;
  }

  rasterize(key: string): Promise<Readonly<GlyphRaster> | undefined> {
    return Promise.resolve(this.lookup(key));
  }

  get stats(): Readonly<PrebuiltGlyphProviderStats> {
    return Object.freeze({
      glyphs: this.#glyphs.size,
      pages: this.#pages.size,
      cacheEntries: this.#cache.size,
      hits: this.#hits,
      misses: this.#misses,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#pages.clear();
    this.#glyphs.clear();
    this.#byIdentity.clear();
    this.#cache.clear();
    this.#destroyed = true;
  }

  #materialize(
    source: Readonly<GlyphSource>,
    cacheKey: string,
    metrics: Readonly<GlyphMetrics> | undefined,
  ): Readonly<GlyphRaster> {
    this.#misses += 1;
    const channels = channelCount(source.page.mode);
    const { record, page } = source;
    let pixels: Uint8Array;
    if (
      record.x === 0 &&
      record.y === 0 &&
      record.width === page.width &&
      record.height === page.height
    ) {
      pixels = page.pixels;
    } else {
      pixels = new Uint8Array(record.width * record.height * channels);
      for (let row = 0; row < record.height; row += 1) {
        const sourceStart = ((record.y + row) * page.width + record.x) * channels;
        const targetStart = row * record.width * channels;
        pixels.set(
          page.pixels.subarray(sourceStart, sourceStart + record.width * channels),
          targetStart,
        );
      }
    }
    const raster: Readonly<GlyphRaster> = Object.freeze({
      mode: page.mode,
      width: record.width,
      height: record.height,
      pixels,
      ...(metrics === undefined ? {} : { metrics: Object.freeze({ ...metrics }) }),
    });
    this.#cache.set(cacheKey, raster);
    return raster;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("PrebuiltGlyphProvider has been destroyed");
    }
  }
}

/** Bake identity without font revision. Re-registering a family keeps the same page. */
export function prebuiltGlyphKey(
  request: Pick<
    RasterGlyphRequest,
    "family" | "glyphId" | "glyphText" | "fontSize" | "fontWeight" | "mode"
  >,
): string {
  return [
    request.family,
    String(request.glyphId),
    request.glyphText,
    String(Math.round(request.fontSize)),
    request.fontWeight ?? "normal",
    request.mode,
  ].join("\0");
}

function prebuiltIdentityKey(
  request: Pick<RasterGlyphRequest, "family" | "glyphId" | "glyphText" | "mode"> & {
    readonly fontWeight?: string;
  },
): string {
  return [
    request.family,
    String(request.glyphId),
    request.glyphText,
    request.fontWeight ?? "normal",
    request.mode,
  ].join("\0");
}

function parsePrebuiltGlyphKey(key: string):
  | {
      readonly family: string;
      readonly glyphId: number;
      readonly glyphText: string;
      readonly fontSize: number;
      readonly fontWeight: string;
      readonly mode: GlyphMode;
    }
  | undefined {
  const parts = key.split("\0");
  if (parts.length !== 6) return undefined;
  const family = parts[0];
  const glyphIdText = parts[1];
  const glyphText = parts[2];
  const fontSizeText = parts[3];
  const fontWeight = parts[4];
  const mode = parts[5];
  if (
    family === undefined ||
    family.length === 0 ||
    glyphIdText === undefined ||
    glyphText === undefined ||
    glyphText.length === 0 ||
    fontSizeText === undefined ||
    fontWeight === undefined ||
    fontWeight.length === 0 ||
    !isGlyphMode(mode)
  ) {
    return undefined;
  }
  const glyphId = Number(glyphIdText);
  const fontSize = Number(fontSizeText);
  if (!Number.isSafeInteger(glyphId) || glyphId < 0) return undefined;
  if (!Number.isFinite(fontSize) || fontSize <= 0) return undefined;
  return { family, glyphId, glyphText, fontSize, fontWeight, mode };
}

function scaleRecordMetrics(
  metrics: Readonly<GlyphMetrics> | undefined,
  sourceFontSize: number,
  requestFontSize: number,
  physicalFontSize: number,
): Readonly<GlyphMetrics> | undefined {
  if (metrics === undefined) return undefined;
  const ratio = requestFontSize / sourceFontSize;
  const rasterScale = physicalFontSize / requestFontSize;
  return Object.freeze({
    bearingX: metrics.bearingX * ratio,
    bearingY: metrics.bearingY * ratio,
    advance: metrics.advance * ratio,
    ...(metrics.fieldRange === undefined ? {} : { fieldRange: metrics.fieldRange * ratio }),
    ...(rasterScale === 1 ? {} : { rasterScale }),
  });
}

/** One Unicode scalar. Ligatures stay on the exact prebuilt key. */
function isSingleUnicodeScalar(text: string): boolean {
  return [...text].length === 1;
}

function isGlyphMode(mode: string | undefined): mode is GlyphMode {
  return mode === "msdf" || mode === "sdf" || mode === "alpha" || mode === "color";
}

function validatePage(page: PrebuiltGlyphPage): void {
  assertNonEmpty("page.id", page.id);
  assertMode(page.mode);
  assertPositiveInteger("page.width", page.width);
  assertPositiveInteger("page.height", page.height);
  if (!(page.pixels instanceof Uint8Array)) {
    throw new TypeError("Prebuilt page pixels must be a Uint8Array");
  }
  const expected = page.width * page.height * channelCount(page.mode);
  if (page.pixels.byteLength !== expected) {
    throw new TypeError(`Prebuilt page ${page.id} contains an invalid pixel byte length`);
  }
}

function validateRecord(record: PrebuiltGlyphRecord): void {
  assertNonEmpty("glyph.key", record.key);
  assertNonEmpty("glyph.pageId", record.pageId);
  assertNonNegativeInteger("glyph.x", record.x);
  assertNonNegativeInteger("glyph.y", record.y);
  assertPositiveInteger("glyph.width", record.width);
  assertPositiveInteger("glyph.height", record.height);
  if (record.metrics !== undefined) validateMetrics(record.metrics);
}

function validateMetrics(metrics: GlyphMetrics): void {
  if (
    !Number.isFinite(metrics.bearingX) ||
    !Number.isFinite(metrics.bearingY) ||
    !Number.isFinite(metrics.advance) ||
    (metrics.fieldRange !== undefined &&
      (!Number.isFinite(metrics.fieldRange) || metrics.fieldRange < 0)) ||
    (metrics.rasterScale !== undefined &&
      (!Number.isFinite(metrics.rasterScale) || metrics.rasterScale < 1))
  ) {
    throw new TypeError("Prebuilt glyph metrics must contain finite values");
  }
}

function channelCount(mode: PrebuiltGlyphPage["mode"]): number {
  return mode === "sdf" || mode === "alpha" ? 1 : 4;
}

function assertMode(mode: string): void {
  if (mode !== "msdf" && mode !== "sdf" && mode !== "alpha" && mode !== "color") {
    throw new TypeError("Prebuilt page mode is unsupported");
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}
