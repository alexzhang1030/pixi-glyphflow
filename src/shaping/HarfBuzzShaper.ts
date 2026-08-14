import type { Blob, Buffer, Face, Font } from "harfbuzzjs";

import type { FontRegistry } from "../FontRegistry";
import type { PositionedRun, TextDirection } from "../layout/types";
import type {
  HarfBuzzRuntime,
  HarfBuzzRuntimeLoader,
  HarfBuzzShapeInput,
  HarfBuzzShaperOptions,
  HarfBuzzShaperStats,
} from "./types";

interface FontResource {
  readonly blob: Blob;
  readonly face: Face;
  readonly font: Font;
}

export class HarfBuzzShaper {
  readonly #registry: FontRegistry;
  readonly #loadRuntime: HarfBuzzRuntimeLoader;
  readonly #cacheSize: number;
  readonly #fontResources = new Map<string, FontResource>();
  readonly #cache = new Map<string, Readonly<PositionedRun>>();
  readonly #bufferPool: Buffer[] = [];
  #runtimePromise: Promise<HarfBuzzRuntime> | undefined;
  #runtimeLoads = 0;
  #hits = 0;
  #misses = 0;
  #shapes = 0;
  #destroyed = false;

  constructor(registry: FontRegistry, options: HarfBuzzShaperOptions = {}) {
    this.#registry = registry;
    this.#loadRuntime = options.loadRuntime ?? defaultRuntimeLoader;
    this.#cacheSize = options.cacheSize ?? 1_000;
    if (!Number.isSafeInteger(this.#cacheSize) || this.#cacheSize <= 0) {
      throw new TypeError("cacheSize must be a positive safe integer");
    }
  }

  async shape(input: HarfBuzzShapeInput): Promise<Readonly<PositionedRun>> {
    this.#assertActive();
    assertInput(input);
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
    const variationKey = variationCacheKey(input.variations);
    const featureKey = input.features?.join(",") ?? "";
    const cacheKey = [
      input.family,
      registered.revision,
      input.fontSize,
      direction,
      input.language ?? "",
      input.script ?? "",
      featureKey,
      variationKey,
      input.text,
    ].join("\u0000");
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      this.#hits += 1;
      return cached;
    }

    this.#misses += 1;
    const runtime = await this.#runtime();
    this.#assertActive();
    const resource = await this.#fontResource(
      runtime,
      input.family,
      registered.revision,
      input.fontSize,
      input.variations,
      variationKey,
    );
    const buffer = this.#bufferPool.pop() ?? new runtime.Buffer();

    try {
      buffer.addText(input.text);
      buffer.guessSegmentProperties();
      buffer.setDirection(direction === "rtl" ? runtime.Direction.RTL : runtime.Direction.LTR);
      if (input.language !== undefined) buffer.setLanguage(input.language);
      if (input.script !== undefined) buffer.setScript(input.script);
      const features = (input.features ?? []).map((value) => {
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

      const run = Object.freeze({
        source: "harfbuzz" as const,
        text: input.text,
        fontFamily: input.family,
        fontRevision: registered.revision,
        glyphCount,
        direction,
        glyphIds,
        clusters,
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
      this.#evictCache();

      return run;
    } finally {
      buffer.clearContents?.();
      if (this.#bufferPool.length < 4) {
        this.#bufferPool.push(buffer);
      }
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
    const registered = this.#registry.get(family);
    if (registered?.kind !== "binary") {
      throw new RangeError(`Binary font family is unavailable: ${family}`);
    }
    const runtime = await this.#runtime();
    const variationKey = variationCacheKey(variations);
    const resource = await this.#fontResource(
      runtime,
      family,
      registered.revision,
      fontSize,
      variations,
      variationKey,
    );

    return resource.font.glyphToPath(glyphId);
  }

  get stats(): Readonly<HarfBuzzShaperStats> {
    return Object.freeze({
      runtimeLoads: this.#runtimeLoads,
      fontObjects: this.#fontResources.size,
      cacheEntries: this.#cache.size,
      hits: this.#hits,
      misses: this.#misses,
      shapes: this.#shapes,
      pooledBuffers: this.#bufferPool.length,
    });
  }

  clear(): number {
    this.#assertActive();
    const entries = this.#cache.size + this.#fontResources.size;
    this.#cache.clear();
    this.#fontResources.clear();
    this.#bufferPool.length = 0;

    return entries;
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#cache.clear();
    this.#fontResources.clear();
    this.#bufferPool.length = 0;
    this.#destroyed = true;
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
    variationKey: string,
  ): Promise<FontResource> {
    const key = [family, revision, fontSize, variationKey].join(":");
    const cached = this.#fontResources.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const bytes = this.#registry.getBinaryData(family);
    if (bytes === undefined) {
      throw new RangeError(`Binary font data is unavailable: ${family}`);
    }

    const blob = new runtime.Blob(bytes);
    const face = new runtime.Face(blob, 0);
    if (!Number.isFinite(face.upem) || face.upem <= 0) {
      throw new TypeError(`Binary font has an invalid units-per-em value: ${family}`);
    }
    const font = new runtime.Font(face);
    const scale = Math.max(1, Math.round(fontSize * 64));
    font.setScale(scale, scale);
    const variationEntries = Object.entries(variations ?? {});
    if (variationEntries.length > 0) {
      font.setVariations(
        variationEntries.map(([tag, value]) => {
          if (tag.length !== 4 || !Number.isFinite(value)) {
            throw new TypeError(`Invalid font variation: ${tag}=${String(value)}`);
          }
          return new runtime.Variation(tag, value);
        }),
      );
    }

    const resource = { blob, face, font };
    this.#fontResources.set(key, resource);

    return resource;
  }

  #evictCache(): void {
    while (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      this.#cache.delete(oldest);
    }
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("HarfBuzzShaper has been destroyed");
    }
  }
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

function variationCacheKey(variations: Readonly<Record<string, number>> | undefined): string {
  return Object.entries(variations ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, value]) => `${tag}=${String(value)}`)
    .join(",");
}
