import { Color } from "pixi.js";

import { DirtyRanges } from "./DirtyRanges";
import type {
  DirtyByteRange,
  TransformPaletteInput,
  TransformPaletteOptions,
  TransformPaletteStats,
  TransformRunBounds,
} from "./types";

export const TRANSFORM_PALETTE_STRIDE = 64;
const FLOATS_PER_LABEL = TRANSFORM_PALETTE_STRIDE / Float32Array.BYTES_PER_ELEMENT;
const TEXELS_PER_LABEL = 4;
const DEFAULT_CAPACITY = 1_024;
const DEFAULT_TEXTURE_WIDTH = 1_024;
const DEFAULT_MAX_CAPACITY = 0x100_0000;

export class TransformPalette {
  readonly #textureWidth: number;
  readonly #maxCapacity: number;
  readonly #dirty = new DirtyRanges();
  #capacity: number;
  #data: Float32Array;
  #occupied: Uint8Array;
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
    this.#ensureCapacity(slot + 1);
    const offset = slot * FLOATS_PER_LABEL;
    const labelAlpha = Math.fround(input.visible ? input.alpha : 0);
    const fill = resolvePaint(input.fill, 0xffffff);
    const stroke = resolveStroke(input.stroke);
    const shadow = resolveShadow(input.dropShadow);
    const next = [
      input.x,
      input.y,
      input.scaleX,
      input.scaleY,
      Math.sin(input.rotation),
      Math.cos(input.rotation),
      input.anchorX * bounds.width,
      input.anchorY * bounds.height,
      fill.r,
      fill.g,
      fill.b,
      packFillAlpha(fill.alpha, labelAlpha),
      stroke.color,
      packStroke(stroke.width, stroke.alpha, shadow.alpha),
      shadow.color,
      packShadow(shadow.x, shadow.y, shadow.blur, shadow.alpha),
    ];
    let changed = this.#occupied[slot] !== 1;
    for (let index = 0; index < FLOATS_PER_LABEL; index += 1) {
      const value = Math.fround(next[index] ?? 0);
      if (this.#data[offset + index] !== value) {
        this.#data[offset + index] = value;
        changed = true;
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
    this.#data[slot * FLOATS_PER_LABEL + 11] = 0;
    this.#dirty.record(slot * TRANSFORM_PALETTE_STRIDE, TRANSFORM_PALETTE_STRIDE);

    return true;
  }

  get data(): Float32Array {
    this.#assertActive();
    return this.#data;
  }

  consumeDirty(): readonly Readonly<DirtyByteRange>[] {
    this.#assertActive();
    return this.#dirty.publish();
  }

  get stats(): Readonly<TransformPaletteStats> {
    return Object.freeze({
      capacity: this.#capacity,
      activeLabels: this.#activeLabels,
      allocatedBytes: this.#data.byteLength + this.#occupied.byteLength,
      textureWidth: this.#textureWidth,
      textureHeight: Math.ceil((this.#capacity * TEXELS_PER_LABEL) / this.#textureWidth),
      pendingDirtyRanges: this.#dirty.pendingRanges,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#data = new Float32Array();
    this.#occupied = new Uint8Array();
    this.#dirty.clear();
    this.#capacity = 0;
    this.#activeLabels = 0;
    this.#destroyed = true;
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
    const occupied = new Uint8Array(capacity);
    occupied.set(this.#occupied);
    this.#data = data;
    this.#occupied = occupied;
    this.#capacity = capacity;
    this.#dirty.clear();
    this.#dirty.record(0, data.byteLength);
  }

  #allocateData(capacity: number): Float32Array {
    const textureHeight = Math.ceil((capacity * TEXELS_PER_LABEL) / this.#textureWidth);
    return new Float32Array(this.#textureWidth * textureHeight * 4);
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

function resolvePaint(input: unknown, fallback: number): ResolvedPaint {
  let source = input;
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

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
