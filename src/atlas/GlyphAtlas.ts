import { Packer, type PackedRectangle } from "./Packer";
import {
  atlasArrayKind,
  GLYPH_ATLAS_ARRAY_LAYERS,
  type AtlasCommit,
  type AtlasEntry,
  type AtlasPageInfo,
  type AtlasUpload,
  type GlyphAtlasOptions,
  type GlyphAtlasStats,
  type GlyphCacheKey,
  type GlyphMode,
  type GlyphRaster,
  type GlyphRequest,
} from "./types";

interface AtlasPage {
  readonly id: number;
  readonly mode: GlyphMode;
  readonly layer: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly packer: Packer;
}

interface PendingGlyph {
  readonly entry: Readonly<AtlasEntry>;
  readonly pixels: Uint8Array;
}

interface LruNode {
  readonly key: GlyphCacheKey;
  prev: LruNode | undefined;
  next: LruNode | undefined;
}

interface LruList {
  head: LruNode | undefined;
  tail: LruNode | undefined;
}

const DEFAULT_PAGE_SIZE = 1_024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class GlyphAtlas {
  readonly #pageWidth: number;
  readonly #pageHeight: number;
  readonly #maxBytes: number;
  readonly #pages: AtlasPage[] = [];
  readonly #entries = new Map<GlyphCacheKey, Readonly<AtlasEntry>>();
  readonly #pending = new Map<GlyphCacheKey, PendingGlyph>();
  readonly #requestGenerations = new Map<GlyphCacheKey, number>();
  readonly #lruNodes = new Map<GlyphCacheKey, LruNode>();
  readonly #lruByMode: Record<GlyphMode, LruList> = {
    msdf: { head: undefined, tail: undefined },
    sdf: { head: undefined, tail: undefined },
    alpha: { head: undefined, tail: undefined },
    color: { head: undefined, tail: undefined },
  };
  readonly #pins = new Set<GlyphCacheKey>();
  readonly #evictedSinceCommit: GlyphCacheKey[] = [];
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

  request(key: GlyphCacheKey): Readonly<GlyphRequest> {
    this.#assertActive();
    assertKey(key);
    const previous = this.#requestGenerations.get(key) ?? 0;
    if (previous === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Glyph request generation exhausted: ${String(key)}`);
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
      layer: page.layer,
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
      this.#touch(pending.entry.key, pending.entry.mode);
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

  get(key: GlyphCacheKey): Readonly<AtlasEntry> | undefined {
    this.#assertActive();
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#touch(key, entry.mode);
    }

    return entry;
  }

  getPage(page: number): Readonly<AtlasPageInfo> | undefined {
    this.#assertActive();
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new TypeError("Atlas page must be a non-negative safe integer");
    }
    const value = this.#pages[page];
    if (value === undefined) return undefined;

    return Object.freeze({
      id: value.id,
      mode: value.mode,
      layer: value.layer,
      width: value.width,
      height: value.height,
      bytes: value.bytes,
    });
  }

  pin(key: GlyphCacheKey): boolean {
    this.#assertActive();
    assertKey(key);
    const size = this.#pins.size;
    this.#pins.add(key);
    if (this.#pins.size !== size) {
      this.#detachLru(key);
    }

    return this.#pins.size !== size;
  }

  unpin(key: GlyphCacheKey): boolean {
    this.#assertActive();
    if (!this.#pins.delete(key)) {
      return false;
    }
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#touch(key, entry.mode);
    }
    return true;
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
    this.#lruNodes.clear();
    this.#lruByMode.msdf = { head: undefined, tail: undefined };
    this.#lruByMode.sdf = { head: undefined, tail: undefined };
    this.#lruByMode.alpha = { head: undefined, tail: undefined };
    this.#lruByMode.color = { head: undefined, tail: undefined };
    this.#pins.clear();
    this.#evictedSinceCommit.length = 0;
    this.#allocatedBytes = 0;
    this.#destroyed = true;
  }

  #allocate(
    mode: GlyphMode,
    width: number,
    height: number,
    protectedKey: GlyphCacheKey,
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
    const kind = atlasArrayKind(mode);
    let layer = 0;
    for (const page of this.#pages) {
      if (atlasArrayKind(page.mode) === kind) layer += 1;
    }
    if (layer >= GLYPH_ATLAS_ARRAY_LAYERS) {
      return undefined;
    }
    const page: AtlasPage = {
      id: this.#pages.length,
      mode,
      layer,
      width: this.#pageWidth,
      height: this.#pageHeight,
      bytes,
      packer: new Packer(this.#pageWidth, this.#pageHeight),
    };
    this.#pages.push(page);
    this.#allocatedBytes += bytes;

    return page;
  }

  #evictOldest(mode: GlyphMode, protectedKey: GlyphCacheKey): boolean {
    let node = this.#lruByMode[mode].head;
    while (node !== undefined) {
      const key = node.key;
      const next = node.next;
      if (key !== protectedKey && !this.#pending.has(key) && !this.#pins.has(key)) {
        const entry = this.#entries.get(key);
        if (entry !== undefined && entry.mode === mode) {
          this.#releaseEntry(entry);
          this.#entries.delete(key);
          this.#detachLru(key);
          this.#evictedSinceCommit.push(key);
          this.#evictions += 1;
          return true;
        }
      }
      node = next;
    }
    return false;
  }

  #releaseEntry(entry: AtlasEntry): void {
    const page = this.#pages[entry.page];
    if (page === undefined) {
      throw new Error(`Atlas page ${String(entry.page)} is unavailable`);
    }
    this.#detachLru(entry.key);
    page.packer.release(entry);
  }

  #touch(key: GlyphCacheKey, mode?: GlyphMode): void {
    const resolvedMode = mode ?? this.#entries.get(key)?.mode;
    if (resolvedMode === undefined || this.#pins.has(key)) {
      return;
    }
    const list = this.#lruByMode[resolvedMode];
    const existing = this.#lruNodes.get(key);
    if (existing !== undefined) {
      if (existing === list.tail) {
        return;
      }
      this.#unlink(list, existing);
      this.#append(list, existing);
      return;
    }
    const node: LruNode = { key, prev: undefined, next: undefined };
    this.#lruNodes.set(key, node);
    this.#append(list, node);
  }

  #detachLru(key: GlyphCacheKey): void {
    const node = this.#lruNodes.get(key);
    if (node === undefined) {
      return;
    }
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#unlink(this.#lruByMode[entry.mode], node);
    } else {
      for (const list of Object.values(this.#lruByMode)) {
        if (list.head === node || node.prev !== undefined || node.next !== undefined) {
          this.#unlink(list, node);
          break;
        }
      }
    }
    this.#lruNodes.delete(key);
  }

  #unlink(list: LruList, node: LruNode): void {
    if (node.prev !== undefined) node.prev.next = node.next;
    else if (list.head === node) list.head = node.next;
    if (node.next !== undefined) node.next.prev = node.prev;
    else if (list.tail === node) list.tail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }

  #append(list: LruList, node: LruNode): void {
    node.prev = list.tail;
    node.next = undefined;
    if (list.tail !== undefined) list.tail.next = node;
    else list.head = node;
    list.tail = node;
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
      (!Number.isFinite(metrics.fieldRange) || metrics.fieldRange < 0)) ||
    (metrics.rasterScale !== undefined &&
      (!Number.isFinite(metrics.rasterScale) || metrics.rasterScale < 1))
  ) {
    throw new TypeError("Glyph metrics must contain finite values");
  }
}

function assertKey(key: GlyphCacheKey): void {
  if (typeof key === "number") {
    if (!Number.isSafeInteger(key) || key < 0) {
      throw new TypeError("Glyph key must be a non-empty string or a non-negative safe integer");
    }
    return;
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Glyph key must be a non-empty string or a non-negative safe integer");
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}
