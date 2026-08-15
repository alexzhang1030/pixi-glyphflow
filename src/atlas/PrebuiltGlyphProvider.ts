import type {
  GlyphMetrics,
  GlyphRaster,
  PrebuiltGlyphPage,
  PrebuiltGlyphProviderOptions,
  PrebuiltGlyphProviderStats,
  PrebuiltGlyphRecord,
} from "./types";

interface GlyphSource {
  readonly page: PrebuiltGlyphPage;
  readonly record: PrebuiltGlyphRecord;
}

export class PrebuiltGlyphProvider {
  readonly #pages = new Map<string, PrebuiltGlyphPage>();
  readonly #glyphs = new Map<string, GlyphSource>();
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
      this.#glyphs.set(record.key, { page, record });
    }
  }

  rasterize(key: string): Promise<Readonly<GlyphRaster> | undefined> {
    this.#assertActive();
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#hits += 1;
      return Promise.resolve(cached);
    }
    const source = this.#glyphs.get(key);
    if (source === undefined) {
      return Promise.resolve(undefined);
    }

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
      ...(record.metrics === undefined ? {} : { metrics: Object.freeze({ ...record.metrics }) }),
    });
    this.#cache.set(key, raster);

    return Promise.resolve(raster);
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
    this.#cache.clear();
    this.#destroyed = true;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("PrebuiltGlyphProvider has been destroyed");
    }
  }
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
