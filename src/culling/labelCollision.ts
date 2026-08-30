import type {
  BoundsData,
  LabelCollisionAabb,
  MutableLabelCollisionAabb,
  ScreenTransform,
} from "./types";

/**
 * Storage-buffer-compatible record: `vec4<f32> bounds`, `vec2<f32> priorityZ`, `vec2<u32>
 * orderSlot`.
 */
export const LABEL_COLLISION_RECORD_STRIDE = 32;
export const LABEL_COLLISION_RECORD_WGSL = `
struct LabelCollisionRecord {
  bounds: vec4<f32>,
  priorityZ: vec2<f32>,
  orderSlot: vec2<u32>,
};
`;
export const DEFAULT_LABEL_COLLISION_CELL_SIZE = 64;
const WORDS_PER_RECORD = LABEL_COLLISION_RECORD_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
const MAX_GRID_CELLS_PER_LABEL = 256;

export interface LabelCollisionRecordInput extends LabelCollisionAabb {
  readonly priority: number;
  readonly zIndex: number;
  readonly order: number;
  readonly slot: number;
}

export interface LabelCollisionSelectorOptions {
  /** Screen-pixel expansion applied to every candidate box. */
  readonly padding?: number;
  /** Global admission ceiling after collision resolution. */
  readonly maxVisible?: number;
  /** Screen-pixel hash cell size used by the CPU reference. */
  readonly cellSize?: number;
  /** Validate packed bounds and priorities before selection. Default is true. */
  readonly validateRecords?: boolean;
}

export interface LabelCollisionSelectionResult {
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly collisionCulledCount: number;
  readonly densityCulledCount: number;
  /** FNV-1a over selected slots in draw order; zero identifies an empty selection. */
  readonly selectionHash: number;
}

/**
 * Reusable CPU reference for map-style label admission. Higher priority wins; equal priority uses
 * the earlier insertion order. Selected slots are emitted in z-index then insertion order.
 */
export class LabelCollisionSelector {
  readonly #padding: number;
  readonly #maxVisible: number;
  readonly #cellSize: number;
  readonly #validateRecords: boolean;
  #ranked = new Uint32Array(0);
  #selected = new Uint32Array(0);
  #seen = new Uint32Array(0);
  #seenEpoch = 0;
  readonly #rows = new Map<number, Map<number, number[]>>();
  readonly #usedBuckets: number[][] = [];
  readonly #bucketPool: number[][] = [];
  readonly #spill: number[] = [];
  readonly #identicalRunLengths = new Map<number, number>();
  readonly #candidateBox: MutableLabelCollisionAabb = {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  };
  readonly #cellRange = { minX: 0, minY: 0, maxX: 0, maxY: 0, count: 0 };
  #destroyed = false;

  constructor(options: LabelCollisionSelectorOptions = {}) {
    this.#padding = options.padding ?? 0;
    this.#maxVisible = options.maxVisible ?? Number.MAX_SAFE_INTEGER;
    this.#cellSize = options.cellSize ?? DEFAULT_LABEL_COLLISION_CELL_SIZE;
    this.#validateRecords = options.validateRecords ?? true;
    assertFiniteNonNegative("padding", this.#padding);
    if (!Number.isSafeInteger(this.#maxVisible) || this.#maxVisible < 0) {
      throw new TypeError("Label collision maxVisible must be a non-negative safe integer");
    }
    if (!Number.isFinite(this.#cellSize) || this.#cellSize <= 0) {
      throw new TypeError("Label collision cellSize must be a finite positive number");
    }
    if (typeof this.#validateRecords !== "boolean") {
      throw new TypeError("Label collision validateRecords must be a boolean");
    }
  }

  get allocatedBytes(): number {
    return this.#ranked.byteLength + this.#selected.byteLength + this.#seen.byteLength;
  }

  select(
    records: ArrayBuffer,
    recordCount: number,
    output: Uint32Array,
  ): Readonly<LabelCollisionSelectionResult> {
    assertDenseSelectionInput(records, recordCount, output);
    return this.#select(records, undefined, recordCount, output);
  }

  /**
   * Select from a sparse resident record buffer. `candidateSlots` may alias `output`; candidates
   * are copied into reusable rank scratch before selected slots are written.
   */
  selectCandidates(
    records: ArrayBuffer,
    candidateSlots: Uint32Array,
    candidateCount: number,
    output: Uint32Array,
  ): Readonly<LabelCollisionSelectionResult> {
    assertCandidateSelectionInput(records, candidateSlots, candidateCount, output);
    return this.#select(records, candidateSlots, candidateCount, output);
  }

  /**
   * Select a sparse, strictly increasing slot list whose order already matches admission order.
   * TextLayer proves this from monotonic slot allocation and priority before using the
   * zero-rank-scan path.
   *
   * @internal
   */
  selectRankedCandidates(
    records: ArrayBuffer,
    candidateSlots: Uint32Array,
    candidateCount: number,
    output: Uint32Array,
  ): Readonly<LabelCollisionSelectionResult> {
    assertCandidateSelectionInput(records, candidateSlots, candidateCount, output);
    return this.#select(records, candidateSlots, candidateCount, output, true);
  }

  /** Retire identical-bound run metadata after any packed collision record changes. @internal */
  invalidateRunCache(): void {
    if (this.#destroyed) throw new Error("LabelCollisionSelector has been destroyed");
    this.#identicalRunLengths.clear();
  }

  /** Retire the cached identical-bound span containing one changed record. @internal */
  invalidateRecord(slot: number): void {
    if (this.#destroyed) throw new Error("LabelCollisionSelector has been destroyed");
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new TypeError("Label collision invalidation slot must be a non-negative safe integer");
    }
    for (const [leader, length] of this.#identicalRunLengths) {
      if (slot < leader || slot >= leader + length) continue;
      this.#identicalRunLengths.delete(leader);
    }
  }

  /** Retire cached identical-bound spans touched by a packed slot batch. @internal */
  invalidateRecords(slots: Uint32Array, count: number): void {
    if (this.#destroyed) throw new Error("LabelCollisionSelector has been destroyed");
    if (!(slots instanceof Uint32Array) || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("Label collision invalidation requires a packed slot batch");
    }
    if (count > slots.length) {
      throw new RangeError("Label collision invalidation count exceeds the packed slot batch");
    }
    if (count === 0 || this.#identicalRunLengths.size === 0) return;
    runs: for (const [leader, length] of this.#identicalRunLengths) {
      const end = leader + length;
      for (let index = 0; index < count; index += 1) {
        const slot = slots[index] ?? 0;
        if (slot < leader || slot >= end) continue;
        this.#identicalRunLengths.delete(leader);
        continue runs;
      }
    }
  }

  #select(
    records: ArrayBuffer,
    candidateSlots: Uint32Array | undefined,
    candidateCount: number,
    output: Uint32Array,
    candidatesRanked = false,
  ): Readonly<LabelCollisionSelectionResult> {
    if (this.#destroyed) throw new Error("LabelCollisionSelector has been destroyed");
    this.#resetGrid();
    const residentCount = records.byteLength / LABEL_COLLISION_RECORD_STRIDE;
    if (candidateCount === 0) return emptyResult();
    if (this.#maxVisible === 0) {
      return Object.freeze({
        candidateCount,
        selectedCount: 0,
        collisionCulledCount: 0,
        densityCulledCount: candidateCount,
        selectionHash: 0,
      });
    }
    this.#ensureCapacity(candidateCount, residentCount);

    const floats = new Float32Array(records);
    const uints = new Uint32Array(records);
    let rank: Uint32Array;
    if (candidatesRanked) {
      if (candidateSlots === undefined) {
        throw new Error("Ranked collision selection requires sparse candidate slots");
      }
      if (this.#validateRecords) {
        let previousRecord = 0;
        for (let index = 0; index < candidateCount; index += 1) {
          const recordIndex = candidateSlots[index] ?? 0;
          if (recordIndex >= residentCount) {
            throw new RangeError(
              "Label collision candidate slot exceeds the resident record buffer",
            );
          }
          assertRecordAt(floats, recordIndex);
          if (index > 0 && compareAdmission(floats, uints, previousRecord, recordIndex) > 0) {
            throw new TypeError("Ranked collision candidates must follow admission order");
          }
          previousRecord = recordIndex;
        }
      }
      rank = candidateSlots.subarray(0, candidateCount);
    } else {
      let ranked = true;
      let previousRecord = 0;
      for (let index = 0; index < candidateCount; index += 1) {
        const recordIndex = candidateSlots?.[index] ?? index;
        if (recordIndex >= residentCount) {
          throw new RangeError("Label collision candidate slot exceeds the resident record buffer");
        }
        this.#ranked[index] = recordIndex;
        if (this.#validateRecords) assertRecordAt(floats, recordIndex);
        if (index > 0 && compareAdmission(floats, uints, previousRecord, recordIndex) > 0) {
          ranked = false;
        }
        previousRecord = recordIndex;
      }
      rank = this.#ranked.subarray(0, candidateCount);
      if (!ranked) rank.sort((left, right) => compareAdmission(floats, uints, left, right));
    }

    let selectedCount = 0;
    let collisionCulledCount = 0;
    let densityCulledCount = 0;
    for (let position = 0; position < candidateCount; position += 1) {
      const recordIndex = rank[position] ?? 0;
      const box = readPaddedBox(floats, recordIndex, this.#padding, this.#candidateBox);
      if (this.#collides(floats, box, selectedCount)) {
        collisionCulledCount += 1;
        const next =
          box.maxX > box.minX && box.maxY > box.minY
            ? this.#skipIdenticalBounds(
                floats,
                rank,
                position + 1,
                candidateCount,
                recordIndex,
                candidatesRanked,
              )
            : position + 1;
        collisionCulledCount += next - position - 1;
        position = next - 1;
        continue;
      }
      this.#selected[selectedCount] = recordIndex;
      selectedCount += 1;
      this.#insert(recordIndex, box);
      if (selectedCount === this.#maxVisible) {
        densityCulledCount = candidateCount - position - 1;
        break;
      }
      const next =
        box.maxX > box.minX && box.maxY > box.minY
          ? this.#skipIdenticalBounds(
              floats,
              rank,
              position + 1,
              candidateCount,
              recordIndex,
              candidatesRanked,
            )
          : position + 1;
      collisionCulledCount += next - position - 1;
      position = next - 1;
    }

    const selected = this.#selected.subarray(0, selectedCount);
    if (selectedCount > 1) {
      selected.sort((left, right) => compareDrawOrder(floats, uints, left, right));
    }
    let selectionHash = selectedCount === 0 ? 0 : 0x811c_9dc5;
    for (let index = 0; index < selectedCount; index += 1) {
      const slot = uints[(selected[index] ?? 0) * WORDS_PER_RECORD + 7] ?? 0;
      output[index] = slot;
      selectionHash = Math.imul(selectionHash ^ slot, 0x0100_0193) >>> 0;
    }

    return Object.freeze({
      candidateCount,
      selectedCount,
      collisionCulledCount,
      densityCulledCount,
      selectionHash,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#resetGrid();
    this.#ranked = new Uint32Array(0);
    this.#selected = new Uint32Array(0);
    this.#seen = new Uint32Array(0);
    this.#bucketPool.length = 0;
    this.#identicalRunLengths.clear();
    this.#destroyed = true;
  }

  #skipIdenticalBounds(
    floats: Float32Array,
    ranked: Uint32Array,
    start: number,
    candidateCount: number,
    recordIndex: number,
    cacheable: boolean,
  ): number {
    const leaderPosition = start - 1;
    if (cacheable && !this.#validateRecords) {
      const cachedLength = this.#identicalRunLengths.get(recordIndex) ?? 0;
      const cachedEnd = leaderPosition + cachedLength;
      if (
        cachedLength > 1 &&
        cachedEnd <= candidateCount &&
        ranked[cachedEnd - 1] === recordIndex + cachedLength - 1
      ) {
        return cachedEnd;
      }
    }

    const end = skipIdenticalBounds(floats, ranked, start, candidateCount, recordIndex);
    const length = end - leaderPosition;
    if (
      cacheable &&
      !this.#validateRecords &&
      length > 1 &&
      ranked[end - 1] === recordIndex + length - 1
    ) {
      this.#identicalRunLengths.set(recordIndex, length);
    }
    return end;
  }

  #collides(
    floats: Float32Array,
    box: Readonly<LabelCollisionAabb>,
    selectedCount: number,
  ): boolean {
    const cells = cellRange(box, this.#cellSize, this.#cellRange);
    if (cells.count > MAX_GRID_CELLS_PER_LABEL) {
      for (let index = 0; index < selectedCount; index += 1) {
        const accepted = this.#selected[index] ?? 0;
        if (recordsOverlap(floats, accepted, box, this.#padding)) return true;
      }
      return false;
    }

    for (const accepted of this.#spill) {
      if (recordsOverlap(floats, accepted, box, this.#padding)) return true;
    }
    const epoch = this.#nextSeenEpoch();
    for (let cy = cells.minY; cy <= cells.maxY; cy += 1) {
      const row = this.#rows.get(cy);
      if (row === undefined) continue;
      for (let cx = cells.minX; cx <= cells.maxX; cx += 1) {
        const bucket = row.get(cx);
        if (bucket === undefined) continue;
        for (const accepted of bucket) {
          if (this.#seen[accepted] === epoch) continue;
          this.#seen[accepted] = epoch;
          if (recordsOverlap(floats, accepted, box, this.#padding)) return true;
        }
      }
    }
    return false;
  }

  #insert(recordIndex: number, box: Readonly<LabelCollisionAabb>): void {
    const cells = cellRange(box, this.#cellSize, this.#cellRange);
    if (cells.count > MAX_GRID_CELLS_PER_LABEL) {
      this.#spill.push(recordIndex);
      return;
    }
    for (let cy = cells.minY; cy <= cells.maxY; cy += 1) {
      let row = this.#rows.get(cy);
      if (row === undefined) {
        row = new Map();
        this.#rows.set(cy, row);
      }
      for (let cx = cells.minX; cx <= cells.maxX; cx += 1) {
        let bucket = row.get(cx);
        if (bucket === undefined) {
          bucket = this.#bucketPool.pop() ?? [];
          row.set(cx, bucket);
          this.#usedBuckets.push(bucket);
        }
        bucket.push(recordIndex);
      }
    }
  }

  #nextSeenEpoch(): number {
    this.#seenEpoch += 1;
    if (this.#seenEpoch > 0xffff_ffff) {
      this.#seen.fill(0);
      this.#seenEpoch = 1;
    }
    return this.#seenEpoch;
  }

  #ensureCapacity(candidateCount: number, residentCount: number): void {
    if (this.#ranked.length < candidateCount) {
      let capacity = Math.max(64, this.#ranked.length * 2);
      while (capacity < candidateCount) capacity *= 2;
      this.#ranked = new Uint32Array(capacity);
    }
    const selectedCount = Math.min(candidateCount, this.#maxVisible);
    if (this.#selected.length < selectedCount) {
      let capacity = Math.max(64, this.#selected.length * 2);
      while (capacity < selectedCount) capacity *= 2;
      this.#selected = new Uint32Array(capacity);
    }
    if (this.#seen.length >= residentCount) return;
    let capacity = Math.max(64, this.#seen.length * 2);
    while (capacity < residentCount) capacity *= 2;
    this.#seen = new Uint32Array(capacity);
  }

  #resetGrid(): void {
    for (const bucket of this.#usedBuckets) {
      bucket.length = 0;
      this.#bucketPool.push(bucket);
    }
    this.#usedBuckets.length = 0;
    this.#rows.clear();
    this.#spill.length = 0;
  }
}

export function packLabelCollisionRecords(
  records: readonly Readonly<LabelCollisionRecordInput>[],
): ArrayBuffer {
  const buffer = new ArrayBuffer(records.length * LABEL_COLLISION_RECORD_STRIDE);
  const floats = new Float32Array(buffer);
  const uints = new Uint32Array(buffer);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record !== undefined) writeLabelCollisionRecordAt(floats, uints, index, record);
  }
  return buffer;
}

export function writeLabelCollisionRecordAt(
  floats: Float32Array,
  uints: Uint32Array,
  index: number,
  record: Readonly<LabelCollisionRecordInput>,
): void {
  const base = index * WORDS_PER_RECORD;
  floats[base] = record.minX;
  floats[base + 1] = record.minY;
  floats[base + 2] = record.maxX;
  floats[base + 3] = record.maxY;
  floats[base + 4] = record.priority;
  floats[base + 5] = record.zIndex;
  uints[base + 6] = record.order;
  uints[base + 7] = record.slot;
}

export function projectLabelCollisionAabb(
  bounds: BoundsData,
  transform: ScreenTransform,
  output: MutableLabelCollisionAabb = { minX: 0, minY: 0, maxX: 0, maxY: 0 },
): Readonly<LabelCollisionAabb> {
  const x0 = transform.a * bounds.x + transform.c * bounds.y + transform.tx;
  const y0 = transform.b * bounds.x + transform.d * bounds.y + transform.ty;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const x1 = transform.a * right + transform.c * bounds.y + transform.tx;
  const y1 = transform.b * right + transform.d * bounds.y + transform.ty;
  const x2 = transform.a * right + transform.c * bottom + transform.tx;
  const y2 = transform.b * right + transform.d * bottom + transform.ty;
  const x3 = transform.a * bounds.x + transform.c * bottom + transform.tx;
  const y3 = transform.b * bounds.x + transform.d * bottom + transform.ty;
  output.minX = Math.min(x0, x1, x2, x3);
  output.minY = Math.min(y0, y1, y2, y3);
  output.maxX = Math.max(x0, x1, x2, x3);
  output.maxY = Math.max(y0, y1, y2, y3);
  return output;
}

function compareAdmission(
  floats: Float32Array,
  uints: Uint32Array,
  left: number,
  right: number,
): number {
  const leftBase = left * WORDS_PER_RECORD;
  const rightBase = right * WORDS_PER_RECORD;
  const priority = (floats[rightBase + 4] ?? 0) - (floats[leftBase + 4] ?? 0);
  if (priority !== 0) return priority;
  const order = (uints[leftBase + 6] ?? 0) - (uints[rightBase + 6] ?? 0);
  if (order !== 0) return order;
  return (uints[leftBase + 7] ?? 0) - (uints[rightBase + 7] ?? 0);
}

function compareDrawOrder(
  floats: Float32Array,
  uints: Uint32Array,
  left: number,
  right: number,
): number {
  const leftBase = left * WORDS_PER_RECORD;
  const rightBase = right * WORDS_PER_RECORD;
  const zIndex = (floats[leftBase + 5] ?? 0) - (floats[rightBase + 5] ?? 0);
  if (zIndex !== 0) return zIndex;
  const order = (uints[leftBase + 6] ?? 0) - (uints[rightBase + 6] ?? 0);
  if (order !== 0) return order;
  return (uints[leftBase + 7] ?? 0) - (uints[rightBase + 7] ?? 0);
}

function readPaddedBox(
  floats: Float32Array,
  recordIndex: number,
  padding: number,
  output: MutableLabelCollisionAabb,
): Readonly<LabelCollisionAabb> {
  const base = recordIndex * WORDS_PER_RECORD;
  output.minX = (floats[base] ?? 0) - padding;
  output.minY = (floats[base + 1] ?? 0) - padding;
  output.maxX = (floats[base + 2] ?? 0) + padding;
  output.maxY = (floats[base + 3] ?? 0) + padding;
  return output;
}

function recordsOverlap(
  floats: Float32Array,
  recordIndex: number,
  box: Readonly<LabelCollisionAabb>,
  padding: number,
): boolean {
  const base = recordIndex * WORDS_PER_RECORD;
  const minX = (floats[base] ?? 0) - padding;
  const minY = (floats[base + 1] ?? 0) - padding;
  const maxX = (floats[base + 2] ?? 0) + padding;
  const maxY = (floats[base + 3] ?? 0) + padding;
  return maxX > box.minX && minX < box.maxX && maxY > box.minY && minY < box.maxY;
}

function skipIdenticalBounds(
  floats: Float32Array,
  ranked: Uint32Array,
  start: number,
  candidateCount: number,
  recordIndex: number,
): number {
  const base = recordIndex * WORDS_PER_RECORD;
  const minX = floats[base];
  const minY = floats[base + 1];
  const maxX = floats[base + 2];
  const maxY = floats[base + 3];
  let position = start;
  while (position < candidateCount) {
    const nextBase = (ranked[position] ?? 0) * WORDS_PER_RECORD;
    if (
      floats[nextBase] !== minX ||
      floats[nextBase + 1] !== minY ||
      floats[nextBase + 2] !== maxX ||
      floats[nextBase + 3] !== maxY
    ) {
      break;
    }
    position += 1;
  }
  return position;
}

function cellRange(
  box: Readonly<LabelCollisionAabb>,
  cellSize: number,
  output: { minX: number; minY: number; maxX: number; maxY: number; count: number },
): Readonly<{ minX: number; minY: number; maxX: number; maxY: number; count: number }> {
  const minX = Math.floor(box.minX / cellSize);
  const minY = Math.floor(box.minY / cellSize);
  const maxX = Math.floor(box.maxX / cellSize);
  const maxY = Math.floor(box.maxY / cellSize);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  output.minX = minX;
  output.minY = minY;
  output.maxX = maxX;
  output.maxY = maxY;
  if (
    !Number.isSafeInteger(minX) ||
    !Number.isSafeInteger(minY) ||
    !Number.isSafeInteger(maxX) ||
    !Number.isSafeInteger(maxY)
  ) {
    output.count = MAX_GRID_CELLS_PER_LABEL + 1;
    return output;
  }
  output.count =
    width > MAX_GRID_CELLS_PER_LABEL || height > MAX_GRID_CELLS_PER_LABEL
      ? MAX_GRID_CELLS_PER_LABEL + 1
      : width * height;
  return output;
}

function assertDenseSelectionInput(
  records: ArrayBuffer,
  recordCount: number,
  output: Uint32Array,
): void {
  if (!(records instanceof ArrayBuffer)) {
    throw new TypeError("Label collision records must be an ArrayBuffer");
  }
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new TypeError("Label collision recordCount must be a non-negative safe integer");
  }
  if (records.byteLength < recordCount * LABEL_COLLISION_RECORD_STRIDE) {
    throw new RangeError("Label collision record buffer is shorter than recordCount");
  }
  if (records.byteLength % LABEL_COLLISION_RECORD_STRIDE !== 0) {
    throw new RangeError("Label collision record buffer must contain whole records");
  }
  if (!(output instanceof Uint32Array) || output.length < recordCount) {
    throw new RangeError("Label collision output must hold every candidate slot");
  }
}

function assertCandidateSelectionInput(
  records: ArrayBuffer,
  candidateSlots: Uint32Array,
  candidateCount: number,
  output: Uint32Array,
): void {
  if (!(records instanceof ArrayBuffer)) {
    throw new TypeError("Label collision records must be an ArrayBuffer");
  }
  if (!(candidateSlots instanceof Uint32Array)) {
    throw new TypeError("Label collision candidates must be a Uint32Array");
  }
  if (
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < 0 ||
    candidateCount > candidateSlots.length
  ) {
    throw new RangeError("Label collision candidateCount exceeds the candidate slot list");
  }
  if (!(output instanceof Uint32Array) || output.length < candidateCount) {
    throw new RangeError("Label collision output must hold every candidate slot");
  }
  if (records.byteLength % LABEL_COLLISION_RECORD_STRIDE !== 0) {
    throw new RangeError("Label collision record buffer must contain whole records");
  }
}

function assertRecordAt(floats: Float32Array, index: number): void {
  const base = index * WORDS_PER_RECORD;
  const minX = floats[base] ?? Number.NaN;
  const minY = floats[base + 1] ?? Number.NaN;
  const maxX = floats[base + 2] ?? Number.NaN;
  const maxY = floats[base + 3] ?? Number.NaN;
  const priority = floats[base + 4] ?? Number.NaN;
  const zIndex = floats[base + 5] ?? Number.NaN;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(priority) ||
    !Number.isFinite(zIndex) ||
    maxX < minX ||
    maxY < minY
  ) {
    throw new TypeError("Label collision records require finite ordered bounds and priorities");
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Label collision ${name} must be a finite non-negative number`);
  }
}

function emptyResult(): Readonly<LabelCollisionSelectionResult> {
  return Object.freeze({
    candidateCount: 0,
    selectedCount: 0,
    collisionCulledCount: 0,
    densityCulledCount: 0,
    selectionHash: 0,
  });
}
