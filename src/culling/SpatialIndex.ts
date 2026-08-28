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
const LINEAR_RESULT_FRACTION = 4;

export class SpatialIndex {
  readonly #maxCapacity: number;
  #capacity: number;
  #highWater = 0;
  #entries = 0;
  #originX: Float32Array;
  #originY: Float32Array;
  #localX: Float32Array;
  #localY: Float32Array;
  #width: Float32Array;
  #height: Float32Array;
  #originsAliased = false;
  #zIndex: Float32Array;
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
    this.#originX = new Float32Array(this.#capacity);
    this.#originY = new Float32Array(this.#capacity);
    this.#localX = new Float32Array(this.#capacity);
    this.#localY = new Float32Array(this.#capacity);
    this.#width = new Float32Array(this.#capacity);
    this.#height = new Float32Array(this.#capacity);
    this.#zIndex = new Float32Array(this.#capacity);
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
    this.#writeWorld(slot, bounds.x, bounds.y, bounds.width, bounds.height);
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
    this.#writeWorld(slot, bounds.x, bounds.y, bounds.width, bounds.height);
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

  /**
   * Place occupied slots at packed origins using one shared local box (zero anchors, unit
   * scale/rotation). Keeps z-index and visibility. @internal
   */
  placeMany(slots: Uint32Array, count: number, xy: Float32Array, local: BoundsData): number {
    this.#assertActive();
    if (count <= 0) return 0;
    if (slots.length < count) {
      throw new TypeError("Spatial placeMany slot list is shorter than count");
    }
    if (xy.length < count * 2) {
      throw new TypeError("Spatial placeMany xy must contain one packed pair per slot");
    }
    assertBounds(local);
    const localX = local.x;
    const localY = local.y;
    const width = local.width;
    const height = local.height;
    let placed = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index];
      if (slot === undefined) {
        throw new Error("Spatial placeMany slot list is incomplete");
      }
      if (slot >= this.#highWater || this.#occupied[slot] !== 1) continue;
      const originX = xy[index * 2] ?? 0;
      const originY = xy[index * 2 + 1] ?? 0;
      if (!this.#originsAliased) {
        this.#originX[slot] = originX;
        this.#originY[slot] = originY;
      }
      this.#localX[slot] = localX;
      this.#localY[slot] = localY;
      this.#width[slot] = width;
      this.#height[slot] = height;
      this.#rehash(slot);
      placed += 1;
    }
    return placed;
  }

  /**
   * Alias label-origin columns. World AABB is then origin + cached local box, so a position storm
   * writes x/y once and only rebuckets. Bind before insert, or only to grown copies of the same
   * values. @internal
   */
  bindOrigins(x: Float32Array, y: Float32Array): void {
    this.#assertActive();
    if (!(x instanceof Float32Array) || !(y instanceof Float32Array)) {
      throw new TypeError("Spatial origin columns must be Float32Array");
    }
    if (x.length !== y.length) {
      throw new TypeError("Spatial origin columns must have the same length");
    }
    if (this.#highWater > x.length) {
      throw new RangeError("Spatial origin columns are shorter than occupied slots");
    }
    this.#originX = x;
    this.#originY = y;
    this.#originsAliased = true;
  }

  /** Rebucket one occupied slot after its aliased origin moved. Size class stays. @internal */
  rehashCurrent(slot: number): boolean {
    this.#assertActive();
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) return false;
    this.#rehashPreservingLevel(slot);
    return true;
  }

  /**
   * Slide occupied AABBs by packed per-slot deltas. Size is unchanged, so the size class stays;
   * only a cell-boundary crossing rebuckets. Aliased origins already moved with the store, so this
   * only rebuckets. Keeps z-index and visibility. @internal
   */
  translateMany(slots: Uint32Array, count: number, deltas: Float32Array): number {
    this.#assertActive();
    if (count <= 0) return 0;
    if (slots.length < count) {
      throw new TypeError("Spatial translateMany slot list is shorter than count");
    }
    if (deltas.length < count * 2) {
      throw new TypeError("Spatial translateMany deltas must contain one packed pair per slot");
    }
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index];
      if (slot === undefined) {
        throw new Error("Spatial translateMany slot list is incomplete");
      }
      const deltaX = deltas[index * 2];
      const deltaY = deltas[index * 2 + 1];
      if (
        deltaX === undefined ||
        deltaY === undefined ||
        !Number.isFinite(deltaX) ||
        !Number.isFinite(deltaY)
      ) {
        throw new TypeError("translation must contain finite deltaX/deltaY values");
      }
    }
    let translated = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      const deltaX = deltas[index * 2] ?? 0;
      const deltaY = deltas[index * 2 + 1] ?? 0;
      if (this.#shift(slot, deltaX, deltaY)) translated += 1;
    }
    return translated;
  }

  translate(slot: number, deltaX: number, deltaY: number): boolean {
    this.#assertActive();
    assertSlot(slot);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      throw new TypeError("translation must contain finite deltaX/deltaY values");
    }
    return this.#shift(slot, deltaX, deltaY);
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
    const minX = (this.#originX[slot] ?? 0) + (this.#localX[slot] ?? 0);
    const minY = (this.#originY[slot] ?? 0) + (this.#localY[slot] ?? 0);
    target.x = minX;
    target.y = minY;
    target.width = this.#width[slot] ?? 0;
    target.height = this.#height[slot] ?? 0;

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
      const minX = (this.#originX[slot] ?? 0) + (this.#localX[slot] ?? 0);
      const minY = (this.#originY[slot] ?? 0) + (this.#localY[slot] ?? 0);
      if (
        point.x < minX ||
        point.x > minX + (this.#width[slot] ?? 0) ||
        point.y < minY ||
        point.y > minY + (this.#height[slot] ?? 0)
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
        (this.#originsAliased ? 0 : this.#originX.byteLength + this.#originY.byteLength) +
        this.#localX.byteLength +
        this.#localY.byteLength +
        this.#width.byteLength +
        this.#height.byteLength +
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
    this.#originX = new Float32Array();
    this.#originY = new Float32Array();
    this.#localX = new Float32Array();
    this.#localY = new Float32Array();
    this.#width = new Float32Array();
    this.#height = new Float32Array();
    this.#originsAliased = false;
    this.#zIndex = new Float32Array();
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
    if (this.#originsAliased) {
      if (required > this.#originX.length) {
        throw new RangeError("Spatial origin columns are shorter than the required slot");
      }
    } else {
      this.#originX = grow(this.#originX, capacity);
      this.#originY = grow(this.#originY, capacity);
    }
    this.#localX = grow(this.#localX, capacity);
    this.#localY = grow(this.#localY, capacity);
    this.#width = grow(this.#width, capacity);
    this.#height = grow(this.#height, capacity);
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
      const minX = (this.#originX[slot] ?? 0) + (this.#localX[slot] ?? 0);
      const minY = (this.#originY[slot] ?? 0) + (this.#localY[slot] ?? 0);
      if (
        minX + (this.#width[slot] ?? 0) < minimumX ||
        minY + (this.#height[slot] ?? 0) < minimumY ||
        minX > maximumX ||
        minY > maximumY
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
    if (cells * LINEAR_CELL_FRACTION > this.#entries) return true;
    // Grid output restores insertion order with an O(K log K) sort, so dense results
    // (mid-zoom viewports) cost more than the ascending dense scan. Sum candidate
    // bucket sizes without visiting entries; the dense case exits after a few buckets.
    const limit = this.#entries / LINEAR_RESULT_FRACTION;
    let candidates = this.#spill.length;
    if (candidates > limit) return true;
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
          candidates += bucket.length;
          if (candidates > limit) return true;
        }
      }
    }
    return false;
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

  #shift(slot: number, deltaX: number, deltaY: number): boolean {
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) {
      return false;
    }
    if (!this.#originsAliased) {
      this.#originX[slot] = (this.#originX[slot] ?? 0) + deltaX;
      this.#originY[slot] = (this.#originY[slot] ?? 0) + deltaY;
    }
    this.#rehashPreservingLevel(slot);
    return true;
  }

  #rehash(slot: number): void {
    const next = this.#cellFor(slot);
    const current = this.#cellKey[slot] ?? 0;
    if (current === next && (this.#cellIndex[slot] ?? -1) >= 0) return;
    this.#unhash(slot);
    this.#insertHash(slot, next);
  }

  /**
   * Translate does not change AABB size, so the size class stays. Spill (oversize or unhashed)
   * still goes through `#cellFor` in case a coord overflow can re-enter a cell.
   */
  #rehashPreservingLevel(slot: number): void {
    const current = this.#cellKey[slot] ?? 0;
    if ((this.#cellIndex[slot] ?? -1) < 0 || current === 0) {
      this.#rehash(slot);
      return;
    }
    const level = Math.floor(current / LEVEL_SHIFT) - 1;
    if (level < 0 || level >= CELL_SIZES.length) {
      this.#rehash(slot);
      return;
    }
    const cell = CELL_SIZES[level] ?? 64;
    const minX = (this.#originX[slot] ?? 0) + (this.#localX[slot] ?? 0);
    const minY = (this.#originY[slot] ?? 0) + (this.#localY[slot] ?? 0);
    const centerX = minX + (this.#width[slot] ?? 0) * 0.5;
    const centerY = minY + (this.#height[slot] ?? 0) * 0.5;
    const next = packCell(level, Math.floor(centerX / cell), Math.floor(centerY / cell)) ?? 0;
    if (next === current) return;
    this.#unhash(slot);
    this.#insertHash(slot, next);
  }

  #insertHash(slot: number, next: number): void {
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
    const size = Math.max(this.#width[slot] ?? 0, this.#height[slot] ?? 0);
    let level = -1;
    for (let index = 0; index < CELL_SIZES.length; index += 1) {
      if (size <= (CELL_SIZES[index] ?? 0)) {
        level = index;
        break;
      }
    }
    if (level < 0) return 0;
    const cell = CELL_SIZES[level] ?? 64;
    const minX = (this.#originX[slot] ?? 0) + (this.#localX[slot] ?? 0);
    const minY = (this.#originY[slot] ?? 0) + (this.#localY[slot] ?? 0);
    const centerX = minX + (this.#width[slot] ?? 0) * 0.5;
    const centerY = minY + (this.#height[slot] ?? 0) * 0.5;
    const cx = Math.floor(centerX / cell);
    const cy = Math.floor(centerY / cell);
    return packCell(level, cx, cy) ?? 0;
  }

  #writeWorld(slot: number, x: number, y: number, width: number, height: number): void {
    if (this.#originsAliased) {
      this.#localX[slot] = x - (this.#originX[slot] ?? 0);
      this.#localY[slot] = y - (this.#originY[slot] ?? 0);
    } else {
      this.#originX[slot] = x;
      this.#originY[slot] = y;
      this.#localX[slot] = 0;
      this.#localY[slot] = 0;
    }
    this.#width[slot] = width;
    this.#height[slot] = height;
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
