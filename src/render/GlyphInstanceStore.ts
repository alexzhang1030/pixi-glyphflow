import {
  DIRTY_ACCEPTED_GAP,
  DIRTY_MAX_RANGES,
  DIRTY_WHOLE_BUFFER_BPS,
  DirtyRanges,
} from "./DirtyRanges";
import { packF16 } from "./pack";
import {
  GLYPH_INSTANCE_STRIDE,
  type DirtyByteRange,
  type GlyphInstanceBatch,
  type GlyphInstanceCompactionResult,
  type GlyphInstanceRange,
  type GlyphInstanceStoreOptions,
  type GlyphInstanceStoreStats,
} from "./types";

interface MutableInstanceRange {
  offset: number;
  count: number;
  capacity: number;
}

interface FreeRange {
  offset: number;
  capacity: number;
}

const DEFAULT_CAPACITY = 16;
const DEFAULT_MAX_CAPACITY = 0x100_0000;
const ACTIVE_BIT = 0x8000_0000;
const RASTER_SCALE_SHIFT = 18;
const RASTER_SCALE_MAX = 0x1fff;
const RASTER_SCALE_PRECISION = 64;
const UINT16_PER_INSTANCE = GLYPH_INSTANCE_STRIDE / Uint16Array.BYTES_PER_ELEMENT;
const UINT32_PER_INSTANCE = GLYPH_INSTANCE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
const UV_U16 = 4;
const PALETTE_U32 = 4;
const METADATA_U32 = 5;

export interface GlyphInstanceSetOptions {
  /** Skip the byte-for-byte equality check when the caller already knows the run changed. */
  readonly skipEquality?: boolean;
}

export class GlyphInstanceStore {
  readonly #minimumCapacity: number;
  readonly #maxCapacity: number;
  readonly #ranges = new Map<number, MutableInstanceRange>();
  readonly #free = new InstanceFreeList();
  readonly #dirty = new DirtyRanges();
  #segmentEpoch = 0;
  #capacity: number;
  #highWater = 0;
  #activeInstances = 0;
  #buffer: ArrayBuffer;
  #uint8!: Uint8Array;
  #uint16!: Uint16Array;
  #uint32!: Uint32Array;
  #destroyed = false;

  constructor(options: GlyphInstanceStoreOptions = {}) {
    const initialCapacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    const maxCapacity = options.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    assertPositiveCapacity("initialCapacity", initialCapacity);
    assertPositiveCapacity("maxCapacity", maxCapacity);
    if (initialCapacity > maxCapacity) {
      throw new RangeError("initialCapacity exceeds maxCapacity");
    }
    this.#minimumCapacity = nextPowerOfTwo(initialCapacity);
    this.#maxCapacity = maxCapacity;
    this.#capacity = this.#minimumCapacity;
    this.#buffer = new ArrayBuffer(this.#capacity * GLYPH_INSTANCE_STRIDE);
    this.#bindViews(this.#buffer);
  }

  get buffer(): ArrayBuffer {
    this.#assertActive();
    return this.#buffer;
  }

  /**
   * Changes whenever existing ranges are disturbed: an in-place rewrite resizes a range or lands a
   * glyph on a different page, a range is released or relocated, or the store compacts. Brand-new
   * ranges do not bump it — their space was invalidated at release — so cached draw-segment
   * prefixes survive pure appends.
   */
  get segmentEpoch(): number {
    return this.#segmentEpoch;
  }

  set(labelId: number, batch: GlyphInstanceBatch, options?: GlyphInstanceSetOptions): boolean {
    this.#assertActive();
    assertLabelId(labelId);
    const count = validateBatch(batch);
    if (count === 0) {
      return this.remove(labelId);
    }
    const current = this.#ranges.get(labelId);
    if (
      current !== undefined &&
      current.count === count &&
      options?.skipEquality !== true &&
      this.#matches(current, batch)
    ) {
      return false;
    }

    if (current !== undefined && count <= current.capacity) {
      const dirtyCount = Math.max(current.count, count);
      this.#activeInstances += count - current.count;
      const metadataChanged = this.#write(current.offset, batch);
      this.#clearMetadata(current.offset + count, current.count - count);
      if (count !== current.count || metadataChanged) this.#segmentEpoch += 1;
      current.count = count;
      this.#dirty.record(
        current.offset * GLYPH_INSTANCE_STRIDE,
        dirtyCount * GLYPH_INSTANCE_STRIDE,
      );
      return true;
    }

    if (current !== undefined) this.#releaseLabelRange(labelId, current);

    const capacity = nextPowerOfTwo(count);
    const range = this.#allocateRange(capacity);
    range.count = count;
    this.#ranges.set(labelId, range);
    this.#write(range.offset, batch);
    this.#activeInstances += count;
    this.#dirty.record(range.offset * GLYPH_INSTANCE_STRIDE, count * GLYPH_INSTANCE_STRIDE);

    return true;
  }

  remove(labelId: number): boolean {
    this.#assertActive();
    assertLabelId(labelId);
    const range = this.#ranges.get(labelId);
    if (range === undefined) {
      return false;
    }
    this.#releaseLabelRange(labelId, range);

    return true;
  }

  getRange(labelId: number): Readonly<GlyphInstanceRange> | undefined {
    this.#assertActive();
    return this.#ranges.get(labelId);
  }

  clone(sourceId: number, destId: number): boolean {
    this.#assertActive();
    assertLabelId(sourceId);
    assertLabelId(destId);
    if (sourceId === destId) return false;
    const source = this.#ranges.get(sourceId);
    if (source === undefined || source.count === 0) return false;
    const count = source.count;
    const sourceOffset = source.offset;
    const current = this.#ranges.get(destId);
    if (current !== undefined && current.capacity >= count) {
      this.#copyInstances(sourceOffset, current.offset, count);
      this.#patchPalette(current.offset, count, destId);
      if (count < current.count) {
        this.#clearMetadata(current.offset + count, current.count - count);
      }
      this.#activeInstances += count - current.count;
      this.#segmentEpoch += 1;
      const dirtyCount = Math.max(current.count, count);
      current.count = count;
      this.#dirty.record(
        current.offset * GLYPH_INSTANCE_STRIDE,
        dirtyCount * GLYPH_INSTANCE_STRIDE,
      );
      return true;
    }
    if (current !== undefined) this.#releaseLabelRange(destId, current);

    const range = this.#allocateRange(nextPowerOfTwo(count));
    this.#copyInstances(sourceOffset, range.offset, count);
    this.#patchPalette(range.offset, count, destId);
    range.count = count;
    this.#ranges.set(destId, range);
    this.#activeInstances += count;
    this.#dirty.record(range.offset * GLYPH_INSTANCE_STRIDE, count * GLYPH_INSTANCE_STRIDE);
    return true;
  }

  consumeDirty(): readonly Readonly<DirtyByteRange>[] {
    this.#assertActive();
    return this.#dirty.publish({
      acceptedGap: DIRTY_ACCEPTED_GAP,
      maxRanges: DIRTY_MAX_RANGES,
      liveBytes: this.#highWater * GLYPH_INSTANCE_STRIDE,
      wholeBufferBps: DIRTY_WHOLE_BUFFER_BPS,
    });
  }

  compact(): Readonly<GlyphInstanceCompactionResult> {
    this.#assertActive();
    const beforeCapacity = this.#capacity;
    const beforeBytes = this.#buffer.byteLength;
    const afterCapacity = nextPowerOfTwo(Math.max(this.#minimumCapacity, this.#activeInstances));
    const buffer = new ArrayBuffer(afterCapacity * GLYPH_INSTANCE_STRIDE);
    const source = new Uint8Array(this.#buffer);
    const target = new Uint8Array(buffer);
    let offset = 0;
    for (const range of this.#ranges.values()) {
      const byteLength = range.count * GLYPH_INSTANCE_STRIDE;
      target.set(
        source.subarray(
          range.offset * GLYPH_INSTANCE_STRIDE,
          range.offset * GLYPH_INSTANCE_STRIDE + byteLength,
        ),
        offset * GLYPH_INSTANCE_STRIDE,
      );
      range.offset = offset;
      range.capacity = range.count;
      offset += range.count;
    }
    this.#buffer = buffer;
    this.#bindViews(buffer);
    this.#capacity = afterCapacity;
    this.#highWater = offset;
    this.#segmentEpoch += 1;
    this.#free.clear();
    if (offset < afterCapacity) {
      this.#free.insert(offset, afterCapacity - offset);
    }
    this.#dirty.clear();
    if (afterCapacity > 0) {
      this.#dirty.record(0, afterCapacity * GLYPH_INSTANCE_STRIDE);
    }
    const afterBytes = buffer.byteLength;

    return Object.freeze({
      beforeCapacity,
      afterCapacity,
      beforeBytes,
      afterBytes,
      releasedBytes: beforeBytes - afterBytes,
    });
  }

  get stats(): Readonly<GlyphInstanceStoreStats> {
    return Object.freeze({
      labels: this.#ranges.size,
      activeInstances: this.#activeInstances,
      capacity: this.#capacity,
      highWater: this.#highWater,
      freeInstances: this.#free.totalCapacity(),
      allocatedBytes: this.#buffer.byteLength,
      pendingDirtyRanges: this.#dirty.pendingRanges,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#ranges.clear();
    this.#free.clear();
    this.#dirty.clear();
    this.#buffer = new ArrayBuffer(0);
    this.#bindViews(this.#buffer);
    this.#capacity = 0;
    this.#highWater = 0;
    this.#activeInstances = 0;
    this.#destroyed = true;
  }

  #matches(range: MutableInstanceRange, batch: GlyphInstanceBatch): boolean {
    const uint16 = this.#uint16;
    const uint32 = this.#uint32;
    for (let index = 0; index < range.count; index += 1) {
      const u16 = (range.offset + index) * UINT16_PER_INSTANCE;
      const u32 = (range.offset + index) * UINT32_PER_INSTANCE;
      const inputOffset = index * 4;
      if (
        uint16[u16] !== packF16(batch.positions[inputOffset] ?? 0) ||
        uint16[u16 + 1] !== packF16(batch.positions[inputOffset + 1] ?? 0) ||
        uint16[u16 + 2] !== packF16(batch.positions[inputOffset + 2] ?? 0) ||
        uint16[u16 + 3] !== packF16(batch.positions[inputOffset + 3] ?? 0) ||
        uint16[u16 + UV_U16] !== packUv(batch.uvs[inputOffset] ?? 0) ||
        uint16[u16 + UV_U16 + 1] !== packUv(batch.uvs[inputOffset + 1] ?? 0) ||
        uint16[u16 + UV_U16 + 2] !== packUv(batch.uvs[inputOffset + 2] ?? 0) ||
        uint16[u16 + UV_U16 + 3] !== packUv(batch.uvs[inputOffset + 3] ?? 0) ||
        uint32[u32 + PALETTE_U32] !== batch.paletteIndices[index] ||
        uint32[u32 + METADATA_U32] !== metadata(batch, index)
      ) {
        return false;
      }
    }

    return true;
  }

  #copyInstances(sourceOffset: number, destOffset: number, count: number): void {
    const bytes = count * GLYPH_INSTANCE_STRIDE;
    const sourceByte = sourceOffset * GLYPH_INSTANCE_STRIDE;
    this.#uint8.copyWithin(destOffset * GLYPH_INSTANCE_STRIDE, sourceByte, sourceByte + bytes);
  }

  #patchPalette(offset: number, count: number, paletteIndex: number): void {
    const uint32 = this.#uint32;
    for (let index = 0; index < count; index += 1) {
      uint32[(offset + index) * UINT32_PER_INSTANCE + PALETTE_U32] = paletteIndex;
    }
  }

  /** Returns whether any metadata word (page and flag bits) changed, for segment caching. */
  #write(offset: number, batch: GlyphInstanceBatch): boolean {
    const uint16 = this.#uint16;
    const uint32 = this.#uint32;
    const count = batch.paletteIndices.length;
    let metadataChanged = false;
    for (let index = 0; index < count; index += 1) {
      const u16 = (offset + index) * UINT16_PER_INSTANCE;
      const u32 = (offset + index) * UINT32_PER_INSTANCE;
      const inputOffset = index * 4;
      uint16[u16] = packF16(batch.positions[inputOffset] ?? 0);
      uint16[u16 + 1] = packF16(batch.positions[inputOffset + 1] ?? 0);
      uint16[u16 + 2] = packF16(batch.positions[inputOffset + 2] ?? 0);
      uint16[u16 + 3] = packF16(batch.positions[inputOffset + 3] ?? 0);
      uint16[u16 + UV_U16] = packUv(batch.uvs[inputOffset] ?? 0);
      uint16[u16 + UV_U16 + 1] = packUv(batch.uvs[inputOffset + 1] ?? 0);
      uint16[u16 + UV_U16 + 2] = packUv(batch.uvs[inputOffset + 2] ?? 0);
      uint16[u16 + UV_U16 + 3] = packUv(batch.uvs[inputOffset + 3] ?? 0);
      uint32[u32 + PALETTE_U32] = batch.paletteIndices[index] ?? 0;
      const nextMetadata = metadata(batch, index);
      if (uint32[u32 + METADATA_U32] !== nextMetadata) metadataChanged = true;
      uint32[u32 + METADATA_U32] = nextMetadata;
    }

    return metadataChanged;
  }

  #clearMetadata(offset: number, count: number): void {
    const uint32 = this.#uint32;
    for (let index = 0; index < count; index += 1) {
      uint32[(offset + index) * UINT32_PER_INSTANCE + METADATA_U32] = 0;
    }
  }

  #allocateRange(capacity: number): MutableInstanceRange {
    const taken = this.#free.take(capacity);
    if (taken !== undefined) {
      return { offset: taken.offset, count: 0, capacity };
    }

    const required = this.#highWater + capacity;
    this.#ensureCapacity(required);
    const range = { offset: this.#highWater, count: 0, capacity };
    this.#highWater = required;
    return range;
  }

  #releaseRange(range: GlyphInstanceRange): void {
    this.#free.insert(range.offset, range.capacity);
  }

  #releaseLabelRange(labelId: number, range: MutableInstanceRange): void {
    this.#clearMetadata(range.offset, range.count);
    this.#dirty.record(range.offset * GLYPH_INSTANCE_STRIDE, range.count * GLYPH_INSTANCE_STRIDE);
    this.#activeInstances -= range.count;
    this.#ranges.delete(labelId);
    this.#releaseRange(range);
    this.#segmentEpoch += 1;
  }

  #ensureCapacity(required: number): void {
    if (required > this.#maxCapacity) {
      throw new RangeError(`Glyph instance capacity exceeds ${String(this.#maxCapacity)}`);
    }
    if (required <= this.#capacity) return;
    let capacity = this.#capacity;
    while (capacity < required) capacity *= 2;
    capacity = Math.min(capacity, this.#maxCapacity);
    const buffer = new ArrayBuffer(capacity * GLYPH_INSTANCE_STRIDE);
    new Uint8Array(buffer).set(this.#uint8);
    this.#buffer = buffer;
    this.#bindViews(buffer);
    this.#capacity = capacity;
    this.#dirty.clear();
    if (this.#highWater > 0) {
      this.#dirty.record(0, this.#highWater * GLYPH_INSTANCE_STRIDE);
    }
  }

  #bindViews(buffer: ArrayBuffer): void {
    const views = bindInstanceViews(buffer);
    this.#uint8 = views.uint8;
    this.#uint16 = views.uint16;
    this.#uint32 = views.uint32;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("GlyphInstanceStore has been destroyed");
    }
  }
}

const MAX_FREE_CLASS = 24;

class InstanceFreeList {
  readonly #buckets: FreeRange[][] = Array.from({ length: MAX_FREE_CLASS + 1 }, () => []);
  readonly #byOffset = new Map<number, FreeRange>();
  readonly #byEnd = new Map<number, FreeRange>();

  clear(): void {
    for (const bucket of this.#buckets) bucket.length = 0;
    this.#byOffset.clear();
    this.#byEnd.clear();
  }

  totalCapacity(): number {
    let sum = 0;
    for (const range of this.#byOffset.values()) sum += range.capacity;
    return sum;
  }

  insert(offset: number, capacity: number): void {
    if (capacity <= 0) return;
    let start = offset;
    let size = capacity;
    const previous = this.#byEnd.get(start);
    if (previous !== undefined) {
      this.#detach(previous);
      start = previous.offset;
      size += previous.capacity;
    }
    const next = this.#byOffset.get(start + size);
    if (next !== undefined) {
      this.#detach(next);
      size += next.capacity;
    }
    const range: FreeRange = { offset: start, capacity: size };
    this.#byOffset.set(start, range);
    this.#byEnd.set(start + size, range);
    this.#bucket(size).push(range);
  }

  take(need: number): { offset: number; capacity: number } | undefined {
    const startClass = sizeClass(need);
    for (let klass = startClass; klass <= MAX_FREE_CLASS; klass += 1) {
      const bucket = this.#buckets[klass];
      if (bucket === undefined) continue;
      for (let index = 0; index < bucket.length; index += 1) {
        const range = bucket[index];
        if (range !== undefined && range.capacity >= need) {
          this.#detach(range);
          if (range.capacity > need) {
            this.insert(range.offset + need, range.capacity - need);
          }
          return { offset: range.offset, capacity: need };
        }
      }
    }
    return undefined;
  }

  #detach(range: FreeRange): void {
    this.#byOffset.delete(range.offset);
    this.#byEnd.delete(range.offset + range.capacity);
    const bucket = this.#bucket(range.capacity);
    const index = bucket.indexOf(range);
    if (index >= 0) bucket.splice(index, 1);
  }

  #bucket(capacity: number): FreeRange[] {
    const klass = sizeClass(capacity);
    const bucket = this.#buckets[klass];
    if (bucket === undefined) {
      throw new RangeError(`Instance free-list size class ${String(klass)} is out of range`);
    }
    return bucket;
  }
}

function sizeClass(value: number): number {
  return 31 - Math.clz32(value);
}

function validateBatch(batch: GlyphInstanceBatch): number {
  if (!(batch.positions instanceof Float32Array)) {
    throw new TypeError("positions must be a Float32Array");
  }
  if (!(batch.uvs instanceof Float32Array)) {
    throw new TypeError("uvs must be a Float32Array");
  }
  if (!(batch.paletteIndices instanceof Uint32Array)) {
    throw new TypeError("paletteIndices must be a Uint32Array");
  }
  if (!(batch.pages instanceof Uint16Array)) {
    throw new TypeError("pages must be a Uint16Array");
  }
  if (!(batch.modes instanceof Uint8Array)) {
    throw new TypeError("modes must be a Uint8Array");
  }
  if (batch.rasterScales !== undefined && !(batch.rasterScales instanceof Float32Array)) {
    throw new TypeError("rasterScales must be a Float32Array");
  }
  const count = batch.paletteIndices.length;
  if (
    batch.positions.length !== count * 4 ||
    batch.uvs.length !== count * 4 ||
    batch.pages.length !== count ||
    batch.modes.length !== count ||
    (batch.rasterScales !== undefined && batch.rasterScales.length !== count)
  ) {
    throw new TypeError("Glyph instance batch arrays have inconsistent lengths");
  }
  for (const value of batch.positions) {
    if (!Number.isFinite(value)) {
      throw new TypeError("Glyph positions and sizes must be finite");
    }
  }
  for (const value of batch.uvs) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError("Glyph UV values must be finite values from 0 to 1");
    }
  }
  for (const mode of batch.modes) {
    if (mode > 3) {
      throw new TypeError("Glyph modes must use values from 0 to 3");
    }
  }
  for (const scale of batch.rasterScales ?? []) {
    if (!Number.isFinite(scale) || scale < 1) {
      throw new TypeError("Glyph raster scales must be finite values greater than or equal to 1");
    }
  }

  return count;
}

function metadata(batch: GlyphInstanceBatch, index: number): number {
  const rasterScale = batch.rasterScales?.[index] ?? 1;
  const packedRasterScale = Math.min(
    RASTER_SCALE_MAX,
    Math.max(1, Math.round(rasterScale * RASTER_SCALE_PRECISION)),
  );
  return (
    (ACTIVE_BIT |
      (packedRasterScale << RASTER_SCALE_SHIFT) |
      ((batch.modes[index] ?? 0) << 16) |
      (batch.pages[index] ?? 0)) >>>
    0
  );
}

function packUv(value: number): number {
  return Math.round(value * 65_535);
}

function assertLabelId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("labelId must be a non-negative safe integer");
  }
}

function assertPositiveCapacity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function bindInstanceViews(buffer: ArrayBuffer): {
  readonly uint8: Uint8Array;
  readonly uint16: Uint16Array;
  readonly uint32: Uint32Array;
} {
  return {
    uint8: new Uint8Array(buffer),
    uint16: new Uint16Array(buffer),
    uint32: new Uint32Array(buffer),
  };
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
