import { BoundedCache } from "../../cache/BoundedCache";
import type { BoundedCacheStats } from "../../cache/BoundedCache";
import { encodeCacheKey } from "../../cache/cacheKey";
import { normalizeOutlineColor, powerOfTwoBucket } from "./helpers";
import type { OutlineColor, OutlineCpuBitmap } from "./types";

export const SPARSE_STRIP_SCHEMA_VERSION = 1 as const;
export const SPARSE_STRIP_TILE_SIZE = 4 as const;

const SPARSE_STRIP_MAGIC = 0x5353_4731;
const TILE_TRANSPARENT = 0;
const TILE_SOLID = 1;
const TILE_BOUNDARY = 2;

/** Versioned storage contract consumed by the CPU codec and WebGPU storage-buffer adapter. */
const sparseStripLayout = {
  headerWords: 12,
  recordWords: 4,
  tileCoverageBytes: 16,
  solidCoverageSentinel: 0xffff_ffff as number,
  header: {
    magic: 0,
    schemaVersion: 1,
    tileSize: 2,
    width: 3,
    height: 4,
    tileColumns: 5,
    tileRows: 6,
    recordCount: 7,
    recordWords: 8,
    coverageBytes: 9,
    denseEquivalentBytes: 10,
    reserved: 11,
  },
  record: {
    tileY: 0,
    tileX0: 1,
    tileX1: 2,
    coverageOffset: 3,
  },
} as const;

export type SparseStripLayout = typeof sparseStripLayout;

Object.freeze(sparseStripLayout.header);
Object.freeze(sparseStripLayout.record);
export const SPARSE_STRIP_LAYOUT: SparseStripLayout = Object.freeze(sparseStripLayout);

const SOLID_COVERAGE_SENTINEL = SPARSE_STRIP_LAYOUT.solidCoverageSentinel;
const HEADER_WORDS = SPARSE_STRIP_LAYOUT.headerWords;
const RECORD_WORDS = SPARSE_STRIP_LAYOUT.recordWords;
const TILE_COVERAGE_BYTES = SPARSE_STRIP_LAYOUT.tileCoverageBytes;
const MAX_U32 = SPARSE_STRIP_LAYOUT.solidCoverageSentinel;

const {
  magic: HEADER_MAGIC,
  schemaVersion: HEADER_SCHEMA,
  tileSize: HEADER_TILE_SIZE,
  width: HEADER_WIDTH,
  height: HEADER_HEIGHT,
  tileColumns: HEADER_TILE_COLUMNS,
  tileRows: HEADER_TILE_ROWS,
  recordCount: HEADER_RECORD_COUNT,
  recordWords: HEADER_RECORD_WORDS,
  coverageBytes: HEADER_COVERAGE_BYTES,
  denseEquivalentBytes: HEADER_DENSE_BYTES,
  reserved: HEADER_RESERVED,
} = SPARSE_STRIP_LAYOUT.header;

const {
  tileY: RECORD_TILE_Y,
  tileX0: RECORD_TILE_X0,
  tileX1: RECORD_TILE_X1,
  coverageOffset: RECORD_COVERAGE_OFFSET,
} = SPARSE_STRIP_LAYOUT.record;

export type SparseStripAaMode = "grayscale" | "binary";

export interface SparseGlyphStripIdentity {
  readonly family: string;
  readonly fontRevision: number;
  readonly glyphId: number;
  readonly variationKey?: string;
  /** Projected pixel height. The key stores its power-of-two physical bucket. */
  readonly pixelHeight: number;
  readonly padding: number;
  readonly aaMode: SparseStripAaMode;
}

export interface SparseStripEncodeOptions {
  /** Alpha used when the input bitmap was rasterized. Defaults to one. */
  readonly sourceAlpha?: number;
  readonly aaMode?: SparseStripAaMode;
}

export interface SparseStripGlyph {
  readonly schemaVersion: 1;
  readonly tileSize: 4;
  readonly width: number;
  readonly height: number;
  readonly tileColumns: number;
  readonly tileRows: number;
  /** Twelve u32 words following `SPARSE_STRIP_LAYOUT.header`. */
  readonly header: Uint32Array;
  /** Four u32 words per row-major boundary tile or horizontal solid gap. */
  readonly strips: Uint32Array;
  /** Sixteen row-major coverage bytes per boundary tile. */
  readonly coverage: Uint8Array;
  readonly allocatedBytes: number;
  /** One dense alpha byte per pixel; color storage stays external. */
  readonly denseEquivalentBytes: number;
}

export interface SparseGlyphStripCacheOptions {
  readonly maxBytes: number;
  readonly maxEntries?: number;
}

/** Bucket continuous zoom levels into a stable physical raster height. */
export function sparseGlyphStripPixelBucket(projectedPixelHeight: number): number {
  if (!Number.isFinite(projectedPixelHeight) || projectedPixelHeight <= 0) {
    throw new TypeError("projectedPixelHeight must be finite and positive");
  }
  const resolved = powerOfTwoBucket(Math.ceil(projectedPixelHeight));
  if (!Number.isSafeInteger(resolved)) {
    throw new RangeError("projectedPixelHeight exceeds the safe pixel bucket range");
  }
  return resolved;
}

/** Encode the complete glyph identity with tuple-safe length prefixes. */
export function createSparseGlyphStripKey(identity: Readonly<SparseGlyphStripIdentity>): string {
  assertIdentity(identity);
  return encodeCacheKey([
    String(SPARSE_STRIP_SCHEMA_VERSION),
    identity.family,
    String(identity.fontRevision),
    String(identity.glyphId),
    identity.variationKey ?? "",
    String(sparseGlyphStripPixelBucket(identity.pixelHeight)),
    String(identity.padding),
    identity.aaMode,
  ]);
}

/** Convert the alpha channel of a premultiplied outline bitmap into sparse 4x4 strips. */
export function encodeSparseStripGlyph(
  bitmap: Readonly<OutlineCpuBitmap>,
  options: Readonly<SparseStripEncodeOptions> = {},
): Readonly<SparseStripGlyph> {
  assertBitmap(bitmap);
  const sourceAlpha = options.sourceAlpha ?? 1;
  if (!Number.isFinite(sourceAlpha) || sourceAlpha <= 0 || sourceAlpha > 1) {
    throw new TypeError("sourceAlpha must be finite within (0, 1]");
  }
  const aaMode = options.aaMode ?? "grayscale";
  if (aaMode !== "grayscale" && aaMode !== "binary") {
    throw new TypeError("aaMode must be grayscale or binary");
  }

  const tileColumns = Math.ceil(bitmap.width / SPARSE_STRIP_TILE_SIZE);
  const tileRows = Math.ceil(bitmap.height / SPARSE_STRIP_TILE_SIZE);
  assertUint32("tile count", tileColumns * tileRows);

  const tileKinds = new Uint8Array(tileColumns * tileRows);
  let recordCount = 0;
  let boundaryTileCount = 0;
  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    let solidRun = false;
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      const tileIndex = tileY * tileColumns + tileX;
      const kind = classifyBitmapTile(bitmap, tileX, tileY, sourceAlpha, aaMode);
      tileKinds[tileIndex] = kind;
      if (kind === TILE_SOLID) {
        if (!solidRun) recordCount += 1;
        solidRun = true;
        continue;
      }
      solidRun = false;
      if (kind === TILE_BOUNDARY) {
        recordCount += 1;
        boundaryTileCount += 1;
      }
    }
  }

  assertUint32("strip record count", recordCount);
  const boundaryCoverageBytes = boundaryTileCount * TILE_COVERAGE_BYTES;
  if (boundaryCoverageBytes >= SOLID_COVERAGE_SENTINEL) {
    throw new RangeError("sparse strip boundary coverage exceeds its u32 offset range");
  }
  const strips = new Uint32Array(recordCount * RECORD_WORDS);
  const coverage = new Uint8Array(boundaryCoverageBytes);
  let recordIndex = 0;
  let coverageOffset = 0;
  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    let solidStart = -1;
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      const kind = tileKinds[tileY * tileColumns + tileX] ?? TILE_TRANSPARENT;
      if (kind === TILE_SOLID) {
        if (solidStart < 0) solidStart = tileX;
        continue;
      }
      if (solidStart >= 0) {
        writeStripRecord(strips, recordIndex, tileY, solidStart, tileX, SOLID_COVERAGE_SENTINEL);
        recordIndex += 1;
        solidStart = -1;
      }
      if (kind !== TILE_BOUNDARY) continue;
      writeStripRecord(strips, recordIndex, tileY, tileX, tileX + 1, coverageOffset);
      recordIndex += 1;
      writeBoundaryTileCoverage(
        bitmap,
        tileX,
        tileY,
        sourceAlpha,
        aaMode,
        coverage,
        coverageOffset,
      );
      coverageOffset += TILE_COVERAGE_BYTES;
    }
    if (solidStart >= 0) {
      writeStripRecord(
        strips,
        recordIndex,
        tileY,
        solidStart,
        tileColumns,
        SOLID_COVERAGE_SENTINEL,
      );
      recordIndex += 1;
    }
  }
  if (recordIndex !== recordCount || coverageOffset !== coverage.byteLength) {
    throw new Error("sparse strip two-pass allocation count changed during encoding");
  }
  const denseEquivalentBytes = bitmap.width * bitmap.height;
  assertUint32("dense equivalent bytes", denseEquivalentBytes);
  const header = new Uint32Array(HEADER_WORDS);
  header[HEADER_MAGIC] = SPARSE_STRIP_MAGIC;
  header[HEADER_SCHEMA] = SPARSE_STRIP_SCHEMA_VERSION;
  header[HEADER_TILE_SIZE] = SPARSE_STRIP_TILE_SIZE;
  header[HEADER_WIDTH] = bitmap.width;
  header[HEADER_HEIGHT] = bitmap.height;
  header[HEADER_TILE_COLUMNS] = tileColumns;
  header[HEADER_TILE_ROWS] = tileRows;
  header[HEADER_RECORD_COUNT] = strips.length / RECORD_WORDS;
  header[HEADER_RECORD_WORDS] = RECORD_WORDS;
  header[HEADER_COVERAGE_BYTES] = coverage.byteLength;
  header[HEADER_DENSE_BYTES] = denseEquivalentBytes;
  header[HEADER_RESERVED] = 0;
  const allocatedBytes = header.byteLength + strips.byteLength + coverage.byteLength;

  return Object.freeze({
    schemaVersion: SPARSE_STRIP_SCHEMA_VERSION,
    tileSize: SPARSE_STRIP_TILE_SIZE,
    width: bitmap.width,
    height: bitmap.height,
    tileColumns,
    tileRows,
    header,
    strips,
    coverage,
    allocatedBytes,
    denseEquivalentBytes,
  });
}

/** Reconstruct one tightly packed alpha byte per pixel. */
export function decodeSparseStripCoverage(glyph: Readonly<SparseStripGlyph>): Uint8Array {
  validateSparseStripGlyph(glyph);
  const dense = new Uint8Array(glyph.denseEquivalentBytes);
  const recordCount = glyph.strips.length / RECORD_WORDS;
  for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
    const recordOffset = recordIndex * RECORD_WORDS;
    const tileY = readWord(glyph.strips, recordOffset + RECORD_TILE_Y, "tile y");
    const tileX0 = readWord(glyph.strips, recordOffset + RECORD_TILE_X0, "tile x0");
    const tileX1 = readWord(glyph.strips, recordOffset + RECORD_TILE_X1, "tile x1");
    const coverageOffset = readWord(
      glyph.strips,
      recordOffset + RECORD_COVERAGE_OFFSET,
      "coverage offset",
    );
    for (let tileX = tileX0; tileX < tileX1; tileX += 1) {
      let source = 0;
      for (let localY = 0; localY < SPARSE_STRIP_TILE_SIZE; localY += 1) {
        for (let localX = 0; localX < SPARSE_STRIP_TILE_SIZE; localX += 1) {
          const x = tileX * SPARSE_STRIP_TILE_SIZE + localX;
          const y = tileY * SPARSE_STRIP_TILE_SIZE + localY;
          const value =
            coverageOffset === SOLID_COVERAGE_SENTINEL
              ? 255
              : readByte(glyph.coverage, coverageOffset + source, "coverage payload");
          source += 1;
          if (x < glyph.width && y < glyph.height) dense[y * glyph.width + x] = value;
        }
      }
    }
  }
  return dense;
}

/** Rehydrate the sparse coverage with an independent premultiplied RGBA color. */
export function colorizeSparseStripGlyph(
  glyph: Readonly<SparseStripGlyph>,
  color: OutlineColor,
): Readonly<OutlineCpuBitmap> {
  const normalizedColor = normalizeOutlineColor(
    color,
    "outline color must contain four finite channels",
  );
  const dense = decodeSparseStripCoverage(glyph);
  const pixels = new Uint8Array(glyph.width * glyph.height * 4);
  for (let index = 0; index < dense.length; index += 1) {
    const coverage = readByte(dense, index, "decoded coverage") / 255;
    const alpha = normalizedColor[3] * coverage;
    const offset = index * 4;
    pixels[offset] = Math.round(normalizedColor[0] * alpha * 255);
    pixels[offset + 1] = Math.round(normalizedColor[1] * alpha * 255);
    pixels[offset + 2] = Math.round(normalizedColor[2] * alpha * 255);
    pixels[offset + 3] = Math.round(alpha * 255);
  }
  return Object.freeze({
    width: glyph.width,
    height: glyph.height,
    bytesPerRow: glyph.width * 4,
    pixels,
  });
}

/** Validate the versioned storage layout and deterministic row-major record order. */
export function validateSparseStripGlyph(glyph: Readonly<SparseStripGlyph>): void {
  if (typeof glyph !== "object" || glyph === null) {
    throw new TypeError("sparse strip glyph must be an object");
  }
  if (!(glyph.header instanceof Uint32Array) || glyph.header.length !== HEADER_WORDS) {
    throw new TypeError(`sparse strip header must contain ${String(HEADER_WORDS)} u32 words`);
  }
  if (!(glyph.strips instanceof Uint32Array) || glyph.strips.length % RECORD_WORDS !== 0) {
    throw new TypeError("sparse strip records must contain whole four-word records");
  }
  if (!(glyph.coverage instanceof Uint8Array)) {
    throw new TypeError("sparse strip coverage must be a Uint8Array");
  }
  assertPositiveUint32("width", glyph.width);
  assertPositiveUint32("height", glyph.height);
  if (glyph.schemaVersion !== SPARSE_STRIP_SCHEMA_VERSION) {
    throw new TypeError("sparse strip schema version mismatch");
  }
  if (glyph.tileSize !== SPARSE_STRIP_TILE_SIZE) {
    throw new TypeError("sparse strip tile size mismatch");
  }

  const tileColumns = Math.ceil(glyph.width / SPARSE_STRIP_TILE_SIZE);
  const tileRows = Math.ceil(glyph.height / SPARSE_STRIP_TILE_SIZE);
  const denseEquivalentBytes = glyph.width * glyph.height;
  const recordCount = glyph.strips.length / RECORD_WORDS;
  const expectedHeader = [
    SPARSE_STRIP_MAGIC,
    SPARSE_STRIP_SCHEMA_VERSION,
    SPARSE_STRIP_TILE_SIZE,
    glyph.width,
    glyph.height,
    tileColumns,
    tileRows,
    recordCount,
    RECORD_WORDS,
    glyph.coverage.byteLength,
    denseEquivalentBytes,
    0,
  ];
  for (let index = 0; index < expectedHeader.length; index += 1) {
    if (readWord(glyph.header, index, "header") !== expectedHeader[index]) {
      throw new TypeError(`sparse strip header word ${String(index)} mismatch`);
    }
  }
  if (glyph.tileColumns !== tileColumns || glyph.tileRows !== tileRows) {
    throw new TypeError("sparse strip tile grid mismatch");
  }
  if (glyph.denseEquivalentBytes !== denseEquivalentBytes) {
    throw new TypeError("sparse strip dense byte count mismatch");
  }
  if (
    glyph.allocatedBytes !==
    glyph.header.byteLength + glyph.strips.byteLength + glyph.coverage.byteLength
  ) {
    throw new TypeError("sparse strip allocated byte count mismatch");
  }

  let previousTileY = -1;
  let previousTileX1 = 0;
  let previousSolid = false;
  let expectedCoverageOffset = 0;
  for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
    const offset = recordIndex * RECORD_WORDS;
    const tileY = readWord(glyph.strips, offset + RECORD_TILE_Y, "tile y");
    const tileX0 = readWord(glyph.strips, offset + RECORD_TILE_X0, "tile x0");
    const tileX1 = readWord(glyph.strips, offset + RECORD_TILE_X1, "tile x1");
    const coverageOffset = readWord(
      glyph.strips,
      offset + RECORD_COVERAGE_OFFSET,
      "coverage offset",
    );
    if (tileY >= tileRows || tileX0 >= tileX1 || tileX1 > tileColumns) {
      throw new TypeError("sparse strip coordinates must form an in-bounds horizontal span");
    }
    if (tileY < previousTileY || (tileY === previousTileY && tileX0 < previousTileX1)) {
      throw new TypeError("sparse strip spans must be disjoint and row-major");
    }
    if (tileY !== previousTileY) {
      previousTileX1 = 0;
      previousSolid = false;
    }
    const solid = coverageOffset === SOLID_COVERAGE_SENTINEL;
    if (solid && previousSolid && tileY === previousTileY && tileX0 === previousTileX1) {
      throw new TypeError("adjacent sparse strip solid gaps must be merged");
    }
    previousTileY = tileY;
    previousTileX1 = tileX1;
    previousSolid = solid;
    if (solid) {
      if (
        (tileY === tileRows - 1 && glyph.height % SPARSE_STRIP_TILE_SIZE !== 0) ||
        (tileX1 === tileColumns && glyph.width % SPARSE_STRIP_TILE_SIZE !== 0)
      ) {
        throw new TypeError("solid gaps must stay inside complete 4x4 tiles");
      }
      continue;
    }
    if (tileX1 !== tileX0 + 1) {
      throw new TypeError("boundary coverage must address one 4x4 tile");
    }
    if (coverageOffset !== expectedCoverageOffset) {
      throw new TypeError("sparse strip boundary payloads must be tightly ordered");
    }
    let hasTransparentSample = false;
    let hasCoveredSample = false;
    for (let index = 0; index < TILE_COVERAGE_BYTES; index += 1) {
      const value = readByte(glyph.coverage, coverageOffset + index, "coverage payload");
      const x = tileX0 * SPARSE_STRIP_TILE_SIZE + (index % SPARSE_STRIP_TILE_SIZE);
      const y = tileY * SPARSE_STRIP_TILE_SIZE + Math.floor(index / SPARSE_STRIP_TILE_SIZE);
      if ((x >= glyph.width || y >= glyph.height) && value !== 0) {
        throw new TypeError("boundary coverage outside glyph bounds must be transparent");
      }
      if (value !== 255) hasTransparentSample = true;
      if (value !== 0) hasCoveredSample = true;
    }
    if (!hasTransparentSample || !hasCoveredSample) {
      throw new TypeError("boundary coverage must contain mixed alpha samples");
    }
    expectedCoverageOffset += TILE_COVERAGE_BYTES;
  }
  if (expectedCoverageOffset !== glyph.coverage.byteLength) {
    throw new TypeError("sparse strip coverage payload has unreferenced bytes");
  }
}

/** Byte-bounded LRU for immutable sparse-strip identities. */
export class SparseGlyphStripCache {
  readonly #cache: BoundedCache<string, Readonly<SparseStripGlyph>>;
  readonly #maxBytes: number;

  constructor(options: Readonly<SparseGlyphStripCacheOptions>) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new TypeError("maxBytes must be a positive safe integer");
    }
    if (
      options.maxEntries !== undefined &&
      (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0)
    ) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
    this.#maxBytes = options.maxBytes;
    this.#cache = new BoundedCache({
      maxBytes: options.maxBytes,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      policy: "lru",
      sizeOf: (glyph) => glyph.allocatedBytes,
    });
  }

  get(key: string): Readonly<SparseStripGlyph> | undefined {
    assertCacheKey(key);
    const glyph = this.#cache.get(key);
    return glyph === undefined ? undefined : cloneSparseStripGlyph(glyph);
  }

  set(key: string, glyph: Readonly<SparseStripGlyph>): boolean {
    assertCacheKey(key);
    validateSparseStripGlyph(glyph);
    if (glyph.allocatedBytes > this.#maxBytes) return false;
    const existing = this.#cache.peek(key);
    if (existing !== undefined) {
      if (!equalSparseStripGlyphs(existing, glyph)) {
        throw new TypeError("sparse glyph strip key maps to a different glyph payload");
      }
      this.#cache.get(key);
      return true;
    }
    return this.#cache.set(key, cloneSparseStripGlyph(glyph));
  }

  getOrCreate(key: string, factory: () => Readonly<SparseStripGlyph>): Readonly<SparseStripGlyph> {
    assertCacheKey(key);
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cloneSparseStripGlyph(cached);
    const created = factory();
    validateSparseStripGlyph(created);
    if (created.allocatedBytes > this.#maxBytes) return cloneSparseStripGlyph(created);
    const owned = cloneSparseStripGlyph(created);
    this.#cache.set(key, owned);
    return cloneSparseStripGlyph(owned);
  }

  clear(): number {
    return this.#cache.clear();
  }

  get stats(): Readonly<BoundedCacheStats> {
    return this.#cache.stats;
  }
}

function assertIdentity(identity: Readonly<SparseGlyphStripIdentity>): void {
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError("sparse glyph identity must be an object");
  }
  if (typeof identity.family !== "string" || identity.family.length === 0) {
    throw new TypeError("family must be a non-empty string");
  }
  assertNonNegativeSafeInteger("fontRevision", identity.fontRevision);
  assertNonNegativeSafeInteger("glyphId", identity.glyphId);
  assertNonNegativeSafeInteger("padding", identity.padding);
  if (identity.variationKey !== undefined && typeof identity.variationKey !== "string") {
    throw new TypeError("variationKey must be a string");
  }
  if (identity.aaMode !== "grayscale" && identity.aaMode !== "binary") {
    throw new TypeError("aaMode must be grayscale or binary");
  }
}

function cloneSparseStripGlyph(glyph: Readonly<SparseStripGlyph>): Readonly<SparseStripGlyph> {
  return Object.freeze({
    schemaVersion: glyph.schemaVersion,
    tileSize: glyph.tileSize,
    width: glyph.width,
    height: glyph.height,
    tileColumns: glyph.tileColumns,
    tileRows: glyph.tileRows,
    header: glyph.header.slice(),
    strips: glyph.strips.slice(),
    coverage: glyph.coverage.slice(),
    allocatedBytes: glyph.allocatedBytes,
    denseEquivalentBytes: glyph.denseEquivalentBytes,
  });
}

function assertBitmap(bitmap: Readonly<OutlineCpuBitmap>): void {
  if (typeof bitmap !== "object" || bitmap === null) {
    throw new TypeError("outline bitmap must be an object");
  }
  assertPositiveUint32("bitmap width", bitmap.width);
  assertPositiveUint32("bitmap height", bitmap.height);
  if (!Number.isSafeInteger(bitmap.bytesPerRow) || bitmap.bytesPerRow < bitmap.width * 4) {
    throw new TypeError("bitmap bytesPerRow must cover one RGBA8 row");
  }
  if (!(bitmap.pixels instanceof Uint8Array)) {
    throw new TypeError("bitmap pixels must be a Uint8Array");
  }
  const requiredBytes = bitmap.bytesPerRow * bitmap.height;
  if (!Number.isSafeInteger(requiredBytes) || bitmap.pixels.byteLength < requiredBytes) {
    throw new TypeError("bitmap pixels must cover every declared row");
  }
  assertUint32("dense equivalent bytes", bitmap.width * bitmap.height);
}

function readBitmapAlpha(bitmap: Readonly<OutlineCpuBitmap>, x: number, y: number): number {
  return readByte(bitmap.pixels, y * bitmap.bytesPerRow + x * 4 + 3, "bitmap alpha");
}

function classifyBitmapTile(
  bitmap: Readonly<OutlineCpuBitmap>,
  tileX: number,
  tileY: number,
  sourceAlpha: number,
  aaMode: SparseStripAaMode,
): number {
  let transparent = true;
  let solid = true;
  for (let localY = 0; localY < SPARSE_STRIP_TILE_SIZE; localY += 1) {
    for (let localX = 0; localX < SPARSE_STRIP_TILE_SIZE; localX += 1) {
      const x = tileX * SPARSE_STRIP_TILE_SIZE + localX;
      const y = tileY * SPARSE_STRIP_TILE_SIZE + localY;
      const coverage =
        x < bitmap.width && y < bitmap.height
          ? normalizeCoverage(readBitmapAlpha(bitmap, x, y), sourceAlpha, aaMode)
          : 0;
      if (coverage !== 0) transparent = false;
      if (coverage !== 255) solid = false;
    }
  }
  if (transparent) return TILE_TRANSPARENT;
  return solid ? TILE_SOLID : TILE_BOUNDARY;
}

function writeBoundaryTileCoverage(
  bitmap: Readonly<OutlineCpuBitmap>,
  tileX: number,
  tileY: number,
  sourceAlpha: number,
  aaMode: SparseStripAaMode,
  target: Uint8Array,
  offset: number,
): void {
  let cursor = offset;
  for (let localY = 0; localY < SPARSE_STRIP_TILE_SIZE; localY += 1) {
    for (let localX = 0; localX < SPARSE_STRIP_TILE_SIZE; localX += 1) {
      const x = tileX * SPARSE_STRIP_TILE_SIZE + localX;
      const y = tileY * SPARSE_STRIP_TILE_SIZE + localY;
      target[cursor] =
        x < bitmap.width && y < bitmap.height
          ? normalizeCoverage(readBitmapAlpha(bitmap, x, y), sourceAlpha, aaMode)
          : 0;
      cursor += 1;
    }
  }
}

function writeStripRecord(
  strips: Uint32Array,
  recordIndex: number,
  tileY: number,
  tileX0: number,
  tileX1: number,
  coverageOffset: number,
): void {
  const offset = recordIndex * RECORD_WORDS;
  strips[offset + RECORD_TILE_Y] = tileY;
  strips[offset + RECORD_TILE_X0] = tileX0;
  strips[offset + RECORD_TILE_X1] = tileX1;
  strips[offset + RECORD_COVERAGE_OFFSET] = coverageOffset;
}

function normalizeCoverage(alpha: number, sourceAlpha: number, aaMode: SparseStripAaMode): number {
  const grayscale = Math.min(255, Math.max(0, Math.round(alpha / sourceAlpha)));
  return aaMode === "binary" ? Number(grayscale >= 128) * 255 : grayscale;
}

function equalSparseStripGlyphs(
  first: Readonly<SparseStripGlyph>,
  second: Readonly<SparseStripGlyph>,
): boolean {
  return (
    first.width === second.width &&
    first.height === second.height &&
    equalBytes(first.header, second.header) &&
    equalBytes(first.strips, second.strips) &&
    equalBytes(first.coverage, second.coverage)
  );
}

function equalBytes(first: Uint8Array | Uint32Array, second: Uint8Array | Uint32Array): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

function assertCacheKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("sparse glyph strip cache key must be a non-empty string");
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveUint32(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_U32) {
    throw new TypeError(`${name} must be a positive u32 integer`);
  }
}

function assertUint32(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new TypeError(`${name} must be a u32 integer`);
  }
}

function readWord(storage: Uint32Array, index: number, name: string): number {
  const value = storage[index];
  if (value === undefined) throw new TypeError(`${name} is outside its storage`);
  return value;
}

function readByte(storage: Uint8Array, index: number, name: string): number {
  const value = storage[index];
  if (value === undefined) throw new TypeError(`${name} is outside its storage`);
  return value;
}
