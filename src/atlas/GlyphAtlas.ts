import { Packer, type PackedRectangle } from "./Packer";
import type {
  AtlasCommit,
  AtlasEntry,
  AtlasUpload,
  GlyphAtlasOptions,
  GlyphAtlasStats,
  GlyphMode,
  GlyphRaster,
  GlyphRequest,
} from "./types";

interface AtlasPage {
  readonly id: number;
  readonly mode: GlyphMode;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly packer: Packer;
}

interface PendingGlyph {
  readonly entry: Readonly<AtlasEntry>;
  readonly pixels: Uint8Array;
}

const DEFAULT_PAGE_SIZE = 1_024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class GlyphAtlas {
  readonly #pageWidth: number;
  readonly #pageHeight: number;
  readonly #maxBytes: number;
  readonly #pages: AtlasPage[] = [];
  readonly #entries = new Map<string, Readonly<AtlasEntry>>();
  readonly #pending = new Map<string, PendingGlyph>();
  readonly #requestGenerations = new Map<string, number>();
  readonly #lastUsed = new Map<string, number>();
  readonly #pins = new Set<string>();
  readonly #evictedSinceCommit: string[] = [];
  #clock = 0;
  #allocatedBytes = 0;
  #requests = 0;
  #stagedResults = 0;
  #staleResults = 0;
  #evictions = 0;
  #capacityFailures = 0;
  #commits = 0;
  #destroyed = false;

  constructor(options: GlyphAtlasOptions = {}) {
    this.#pageWidth = options.pageWidth ?? DEFAULT_PAGE_SIZE;
    this.#pageHeight = options.pageHeight ?? DEFAULT_PAGE_SIZE;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    assertPositiveInteger("pageWidth", this.#pageWidth);
    assertPositiveInteger("pageHeight", this.#pageHeight);
    assertPositiveInteger("maxBytes", this.#maxBytes);
  }

  request(key: string): Readonly<GlyphRequest> {
    this.#assertActive();
    assertKey(key);
    const previous = this.#requestGenerations.get(key) ?? 0;
    if (previous === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Glyph request generation exhausted: ${key}`);
    }
    const generation = previous + 1;
    this.#requestGenerations.set(key, generation);
    this.#requests += 1;

    return Object.freeze({ key, generation });
  }

  stage(request: GlyphRequest, raster: GlyphRaster): boolean {
    this.#assertActive();
    assertKey(request.key);
    assertPositiveInteger("request.generation", request.generation);
    assertRaster(raster, this.#pageWidth, this.#pageHeight);
    if (this.#requestGenerations.get(request.key) !== request.generation) {
      this.#staleResults += 1;
      return false;
    }

    const previousPending = this.#pending.get(request.key);
    if (previousPending !== undefined) {
      this.#releaseEntry(previousPending.entry);
      this.#pending.delete(request.key);
    }
    const placement = this.#allocate(raster.mode, raster.width, raster.height, request.key);
    if (placement === undefined) {
      this.#capacityFailures += 1;
      return false;
    }
    const { page, rectangle } = placement;
    const entry = Object.freeze({
      key: request.key,
      generation: request.generation,
      page: page.id,
      mode: raster.mode,
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
      u0: rectangle.x / page.width,
      v0: rectangle.y / page.height,
      u1: (rectangle.x + rectangle.width) / page.width,
      v1: (rectangle.y + rectangle.height) / page.height,
      ...(raster.metrics === undefined ? {} : { metrics: Object.freeze({ ...raster.metrics }) }),
    });
    this.#pending.set(request.key, { entry, pixels: raster.pixels });
    this.#stagedResults += 1;

    return true;
  }

  commitFrame(): Readonly<AtlasCommit> {
    this.#assertActive();
    const entries: Readonly<AtlasEntry>[] = [];
    const uploads: Readonly<AtlasUpload>[] = [];
    for (const pending of this.#pending.values()) {
      const current = this.#entries.get(pending.entry.key);
      if (current !== undefined) {
        this.#releaseEntry(current);
      }
      this.#entries.set(pending.entry.key, pending.entry);
      this.#touch(pending.entry.key);
      entries.push(pending.entry);
      uploads.push(Object.freeze({ entry: pending.entry, pixels: pending.pixels }));
    }
    this.#pending.clear();
    const evictedKeys = Object.freeze([...this.#evictedSinceCommit]);
    this.#evictedSinceCommit.length = 0;
    if (entries.length > 0 || evictedKeys.length > 0) {
      this.#commits += 1;
    }

    return Object.freeze({
      entries: Object.freeze(entries),
      uploads: Object.freeze(uploads),
      evictedKeys,
    });
  }

  get(key: string): Readonly<AtlasEntry> | undefined {
    this.#assertActive();
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#touch(key);
    }

    return entry;
  }

  pin(key: string): boolean {
    this.#assertActive();
    assertKey(key);
    const size = this.#pins.size;
    this.#pins.add(key);

    return this.#pins.size !== size;
  }

  unpin(key: string): boolean {
    this.#assertActive();
    return this.#pins.delete(key);
  }

  get stats(): Readonly<GlyphAtlasStats> {
    return Object.freeze({
      entries: this.#entries.size,
      pendingEntries: this.#pending.size,
      pages: this.#pages.length,
      allocatedBytes: this.#allocatedBytes,
      pinnedEntries: this.#pins.size,
      requests: this.#requests,
      stagedResults: this.#stagedResults,
      staleResults: this.#staleResults,
      evictions: this.#evictions,
      capacityFailures: this.#capacityFailures,
      commits: this.#commits,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#pages.length = 0;
    this.#entries.clear();
    this.#pending.clear();
    this.#requestGenerations.clear();
    this.#lastUsed.clear();
    this.#pins.clear();
    this.#evictedSinceCommit.length = 0;
    this.#allocatedBytes = 0;
    this.#destroyed = true;
  }

  #allocate(
    mode: GlyphMode,
    width: number,
    height: number,
    protectedKey: string,
  ): { readonly page: AtlasPage; readonly rectangle: Readonly<PackedRectangle> } | undefined {
    let placement = this.#tryPages(mode, width, height);
    if (placement !== undefined) {
      return placement;
    }

    const page = this.#createPage(mode);
    if (page !== undefined) {
      const rectangle = page.packer.allocate(width, height);
      if (rectangle !== undefined) {
        return { page, rectangle };
      }
    }

    while (this.#evictOldest(mode, protectedKey)) {
      placement = this.#tryPages(mode, width, height);
      if (placement !== undefined) {
        return placement;
      }
    }

    return undefined;
  }

  #tryPages(
    mode: GlyphMode,
    width: number,
    height: number,
  ): { readonly page: AtlasPage; readonly rectangle: Readonly<PackedRectangle> } | undefined {
    for (const page of this.#pages) {
      if (page.mode !== mode) continue;
      const rectangle = page.packer.allocate(width, height);
      if (rectangle !== undefined) {
        return { page, rectangle };
      }
    }

    return undefined;
  }

  #createPage(mode: GlyphMode): AtlasPage | undefined {
    const bytes = this.#pageWidth * this.#pageHeight * bytesPerPixel(mode);
    if (this.#allocatedBytes + bytes > this.#maxBytes) {
      return undefined;
    }
    const page: AtlasPage = {
      id: this.#pages.length,
      mode,
      width: this.#pageWidth,
      height: this.#pageHeight,
      bytes,
      packer: new Packer(this.#pageWidth, this.#pageHeight),
    };
    this.#pages.push(page);
    this.#allocatedBytes += bytes;

    return page;
  }

  #evictOldest(mode: GlyphMode, protectedKey: string): boolean {
    let candidate: string | undefined;
    let candidateClock = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (
        key === protectedKey ||
        entry.mode !== mode ||
        this.#pins.has(key) ||
        this.#pending.has(key)
      ) {
        continue;
      }
      const clock = this.#lastUsed.get(key) ?? 0;
      if (clock < candidateClock) {
        candidate = key;
        candidateClock = clock;
      }
    }
    if (candidate === undefined) {
      return false;
    }

    const entry = this.#entries.get(candidate);
    if (entry === undefined) {
      return false;
    }
    this.#releaseEntry(entry);
    this.#entries.delete(candidate);
    this.#lastUsed.delete(candidate);
    this.#evictedSinceCommit.push(candidate);
    this.#evictions += 1;

    return true;
  }

  #releaseEntry(entry: AtlasEntry): void {
    const page = this.#pages[entry.page];
    if (page === undefined) {
      throw new Error(`Atlas page ${String(entry.page)} is unavailable`);
    }
    page.packer.release(entry);
  }

  #touch(key: string): void {
    this.#clock += 1;
    this.#lastUsed.set(key, this.#clock);
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("GlyphAtlas has been destroyed");
    }
  }
}

function bytesPerPixel(mode: GlyphMode): number {
  return mode === "sdf" || mode === "alpha" ? 1 : 4;
}

function assertRaster(raster: GlyphRaster, pageWidth: number, pageHeight: number): void {
  if (
    raster.mode !== "msdf" &&
    raster.mode !== "sdf" &&
    raster.mode !== "alpha" &&
    raster.mode !== "color"
  ) {
    throw new TypeError("Glyph raster mode is unsupported");
  }
  assertPositiveInteger("raster.width", raster.width);
  assertPositiveInteger("raster.height", raster.height);
  if (raster.width > pageWidth || raster.height > pageHeight) {
    throw new RangeError("Glyph raster exceeds the atlas page dimensions");
  }
  if (!(raster.pixels instanceof Uint8Array)) {
    throw new TypeError("Glyph raster pixels must be a Uint8Array");
  }
  const expectedBytes = raster.width * raster.height * bytesPerPixel(raster.mode);
  if (raster.pixels.byteLength !== expectedBytes) {
    throw new TypeError(
      `Glyph raster contains ${String(raster.pixels.byteLength)} bytes; expected ${String(expectedBytes)}`,
    );
  }
  if (raster.metrics !== undefined) {
    assertMetrics(raster.metrics);
  }
}

function assertMetrics(metrics: NonNullable<GlyphRaster["metrics"]>): void {
  if (
    !Number.isFinite(metrics.bearingX) ||
    !Number.isFinite(metrics.bearingY) ||
    !Number.isFinite(metrics.advance) ||
    (metrics.fieldRange !== undefined &&
      (!Number.isFinite(metrics.fieldRange) || metrics.fieldRange < 0))
  ) {
    throw new TypeError("Glyph metrics must contain finite values");
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Glyph key must be a non-empty string");
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}
