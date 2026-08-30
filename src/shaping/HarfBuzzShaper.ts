import type { Blob, Buffer, Face, Font } from "harfbuzzjs";

import { BoundedCache } from "../cache/BoundedCache";
import { encodeCacheKey } from "../cache/cacheKey";
import type { FontRegistry } from "../FontRegistry";
import type { PositionedRun, TextDirection } from "../layout/types";
import type {
  HarfBuzzRuntime,
  HarfBuzzRuntimeLoader,
  HarfBuzzShapeInput,
  HarfBuzzShaperOptions,
  HarfBuzzShaperStats,
} from "./types";
import { canonicalizeVariations } from "./variationKey";

interface FontSourceResource {
  readonly key: string;
  readonly blob: Blob;
  readonly face: Face;
  readonly bytes: number;
  references: number;
  released: boolean;
}

interface FontResource {
  readonly source: FontSourceResource;
  readonly font: Font;
  users: number;
  retired: boolean;
  released: boolean;
}

const DEFAULT_FONT_RESOURCE_CACHE_ENTRIES = 64;
const DEFAULT_FONT_RESOURCE_CACHE_BYTES = 32 * 1024 * 1024;

export class HarfBuzzShaper {
  readonly #registry: FontRegistry;
  readonly #loadRuntime: HarfBuzzRuntimeLoader;
  readonly #fontResources: BoundedCache<string, FontResource>;
  readonly #fontSources = new Map<string, FontSourceResource>();
  readonly #liveFontResources = new Set<FontResource>();
  readonly #cache: BoundedCache<string, Readonly<PositionedRun>>;
  readonly #bufferPool: Buffer[] = [];
  #fontResourceEvictionFailure: CleanupFailure | undefined;
  #runtimePromise: Promise<HarfBuzzRuntime> | undefined;
  #runtimeLoads = 0;
  #shapes = 0;
  #destroyed = false;

  constructor(registry: FontRegistry, options: HarfBuzzShaperOptions = {}) {
    this.#registry = registry;
    this.#loadRuntime = options.loadRuntime ?? defaultRuntimeLoader;
    const cacheSize = options.cacheSize ?? 1_000;
    if (!Number.isSafeInteger(cacheSize) || cacheSize <= 0) {
      throw new TypeError("cacheSize must be a positive safe integer");
    }
    this.#cache = new BoundedCache({ maxEntries: cacheSize, policy: "lru" });
    this.#fontResources = new BoundedCache({
      maxEntries: options.fontResourceCacheEntries ?? DEFAULT_FONT_RESOURCE_CACHE_ENTRIES,
      maxBytes: options.fontResourceCacheBytes ?? DEFAULT_FONT_RESOURCE_CACHE_BYTES,
      policy: "lru",
      // Charge every identity its full source size. Shared family sources make this conservative.
      sizeOf: (resource) => resource.source.bytes,
      onEviction: ({ value }) => {
        const failure = this.#fontResourceEvictionFailure;
        if (failure === undefined) {
          this.#retireFontResource(value);
          return;
        }
        captureCleanupFailure(failure, () => this.#retireFontResource(value));
      },
    });
  }

  async shape(input: HarfBuzzShapeInput): Promise<Readonly<PositionedRun>> {
    this.#assertActive();
    assertInput(input);
    const { variationKey, cacheKey: variationCacheKey } = canonicalizeVariations(input.variations);
    const registered = this.#registry.get(input.family);
    if (registered?.kind !== "binary") {
      throw new RangeError(`Binary font family is unavailable: ${input.family}`);
    }
    if (input.fontRevision !== undefined && input.fontRevision !== registered.revision) {
      throw new RangeError(
        `Font revision ${String(input.fontRevision)} is stale; current revision is ${String(registered.revision)}`,
      );
    }

    const direction = input.direction ?? detectDirection(input.text);
    const featureValues = input.features ?? [];
    const cacheKey = encodeCacheKey([
      input.family,
      String(registered.revision),
      String(input.fontSize),
      direction,
      input.language ?? "",
      input.script ?? "",
      ...featureValues,
      variationCacheKey,
      input.text,
    ]);
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const runtime = await this.#runtime();
    this.#assertActive();
    this.#assertFontRevision(input.family, registered.revision);
    const resource = await this.#fontResource(
      runtime,
      input.family,
      registered.revision,
      input.fontSize,
      input.variations,
      variationCacheKey,
    );
    let buffer: Buffer | undefined;
    const failure = createCleanupFailure();

    try {
      buffer = this.#bufferPool.pop() ?? new runtime.Buffer();
      buffer.addText(input.text);
      buffer.guessSegmentProperties();
      buffer.setDirection(direction === "rtl" ? runtime.Direction.RTL : runtime.Direction.LTR);
      if (input.language !== undefined) buffer.setLanguage(input.language);
      if (input.script !== undefined) buffer.setScript(input.script);
      const features = featureValues.map((value) => {
        const feature = runtime.Feature.fromString(value);
        if (feature === undefined) {
          throw new TypeError(`Invalid OpenType feature: ${value}`);
        }
        return feature;
      });

      runtime.shape(resource.font, buffer, features);
      this.#shapes += 1;
      const infos = buffer.getGlyphInfos();
      const positions = buffer.getGlyphPositions();
      if (infos.length !== positions.length) {
        throw new Error("HarfBuzz returned mismatched glyph info and position arrays");
      }

      const glyphCount = infos.length;
      const glyphIds = new Uint32Array(glyphCount);
      const clusters = new Uint32Array(glyphCount);
      const x = new Float32Array(glyphCount);
      const y = new Float32Array(glyphCount);
      const xAdvance = new Float32Array(glyphCount);
      const yAdvance = new Float32Array(glyphCount);
      const lineIndices = new Uint32Array(glyphCount);
      let penX = 0;
      let penY = 0;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < glyphCount; index += 1) {
        const info = infos[index];
        const position = positions[index];
        if (info === undefined || position === undefined) {
          throw new Error(`HarfBuzz glyph data missing at index ${String(index)}`);
        }

        const glyphX = (penX + position.xOffset) / 64;
        const glyphY = -(penY + position.yOffset) / 64;
        const advanceX = position.xAdvance / 64;
        const advanceY = -position.yAdvance / 64;
        glyphIds[index] = info.codepoint;
        clusters[index] = info.cluster;
        x[index] = glyphX;
        y[index] = glyphY;
        xAdvance[index] = advanceX;
        yAdvance[index] = advanceY;
        lineIndices[index] = 0;

        const extents = resource.font.glyphExtents(info.codepoint);
        if (extents !== undefined) {
          const left = glyphX + extents.xBearing / 64;
          const top = glyphY - extents.yBearing / 64;
          const right = left + extents.width / 64;
          const bottom = top - extents.height / 64;
          minX = Math.min(minX, left, right);
          minY = Math.min(minY, top, bottom);
          maxX = Math.max(maxX, left, right);
          maxY = Math.max(maxY, top, bottom);
        }
        penX += position.xAdvance;
        penY += position.yAdvance;
      }

      if (glyphCount === 0 || !Number.isFinite(minX)) {
        const extents = resource.font.hExtents();
        minX = 0;
        minY = -extents.ascender / 64;
        maxX = Math.abs(penX / 64);
        maxY = -extents.descender / 64;
      }
      const clusterEnds = resolveClusterEnds(input.text, clusters);

      const run = Object.freeze({
        source: "harfbuzz" as const,
        text: input.text,
        fontFamily: input.family,
        fontRevision: registered.revision,
        glyphCount,
        direction,
        glyphIds,
        clusters,
        clusterEnds,
        variationKey,
        x,
        y,
        xAdvance,
        yAdvance,
        lineIndices,
        bounds: Object.freeze({
          x: minX,
          y: minY,
          width: Math.max(0, maxX - minX),
          height: Math.max(0, maxY - minY),
        }),
      });
      this.#cache.set(cacheKey, run);

      return run;
    } catch (error) {
      retainCleanupFailure(failure, error);
      throw error;
    } finally {
      try {
        if (buffer !== undefined) {
          const activeBuffer = buffer;
          let bufferReusable = false;
          captureCleanupFailure(failure, () => {
            activeBuffer.clearContents?.();
            bufferReusable = true;
          });
          if (bufferReusable && this.#bufferPool.length < 4) {
            this.#bufferPool.push(activeBuffer);
          }
        }
      } finally {
        captureCleanupFailure(failure, () => this.#releaseFontResourceUse(resource));
      }
      throwCleanupFailure(failure);
    }
  }

  async getGlyphPath(
    family: string,
    glyphId: number,
    fontSize: number,
    variations?: Readonly<Record<string, number>>,
  ): Promise<string> {
    this.#assertActive();
    if (!Number.isSafeInteger(glyphId) || glyphId < 0) {
      throw new TypeError("glyphId must be a non-negative safe integer");
    }
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      throw new TypeError("fontSize must be a positive finite number");
    }
    const { cacheKey: variationCacheKey } = canonicalizeVariations(variations);
    const registered = this.#registry.get(family);
    if (registered?.kind !== "binary") {
      throw new RangeError(`Binary font family is unavailable: ${family}`);
    }
    const runtime = await this.#runtime();
    this.#assertActive();
    this.#assertFontRevision(family, registered.revision);
    const resource = await this.#fontResource(
      runtime,
      family,
      registered.revision,
      fontSize,
      variations,
      variationCacheKey,
    );
    const failure = createCleanupFailure();

    try {
      return resource.font.glyphToPath(glyphId);
    } catch (error) {
      retainCleanupFailure(failure, error);
      throw error;
    } finally {
      captureCleanupFailure(failure, () => this.#releaseFontResourceUse(resource));
      throwCleanupFailure(failure);
    }
  }

  get stats(): Readonly<HarfBuzzShaperStats> {
    const cache = this.#cache.stats;
    const fontResources = this.#fontResources.stats;
    return Object.freeze({
      runtimeLoads: this.#runtimeLoads,
      fontObjects: fontResources.entries,
      fontResourceEntries: fontResources.entries,
      fontResourceBytes: fontResources.bytes,
      fontResourceEvictions: fontResources.evictions,
      cacheEntries: cache.entries,
      hits: cache.hits,
      misses: cache.misses,
      shapes: this.#shapes,
      pooledBuffers: this.#bufferPool.length,
      cacheEvictions: cache.evictions,
    });
  }

  clear(): number {
    this.#assertActive();
    return this.#clearResources();
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#clearResources();
  }

  #clearResources(): number {
    const entries = this.#cache.clear() + this.#fontResources.clear();
    const failure = createCleanupFailure();
    for (const resource of this.#liveFontResources) {
      captureCleanupFailure(failure, () => this.#retireFontResource(resource));
    }
    this.#bufferPool.length = 0;
    throwCleanupFailure(failure);
    return entries;
  }

  async #runtime(): Promise<HarfBuzzRuntime> {
    if (this.#runtimePromise === undefined) {
      this.#runtimeLoads += 1;
      this.#runtimePromise = this.#loadRuntime();
    }

    return this.#runtimePromise;
  }

  async #fontResource(
    runtime: HarfBuzzRuntime,
    family: string,
    revision: number,
    fontSize: number,
    variations: Readonly<Record<string, number>> | undefined,
    variationCacheKey: string,
  ): Promise<FontResource> {
    const key = encodeCacheKey([family, String(revision), String(fontSize), variationCacheKey]);
    const cached = this.#fontResources.get(key);
    if (cached !== undefined) {
      return this.#acquireFontResource(cached);
    }
    const sourceKey = encodeCacheKey([family, String(revision)]);
    let source = this.#fontSources.get(sourceKey);
    let font: Font | undefined;
    try {
      if (source === undefined) {
        const bytes = this.#registry.getBinaryData(family);
        if (bytes === undefined) {
          throw new RangeError(`Binary font data is unavailable: ${family}`);
        }
        const blob = new runtime.Blob(bytes);
        let face: Face | undefined;
        try {
          face = new runtime.Face(blob, 0);
          if (!Number.isFinite(face.upem) || face.upem <= 0) {
            throw new TypeError(`Binary font has an invalid units-per-em value: ${family}`);
          }
          source = {
            key: sourceKey,
            blob,
            face,
            bytes: bytes.byteLength,
            references: 0,
            released: false,
          };
          this.#fontSources.set(sourceKey, source);
        } catch (error) {
          const failure = createCleanupFailure();
          retainCleanupFailure(failure, error);
          captureCleanupFailure(failure, () => destroyHarfBuzzObject(face));
          captureCleanupFailure(failure, () => destroyHarfBuzzObject(blob));
          throw failure.error;
        }
      }
      font = new runtime.Font(source.face);
      const scale = Math.max(1, Math.round(fontSize * 64));
      font.setScale(scale, scale);
      const variationEntries = Object.entries(variations ?? {});
      if (variationEntries.length > 0) {
        font.setVariations(
          variationEntries.map(([tag, value]) => new runtime.Variation(tag, value)),
        );
      }

      const resource: FontResource = {
        source,
        font,
        users: 1,
        retired: false,
        released: false,
      };
      source.references += 1;
      this.#liveFontResources.add(resource);
      font = undefined;

      const insertionFailure = createCleanupFailure();
      const previousEvictionFailure = this.#fontResourceEvictionFailure;
      this.#fontResourceEvictionFailure = insertionFailure;
      try {
        this.#fontResources.set(key, resource);
      } catch (error) {
        retainCleanupFailure(insertionFailure, error);
      } finally {
        this.#fontResourceEvictionFailure = previousEvictionFailure;
      }
      if (insertionFailure.caught) {
        if (this.#fontResources.peek(key) === resource) {
          this.#fontResources.delete(key);
        }
        resource.retired = true;
        captureCleanupFailure(insertionFailure, () => this.#releaseFontResourceUse(resource));
        throwCleanupFailure(insertionFailure);
      }

      return resource;
    } catch (error) {
      const failure = createCleanupFailure();
      retainCleanupFailure(failure, error);
      captureCleanupFailure(failure, () => destroyHarfBuzzObject(font));
      if (source !== undefined && source.references === 0) {
        const releasableSource = source;
        captureCleanupFailure(failure, () => this.#releaseFontSource(releasableSource));
      }
      throw failure.error;
    }
  }

  #acquireFontResource(resource: FontResource): FontResource {
    if (resource.released) {
      throw new Error("HarfBuzz font resource has been released");
    }
    resource.users += 1;
    return resource;
  }

  #retireFontResource(resource: FontResource): void {
    resource.retired = true;
    this.#releaseFontResource(resource);
  }

  #releaseFontResourceUse(resource: FontResource): void {
    if (resource.users <= 0) {
      throw new Error("HarfBuzz font resource use count underflow");
    }
    resource.users -= 1;
    this.#releaseFontResource(resource);
  }

  #releaseFontResource(resource: FontResource): void {
    if (resource.released || !resource.retired || resource.users > 0) return;
    resource.released = true;
    const failure = createCleanupFailure();
    captureCleanupFailure(failure, () => destroyHarfBuzzObject(resource.font));
    this.#liveFontResources.delete(resource);
    resource.source.references -= 1;
    if (resource.source.references < 0) {
      captureCleanupFailure(failure, () => {
        throw new Error("HarfBuzz font source reference count underflow");
      });
    }
    if (resource.source.references <= 0) {
      captureCleanupFailure(failure, () => this.#releaseFontSource(resource.source));
    }
    throwCleanupFailure(failure);
  }

  #releaseFontSource(source: FontSourceResource): void {
    if (source.released) return;
    source.released = true;
    const failure = createCleanupFailure();
    captureCleanupFailure(failure, () => destroyHarfBuzzObject(source.face));
    captureCleanupFailure(failure, () => destroyHarfBuzzObject(source.blob));
    if (this.#fontSources.get(source.key) === source) {
      this.#fontSources.delete(source.key);
    }
    throwCleanupFailure(failure);
  }

  #assertFontRevision(family: string, revision: number): void {
    const current = this.#registry.get(family);
    if (current?.kind !== "binary") {
      throw new RangeError(`Binary font family is unavailable: ${family}`);
    }
    if (current.revision !== revision) {
      throw new RangeError(
        `Font revision ${String(revision)} is stale; current revision is ${String(current.revision)}`,
      );
    }
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("HarfBuzzShaper has been destroyed");
    }
  }
}

interface CleanupFailure {
  caught: boolean;
  error: unknown;
}

function createCleanupFailure(): CleanupFailure {
  return { caught: false, error: undefined };
}

function captureCleanupFailure(failure: CleanupFailure, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    retainCleanupFailure(failure, error);
  }
}

function retainCleanupFailure(failure: CleanupFailure, error: unknown): void {
  if (failure.caught) return;
  failure.caught = true;
  failure.error = error;
}

function throwCleanupFailure(failure: CleanupFailure): void {
  if (failure.caught) throw failure.error;
}

function destroyHarfBuzzObject(value: unknown): void {
  // harfbuzzjs 1.6 owns native-pointer cleanup through FinalizationRegistry. Injected runtimes can
  // expose destroy for immediate release.
  if (value === undefined || value === null) return;
  const destroy = (value as { readonly destroy?: () => void }).destroy;
  destroy?.call(value);
}

const defaultRuntimeLoader: HarfBuzzRuntimeLoader = () => import("harfbuzzjs");

function assertInput(input: HarfBuzzShapeInput): void {
  if (typeof input.family !== "string" || input.family.trim().length === 0) {
    throw new TypeError("family must be a non-empty string");
  }
  if (typeof input.text !== "string") {
    throw new TypeError("text must be a string");
  }
  if (!Number.isFinite(input.fontSize) || input.fontSize <= 0) {
    throw new TypeError("fontSize must be a positive finite number");
  }
  if (
    input.fontRevision !== undefined &&
    (!Number.isSafeInteger(input.fontRevision) || input.fontRevision < 0)
  ) {
    throw new TypeError("fontRevision must be a non-negative safe integer");
  }
  if (input.direction !== undefined && input.direction !== "ltr" && input.direction !== "rtl") {
    throw new TypeError("direction must be ltr or rtl");
  }
}

function detectDirection(text: string): TextDirection {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
      (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
      (codePoint >= 0xfe70 && codePoint <= 0xfeff)
    ) {
      return "rtl";
    }
    if (
      (codePoint >= 0x0041 && codePoint <= 0x005a) ||
      (codePoint >= 0x0061 && codePoint <= 0x007a) ||
      (codePoint >= 0x00c0 && codePoint <= 0x02af)
    ) {
      return "ltr";
    }
  }

  return "ltr";
}

function resolveClusterEnds(text: string, clusters: Readonly<Uint32Array>): Uint32Array {
  const boundaries = [...new Set(clusters)].sort((left, right) => left - right);
  for (const boundary of boundaries) {
    if (boundary > text.length) {
      throw new RangeError(
        `HarfBuzz cluster ${String(boundary)} exceeds UTF-16 text length ${String(text.length)}`,
      );
    }
  }
  const endByStart = new Map<number, number>();
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index];
    if (start === undefined) continue;
    endByStart.set(start, boundaries[index + 1] ?? text.length);
  }
  const ends = new Uint32Array(clusters.length);
  for (let index = 0; index < clusters.length; index += 1) {
    const start = clusters[index] ?? 0;
    const end = endByStart.get(start) ?? text.length;
    ends[index] = end;
  }
  return ends;
}
