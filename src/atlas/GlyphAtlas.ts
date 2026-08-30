import { BoundedCache } from "../cache";
import { Packer, type PackedRectangle } from "./Packer";
import {
  atlasArrayKind,
  GLYPH_ATLAS_ARRAY_LAYERS,
  sameRenderScope,
  type AtlasCommit,
  type AtlasEntry,
  type AtlasExternalUpload,
  type AtlasGlyphRaster,
  type AtlasPageInfo,
  type AtlasUpload,
  type GlyphAtlasOptions,
  type GlyphAtlasStats,
  type GlyphCacheKey,
  type GlyphMode,
  type GlyphRaster,
  type GlyphRequest,
  type RenderToken,
  type RenderTokenScope,
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

interface PendingGlyphBase {
  readonly entry: Readonly<AtlasEntry>;
  readonly token?: Readonly<RenderToken>;
}

type PendingGlyph =
  | (PendingGlyphBase & { readonly kind: "cpu"; readonly pixels: Uint8Array })
  | (PendingGlyphBase & {
      readonly kind: "external";
      readonly source: Readonly<Extract<AtlasGlyphRaster, { source: unknown }>["source"]>;
      readonly sourceX: number;
      readonly sourceY: number;
      readonly release: () => void;
    });

interface LruNode {
  readonly key: GlyphCacheKey;
  prev: LruNode | undefined;
  next: LruNode | undefined;
}

interface LruList {
  head: LruNode | undefined;
  tail: LruNode | undefined;
}

interface CleanupFailure {
  readonly error: unknown;
}

const DEFAULT_PAGE_SIZE = 1_024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_GENERATION_CACHE_ENTRIES = 65_536;

interface GlyphAtlasRenderBridge {
  readonly request: (
    key: GlyphCacheKey,
    scope: Readonly<RenderTokenScope>,
    sourceRevision: number,
  ) => Readonly<RenderToken>;
  readonly stage: (token: Readonly<RenderToken>, raster: AtlasGlyphRaster) => boolean;
  readonly commit: (scope: Readonly<RenderTokenScope>) => Readonly<AtlasCommit>;
  readonly discard: (scope: Readonly<RenderTokenScope>) => number;
}

const RENDER_BRIDGES = new WeakMap<GlyphAtlas, Readonly<GlyphAtlasRenderBridge>>();

function renderBridge(atlas: GlyphAtlas): Readonly<GlyphAtlasRenderBridge> {
  const bridge = RENDER_BRIDGES.get(atlas);
  if (bridge === undefined) throw new TypeError("GlyphAtlas render bridge is unavailable");
  return bridge;
}

/** @internal Create a tokenized request for one coordinator render lifetime. */
export function requestGlyphAtlasRenderToken(
  atlas: GlyphAtlas,
  key: GlyphCacheKey,
  scope: Readonly<RenderTokenScope>,
  sourceRevision: number,
): Readonly<RenderToken> {
  return renderBridge(atlas).request(key, scope, sourceRevision);
}

/** @internal Stage a tokenized coordinator result. */
export function stageGlyphAtlasRenderToken(
  atlas: GlyphAtlas,
  token: Readonly<RenderToken>,
  raster: AtlasGlyphRaster,
): boolean {
  return renderBridge(atlas).stage(token, raster);
}

/** @internal Publish staged glyphs for one exact coordinator render lifetime. */
export function commitGlyphAtlasRenderFrame(
  atlas: GlyphAtlas,
  scope: Readonly<RenderTokenScope>,
): Readonly<AtlasCommit> {
  return renderBridge(atlas).commit(scope);
}

/** @internal Release staged glyphs owned by one coordinator render lifetime. */
export function discardGlyphAtlasRenderFrame(
  atlas: GlyphAtlas,
  scope: Readonly<RenderTokenScope>,
): number {
  return renderBridge(atlas).discard(scope);
}

export class GlyphAtlas {
  readonly #pageWidth: number;
  readonly #pageHeight: number;
  readonly #maxBytes: number;
  readonly #pages: AtlasPage[] = [];
  readonly #entries = new Map<GlyphCacheKey, Readonly<AtlasEntry>>();
  readonly #pending = new Map<GlyphCacheKey, PendingGlyph>();
  // Active, staged, and caller-pinned keys stay exact; evictable request tombstones use the cache.
  readonly #protectedRequestGenerations = new Map<GlyphCacheKey, number>();
  readonly #requestGenerationTombstones: BoundedCache<GlyphCacheKey, number>;
  readonly #lruNodes = new Map<GlyphCacheKey, LruNode>();
  readonly #lruByMode: Record<GlyphMode, LruList> = {
    msdf: { head: undefined, tail: undefined },
    sdf: { head: undefined, tail: undefined },
    alpha: { head: undefined, tail: undefined },
    color: { head: undefined, tail: undefined },
  };
  readonly #pins = new Set<GlyphCacheKey>();
  readonly #evictedSinceCommit: GlyphCacheKey[] = [];
  #generationFloor = 0;
  #generationHighWater = 0;
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
    this.#requestGenerationTombstones = new BoundedCache({
      maxEntries: options.requestGenerationCacheEntries ?? DEFAULT_REQUEST_GENERATION_CACHE_ENTRIES,
      policy: "lru",
      onEviction: () => {
        // A missing key resumes above every generation that could still complete asynchronously.
        this.#generationFloor = this.#generationHighWater;
      },
    });
    RENDER_BRIDGES.set(this, {
      request: (key, scope, sourceRevision) => this.#requestRenderToken(key, scope, sourceRevision),
      stage: (token, raster) => this.#stage(token, raster),
      commit: (scope) => this.#commitFrame(scope),
      discard: (scope) => this.#discardFrame(scope),
    });
  }

  request(key: GlyphCacheKey): Readonly<GlyphRequest> {
    return Object.freeze({ key, generation: this.#nextRequestGeneration(key) });
  }

  #requestRenderToken(
    key: GlyphCacheKey,
    scope: Readonly<RenderTokenScope>,
    sourceRevision: number,
  ): Readonly<RenderToken> {
    const generation = this.#nextRequestGeneration(key);
    return Object.freeze({
      key,
      generation,
      lifecycleEpoch: scope.lifecycleEpoch,
      commitTicket: scope.commitTicket,
      fontRegistryRevision: scope.fontRegistryRevision,
      destinationIdentity: scope.destinationIdentity,
      sourceRevision,
    });
  }

  #nextRequestGeneration(key: GlyphCacheKey): number {
    this.#assertActive();
    assertKey(key);
    const previous = this.#currentRequestGeneration(key) ?? this.#generationFloor;
    if (previous === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Glyph request generation exhausted: ${String(key)}`);
    }
    const generation = previous + 1;
    this.#generationHighWater = Math.max(this.#generationHighWater, generation);
    if (this.#isGenerationProtected(key)) {
      this.#requestGenerationTombstones.delete(key);
      this.#protectedRequestGenerations.set(key, generation);
    } else {
      this.#protectedRequestGenerations.delete(key);
      this.#requestGenerationTombstones.set(key, generation);
    }
    this.#requests += 1;
    return generation;
  }

  stage(request: GlyphRequest, raster: AtlasGlyphRaster): boolean {
    return this.#stage(request, raster);
  }

  #stage(request: GlyphRequest | RenderToken, raster: AtlasGlyphRaster): boolean {
    let incomingOwned = isExternalRaster(raster);
    try {
      this.#assertActive();
      assertKey(request.key);
      assertPositiveInteger("request.generation", request.generation);
      assertRaster(raster, this.#pageWidth, this.#pageHeight);
      const token = isRenderToken(request) ? request : undefined;
      if (this.#currentRequestGeneration(request.key) !== request.generation) {
        this.#staleResults += 1;
        incomingOwned = false;
        releaseExternalRaster(raster);
        return false;
      }

      const previousPending = this.#pending.get(request.key);
      if (previousPending !== undefined) {
        this.#detachPending(request.key, previousPending, false);
      }
      const placement = this.#allocate(raster.mode, raster.width, raster.height, request.key);
      if (placement === undefined) {
        this.#capacityFailures += 1;
        const capacityError =
          token === undefined
            ? undefined
            : new Error(`Glyph atlas capacity rejected: ${String(request.key)}`);
        incomingOwned = false;
        const releaseFailure = cleanupBestEffort([() => releaseExternalRaster(raster)]);
        if (capacityError !== undefined) throw capacityError;
        if (releaseFailure !== undefined) throw releaseFailure.error;
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
      const pending: PendingGlyph = isExternalRaster(raster)
        ? {
            kind: "external",
            entry,
            source: raster.source,
            sourceX: raster.sourceX,
            sourceY: raster.sourceY,
            release: raster.release,
            ...(token === undefined ? {} : { token }),
          }
        : {
            kind: "cpu",
            entry,
            pixels: raster.pixels,
            ...(token === undefined ? {} : { token }),
          };
      this.#pending.set(request.key, pending);
      this.#protectRequestGeneration(request.key, request.generation);
      this.#stagedResults += 1;
      incomingOwned = false;

      return true;
    } catch (error: unknown) {
      if (incomingOwned) {
        cleanupBestEffort([() => releaseExternalRaster(raster)]);
      }
      throw error;
    }
  }

  commitFrame(): Readonly<AtlasCommit> {
    return this.#commitFrame();
  }

  #commitFrame(scope?: Readonly<RenderTokenScope>): Readonly<AtlasCommit> {
    this.#assertActive();
    const entries: Readonly<AtlasEntry>[] = [];
    const uploads: Readonly<AtlasUpload>[] = [];
    const externalUploads: Readonly<AtlasExternalUpload>[] = [];
    let rejectionFailure: CleanupFailure | undefined;
    for (const [key, pending] of this.#pending) {
      if (this.#currentRequestGeneration(key) !== pending.entry.generation) {
        const failure = cleanupBestEffort([() => this.#detachPending(key, pending, true)]);
        rejectionFailure ??= failure;
        continue;
      }
      const token = pending.token;
      if (scope === undefined) {
        if (token !== undefined) continue;
      } else {
        if (token === undefined) continue;
        if (token.destinationIdentity !== scope.destinationIdentity) continue;
        if (!sameRenderScope(token, scope)) {
          const failure = cleanupBestEffort([() => this.#detachPending(key, pending, true)]);
          rejectionFailure ??= failure;
          continue;
        }
      }
    }
    if (rejectionFailure !== undefined) throw rejectionFailure.error;

    for (const [key, pending] of this.#pending) {
      const token = pending.token;
      if (
        scope === undefined
          ? token !== undefined
          : token === undefined || !sameRenderScope(token, scope)
      ) {
        continue;
      }
      const current = this.#entries.get(pending.entry.key);
      if (current !== undefined) {
        this.#releaseEntry(current);
      }
      this.#entries.set(pending.entry.key, pending.entry);
      this.#touch(pending.entry.key, pending.entry.mode);
      entries.push(pending.entry);
      if (pending.kind === "cpu") {
        uploads.push(Object.freeze({ entry: pending.entry, pixels: pending.pixels }));
      } else {
        externalUploads.push(
          Object.freeze({
            entry: pending.entry,
            source: pending.source,
            sourceX: pending.sourceX,
            sourceY: pending.sourceY,
            release: pending.release,
          }),
        );
      }
      this.#pending.delete(key);
    }
    const evictedKeys = Object.freeze([...this.#evictedSinceCommit]);
    this.#evictedSinceCommit.length = 0;
    if (entries.length > 0 || evictedKeys.length > 0) {
      this.#commits += 1;
    }

    return Object.freeze({
      entries: Object.freeze(entries),
      uploads: Object.freeze(uploads),
      externalUploads: Object.freeze(externalUploads),
      evictedKeys,
    });
  }

  #discardFrame(scope: Readonly<RenderTokenScope>): number {
    if (this.#destroyed) return 0;
    let discarded = 0;
    let firstFailure: CleanupFailure | undefined;
    for (const [key, pending] of this.#pending) {
      if (pending.token !== undefined && sameRenderScope(pending.token, scope)) {
        const failure = cleanupBestEffort([() => this.#detachPending(key, pending, true)]);
        firstFailure ??= failure;
        discarded += 1;
      }
    }
    if (firstFailure !== undefined) throw firstFailure.error;
    return discarded;
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
      const generation = this.#requestGenerationTombstones.peek(key);
      if (generation !== undefined) this.#protectRequestGeneration(key, generation);
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
    this.#demoteRequestGeneration(key);
    return true;
  }

  get stats(): Readonly<GlyphAtlasStats> {
    const tombstones = this.#requestGenerationTombstones.stats;
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
      requestGenerationEntries: this.#protectedRequestGenerations.size + tombstones.entries,
      requestGenerationProtectedEntries: this.#protectedRequestGenerations.size,
      requestGenerationTombstones: tombstones.entries,
      requestGenerationEvictions: tombstones.evictions,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    const pending = [...this.#pending.values()];
    this.#pages.length = 0;
    this.#entries.clear();
    this.#pending.clear();
    this.#protectedRequestGenerations.clear();
    this.#requestGenerationTombstones.clear();
    this.#lruNodes.clear();
    this.#lruByMode.msdf = { head: undefined, tail: undefined };
    this.#lruByMode.sdf = { head: undefined, tail: undefined };
    this.#lruByMode.alpha = { head: undefined, tail: undefined };
    this.#lruByMode.color = { head: undefined, tail: undefined };
    this.#pins.clear();
    this.#evictedSinceCommit.length = 0;
    this.#allocatedBytes = 0;
    this.#destroyed = true;
    const failure = cleanupBestEffort(pending.map((entry) => () => releasePendingRaster(entry)));
    if (failure !== undefined) throw failure.error;
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
          this.#demoteRequestGeneration(key);
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
    this.#detachLru(entry.key);
    this.#releasePendingEntry(entry);
  }

  #releasePendingEntry(entry: AtlasEntry): void {
    const page = this.#pages[entry.page];
    if (page === undefined) {
      throw new Error(`Atlas page ${String(entry.page)} is unavailable`);
    }
    page.packer.release(entry);
  }

  #detachPending(key: GlyphCacheKey, pending: PendingGlyph, stale: boolean): void {
    if (this.#pending.get(key) === pending) this.#pending.delete(key);
    this.#demoteRequestGeneration(key);
    if (stale) this.#staleResults += 1;
    const failure = cleanupBestEffort([
      () => this.#releasePendingEntry(pending.entry),
      () => releasePendingRaster(pending),
    ]);
    if (failure !== undefined) throw failure.error;
  }

  #currentRequestGeneration(key: GlyphCacheKey): number | undefined {
    return (
      this.#protectedRequestGenerations.get(key) ?? this.#requestGenerationTombstones.peek(key)
    );
  }

  #protectRequestGeneration(key: GlyphCacheKey, generation: number): void {
    this.#requestGenerationTombstones.delete(key);
    this.#protectedRequestGenerations.set(key, generation);
  }

  #demoteRequestGeneration(key: GlyphCacheKey): void {
    if (this.#isGenerationProtected(key)) return;
    const generation = this.#protectedRequestGenerations.get(key);
    if (generation === undefined) return;
    this.#protectedRequestGenerations.delete(key);
    this.#requestGenerationTombstones.set(key, generation);
  }

  #isGenerationProtected(key: GlyphCacheKey): boolean {
    return this.#entries.has(key) || this.#pending.has(key) || this.#pins.has(key);
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

function assertRaster(raster: AtlasGlyphRaster, pageWidth: number, pageHeight: number): void {
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
  if (isExternalRaster(raster)) {
    if (
      raster.mode !== "color" ||
      raster.source.format !== "rgba8unorm" ||
      !Number.isSafeInteger(raster.sourceX) ||
      raster.sourceX < 0 ||
      !Number.isSafeInteger(raster.sourceY) ||
      raster.sourceY < 0 ||
      !Number.isSafeInteger(raster.source.width) ||
      raster.source.width <= 0 ||
      !Number.isSafeInteger(raster.source.height) ||
      raster.source.height <= 0 ||
      raster.sourceX + raster.width > raster.source.width ||
      raster.sourceY + raster.height > raster.source.height ||
      typeof raster.release !== "function"
    ) {
      throw new TypeError("External color glyph raster is invalid");
    }
  } else {
    if (!(raster.pixels instanceof Uint8Array)) {
      throw new TypeError("Glyph raster pixels must be a Uint8Array");
    }
    const expectedBytes = raster.width * raster.height * bytesPerPixel(raster.mode);
    if (raster.pixels.byteLength !== expectedBytes) {
      throw new TypeError(
        `Glyph raster contains ${String(raster.pixels.byteLength)} bytes; expected ${String(expectedBytes)}`,
      );
    }
  }
  if (raster.metrics !== undefined) {
    assertMetrics(raster.metrics);
  }
}

function isExternalRaster(
  raster: Readonly<AtlasGlyphRaster>,
): raster is Readonly<Extract<AtlasGlyphRaster, { source: unknown }>> {
  return "source" in raster;
}

function releaseExternalRaster(raster: Readonly<AtlasGlyphRaster>): void {
  if (isExternalRaster(raster)) raster.release();
}

function releasePendingRaster(pending: Readonly<PendingGlyph>): void {
  if (pending.kind === "external") pending.release();
}

function cleanupBestEffort(
  cleanupSteps: Iterable<() => void>,
): Readonly<CleanupFailure> | undefined {
  let firstFailure: CleanupFailure | undefined;
  for (const cleanup of cleanupSteps) {
    try {
      cleanup();
    } catch (error: unknown) {
      firstFailure ??= { error };
    }
  }
  return firstFailure;
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

function isRenderToken(request: GlyphRequest | RenderToken): request is RenderToken {
  return "lifecycleEpoch" in request;
}
