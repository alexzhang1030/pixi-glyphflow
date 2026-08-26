import { packF16, unpackF16 } from "../render/pack";
import type { TextId } from "../types";
import { assertBlendMode, decodeBlendMode, encodeBlendMode } from "./blendModes";
import {
  DirtyJournal,
  type DirtySlotVisitor,
  type PendingDirty,
  type PublishedDirty,
} from "./DirtyJournal";
import {
  TextDirty,
  type TextDirtyMask,
  type MutableTextStoreLabel,
  type TextStoreLabel,
  type TextStoreLabelPatch,
  type TextStoreCompaction,
  type TextStoreSnapshot,
  type TextStoreStats,
} from "./types";

const SLOT_RADIX = 0x100_0000;
const NAMESPACE_RADIX = 0x2_0000_0000;
const MAX_GENERATION = 0x1ff;
const MAX_SOURCE_REVISION = 0xffff_ffff;
const MAX_NAMESPACE = 0xf_ffff;
const MAX_CAPACITY = 0x100_0000;
const DEFAULT_CAPACITY = 16;
const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;
const POSITION_ONLY = 1;
const FULL_TRANSFORM = 2;
const FLAG_OCCUPIED = 1;
const FLAG_VISIBLE = 2;
const FLAG_KIND_SHIFT = 2;
const FLAG_KIND_MASK = 3;
const EMPTY_STYLE: Readonly<TextStoreLabel["style"]> = Object.freeze({});
const F16_ONE = packF16(1);
const F16_ZERO = packF16(0);
const BLEND_NORMAL = encodeBlendMode("normal");
let nextNamespace = 1;

export interface TextStoreOptions {
  readonly initialCapacity?: number;
}

export interface TextStoreColumnUpdateResult {
  readonly changed: number;
  readonly mask: TextDirtyMask;
}

export class TextStore {
  readonly #idBase: number;
  #capacity: number;
  #size = 0;
  #highWater = 0;
  #generations: Uint16Array;
  #flags: Uint8Array;
  #sourceRevisions: Uint32Array;
  #x: Float32Array;
  #y: Float32Array;
  #scaleX: Uint16Array;
  #scaleY: Uint16Array;
  #rotation: Uint16Array;
  #zIndex: Float32Array;
  #blendModes: Uint8Array;
  #alpha: Uint16Array;
  #anchorX: Uint16Array;
  #anchorY: Uint16Array;
  #texts: Array<string | undefined>;
  #styles: Array<Readonly<TextStoreLabel["style"]> | undefined>;
  readonly #styleIntern = new Map<string, Readonly<TextStoreLabel["style"]>>();
  #lastStyle: Readonly<TextStoreLabel["style"]> | undefined;
  #lastStyleKey: string | undefined;
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
    this.#generations = new Uint16Array(this.#capacity);
    this.#flags = new Uint8Array(this.#capacity);
    this.#sourceRevisions = new Uint32Array(this.#capacity);
    this.#x = new Float32Array(this.#capacity);
    this.#y = new Float32Array(this.#capacity);
    this.#scaleX = new Uint16Array(this.#capacity);
    this.#scaleY = new Uint16Array(this.#capacity);
    this.#rotation = new Uint16Array(this.#capacity);
    this.#zIndex = new Float32Array(this.#capacity);
    this.#blendModes = new Uint8Array(this.#capacity);
    this.#alpha = new Uint16Array(this.#capacity);
    this.#anchorX = new Uint16Array(this.#capacity);
    this.#anchorY = new Uint16Array(this.#capacity);
    this.#texts = Array.from({ length: this.#capacity }, () => undefined);
    this.#styles = Array.from({ length: this.#capacity }, () => undefined);
    this.#journal = new DirtyJournal(DEFAULT_CAPACITY);
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
      this.#flags.byteLength +
      this.#sourceRevisions.byteLength +
      this.#x.byteLength +
      this.#y.byteLength +
      this.#scaleX.byteLength +
      this.#scaleY.byteLength +
      this.#rotation.byteLength +
      this.#zIndex.byteLength +
      this.#blendModes.byteLength +
      this.#alpha.byteLength +
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
    this.#flags[slot] = FLAG_OCCUPIED;
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

    return this.#snapshot(slot, id, true);
  }

  /** Return the current slot for a layer-local identity. @internal */
  slotOf(id: TextId): number | undefined {
    return this.#resolveSlot(id);
  }

  /** Layer-local identity for an occupied dense slot. @internal */
  idAt(slot: number): TextId | undefined {
    if (slot >= this.#highWater || !this.#occupied(slot)) return undefined;
    const generation = this.#generations[slot] ?? 1;
    return (this.#idBase + generation * SLOT_RADIX + slot) as TextId;
  }

  /** Occupied slot text without a snapshot. @internal */
  textAt(slot: number): string | undefined {
    if (slot >= this.#highWater || !this.#occupied(slot)) return undefined;
    return this.#texts[slot];
  }

  /** Occupied slot interned style without a snapshot. @internal */
  styleAt(slot: number): Readonly<TextStoreLabel["style"]> | undefined {
    if (slot >= this.#highWater || !this.#occupied(slot)) return undefined;
    return this.#styles[slot];
  }

  /** True when both anchors decode to zero. @internal */
  anchorsZeroAt(slot: number): boolean {
    return (
      slot < this.#highWater &&
      this.#occupied(slot) &&
      this.#anchorX[slot] === F16_ZERO &&
      this.#anchorY[slot] === F16_ZERO
    );
  }

  /** True when scale is 1 and rotation is 0. @internal */
  unitTransformAt(slot: number): boolean {
    return (
      slot < this.#highWater &&
      this.#occupied(slot) &&
      this.#scaleX[slot] === F16_ONE &&
      this.#scaleY[slot] === F16_ONE &&
      this.#rotation[slot] === F16_ZERO
    );
  }

  /**
   * First-seen / fill-only admit: visible, z 0, normal blend, alpha 1, unit transform, zero
   * anchors, no stroke or drop shadow.
   *
   * @internal
   */
  admitLaneAt(slot: number): boolean {
    if (slot >= this.#highWater || !this.#occupied(slot)) return false;
    if (!this.#visible(slot) || (this.#zIndex[slot] ?? 0) !== 0) return false;
    if ((this.#blendModes[slot] ?? 0) !== BLEND_NORMAL) return false;
    if (this.#alpha[slot] !== F16_ONE) return false;
    if (this.#anchorX[slot] !== F16_ZERO || this.#anchorY[slot] !== F16_ZERO) return false;
    if (
      this.#scaleX[slot] !== F16_ONE ||
      this.#scaleY[slot] !== F16_ONE ||
      this.#rotation[slot] !== F16_ZERO
    ) {
      return false;
    }
    const style = this.#styles[slot];
    return style !== undefined && style.stroke === undefined && style.dropShadow === undefined;
  }

  /** Read the current label occupying a dense slot. @internal */
  snapshotAt(slot: number): Readonly<TextStoreSnapshot> | undefined {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new TypeError("TextStore slot must be a non-negative safe integer");
    }
    if (slot >= this.#highWater || !this.#occupied(slot)) {
      return undefined;
    }
    const generation = this.#generations[slot] ?? 1;
    const id = (this.#idBase + generation * SLOT_RADIX + slot) as TextId;

    return this.#snapshot(slot, id, false);
  }

  #snapshot(slot: number, id: TextId, freeze: boolean): Readonly<TextStoreSnapshot> {
    const text = this.#texts[slot];
    const style = this.#styles[slot];
    if (text === undefined || style === undefined) {
      throw new Error("TextStore invariant violation: occupied slot is incomplete");
    }

    const snapshot = {
      id,
      sourceRevision: this.#sourceRevisions[slot] ?? 1,
      text,
      x: this.#x[slot] ?? 0,
      y: this.#y[slot] ?? 0,
      scaleX: readF16(this.#scaleX, slot),
      scaleY: readF16(this.#scaleY, slot),
      rotation: readF16(this.#rotation, slot),
      zIndex: this.#zIndex[slot] ?? 0,
      blendMode: decodeBlendMode(this.#blendModes[slot] ?? 1),
      alpha: readF16(this.#alpha, slot),
      visible: this.#visible(slot),
      anchorX: readF16(this.#anchorX, slot),
      anchorY: readF16(this.#anchorY, slot),
      style,
    };
    return freeze ? Object.freeze(snapshot) : snapshot;
  }

  has(id: TextId): boolean {
    return this.#resolveSlot(id) !== undefined;
  }

  /** Report whether a dense slot currently holds a label without building a snapshot. @internal */
  occupiedAt(slot: number): boolean {
    return slot < this.#highWater && this.#occupied(slot);
  }

  /** Copy x/y columns for a slot list into packed pairs without snapshots. @internal */
  positionsInto(slots: Uint32Array, count: number, xy: Float32Array): void {
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      xy[index * 2] = this.#x[slot] ?? 0;
      xy[index * 2 + 1] = this.#y[slot] ?? 0;
    }
  }

  update(id: TextId, patch: TextStoreLabelPatch): TextDirtyMask {
    assertPatch(patch);
    const slot = this.#requireSlot(id);

    return this.updateAt(slot, patch);
  }

  /** Apply an already-validated patch to a current dense slot. @internal */
  updateAt(slot: number, patch: TextStoreLabelPatch): TextDirtyMask {
    let dirty = TextDirty.None as TextDirtyMask;
    let transformKind = 0;

    if (patch.text !== undefined && patch.text !== this.#texts[slot]) {
      this.#texts[slot] = patch.text;
      dirty |= TextDirty.Content;
    }
    if (patch.x !== undefined && patch.x !== this.#x[slot]) {
      this.#x[slot] = patch.x;
      dirty |= TextDirty.Transform;
      transformKind |= POSITION_ONLY;
    }
    if (patch.y !== undefined && patch.y !== this.#y[slot]) {
      this.#y[slot] = patch.y;
      dirty |= TextDirty.Transform;
      transformKind |= POSITION_ONLY;
    }
    if (patch.scaleX !== undefined && writeF16(this.#scaleX, slot, patch.scaleX)) {
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.scaleY !== undefined && writeF16(this.#scaleY, slot, patch.scaleY)) {
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.rotation !== undefined && writeF16(this.#rotation, slot, patch.rotation)) {
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.zIndex !== undefined && patch.zIndex !== this.#zIndex[slot]) {
      this.#zIndex[slot] = patch.zIndex;
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (
      patch.blendMode !== undefined &&
      encodeBlendMode(patch.blendMode) !== this.#blendModes[slot]
    ) {
      this.#blendModes[slot] = encodeBlendMode(patch.blendMode);
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.alpha !== undefined && writeF16(this.#alpha, slot, patch.alpha)) {
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.visible !== undefined && patch.visible !== this.#visible(slot)) {
      this.#setVisible(slot, patch.visible);
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.anchorX !== undefined && writeF16(this.#anchorX, slot, patch.anchorX)) {
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.anchorY !== undefined && writeF16(this.#anchorY, slot, patch.anchorY)) {
      dirty |= TextDirty.Transform;
      transformKind |= FULL_TRANSFORM;
    }
    if (patch.style !== undefined) {
      const interned = this.#internStyle(patch.style);
      if (interned !== this.#styles[slot]) {
        this.#styles[slot] = interned;
        dirty |= TextDirty.Style;
      }
    }
    this.#markTransformKind(slot, transformKind);

    if ((dirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
      const revision = this.#sourceRevisions[slot] ?? 0;
      if (revision === MAX_SOURCE_REVISION) {
        throw new RangeError("Text label source revision exhausted");
      }
      this.#sourceRevisions[slot] = revision + 1;
    }
    if (dirty !== TextDirty.None) {
      this.#journal.record(slot, dirty);
    }

    return dirty;
  }

  /** Set visibility for every occupied slot through one columnar pass. @internal */
  setAllVisible(visible: boolean): number {
    if (typeof visible !== "boolean") {
      throw new TypeError("visible must be a boolean");
    }
    let changed = 0;
    for (let slot = 0; slot < this.#highWater; slot += 1) {
      if (!this.#occupied(slot) || this.#visible(slot) === visible) continue;
      this.#setVisible(slot, visible);
      this.#markTransformKind(slot, FULL_TRANSFORM);
      this.#journal.record(slot, TextDirty.Transform);
      changed += 1;
    }

    return changed;
  }

  /** Copy spatial-bound inputs into caller-owned scratch storage. @internal */
  copyBoundsLabelAt(slot: number, output: MutableTextStoreLabel): boolean {
    if (slot >= this.#highWater || !this.#occupied(slot)) return false;
    const text = this.#texts[slot];
    const style = this.#styles[slot];
    if (text === undefined || style === undefined) {
      throw new Error("TextStore invariant violation: occupied slot is incomplete");
    }
    output.text = text;
    output.x = this.#x[slot] ?? 0;
    output.y = this.#y[slot] ?? 0;
    output.scaleX = readF16(this.#scaleX, slot);
    output.scaleY = readF16(this.#scaleY, slot);
    output.rotation = readF16(this.#rotation, slot);
    output.zIndex = this.#zIndex[slot] ?? 0;
    output.visible = this.#visible(slot);
    output.anchorX = readF16(this.#anchorX, slot);
    output.anchorY = readF16(this.#anchorY, slot);
    output.style = style;

    return true;
  }

  updatePositions(
    ids: readonly TextId[] | Float64Array,
    positions: Float32Array | Float64Array,
    visitor?: (slot: number, x: number, y: number, previousX: number, previousY: number) => void,
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
      const previousX = this.#x[slot] ?? 0;
      const previousY = this.#y[slot] ?? 0;
      if (x === previousX && y === previousY) {
        continue;
      }

      this.#x[slot] = x;
      this.#y[slot] = y;
      this.#markTransformKind(slot, POSITION_ONLY);
      this.#journal.record(slot, TextDirty.Transform);
      visitor?.(slot, x, y, previousX, previousY);
      changed += 1;
    }

    return changed;
  }

  /** Apply one text value plus packed x/y columns through a single validation pass. @internal */
  updateTextPositions(
    ids: readonly TextId[] | Float64Array,
    texts: string | readonly string[],
    positions: Float32Array | Float64Array,
    visitor?: (
      slot: number,
      index: number,
      contentChanged: boolean,
      previousX: number,
      previousY: number,
    ) => void,
  ): Readonly<TextStoreColumnUpdateResult> {
    if (positions.length !== ids.length * 2) {
      throw new TypeError("positions must contain one packed x/y pair for every TextId");
    }
    if (typeof texts !== "string" && texts.length !== ids.length) {
      throw new TypeError("texts must contain one string for every TextId");
    }
    if (this.#positionSlots.length < ids.length) {
      this.#positionSlots = new Uint32Array(nextPowerOfTwo(ids.length));
    }
    const slots = this.#positionSlots;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) throw new TypeError(`Missing TextId at index ${String(index)}`);
      const slot = this.#requireSlot(id as TextId);
      const text = typeof texts === "string" ? texts : texts[index];
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      if (typeof text !== "string") {
        throw new TypeError(`Text at index ${String(index)} must be a string`);
      }
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError(`Position at index ${String(index)} must contain finite x/y values`);
      }
      if (text !== this.#texts[slot] && this.#sourceRevisions[slot] === MAX_SOURCE_REVISION) {
        throw new RangeError("Text label source revision exhausted");
      }
      slots[index] = slot;
    }

    let changed = 0;
    let mask = TextDirty.None as TextDirtyMask;
    for (let index = 0; index < ids.length; index += 1) {
      const slot = slots[index];
      if (slot === undefined) {
        throw new Error(`TextStore column slot missing at index ${String(index)}`);
      }
      const text = typeof texts === "string" ? texts : (texts[index] ?? "");
      const x = Math.fround(positions[index * 2] ?? 0);
      const y = Math.fround(positions[index * 2 + 1] ?? 0);
      const previousX = this.#x[slot] ?? 0;
      const previousY = this.#y[slot] ?? 0;
      const contentChanged = text !== this.#texts[slot];
      const transformChanged = x !== previousX || y !== previousY;
      if (!contentChanged && !transformChanged) continue;
      let dirty = TextDirty.None as TextDirtyMask;
      if (contentChanged) {
        this.#texts[slot] = text;
        this.#sourceRevisions[slot] = (this.#sourceRevisions[slot] ?? 0) + 1;
        dirty |= TextDirty.Content;
      }
      if (transformChanged) {
        this.#x[slot] = x;
        this.#y[slot] = y;
        dirty |= TextDirty.Transform;
        this.#markTransformKind(slot, POSITION_ONLY);
      }
      this.#journal.record(slot, dirty);
      visitor?.(slot, index, contentChanged, previousX, previousY);
      changed += 1;
      mask |= dirty;
    }

    return Object.freeze({ changed, mask });
  }

  remove(id: TextId): boolean {
    const slot = this.#resolveSlot(id);
    if (slot === undefined) {
      return false;
    }

    this.#flags[slot] = 0;
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
      if (this.#occupied(slot)) {
        this.#flags[slot] = 0;
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
    if ((mask & TextDirty.Transform) !== 0) {
      this.#markTransformKind(slot, FULL_TRANSFORM);
    }
    this.#journal.record(slot, mask);
  }

  /** True when this epoch's transform dirty is only x/y. Consuming clears the flag. @internal */
  consumePositionOnly(slot: number): boolean {
    const value = this.#transformKind(slot) === POSITION_ONLY;
    this.#setTransformKind(slot, 0);
    return value;
  }

  /** Advance source identity and publish a source-affecting dirty domain. @internal */
  markSourceDirty(id: TextId, mask: TextDirtyMask): void {
    const slot = this.#requireSlot(id);
    if (
      !Number.isSafeInteger(mask) ||
      mask <= TextDirty.None ||
      (mask & ~(TextDirty.Content | TextDirty.Style)) !== 0
    ) {
      throw new TypeError("Source dirty mask must contain content or style domains");
    }
    const revision = this.#sourceRevisions[slot] ?? 0;
    if (revision === MAX_SOURCE_REVISION) {
      throw new RangeError("Text label source revision exhausted");
    }
    this.#sourceRevisions[slot] = revision + 1;
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
      if (this.#occupied(slot)) {
        if ((mask & TextDirty.Transform) !== 0) {
          this.#markTransformKind(slot, FULL_TRANSFORM);
        }
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
      this.#flags = resizeTypedArray(this.#flags, afterCapacity);
      this.#sourceRevisions = resizeTypedArray(this.#sourceRevisions, afterCapacity);
      this.#x = resizeTypedArray(this.#x, afterCapacity);
      this.#y = resizeTypedArray(this.#y, afterCapacity);
      this.#scaleX = resizeTypedArray(this.#scaleX, afterCapacity);
      this.#scaleY = resizeTypedArray(this.#scaleY, afterCapacity);
      this.#rotation = resizeTypedArray(this.#rotation, afterCapacity);
      this.#zIndex = resizeTypedArray(this.#zIndex, afterCapacity);
      this.#blendModes = resizeTypedArray(this.#blendModes, afterCapacity);
      this.#alpha = resizeTypedArray(this.#alpha, afterCapacity);
      this.#anchorX = resizeTypedArray(this.#anchorX, afterCapacity);
      this.#anchorY = resizeTypedArray(this.#anchorY, afterCapacity);
      this.#texts.length = afterCapacity;
      this.#styles.length = afterCapacity;
      if (this.#journal.capacity > afterCapacity) {
        this.#journal.resize(afterCapacity);
      }
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
    this.#generations = new Uint16Array();
    this.#flags = new Uint8Array();
    this.#sourceRevisions = new Uint32Array();
    this.#x = new Float32Array();
    this.#y = new Float32Array();
    this.#scaleX = new Uint16Array();
    this.#scaleY = new Uint16Array();
    this.#rotation = new Uint16Array();
    this.#zIndex = new Float32Array();
    this.#blendModes = new Uint8Array();
    this.#alpha = new Uint16Array();
    this.#anchorX = new Uint16Array();
    this.#anchorY = new Uint16Array();
    this.#texts = [];
    this.#styles = [];
    this.#styleIntern.clear();
    this.#lastStyle = undefined;
    this.#lastStyleKey = undefined;
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
    this.#flags = growTypedArray(this.#flags, capacity);
    this.#sourceRevisions = growTypedArray(this.#sourceRevisions, capacity);
    this.#x = growTypedArray(this.#x, capacity);
    this.#y = growTypedArray(this.#y, capacity);
    this.#scaleX = growTypedArray(this.#scaleX, capacity);
    this.#scaleY = growTypedArray(this.#scaleY, capacity);
    this.#rotation = growTypedArray(this.#rotation, capacity);
    this.#zIndex = growTypedArray(this.#zIndex, capacity);
    this.#blendModes = growTypedArray(this.#blendModes, capacity);
    this.#alpha = growTypedArray(this.#alpha, capacity);
    this.#anchorX = growTypedArray(this.#anchorX, capacity);
    this.#anchorY = growTypedArray(this.#anchorY, capacity);
    this.#texts.length = capacity;
    this.#styles.length = capacity;
    this.#capacity = capacity;
  }

  #write(slot: number, label: TextStoreLabel): void {
    this.#texts[slot] = label.text;
    this.#x[slot] = label.x;
    this.#y[slot] = label.y;
    writeF16(this.#scaleX, slot, label.scaleX);
    writeF16(this.#scaleY, slot, label.scaleY);
    writeF16(this.#rotation, slot, label.rotation);
    this.#zIndex[slot] = label.zIndex;
    this.#blendModes[slot] = encodeBlendMode(label.blendMode);
    writeF16(this.#alpha, slot, label.alpha);
    this.#setVisible(slot, label.visible);
    writeF16(this.#anchorX, slot, label.anchorX);
    writeF16(this.#anchorY, slot, label.anchorY);
    this.#styles[slot] = this.#internStyle(label.style);
  }

  #markTransformKind(slot: number, kind: number): void {
    if (kind === 0) return;
    if (kind === POSITION_ONLY && this.#transformKind(slot) !== FULL_TRANSFORM) {
      this.#setTransformKind(slot, POSITION_ONLY);
      return;
    }
    this.#setTransformKind(slot, FULL_TRANSFORM);
  }

  #occupied(slot: number): boolean {
    return ((this.#flags[slot] ?? 0) & FLAG_OCCUPIED) !== 0;
  }

  #visible(slot: number): boolean {
    return ((this.#flags[slot] ?? 0) & FLAG_VISIBLE) !== 0;
  }

  #setVisible(slot: number, visible: boolean): void {
    const flags = this.#flags[slot] ?? 0;
    this.#flags[slot] = visible ? flags | FLAG_VISIBLE : flags & ~FLAG_VISIBLE;
  }

  #transformKind(slot: number): number {
    return ((this.#flags[slot] ?? 0) >> FLAG_KIND_SHIFT) & FLAG_KIND_MASK;
  }

  #setTransformKind(slot: number, kind: number): void {
    const flags = this.#flags[slot] ?? 0;
    this.#flags[slot] = (flags & ~(FLAG_KIND_MASK << FLAG_KIND_SHIFT)) | (kind << FLAG_KIND_SHIFT);
  }

  #internStyle(style: Readonly<TextStoreLabel["style"]>): Readonly<TextStoreLabel["style"]> {
    if (isEmptyStyle(style)) return EMPTY_STYLE;
    if (style === this.#lastStyle) return style;
    const key = styleInternKey(style);
    if (key === this.#lastStyleKey && this.#lastStyle !== undefined) return this.#lastStyle;
    const existing = this.#styleIntern.get(key);
    if (existing !== undefined) {
      this.#lastStyle = existing;
      this.#lastStyleKey = key;
      return existing;
    }
    const frozen = Object.isFrozen(style) ? style : Object.freeze({ ...style });
    this.#styleIntern.set(key, frozen);
    this.#lastStyle = frozen;
    this.#lastStyleKey = key;
    return frozen;
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
      !this.#occupied(slot) ||
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
  assertBlendMode(label.blendMode);
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
  if (patch.blendMode !== undefined) assertBlendMode(patch.blendMode);
  assertFiniteFields(patch);
}

function assertFiniteFields(label: TextStoreLabelPatch): void {
  assertFiniteField("x", label.x);
  assertFiniteField("y", label.y);
  assertFiniteField("scaleX", label.scaleX);
  assertFiniteField("scaleY", label.scaleY);
  assertFiniteField("rotation", label.rotation);
  assertFiniteField("zIndex", label.zIndex);
  assertFiniteField("alpha", label.alpha);
  assertFiniteField("anchorX", label.anchorX);
  assertFiniteField("anchorY", label.anchorY);
}

function assertFiniteField(name: string, value: number | undefined): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function isEmptyStyle(style: Readonly<TextStoreLabel["style"]>): boolean {
  for (const _key in style) return false;
  return true;
}

function styleInternKey(style: Readonly<TextStoreLabel["style"]>): string {
  try {
    const keys = Object.keys(style).sort();
    if (keys.length === 0) return "";
    const ordered: Record<string, unknown> = {};
    for (const key of keys) {
      ordered[key] = (style as Record<string, unknown>)[key];
    }
    return JSON.stringify(ordered);
  } catch {
    return `\0${String(++styleKeyFallback)}`;
  }
}

let styleKeyFallback = 0;

function readF16(column: Uint16Array, slot: number): number {
  return unpackF16(column[slot] ?? 0);
}

function writeF16(column: Uint16Array, slot: number, value: number): boolean {
  const packed = packF16(value);
  if (column[slot] === packed) return false;
  column[slot] = packed;
  return true;
}

function growTypedArray<
  T extends Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array,
>(source: T, capacity: number): T {
  const target = allocateTypedArray(source, capacity);
  target.set(source);

  return target;
}

function resizeTypedArray<
  T extends Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array,
>(source: T, capacity: number): T {
  const target = allocateTypedArray(source, capacity);
  target.set(source.subarray(0, capacity));

  return target;
}

function allocateTypedArray<
  T extends Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array,
>(source: T, capacity: number): T {
  return (
    source instanceof Uint8Array
      ? new Uint8Array(capacity)
      : source instanceof Uint16Array
        ? new Uint16Array(capacity)
        : source instanceof Uint32Array
          ? new Uint32Array(capacity)
          : source instanceof Float64Array
            ? new Float64Array(capacity)
            : new Float32Array(capacity)
  ) as T;
}
