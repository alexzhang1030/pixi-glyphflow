import type { BLEND_MODES } from "pixi.js";

import {
  CULL_RECORD_STRIDE,
  type CullRecordDirty,
  type CullViewport,
} from "../culling/computeCull";
import { DIRTY_MAX_RANGES, DirtyRanges } from "./DirtyRanges";
import { packF16, unpackF16 } from "./pack";
import {
  PALETTE_DENSE_MOVE_STRIDE,
  PALETTE_DENSE_MOVE_WORDS,
  PALETTE_MOVE_STRIDE,
  PALETTE_MOVE_WORDS,
  PALETTE_DENSE_TRANSFORM_MOVE_STRIDE,
  PALETTE_DENSE_TRANSFORM_MOVE_WORDS,
  PALETTE_INDEXED_TRANSFORM_MOVE_STRIDE,
  PALETTE_INDEXED_TRANSFORM_MOVE_WORDS,
  packResidentRotation,
  paletteMoveUploadBytes,
  writeResidentRotatedAabbF32,
  type PaletteMoveUpload,
} from "./paletteStorage";

export const GPU_RESIDENT_RECORD_STRIDE: number = CULL_RECORD_STRIDE;

const WORDS_PER_RECORD = GPU_RESIDENT_RECORD_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
const DEFAULT_CAPACITY = 1_024;
const DEFAULT_MAX_CAPACITY = 0x100_0000;

/** @internal Typed group accepted by the fixed-slot GPU-resident scene. */
export interface GpuResidentAdmitColumn {
  readonly slots: Uint32Array;
  readonly count: number;
  readonly xy: Float32Array;
  /** Decoded binary16 label rotations; omitted columns use zero rotation. */
  readonly rotations?: Float32Array;
  readonly orders: Uint32Array;
  /** Shared local x, y, width, height for every slot in this prototype column. */
  readonly localBounds: Float32Array;
  readonly prototypeId: number;
  readonly instanceOffset: number;
  readonly instanceCount: number;
  readonly zIndex: number;
  readonly blendMode: BLEND_MODES;
}

/** @internal Structurally compatible with RenderComputeCullUpdate. */
export interface GpuResidentCullUpdate {
  readonly records: ArrayBuffer;
  readonly recordCount: number;
  /** Conservative compact-output capacity: every glyph referenced by every active record. */
  readonly drawInstanceCount: number;
  readonly recordDirty: CullRecordDirty;
  /** Shared x, y, width, height entries addressed by record word 7. */
  readonly localBounds: Float32Array;
  readonly localBoundsCount: number;
  readonly localBoundsDirty: "all" | "none";
  readonly viewport: CullViewport;
}

/** @internal A mover wave patches palette origins and resident AABBs in one GPU pass. */
export interface GpuResidentPositionUpdate {
  readonly paletteMoves: Readonly<PaletteMoveUpload>;
  readonly recordDirty: "none";
}

export interface GpuResidentSceneOptions {
  readonly initialCapacity?: number;
  readonly maxCapacity?: number;
}

export interface GpuResidentSceneStats {
  readonly activeLabels: number;
  readonly activeGlyphInstances: number;
  readonly recordCount: number;
  readonly recordBytes: number;
  readonly allocatedBytes: number;
  readonly prototypeCount: number;
  readonly tombstones: number;
  readonly pendingSpatialMoves: number;
  readonly repackSignals: number;
  /** Structural invariant: residency uses typed columns and prototype-level maps. */
  readonly perLabelObjectCount: 0;
}

/**
 * @internal CPU setup and lifecycle owner for fixed-slot GPU-resident cull records.
 *
 * Record index equals label slot. A prototype column writes palette rows for every label while
 * keeping one glyph-instance range. Position waves stay GPU-owned and retain a deferred CPU
 * spatial journal for query and hit-test convergence.
 */
export class GpuResidentScene {
  readonly #initialCapacity: number;
  readonly #maxCapacity: number;
  readonly #prototypeRefs = new Map<number, number>();
  readonly #prototypeBoundsIndex = new Map<number, number>();
  readonly #dirty = new DirtyRanges();
  #records = new ArrayBuffer(0);
  #recordFloats = new Float32Array(0);
  #recordUints = new Uint32Array(0);
  #occupied = new Uint8Array(0);
  #originX: Float32Array<ArrayBufferLike> = new Float32Array(0);
  #originY: Float32Array<ArrayBufferLike> = new Float32Array(0);
  #originsExternal = false;
  #rotations: Uint16Array<ArrayBufferLike> = new Uint16Array(0);
  #rotationsExternal = false;
  #orders = new Uint32Array(0);
  #prototypeIds = new Uint32Array(0);
  #prototypeBounds = new Float32Array(0);
  #prototypeBoundsCount = 0;
  #localBoundsDirty = false;
  #movedFlags = new Uint8Array(0);
  #movedSlots = new Uint32Array(0);
  #spatialXy = new Float32Array(0);
  #moveCommands = new ArrayBuffer(0);
  #pendingSpatialMoves = 0;
  #recordsNeedReconcile = false;
  #capacity = 0;
  #recordCount = 0;
  #activeLabels = 0;
  #activeGlyphInstances = 0;
  #tombstones = 0;
  #dirtyAll = false;
  #lastOrder = -1;
  #repackRequired = false;
  #repackSignals = 0;
  #destroyed = false;

  constructor(options: GpuResidentSceneOptions = {}) {
    this.#initialCapacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    this.#maxCapacity = options.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    assertCapacity("initialCapacity", this.#initialCapacity);
    assertCapacity("maxCapacity", this.#maxCapacity);
    if (this.#initialCapacity > this.#maxCapacity) {
      throw new RangeError("GPU resident initialCapacity exceeds maxCapacity");
    }
  }

  setup(column: Readonly<GpuResidentAdmitColumn>): void {
    this.setupMany([column]);
  }

  setupMany(columns: readonly Readonly<GpuResidentAdmitColumn>[]): void {
    this.#assertActive();
    const inspection = inspectColumnUnion(
      columns,
      0,
      -1,
      this.#maxCapacity,
      "GPU resident setup exceeds maxCapacity",
    );
    if (inspection === undefined) {
      throw new TypeError("GPU resident setup requires columns whose union is exactly dense");
    }
    this.#assertPrototypeBounds(columns, false);
    const highWater = inspection.recordEnd;
    const capacity = Math.max(this.#initialCapacity, highWater);
    if (capacity > this.#maxCapacity) {
      throw new RangeError("GPU resident setup exceeds maxCapacity");
    }
    this.#allocate(capacity);
    this.#prototypeRefs.clear();
    this.#prototypeBoundsIndex.clear();
    this.#prototypeBoundsCount = 0;
    this.#localBoundsDirty = false;
    this.#recordCount = highWater;
    this.#activeLabels = 0;
    this.#activeGlyphInstances = 0;
    this.#tombstones = 0;
    this.#repackSignals = 0;
    this.#repackRequired = false;
    this.#pendingSpatialMoves = 0;
    this.#recordsNeedReconcile = false;
    this.#lastOrder = inspection.lastOrder;
    this.#dirty.clear();
    for (const column of columns) this.#writeColumn(column);
    this.#dirtyAll = inspection.recordCount > 0;
  }

  /** Alias the authoritative TextStore origins so mover intake writes x/y once. @internal */
  bindOriginColumns(originX: Float32Array, originY: Float32Array, rotations?: Uint16Array): void {
    this.#assertActive();
    if (!(originX instanceof Float32Array) || !(originY instanceof Float32Array)) {
      throw new TypeError("GPU resident origin columns must be Float32Array");
    }
    if (originX.length !== originY.length) {
      throw new TypeError("GPU resident origin columns must have the same length");
    }
    if (originX.length < this.#capacity) {
      throw new RangeError("GPU resident origin columns are shorter than scene capacity");
    }
    if (rotations !== undefined && rotations.length < this.#capacity) {
      throw new RangeError("GPU resident rotation column is shorter than scene capacity");
    }
    this.#originX = originX;
    this.#originY = originY;
    this.#originsExternal = true;
    if (rotations !== undefined) {
      this.#rotations = rotations;
      this.#rotationsExternal = true;
    }
  }

  append(column: Readonly<GpuResidentAdmitColumn>): boolean {
    return this.appendMany([column]);
  }

  appendMany(columns: readonly Readonly<GpuResidentAdmitColumn>[]): boolean {
    this.#assertActive();
    const inspection = inspectColumnUnion(
      columns,
      this.#recordCount,
      this.#lastOrder,
      this.#maxCapacity,
      "GPU resident append exceeds maxCapacity",
    );
    if (inspection === undefined) {
      this.#signalRepack();
      return false;
    }
    if (inspection.recordCount === 0) return true;
    if (this.#activeGlyphInstances + inspection.glyphInstances > 0xffff_ffff) {
      throw new RangeError("GPU resident draw instance count exceeds uint32 capacity");
    }
    this.#assertPrototypeBounds(columns, true);
    this.#ensureCapacity(inspection.recordEnd);
    for (const column of columns) this.#writeColumn(column);
    this.#recordCount = inspection.recordEnd;
    this.#lastOrder = inspection.lastOrder;
    if (!this.#dirtyAll) {
      for (const column of columns) {
        for (let index = 0; index < column.count; index += 1) {
          const slot = column.slots[index] ?? 0;
          this.#dirty.record(slot * GPU_RESIDENT_RECORD_STRIDE, GPU_RESIDENT_RECORD_STRIDE);
        }
      }
    }
    return true;
  }

  /** Replace existing slot bindings after text, wrap width, or writing-flow changes. */
  rebindMany(columns: readonly Readonly<GpuResidentAdmitColumn>[]): boolean {
    this.#assertActive();
    let count = 0;
    let removedGlyphs = 0;
    let addedGlyphs = 0;
    for (const column of columns) {
      validateColumn(column);
      if (column.zIndex !== 0 || column.blendMode !== "normal") {
        throw new TypeError("GPU resident rebind requires zero z-index and normal blending");
      }
      count += column.count;
      addedGlyphs += column.count * column.instanceCount;
      for (let index = 0; index < column.count; index += 1) {
        const slot = column.slots[index] ?? 0;
        if (
          slot >= this.#recordCount ||
          this.#occupied[slot] !== 1 ||
          column.orders[index] !== this.#orders[slot]
        ) {
          this.#repackRequired = true;
          return false;
        }
        removedGlyphs += this.#recordUints[slot * WORDS_PER_RECORD + 5] ?? 0;
      }
    }
    const slots = new Uint32Array(count);
    let offset = 0;
    for (const column of columns) {
      slots.set(column.slots.subarray(0, column.count), offset);
      offset += column.count;
    }
    slots.sort();
    for (let index = 1; index < slots.length; index += 1) {
      if (slots[index] === slots[index - 1]) {
        throw new TypeError("GPU resident rebind contains duplicate slots");
      }
    }
    const nextGlyphs = this.#activeGlyphInstances - removedGlyphs + addedGlyphs;
    if (!Number.isSafeInteger(nextGlyphs) || nextGlyphs > 0xffff_ffff) {
      throw new RangeError("GPU resident draw instance count exceeds uint32 capacity");
    }
    this.#assertPrototypeBounds(columns, true);
    for (const slot of slots) {
      this.#activeGlyphInstances -= this.#recordUints[slot * WORDS_PER_RECORD + 5] ?? 0;
      this.#activeLabels -= 1;
      this.#releasePrototypeRef(this.#prototypeIds[slot] ?? 0);
    }
    for (const column of columns) this.#writeColumn(column);
    for (const slot of slots) {
      this.#dirty.record(slot * GPU_RESIDENT_RECORD_STRIDE, GPU_RESIDENT_RECORD_STRIDE);
    }
    return true;
  }

  referencedGlyphCount(slots: Uint32Array, count: number): number {
    this.#assertActive();
    let glyphs = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot < this.#recordCount && this.#occupied[slot] === 1) {
        glyphs += this.#recordUints[slot * WORDS_PER_RECORD + 5] ?? 0;
      }
    }
    return glyphs;
  }

  remove(slots: Uint32Array, count: number): number {
    this.#assertActive();
    validateSlots(slots, count, "remove");
    let removed = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot >= this.#capacity || this.#occupied[slot] !== 1) continue;
      const base = slot * WORDS_PER_RECORD;
      this.#occupied[slot] = 0;
      this.#activeGlyphInstances -= this.#recordUints[base + 5] ?? 0;
      this.#recordUints[base + 5] = 0;
      this.#activeLabels -= 1;
      this.#tombstones += 1;
      const prototypeId = this.#prototypeIds[slot] ?? 0;
      this.#releasePrototypeRef(prototypeId);
      this.#dirty.record(slot * GPU_RESIDENT_RECORD_STRIDE, GPU_RESIDENT_RECORD_STRIDE);
      removed += 1;
    }
    return removed;
  }

  updatePositions(
    slots: Uint32Array,
    count: number,
    xy: Float32Array,
  ): Readonly<GpuResidentPositionUpdate> {
    this.#assertActive();
    validatePositionColumns(slots, count, xy);
    let dense = count > 0;
    const baseSlot = slots[0] ?? 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      const x = Math.fround(xy[index * 2] ?? 0);
      const y = Math.fround(xy[index * 2 + 1] ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError("GPU resident position values must be finite");
      }
      if (slot >= this.#capacity || this.#occupied[slot] !== 1 || slot !== baseSlot + index) {
        dense = false;
      }
    }
    const commandBytes = count * (dense ? PALETTE_DENSE_MOVE_STRIDE : PALETTE_MOVE_STRIDE);
    if (this.#moveCommands.byteLength !== commandBytes) {
      this.#moveCommands = new ArrayBuffer(commandBytes);
    }
    const commandUints = new Uint32Array(this.#moveCommands);
    const commandFloats = new Float32Array(this.#moveCommands);
    this.reservePositionNotes(count);
    let written = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot >= this.#capacity || this.#occupied[slot] !== 1) continue;
      const x = Math.fround(xy[index * 2] ?? 0);
      const y = Math.fround(xy[index * 2 + 1] ?? 0);
      const commandBase = written * (dense ? PALETTE_DENSE_MOVE_WORDS : PALETTE_MOVE_WORDS);
      if (dense) {
        commandFloats[commandBase] = x;
        commandFloats[commandBase + 1] = y;
      } else {
        commandUints[commandBase] = slot;
        commandFloats[commandBase + 1] = x;
        commandFloats[commandBase + 2] = y;
      }
      if (!this.#originsExternal) {
        this.#originX[slot] = x;
        this.#originY[slot] = y;
      }
      this.notePosition(slot);
      written += 1;
    }
    const paletteMoves: PaletteMoveUpload = dense
      ? { mode: "dense", baseSlot, commands: this.#moveCommands, count: written }
      : { mode: "indexed", commands: this.#moveCommands, count: written };
    return {
      paletteMoves,
      recordDirty: "none",
    };
  }

  /** Pack position and rotation changes while retaining prototype geometry and cull records. */
  updateTransforms(
    slots: Uint32Array,
    count: number,
    xy: Float32Array,
    rotations: Float32Array,
  ): Readonly<GpuResidentPositionUpdate> {
    this.#assertActive();
    validatePositionColumns(slots, count, xy);
    if (rotations.length < count) {
      throw new TypeError("GPU resident rotations are shorter than count");
    }
    let dense = count > 0;
    const baseSlot = slots[0] ?? 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (
        !Number.isFinite(xy[index * 2]) ||
        !Number.isFinite(xy[index * 2 + 1]) ||
        !Number.isFinite(rotations[index])
      ) {
        throw new TypeError("GPU resident transform values must be finite");
      }
      if (slot >= this.#capacity || this.#occupied[slot] !== 1 || slot !== baseSlot + index) {
        dense = false;
      }
    }
    const commandBytes =
      count * (dense ? PALETTE_DENSE_TRANSFORM_MOVE_STRIDE : PALETTE_INDEXED_TRANSFORM_MOVE_STRIDE);
    if (this.#moveCommands.byteLength !== commandBytes) {
      this.#moveCommands = new ArrayBuffer(commandBytes);
    }
    const commandUints = new Uint32Array(this.#moveCommands);
    const commandFloats = new Float32Array(this.#moveCommands);
    this.reservePositionNotes(count);
    let written = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot >= this.#capacity || this.#occupied[slot] !== 1) continue;
      const x = Math.fround(xy[index * 2] ?? 0);
      const y = Math.fround(xy[index * 2 + 1] ?? 0);
      const rotationBits = packF16(rotations[index] ?? 0);
      const packedRotation = packResidentRotation(unpackF16(rotationBits));
      const base =
        written *
        (dense ? PALETTE_DENSE_TRANSFORM_MOVE_WORDS : PALETTE_INDEXED_TRANSFORM_MOVE_WORDS);
      const offset = dense ? 0 : 1;
      if (!dense) commandUints[base] = slot;
      commandFloats[base + offset] = x;
      commandFloats[base + offset + 1] = y;
      commandUints[base + offset + 2] = packedRotation;
      if (!this.#originsExternal) {
        this.#originX[slot] = x;
        this.#originY[slot] = y;
      }
      if (!this.#rotationsExternal) this.#rotations[slot] = rotationBits;
      this.notePosition(slot);
      written += 1;
    }
    return {
      paletteMoves: dense
        ? { mode: "dense-transform", baseSlot, commands: this.#moveCommands, count: written }
        : { mode: "indexed-transform", commands: this.#moveCommands, count: written },
      recordDirty: "none",
    };
  }

  /** Reserve the deferred CPU record journal before a validated store batch starts applying. */
  reservePositionNotes(additional: number): void {
    this.#assertActive();
    if (!Number.isSafeInteger(additional) || additional < 0) {
      throw new TypeError("GPU resident position reserve must be a non-negative safe integer");
    }
    this.#ensureMovedCapacity(Math.min(this.#capacity, this.#pendingSpatialMoves + additional));
  }

  /** Queue one authoritative-origin slot for deferred CPU record reconciliation. @internal */
  notePosition(slot: number): boolean {
    this.#assertActive();
    assertUint("slot", slot);
    if (slot >= this.#capacity || this.#occupied[slot] !== 1) return false;
    this.#recordsNeedReconcile = true;
    if (this.#movedFlags[slot] === 1) return false;
    this.#ensureMovedCapacity(this.#pendingSpatialMoves + 1);
    this.#movedFlags[slot] = 1;
    this.#movedSlots[this.#pendingSpatialMoves] = slot;
    this.#pendingSpatialMoves += 1;
    return true;
  }

  /** Queue one packed authoritative-origin wave through a single validated pass. @internal */
  notePositions(slots: Uint32Array, count: number): number {
    this.#assertActive();
    if (!(slots instanceof Uint32Array)) {
      throw new TypeError("GPU resident position slot column must be Uint32Array");
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("GPU resident position slot count must be a non-negative safe integer");
    }
    if (slots.length < count) {
      throw new TypeError("GPU resident position slot list is shorter than count");
    }
    this.reservePositionNotes(count);
    if (count > 0) this.#recordsNeedReconcile = true;
    const flags = this.#movedFlags;
    const journal = this.#movedSlots;
    let pending = this.#pendingSpatialMoves;
    let noted = 0;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot >= this.#capacity || this.#occupied[slot] !== 1 || flags[slot] === 1) continue;
      flags[slot] = 1;
      journal[pending] = slot;
      pending += 1;
      noted += 1;
    }
    this.#pendingSpatialMoves = pending;
    return noted;
  }

  /** Accept a TextStore-produced mover lease without scanning or repacking its commands. */
  updatePositionsPacked(move: Readonly<PaletteMoveUpload>): Readonly<GpuResidentPositionUpdate> {
    this.#assertActive();
    if (!(move.commands instanceof ArrayBuffer)) {
      throw new TypeError("GPU resident packed move commands must be an ArrayBuffer");
    }
    const commandBytes = paletteMoveUploadBytes(move.mode, move.count);
    if (move.commands.byteLength < commandBytes) {
      throw new RangeError("GPU resident packed move commands are shorter than count");
    }
    if (move.mode === "dense" || move.mode === "dense-transform") {
      if (!Number.isSafeInteger(move.baseSlot) || move.baseSlot < 0) {
        throw new TypeError("GPU resident dense move baseSlot must be a non-negative safe integer");
      }
      const end = move.baseSlot + move.count;
      if (!Number.isSafeInteger(end) || end > 0x1_0000_0000) {
        throw new RangeError("GPU resident dense move slot range exceeds uint32 capacity");
      }
      for (let slot = move.baseSlot; slot < end; slot += 1) {
        if (slot >= this.#capacity || this.#occupied[slot] !== 1) {
          throw new RangeError("GPU resident dense move range contains an inactive slot");
        }
      }
    }
    return { paletteMoves: move, recordDirty: "none" };
  }

  /** Reconcile CPU AABBs and spatial indexing before a CPU query or hit test. */
  flushSpatialMoves(
    visitor: (slots: Uint32Array, count: number, xy: Float32Array) => void,
  ): number {
    this.#assertActive();
    if (typeof visitor !== "function") {
      throw new TypeError("GPU resident spatial visitor must be a function");
    }
    const pending = this.#pendingSpatialMoves;
    if (pending === 0) return 0;
    if (this.#spatialXy.length < pending * 2) this.#spatialXy = new Float32Array(pending * 2);
    let written = 0;
    for (let index = 0; index < pending; index += 1) {
      const slot = this.#movedSlots[index] ?? 0;
      this.#movedFlags[slot] = 0;
      if (this.#occupied[slot] !== 1) continue;
      this.#movedSlots[written] = slot;
      this.#spatialXy[written * 2] = this.#originX[slot] ?? 0;
      this.#spatialXy[written * 2 + 1] = this.#originY[slot] ?? 0;
      this.#reconcileRecord(slot);
      written += 1;
    }
    this.#pendingSpatialMoves = 0;
    this.#recordsNeedReconcile = false;
    if (written > 0) visitor(this.#movedSlots, written, this.#spatialXy);
    return written;
  }

  snapshot(viewport: Readonly<CullViewport>): Readonly<GpuResidentCullUpdate> {
    this.#assertActive();
    let recordDirty: CullRecordDirty;
    if (this.#dirtyAll) {
      recordDirty = "all";
      this.#dirtyAll = false;
      this.#dirty.clear();
    } else {
      const ranges = this.#dirty.publish({
        maxRanges: DIRTY_MAX_RANGES,
        liveBytes: this.#recordCount * GPU_RESIDENT_RECORD_STRIDE,
      });
      recordDirty = ranges.length === 0 ? "none" : ranges;
    }
    // Banded structural uploads can include moved neighbors in their unchanged gaps.
    if (recordDirty !== "none") this.#reconcilePendingRecords();
    const update: GpuResidentCullUpdate = {
      records: this.#records,
      recordCount: this.#recordCount,
      drawInstanceCount: this.#activeGlyphInstances,
      recordDirty,
      localBounds: this.#prototypeBounds,
      localBoundsCount: this.#prototypeBoundsCount,
      localBoundsDirty: this.#localBoundsDirty ? "all" : "none",
      viewport,
    };
    this.#localBoundsDirty = false;
    return update;
  }

  get originX(): Float32Array {
    this.#assertActive();
    return this.#originX;
  }

  get originY(): Float32Array {
    this.#assertActive();
    return this.#originY;
  }

  /** Copy current rendered bounds for CPU query reconciliation. */
  copyBounds(
    slot: number,
    output: { x: number; y: number; width: number; height: number },
  ): boolean {
    this.#assertActive();
    if (slot >= this.#capacity || this.#occupied[slot] !== 1) return false;
    this.#reconcileRecord(slot);
    const base = slot * WORDS_PER_RECORD;
    output.x = this.#recordFloats[base] ?? 0;
    output.y = this.#recordFloats[base + 1] ?? 0;
    output.width = (this.#recordFloats[base + 2] ?? 0) - output.x;
    output.height = (this.#recordFloats[base + 3] ?? 0) - output.y;
    return true;
  }

  get repackRequired(): boolean {
    this.#assertActive();
    return this.#repackRequired;
  }

  clearRepackSignal(): void {
    this.#assertActive();
    this.#repackRequired = false;
  }

  isActive(slot: number, order?: number): boolean {
    this.#assertActive();
    assertUint("slot", slot);
    return (
      slot < this.#capacity &&
      this.#occupied[slot] === 1 &&
      (order === undefined || this.#orders[slot] === order)
    );
  }

  get stats(): Readonly<GpuResidentSceneStats> {
    this.#assertActive();
    return Object.freeze({
      activeLabels: this.#activeLabels,
      activeGlyphInstances: this.#activeGlyphInstances,
      recordCount: this.#recordCount,
      recordBytes: this.#recordCount * GPU_RESIDENT_RECORD_STRIDE,
      allocatedBytes:
        this.#records.byteLength +
        this.#occupied.byteLength +
        (this.#originsExternal ? 0 : this.#originX.byteLength + this.#originY.byteLength) +
        (this.#rotationsExternal ? 0 : this.#rotations.byteLength) +
        this.#orders.byteLength +
        this.#prototypeIds.byteLength +
        this.#prototypeBounds.byteLength +
        this.#movedFlags.byteLength +
        this.#movedSlots.byteLength +
        this.#spatialXy.byteLength +
        this.#moveCommands.byteLength,
      prototypeCount: this.#prototypeRefs.size,
      tombstones: this.#tombstones,
      pendingSpatialMoves: this.#pendingSpatialMoves,
      repackSignals: this.#repackSignals,
      perLabelObjectCount: 0,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#records = new ArrayBuffer(0);
    this.#recordFloats = new Float32Array(0);
    this.#recordUints = new Uint32Array(0);
    this.#occupied = new Uint8Array(0);
    this.#originX = new Float32Array(0);
    this.#originY = new Float32Array(0);
    this.#originsExternal = false;
    this.#rotations = new Uint16Array(0);
    this.#rotationsExternal = false;
    this.#orders = new Uint32Array(0);
    this.#prototypeIds = new Uint32Array(0);
    this.#prototypeBounds = new Float32Array(0);
    this.#movedFlags = new Uint8Array(0);
    this.#movedSlots = new Uint32Array(0);
    this.#spatialXy = new Float32Array(0);
    this.#moveCommands = new ArrayBuffer(0);
    this.#prototypeRefs.clear();
    this.#prototypeBoundsIndex.clear();
    this.#capacity = 0;
    this.#recordCount = 0;
    this.#activeLabels = 0;
    this.#activeGlyphInstances = 0;
    this.#tombstones = 0;
    this.#pendingSpatialMoves = 0;
    this.#recordsNeedReconcile = false;
    this.#prototypeBoundsCount = 0;
    this.#localBoundsDirty = false;
    this.#lastOrder = -1;
    this.#repackRequired = false;
    this.#dirty.clear();
    this.#destroyed = true;
  }

  #writeColumn(column: Readonly<GpuResidentAdmitColumn>): void {
    const addedInstances = column.count * column.instanceCount;
    if (
      !Number.isSafeInteger(addedInstances) ||
      this.#activeGlyphInstances + addedInstances > 0xffff_ffff
    ) {
      throw new RangeError("GPU resident draw instance count exceeds uint32 capacity");
    }
    const boundsX = Math.fround(column.localBounds[0] ?? 0);
    const boundsY = Math.fround(column.localBounds[1] ?? 0);
    const boundsWidth = Math.fround(column.localBounds[2] ?? 0);
    const boundsHeight = Math.fround(column.localBounds[3] ?? 0);
    const boundsIndex = this.#registerPrototypeBounds(
      column.prototypeId,
      boundsX,
      boundsY,
      boundsWidth,
      boundsHeight,
    );
    for (let index = 0; index < column.count; index += 1) {
      const slot = column.slots[index] ?? 0;
      const x = Math.fround(column.xy[index * 2] ?? 0);
      const y = Math.fround(column.xy[index * 2 + 1] ?? 0);
      const rotationBits = packF16(column.rotations?.[index] ?? 0);
      const base = slot * WORDS_PER_RECORD;
      writeResidentRotatedAabbF32(
        this.#recordFloats,
        base,
        x,
        y,
        boundsX,
        boundsY,
        boundsWidth,
        boundsHeight,
        packResidentRotation(unpackF16(rotationBits)),
      );
      this.#recordUints[base + 4] = column.instanceOffset;
      this.#recordUints[base + 5] = column.instanceCount;
      this.#recordUints[base + 6] = slot;
      this.#recordUints[base + 7] = boundsIndex;
      this.#occupied[slot] = 1;
      if (!this.#originsExternal) {
        this.#originX[slot] = x;
        this.#originY[slot] = y;
      }
      if (!this.#rotationsExternal) this.#rotations[slot] = rotationBits;
      this.#orders[slot] = column.orders[index] ?? 0;
      this.#prototypeIds[slot] = column.prototypeId;
      this.#activeLabels += 1;
    }
    this.#activeGlyphInstances += addedInstances;
    if (column.count > 0) {
      this.#prototypeRefs.set(
        column.prototypeId,
        (this.#prototypeRefs.get(column.prototypeId) ?? 0) + column.count,
      );
    }
  }

  #allocate(capacity: number): void {
    this.#capacity = capacity;
    this.#records = new ArrayBuffer(capacity * GPU_RESIDENT_RECORD_STRIDE);
    this.#recordFloats = new Float32Array(this.#records);
    this.#recordUints = new Uint32Array(this.#records);
    this.#occupied = new Uint8Array(capacity);
    this.#originX = new Float32Array(capacity);
    this.#originY = new Float32Array(capacity);
    this.#originsExternal = false;
    this.#rotations = new Uint16Array(capacity);
    this.#rotationsExternal = false;
    this.#orders = new Uint32Array(capacity);
    this.#prototypeIds = new Uint32Array(capacity);
    this.#prototypeBounds = new Float32Array(4);
    this.#movedFlags = new Uint8Array(capacity);
    this.#movedSlots = new Uint32Array(0);
    this.#spatialXy = new Float32Array(0);
    this.#moveCommands = new ArrayBuffer(0);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;
    if (required > this.#maxCapacity) {
      throw new RangeError("GPU resident append exceeds maxCapacity");
    }
    let capacity = Math.max(1, this.#capacity);
    while (capacity < required) capacity = Math.min(this.#maxCapacity, capacity * 2);
    if (
      this.#originsExternal &&
      (this.#originX.length < capacity || this.#originY.length < capacity)
    ) {
      throw new RangeError("GPU resident external origin columns are shorter than append capacity");
    }
    if (this.#rotationsExternal && this.#rotations.length < capacity) {
      throw new RangeError("GPU resident external rotation column is shorter than append capacity");
    }
    const records = new ArrayBuffer(capacity * GPU_RESIDENT_RECORD_STRIDE);
    new Uint8Array(records).set(new Uint8Array(this.#records));
    const recordFloats = new Float32Array(records);
    const recordUints = new Uint32Array(records);
    const occupied = growUint8(this.#occupied, capacity);
    const originX = this.#originsExternal ? this.#originX : growFloat32(this.#originX, capacity);
    const originY = this.#originsExternal ? this.#originY : growFloat32(this.#originY, capacity);
    const rotations = this.#rotationsExternal
      ? this.#rotations
      : growUint16(this.#rotations, capacity);
    const orders = growUint32(this.#orders, capacity);
    const prototypeIds = growUint32(this.#prototypeIds, capacity);
    const movedFlags = growUint8(this.#movedFlags, capacity);

    this.#records = records;
    this.#recordFloats = recordFloats;
    this.#recordUints = recordUints;
    this.#occupied = occupied;
    this.#originX = originX;
    this.#originY = originY;
    this.#rotations = rotations;
    this.#orders = orders;
    this.#prototypeIds = prototypeIds;
    this.#movedFlags = movedFlags;
    this.#capacity = capacity;
    this.#dirty.clear();
    this.#dirtyAll = this.#recordCount > 0;
  }

  #ensureMovedCapacity(required: number): void {
    if (this.#movedSlots.length >= required) return;
    let capacity = Math.max(16, this.#movedSlots.length);
    while (capacity < required) capacity *= 2;
    const slots = new Uint32Array(capacity);
    slots.set(this.#movedSlots.subarray(0, this.#pendingSpatialMoves));
    this.#movedSlots = slots;
  }

  #reconcileRecord(slot: number): void {
    const base = slot * WORDS_PER_RECORD;
    const boundsBase = (this.#recordUints[base + 7] ?? 0) * 4;
    const x = this.#originX[slot] ?? 0;
    const y = this.#originY[slot] ?? 0;
    const boundsX = this.#prototypeBounds[boundsBase] ?? 0;
    const boundsY = this.#prototypeBounds[boundsBase + 1] ?? 0;
    const boundsWidth = this.#prototypeBounds[boundsBase + 2] ?? 0;
    const boundsHeight = this.#prototypeBounds[boundsBase + 3] ?? 0;
    writeResidentRotatedAabbF32(
      this.#recordFloats,
      base,
      x,
      y,
      boundsX,
      boundsY,
      boundsWidth,
      boundsHeight,
      packResidentRotation(unpackF16(this.#rotations[slot] ?? 0)),
    );
  }

  #reconcilePendingRecords(): void {
    if (!this.#recordsNeedReconcile) return;
    for (let index = 0; index < this.#pendingSpatialMoves; index += 1) {
      const slot = this.#movedSlots[index] ?? 0;
      if (this.#occupied[slot] === 1) this.#reconcileRecord(slot);
    }
    this.#recordsNeedReconcile = false;
  }

  #signalRepack(): void {
    this.#repackRequired = true;
    this.#repackSignals += 1;
  }

  #releasePrototypeRef(prototypeId: number): void {
    const refs = this.#prototypeRefs.get(prototypeId) ?? 0;
    if (refs <= 1) this.#prototypeRefs.delete(prototypeId);
    else this.#prototypeRefs.set(prototypeId, refs - 1);
  }

  #registerPrototypeBounds(
    prototypeId: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): number {
    const existing = this.#prototypeBoundsIndex.get(prototypeId);
    if (existing !== undefined) {
      const base = existing * 4;
      if (
        this.#prototypeBounds[base] !== x ||
        this.#prototypeBounds[base + 1] !== y ||
        this.#prototypeBounds[base + 2] !== width ||
        this.#prototypeBounds[base + 3] !== height
      ) {
        throw new TypeError("GPU resident prototype local bounds changed");
      }
      return existing;
    }
    const index = this.#prototypeBoundsCount;
    const needed = (index + 1) * 4;
    if (this.#prototypeBounds.length < needed) {
      let capacity = Math.max(16, this.#prototypeBounds.length);
      while (capacity < needed) capacity *= 2;
      const bounds = new Float32Array(capacity);
      bounds.set(this.#prototypeBounds);
      this.#prototypeBounds = bounds;
    }
    const base = index * 4;
    this.#prototypeBounds[base] = x;
    this.#prototypeBounds[base + 1] = y;
    this.#prototypeBounds[base + 2] = width;
    this.#prototypeBounds[base + 3] = height;
    this.#prototypeBoundsIndex.set(prototypeId, index);
    this.#prototypeBoundsCount += 1;
    this.#localBoundsDirty = true;
    return index;
  }

  #assertPrototypeBounds(
    columns: readonly Readonly<GpuResidentAdmitColumn>[],
    includeResident: boolean,
  ): void {
    const pending = new Map<number, readonly [number, number, number, number]>();
    for (const column of columns) {
      if (column.count === 0) continue;
      const bounds = columnBounds(column);
      if (includeResident) {
        const existing = this.#prototypeBoundsIndex.get(column.prototypeId);
        if (existing !== undefined) {
          const base = existing * 4;
          if (
            this.#prototypeBounds[base] !== bounds[0] ||
            this.#prototypeBounds[base + 1] !== bounds[1] ||
            this.#prototypeBounds[base + 2] !== bounds[2] ||
            this.#prototypeBounds[base + 3] !== bounds[3]
          ) {
            throw new TypeError("GPU resident prototype local bounds changed");
          }
        }
      }
      const candidate = pending.get(column.prototypeId);
      if (
        candidate !== undefined &&
        (candidate[0] !== bounds[0] ||
          candidate[1] !== bounds[1] ||
          candidate[2] !== bounds[2] ||
          candidate[3] !== bounds[3])
      ) {
        throw new TypeError("GPU resident prototype local bounds changed");
      }
      pending.set(column.prototypeId, bounds);
    }
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("GpuResidentScene has been destroyed");
  }
}

/** @internal Eligibility keeps slot traversal equivalent to transparent insertion order. */
export function gpuResidentAdmitEligible(column: Readonly<GpuResidentAdmitColumn>): boolean {
  if (column.zIndex !== 0 || column.blendMode !== "normal") return false;
  let previousSlot = -1;
  let previousOrder = -1;
  for (let index = 0; index < column.count; index += 1) {
    const slot = column.slots[index];
    const order = column.orders[index];
    if (slot === undefined || order === undefined) return false;
    if ((previousSlot >= 0 && slot !== previousSlot + 1) || order <= previousOrder) return false;
    previousSlot = slot;
    previousOrder = order;
  }
  return true;
}

interface ColumnUnionInspection {
  readonly recordCount: number;
  readonly recordEnd: number;
  readonly glyphInstances: number;
  readonly lastOrder: number;
}

function inspectColumnUnion(
  columns: readonly Readonly<GpuResidentAdmitColumn>[],
  recordStart: number,
  previousOrder: number,
  maxRecordEnd: number,
  capacityMessage: string,
): Readonly<ColumnUnionInspection> | undefined {
  if (!Array.isArray(columns)) {
    throw new TypeError("GPU resident columns must be an array");
  }
  let recordCount = 0;
  let glyphInstances = 0;
  for (const column of columns) {
    validateColumn(column);
    if (column.zIndex !== 0 || column.blendMode !== "normal") return undefined;
    recordCount += column.count;
    const addedInstances = column.count * column.instanceCount;
    glyphInstances += addedInstances;
    if (
      !Number.isSafeInteger(recordCount) ||
      !Number.isSafeInteger(glyphInstances) ||
      glyphInstances > 0xffff_ffff
    ) {
      throw new RangeError("GPU resident draw instance count exceeds uint32 capacity");
    }
  }
  const recordEnd = recordStart + recordCount;
  if (!Number.isSafeInteger(recordEnd) || recordEnd > 0xffff_ffff) {
    throw new RangeError("GPU resident record count exceeds uint32 capacity");
  }
  if (recordEnd > maxRecordEnd) throw new RangeError(capacityMessage);
  if (recordCount === 0) {
    return {
      recordCount,
      recordEnd,
      glyphInstances,
      lastOrder: previousOrder,
    };
  }

  const occupied = new Uint8Array(recordCount);
  const orders = new Uint32Array(recordCount);
  for (const column of columns) {
    let priorSlot = -1;
    let priorColumnOrder = -1;
    for (let index = 0; index < column.count; index += 1) {
      const slot = column.slots[index];
      const order = column.orders[index];
      if (
        slot === undefined ||
        order === undefined ||
        slot <= priorSlot ||
        order <= priorColumnOrder
      ) {
        return undefined;
      }
      const relative = slot - recordStart;
      if (relative < 0 || relative >= recordCount || occupied[relative] === 1) return undefined;
      occupied[relative] = 1;
      orders[relative] = order;
      priorSlot = slot;
      priorColumnOrder = order;
    }
  }
  let lastOrder = previousOrder;
  for (let relative = 0; relative < recordCount; relative += 1) {
    if (occupied[relative] !== 1) return undefined;
    const order = orders[relative] ?? 0;
    if (order <= lastOrder) return undefined;
    lastOrder = order;
  }
  return { recordCount, recordEnd, glyphInstances, lastOrder };
}

function columnBounds(
  column: Readonly<GpuResidentAdmitColumn>,
): readonly [number, number, number, number] {
  return [
    Math.fround(column.localBounds[0] ?? 0),
    Math.fround(column.localBounds[1] ?? 0),
    Math.fround(column.localBounds[2] ?? 0),
    Math.fround(column.localBounds[3] ?? 0),
  ];
}

function validateColumn(column: Readonly<GpuResidentAdmitColumn>): void {
  if (!(column.slots instanceof Uint32Array)) {
    throw new TypeError("GPU resident slots must be a Uint32Array");
  }
  if (!(column.xy instanceof Float32Array)) {
    throw new TypeError("GPU resident xy must be a Float32Array");
  }
  if (!(column.orders instanceof Uint32Array)) {
    throw new TypeError("GPU resident orders must be a Uint32Array");
  }
  if (!(column.localBounds instanceof Float32Array) || column.localBounds.length !== 4) {
    throw new TypeError("GPU resident localBounds must contain x, y, width, height");
  }
  if (!Number.isSafeInteger(column.count) || column.count < 0) {
    throw new TypeError("GPU resident count must be a non-negative safe integer");
  }
  if (
    column.count > column.slots.length ||
    column.count > column.orders.length ||
    column.count * 2 > column.xy.length ||
    (column.rotations !== undefined && column.rotations.length < column.count)
  ) {
    throw new RangeError("GPU resident typed columns are shorter than count");
  }
  assertUint("prototypeId", column.prototypeId);
  assertUint("instanceOffset", column.instanceOffset);
  assertUint("instanceCount", column.instanceCount);
  if (!Number.isFinite(column.zIndex)) {
    throw new TypeError("GPU resident zIndex must be finite");
  }
  for (let index = 0; index < 4; index += 1) {
    if (!Number.isFinite(column.localBounds[index])) {
      throw new TypeError("GPU resident local bounds must be finite");
    }
  }
  for (let index = 0; index < column.count * 2; index += 1) {
    if (!Number.isFinite(column.xy[index])) {
      throw new TypeError("GPU resident xy values must be finite");
    }
  }
  if (column.rotations !== undefined) {
    for (let index = 0; index < column.count; index += 1) {
      if (!Number.isFinite(column.rotations[index])) {
        throw new TypeError("GPU resident rotations must be finite");
      }
    }
  }
}

function validatePositionColumns(slots: Uint32Array, count: number, xy: Float32Array): void {
  if (!(slots instanceof Uint32Array) || !(xy instanceof Float32Array)) {
    throw new TypeError("GPU resident move columns must use Uint32Array and Float32Array");
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("GPU resident move count must be a non-negative safe integer");
  }
  if (count > slots.length || count * 2 > xy.length) {
    throw new RangeError("GPU resident move columns are shorter than count");
  }
}

function validateSlots(slots: Uint32Array, count: number, operation: string): void {
  if (!(slots instanceof Uint32Array)) {
    throw new TypeError(`GPU resident ${operation} slots must be a Uint32Array`);
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`GPU resident ${operation} count must be a non-negative safe integer`);
  }
  if (count > slots.length) {
    throw new RangeError(`GPU resident ${operation} slots are shorter than count`);
  }
}

function growUint8(source: Uint8Array, capacity: number): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(new ArrayBuffer(capacity));
  next.set(source);
  return next;
}

function growUint32(source: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const next = new Uint32Array(new ArrayBuffer(capacity * Uint32Array.BYTES_PER_ELEMENT));
  next.set(source);
  return next;
}

function growUint16(source: Uint16Array, capacity: number): Uint16Array<ArrayBuffer> {
  const next = new Uint16Array(new ArrayBuffer(capacity * Uint16Array.BYTES_PER_ELEMENT));
  next.set(source);
  return next;
}

function growFloat32(source: Float32Array, capacity: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(new ArrayBuffer(capacity * Float32Array.BYTES_PER_ELEMENT));
  next.set(source);
  return next;
}

function assertCapacity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`GPU resident ${name} must be a non-negative safe integer`);
  }
}

function assertUint(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`GPU resident ${name} must fit uint32`);
  }
}
