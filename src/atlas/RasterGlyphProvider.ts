import type { FontRegistry } from "../FontRegistry";
import { prepareGlyphFont } from "../fonts/cmap";
import { PrebuiltGlyphProvider, prebuiltGlyphKey } from "./PrebuiltGlyphProvider";
import { encodeTinySdf, TINY_SDF_RADIUS } from "./tinySdf";
import type {
  GlyphMetrics,
  GlyphMode,
  GlyphRaster,
  MsdfAtlasLike,
  MsdfGeneratorLike,
  RasterGlyphProviderOptions,
  RasterGlyphProviderStats,
  RasterGlyphRequest,
} from "./types";

const DEFAULT_CACHE_SIZE = 2_048;
const DEFAULT_DISTANCE_FIELD_MIN_FONT_SIZE = 48;
const FONT_WEIGHTS = new Set([
  "normal",
  "bold",
  "bolder",
  "lighter",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
]);

export class RasterGlyphProvider {
  readonly #registry: FontRegistry;
  readonly #cacheSize: number;
  readonly #generatorConcurrency: number;
  readonly #distanceFieldMinFontSize: number;
  readonly #canvasRasterizer: (request: RasterGlyphRequest) => Promise<GlyphRaster>;
  readonly #createMsdfGenerator: () => Promise<MsdfGeneratorLike>;
  readonly #cache = new Map<string, Readonly<GlyphRaster>>();
  readonly #pending = new Map<string, Promise<Readonly<GlyphRaster>>>();
  readonly #generatorPromises: Array<Promise<MsdfGeneratorLike> | undefined>;
  readonly #generatorTails: Array<Promise<void> | undefined>;
  #nextGenerator = 0;
  #hits = 0;
  #misses = 0;
  #canvasRasters = 0;
  #distanceFieldRasters = 0;
  #tinySdfRasters = 0;
  #prebuiltHits = 0;
  #generatorStarts = 0;
  readonly #faces = new Map<string, FontFace>();
  readonly #faceLoads = new Map<string, Promise<void>>();
  readonly #prebuilt: PrebuiltGlyphProvider | undefined;
  readonly #msdfBatches = new Map<string, MsdfBatch>();
  readonly #tinySdfBatches = new Map<string, TinySdfBatch>();
  #msdfFlushScheduled = false;
  #tinySdfFlushScheduled = false;
  #destroyed = false;

  constructor(registry: FontRegistry, options: RasterGlyphProviderOptions = {}) {
    this.#registry = registry;
    this.#cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
    if (!Number.isSafeInteger(this.#cacheSize) || this.#cacheSize <= 0) {
      throw new TypeError("cacheSize must be a positive safe integer");
    }
    this.#generatorConcurrency =
      options.generatorConcurrency ?? Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1);
    if (!Number.isSafeInteger(this.#generatorConcurrency) || this.#generatorConcurrency <= 0) {
      throw new TypeError("generatorConcurrency must be a positive safe integer");
    }
    this.#distanceFieldMinFontSize =
      options.distanceFieldMinFontSize ?? DEFAULT_DISTANCE_FIELD_MIN_FONT_SIZE;
    if (!Number.isFinite(this.#distanceFieldMinFontSize) || this.#distanceFieldMinFontSize <= 0) {
      throw new TypeError("distanceFieldMinFontSize must be a positive finite number");
    }
    this.#generatorPromises = Array.from({ length: this.#generatorConcurrency });
    this.#generatorTails = Array.from({ length: this.#generatorConcurrency });
    this.#canvasRasterizer = options.canvasRasterizer ?? defaultCanvasRasterizer;
    this.#createMsdfGenerator = options.createMsdfGenerator ?? defaultMsdfGenerator;
    this.#prebuilt =
      options.prebuilt === undefined ? undefined : new PrebuiltGlyphProvider(options.prebuilt);
  }

  async rasterize(request: RasterGlyphRequest): Promise<Readonly<GlyphRaster>> {
    this.#assertActive();
    validateRequest(request);
    const registered = this.#registry.get(request.family);
    if (
      registered === undefined &&
      (request.fontRevision !== 0 || request.mode === "msdf" || request.mode === "sdf")
    ) {
      throw new RangeError(`Font family is unavailable: ${request.family}`);
    }
    if (registered !== undefined && registered.revision !== request.fontRevision) {
      throw new RangeError(
        `Font revision ${String(request.fontRevision)} is stale; current revision is ${String(registered.revision)}`,
      );
    }
    if (request.mode === "msdf" && registered?.kind !== "binary") {
      throw new RangeError(`MSDF rasterization requires a binary font: ${request.family}`);
    }

    const key = requestCacheKey(request);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#hits += 1;
      return cached;
    }
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      this.#hits += 1;
      return pending;
    }

    this.#misses += 1;
    const promise = this.#createRaster(request).then((raster) => {
      this.#assertActive();
      validateRaster(raster, request.mode);
      const frozen = Object.freeze({
        ...raster,
        ...(raster.metrics === undefined ? {} : { metrics: Object.freeze({ ...raster.metrics }) }),
      });
      this.#cache.set(key, frozen);
      while (this.#cache.size > this.#cacheSize) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }

      return frozen;
    });
    this.#pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#pending.delete(key);
    }
  }

  get stats(): Readonly<RasterGlyphProviderStats> {
    return Object.freeze({
      cacheEntries: this.#cache.size,
      pending: this.#pending.size,
      hits: this.#hits,
      misses: this.#misses,
      canvasRasters: this.#canvasRasters,
      distanceFieldRasters: this.#distanceFieldRasters,
      tinySdfRasters: this.#tinySdfRasters,
      prebuiltHits: this.#prebuiltHits,
      generatorStarts: this.#generatorStarts,
    });
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cache.clear();
    this.#pending.clear();
    this.#prebuilt?.destroy();
    for (const face of this.#faces.values()) {
      globalThis.document?.fonts.delete(face);
    }
    this.#faces.clear();
    await Promise.all(this.#generatorTails.flatMap((tail) => (tail === undefined ? [] : [tail])));
    const generators = await Promise.all(
      this.#generatorPromises.flatMap((generator) => (generator === undefined ? [] : [generator])),
    );
    await Promise.all(generators.map((generator) => generator.dispose()));
  }

  async #createRaster(request: RasterGlyphRequest): Promise<Readonly<GlyphRaster>> {
    const baked = this.#prebuilt?.lookup(prebuiltGlyphKey(request));
    if (baked !== undefined) {
      this.#prebuiltHits += 1;
      return baked;
    }
    if (request.mode === "alpha" || request.mode === "color") {
      this.#canvasRasters += 1;
      return this.#canvasRasterizer(request);
    }
    if (request.mode === "sdf") {
      return this.#queueTinySdf(request);
    }

    this.#distanceFieldRasters += 1;
    const bytes = this.#registry.getBinaryData(request.family);
    if (bytes === undefined) {
      throw new RangeError(`Binary font data is unavailable: ${request.family}`);
    }
    const prepared = prepareGlyphFont(bytes, request.glyphId, request.glyphText);
    const rasterFontSize = Math.max(request.fontSize, this.#distanceFieldMinFontSize);
    const rasterScale = rasterFontSize / request.fontSize;
    if (prepared.bytes !== bytes) {
      // A patched cmap font is unique to this glyph; it cannot share a generator pass.
      const textureSize = nextPowerOfTwo(Math.max(32, Math.ceil(rasterFontSize * 2)));
      const atlas = await this.#generateAtlas({
        font: prepared.bytes,
        charset: prepared.glyphText,
        fontSize: rasterFontSize,
        textureSize: [textureSize, textureSize],
        fieldRange: 4,
        padding: 2,
        fixOverlaps: true,
      });
      return extractDistanceField(request, atlas, prepared.glyphText, rasterScale);
    }

    // The generator re-parses the posted font on every call, so a commit's misses for one
    // (family, revision, size) share a single pass: one parse plus N crops instead of N parses.
    return new Promise((resolve, reject) => {
      const key = `${request.family}\u0000${String(request.fontRevision)}\u0000${String(rasterFontSize)}`;
      let batch = this.#msdfBatches.get(key);
      if (batch === undefined) {
        batch = { bytes, rasterFontSize, members: [] };
        this.#msdfBatches.set(key, batch);
      }
      batch.members.push({
        request,
        glyphText: prepared.glyphText,
        rasterScale,
        resolve,
        reject,
      });
      if (!this.#msdfFlushScheduled) {
        this.#msdfFlushScheduled = true;
        queueMicrotask(() => {
          this.#msdfFlushScheduled = false;
          this.#flushMsdfBatches();
        });
      }
    });
  }

  #flushMsdfBatches(): void {
    const batches = [...this.#msdfBatches.values()];
    this.#msdfBatches.clear();
    for (const batch of batches) {
      for (let start = 0; start < batch.members.length; start += MSDF_BATCH_LIMIT) {
        void this.#rasterizeMsdfChunk(batch, batch.members.slice(start, start + MSDF_BATCH_LIMIT));
      }
    }
  }

  async #rasterizeMsdfChunk(
    batch: Readonly<MsdfBatch>,
    chunk: readonly MsdfBatchMember[],
  ): Promise<void> {
    if (this.#destroyed) {
      const error = new Error("RasterGlyphProvider was destroyed before the batch generated");
      for (const member of chunk) member.reject(error);
      return;
    }
    try {
      const cell = Math.ceil(batch.rasterFontSize * 1.5) + 8;
      const side = nextPowerOfTwo(
        Math.max(
          32,
          Math.ceil(batch.rasterFontSize * 2),
          Math.ceil(Math.sqrt(chunk.length)) * cell,
        ),
      );
      const atlas = await this.#generateAtlas({
        font: batch.bytes,
        charset: chunk.map((member) => member.glyphText).join(""),
        fontSize: batch.rasterFontSize,
        textureSize: [side, side],
        fieldRange: 4,
        padding: 2,
        fixOverlaps: true,
      });
      for (const member of chunk) {
        try {
          member.resolve(
            extractDistanceField(member.request, atlas, member.glyphText, member.rasterScale),
          );
        } catch (error: unknown) {
          member.reject(error);
        }
      }
    } catch (error: unknown) {
      for (const member of chunk) member.reject(error);
    }
  }

  #queueTinySdf(request: RasterGlyphRequest): Promise<Readonly<GlyphRaster>> {
    const rasterFontSize = Math.max(request.fontSize, this.#distanceFieldMinFontSize);
    const key = [
      request.family,
      request.fontFamilies?.join("\u0001") ?? "",
      String(request.fontRevision),
      String(rasterFontSize),
      String(request.fontWeight ?? "normal"),
    ].join("\u0000");
    return new Promise((resolve, reject) => {
      let batch = this.#tinySdfBatches.get(key);
      if (batch === undefined) {
        batch = { family: request.family, rasterFontSize, members: [] };
        this.#tinySdfBatches.set(key, batch);
      }
      batch.members.push({ request, rasterFontSize, resolve, reject });
      if (!this.#tinySdfFlushScheduled) {
        this.#tinySdfFlushScheduled = true;
        queueMicrotask(() => {
          this.#tinySdfFlushScheduled = false;
          this.#flushTinySdfBatches();
        });
      }
    });
  }

  #flushTinySdfBatches(): void {
    const batches = [...this.#tinySdfBatches.values()];
    this.#tinySdfBatches.clear();
    for (const batch of batches) {
      void this.#rasterizeTinySdfBatch(batch);
    }
  }

  async #rasterizeTinySdfBatch(batch: Readonly<TinySdfBatch>): Promise<void> {
    if (this.#destroyed) {
      const error = new Error("RasterGlyphProvider was destroyed before TinySDF ran");
      for (const member of batch.members) member.reject(error);
      return;
    }
    try {
      // Neighbors on one sheet corrupt EDT. One FontFace wait, then one mask+EDT per glyph.
      await this.#ensureDocumentFont(batch.family);
    } catch (error: unknown) {
      for (const member of batch.members) member.reject(error);
      return;
    }
    for (const member of batch.members) {
      if (this.#destroyed) {
        member.reject(new Error("RasterGlyphProvider was destroyed before TinySDF ran"));
        continue;
      }
      try {
        member.resolve(await this.#tinySdfMember(member));
      } catch (error: unknown) {
        member.reject(error);
      }
    }
  }

  async #tinySdfMember(member: Readonly<TinySdfBatchMember>): Promise<Readonly<GlyphRaster>> {
    this.#tinySdfRasters += 1;
    this.#canvasRasters += 1;
    const rasterScale = member.rasterFontSize / member.request.fontSize;
    const alpha = await this.#canvasRasterizer({
      ...member.request,
      fontSize: member.rasterFontSize,
      mode: "alpha",
    });
    if (alpha.mode !== "alpha") {
      throw new TypeError("TinySDF requires an alpha canvas raster");
    }
    const pixels = encodeTinySdf(alpha.pixels, alpha.width, alpha.height, TINY_SDF_RADIUS);
    const metrics = alpha.metrics;
    return {
      mode: "sdf",
      width: alpha.width,
      height: alpha.height,
      pixels,
      ...(metrics === undefined
        ? {}
        : {
            metrics: scaledFieldMetrics(
              metrics.bearingX,
              metrics.bearingY,
              metrics.advance,
              TINY_SDF_RADIUS,
              rasterScale,
            ),
          }),
    };
  }

  async #ensureDocumentFont(family: string): Promise<void> {
    if (this.#faces.has(family)) return;
    const existing = this.#faceLoads.get(family);
    if (existing !== undefined) return existing;
    const pending = this.#installDocumentFont(family);
    this.#faceLoads.set(family, pending);
    try {
      await pending;
    } finally {
      if (this.#faceLoads.get(family) === pending) this.#faceLoads.delete(family);
    }
  }

  async #installDocumentFont(family: string): Promise<void> {
    const bytes = this.#registry.getBinaryData(family);
    if (bytes === undefined) return;
    if (typeof FontFace === "undefined") return;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const face = new FontFace(family, copy);
    await face.load();
    if (this.#destroyed) return;
    if (this.#faces.has(family)) return;
    globalThis.document?.fonts.add(face);
    this.#faces.set(family, face);
  }

  #generateAtlas(options: Readonly<Record<string, unknown>>): Promise<MsdfAtlasLike> {
    const index = this.#nextGenerator % this.#generatorConcurrency;
    this.#nextGenerator += 1;
    const previous = this.#generatorTails[index] ?? Promise.resolve();
    const work = previous.then(async () => {
      const generator = await this.#generator(index);
      return generator.generateAtlas(options);
    });
    this.#generatorTails[index] = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async #generator(index: number): Promise<MsdfGeneratorLike> {
    let generatorPromise = this.#generatorPromises[index];
    if (generatorPromise === undefined) {
      this.#generatorStarts += 1;
      generatorPromise = this.#createMsdfGenerator().then(async (generator) => {
        await generator.initialize?.();
        return generator;
      });
      this.#generatorPromises[index] = generatorPromise;
    }

    return generatorPromise;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("RasterGlyphProvider has been destroyed");
    }
  }
}

function extractDistanceField(
  request: RasterGlyphRequest,
  atlas: MsdfAtlasLike,
  generatedGlyphText: string,
  rasterScale: number,
): Readonly<GlyphRaster> {
  // Batched atlases carry many glyphs; falling back to glyphs[0] would crop a stranger.
  const glyph =
    atlas.glyphs.find((candidate) => candidate.char === generatedGlyphText) ??
    (atlas.glyphs.length === 1 ? atlas.glyphs[0] : undefined);
  if (glyph === undefined) {
    throw new RangeError(`MSDF generator returned no glyph for: ${request.glyphText}`);
  }
  const [x, y] = glyph.atlasPosition;
  const [width, height] = glyph.atlasSize;
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > atlas.texture.width ||
    y + height > atlas.texture.height
  ) {
    throw new RangeError("MSDF generator returned invalid atlas coordinates");
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * atlas.texture.width + x) * 4;
    rgba.set(atlas.texture.data.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
  }
  const metrics = scaledFieldMetrics(
    glyph.bounds.left,
    glyph.bounds.top,
    glyph.advance,
    atlas.fieldRange,
    rasterScale,
  );
  if (request.mode === "msdf") {
    return Object.freeze({ mode: "msdf", width, height, pixels: rgba, metrics });
  }

  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4;
    pixels[index] = median(rgba[offset] ?? 0, rgba[offset + 1] ?? 0, rgba[offset + 2] ?? 0);
  }

  return Object.freeze({ mode: "sdf", width, height, pixels, metrics });
}

const MSDF_BATCH_LIMIT = 64;

interface MsdfBatchMember {
  readonly request: RasterGlyphRequest;
  readonly glyphText: string;
  readonly rasterScale: number;
  readonly resolve: (raster: Readonly<GlyphRaster>) => void;
  readonly reject: (error: unknown) => void;
}

interface MsdfBatch {
  readonly bytes: Uint8Array;
  readonly rasterFontSize: number;
  readonly members: MsdfBatchMember[];
}

interface TinySdfBatchMember {
  readonly request: RasterGlyphRequest;
  readonly rasterFontSize: number;
  readonly resolve: (raster: Readonly<GlyphRaster>) => void;
  readonly reject: (error: unknown) => void;
}

interface TinySdfBatch {
  readonly family: string;
  readonly rasterFontSize: number;
  readonly members: TinySdfBatchMember[];
}

/** Distance-field metrics scale together or the shader's screen-space math drifts. */
function scaledFieldMetrics(
  bearingX: number,
  bearingY: number,
  advance: number,
  fieldRange: number,
  rasterScale: number,
): Readonly<GlyphMetrics> {
  return Object.freeze({
    bearingX: bearingX / rasterScale,
    bearingY: bearingY / rasterScale,
    advance: advance / rasterScale,
    fieldRange: fieldRange / rasterScale,
    ...(rasterScale === 1 ? {} : { rasterScale }),
  });
}

async function defaultMsdfGenerator(): Promise<MsdfGeneratorLike> {
  const { MSDF } = await import("@zappar/msdf-generator");
  return new MSDF() as unknown as MsdfGeneratorLike;
}

async function defaultCanvasRasterizer(request: RasterGlyphRequest): Promise<GlyphRaster> {
  const canvas = createCanvas(1, 1);
  let context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Canvas 2D context is unavailable");
  }
  context.font = canvasFont(request);
  const measurement = context.measureText(request.glyphText);
  const padding = Math.max(8, Math.ceil(request.fontSize * 0.25));
  const left = measurement.actualBoundingBoxLeft || 0;
  const right = measurement.actualBoundingBoxRight || measurement.width;
  const ascent = measurement.actualBoundingBoxAscent || request.fontSize;
  const descent = measurement.actualBoundingBoxDescent || request.fontSize * 0.25;
  const width = Math.max(1, Math.ceil(left + right) + padding * 2);
  const height = Math.max(1, Math.ceil(ascent + descent) + padding * 2);
  canvas.width = width;
  canvas.height = height;
  context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Canvas 2D context is unavailable after resize");
  }
  context.clearRect(0, 0, width, height);
  context.font = canvasFont(request);
  context.textBaseline = "alphabetic";
  context.fillStyle = "white";
  context.fillText(request.glyphText, padding + left, padding + ascent);
  const image = context.getImageData(0, 0, width, height);
  const metrics = Object.freeze({ bearingX: -left, bearingY: ascent, advance: measurement.width });
  if (request.mode === "color") {
    return { mode: "color", width, height, pixels: new Uint8Array(image.data), metrics };
  }
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = image.data[index * 4 + 3] ?? 0;
  }

  return { mode: "alpha", width, height, pixels, metrics };
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("Canvas rasterization requires OffscreenCanvas or a browser document");
}

function validateRequest(request: RasterGlyphRequest): void {
  if (typeof request.family !== "string" || request.family.length === 0) {
    throw new TypeError("family must be a non-empty string");
  }
  if (request.fontFamilies !== undefined) {
    if (
      !Array.isArray(request.fontFamilies) ||
      request.fontFamilies.length === 0 ||
      request.fontFamilies.some((family) => typeof family !== "string" || family.length === 0) ||
      request.fontFamilies[0] !== request.family
    ) {
      throw new TypeError("fontFamilies must be an ordered stack beginning with family");
    }
  }
  if (!Number.isSafeInteger(request.fontRevision) || request.fontRevision < 0) {
    throw new TypeError("fontRevision must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(request.glyphId) || request.glyphId < 0) {
    throw new TypeError("glyphId must be a non-negative safe integer");
  }
  if (typeof request.glyphText !== "string" || request.glyphText.length === 0) {
    throw new TypeError("glyphText must be a non-empty string");
  }
  if (!Number.isFinite(request.fontSize) || request.fontSize <= 0) {
    throw new TypeError("fontSize must be a positive finite number");
  }
  if (request.fontWeight !== undefined && !FONT_WEIGHTS.has(request.fontWeight)) {
    throw new TypeError("fontWeight must be a supported CSS font weight");
  }
  assertMode(request.mode);
}

function validateRaster(raster: GlyphRaster, expectedMode: GlyphMode): void {
  if (raster.mode !== expectedMode) {
    throw new TypeError(`Raster mode ${raster.mode} differs from request mode ${expectedMode}`);
  }
  if (!Number.isSafeInteger(raster.width) || raster.width <= 0) {
    throw new TypeError("Raster width must be a positive safe integer");
  }
  if (!Number.isSafeInteger(raster.height) || raster.height <= 0) {
    throw new TypeError("Raster height must be a positive safe integer");
  }
  if (!(raster.pixels instanceof Uint8Array)) {
    throw new TypeError("Raster pixels must be a Uint8Array");
  }
  const channels = raster.mode === "sdf" || raster.mode === "alpha" ? 1 : 4;
  if (raster.pixels.byteLength !== raster.width * raster.height * channels) {
    throw new TypeError("Raster pixel byte length differs from its dimensions and mode");
  }
}

function requestCacheKey(request: RasterGlyphRequest): string {
  return [
    request.family,
    request.fontFamilies?.join("\u0001") ?? "",
    request.fontRevision,
    request.glyphId,
    request.glyphText,
    request.fontSize,
    request.fontWeight ?? "normal",
    request.mode,
  ].join("\u0000");
}

function canvasFont(request: RasterGlyphRequest): string {
  const families = request.fontFamilies ?? [request.family];
  return `${request.fontWeight ?? "normal"} ${String(request.fontSize)}px ${families.map(formatFamily).join(", ")}`;
}

const CSS_GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

function formatFamily(family: string): string {
  return CSS_GENERIC_FAMILIES.has(family.toLowerCase()) ? family : quoteFamily(family);
}

function quoteFamily(family: string): string {
  return `"${family.replaceAll('"', '\\"')}"`;
}

function median(first: number, second: number, third: number): number {
  return Math.max(Math.min(first, second), Math.min(Math.max(first, second), third));
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function assertMode(mode: string): void {
  if (mode !== "msdf" && mode !== "sdf" && mode !== "alpha" && mode !== "color") {
    throw new TypeError("Glyph mode is unsupported");
  }
}
