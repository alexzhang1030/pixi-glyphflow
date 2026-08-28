import { Color } from "pixi.js";

import {
  DIRTY_ACCEPTED_GAP,
  DIRTY_MAX_RANGES,
  DIRTY_WHOLE_BUFFER_BPS,
  DirtyRanges,
} from "./DirtyRanges";
import { packHalf2x16 } from "./pack";
import type {
  DirtyByteRange,
  TransformPaletteInput,
  TransformPaletteOptions,
  TransformPaletteStats,
  TransformRunBounds,
} from "./types";

/** Fill-only GPU record: two rgba32float texels. See `.agents/docs/performance-plan.md`. */
export const TRANSFORM_PALETTE_STRIDE = 32;
/** Stroke/shadow texel stored after the core region when any label uses effects. */
export const TRANSFORM_EFFECT_STRIDE = 16;
const FLOATS_PER_LABEL = TRANSFORM_PALETTE_STRIDE / Float32Array.BYTES_PER_ELEMENT;
const FLOATS_PER_EFFECT = TRANSFORM_EFFECT_STRIDE / Float32Array.BYTES_PER_ELEMENT;
const CORE_TEXELS_PER_LABEL = 2;
const EFFECT_FLAG = 65_536;
const DEFAULT_CAPACITY = 1_024;
const DEFAULT_TEXTURE_WIDTH = 1_024;
const DEFAULT_MAX_CAPACITY = 0x100_0000;

export class TransformPalette {
  readonly #textureWidth: number;
  readonly #maxCapacity: number;
  readonly #dirty = new DirtyRanges();
  readonly #scratch = new Float32Array(FLOATS_PER_LABEL);
  readonly #scratchBits = new Uint32Array(this.#scratch.buffer);
  #capacity: number;
  #data: Float32Array;
  #occupied: Uint8Array;
  #effectsEnabled = false;
  #activeLabels = 0;
  #destroyed = false;

  constructor(options: TransformPaletteOptions = {}) {
    const initialCapacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    this.#textureWidth = options.textureWidth ?? DEFAULT_TEXTURE_WIDTH;
    this.#maxCapacity = options.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    assertPositiveInteger("initialCapacity", initialCapacity);
    assertPositiveInteger("textureWidth", this.#textureWidth);
    assertPositiveInteger("maxCapacity", this.#maxCapacity);
    if (initialCapacity > this.#maxCapacity) {
      throw new RangeError("initialCapacity exceeds maxCapacity");
    }
    this.#capacity = nextPowerOfTwo(initialCapacity);
    this.#data = this.#allocateData(this.#capacity);
    this.#occupied = new Uint8Array(this.#capacity);
  }

  set(slot: number, input: TransformPaletteInput, bounds: TransformRunBounds): boolean {
    this.#assertActive();
    assertSlot(slot);
    validateInput(input, bounds);
    const hasEffects = input.stroke !== undefined || input.dropShadow !== undefined;
    if (hasEffects) this.#enableEffects();
    this.#ensureCapacity(slot + 1);
    const offset = slot * FLOATS_PER_LABEL;
    const data = this.#data;
    const labelAlpha = Math.fround(input.visible ? input.alpha : 0);
    const fill = resolvePaint(input.fill, 0xffffff);
    const stroke = hasEffects ? resolveStroke(input.stroke) : EMPTY_STROKE;
    const shadow = hasEffects ? resolveShadow(input.dropShadow) : EMPTY_SHADOW;
    const rotation = input.rotation;
    const sin = rotation === 0 ? 0 : Math.fround(Math.sin(rotation));
    const cos = rotation === 0 ? 1 : Math.fround(Math.cos(rotation));
    const values = this.#scratch;
    const bits = this.#scratchBits;
    values[0] = Math.fround(input.x);
    values[1] = Math.fround(input.y);
    values[2] = Math.fround(input.scaleX);
    values[3] = Math.fround(input.scaleY);
    bits[4] = packHalf2x16(sin, cos);
    bits[5] = packHalf2x16(
      Math.fround(input.anchorX * bounds.width),
      Math.fround(input.anchorY * bounds.height),
    );
    values[6] = fill.color;
    values[7] = packFillAlpha(fill.alpha, labelAlpha) + (hasEffects ? EFFECT_FLAG : 0);
    let changed = this.#occupied[slot] !== 1;
    for (let index = 0; index < FLOATS_PER_LABEL; index += 1) {
      const value = values[index] ?? 0;
      if (data[offset + index] !== value) {
        data[offset + index] = value;
        changed = true;
      }
    }
    if (this.#effectsEnabled) {
      const effectOffset = this.#effectOffset(slot);
      const next = [
        hasEffects ? stroke.color : 0,
        hasEffects ? packStroke(stroke.width, stroke.alpha, shadow.alpha) : 0,
        hasEffects ? shadow.color : 0,
        hasEffects ? packShadow(shadow.x, shadow.y, shadow.blur, shadow.alpha) : 0,
      ];
      for (let index = 0; index < FLOATS_PER_EFFECT; index += 1) {
        const value = next[index] ?? 0;
        if (data[effectOffset + index] !== value) {
          data[effectOffset + index] = value;
          changed = true;
        }
      }
    }
    if (!changed) {
      return false;
    }
    if (this.#occupied[slot] !== 1) {
      this.#occupied[slot] = 1;
      this.#activeLabels += 1;
    }
    this.#dirty.record(slot * TRANSFORM_PALETTE_STRIDE, TRANSFORM_PALETTE_STRIDE);
    if (this.#effectsEnabled) {
      this.#dirty.record(this.#effectByteOffset(slot), TRANSFORM_EFFECT_STRIDE);
    }

    return true;
  }

  /** Patch x/y texels for a slot column without per-label objects or validation. */
  writePositions(slots: Uint32Array, count: number, xy: Float32Array): number {
    this.#assertActive();
    const data = this.#data;
    const occupied = this.#occupied;
    let written = 0;
    let minSlot = 0xffff_ffff;
    let maxSlot = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot >= this.#capacity || occupied[slot] !== 1) continue;
      const offset = slot * FLOATS_PER_LABEL;
      const nextX = Math.fround(xy[index * 2] ?? 0);
      const nextY = Math.fround(xy[index * 2 + 1] ?? 0);
      if (data[offset] === nextX && data[offset + 1] === nextY) continue;
      data[offset] = nextX;
      data[offset + 1] = nextY;
      if (slot < minSlot) minSlot = slot;
      if (slot > maxSlot) maxSlot = slot;
      written += 1;
    }
    if (written > 0) {
      this.#recordPositionDirty(minSlot, maxSlot, written, slots, count, occupied);
    }
    // #region agent log
    const posLog = (globalThis as { __GLYPHFLOW_POS_LOGS?: number }).__GLYPHFLOW_POS_LOGS ?? 0;
    if (posLog < 3) {
      (globalThis as { __GLYPHFLOW_POS_LOGS?: number }).__GLYPHFLOW_POS_LOGS = posLog + 1;
      agentLog("K", "TransformPalette.ts:writePositions", "writePositions", {
        count,
        written,
        minSlot: written > 0 ? minSlot : -1,
        maxSlot: written > 0 ? maxSlot : -1,
        spanSlots: written > 0 ? maxSlot - minSlot + 1 : 0,
        pendingDirtyRanges: this.#dirty.pendingRanges,
      });
    }
    // #endregion

    return written;
  }

  #recordPositionDirty(
    minSlot: number,
    maxSlot: number,
    written: number,
    slots: Uint32Array,
    count: number,
    occupied: Uint8Array,
  ): void {
    const spanSlots = maxSlot - minSlot + 1;
    if (spanSlots <= written * 4) {
      this.#dirty.record(
        minSlot * TRANSFORM_PALETTE_STRIDE,
        (maxSlot - minSlot) * TRANSFORM_PALETTE_STRIDE + 16,
      );
      return;
    }
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot >= this.#capacity || occupied[slot] !== 1) continue;
      this.#dirty.record(slot * TRANSFORM_PALETTE_STRIDE, 16);
    }
  }

  /**
   * Occupy a slot column with fill-only identity transforms (scale 1, rotation 0, anchors 0,
   * visible alpha 1) and packed x/y. Resolves `fill` once. Used for first-seen admit.
   */
  writeFills(slots: Uint32Array, count: number, xy: Float32Array, fill: unknown): number {
    this.#assertActive();
    if (count <= 0) return 0;
    if (xy.length < count * 2) {
      throw new TypeError("Palette writeFills xy must contain one packed pair per slot");
    }
    let maxSlot = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index];
      if (slot === undefined) {
        throw new Error("Palette writeFills slot list is incomplete");
      }
      assertSlot(slot);
      if (slot > maxSlot) maxSlot = slot;
    }
    this.#ensureCapacity(maxSlot + 1);
    const paint = resolvePaint(fill, 0xffffff);
    const packedAlpha = packFillAlpha(paint.alpha, 1);
    const rotationBits = packHalf2x16(0, 1);
    const anchorBits = packHalf2x16(0, 0);
    const data = this.#data;
    const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
    const occupied = this.#occupied;
    let written = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      const offset = slot * FLOATS_PER_LABEL;
      const nextX = Math.fround(xy[index * 2] ?? 0);
      const nextY = Math.fround(xy[index * 2 + 1] ?? 0);
      if (
        occupied[slot] === 1 &&
        data[offset] === nextX &&
        data[offset + 1] === nextY &&
        data[offset + 2] === 1 &&
        data[offset + 3] === 1 &&
        bits[offset + 4] === rotationBits &&
        bits[offset + 5] === anchorBits &&
        data[offset + 6] === paint.color &&
        data[offset + 7] === packedAlpha
      ) {
        continue;
      }
      data[offset] = nextX;
      data[offset + 1] = nextY;
      data[offset + 2] = 1;
      data[offset + 3] = 1;
      bits[offset + 4] = rotationBits;
      bits[offset + 5] = anchorBits;
      data[offset + 6] = paint.color;
      data[offset + 7] = packedAlpha;
      if (occupied[slot] !== 1) {
        occupied[slot] = 1;
        this.#activeLabels += 1;
      }
      this.#dirty.record(slot * TRANSFORM_PALETTE_STRIDE, TRANSFORM_PALETTE_STRIDE);
      written += 1;
    }
    return written;
  }

  /** Patch only the x/y texels of an occupied slot. */
  setPosition(slot: number, x: number, y: number): boolean {
    this.#assertActive();
    assertSlot(slot);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError("x and y must be finite");
    }
    if (slot >= this.#capacity || this.#occupied[slot] !== 1) {
      return false;
    }
    const offset = slot * FLOATS_PER_LABEL;
    const nextX = Math.fround(x);
    const nextY = Math.fround(y);
    if (this.#data[offset] === nextX && this.#data[offset + 1] === nextY) {
      return false;
    }
    this.#data[offset] = nextX;
    this.#data[offset + 1] = nextY;
    this.#dirty.record(slot * TRANSFORM_PALETTE_STRIDE, 16);

    return true;
  }

  remove(slot: number): boolean {
    this.#assertActive();
    assertSlot(slot);
    if (slot >= this.#capacity || this.#occupied[slot] !== 1) {
      return false;
    }
    this.#occupied[slot] = 0;
    this.#activeLabels -= 1;
    this.#data[slot * FLOATS_PER_LABEL + 7] = 0;
    this.#dirty.record(slot * TRANSFORM_PALETTE_STRIDE, TRANSFORM_PALETTE_STRIDE);
    if (this.#effectsEnabled) {
      const effectOffset = this.#effectOffset(slot);
      this.#data.fill(0, effectOffset, effectOffset + FLOATS_PER_EFFECT);
      this.#dirty.record(this.#effectByteOffset(slot), TRANSFORM_EFFECT_STRIDE);
    }

    return true;
  }

  get data(): Float32Array {
    this.#assertActive();
    return this.#data;
  }

  /** Occupied flag for a slot. Storage rebuilds refresh x/y from the store columns. @internal */
  occupiedAt(slot: number): boolean {
    this.#assertActive();
    return slot < this.#capacity && this.#occupied[slot] === 1;
  }

  /**
   * Rewrite occupied x/y from store columns without dirtying. Used when a storage buffer rebuild
   * would otherwise upload stale CPU texels after a mover-only storm.
   */
  refreshOrigins(originX: Float32Array, originY: Float32Array): number {
    this.#assertActive();
    const data = this.#data;
    const occupied = this.#occupied;
    const limit = Math.min(this.#capacity, occupied.length, originX.length, originY.length);
    let written = 0;
    for (let slot = 0; slot < limit; slot += 1) {
      if (occupied[slot] !== 1) continue;
      const offset = slot * FLOATS_PER_LABEL;
      data[offset] = originX[slot] ?? 0;
      data[offset + 1] = originY[slot] ?? 0;
      written += 1;
    }
    return written;
  }

  consumeDirty(): readonly Readonly<DirtyByteRange>[] {
    this.#assertActive();
    return this.#dirty.publish({
      acceptedGap: DIRTY_ACCEPTED_GAP,
      maxRanges: DIRTY_MAX_RANGES,
      liveBytes: this.#data.byteLength,
      wholeBufferBps: DIRTY_WHOLE_BUFFER_BPS,
    });
  }

  get stats(): Readonly<TransformPaletteStats> {
    return Object.freeze({
      capacity: this.#capacity,
      activeLabels: this.#activeLabels,
      allocatedBytes: this.#data.byteLength + this.#occupied.byteLength,
      textureWidth: this.#textureWidth,
      textureHeight: Math.ceil(this.#texelCount(this.#capacity) / this.#textureWidth),
      pendingDirtyRanges: this.#dirty.pendingRanges,
      coreStride: TRANSFORM_PALETTE_STRIDE,
      effectBase: this.#effectsEnabled ? this.#capacity * CORE_TEXELS_PER_LABEL : 0,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#data = new Float32Array();
    this.#occupied = new Uint8Array();
    this.#dirty.clear();
    this.#capacity = 0;
    this.#activeLabels = 0;
    this.#effectsEnabled = false;
    this.#destroyed = true;
  }

  #enableEffects(): void {
    if (this.#effectsEnabled) return;
    this.#effectsEnabled = true;
    const data = this.#allocateData(this.#capacity);
    data.set(this.#data.subarray(0, this.#capacity * FLOATS_PER_LABEL));
    this.#data = data;
    this.#dirty.clear();
    this.#dirty.record(0, data.byteLength);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;
    if (required > this.#maxCapacity) {
      throw new RangeError(`Transform palette capacity exceeds ${String(this.#maxCapacity)}`);
    }
    let capacity = this.#capacity;
    while (capacity < required) capacity *= 2;
    capacity = Math.min(capacity, this.#maxCapacity);
    const data = this.#allocateData(capacity);
    data.set(this.#data.subarray(0, this.#capacity * FLOATS_PER_LABEL));
    if (this.#effectsEnabled) {
      const previous = this.#data.subarray(
        this.#capacity * FLOATS_PER_LABEL,
        this.#capacity * FLOATS_PER_LABEL + this.#capacity * FLOATS_PER_EFFECT,
      );
      data.set(previous, capacity * FLOATS_PER_LABEL);
    }
    const occupied = new Uint8Array(capacity);
    occupied.set(this.#occupied);
    this.#data = data;
    this.#occupied = occupied;
    this.#capacity = capacity;
    this.#dirty.clear();
    this.#dirty.record(0, data.byteLength);
  }

  #allocateData(capacity: number): Float32Array {
    const textureHeight = Math.ceil(this.#texelCount(capacity) / this.#textureWidth);
    return new Float32Array(this.#textureWidth * textureHeight * 4);
  }

  #texelCount(capacity: number): number {
    return capacity * CORE_TEXELS_PER_LABEL + (this.#effectsEnabled ? capacity : 0);
  }

  #effectOffset(slot: number): number {
    return this.#capacity * FLOATS_PER_LABEL + slot * FLOATS_PER_EFFECT;
  }

  #effectByteOffset(slot: number): number {
    return this.#effectOffset(slot) * Float32Array.BYTES_PER_ELEMENT;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("TransformPalette has been destroyed");
    }
  }
}

interface ResolvedPaint {
  readonly color: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
}

const EMPTY_STROKE = Object.freeze({ color: 0, width: 0, alpha: 0 });
const EMPTY_SHADOW = Object.freeze({ color: 0, x: 0, y: 0, blur: 0, alpha: 0 });

function resolvePaint(input: unknown, fallback: number): ResolvedPaint {
  if (typeof input === "number" && Number.isFinite(input)) {
    const color = Math.max(0, Math.min(0xffffff, Math.trunc(input)));
    return {
      color,
      r: ((color >> 16) & 0xff) / 255,
      g: ((color >> 8) & 0xff) / 255,
      b: (color & 0xff) / 255,
      alpha: 1,
    };
  }
  if (input === undefined || input === null) {
    const color = fallback;
    return {
      color,
      r: ((color >> 16) & 0xff) / 255,
      g: ((color >> 8) & 0xff) / 255,
      b: (color & 0xff) / 255,
      alpha: 1,
    };
  }
  let source: unknown = input;
  let alpha = 1;
  if (typeof input === "object" && input !== null) {
    const style = input as Readonly<{ color?: unknown; fill?: unknown; alpha?: unknown }>;
    source = style.color ?? style.fill;
    if (typeof style.alpha === "number" && Number.isFinite(style.alpha)) {
      alpha = clamp(style.alpha, 0, 1);
    }
  }
  if (source === undefined || source === null) source = fallback;
  let color = fallback;
  try {
    const parsed = new Color(source as ConstructorParameters<typeof Color>[0]);
    color = parsed.toNumber();
    alpha *= parsed.alpha;
  } catch {
    color = fallback;
  }
  color = Math.max(0, Math.min(0xffffff, Math.trunc(color)));
  return {
    color,
    r: ((color >> 16) & 0xff) / 255,
    g: ((color >> 8) & 0xff) / 255,
    b: (color & 0xff) / 255,
    alpha,
  };
}

function resolveStroke(input: unknown): Readonly<{ color: number; width: number; alpha: number }> {
  if (input === undefined || input === null || input === false) {
    return { color: 0, width: 0, alpha: 0 };
  }
  const style =
    typeof input === "object" && input !== null
      ? (input as Readonly<{ width?: unknown }>)
      : undefined;
  const paint = resolvePaint(input, 0x000000);
  const width =
    typeof style?.width === "number" && Number.isFinite(style.width)
      ? clamp(style.width, 0, 255.9375)
      : 1;
  return { color: paint.color, width, alpha: paint.alpha };
}

function resolveShadow(
  input: unknown,
): Readonly<{ color: number; x: number; y: number; blur: number; alpha: number }> {
  if (input !== true && (typeof input !== "object" || input === null)) {
    return { color: 0, x: 0, y: 0, blur: 0, alpha: 0 };
  }
  const style =
    input === true
      ? {}
      : (input as Readonly<{
          angle?: unknown;
          distance?: unknown;
          blur?: unknown;
        }>);
  const paint = resolvePaint(input === true ? 0x000000 : input, 0x000000);
  const angle =
    typeof style.angle === "number" && Number.isFinite(style.angle) ? style.angle : Math.PI / 6;
  const distance =
    typeof style.distance === "number" && Number.isFinite(style.distance) ? style.distance : 5;
  const blur =
    typeof style.blur === "number" && Number.isFinite(style.blur) ? clamp(style.blur, 0, 15) : 0;
  return {
    color: paint.color,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    blur,
    alpha: paint.alpha,
  };
}

function packFillAlpha(fillAlpha: number, labelAlpha: number): number {
  const fillBits = Math.round(clamp(fillAlpha, 0, 1) * 255);
  const labelBits = Math.round(clamp(labelAlpha, 0, 1) * 255);
  return fillBits + labelBits * 256;
}

function packStroke(width: number, alpha: number, shadowAlpha: number): number {
  const widthBits = Math.round(clamp(width, 0, 255.9375) * 16);
  const alphaBits = Math.round(clamp(alpha, 0, 1) * 255);
  const shadowAlphaBits = Math.round(clamp(shadowAlpha, 0, 1) * 255);
  return widthBits + alphaBits * 4096 + (shadowAlphaBits & 15) * 1_048_576;
}

function packShadow(x: number, y: number, blur: number, alpha: number): number {
  const xBits = Math.round(clamp(x, -32, 31.75) * 4) + 128;
  const yBits = Math.round(clamp(y, -32, 31.75) * 4) + 128;
  const blurBits = Math.round(clamp(blur, 0, 15));
  const alphaBits = Math.round(clamp(alpha, 0, 1) * 255);
  return xBits + yBits * 256 + blurBits * 65_536 + (alphaBits >> 4) * 1_048_576;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validateInput(input: TransformPaletteInput, bounds: TransformRunBounds): void {
  for (const [name, value] of Object.entries({
    x: input.x,
    y: input.y,
    scaleX: input.scaleX,
    scaleY: input.scaleY,
    rotation: input.rotation,
    alpha: input.alpha,
    anchorX: input.anchorX,
    anchorY: input.anchorY,
    width: bounds.width,
    height: bounds.height,
  })) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must be finite`);
    }
  }
  if (bounds.width < 0 || bounds.height < 0) {
    throw new TypeError("Transform run bounds must be non-negative");
  }
}

function assertSlot(slot: number): void {
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new TypeError("Transform palette slot must be a non-negative safe integer");
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function agentLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  if (!(globalThis as { __GLYPHFLOW_AGENT_DEBUG?: boolean }).__GLYPHFLOW_AGENT_DEBUG) return;
  const entry = {
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
  const line = JSON.stringify(entry);
  console.info("__AGENT_LOG__", line);
  if (typeof fetch !== "function") return;
  const send = (url: string): void => {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line,
      keepalive: true,
      mode: "cors",
    }).catch(() => undefined);
  };
  send("http://127.0.0.1:7733/");
  send("/agent-debug-log");
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
