import type {
  BoundsData,
  MutableBoundsData,
  PointLike,
  SpatialIndexOptions,
  SpatialIndexStats,
} from "./types";

const DEFAULT_CAPACITY = 16;
const DEFAULT_MAX_CAPACITY = 0x100_0000;
const CELL_SIZES = Object.freeze([64, 256, 1024, 4096]);
const LEVEL_SHIFT = 2 ** 50;
const X_SHIFT = 2 ** 25;
const COORD_BIAS = 2 ** 24;
const COORD_MIN = -COORD_BIAS;
const COORD_MAX = COORD_BIAS - 1;
const LINEAR_CELL_FRACTION = 8;

export class SpatialIndex {
  readonly #maxCapacity: number;
  #capacity: number;
  #highWater = 0;
  #entries = 0;
  #minimumX: Float32Array;
  #minimumY: Float32Array;
  #maximumX: Float32Array;
  #maximumY: Float32Array;
  #zIndex: Float64Array;
  #order: Uint32Array;
  #occupied: Uint8Array;
  #visible: Uint8Array;
  #cellKey: Float64Array;
  #cellIndex: Int32Array;
  readonly #cells = new Map<number, number[]>();
  readonly #spill: number[] = [];
  #clock = 0;
  #queries = 0;
  #testedEntries = 0;
  #returnedEntries = 0;
  #hits = 0;
  #destroyed = false;

  constructor(options: SpatialIndexOptions = {}) {
    const initialCapacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    this.#maxCapacity = options.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    assertCapacity("initialCapacity", initialCapacity);
    assertCapacity("maxCapacity", this.#maxCapacity);
    if (initialCapacity > this.#maxCapacity) {
      throw new RangeError("initialCapacity exceeds maxCapacity");
    }
    this.#capacity = nextPowerOfTwo(initialCapacity);
    this.#minimumX = new Float32Array(this.#capacity);
    this.#minimumY = new Float32Array(this.#capacity);
    this.#maximumX = new Float32Array(this.#capacity);
    this.#maximumY = new Float32Array(this.#capacity);
    this.#zIndex = new Float64Array(this.#capacity);
    this.#order = new Uint32Array(this.#capacity);
    this.#occupied = new Uint8Array(this.#capacity);
    this.#visible = new Uint8Array(this.#capacity);
    this.#cellKey = new Float64Array(this.#capacity);
    this.#cellIndex = new Int32Array(this.#capacity).fill(-1);
  }

  get capacity(): number {
    return this.#capacity;
  }

  reserve(requiredCapacity: number): void {
    this.#assertActive();
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity < 0) {
      throw new TypeError("requiredCapacity must be a non-negative safe integer");
    }
    this.#ensureCapacity(requiredCapacity);
  }

  set(slot: number, bounds: BoundsData, zIndex = 0, visible = true): void {
    this.#assertActive();
    assertSlot(slot);
    assertBounds(bounds);
    if (!Number.isFinite(zIndex)) {
      throw new TypeError("zIndex must be finite");
    }
    if (typeof visible !== "boolean") {
      throw new TypeError("visible must be a boolean");
    }
    this.#ensureCapacity(slot + 1);
    const wasOccupied = this.#occupied[slot] === 1;
    this.#minimumX[slot] = bounds.x;
    this.#minimumY[slot] = bounds.y;
    this.#maximumX[slot] = bounds.x + bounds.width;
    this.#maximumY[slot] = bounds.y + bounds.height;
    this.#zIndex[slot] = zIndex;
    this.#visible[slot] = Number(visible);
    if (!wasOccupied) {
      this.#occupied[slot] = 1;
      this.#entries += 1;
      this.#clock += 1;
      this.#order[slot] = this.#clock;
      this.#highWater = Math.max(this.#highWater, slot + 1);
    }
    this.#rehash(slot);
  }

  /** Replace a validated, occupied entry without repeating public-boundary checks. @internal */
  updateCurrent(slot: number, bounds: BoundsData, zIndex: number, visible: boolean): void {
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) {
      throw new RangeError("Spatial update requires a current occupied slot");
    }
    this.#minimumX[slot] = bounds.x;
    this.#minimumY[slot] = bounds.y;
    this.#maximumX[slot] = bounds.x + bounds.width;
    this.#maximumY[slot] = bounds.y + bounds.height;
    this.#zIndex[slot] = zIndex;
    this.#visible[slot] = Number(visible);
    this.#rehash(slot);
  }

  setVisible(slot: number, visible: boolean): boolean {
    this.#assertActive();
    assertSlot(slot);
    if (typeof visible !== "boolean") {
      throw new TypeError("visible must be a boolean");
    }
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) {
      return false;
    }
    const value = Number(visible);
    if (this.#visible[slot] === value) return false;
    this.#visible[slot] = value;

    return true;
  }

  /** Set visibility for every occupied entry through one dense pass. @internal */
  setAllVisible(visible: boolean): number {
    this.#assertActive();
    if (typeof visible !== "boolean") {
      throw new TypeError("visible must be a boolean");
    }
    const value = Number(visible);
    let changed = 0;
    for (let slot = 0; slot < this.#highWater; slot += 1) {
      if (this.#occupied[slot] !== 1 || this.#visible[slot] === value) continue;
      this.#visible[slot] = value;
      changed += 1;
    }

    return changed;
  }

  translate(slot: number, deltaX: number, deltaY: number): boolean {
    this.#assertActive();
    assertSlot(slot);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      throw new TypeError("translation must contain finite deltaX/deltaY values");
    }
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) {
      return false;
    }
    this.#minimumX[slot] = (this.#minimumX[slot] ?? 0) + deltaX;
    this.#minimumY[slot] = (this.#minimumY[slot] ?? 0) + deltaY;
    this.#maximumX[slot] = (this.#maximumX[slot] ?? 0) + deltaX;
    this.#maximumY[slot] = (this.#maximumY[slot] ?? 0) + deltaY;
    this.#rehash(slot);

    return true;
  }

  remove(slot: number): boolean {
    this.#assertActive();
    assertSlot(slot);
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) return false;
    this.#unhash(slot);
    this.#occupied[slot] = 0;
    this.#visible[slot] = 0;
    this.#entries -= 1;

    return true;
  }

  get(slot: number, output?: MutableBoundsData): Readonly<BoundsData> | undefined {
    this.#assertActive();
    assertSlot(slot);
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) return undefined;
    const target = output ?? { x: 0, y: 0, width: 0, height: 0 };
    target.x = this.#minimumX[slot] ?? 0;
    target.y = this.#minimumY[slot] ?? 0;
    target.width = (this.#maximumX[slot] ?? 0) - target.x;
    target.height = (this.#maximumY[slot] ?? 0) - target.y;

    return target;
  }

  /** Return the stable insertion order used for z-index ties. @internal */
  orderOf(slot: number): number | undefined {
    this.#assertActive();
    assertSlot(slot);
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) return undefined;
    return this.#order[slot];
  }

  query(bounds: BoundsData, output: Uint32Array, padding = 0): number {
    this.#assertActive();
    assertBounds(bounds);
    if (!(output instanceof Uint32Array)) {
      throw new TypeError("Spatial query output must be a Uint32Array");
    }
    if (!Number.isFinite(padding) || padding < 0) {
      throw new TypeError("Spatial query padding must be a finite non-negative number");
    }
    const minimumX = bounds.x - padding;
    const minimumY = bounds.y - padding;
    const maximumX = bounds.x + bounds.width + padding;
    const maximumY = bounds.y + bounds.height + padding;
    const count = this.#queryBounds(minimumX, minimumY, maximumX, maximumY, output);
    this.#queries += 1;
    this.#returnedEntries += count;

    return count;
  }

  queryAll(output: Uint32Array): number {
    this.#assertActive();
    if (!(output instanceof Uint32Array)) {
      throw new TypeError("Spatial query output must be a Uint32Array");
    }
    let count = 0;
    for (let slot = 0; slot < this.#highWater; slot += 1) {
      if (this.#occupied[slot] !== 1 || this.#visible[slot] !== 1) continue;
      if (count >= output.length) {
        throw new RangeError("Spatial query output capacity is smaller than the result set");
      }
      output[count] = slot;
      count += 1;
    }
    this.#queries += 1;
    this.#testedEntries += this.#entries;
    this.#returnedEntries += count;

    return count;
  }

  hitTest(point: PointLike): number | undefined {
    this.#assertActive();
    assertPoint(point);
    let hit: number | undefined;
    let topZ = Number.NEGATIVE_INFINITY;
    let topOrder = 0;
    const visit = (slot: number): void => {
      if (this.#occupied[slot] !== 1 || this.#visible[slot] !== 1) return;
      if (
        point.x < (this.#minimumX[slot] ?? 0) ||
        point.x > (this.#maximumX[slot] ?? 0) ||
        point.y < (this.#minimumY[slot] ?? 0) ||
        point.y > (this.#maximumY[slot] ?? 0)
      ) {
        return;
      }
      const zIndex = this.#zIndex[slot] ?? 0;
      const order = this.#order[slot] ?? 0;
      if (zIndex > topZ || (zIndex === topZ && order > topOrder)) {
        hit = slot;
        topZ = zIndex;
        topOrder = order;
      }
    };
    if (this.#shouldScanLinear(point.x, point.y, point.x, point.y)) {
      for (let slot = 0; slot < this.#highWater; slot += 1) visit(slot);
    } else {
      this.#visitOverlapping(point.x, point.y, point.x, point.y, visit);
    }
    this.#hits += Number(hit !== undefined);

    return hit;
  }

  clear(): void {
    this.#assertActive();
    this.#occupied.fill(0, 0, this.#highWater);
    this.#visible.fill(0, 0, this.#highWater);
    this.#cellKey.fill(0, 0, this.#highWater);
    this.#cellIndex.fill(-1, 0, this.#highWater);
    this.#cells.clear();
    this.#spill.length = 0;
    this.#entries = 0;
    this.#highWater = 0;
  }

  get stats(): Readonly<SpatialIndexStats> {
    return Object.freeze({
      entries: this.#entries,
      capacity: this.#capacity,
      allocatedBytes:
        this.#minimumX.byteLength +
        this.#minimumY.byteLength +
        this.#maximumX.byteLength +
        this.#maximumY.byteLength +
        this.#zIndex.byteLength +
        this.#order.byteLength +
        this.#occupied.byteLength +
        this.#visible.byteLength +
        this.#cellKey.byteLength +
        this.#cellIndex.byteLength,
      queries: this.#queries,
      testedEntries: this.#testedEntries,
      returnedEntries: this.#returnedEntries,
      hits: this.#hits,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#minimumX = new Float32Array();
    this.#minimumY = new Float32Array();
    this.#maximumX = new Float32Array();
    this.#maximumY = new Float32Array();
    this.#zIndex = new Float64Array();
    this.#order = new Uint32Array();
    this.#occupied = new Uint8Array();
    this.#visible = new Uint8Array();
    this.#cellKey = new Float64Array();
    this.#cellIndex = new Int32Array();
    this.#cells.clear();
    this.#spill.length = 0;
    this.#capacity = 0;
    this.#entries = 0;
    this.#highWater = 0;
    this.#destroyed = true;
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;
    if (required > this.#maxCapacity) {
      throw new RangeError(`Spatial index capacity exceeds ${String(this.#maxCapacity)}`);
    }
    let capacity = this.#capacity;
    while (capacity < required) capacity *= 2;
    capacity = Math.min(capacity, this.#maxCapacity);
    this.#minimumX = grow(this.#minimumX, capacity);
    this.#minimumY = grow(this.#minimumY, capacity);
    this.#maximumX = grow(this.#maximumX, capacity);
    this.#maximumY = grow(this.#maximumY, capacity);
    this.#zIndex = grow(this.#zIndex, capacity);
    this.#order = grow(this.#order, capacity);
    this.#occupied = grow(this.#occupied, capacity);
    this.#visible = grow(this.#visible, capacity);
    this.#cellKey = grow(this.#cellKey, capacity);
    this.#cellIndex = grow(this.#cellIndex, capacity);
    this.#capacity = capacity;
  }

  #queryBounds(
    minimumX: number,
    minimumY: number,
    maximumX: number,
    maximumY: number,
    output: Uint32Array,
  ): number {
    let count = 0;
    let tested = 0;
    const visit = (slot: number): void => {
      if (this.#occupied[slot] !== 1 || this.#visible[slot] !== 1) return;
      tested += 1;
      if (
        (this.#maximumX[slot] ?? 0) < minimumX ||
        (this.#maximumY[slot] ?? 0) < minimumY ||
        (this.#minimumX[slot] ?? 0) > maximumX ||
        (this.#minimumY[slot] ?? 0) > maximumY
      ) {
        return;
      }
      if (count >= output.length) {
        throw new RangeError("Spatial query output capacity is smaller than the result set");
      }
      output[count] = slot;
      count += 1;
    };
    if (this.#shouldScanLinear(minimumX, minimumY, maximumX, maximumY)) {
      for (let slot = 0; slot < this.#highWater; slot += 1) visit(slot);
    } else {
      this.#visitOverlapping(minimumX, minimumY, maximumX, maximumY, visit);
      if (count > 1) {
        output.subarray(0, count).sort();
      }
    }
    this.#testedEntries += tested;
    return count;
  }

  #shouldScanLinear(
    minimumX: number,
    minimumY: number,
    maximumX: number,
    maximumY: number,
  ): boolean {
    if (this.#entries <= 64) return true;
    let cells = this.#spill.length > 0 ? 1 : 0;
    for (let level = 0; level < CELL_SIZES.length; level += 1) {
      const size = CELL_SIZES[level] ?? 64;
      const expand = size * 0.5;
      const minCX = Math.floor((minimumX - expand) / size);
      const maxCX = Math.floor((maximumX + expand) / size);
      const minCY = Math.floor((minimumY - expand) / size);
      const maxCY = Math.floor((maximumY + expand) / size);
      cells += (maxCX - minCX + 1) * (maxCY - minCY + 1);
    }
    return cells * LINEAR_CELL_FRACTION > this.#entries;
  }

  #visitOverlapping(
    minimumX: number,
    minimumY: number,
    maximumX: number,
    maximumY: number,
    visit: (slot: number) => void,
  ): void {
    for (let level = 0; level < CELL_SIZES.length; level += 1) {
      const size = CELL_SIZES[level] ?? 64;
      const expand = size * 0.5;
      const minCX = Math.floor((minimumX - expand) / size);
      const maxCX = Math.floor((maximumX + expand) / size);
      const minCY = Math.floor((minimumY - expand) / size);
      const maxCY = Math.floor((maximumY + expand) / size);
      for (let cy = minCY; cy <= maxCY; cy += 1) {
        for (let cx = minCX; cx <= maxCX; cx += 1) {
          const packed = packCell(level, cx, cy);
          if (packed === undefined) continue;
          const bucket = this.#cells.get(packed);
          if (bucket === undefined) continue;
          for (const slot of bucket) visit(slot);
        }
      }
    }
    for (const slot of this.#spill) visit(slot);
  }

  #rehash(slot: number): void {
    const next = this.#cellFor(slot);
    const current = this.#cellKey[slot] ?? 0;
    if (current === next && (this.#cellIndex[slot] ?? -1) >= 0) return;
    this.#unhash(slot);
    if (next === 0) {
      this.#cellIndex[slot] = this.#spill.length;
      this.#spill.push(slot);
      this.#cellKey[slot] = 0;
      return;
    }
    let bucket = this.#cells.get(next);
    if (bucket === undefined) {
      bucket = [];
      this.#cells.set(next, bucket);
    }
    this.#cellIndex[slot] = bucket.length;
    bucket.push(slot);
    this.#cellKey[slot] = next;
  }

  #unhash(slot: number): void {
    const index = this.#cellIndex[slot] ?? -1;
    if (index < 0) return;
    const key = this.#cellKey[slot] ?? 0;
    this.#cellIndex[slot] = -1;
    if (key === 0) {
      const last = this.#spill.pop();
      if (last === undefined) return;
      if (last !== slot) {
        this.#spill[index] = last;
        this.#cellIndex[last] = index;
      }
      return;
    }
    const bucket = this.#cells.get(key);
    if (bucket === undefined) return;
    const last = bucket.pop();
    if (last === undefined) return;
    if (last !== slot) {
      bucket[index] = last;
      this.#cellIndex[last] = index;
    }
    if (bucket.length === 0) this.#cells.delete(key);
    this.#cellKey[slot] = 0;
  }

  #cellFor(slot: number): number {
    const width = (this.#maximumX[slot] ?? 0) - (this.#minimumX[slot] ?? 0);
    const height = (this.#maximumY[slot] ?? 0) - (this.#minimumY[slot] ?? 0);
    const size = Math.max(width, height);
    let level = -1;
    for (let index = 0; index < CELL_SIZES.length; index += 1) {
      if (size <= (CELL_SIZES[index] ?? 0)) {
        level = index;
        break;
      }
    }
    if (level < 0) return 0;
    const cell = CELL_SIZES[level] ?? 64;
    const centerX = ((this.#minimumX[slot] ?? 0) + (this.#maximumX[slot] ?? 0)) * 0.5;
    const centerY = ((this.#minimumY[slot] ?? 0) + (this.#maximumY[slot] ?? 0)) * 0.5;
    const cx = Math.floor(centerX / cell);
    const cy = Math.floor(centerY / cell);
    return packCell(level, cx, cy) ?? 0;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("SpatialIndex has been destroyed");
    }
  }
}

function grow<T extends Float32Array | Float64Array | Uint32Array | Int32Array | Uint8Array>(
  source: T,
  capacity: number,
): T {
  const target = (
    source instanceof Float32Array
      ? new Float32Array(capacity)
      : source instanceof Float64Array
        ? new Float64Array(capacity)
        : source instanceof Uint32Array
          ? new Uint32Array(capacity)
          : source instanceof Int32Array
            ? new Int32Array(capacity).fill(-1)
            : new Uint8Array(capacity)
  ) as T;
  target.set(source);

  return target;
}

function assertBounds(bounds: BoundsData): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    throw new TypeError("Bounds must contain finite x/y and non-negative width/height values");
  }
}

function assertPoint(point: PointLike): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError("Point must contain finite x/y values");
  }
}

function assertSlot(slot: number): void {
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new TypeError("Spatial index slot must be a non-negative safe integer");
  }
}

function assertCapacity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAX_CAPACITY) {
    throw new TypeError(`${name} must be an integer from 1 to ${String(DEFAULT_MAX_CAPACITY)}`);
  }
}

function packCell(level: number, cx: number, cy: number): number | undefined {
  if (cx < COORD_MIN || cx > COORD_MAX || cy < COORD_MIN || cy > COORD_MAX) {
    return undefined;
  }
  return (level + 1) * LEVEL_SHIFT + (cx + COORD_BIAS) * X_SHIFT + (cy + COORD_BIAS);
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
