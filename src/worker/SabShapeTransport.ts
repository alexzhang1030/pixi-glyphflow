import type { SerializedPositionedRun, ShapeWorkerResponse } from "./protocol";

export interface SabShapeRingLayout {
  readonly magic: number;
  readonly version: number;
  readonly headerBytes: number;
  readonly slotHeaderBytes: number;
  readonly recordHeaderBytes: number;
  readonly alignment: number;
}

export const SAB_SHAPE_RING_LAYOUT: Readonly<SabShapeRingLayout> = Object.freeze({
  magic: 0x4753_4631,
  version: 2,
  headerBytes: 64,
  slotHeaderBytes: 32,
  recordHeaderBytes: 96,
  alignment: 4,
});

export type SabShapeCapabilityReason = "shared-array-buffer" | "atomics" | "cross-origin-isolation";

export interface SabShapeCapabilityScope {
  readonly SharedArrayBuffer: typeof SharedArrayBuffer | undefined;
  readonly Atomics: typeof Atomics | undefined;
  readonly crossOriginIsolated: boolean | undefined;
}

export interface SabShapeTransportCapability {
  readonly supported: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly atomics: boolean;
  readonly crossOriginIsolated: boolean;
  readonly reason: SabShapeCapabilityReason | undefined;
}

export interface SabShapeTransportOptions {
  readonly slotCount: number;
  readonly slotPayloadBytes: number;
}

export type ShapeResultResponse = Extract<ShapeWorkerResponse, { readonly type: "shape-result" }>;

export interface SabShapeResultLease {
  readonly result: Readonly<ShapeResultResponse>;
  readonly released: boolean;
  release(): void;
}

export class SabShapeOverflowError extends RangeError {
  readonly requiredBytes: number;
  readonly availableBytes: number;

  constructor(requiredBytes: number, availableBytes: number) {
    super(
      `Shape result requires ${String(requiredBytes)} bytes; ring slots provide ${String(availableBytes)} bytes`,
    );
    this.name = "SabShapeOverflowError";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

export class SabShapeTransportDestroyedError extends Error {
  constructor() {
    super("Shared shape transport has been destroyed");
    this.name = "SabShapeTransportDestroyedError";
  }
}

const enum HeaderIndex {
  Magic = 0,
  Version = 1,
  State = 2,
  SlotCount = 3,
  SlotPayloadBytes = 4,
  WriteSequence = 5,
  ReclaimSequence = 6,
  Signal = 7,
  ClaimSequence = 8,
}

const enum SlotIndex {
  State = 0,
  Sequence = 1,
  RecordBytes = 2,
  GlyphCount = 3,
}

const enum TransportState {
  Active = 1,
  Destroyed = 2,
}

const enum SlotState {
  Empty = 0,
  Writing = 1,
  Ready = 2,
  Leased = 3,
  Released = 4,
  Reclaiming = 5,
}

const enum RecordOffset {
  Magic = 0,
  Version = 4,
  RequestId = 8,
  LabelId = 16,
  SourceRevision = 24,
  FontRevision = 32,
  GlyphCount = 40,
  Direction = 44,
  TextBytes = 48,
  FamilyBytes = 52,
  MetadataBytes = 56,
  Flags = 60,
  BoundsX = 64,
  BoundsY = 72,
  BoundsWidth = 80,
  BoundsHeight = 88,
}

const RECORD_MAGIC = 0x5348_5031;
const RECORD_VERSION = 1;
const GLYPH_KEYS_FLAG = 1;
const CLUSTER_ENDS_FLAG = 1 << 1;
const VARIATION_KEY_FLAG = 1 << 2;
const SUPPORTED_RECORD_FLAGS = GLYPH_KEYS_FLAG | CLUSTER_ENDS_FLAG | VARIATION_KEY_FLAG;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function detectSabShapeTransportCapability(
  scope: Readonly<SabShapeCapabilityScope> = runtimeCapabilityScope(),
): Readonly<SabShapeTransportCapability> {
  const sharedArrayBuffer = typeof scope.SharedArrayBuffer === "function";
  const atomics =
    typeof scope.Atomics === "object" &&
    scope.Atomics !== null &&
    typeof scope.Atomics.load === "function" &&
    typeof scope.Atomics.store === "function" &&
    typeof scope.Atomics.notify === "function";
  const crossOriginIsolated = scope.crossOriginIsolated === true;
  const reason = !sharedArrayBuffer
    ? "shared-array-buffer"
    : !atomics
      ? "atomics"
      : !crossOriginIsolated
        ? "cross-origin-isolation"
        : undefined;

  return Object.freeze({
    supported: reason === undefined,
    sharedArrayBuffer,
    atomics,
    crossOriginIsolated,
    reason,
  });
}

/** Single-producer/single-consumer ring for leased, zero-copy positioned-run views. */
export class SabShapeTransport {
  readonly buffer: SharedArrayBuffer;
  readonly slotCount: number;
  readonly slotPayloadBytes: number;
  readonly #header: Int32Array;

  private constructor(
    buffer: SharedArrayBuffer,
    header: Int32Array,
    slotCount: number,
    slotPayloadBytes: number,
  ) {
    this.buffer = buffer;
    this.#header = header;
    this.slotCount = slotCount;
    this.slotPayloadBytes = slotPayloadBytes;
  }

  static create(options: Readonly<SabShapeTransportOptions>): SabShapeTransport {
    assertInteger("slotCount", options.slotCount, 1);
    assertPowerOfTwoSlotCount(options.slotCount);
    assertInteger(
      "slotPayloadBytes",
      options.slotPayloadBytes,
      SAB_SHAPE_RING_LAYOUT.recordHeaderBytes,
    );
    const slotPayloadBytes = align(options.slotPayloadBytes, SAB_SHAPE_RING_LAYOUT.alignment);
    const slotBytes = SAB_SHAPE_RING_LAYOUT.slotHeaderBytes + slotPayloadBytes;
    const byteLength = SAB_SHAPE_RING_LAYOUT.headerBytes + options.slotCount * slotBytes;
    if (!Number.isSafeInteger(byteLength)) {
      throw new RangeError("Shared shape transport byte length exceeds safe integer capacity");
    }
    const buffer = new SharedArrayBuffer(byteLength);
    const header = new Int32Array(buffer, 0, SAB_SHAPE_RING_LAYOUT.headerBytes / 4);
    Atomics.store(header, HeaderIndex.Magic, SAB_SHAPE_RING_LAYOUT.magic);
    Atomics.store(header, HeaderIndex.Version, SAB_SHAPE_RING_LAYOUT.version);
    Atomics.store(header, HeaderIndex.State, TransportState.Active);
    Atomics.store(header, HeaderIndex.SlotCount, options.slotCount);
    Atomics.store(header, HeaderIndex.SlotPayloadBytes, slotPayloadBytes);

    return new SabShapeTransport(buffer, header, options.slotCount, slotPayloadBytes);
  }

  static attach(buffer: SharedArrayBuffer): SabShapeTransport {
    if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("buffer must be a SharedArrayBuffer");
    }
    if (buffer.byteLength < SAB_SHAPE_RING_LAYOUT.headerBytes) {
      throw new RangeError("Shared shape transport header is truncated");
    }
    const header = new Int32Array(buffer, 0, SAB_SHAPE_RING_LAYOUT.headerBytes / 4);
    if (Atomics.load(header, HeaderIndex.Magic) !== SAB_SHAPE_RING_LAYOUT.magic) {
      throw new TypeError("Shared shape transport magic is invalid");
    }
    if (Atomics.load(header, HeaderIndex.Version) !== SAB_SHAPE_RING_LAYOUT.version) {
      throw new TypeError("Shared shape transport version is unsupported");
    }
    const slotCount = Atomics.load(header, HeaderIndex.SlotCount);
    const slotPayloadBytes = Atomics.load(header, HeaderIndex.SlotPayloadBytes);
    assertInteger("slotCount", slotCount, 1);
    assertPowerOfTwoSlotCount(slotCount);
    assertInteger("slotPayloadBytes", slotPayloadBytes, SAB_SHAPE_RING_LAYOUT.recordHeaderBytes);
    if (slotPayloadBytes % SAB_SHAPE_RING_LAYOUT.alignment !== 0) {
      throw new RangeError("Shared shape transport slot payload alignment is invalid");
    }
    const expectedBytes =
      SAB_SHAPE_RING_LAYOUT.headerBytes +
      slotCount * (SAB_SHAPE_RING_LAYOUT.slotHeaderBytes + slotPayloadBytes);
    if (buffer.byteLength !== expectedBytes) {
      throw new RangeError("Shared shape transport byte length does not match its header");
    }

    return new SabShapeTransport(buffer, header, slotCount, slotPayloadBytes);
  }

  get destroyed(): boolean {
    return Atomics.load(this.#header, HeaderIndex.State) !== TransportState.Active;
  }

  tryWrite(result: Readonly<ShapeResultResponse>): boolean {
    this.#assertActive();
    const encoded = prepareResult(result);
    if (encoded.recordBytes > this.slotPayloadBytes) {
      throw new SabShapeOverflowError(encoded.recordBytes, this.slotPayloadBytes);
    }
    return this.#tryWritePrepared(encoded);
  }

  async write(result: Readonly<ShapeResultResponse>): Promise<void> {
    this.#assertActive();
    const encoded = prepareResult(result);
    if (encoded.recordBytes > this.slotPayloadBytes) {
      throw new SabShapeOverflowError(encoded.recordBytes, this.slotPayloadBytes);
    }
    for (;;) {
      const signal = Atomics.load(this.#header, HeaderIndex.Signal);
      if (this.#tryWritePrepared(encoded)) return;

      await waitForAtomicChange(this.#header, HeaderIndex.Signal, signal);
      this.#assertActive();
    }
  }

  #tryWritePrepared(encoded: Readonly<PreparedResult>): boolean {
    this.#assertActive();
    const writeSequence = Atomics.load(this.#header, HeaderIndex.WriteSequence) >>> 0;
    const reclaimSequence = Atomics.load(this.#header, HeaderIndex.ReclaimSequence) >>> 0;
    if ((writeSequence - reclaimSequence) >>> 0 >= this.slotCount) {
      return false;
    }
    const slot = this.#slotHeader(writeSequence % this.slotCount);
    if (
      Atomics.compareExchange(slot, SlotIndex.State, SlotState.Empty, SlotState.Writing) !==
      SlotState.Empty
    ) {
      return false;
    }

    try {
      writeResult(this.buffer, this.#slotPayloadOffset(writeSequence % this.slotCount), encoded);
      Atomics.store(slot, SlotIndex.Sequence, writeSequence);
      Atomics.store(slot, SlotIndex.RecordBytes, encoded.recordBytes);
      Atomics.store(slot, SlotIndex.GlyphCount, encoded.result.run.glyphCount);
      Atomics.store(slot, SlotIndex.State, SlotState.Ready);
      Atomics.store(this.#header, HeaderIndex.WriteSequence, writeSequence + 1);
      Atomics.add(this.#header, HeaderIndex.Signal, 1);
      Atomics.notify(slot, SlotIndex.State);
      Atomics.notify(this.#header, HeaderIndex.WriteSequence);
      Atomics.notify(this.#header, HeaderIndex.Signal);
      return true;
    } catch (error) {
      Atomics.store(slot, SlotIndex.State, SlotState.Empty);
      Atomics.notify(slot, SlotIndex.State);
      throw error;
    }
  }

  tryRead(): SabShapeResultLease | undefined {
    this.#assertActive();
    const claimSequence = Atomics.load(this.#header, HeaderIndex.ClaimSequence) >>> 0;
    const writeSequence = Atomics.load(this.#header, HeaderIndex.WriteSequence) >>> 0;
    if (claimSequence === writeSequence) {
      return undefined;
    }
    const slotIndex = claimSequence % this.slotCount;
    const slot = this.#slotHeader(slotIndex);
    if (
      Atomics.compareExchange(slot, SlotIndex.State, SlotState.Ready, SlotState.Leased) !==
      SlotState.Ready
    ) {
      return undefined;
    }

    try {
      if (Atomics.load(slot, SlotIndex.Sequence) >>> 0 !== claimSequence) {
        throw new Error("Shared shape transport slot sequence is inconsistent");
      }
      const recordBytes = Atomics.load(slot, SlotIndex.RecordBytes);
      const glyphCount = Atomics.load(slot, SlotIndex.GlyphCount);
      if (
        recordBytes < SAB_SHAPE_RING_LAYOUT.recordHeaderBytes ||
        recordBytes > this.slotPayloadBytes
      ) {
        throw new RangeError("Shared shape record byte length exceeds its slot");
      }
      const result = readResult(
        this.buffer,
        this.#slotPayloadOffset(slotIndex),
        recordBytes,
        glyphCount,
      );
      Atomics.store(this.#header, HeaderIndex.ClaimSequence, claimSequence + 1);
      return createLease(result, () => {
        if (
          Atomics.compareExchange(slot, SlotIndex.State, SlotState.Leased, SlotState.Released) !==
          SlotState.Leased
        ) {
          return;
        }
        this.#reclaimReleased();
      });
    } catch (error) {
      Atomics.store(slot, SlotIndex.State, SlotState.Ready);
      Atomics.notify(slot, SlotIndex.State);
      throw error;
    }
  }

  async read(): Promise<SabShapeResultLease> {
    this.#assertActive();
    for (;;) {
      const signal = Atomics.load(this.#header, HeaderIndex.Signal);
      const lease = this.tryRead();
      if (lease !== undefined) return lease;

      await waitForAtomicChange(this.#header, HeaderIndex.Signal, signal);
      this.#assertActive();
    }
  }

  destroy(): void {
    if (this.destroyed) return;

    Atomics.store(this.#header, HeaderIndex.State, TransportState.Destroyed);
    Atomics.add(this.#header, HeaderIndex.Signal, 1);
    Atomics.notify(this.#header, HeaderIndex.State);
    Atomics.notify(this.#header, HeaderIndex.WriteSequence);
    Atomics.notify(this.#header, HeaderIndex.ReclaimSequence);
    Atomics.notify(this.#header, HeaderIndex.ClaimSequence);
    Atomics.notify(this.#header, HeaderIndex.Signal);
    for (let slotIndex = 0; slotIndex < this.slotCount; slotIndex += 1) {
      const slot = this.#slotHeader(slotIndex);
      Atomics.notify(slot, SlotIndex.State);
    }
  }

  #slotHeader(slotIndex: number): Int32Array {
    const byteOffset =
      SAB_SHAPE_RING_LAYOUT.headerBytes +
      slotIndex * (SAB_SHAPE_RING_LAYOUT.slotHeaderBytes + this.slotPayloadBytes);
    return new Int32Array(this.buffer, byteOffset, SAB_SHAPE_RING_LAYOUT.slotHeaderBytes / 4);
  }

  /** Advance producer-visible capacity across the contiguous released prefix. */
  #reclaimReleased(): void {
    for (;;) {
      const reclaimSequence = Atomics.load(this.#header, HeaderIndex.ReclaimSequence) >>> 0;
      const claimSequence = Atomics.load(this.#header, HeaderIndex.ClaimSequence) >>> 0;
      if (reclaimSequence === claimSequence) return;

      const slot = this.#slotHeader(reclaimSequence % this.slotCount);
      if (Atomics.load(slot, SlotIndex.Sequence) >>> 0 !== reclaimSequence) return;
      if (
        Atomics.compareExchange(slot, SlotIndex.State, SlotState.Released, SlotState.Reclaiming) !==
        SlotState.Released
      ) {
        return;
      }

      Atomics.store(slot, SlotIndex.RecordBytes, 0);
      Atomics.store(slot, SlotIndex.GlyphCount, 0);
      Atomics.store(slot, SlotIndex.State, SlotState.Empty);
      Atomics.store(this.#header, HeaderIndex.ReclaimSequence, reclaimSequence + 1);
      Atomics.add(this.#header, HeaderIndex.Signal, 1);
      Atomics.notify(slot, SlotIndex.State);
      Atomics.notify(this.#header, HeaderIndex.ReclaimSequence);
      Atomics.notify(this.#header, HeaderIndex.Signal);
    }
  }

  #slotPayloadOffset(slotIndex: number): number {
    return (
      SAB_SHAPE_RING_LAYOUT.headerBytes +
      slotIndex * (SAB_SHAPE_RING_LAYOUT.slotHeaderBytes + this.slotPayloadBytes) +
      SAB_SHAPE_RING_LAYOUT.slotHeaderBytes
    );
  }

  #assertActive(): void {
    if (this.destroyed) throw new SabShapeTransportDestroyedError();
  }
}

interface PreparedResult {
  readonly result: Readonly<ShapeResultResponse>;
  readonly text: Uint8Array;
  readonly family: Uint8Array;
  readonly metadata: Uint8Array;
  readonly flags: number;
  readonly variableOffset: number;
  readonly recordBytes: number;
}

function prepareResult(result: Readonly<ShapeResultResponse>): Readonly<PreparedResult> {
  assertSafeInteger("requestId", result.requestId);
  assertSafeInteger("labelId", result.labelId);
  assertSafeInteger("sourceRevision", result.sourceRevision);
  assertSafeInteger("fontRevision", result.fontRevision);
  const run = result.run;
  assertSafeInteger("run.fontRevision", run.fontRevision);
  assertInteger("run.glyphCount", run.glyphCount, 0);
  if (run.fontRevision !== result.fontRevision) {
    throw new TypeError("Shape result and run font revisions must match");
  }
  const arrays: readonly ArrayLike<number>[] = [
    run.glyphIds,
    run.clusters,
    ...(run.clusterEnds === undefined ? [] : [run.clusterEnds]),
    run.x,
    run.y,
    run.xAdvance,
    run.yAdvance,
    run.lineIndices,
  ];
  if (arrays.some((array) => array.length !== run.glyphCount)) {
    throw new RangeError("Every shaped-run array must match glyphCount");
  }
  if (run.glyphKeys !== undefined && run.glyphKeys.length !== run.glyphCount) {
    throw new RangeError("glyphKeys must match glyphCount");
  }
  assertFinite("run.bounds.x", run.bounds.x);
  assertFinite("run.bounds.y", run.bounds.y);
  assertFinite("run.bounds.width", run.bounds.width);
  assertFinite("run.bounds.height", run.bounds.height);
  const text = encoder.encode(run.text);
  const family = encoder.encode(run.fontFamily);
  const flags =
    (run.glyphKeys === undefined ? 0 : GLYPH_KEYS_FLAG) |
    (run.clusterEnds === undefined ? 0 : CLUSTER_ENDS_FLAG) |
    (run.variationKey === undefined ? 0 : VARIATION_KEY_FLAG);
  const metadata = encodeMetadata(run);
  const variableOffset = align(
    SAB_SHAPE_RING_LAYOUT.recordHeaderBytes +
      text.byteLength +
      family.byteLength +
      metadata.byteLength,
    SAB_SHAPE_RING_LAYOUT.alignment,
  );
  const columnCount = 7 + (run.clusterEnds === undefined ? 0 : 1);
  const recordBytes = variableOffset + run.glyphCount * columnCount * Uint32Array.BYTES_PER_ELEMENT;

  return Object.freeze({ result, text, family, metadata, flags, variableOffset, recordBytes });
}

function encodeMetadata(run: Readonly<SerializedPositionedRun>): Uint8Array {
  if (run.glyphKeys === undefined && run.variationKey === undefined) return new Uint8Array();

  return encoder.encode(
    JSON.stringify({
      ...(run.glyphKeys === undefined ? {} : { glyphKeys: run.glyphKeys }),
      ...(run.variationKey === undefined ? {} : { variationKey: run.variationKey }),
    }),
  );
}

function writeResult(
  buffer: SharedArrayBuffer,
  byteOffset: number,
  encoded: Readonly<PreparedResult>,
): void {
  const result = encoded.result;
  const run = result.run;
  const view = new DataView(buffer, byteOffset, encoded.recordBytes);
  view.setUint32(RecordOffset.Magic, RECORD_MAGIC, true);
  view.setUint32(RecordOffset.Version, RECORD_VERSION, true);
  view.setFloat64(RecordOffset.RequestId, result.requestId, true);
  view.setFloat64(RecordOffset.LabelId, result.labelId, true);
  view.setFloat64(RecordOffset.SourceRevision, result.sourceRevision, true);
  view.setFloat64(RecordOffset.FontRevision, result.fontRevision, true);
  view.setUint32(RecordOffset.GlyphCount, run.glyphCount, true);
  view.setUint32(RecordOffset.Direction, run.direction === "rtl" ? 1 : 0, true);
  view.setUint32(RecordOffset.TextBytes, encoded.text.byteLength, true);
  view.setUint32(RecordOffset.FamilyBytes, encoded.family.byteLength, true);
  view.setUint32(RecordOffset.MetadataBytes, encoded.metadata.byteLength, true);
  view.setUint32(RecordOffset.Flags, encoded.flags, true);
  view.setFloat64(RecordOffset.BoundsX, run.bounds.x, true);
  view.setFloat64(RecordOffset.BoundsY, run.bounds.y, true);
  view.setFloat64(RecordOffset.BoundsWidth, run.bounds.width, true);
  view.setFloat64(RecordOffset.BoundsHeight, run.bounds.height, true);

  const bytes = new Uint8Array(buffer, byteOffset, encoded.recordBytes);
  let cursor = SAB_SHAPE_RING_LAYOUT.recordHeaderBytes;
  bytes.set(encoded.text, cursor);
  cursor += encoded.text.byteLength;
  bytes.set(encoded.family, cursor);
  cursor += encoded.family.byteLength;
  bytes.set(encoded.metadata, cursor);
  cursor = encoded.variableOffset;
  cursor = writeUint32Array(buffer, byteOffset + cursor, run.glyphIds) - byteOffset;
  cursor = writeUint32Array(buffer, byteOffset + cursor, run.clusters) - byteOffset;
  if (run.clusterEnds !== undefined) {
    cursor = writeUint32Array(buffer, byteOffset + cursor, run.clusterEnds) - byteOffset;
  }
  cursor = writeFloat32Array(buffer, byteOffset + cursor, run.x) - byteOffset;
  cursor = writeFloat32Array(buffer, byteOffset + cursor, run.y) - byteOffset;
  cursor = writeFloat32Array(buffer, byteOffset + cursor, run.xAdvance) - byteOffset;
  cursor = writeFloat32Array(buffer, byteOffset + cursor, run.yAdvance) - byteOffset;
  writeUint32Array(buffer, byteOffset + cursor, run.lineIndices);
}

function writeUint32Array(
  buffer: SharedArrayBuffer,
  byteOffset: number,
  values: ArrayLike<number>,
): number {
  new Uint32Array(buffer, byteOffset, values.length).set(values);
  return byteOffset + values.length * Uint32Array.BYTES_PER_ELEMENT;
}

function writeFloat32Array(
  buffer: SharedArrayBuffer,
  byteOffset: number,
  values: ArrayLike<number>,
): number {
  new Float32Array(buffer, byteOffset, values.length).set(values);
  return byteOffset + values.length * Float32Array.BYTES_PER_ELEMENT;
}

function readResult(
  buffer: SharedArrayBuffer,
  byteOffset: number,
  recordBytes: number,
  slotGlyphCount: number,
): Readonly<ShapeResultResponse> {
  if (
    recordBytes < SAB_SHAPE_RING_LAYOUT.recordHeaderBytes ||
    recordBytes > buffer.byteLength - byteOffset
  ) {
    throw new RangeError("Shared shape record byte length is invalid");
  }
  const view = new DataView(buffer, byteOffset, recordBytes);
  if (view.getUint32(RecordOffset.Magic, true) !== RECORD_MAGIC) {
    throw new TypeError("Shared shape record magic is invalid");
  }
  if (view.getUint32(RecordOffset.Version, true) !== RECORD_VERSION) {
    throw new TypeError("Shared shape record version is unsupported");
  }
  const glyphCount = view.getUint32(RecordOffset.GlyphCount, true);
  if (glyphCount !== slotGlyphCount) {
    throw new Error("Shared shape record glyph count is inconsistent");
  }
  const textBytes = view.getUint32(RecordOffset.TextBytes, true);
  const familyBytes = view.getUint32(RecordOffset.FamilyBytes, true);
  const metadataBytes = view.getUint32(RecordOffset.MetadataBytes, true);
  const flags = view.getUint32(RecordOffset.Flags, true);
  if ((flags & ~SUPPORTED_RECORD_FLAGS) !== 0) {
    throw new TypeError("Shared shape record flags are unsupported");
  }
  const stringEnd =
    SAB_SHAPE_RING_LAYOUT.recordHeaderBytes + textBytes + familyBytes + metadataBytes;
  const arrayOffset = align(stringEnd, SAB_SHAPE_RING_LAYOUT.alignment);
  const columnCount = 7 + ((flags & CLUSTER_ENDS_FLAG) === 0 ? 0 : 1);
  const expectedBytes = arrayOffset + glyphCount * columnCount * Uint32Array.BYTES_PER_ELEMENT;
  if (expectedBytes !== recordBytes) {
    throw new RangeError("Shared shape record sections exceed the published record length");
  }
  let cursor = SAB_SHAPE_RING_LAYOUT.recordHeaderBytes;
  const text = decodeString(buffer, byteOffset + cursor, textBytes);
  cursor += textBytes;
  const fontFamily = decodeString(buffer, byteOffset + cursor, familyBytes);
  cursor += familyBytes;
  const metadataJson = decodeString(buffer, byteOffset + cursor, metadataBytes);
  const metadata = parseMetadata(metadataJson, flags, glyphCount);
  cursor = arrayOffset;
  const glyphIds = new Uint32Array(buffer, byteOffset + cursor, glyphCount);
  cursor += glyphCount * 4;
  const clusters = new Uint32Array(buffer, byteOffset + cursor, glyphCount);
  cursor += glyphCount * 4;
  const clusterEnds =
    (flags & CLUSTER_ENDS_FLAG) === 0
      ? undefined
      : new Uint32Array(buffer, byteOffset + cursor, glyphCount);
  if (clusterEnds !== undefined) cursor += glyphCount * 4;
  const x = new Float32Array(buffer, byteOffset + cursor, glyphCount);
  cursor += glyphCount * 4;
  const y = new Float32Array(buffer, byteOffset + cursor, glyphCount);
  cursor += glyphCount * 4;
  const xAdvance = new Float32Array(buffer, byteOffset + cursor, glyphCount);
  cursor += glyphCount * 4;
  const yAdvance = new Float32Array(buffer, byteOffset + cursor, glyphCount);
  cursor += glyphCount * 4;
  const lineIndices = new Uint32Array(buffer, byteOffset + cursor, glyphCount);
  const fontRevision = view.getFloat64(RecordOffset.FontRevision, true);
  const direction = view.getUint32(RecordOffset.Direction, true);
  if (direction > 1) throw new TypeError("Shared shape record direction is invalid");
  const requestId = view.getFloat64(RecordOffset.RequestId, true);
  const labelId = view.getFloat64(RecordOffset.LabelId, true);
  const sourceRevision = view.getFloat64(RecordOffset.SourceRevision, true);
  assertSafeInteger("requestId", requestId);
  assertSafeInteger("labelId", labelId);
  assertSafeInteger("sourceRevision", sourceRevision);
  assertSafeInteger("fontRevision", fontRevision);
  const run: SerializedPositionedRun = Object.freeze({
    source: "harfbuzz",
    text,
    fontFamily,
    fontRevision,
    glyphCount,
    direction: direction === 1 ? "rtl" : "ltr",
    glyphIds,
    clusters,
    ...(clusterEnds === undefined ? {} : { clusterEnds }),
    ...(metadata.variationKey === undefined ? {} : { variationKey: metadata.variationKey }),
    x,
    y,
    xAdvance,
    yAdvance,
    lineIndices,
    ...(metadata.glyphKeys === undefined ? {} : { glyphKeys: metadata.glyphKeys }),
    bounds: Object.freeze({
      x: view.getFloat64(RecordOffset.BoundsX, true),
      y: view.getFloat64(RecordOffset.BoundsY, true),
      width: view.getFloat64(RecordOffset.BoundsWidth, true),
      height: view.getFloat64(RecordOffset.BoundsHeight, true),
    }),
  });

  return Object.freeze({
    type: "shape-result",
    requestId,
    labelId,
    sourceRevision,
    fontRevision,
    run,
  });
}

function createLease(
  result: Readonly<ShapeResultResponse>,
  onRelease: () => void,
): SabShapeResultLease {
  let released = false;

  return {
    result,
    get released() {
      return released;
    },
    release() {
      if (released) return;
      released = true;
      onRelease();
    },
  };
}

interface ShapeRecordMetadata {
  readonly glyphKeys?: readonly string[];
  readonly variationKey?: string;
}

function parseMetadata(
  value: string,
  flags: number,
  glyphCount: number,
): Readonly<ShapeRecordMetadata> {
  const metadataFlags = flags & (GLYPH_KEYS_FLAG | VARIATION_KEY_FLAG);
  if (metadataFlags === 0) {
    if (value.length !== 0) throw new TypeError("Shared shape record metadata is unexpected");
    return Object.freeze({});
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Shared shape record metadata is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const glyphKeys = record.glyphKeys;
  const variationKey = record.variationKey;
  if (
    (flags & GLYPH_KEYS_FLAG) !== 0 &&
    (!Array.isArray(glyphKeys) ||
      glyphKeys.length !== glyphCount ||
      glyphKeys.some((entry) => typeof entry !== "string"))
  ) {
    throw new TypeError("Shared shape glyphKeys are invalid");
  }
  if ((flags & GLYPH_KEYS_FLAG) === 0 && glyphKeys !== undefined) {
    throw new TypeError("Shared shape glyphKeys flag is missing");
  }
  if ((flags & VARIATION_KEY_FLAG) !== 0 && typeof variationKey !== "string") {
    throw new TypeError("Shared shape variationKey is invalid");
  }
  if ((flags & VARIATION_KEY_FLAG) === 0 && variationKey !== undefined) {
    throw new TypeError("Shared shape variationKey flag is missing");
  }

  return Object.freeze({
    ...((flags & GLYPH_KEYS_FLAG) === 0 ? {} : { glyphKeys: Object.freeze(glyphKeys as string[]) }),
    ...((flags & VARIATION_KEY_FLAG) === 0 ? {} : { variationKey: variationKey as string }),
  });
}

function decodeString(buffer: SharedArrayBuffer, byteOffset: number, byteLength: number): string {
  return decoder.decode(new Uint8Array(buffer, byteOffset, byteLength).slice());
}

function runtimeCapabilityScope(): Readonly<SabShapeCapabilityScope> {
  return {
    SharedArrayBuffer: typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer,
    Atomics: typeof Atomics === "undefined" ? undefined : Atomics,
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === "boolean"
        ? globalThis.crossOriginIsolated
        : undefined,
  };
}

interface AtomicsWaitAsyncResult {
  readonly async: boolean;
  readonly value: string | Promise<string>;
}

type AtomicsWaitAsync = (array: Int32Array, index: number, value: number) => AtomicsWaitAsyncResult;

async function waitForAtomicChange(
  array: Int32Array,
  index: number,
  expected: number,
): Promise<void> {
  const waitAsync = (Atomics as unknown as { readonly waitAsync?: AtomicsWaitAsync }).waitAsync;
  if (waitAsync !== undefined) {
    const result = waitAsync(array, index, expected);
    await result.value;
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be a safe integer greater than or equal to ${String(minimum)}`,
    );
  }
}

function assertSafeInteger(name: string, value: number): void {
  assertInteger(name, value, 0);
}

function assertPowerOfTwoSlotCount(value: number): void {
  if (!Number.isInteger(Math.log2(value)) || value > 0x4000_0000) {
    throw new RangeError("slotCount must be a power of two representable by the ring header");
  }
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
