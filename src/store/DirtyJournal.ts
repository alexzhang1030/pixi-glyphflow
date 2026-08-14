import { TextDirty, type TextDirtyMask } from "./types";

const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;

export interface PendingDirty {
  readonly labels: number;
  readonly mask: TextDirtyMask;
}

export interface PublishedDirty extends PendingDirty {
  readonly content: number;
  readonly transform: number;
  readonly style: number;
}

export class DirtyJournal {
  #capacity: number;
  #length = 0;
  #aggregateMask: TextDirtyMask = TextDirty.None;
  #masks: Uint8Array;
  #slots: Uint32Array;

  constructor(initialCapacity: number) {
    assertCapacity(initialCapacity);
    this.#capacity = nextPowerOfTwo(initialCapacity);
    this.#masks = new Uint8Array(this.#capacity);
    this.#slots = new Uint32Array(this.#capacity);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get allocatedBytes(): number {
    return this.#masks.byteLength + this.#slots.byteLength;
  }

  get pending(): Readonly<PendingDirty> {
    return Object.freeze({
      labels: this.#length,
      mask: this.#aggregateMask,
    });
  }

  reserve(requiredCapacity: number): void {
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity < 0) {
      throw new TypeError("requiredCapacity must be a non-negative safe integer");
    }
    if (requiredCapacity <= this.#capacity) {
      return;
    }

    this.resize(nextPowerOfTwo(requiredCapacity));
  }

  resize(capacity: number): void {
    assertCapacity(capacity);
    if (capacity < this.#highestPendingSlot() + 1) {
      throw new RangeError("DirtyJournal capacity must retain every pending slot");
    }
    if (capacity === this.#capacity) {
      return;
    }

    const masks = new Uint8Array(capacity);
    masks.set(this.#masks.subarray(0, capacity));
    const slots = new Uint32Array(capacity);
    slots.set(this.#slots.subarray(0, this.#length));
    this.#masks = masks;
    this.#slots = slots;
    this.#capacity = capacity;
  }

  record(slot: number, mask: TextDirtyMask): void {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new TypeError("Dirty slot must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(mask) || mask < 0 || (mask & ~ALL_DIRTY) !== 0) {
      throw new TypeError("Dirty mask contains an unsupported domain");
    }
    if (mask === TextDirty.None) {
      return;
    }

    this.reserve(slot + 1);
    const previous = this.#masks[slot] ?? TextDirty.None;
    if (previous === TextDirty.None) {
      this.#slots[this.#length] = slot;
      this.#length += 1;
    }
    this.#masks[slot] = previous | mask;
    this.#aggregateMask |= mask;
  }

  publish(): Readonly<PublishedDirty> {
    let content = 0;
    let transform = 0;
    let style = 0;

    for (let index = 0; index < this.#length; index += 1) {
      const slot = this.#slots[index];
      if (slot === undefined) {
        throw new Error(`DirtyJournal slot missing at index ${String(index)}`);
      }
      const mask = this.#masks[slot] ?? TextDirty.None;
      content += Number((mask & TextDirty.Content) !== 0);
      transform += Number((mask & TextDirty.Transform) !== 0);
      style += Number((mask & TextDirty.Style) !== 0);
      this.#masks[slot] = TextDirty.None;
    }

    const published = Object.freeze({
      labels: this.#length,
      content,
      transform,
      style,
      mask: this.#aggregateMask,
    });
    this.#length = 0;
    this.#aggregateMask = TextDirty.None;

    return published;
  }

  dispose(): void {
    this.#capacity = 0;
    this.#length = 0;
    this.#aggregateMask = TextDirty.None;
    this.#masks = new Uint8Array();
    this.#slots = new Uint32Array();
  }

  #highestPendingSlot(): number {
    let highest = -1;
    for (let index = 0; index < this.#length; index += 1) {
      highest = Math.max(highest, this.#slots[index] ?? -1);
    }
    return highest;
  }
}

function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError("DirtyJournal capacity must be a positive safe integer");
  }
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) {
    capacity *= 2;
  }

  return capacity;
}
