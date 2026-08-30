import { encodeCacheKey } from "../../cache/cacheKey";
import { cleanupBestEffortOrThrow } from "../cleanup";
import { createOutlineComputeRasterizer } from "./compute";
import { normalizeOutlineColor, powerOfTwoBucket } from "./helpers";
import { prepareOutlineGlyph } from "./prepare";
import { resolveOutlineRoute } from "./routing";
import type {
  OutlineColor,
  OutlineColorAtlas,
  OutlineColorAtlasEntry,
  OutlineComputeRasterizer,
  OutlinePackedGlyphRequest,
  OutlinePreparationResult,
  OutlineRenderingFailureReason,
  OutlineRenderingOptions,
  OutlineRenderingPlugin,
  OutlineRenderingRasterRequest,
  OutlineRenderingResult,
  PreparedOutlineGlyph,
} from "./types";

const DEFAULT_PROJECTED_SIZE_THRESHOLD_PX = 128;
const DEFAULT_PADDING = 2;
const DEFAULT_PREPARED_CACHE_ENTRIES = 256;
const DEFAULT_COLOR = Object.freeze([1, 1, 1, 1] as const);
const DESTROYED_MESSAGE = "outline rendering plugin has been destroyed";
const INVALID_COLOR_MESSAGE = "outline color must contain four finite channels";

interface NormalizedRequest {
  readonly input: Readonly<OutlineRenderingRasterRequest>;
  readonly pixelHeight: number;
  readonly padding: number;
  readonly color: OutlineColor;
}

interface PendingRaster {
  readonly request: Readonly<NormalizedRequest>;
  readonly resolve: (result: Readonly<OutlineRenderingResult>) => void;
  settled: boolean;
}

type PreparedLoad =
  | OutlinePreparationResult
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      status: "failed";
      reason: "packed-source" | "invalid-packed-outline";
      message: string;
    }>;

interface ReadyRaster {
  readonly member: PendingRaster;
  readonly glyph: Readonly<PreparedOutlineGlyph>;
}

export function createOutlineRendering(
  options: Readonly<OutlineRenderingOptions>,
): OutlineRenderingPlugin {
  return new DefaultOutlineRenderingPlugin(options);
}

class DefaultOutlineRenderingPlugin implements OutlineRenderingPlugin {
  readonly capability;
  readonly projectedSizeThresholdPx: number;
  readonly #source: OutlineRenderingOptions["source"];
  readonly #rasterizer: OutlineComputeRasterizer;
  readonly #padding: number;
  readonly #color: OutlineColor;
  readonly #prepareOptions: OutlineRenderingOptions["prepareOptions"];
  readonly #preparedCacheEntries: number;
  readonly #prepared = new Map<string, Promise<Readonly<PreparedLoad>>>();
  readonly #active = new Set<PendingRaster>();
  readonly #leases = new Set<AtlasLease>();
  readonly #queue: PendingRaster[] = [];
  #flushScheduled = false;
  #destroyed = false;

  constructor(options: Readonly<OutlineRenderingOptions>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("outline rendering options must be an object");
    }
    if (typeof options.source !== "function") {
      throw new TypeError("outline packed source must be a function");
    }
    this.projectedSizeThresholdPx =
      options.projectedSizeThresholdPx ?? DEFAULT_PROJECTED_SIZE_THRESHOLD_PX;
    if (!Number.isFinite(this.projectedSizeThresholdPx) || this.projectedSizeThresholdPx <= 0) {
      throw new TypeError("projectedSizeThresholdPx must be finite and positive");
    }
    this.#padding = options.padding ?? DEFAULT_PADDING;
    assertPadding(this.#padding);
    this.#color = normalizeOutlineColor(options.color ?? DEFAULT_COLOR, INVALID_COLOR_MESSAGE);
    this.#preparedCacheEntries = options.preparedCacheEntries ?? DEFAULT_PREPARED_CACHE_ENTRIES;
    if (!Number.isSafeInteger(this.#preparedCacheEntries) || this.#preparedCacheEntries <= 0) {
      throw new TypeError("preparedCacheEntries must be a positive safe integer");
    }
    this.#source = options.source;
    this.#prepareOptions = options.prepareOptions;
    this.#rasterizer = options.rasterizer ?? createOutlineComputeRasterizer(options.device);
    this.capability = this.#rasterizer.capability;
  }

  route(projectedHeightPx: number) {
    return resolveOutlineRoute({
      mode: "outline",
      projectedHeightPx,
      projectedSizeThresholdPx: this.projectedSizeThresholdPx,
      capability: this.capability,
    });
  }

  rasterPixelHeight(projectedHeightPx: number): number {
    if (!Number.isFinite(projectedHeightPx) || projectedHeightPx <= 0) {
      throw new TypeError("projectedHeightPx must be finite and positive");
    }
    return powerOfTwoBucket(Math.ceil(projectedHeightPx));
  }

  rasterize(
    request: Readonly<OutlineRenderingRasterRequest>,
  ): Promise<Readonly<OutlineRenderingResult>> {
    if (this.#destroyed) return Promise.resolve(destroyedResult());
    assertRasterRequest(request);
    const route = this.route(request.projectedHeightPx);
    if (route.path === "atlas") {
      return Promise.resolve(
        Object.freeze({
          status: "fallback",
          reason: route.reason,
        }) as Readonly<OutlineRenderingResult>,
      );
    }
    const pixelHeight =
      request.rasterPixelHeight ?? this.rasterPixelHeight(request.projectedHeightPx);
    if (!Number.isSafeInteger(pixelHeight) || pixelHeight <= 0) {
      return Promise.resolve(Object.freeze({ status: "fallback", reason: "atlas-too-large" }));
    }
    const normalized = Object.freeze({
      input: request,
      pixelHeight,
      padding: request.padding ?? this.#padding,
      color:
        request.color === undefined
          ? this.#color
          : normalizeOutlineColor(request.color, INVALID_COLOR_MESSAGE),
    });
    assertPadding(normalized.padding);

    return new Promise((resolve) => {
      const member: PendingRaster = { request: normalized, resolve, settled: false };
      this.#queue.push(member);
      this.#active.add(member);
      if (this.#flushScheduled) return;
      this.#flushScheduled = true;
      queueMicrotask(() => {
        void this.#flush().catch((error: unknown) => this.#failActive("device-error", error));
      });
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#queue.length = 0;
    this.#prepared.clear();
    for (const member of this.#active) this.#settle(member, destroyedResult());
    cleanupBestEffortOrThrow([
      ...Array.from(this.#leases, (lease) => () => lease.destroy()),
      () => this.#rasterizer.destroy(),
    ]);
  }

  async #flush(): Promise<void> {
    this.#flushScheduled = false;
    const members = this.#queue.splice(0);
    if (members.length === 0) return;
    const loaded = await Promise.all(
      members.map((member) => this.#loadPrepared(member.request.input)),
    );
    if (this.#destroyed) {
      for (const member of members) this.#settle(member, destroyedResult());
      return;
    }

    const ready: ReadyRaster[] = [];
    members.forEach((member, index) => {
      if (member.settled) return;
      const prepared = loaded[index];
      if (prepared === undefined) {
        this.#settle(member, failureResult("packed-source", "packed source result is unavailable"));
        return;
      }
      switch (prepared.status) {
        case "ready":
          ready.push({ member, glyph: prepared.glyph });
          return;
        case "empty":
          this.#settle(member, Object.freeze({ status: "empty", quad: prepared.quad }));
          return;
        case "unsupported":
          this.#settle(
            member,
            Object.freeze({
              status: "fallback",
              reason: "resource-limits",
              limit: prepared.limit,
            }),
          );
          return;
        case "unavailable":
          this.#settle(
            member,
            Object.freeze({ status: "fallback", reason: "packed-source-unavailable" }),
          );
          return;
        case "failed":
          this.#settle(member, failureResult(prepared.reason, prepared.message));
          return;
      }
    });
    if (ready.length > 0) await this.#rasterizeReady(ready);
  }

  #loadPrepared(request: Readonly<OutlineRenderingRasterRequest>): Promise<Readonly<PreparedLoad>> {
    const key = packedGlyphKey(request);
    const cached = this.#prepared.get(key);
    if (cached !== undefined) {
      this.#prepared.delete(key);
      this.#prepared.set(key, cached);
      return cached;
    }
    const sourceRequest: Readonly<OutlinePackedGlyphRequest> = Object.freeze({
      family: request.family,
      fontRevision: request.fontRevision,
      glyphId: request.glyphId,
      ...(request.variationKey === undefined ? {} : { variationKey: request.variationKey }),
    });
    const pending = Promise.resolve()
      .then(() => this.#source(sourceRequest))
      .then(
        (input): Readonly<PreparedLoad> => {
          if (input === undefined) return Object.freeze({ status: "unavailable" });
          try {
            return prepareOutlineGlyph(input, this.#prepareOptions);
          } catch (error: unknown) {
            return failureResult("invalid-packed-outline", error);
          }
        },
        (error: unknown): Readonly<PreparedLoad> => failureResult("packed-source", error),
      );
    this.#prepared.set(key, pending);
    void pending.then((result) => {
      if (this.#prepared.get(key) !== pending) return;
      if (result.status === "failed" || result.status === "unavailable") {
        this.#prepared.delete(key);
        return;
      }
      while (this.#prepared.size > this.#preparedCacheEntries) {
        const oldest = this.#prepared.keys().next().value;
        if (oldest === undefined) break;
        this.#prepared.delete(oldest);
      }
    });
    return pending;
  }

  async #rasterizeReady(ready: readonly Readonly<ReadyRaster>[]): Promise<void> {
    let result;
    try {
      result = await this.#rasterizer.rasterize(
        ready.map(({ member, glyph }) => ({
          glyph,
          pixelHeight: member.request.pixelHeight,
          padding: member.request.padding,
          color: member.request.color,
        })),
      );
    } catch (error: unknown) {
      for (const item of ready) this.#settle(item.member, failureResult("device-error", error));
      return;
    }
    if (this.#destroyed) {
      if (result.status === "ready") result.atlas.destroy();
      for (const item of ready) this.#settle(item.member, destroyedResult());
      return;
    }
    switch (result.status) {
      case "ready":
        this.#adoptAtlas(ready, result.atlas);
        return;
      case "unsupported":
        for (const item of ready) {
          this.#settle(
            item.member,
            Object.freeze({
              status: "fallback",
              reason:
                result.capability.reason === "webgpu-unavailable"
                  ? "capability-unavailable"
                  : result.capability.reason,
            }),
          );
        }
        return;
      case "failed":
        for (const item of ready) {
          this.#settle(item.member, failureResult(result.reason, result.message));
        }
        return;
      case "empty":
        for (const item of ready) {
          this.#settle(
            item.member,
            failureResult("device-error", "outline compute returned an empty non-empty batch"),
          );
        }
        return;
    }
  }

  #adoptAtlas(ready: readonly Readonly<ReadyRaster>[], atlas: OutlineColorAtlas): void {
    const entries = indexEntries(atlas, ready.length);
    if (entries === undefined) {
      atlas.destroy();
      for (const item of ready) {
        this.#settle(
          item.member,
          failureResult("device-error", "outline compute returned invalid atlas entries"),
        );
      }
      return;
    }
    const lease = new AtlasLease(atlas, ready.length, () => this.#leases.delete(lease));
    this.#leases.add(lease);
    const source = Object.freeze({
      texture: atlas.texture,
      format: atlas.format,
      width: atlas.width,
      height: atlas.height,
    });
    ready.forEach((item, requestIndex) => {
      const entry = entries[requestIndex];
      if (entry === undefined) {
        lease.destroy();
        this.#settle(
          item.member,
          failureResult("device-error", "outline atlas entry is unavailable"),
        );
        return;
      }
      let released = false;
      const input = item.member.request.input;
      const logicalScaleX = input.fontSize / item.glyph.unitsPerEmX;
      const logicalScaleY = input.fontSize / item.glyph.unitsPerEmY;
      const raster = Object.freeze({
        mode: "color" as const,
        width: entry.width,
        height: entry.height,
        source,
        sourceX: entry.x,
        sourceY: entry.y,
        padding: entry.padding,
        scale: entry.scale,
        quad: entry.quad,
        metrics: Object.freeze({
          bearingX: (entry.quad.minX - entry.padding / entry.scale) * logicalScaleX,
          bearingY: (entry.quad.maxY + entry.padding / entry.scale) * logicalScaleY,
          advance: input.advance ?? 0,
          rasterScale: entry.scale / logicalScaleY,
        }),
        release: () => {
          if (released) return;
          released = true;
          lease.release();
        },
      });
      this.#settle(item.member, Object.freeze({ status: "ready", raster }));
    });
  }

  #settle(member: PendingRaster, result: Readonly<OutlineRenderingResult>): void {
    if (member.settled) return;
    member.settled = true;
    this.#active.delete(member);
    member.resolve(result);
  }

  #failActive(reason: OutlineRenderingFailureReason, error: unknown): void {
    const result = failureResult(reason, error);
    for (const member of this.#active) this.#settle(member, result);
  }
}

/** @internal */
export class AtlasLease {
  readonly #atlas: OutlineColorAtlas;
  readonly #onDestroy: () => void;
  #references: number;
  #destroyed = false;

  constructor(atlas: OutlineColorAtlas, references: number, onDestroy: () => void) {
    this.#atlas = atlas;
    this.#references = references;
    this.#onDestroy = onDestroy;
  }

  release(): void {
    if (this.#destroyed) return;
    this.#references -= 1;
    if (this.#references === 0) this.destroy();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#references = 0;
    cleanupBestEffortOrThrow([() => this.#onDestroy(), () => this.#atlas.destroy()]);
  }
}

function indexEntries(
  atlas: Readonly<OutlineColorAtlas>,
  expected: number,
): readonly Readonly<OutlineColorAtlasEntry>[] | undefined {
  if (atlas.entries.length !== expected) return undefined;
  const entries: Array<Readonly<OutlineColorAtlasEntry> | undefined> = Array.from({
    length: expected,
  });
  for (const entry of atlas.entries) {
    if (
      !Number.isSafeInteger(entry.requestIndex) ||
      entry.requestIndex < 0 ||
      entry.requestIndex >= expected ||
      entries[entry.requestIndex] !== undefined
    ) {
      return undefined;
    }
    entries[entry.requestIndex] = entry;
  }
  return entries.every((entry) => entry !== undefined)
    ? (entries as readonly Readonly<OutlineColorAtlasEntry>[])
    : undefined;
}

function packedGlyphKey(request: Readonly<OutlineRenderingRasterRequest>): string {
  return encodeCacheKey([
    request.family,
    String(request.fontRevision),
    String(request.glyphId),
    request.variationKey ?? "",
  ]);
}

function assertRasterRequest(request: Readonly<OutlineRenderingRasterRequest>): void {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("outline raster request must be an object");
  }
  if (typeof request.family !== "string" || request.family.length === 0) {
    throw new TypeError("outline raster family must be a non-empty string");
  }
  for (const [name, value] of [
    ["fontRevision", request.fontRevision],
    ["glyphId", request.glyphId],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (!Number.isFinite(request.fontSize) || request.fontSize <= 0) {
    throw new TypeError("fontSize must be finite and positive");
  }
  if (request.rasterPixelHeight !== undefined) {
    if (!Number.isSafeInteger(request.rasterPixelHeight) || request.rasterPixelHeight <= 0) {
      throw new TypeError("rasterPixelHeight must be a positive safe integer");
    }
  }
  if (request.advance !== undefined && !Number.isFinite(request.advance)) {
    throw new TypeError("advance must be finite");
  }
  if (request.variationKey !== undefined && typeof request.variationKey !== "string") {
    throw new TypeError("variationKey must be a string");
  }
  if (request.padding !== undefined) assertPadding(request.padding);
  if (request.color !== undefined) normalizeOutlineColor(request.color, INVALID_COLOR_MESSAGE);
}

function assertPadding(padding: number): void {
  if (!Number.isSafeInteger(padding) || padding < 0) {
    throw new TypeError("padding must be a non-negative safe integer");
  }
}

function destroyedResult(): Readonly<OutlineRenderingResult> {
  return Object.freeze({ status: "failed", reason: "destroyed", message: DESTROYED_MESSAGE });
}

function failureResult<Reason extends OutlineRenderingFailureReason>(
  reason: Reason,
  error: unknown,
): Readonly<{ status: "failed"; reason: Reason; message: string }> {
  return Object.freeze({
    status: "failed",
    reason,
    message: error instanceof Error ? error.message : String(error),
  });
}
