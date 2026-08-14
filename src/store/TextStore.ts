import type { TextId } from "../types";
import {
  DirtyJournal,
  type DirtySlotVisitor,
  type PendingDirty,
  type PublishedDirty,
} from "./DirtyJournal";
import {
  TextDirty,
  type TextDirtyMask,
  type TextStoreLabel,
  type TextStoreLabelPatch,
  type TextStoreCompaction,
  type TextStoreSnapshot,
  type TextStoreStats,
} from "./types";

const SLOT_RADIX = 0x100_0000;
const NAMESPACE_RADIX = 0x2_0000_0000;
const MAX_GENERATION = 0x1ff;
const MAX_NAMESPACE = 0xf_ffff;
const MAX_CAPACITY = 0x100_0000;
const DEFAULT_CAPACITY = 16;
const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;
let nextNamespace = 1;

export interface TextStoreOptions {
  readonly initialCapacity?: number;
}

export class TextStore {
  readonly #idBase: number;
  #capacity: number;
  #size = 0;
  #highWater = 0;
  #generations: Uint32Array;
  #occupied: Uint8Array;
  #sourceRevisions: Uint32Array;
  #x: Float32Array;
  #y: Float32Array;
  #scaleX: Float32Array;
  #scaleY: Float32Array;
  #rotation: Float32Array;
  #alpha: Float32Array;
  #visible: Uint8Array;
  #anchorX: Float32Array;
  #anchorY: Float32Array;
  #texts: Array<string | undefined>;
  #styles: Array<Readonly<TextStoreLabel["style"]> | undefined>;
  readonly #freeSlots: number[] = [];
  #positionSlots = new Uint32Array();
  readonly #journal: DirtyJournal;

  constructor(options: TextStoreOptions = {}) {
    const requestedCapacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    assertPositiveCapacity(requestedCapacity);
    if (nextNamespace > MAX_NAMESPACE) {
      throw new RangeError("TextStore namespace capacity exhausted in this JavaScript realm");
    }
    this.#idBase = nextNamespace * NAMESPACE_RADIX;
    nextNamespace += 1;

    this.#capacity = nextPowerOfTwo(requestedCapacity);
    this.#generations = new Uint32Array(this.#capacity);
    this.#occupied = new Uint8Array(this.#capacity);
    this.#sourceRevisions = new Uint32Array(this.#capacity);
    this.#x = new Float32Array(this.#capacity);
    this.#y = new Float32Array(this.#capacity);
    this.#scaleX = new Float32Array(this.#capacity);
    this.#scaleY = new Float32Array(this.#capacity);
    this.#rotation = new Float32Array(this.#capacity);
    this.#alpha = new Float32Array(this.#capacity);
    this.#visible = new Uint8Array(this.#capacity);
    this.#anchorX = new Float32Array(this.#capacity);
    this.#anchorY = new Float32Array(this.#capacity);
    this.#texts = Array.from({ length: this.#capacity }, () => undefined);
    this.#styles = Array.from({ length: this.#capacity }, () => undefined);
    this.#journal = new DirtyJournal(this.#capacity);
  }

  get size(): number {
    return this.#size;
  }

  get capacity(): number {
    return this.#capacity;
  }

  reserve(additionalLabels: number): void {
    if (!Number.isSafeInteger(additionalLabels) || additionalLabels < 0) {
      throw new TypeError("additionalLabels must be a non-negative safe integer");
    }

    const requiredNewSlots = Math.max(0, additionalLabels - this.#freeSlots.length);
    const requiredHighWater = this.#highWater + requiredNewSlots;
    if (requiredHighWater > MAX_CAPACITY) {
      throw new RangeError(`TextStore capacity exceeds ${String(MAX_CAPACITY)} labels`);
    }
    while (this.#capacity < requiredHighWater) {
      this.#grow();
    }
  }

  get stats(): Readonly<TextStoreStats> {
    const numericBytes =
      this.#generations.byteLength +
      this.#occupied.byteLength +
      this.#sourceRevisions.byteLength +
      this.#x.byteLength +
      this.#y.byteLength +
      this.#scaleX.byteLength +
      this.#scaleY.byteLength +
      this.#rotation.byteLength +
      this.#alpha.byteLength +
      this.#visible.byteLength +
      this.#anchorX.byteLength +
      this.#anchorY.byteLength +
      this.#positionSlots.byteLength +
      this.#journal.allocatedBytes;
    const referenceSlotBytes = this.#capacity * 2 * 8;

    return Object.freeze({
      size: this.#size,
      capacity: this.#capacity,
      freeSlots: this.#freeSlots.length,
      numericBytes,
      referenceSlotBytes,
      allocatedBytes: numericBytes + referenceSlotBytes,
    });
  }

  create(label: TextStoreLabel): TextId {
    assertLabel(label);
    const slot = this.#freeSlots.pop() ?? this.#allocateSlot();
    const generation = this.#generations[slot] ?? 1;

    this.#generations[slot] = generation;
    this.#occupied[slot] = 1;
    this.#sourceRevisions[slot] = 1;
    this.#write(slot, label);
    this.#journal.record(slot, ALL_DIRTY);
    this.#size += 1;

    return (this.#idBase + generation * SLOT_RADIX + slot) as TextId;
  }

  get(id: TextId): Readonly<TextStoreSnapshot> | undefined {
    const slot = this.#resolveSlot(id);
    if (slot === undefined) {
      return undefined;
    }

    return this.#snapshot(slot, id);
  }

  /** Return the current slot for a layer-local identity. @internal */
  slotOf(id: TextId): number | undefined {
    return this.#resolveSlot(id);
  }

  /** Read the current label occupying a dense slot. @internal */
  snapshotAt(slot: number): Readonly<TextStoreSnapshot> | undefined {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new TypeError("TextStore slot must be a non-negative safe integer");
    }
    if (slot >= this.#highWater || this.#occupied[slot] !== 1) {
      return undefined;
    }
    const generation = this.#generations[slot] ?? 1;
    const id = (this.#idBase + generation * SLOT_RADIX + slot) as TextId;

    return this.#snapshot(slot, id);
  }

  #snapshot(slot: number, id: TextId): Readonly<TextStoreSnapshot> {
    const text = this.#texts[slot];
    const style = this.#styles[slot];
    if (text === undefined || style === undefined) {
      throw new Error("TextStore invariant violation: occupied slot is incomplete");
    }

    return Object.freeze({
      id,
      sourceRevision: this.#sourceRevisions[slot] ?? 1,
      text,
      x: this.#x[slot] ?? 0,
      y: this.#y[slot] ?? 0,
      scaleX: this.#scaleX[slot] ?? 0,
      scaleY: this.#scaleY[slot] ?? 0,
      rotation: this.#rotation[slot] ?? 0,
      alpha: this.#alpha[slot] ?? 0,
      visible: this.#visible[slot] === 1,
      anchorX: this.#anchorX[slot] ?? 0,
      anchorY: this.#anchorY[slot] ?? 0,
      style,
    });
  }

  has(id: TextId): boolean {
    return this.#resolveSlot(id) !== undefined;
  }

  update(id: TextId, patch: TextStoreLabelPatch): TextDirtyMask {
    assertPatch(patch);
    const slot = this.#requireSlot(id);
    let dirty = TextDirty.None as TextDirtyMask;

    if (patch.text !== undefined && patch.text !== this.#texts[slot]) {
      this.#texts[slot] = patch.text;
      dirty |= TextDirty.Content;
    }
    if (patch.x !== undefined && patch.x !== this.#x[slot]) {
      this.#x[slot] = patch.x;
      dirty |= TextDirty.Transform;
    }
    if (patch.y !== undefined && patch.y !== this.#y[slot]) {
      this.#y[slot] = patch.y;
      dirty |= TextDirty.Transform;
    }
    if (patch.scaleX !== undefined && patch.scaleX !== this.#scaleX[slot]) {
      this.#scaleX[slot] = patch.scaleX;
      dirty |= TextDirty.Transform;
    }
    if (patch.scaleY !== undefined && patch.scaleY !== this.#scaleY[slot]) {
      this.#scaleY[slot] = patch.scaleY;
      dirty |= TextDirty.Transform;
    }
    if (patch.rotation !== undefined && patch.rotation !== this.#rotation[slot]) {
      this.#rotation[slot] = patch.rotation;
      dirty |= TextDirty.Transform;
    }
    if (patch.alpha !== undefined && patch.alpha !== this.#alpha[slot]) {
      this.#alpha[slot] = patch.alpha;
      dirty |= TextDirty.Transform;
    }
    if (patch.visible !== undefined && Number(patch.visible) !== this.#visible[slot]) {
      this.#visible[slot] = Number(patch.visible);
      dirty |= TextDirty.Transform;
    }
    if (patch.anchorX !== undefined && patch.anchorX !== this.#anchorX[slot]) {
      this.#anchorX[slot] = patch.anchorX;
      dirty |= TextDirty.Transform;
    }
    if (patch.anchorY !== undefined && patch.anchorY !== this.#anchorY[slot]) {
      this.#anchorY[slot] = patch.anchorY;
      dirty |= TextDirty.Transform;
    }
    if (patch.style !== undefined && patch.style !== this.#styles[slot]) {
      this.#styles[slot] = freezeStyle(patch.style);
      dirty |= TextDirty.Style;
    }

    if ((dirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
      const revision = this.#sourceRevisions[slot] ?? 0;
      if (revision === 0xffff_ffff) {
        throw new RangeError("Text label source revision exhausted");
      }
      this.#sourceRevisions[slot] = revision + 1;
    }
    if (dirty !== TextDirty.None) {
      this.#journal.record(slot, dirty);
    }

    return dirty;
  }

  updatePositions(
    ids: readonly TextId[] | Float64Array,
    positions: Float32Array | Float64Array,
  ): number {
    if (positions.length !== ids.length * 2) {
      throw new TypeError("positions must contain one packed x/y pair for every TextId");
    }

    if (this.#positionSlots.length < ids.length) {
      this.#positionSlots = new Uint32Array(nextPowerOfTwo(ids.length));
    }
    const slots = this.#positionSlots;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) {
        throw new TypeError(`Missing TextId at index ${String(index)}`);
      }
      const slot = this.#requireSlot(id as TextId);
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError(`Position at index ${String(index)} must contain finite x/y values`);
      }
      slots[index] = slot;
    }

    let changed = 0;
    for (let index = 0; index < ids.length; index += 1) {
      const slot = slots[index];
      if (slot === undefined) {
        throw new Error(`TextStore position slot missing at index ${String(index)}`);
      }
      const x = Math.fround(positions[index * 2] ?? 0);
      const y = Math.fround(positions[index * 2 + 1] ?? 0);
      if (x === this.#x[slot] && y === this.#y[slot]) {
        continue;
      }

      this.#x[slot] = x;
      this.#y[slot] = y;
      this.#journal.record(slot, TextDirty.Transform);
      changed += 1;
    }

    return changed;
  }

  remove(id: TextId): boolean {
    const slot = this.#resolveSlot(id);
    if (slot === undefined) {
      return false;
    }

    this.#occupied[slot] = 0;
    this.#sourceRevisions[slot] = 0;
    this.#texts[slot] = undefined;
    this.#styles[slot] = undefined;
    this.#size -= 1;
    this.#journal.record(slot, ALL_DIRTY);
    this.#retireSlot(slot);

    return true;
  }

  clear(): void {
    this.#freeSlots.length = 0;

    for (let slot = 0; slot < this.#highWater; slot += 1) {
      if (this.#occupied[slot] === 1) {
        this.#occupied[slot] = 0;
        this.#sourceRevisions[slot] = 0;
        this.#texts[slot] = undefined;
        this.#styles[slot] = undefined;
        this.#journal.record(slot, ALL_DIRTY);
        this.#retireSlot(slot);
      } else if ((this.#generations[slot] ?? 0) < MAX_GENERATION) {
        this.#freeSlots.push(slot);
      }
    }

    this.#size = 0;
  }

  get pendingDirty(): Readonly<PendingDirty> {
    return this.#journal.pending;
  }

  markDirty(id: TextId, mask: TextDirtyMask): void {
    const slot = this.#requireSlot(id);
    if (!Number.isSafeInteger(mask) || mask <= TextDirty.None || (mask & ~ALL_DIRTY) !== 0) {
      throw new TypeError("Dirty mask contains unsupported domains");
    }
    this.#journal.record(slot, mask);
  }

  publishDirty(visitor?: DirtySlotVisitor): Readonly<PublishedDirty> {
    return this.#journal.publish(visitor);
  }

  markAllDirty(mask: TextDirtyMask = ALL_DIRTY): number {
    if (!Number.isSafeInteger(mask) || mask <= TextDirty.None || (mask & ~ALL_DIRTY) !== 0) {
      throw new TypeError("Dirty mask contains unsupported domains");
    }
    let marked = 0;
    for (let slot = 0; slot < this.#highWater; slot += 1) {
      if (this.#occupied[slot] === 1) {
        this.#journal.record(slot, mask);
        marked += 1;
      }
    }

    return marked;
  }

  compact(): Readonly<TextStoreCompaction> {
    const beforeCapacity = this.#capacity;
    const beforeBytes = this.stats.allocatedBytes;
    const minimumCapacity = Math.max(DEFAULT_CAPACITY, this.#highWater);
    const afterCapacity = nextPowerOfTwo(minimumCapacity);

    if (afterCapacity < beforeCapacity) {
      this.#generations = resizeTypedArray(this.#generations, afterCapacity);
      this.#occupied = resizeTypedArray(this.#occupied, afterCapacity);
      this.#sourceRevisions = resizeTypedArray(this.#sourceRevisions, afterCapacity);
      this.#x = resizeTypedArray(this.#x, afterCapacity);
      this.#y = resizeTypedArray(this.#y, afterCapacity);
      this.#scaleX = resizeTypedArray(this.#scaleX, afterCapacity);
      this.#scaleY = resizeTypedArray(this.#scaleY, afterCapacity);
      this.#rotation = resizeTypedArray(this.#rotation, afterCapacity);
      this.#alpha = resizeTypedArray(this.#alpha, afterCapacity);
      this.#visible = resizeTypedArray(this.#visible, afterCapacity);
      this.#anchorX = resizeTypedArray(this.#anchorX, afterCapacity);
      this.#anchorY = resizeTypedArray(this.#anchorY, afterCapacity);
      this.#texts.length = afterCapacity;
      this.#styles.length = afterCapacity;
      this.#journal.resize(afterCapacity);
      this.#capacity = afterCapacity;
    }

    const afterBytes = this.stats.allocatedBytes;
    return Object.freeze({
      beforeCapacity,
      afterCapacity: this.#capacity,
      beforeBytes,
      afterBytes,
      releasedBytes: beforeBytes - afterBytes,
    });
  }

  dispose(): void {
    this.#capacity = 0;
    this.#size = 0;
    this.#highWater = 0;
    this.#generations = new Uint32Array();
    this.#occupied = new Uint8Array();
    this.#sourceRevisions = new Uint32Array();
    this.#x = new Float32Array();
    this.#y = new Float32Array();
    this.#scaleX = new Float32Array();
    this.#scaleY = new Float32Array();
    this.#rotation = new Float32Array();
    this.#alpha = new Float32Array();
    this.#visible = new Uint8Array();
    this.#anchorX = new Float32Array();
    this.#anchorY = new Float32Array();
    this.#texts = [];
    this.#styles = [];
    this.#freeSlots.length = 0;
    this.#positionSlots = new Uint32Array();
    this.#journal.dispose();
  }

  #allocateSlot(): number {
    if (this.#highWater === this.#capacity) {
      this.#grow();
    }

    const slot = this.#highWater;
    this.#highWater += 1;
    this.#generations[slot] = 1;

    return slot;
  }

  #grow(): void {
    if (this.#capacity >= MAX_CAPACITY) {
      throw new RangeError(`TextStore capacity exceeds ${String(MAX_CAPACITY)} labels`);
    }

    const capacity = Math.min(this.#capacity * 2, MAX_CAPACITY);
    this.#generations = growTypedArray(this.#generations, capacity);
    this.#occupied = growTypedArray(this.#occupied, capacity);
    this.#sourceRevisions = growTypedArray(this.#sourceRevisions, capacity);
    this.#x = growTypedArray(this.#x, capacity);
    this.#y = growTypedArray(this.#y, capacity);
    this.#scaleX = growTypedArray(this.#scaleX, capacity);
    this.#scaleY = growTypedArray(this.#scaleY, capacity);
    this.#rotation = growTypedArray(this.#rotation, capacity);
    this.#alpha = growTypedArray(this.#alpha, capacity);
    this.#visible = growTypedArray(this.#visible, capacity);
    this.#anchorX = growTypedArray(this.#anchorX, capacity);
    this.#anchorY = growTypedArray(this.#anchorY, capacity);
    this.#texts.length = capacity;
    this.#styles.length = capacity;
    this.#journal.reserve(capacity);
    this.#capacity = capacity;
  }

  #write(slot: number, label: TextStoreLabel): void {
    this.#texts[slot] = label.text;
    this.#x[slot] = label.x;
    this.#y[slot] = label.y;
    this.#scaleX[slot] = label.scaleX;
    this.#scaleY[slot] = label.scaleY;
    this.#rotation[slot] = label.rotation;
    this.#alpha[slot] = label.alpha;
    this.#visible[slot] = Number(label.visible);
    this.#anchorX[slot] = label.anchorX;
    this.#anchorY[slot] = label.anchorY;
    this.#styles[slot] = freezeStyle(label.style);
  }

  #retireSlot(slot: number): void {
    const generation = this.#generations[slot] ?? 1;
    if (generation < MAX_GENERATION) {
      this.#generations[slot] = generation + 1;
      this.#freeSlots.push(slot);
    }
  }

  #requireSlot(id: TextId): number {
    const slot = this.#resolveSlot(id);
    if (slot === undefined) {
      throw new RangeError(`Unknown or stale TextId: ${String(id)}`);
    }

    return slot;
  }

  #resolveSlot(id: TextId): number | undefined {
    const value = Number(id);
    const localId = value - this.#idBase;
    if (!Number.isSafeInteger(value) || localId < SLOT_RADIX || localId >= NAMESPACE_RADIX) {
      return undefined;
    }

    const generation = Math.floor(localId / SLOT_RADIX);
    const slot = localId - generation * SLOT_RADIX;
    if (
      generation < 1 ||
      generation > MAX_GENERATION ||
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= this.#highWater ||
      this.#occupied[slot] !== 1 ||
      this.#generations[slot] !== generation
    ) {
      return undefined;
    }

    return slot;
  }
}

function assertPositiveCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > MAX_CAPACITY) {
    throw new TypeError(`initialCapacity must be an integer from 1 to ${String(MAX_CAPACITY)}`);
  }
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) {
    capacity *= 2;
  }

  return capacity;
}

function assertLabel(label: TextStoreLabel): void {
  if (typeof label.text !== "string") {
    throw new TypeError("Label text must be a string");
  }
  if (typeof label.visible !== "boolean") {
    throw new TypeError("visible must be a boolean");
  }
  if (typeof label.style !== "object" || label.style === null) {
    throw new TypeError("style must be an object");
  }
  assertFiniteFields(label);
}

function assertPatch(patch: TextStoreLabelPatch): void {
  if (patch.text !== undefined && typeof patch.text !== "string") {
    throw new TypeError("Label text must be a string");
  }
  if (patch.visible !== undefined && typeof patch.visible !== "boolean") {
    throw new TypeError("visible must be a boolean");
  }
  if (patch.style !== undefined && (typeof patch.style !== "object" || patch.style === null)) {
    throw new TypeError("style must be an object");
  }
  assertFiniteFields(patch);
}

function assertFiniteFields(label: TextStoreLabelPatch): void {
  assertFiniteField("x", label.x);
  assertFiniteField("y", label.y);
  assertFiniteField("scaleX", label.scaleX);
  assertFiniteField("scaleY", label.scaleY);
  assertFiniteField("rotation", label.rotation);
  assertFiniteField("alpha", label.alpha);
  assertFiniteField("anchorX", label.anchorX);
  assertFiniteField("anchorY", label.anchorY);
}

function assertFiniteField(name: string, value: number | undefined): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function freezeStyle(style: Readonly<TextStoreLabel["style"]>): Readonly<TextStoreLabel["style"]> {
  if (Object.isFrozen(style)) {
    return style;
  }

  return Object.freeze({ ...style });
}

function growTypedArray<T extends Uint8Array | Uint32Array | Float32Array>(
  source: T,
  capacity: number,
): T {
  const target = (
    source instanceof Uint8Array
      ? new Uint8Array(capacity)
      : source instanceof Uint32Array
        ? new Uint32Array(capacity)
        : new Float32Array(capacity)
  ) as T;
  target.set(source);

  return target;
}

function resizeTypedArray<T extends Uint8Array | Uint32Array | Float32Array>(
  source: T,
  capacity: number,
): T {
  const target = (
    source instanceof Uint8Array
      ? new Uint8Array(capacity)
      : source instanceof Uint32Array
        ? new Uint32Array(capacity)
        : new Float32Array(capacity)
  ) as T;
  target.set(source.subarray(0, capacity));

  return target;
}
