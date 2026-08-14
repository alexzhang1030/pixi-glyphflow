import { DirtyRanges } from "./DirtyRanges";
import type {
  DirtyByteRange,
  TransformPaletteInput,
  TransformPaletteOptions,
  TransformPaletteStats,
  TransformRunBounds,
} from "./types";

export const TRANSFORM_PALETTE_STRIDE = 48;
const FLOATS_PER_LABEL = TRANSFORM_PALETTE_STRIDE / Float32Array.BYTES_PER_ELEMENT;
const TEXELS_PER_LABEL = 3;
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
    const alpha = Math.fround(input.visible ? input.alpha : 0);
    const color = resolveColor(input.fill, alpha);
    const next = [
      input.x,
      input.y,
      input.scaleX,
      input.scaleY,
      Math.sin(input.rotation),
      Math.cos(input.rotation),
      input.anchorX * bounds.width,
      input.anchorY * bounds.height,
      color.r,
      color.g,
      color.b,
      alpha,
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

function resolveColor(fill: unknown, alpha: number): Readonly<{ r: number; g: number; b: number }> {
  let color = 0xffffff;
  if (typeof fill === "number" && Number.isFinite(fill)) {
    color = Math.max(0, Math.min(0xffffff, Math.trunc(fill)));
  } else if (typeof fill === "string") {
    const normalized = fill.startsWith("#") ? fill.slice(1) : fill;
    if (/^[0-9a-f]{6}$/i.test(normalized)) {
      color = Number.parseInt(normalized, 16);
    }
  }

  return {
    r: (((color >> 16) & 0xff) / 255) * alpha,
    g: (((color >> 8) & 0xff) / 255) * alpha,
    b: ((color & 0xff) / 255) * alpha,
  };
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
