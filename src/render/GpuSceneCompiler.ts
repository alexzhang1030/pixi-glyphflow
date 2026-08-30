import type { TextStyleOptions } from "pixi.js";

import { encodeCacheKey } from "../cache/cacheKey";
import type { PositionedRun } from "../layout/types";
import { canonicalFillPaint, type CanonicalFillPaint } from "./TransformPalette";

export const GPU_SCENE_MAX_PROTOTYPES = 64;
export const GPU_SCENE_MAX_PAINTS = 8;

/** @internal One request column presented to the retained GPU-scene compiler. */
export interface GpuSceneCompilerColumn {
  readonly slots: Uint32Array;
  readonly count: number;
  readonly xy: Float32Array;
  readonly orders: Uint32Array;
  readonly run: Readonly<PositionedRun>;
  readonly rasterIdentity: string;
  readonly paint: Readonly<CanonicalFillPaint>;
}

/** @internal One slot-sorted prototype/paint column in a compiled scene revision. */
export interface GpuScenePlanColumn {
  readonly prototypeIndex: number;
  readonly paintIndex: number;
  /** Source compiler column used when this prototype still needs a GPU arena binding. */
  readonly sourceIndex: number;
  readonly slots: Uint32Array;
  readonly count: number;
  readonly xy: Float32Array;
  readonly orders: Uint32Array;
}

/** @internal Bounded typed plan consumed by the coordinator and resident record owner. */
export interface GpuScenePlan {
  readonly status: "ready";
  readonly recordStart: number;
  readonly recordCount: number;
  readonly prototypeCount: number;
  readonly paintCount: number;
  readonly previousPrototypeCount: number;
  readonly previousPaintCount: number;
  readonly newPrototypeIndices: Uint8Array;
  readonly newPrototypeSources: Uint32Array;
  readonly columns: readonly Readonly<GpuScenePlanColumn>[];
}

export interface UnsupportedGpuScenePlan {
  readonly status: "unsupported";
  readonly reason: "unsupported-scene";
}

export type GpuSceneCompileResult = Readonly<GpuScenePlan> | Readonly<UnsupportedGpuScenePlan>;

export interface GpuScenePrototypeBinding {
  readonly prototypeId: number;
  readonly instanceOffset: number;
  readonly instanceCount: number;
  readonly localBounds: Float32Array;
}

export interface GpuSceneCompilerOptions {
  /** @internal Deterministic collision seam for exact-compare tests. */
  readonly prototypeHash?: (run: Readonly<PositionedRun>, rasterIdentity: string) => number;
  /** @internal Compatibility base for coordinator-owned resident lanes sharing lower slots. */
  readonly recordStart?: number;
}

interface PrototypeIdentity {
  readonly hash: number;
  readonly source: PositionedRun["source"];
  readonly fontFamily: string;
  readonly fontFamilies: readonly string[] | undefined;
  readonly fontRevision: number;
  readonly variationKey: string;
  readonly glyphCount: number;
  readonly glyphIds: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly xAdvance: Float32Array;
  readonly yAdvance: Float32Array;
  readonly lineIndices: Uint32Array;
  readonly bounds: readonly [number, number, number, number];
  readonly rasterIdentity: string;
}

const UNSUPPORTED: Readonly<UnsupportedGpuScenePlan> = Object.freeze({
  status: "unsupported",
  reason: "unsupported-scene",
});

/**
 * @internal Retains exact rendered prototype and canonical paint identities across monotonic scene
 * revisions. Compilation performs one dense slot pass and emits at most 64 x 8 typed columns.
 */
export class GpuSceneCompiler {
  readonly #candidatePrototypes = new Map<string, number>();
  readonly #candidatePaints = new Map<string, number>();
  readonly #candidatePairsByStyle = new WeakMap<object, Map<string, number>>();
  readonly #prototypes: PrototypeIdentity[] = [];
  readonly #prototypeBuckets = new Map<number, number[]>();
  readonly #paints: CanonicalFillPaint[] = [];
  readonly #bindings: Array<Readonly<GpuScenePrototypeBinding> | undefined> = [];
  readonly #prototypeHash:
    | ((run: Readonly<PositionedRun>, rasterIdentity: string) => number)
    | undefined;
  #nextSlot = 0;

  constructor(options: Readonly<GpuSceneCompilerOptions> = {}) {
    this.#prototypeHash = options.prototypeHash;
    const recordStart = options.recordStart ?? 0;
    if (!Number.isSafeInteger(recordStart) || recordStart < 0 || recordStart > 0xffff_ffff) {
      throw new TypeError("GPU scene recordStart must fit uint32");
    }
    this.#nextSlot = recordStart;
  }

  get prototypeCount(): number {
    return this.#prototypes.length;
  }

  get paintCount(): number {
    return this.#paints.length;
  }

  /** Pre-layout render-equivalent prototype candidates retained across monotonic appends. */
  get candidatePrototypeCount(): number {
    return this.#candidatePrototypes.size;
  }

  /** Exact packed-palette paints observed by the bounded pre-layout pass. */
  get candidatePaintCount(): number {
    return this.#candidatePaints.size;
  }

  /**
   * Admit one value-semantic text/style candidate before layout and raster work. The returned pair
   * key is bounded to the 64 by 8 candidate matrix; undefined means the scene exceeded it.
   */
  admitCandidate(text: string, style: Readonly<TextStyleOptions>): number | undefined {
    if (typeof text !== "string" || typeof style !== "object" || style === null) return undefined;
    const cached = this.#candidatePairsByStyle.get(style)?.get(text);
    if (cached !== undefined) return cached;

    const prototypeKey = candidatePrototypeKey(text, style);
    if (prototypeKey === undefined) return undefined;
    const paint = canonicalFillPaint(style.fill);
    const paintKey = `${String(paint.colorBits >>> 0)}:${String(paint.alphaBits >>> 0)}`;
    const currentPrototype = this.#candidatePrototypes.get(prototypeKey);
    const currentPaint = this.#candidatePaints.get(paintKey);
    if (
      (currentPrototype === undefined &&
        this.#candidatePrototypes.size >= GPU_SCENE_MAX_PROTOTYPES) ||
      (currentPaint === undefined && this.#candidatePaints.size >= GPU_SCENE_MAX_PAINTS)
    ) {
      return undefined;
    }

    const prototypeIndex = currentPrototype ?? this.#candidatePrototypes.size;
    const paintIndex = currentPaint ?? this.#candidatePaints.size;
    if (currentPrototype === undefined) this.#candidatePrototypes.set(prototypeKey, prototypeIndex);
    if (currentPaint === undefined) this.#candidatePaints.set(paintKey, paintIndex);
    const pair = pairKey(prototypeIndex, paintIndex);
    if (Object.isFrozen(style)) {
      let byText = this.#candidatePairsByStyle.get(style);
      if (byText === undefined) {
        byText = new Map();
        this.#candidatePairsByStyle.set(style, byText);
      }
      byText.set(text, pair);
    }
    return pair;
  }

  paint(index: number): Readonly<CanonicalFillPaint> {
    const paint = this.#paints[index];
    if (paint === undefined) throw new RangeError("GPU scene paint index is unavailable");
    return paint;
  }

  prototypeBinding(index: number): Readonly<GpuScenePrototypeBinding> | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#prototypes.length) {
      throw new RangeError("GPU scene prototype binding index is unavailable");
    }
    return this.#bindings[index];
  }

  bindPrototype(index: number, binding: Readonly<GpuScenePrototypeBinding>): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#prototypes.length) {
      throw new RangeError("GPU scene prototype binding index is unavailable");
    }
    validateBinding(binding);
    const stored = Object.freeze({
      prototypeId: binding.prototypeId >>> 0,
      instanceOffset: binding.instanceOffset >>> 0,
      instanceCount: binding.instanceCount >>> 0,
      localBounds: Float32Array.from(binding.localBounds),
    });
    const current = this.#bindings[index];
    if (current !== undefined && !sameBinding(current, stored)) {
      throw new TypeError("GPU scene prototype binding changed");
    }
    this.#bindings[index] = stored;
  }

  /** Roll back the latest compiled revision after a downstream atlas/arena/palette failure. */
  rollback(plan: Readonly<GpuScenePlan>): boolean {
    if (
      this.#nextSlot !== plan.recordStart + plan.recordCount ||
      this.#prototypes.length !== plan.prototypeCount ||
      this.#paints.length !== plan.paintCount
    ) {
      return false;
    }
    for (
      let index = this.#prototypes.length - 1;
      index >= plan.previousPrototypeCount;
      index -= 1
    ) {
      const identity = this.#prototypes[index];
      if (identity === undefined) continue;
      const bucket = this.#prototypeBuckets.get(identity.hash);
      if (bucket !== undefined) {
        const position = bucket.lastIndexOf(index);
        if (position >= 0) bucket.splice(position, 1);
        if (bucket.length === 0) this.#prototypeBuckets.delete(identity.hash);
      }
    }
    this.#prototypes.length = plan.previousPrototypeCount;
    this.#bindings.length = plan.previousPrototypeCount;
    this.#paints.length = plan.previousPaintCount;
    this.#nextSlot = plan.recordStart;
    return true;
  }

  compile(columns: readonly Readonly<GpuSceneCompilerColumn>[]): GpuSceneCompileResult {
    let recordCount = 0;
    for (const column of columns) {
      recordCount += column.count;
      if (
        !Number.isSafeInteger(recordCount) ||
        recordCount > 0xffff_ffff ||
        this.#nextSlot + recordCount > 0xffff_ffff
      ) {
        return UNSUPPORTED;
      }
    }
    if (recordCount === 0) {
      return Object.freeze({
        status: "ready",
        recordStart: this.#nextSlot,
        recordCount: 0,
        prototypeCount: this.#prototypes.length,
        paintCount: this.#paints.length,
        previousPrototypeCount: this.#prototypes.length,
        previousPaintCount: this.#paints.length,
        newPrototypeIndices: new Uint8Array(0),
        newPrototypeSources: new Uint32Array(0),
        columns: Object.freeze([]),
      });
    }

    const slotColumns = new Uint32Array(recordCount);
    const slotOffsets = new Uint32Array(recordCount);
    const slotOrders = new Uint32Array(recordCount);
    const occupied = new Uint8Array(recordCount);
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex];
      if (column === undefined) return UNSUPPORTED;
      for (let index = 0; index < column.count; index += 1) {
        const slot: number | undefined = column.slots[index];
        const order: number | undefined = column.orders[index];
        if (slot === undefined || order === undefined) return UNSUPPORTED;
        const relative = slot - this.#nextSlot;
        if (relative < 0 || relative >= recordCount || occupied[relative] === 1) {
          return UNSUPPORTED;
        }
        occupied[relative] = 1;
        slotColumns[relative] = columnIndex;
        slotOffsets[relative] = index;
        slotOrders[relative] = order;
      }
    }
    let previousOrder = -1;
    for (let relative = 0; relative < recordCount; relative += 1) {
      if (occupied[relative] !== 1) return UNSUPPORTED;
      const order = slotOrders[relative] ?? 0;
      if (order <= previousOrder) return UNSUPPORTED;
      previousOrder = order;
    }

    const candidatePrototype = new Uint8Array(columns.length);
    const candidatePaint = new Uint8Array(columns.length);
    const pendingPrototypes: PrototypeIdentity[] = [];
    const pendingPrototypeSources: number[] = [];
    const pendingPaints: CanonicalFillPaint[] = [];
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      if (column === undefined) return UNSUPPORTED;
      const identity = prototypeIdentity(column.run, column.rasterIdentity, this.#prototypeHash);
      const prototypeIndex = this.#findPrototype(identity, pendingPrototypes);
      if (prototypeIndex === undefined) {
        if (this.#prototypes.length + pendingPrototypes.length >= GPU_SCENE_MAX_PROTOTYPES) {
          return UNSUPPORTED;
        }
        candidatePrototype[index] = this.#prototypes.length + pendingPrototypes.length;
        pendingPrototypes.push(identity);
        pendingPrototypeSources.push(index);
      } else {
        candidatePrototype[index] = prototypeIndex;
      }

      const paintIndex = this.#findPaint(column.paint, pendingPaints);
      if (paintIndex === undefined) {
        if (this.#paints.length + pendingPaints.length >= GPU_SCENE_MAX_PAINTS) {
          return UNSUPPORTED;
        }
        candidatePaint[index] = this.#paints.length + pendingPaints.length;
        pendingPaints.push({
          colorBits: column.paint.colorBits >>> 0,
          alphaBits: column.paint.alphaBits >>> 0,
        });
      } else {
        candidatePaint[index] = paintIndex;
      }
    }

    const pairCapacity = GPU_SCENE_MAX_PROTOTYPES * GPU_SCENE_MAX_PAINTS;
    const pairCounts = new Uint32Array(pairCapacity);
    const pairSeen = new Uint8Array(pairCapacity);
    const pairOrder = new Uint16Array(pairCapacity);
    const pairSources = new Uint32Array(pairCapacity);
    let pairCount = 0;
    for (let relative = 0; relative < recordCount; relative += 1) {
      const candidate = slotColumns[relative] ?? 0;
      const key = pairKey(candidatePrototype[candidate] ?? 0, candidatePaint[candidate] ?? 0);
      pairCounts[key] = (pairCounts[key] ?? 0) + 1;
      if (pairSeen[key] === 1) continue;
      pairSeen[key] = 1;
      pairOrder[pairCount] = key;
      pairSources[key] = candidate;
      pairCount += 1;
    }
    const compiled: GpuScenePlanColumn[] = [];
    const pairWrites = new Uint32Array(pairCapacity);
    const pairColumns = new Int16Array(pairCapacity).fill(-1);
    for (let index = 0; index < pairCount; index += 1) {
      const key = pairOrder[index] ?? 0;
      const count = pairCounts[key] ?? 0;
      pairColumns[key] = compiled.length;
      compiled.push({
        prototypeIndex: Math.floor(key / GPU_SCENE_MAX_PAINTS),
        paintIndex: key % GPU_SCENE_MAX_PAINTS,
        sourceIndex: pairSources[key] ?? 0,
        slots: new Uint32Array(count),
        count,
        xy: new Float32Array(count * 2),
        orders: new Uint32Array(count),
      });
    }
    for (let relative = 0; relative < recordCount; relative += 1) {
      const candidateIndex = slotColumns[relative] ?? 0;
      const candidate = columns[candidateIndex];
      if (candidate === undefined) return UNSUPPORTED;
      const sourceOffset = slotOffsets[relative] ?? 0;
      const key = pairKey(
        candidatePrototype[candidateIndex] ?? 0,
        candidatePaint[candidateIndex] ?? 0,
      );
      const compiledIndex = pairColumns[key] ?? -1;
      const target = compiledIndex >= 0 ? compiled[compiledIndex] : undefined;
      if (target === undefined) return UNSUPPORTED;
      const write = pairWrites[key] ?? 0;
      target.slots[write] = this.#nextSlot + relative;
      target.xy[write * 2] = candidate.xy[sourceOffset * 2] ?? 0;
      target.xy[write * 2 + 1] = candidate.xy[sourceOffset * 2 + 1] ?? 0;
      target.orders[write] = candidate.orders[sourceOffset] ?? 0;
      pairWrites[key] = write + 1;
    }

    const prototypeBase = this.#prototypes.length;
    const paintBase = this.#paints.length;
    for (let index = 0; index < pendingPrototypes.length; index += 1) {
      const identity = pendingPrototypes[index];
      if (identity === undefined) return UNSUPPORTED;
      const prototypeIndex = this.#prototypes.length;
      this.#prototypes.push(identity);
      let bucket = this.#prototypeBuckets.get(identity.hash);
      if (bucket === undefined) {
        bucket = [];
        this.#prototypeBuckets.set(identity.hash, bucket);
      }
      bucket.push(prototypeIndex);
    }
    this.#paints.push(...pendingPaints);
    const recordStart = this.#nextSlot;
    this.#nextSlot += recordCount;
    const newPrototypeIndices = new Uint8Array(pendingPrototypes.length);
    for (let index = 0; index < newPrototypeIndices.length; index += 1) {
      newPrototypeIndices[index] = prototypeBase + index;
    }

    return Object.freeze({
      status: "ready",
      recordStart,
      recordCount,
      prototypeCount: this.#prototypes.length,
      paintCount: this.#paints.length,
      previousPrototypeCount: prototypeBase,
      previousPaintCount: paintBase,
      newPrototypeIndices,
      newPrototypeSources: Uint32Array.from(pendingPrototypeSources),
      columns: Object.freeze(compiled),
    });
  }

  #findPrototype(
    identity: Readonly<PrototypeIdentity>,
    pending: readonly Readonly<PrototypeIdentity>[],
  ): number | undefined {
    const bucket = this.#prototypeBuckets.get(identity.hash);
    if (bucket !== undefined) {
      for (const index of bucket) {
        const current = this.#prototypes[index];
        if (current !== undefined && samePrototype(current, identity)) return index;
      }
    }
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index];
      if (
        current !== undefined &&
        current.hash === identity.hash &&
        samePrototype(current, identity)
      ) {
        return this.#prototypes.length + index;
      }
    }
    return undefined;
  }

  #findPaint(
    paint: Readonly<CanonicalFillPaint>,
    pending: readonly Readonly<CanonicalFillPaint>[],
  ): number | undefined {
    for (let index = 0; index < this.#paints.length; index += 1) {
      const current = this.#paints[index];
      if (current !== undefined && samePaint(current, paint)) return index;
    }
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index];
      if (current !== undefined && samePaint(current, paint)) return this.#paints.length + index;
    }
    return undefined;
  }
}

function prototypeIdentity(
  run: Readonly<PositionedRun>,
  rasterIdentity: string,
  hashOverride?: (run: Readonly<PositionedRun>, rasterIdentity: string) => number,
): PrototypeIdentity {
  const identity: PrototypeIdentity = {
    hash: 0,
    source: run.source,
    fontFamily: run.fontFamily,
    fontFamilies: run.fontFamilies === undefined ? undefined : Object.freeze([...run.fontFamilies]),
    fontRevision: run.fontRevision,
    variationKey: run.variationKey ?? "",
    glyphCount: run.glyphCount,
    glyphIds: Uint32Array.from(run.glyphIds),
    x: Float32Array.from(run.x),
    y: Float32Array.from(run.y),
    xAdvance: Float32Array.from(run.xAdvance),
    yAdvance: Float32Array.from(run.yAdvance),
    lineIndices: Uint32Array.from(run.lineIndices),
    bounds: Object.freeze([run.bounds.x, run.bounds.y, run.bounds.width, run.bounds.height]),
    rasterIdentity,
  };
  const hash = hashOverride?.(run, rasterIdentity) ?? hashPrototype(identity);
  if (!Number.isSafeInteger(hash)) {
    throw new TypeError("GPU scene prototype hash must be a safe integer");
  }
  return { ...identity, hash: hash >>> 0 };
}

function validateBinding(binding: Readonly<GpuScenePrototypeBinding>): void {
  if (
    !Number.isSafeInteger(binding.prototypeId) ||
    binding.prototypeId < 0 ||
    binding.prototypeId > 0xffff_ffff ||
    !Number.isSafeInteger(binding.instanceOffset) ||
    binding.instanceOffset < 0 ||
    binding.instanceOffset > 0xffff_ffff ||
    !Number.isSafeInteger(binding.instanceCount) ||
    binding.instanceCount < 0 ||
    binding.instanceCount > 0xffff_ffff ||
    !(binding.localBounds instanceof Float32Array) ||
    binding.localBounds.length !== 4
  ) {
    throw new TypeError("GPU scene prototype binding is invalid");
  }
  for (const value of binding.localBounds) {
    if (!Number.isFinite(value)) throw new TypeError("GPU scene prototype binding is invalid");
  }
}

function sameBinding(
  left: Readonly<GpuScenePrototypeBinding>,
  right: Readonly<GpuScenePrototypeBinding>,
): boolean {
  return (
    left.prototypeId === right.prototypeId &&
    left.instanceOffset === right.instanceOffset &&
    left.instanceCount === right.instanceCount &&
    sameTypedBytes(left.localBounds, right.localBounds)
  );
}

function samePrototype(
  left: Readonly<PrototypeIdentity>,
  right: Readonly<PrototypeIdentity>,
): boolean {
  return (
    left.source === right.source &&
    left.fontFamily === right.fontFamily &&
    sameStrings(left.fontFamilies, right.fontFamilies) &&
    left.fontRevision === right.fontRevision &&
    left.variationKey === right.variationKey &&
    left.glyphCount === right.glyphCount &&
    left.rasterIdentity === right.rasterIdentity &&
    sameNumbers(left.bounds, right.bounds) &&
    sameTypedBytes(left.glyphIds, right.glyphIds) &&
    sameTypedBytes(left.x, right.x) &&
    sameTypedBytes(left.y, right.y) &&
    sameTypedBytes(left.xAdvance, right.xAdvance) &&
    sameTypedBytes(left.yAdvance, right.yAdvance) &&
    sameTypedBytes(left.lineIndices, right.lineIndices)
  );
}

function samePaint(
  left: Readonly<CanonicalFillPaint>,
  right: Readonly<CanonicalFillPaint>,
): boolean {
  return left.colorBits === right.colorBits >>> 0 && left.alphaBits === right.alphaBits >>> 0;
}

function pairKey(prototypeIndex: number, paintIndex: number): number {
  return prototypeIndex * GPU_SCENE_MAX_PAINTS + paintIndex;
}

function candidatePrototypeKey(
  text: string,
  style: Readonly<TextStyleOptions>,
): string | undefined {
  try {
    const entries: string[] = [];
    const visiting = new Set<object>();
    for (const key of Object.keys(style).sort()) {
      if (key === "fill") continue;
      const value = (style as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const valueKey = candidateStyleValueKey(value, visiting);
      if (valueKey === undefined) return undefined;
      entries.push(encodeCacheKey([key, valueKey]));
    }
    return encodeCacheKey([text, entries.join("")]);
  } catch {
    return undefined;
  }
}

function candidateStyleValueKey(value: unknown, visiting: Set<object>): string | undefined {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return encodeCacheKey(["string", value]);
  if (typeof value === "boolean") return value ? "boolean:1" : "boolean:0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value !== "object" || visiting.has(value)) return undefined;
  if (
    Object.getOwnPropertySymbols(value).some((key) =>
      Object.prototype.propertyIsEnumerable.call(value, key),
    )
  ) {
    return undefined;
  }

  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length) return undefined;
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (keys[index] !== String(index)) return undefined;
        const entry = candidateStyleValueKey(value[index], visiting);
        if (entry === undefined) return undefined;
        entries.push(entry);
      }
      return encodeCacheKey(["array", ...entries]);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const nestedValue = (value as Record<string, unknown>)[key];
      if (nestedValue === undefined) continue;
      const entry = candidateStyleValueKey(nestedValue, visiting);
      if (entry === undefined) return undefined;
      entries.push(encodeCacheKey([key, entry]));
    }
    return encodeCacheKey(["object", ...entries]);
  } finally {
    visiting.delete(value);
  }
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function sameTypedBytes(
  left: Uint32Array | Float32Array,
  right: Uint32Array | Float32Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function hashPrototype(identity: Readonly<Omit<PrototypeIdentity, "hash">>): number {
  let hash = 0x811c9dc5;
  const addByte = (value: number): void => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const addString = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      addByte(code);
      addByte(code >>> 8);
    }
    addByte(0xff);
  };
  const addBytes = (value: Uint32Array | Float32Array): void => {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (const byte of bytes) addByte(byte);
  };
  addString(identity.source);
  addString(identity.fontFamily);
  for (const family of identity.fontFamilies ?? []) addString(family);
  addString(String(identity.fontRevision));
  addString(identity.variationKey);
  addString(String(identity.glyphCount));
  addString(identity.rasterIdentity);
  addBytes(identity.glyphIds);
  addBytes(identity.x);
  addBytes(identity.y);
  addBytes(identity.xAdvance);
  addBytes(identity.yAdvance);
  addBytes(identity.lineIndices);
  for (const value of identity.bounds) addString(Object.is(value, -0) ? "-0" : String(value));
  return hash >>> 0;
}
