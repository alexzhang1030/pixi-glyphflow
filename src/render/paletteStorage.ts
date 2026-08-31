import { CULL_RECORD_STRIDE, planComputeCullStorageBytes } from "../culling/computeCull";
import { packHalf2x16, unpackF16 } from "./pack";

export type PalettePath = "texture" | "storage";

/** Fill-only record floats. Matches `TRANSFORM_PALETTE_STRIDE / 4`. */
export const PALETTE_ORIGIN_FLOATS = 8;
export const PALETTE_PATCH_WORKGROUP = 256;

export type PalettePositionMoveMode = "dense" | "indexed";
export type PaletteMoveMode = PalettePositionMoveMode | "dense-transform" | "indexed-transform";

/** Dense exact-f32 move command: x, y. The 16-byte header supplies the first slot. */
export const PALETTE_DENSE_MOVE_STRIDE = 8;
export const PALETTE_DENSE_MOVE_WORDS: number =
  PALETTE_DENSE_MOVE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
/** Indexed exact-f32 fallback command: slot, x, y. */
export const PALETTE_INDEXED_MOVE_STRIDE = 12;
/** Frozen indexed mover ABI alias retained for existing internal callers and historical evidence. */
export const PALETTE_MOVE_STRIDE: number = PALETTE_INDEXED_MOVE_STRIDE;
export const PALETTE_MOVE_WORDS: number = PALETTE_MOVE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
/** Dense transform command: exact-f32 x/y and packed binary16 sin/cos. */
export const PALETTE_DENSE_TRANSFORM_MOVE_STRIDE = 12;
export const PALETTE_DENSE_TRANSFORM_MOVE_WORDS: number =
  PALETTE_DENSE_TRANSFORM_MOVE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
/** Indexed transform command: slot, exact-f32 x/y, and packed binary16 sin/cos. */
export const PALETTE_INDEXED_TRANSFORM_MOVE_STRIDE = 16;
export const PALETTE_INDEXED_TRANSFORM_MOVE_WORDS: number =
  PALETTE_INDEXED_TRANSFORM_MOVE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
export const PALETTE_MOVE_UNIFORM_BYTES = 16;
/** Shared resident local bounds: x, y, width, height. */
export const RESIDENT_LOCAL_BOUNDS_STRIDE = 16;
/** One active transform command: slot header, two core texels, and one optional effect texel. */
export const PALETTE_TRANSFORM_COMMAND_STRIDE = 64;
/** Bound reusable command storage independently from the much larger transform table. */
export const PALETTE_TRANSFORM_SCATTER_MAX_COMMAND_BYTES: number = 16 * 1_024 * 1_024;
export const PALETTE_TRANSFORM_SCATTER_MAX_LABELS: number =
  PALETTE_TRANSFORM_SCATTER_MAX_COMMAND_BYTES / PALETTE_TRANSFORM_COMMAND_STRIDE;
/** Conservative dispatch setup expressed as equivalent direct-upload bytes for the cost planner. */
export const PALETTE_TRANSFORM_SCATTER_FIXED_COST_BYTES: number = 64 * 1_024;
const PALETTE_TRANSFORM_COMMAND_WORDS =
  PALETTE_TRANSFORM_COMMAND_STRIDE / Uint32Array.BYTES_PER_ELEMENT;

export interface PalettePathInput {
  readonly adapter: "webgl" | "webgpu" | "unknown" | "detached";
  readonly maxStorageBuffersInVertexStage: number;
  readonly maxStorageBufferBindingSize: number;
  readonly paletteBytes: number;
}

interface PaletteMoveUploadBase {
  readonly commands: ArrayBuffer;
  readonly count: number;
}

export interface PaletteDenseMoveUpload extends PaletteMoveUploadBase {
  readonly mode: "dense";
  readonly baseSlot: number;
}

export interface PaletteIndexedMoveUpload extends PaletteMoveUploadBase {
  readonly mode: "indexed";
}

export interface PaletteDenseTransformMoveUpload extends PaletteMoveUploadBase {
  readonly mode: "dense-transform";
  readonly baseSlot: number;
}

export interface PaletteIndexedTransformMoveUpload extends PaletteMoveUploadBase {
  readonly mode: "indexed-transform";
}

export type PaletteMoveUpload =
  | PaletteDenseMoveUpload
  | PaletteIndexedMoveUpload
  | PaletteDenseTransformMoveUpload
  | PaletteIndexedTransformMoveUpload;

interface ResidentPaletteMoveReferenceBase {
  readonly transforms: Float32Array;
  readonly records: ArrayBuffer;
  readonly recordCount: number;
  readonly localBounds: Float32Array;
  readonly localBoundsCount: number;
}

export type ResidentPaletteMoveReferenceInput = ResidentPaletteMoveReferenceBase &
  PaletteMoveUpload;

export interface ResidentPaletteMoveReferenceResult {
  readonly transformsPatched: number;
  readonly recordsPatched: number;
  readonly cullRecordUploadBytes: 0;
}

export interface PaletteTransformUploadPlan {
  readonly mode: "ranges" | "scatter";
  readonly dirtyBytes: number;
  readonly scatterUploadBytes: number;
  readonly scatterCostBytes: number;
}

/** WebGPU storage palette when the vertex stage can bind the table. WebGL stays on the texture. */
export function resolvePalettePath(input: PalettePathInput): PalettePath {
  if (input.adapter !== "webgpu") return "texture";
  if (input.maxStorageBuffersInVertexStage < 1) return "texture";
  if (input.paletteBytes <= 0) return "texture";
  if (
    planComputeCullStorageBytes(input.paletteBytes, input.maxStorageBufferBindingSize) === undefined
  ) {
    return "texture";
  }
  return "storage";
}

/**
 * Storage WGSL and the CPU skip are only valid once the GPU table exists. A requested storage path
 * with no bound buffer stays on the texture shader.
 */
export function readyPalettePath(requested: PalettePath, storageReady: boolean): PalettePath {
  switch (requested) {
    case "texture":
      return "texture";
    case "storage":
      return storageReady ? "storage" : "texture";
    default: {
      const _exhaustive: never = requested;
      return _exhaustive;
    }
  }
}

/** Position storms on the storage path skip the CPU 32-byte scatter. */
export function shouldWriteCpuPalettePositions(path: PalettePath): boolean {
  switch (path) {
    case "texture":
      return true;
    case "storage":
      return false;
    default: {
      const _exhaustive: never = path;
      return _exhaustive;
    }
  }
}

/** Bytes for one mode-specific exact-f32 command upload. */
export function paletteMoveUploadBytes(mode: PaletteMoveMode, count: number): number {
  assertMoveCount(count);
  if (count === 0) return 0;
  const bytes = count * paletteMoveStride(mode);
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("palette move upload byte length exceeds safe integer capacity");
  }
  return bytes;
}

/** Command buffer plus the move-count uniform. Camera-only frames stay at 0. */
export function paletteMoveDispatchBytes(mode: PaletteMoveMode, count: number): number {
  const commandBytes = paletteMoveUploadBytes(mode, count);
  if (commandBytes === 0) return 0;
  return commandBytes + PALETTE_MOVE_UNIFORM_BYTES;
}

export function residentLocalBoundsBytes(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("resident local-bounds count must be a non-negative safe integer");
  }
  return count * RESIDENT_LOCAL_BOUNDS_STRIDE;
}

/** Exact packed rotation shared by CPU setup, compact commands, culling, and vertex transforms. */
export function packResidentRotation(rotation: number): number {
  if (rotation === 0) return 0x3c00_0000;
  return packHalf2x16(Math.fround(Math.sin(rotation)), Math.fround(Math.cos(rotation)));
}

/** Write one absolute AABB with the same left-associated f32 additions as WGSL. */
export function writeResidentAabbF32(
  records: Float32Array,
  base: number,
  x: number,
  y: number,
  localX: number,
  localY: number,
  width: number,
  height: number,
): void {
  const minX = Math.fround(Math.fround(x) + Math.fround(localX));
  const minY = Math.fround(Math.fround(y) + Math.fround(localY));
  records[base] = minX;
  records[base + 1] = minY;
  records[base + 2] = Math.fround(minX + Math.fround(width));
  records[base + 3] = Math.fround(minY + Math.fround(height));
}

/** Write a rotated absolute AABB from the packed sin/cos consumed by the resident vertex shader. */
export function writeResidentRotatedAabbF32(
  records: Float32Array,
  base: number,
  x: number,
  y: number,
  localX: number,
  localY: number,
  width: number,
  height: number,
  packedRotation: number,
): void {
  const sin = unpackF16(packedRotation);
  const cos = unpackF16(packedRotation >>> 16);
  if (sin === 0 && cos === 1) {
    writeResidentAabbF32(records, base, x, y, localX, localY, width, height);
    return;
  }
  const left = Math.fround(localX);
  const top = Math.fround(localY);
  const right = Math.fround(left + Math.fround(width));
  const bottom = Math.fround(top + Math.fround(height));
  const originX = Math.fround(x);
  const originY = Math.fround(y);
  const leftCos = Math.fround(left * cos);
  const leftSin = Math.fround(left * sin);
  const rightCos = Math.fround(right * cos);
  const rightSin = Math.fround(right * sin);
  const topCos = Math.fround(top * cos);
  const topSin = Math.fround(top * sin);
  const bottomCos = Math.fround(bottom * cos);
  const bottomSin = Math.fround(bottom * sin);
  const x0 = Math.fround(originX + Math.fround(leftCos - topSin));
  const y0 = Math.fround(originY + Math.fround(leftSin + topCos));
  const x1 = Math.fround(originX + Math.fround(rightCos - topSin));
  const y1 = Math.fround(originY + Math.fround(rightSin + topCos));
  const x2 = Math.fround(originX + Math.fround(rightCos - bottomSin));
  const y2 = Math.fround(originY + Math.fround(rightSin + bottomCos));
  const x3 = Math.fround(originX + Math.fround(leftCos - bottomSin));
  const y3 = Math.fround(originY + Math.fround(leftSin + bottomCos));
  records[base] = Math.min(x0, x1, x2, x3);
  records[base + 1] = Math.min(y0, y1, y2, y3);
  records[base + 2] = Math.max(x0, x1, x2, x3);
  records[base + 3] = Math.max(y0, y1, y2, y3);
}

/** Host reference for the fused palette-origin and absolute resident-AABB patch. */
export function applyResidentPaletteMoves(
  input: Readonly<ResidentPaletteMoveReferenceInput>,
): Readonly<ResidentPaletteMoveReferenceResult> {
  const recordWords = CULL_RECORD_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
  if (input.records.byteLength < input.recordCount * CULL_RECORD_STRIDE) {
    throw new RangeError("resident cull records are shorter than recordCount");
  }
  if (input.localBounds.length < input.localBoundsCount * 4) {
    throw new RangeError("resident local bounds are shorter than localBoundsCount");
  }
  const commandBytes = paletteMoveUploadBytes(input.mode, input.count);
  if (input.commands.byteLength < commandBytes) {
    throw new RangeError("resident move commands are shorter than count");
  }
  assertMoveRange(input);
  const recordFloats = new Float32Array(input.records);
  const recordUints = new Uint32Array(input.records);
  const commandUints = new Uint32Array(input.commands);
  const commandFloats = new Float32Array(input.commands);
  const transformUints = new Uint32Array(
    input.transforms.buffer,
    input.transforms.byteOffset,
    input.transforms.length,
  );
  const transformCapacity = Math.floor(input.transforms.length / PALETTE_ORIGIN_FLOATS);
  let transformsPatched = 0;
  let recordsPatched = 0;
  for (let index = 0; index < input.count; index += 1) {
    const dense = input.mode === "dense" || input.mode === "dense-transform";
    const transform = input.mode === "dense-transform" || input.mode === "indexed-transform";
    const commandBase = index * paletteMoveWords(input.mode);
    const slot = dense ? input.baseSlot + index : (commandUints[commandBase] ?? 0);
    const x = commandFloats[commandBase + (dense ? 0 : 1)] ?? 0;
    const y = commandFloats[commandBase + (dense ? 1 : 2)] ?? 0;
    const rotation = transform ? (commandUints[commandBase + (dense ? 2 : 3)] ?? 0) : undefined;
    let packedRotation = 0;
    if (slot < transformCapacity) {
      const transformBase = slot * PALETTE_ORIGIN_FLOATS;
      input.transforms[transformBase] = x;
      input.transforms[transformBase + 1] = y;
      if (rotation !== undefined) {
        transformUints[transformBase + 4] = rotation;
      }
      packedRotation = transformUints[transformBase + 4] ?? 0;
      transformsPatched += 1;
    }
    if (slot >= input.recordCount) continue;
    const recordBase = slot * recordWords;
    const boundsIndex = recordUints[recordBase + 7] ?? 0;
    if (boundsIndex >= input.localBoundsCount) continue;
    const boundsBase = boundsIndex * 4;
    const localX = input.localBounds[boundsBase] ?? 0;
    const localY = input.localBounds[boundsBase + 1] ?? 0;
    const width = input.localBounds[boundsBase + 2] ?? 0;
    const height = input.localBounds[boundsBase + 3] ?? 0;
    writeResidentRotatedAabbF32(
      recordFloats,
      recordBase,
      x,
      y,
      localX,
      localY,
      width,
      height,
      packedRotation,
    );
    recordsPatched += 1;
  }
  return Object.freeze({ transformsPatched, recordsPatched, cullRecordUploadBytes: 0 });
}

/** Bytes submitted by one active-transform scatter, excluding its fixed dispatch cost model. */
export function paletteTransformDispatchBytes(count: number): number {
  if (count <= 0) return 0;
  return count * PALETTE_TRANSFORM_COMMAND_STRIDE + PALETTE_MOVE_UNIFORM_BYTES;
}

/** Compare compact scatter upload plus dispatch cost against direct dirty-range bytes. */
export function planPaletteTransformUpload(
  ranges: readonly Readonly<{ readonly offset: number; readonly length: number }>[],
  activeLabels: number,
): Readonly<PaletteTransformUploadPlan> {
  if (!Number.isSafeInteger(activeLabels) || activeLabels < 0) {
    throw new TypeError("activeLabels must be a non-negative safe integer");
  }
  let dirtyBytes = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
      throw new TypeError("palette dirty offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(range.length) || range.length < 0) {
      throw new TypeError("palette dirty length must be a non-negative safe integer");
    }
    dirtyBytes += range.length;
  }
  const scatterUploadBytes = paletteTransformDispatchBytes(activeLabels);
  const scatterCostBytes =
    scatterUploadBytes === 0
      ? Number.POSITIVE_INFINITY
      : scatterUploadBytes + PALETTE_TRANSFORM_SCATTER_FIXED_COST_BYTES;
  const commandBytes = activeLabels * PALETTE_TRANSFORM_COMMAND_STRIDE;
  const mode =
    commandBytes <= PALETTE_TRANSFORM_SCATTER_MAX_COMMAND_BYTES && scatterCostBytes < dirtyBytes
      ? "scatter"
      : "ranges";
  return Object.freeze({ mode, dirtyBytes, scatterUploadBytes, scatterCostBytes });
}

/** Pack complete active transform records for one GPU scatter dispatch. */
export function packPaletteTransforms(
  dest: ArrayBuffer,
  data: Float32Array,
  slots: Uint32Array,
  count: number,
  effectBase: number,
  originX?: Float32Array,
  originY?: Float32Array,
): number {
  assertTransformPackInput(dest, data, slots, count, effectBase, originX, originY);
  const uints = new Uint32Array(dest);
  const floats = new Float32Array(dest);
  const hasEffects = effectBase > 0;
  const capacity = hasEffects ? effectBase / 2 : Math.floor(data.length / PALETTE_ORIGIN_FLOATS);
  let written = 0;
  for (let index = 0; index < count; index += 1) {
    const slot = slots[index] ?? 0;
    if (slot >= capacity) continue;
    const commandBase = written * PALETTE_TRANSFORM_COMMAND_WORDS;
    const coreBase = slot * PALETTE_ORIGIN_FLOATS;
    uints[commandBase] = slot;
    floats.set(data.subarray(coreBase, coreBase + PALETTE_ORIGIN_FLOATS), commandBase + 4);
    if (originX !== undefined && originY !== undefined) {
      floats[commandBase + 4] = originX[slot] ?? 0;
      floats[commandBase + 5] = originY[slot] ?? 0;
    }
    if (hasEffects) {
      const effectOffset = effectBase * 4 + slot * 4;
      floats.set(data.subarray(effectOffset, effectOffset + 4), commandBase + 12);
    } else {
      floats.fill(0, commandBase + 12, commandBase + 16);
    }
    written += 1;
  }
  return written;
}

/** Apply packed active transforms to a CPU mirror of the storage table. */
export function applyPaletteTransforms(
  data: Float32Array,
  commands: ArrayBuffer,
  count: number,
  effectBase: number,
): number {
  if (!(data instanceof Float32Array)) {
    throw new TypeError("palette transform data must be a Float32Array");
  }
  if (!(commands instanceof ArrayBuffer)) {
    throw new TypeError("palette transform commands must be an ArrayBuffer");
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("palette transform count must be a non-negative safe integer");
  }
  if (commands.byteLength < count * PALETTE_TRANSFORM_COMMAND_STRIDE) {
    throw new RangeError("palette transform command buffer is shorter than the packed count");
  }
  assertEffectBase(data, effectBase);
  const uints = new Uint32Array(commands);
  const floats = new Float32Array(commands);
  const hasEffects = effectBase > 0;
  const capacity = hasEffects ? effectBase / 2 : Math.floor(data.length / PALETTE_ORIGIN_FLOATS);
  let written = 0;
  for (let index = 0; index < count; index += 1) {
    const commandBase = index * PALETTE_TRANSFORM_COMMAND_WORDS;
    const slot = uints[commandBase] ?? 0;
    if (slot >= capacity) continue;
    const coreBase = slot * PALETTE_ORIGIN_FLOATS;
    data.set(floats.subarray(commandBase + 4, commandBase + 12), coreBase);
    if (hasEffects) {
      data.set(floats.subarray(commandBase + 12, commandBase + 16), effectBase * 4 + slot * 4);
    }
    written += 1;
  }
  return written;
}

/**
 * Pack `slot`, `x`, `y` into 12-byte commands. `destIndex` is a command index so lane and content
 * movers can share one buffer. Out-of-range slots are skipped.
 */
export function packPaletteMoves(
  dest: ArrayBuffer,
  destIndex: number,
  slots: Uint32Array,
  count: number,
  originX: Float32Array,
  originY: Float32Array,
): number {
  if (count <= 0) return 0;
  if (destIndex < 0) {
    throw new RangeError("palette move destIndex must be a non-negative command index");
  }
  const needed = (destIndex + count) * PALETTE_MOVE_STRIDE;
  if (needed > dest.byteLength) {
    throw new RangeError("palette move command buffer is shorter than the packed count");
  }
  const uints = new Uint32Array(dest);
  const floats = new Float32Array(dest);
  const originLimit = Math.min(originX.length, originY.length);
  let written = 0;
  for (let index = 0; index < count; index += 1) {
    const slot = slots[index] ?? 0;
    if (slot >= originLimit) continue;
    const base = (destIndex + written) * PALETTE_MOVE_WORDS;
    uints[base] = slot;
    floats[base + 1] = originX[slot] ?? 0;
    floats[base + 2] = originY[slot] ?? 0;
    written += 1;
  }
  return written;
}

/** Apply packed move commands to CPU fill records. Used as the host reference for `patch_xy`. */
export function applyPaletteMoves(data: Float32Array, move: Readonly<PaletteMoveUpload>): number {
  const needed = paletteMoveUploadBytes(move.mode, move.count);
  if (needed > move.commands.byteLength) {
    throw new RangeError("palette move command buffer is shorter than the packed count");
  }
  assertMoveRange(move);
  const uints = new Uint32Array(move.commands);
  const floats = new Float32Array(move.commands);
  const dataUints = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const floatsPerLabel = PALETTE_ORIGIN_FLOATS;
  let written = 0;
  for (let index = 0; index < move.count; index += 1) {
    const dense = move.mode === "dense" || move.mode === "dense-transform";
    const transform = move.mode === "dense-transform" || move.mode === "indexed-transform";
    const base = index * paletteMoveWords(move.mode);
    const slot = dense ? move.baseSlot + index : (uints[base] ?? 0);
    const offset = slot * floatsPerLabel;
    if (offset + (transform ? 4 : 1) >= data.length) continue;
    const nextX = floats[base + (dense ? 0 : 1)] ?? 0;
    const nextY = floats[base + (dense ? 1 : 2)] ?? 0;
    const rotation = transform ? (uints[base + (dense ? 2 : 3)] ?? 0) : undefined;
    const rotationBits = rotation === undefined ? (dataUints[offset + 4] ?? 0) : rotation;
    if (
      data[offset] === nextX &&
      data[offset + 1] === nextY &&
      (!transform || dataUints[offset + 4] === rotationBits)
    ) {
      continue;
    }
    data[offset] = nextX;
    data[offset + 1] = nextY;
    if (transform) dataUints[offset + 4] = rotationBits;
    written += 1;
  }
  return written;
}

/** Copy occupied palette x/y from store columns. Used only when a storage buffer must rebuild. */
export function refreshPaletteOrigins(
  data: Float32Array,
  occupied: Uint8Array,
  originX: Float32Array,
  originY: Float32Array,
  highWater: number,
): number {
  const floatsPerLabel = PALETTE_ORIGIN_FLOATS;
  const limit = Math.min(highWater, occupied.length, originX.length, originY.length);
  let written = 0;
  for (let slot = 0; slot < limit; slot += 1) {
    if (occupied[slot] !== 1) continue;
    const offset = slot * floatsPerLabel;
    if (offset + 1 >= data.length) continue;
    data[offset] = originX[slot] ?? 0;
    data[offset + 1] = originY[slot] ?? 0;
    written += 1;
  }
  return written;
}

function paletteMoveStride(mode: PaletteMoveMode): number {
  switch (mode) {
    case "dense":
      return PALETTE_DENSE_MOVE_STRIDE;
    case "indexed":
      return PALETTE_INDEXED_MOVE_STRIDE;
    case "dense-transform":
      return PALETTE_DENSE_TRANSFORM_MOVE_STRIDE;
    case "indexed-transform":
      return PALETTE_INDEXED_TRANSFORM_MOVE_STRIDE;
    default: {
      const _exhaustive: never = mode;
      throw new TypeError(`Unsupported palette move mode: ${String(_exhaustive)}`);
    }
  }
}

function paletteMoveWords(mode: PaletteMoveMode): number {
  return paletteMoveStride(mode) / Uint32Array.BYTES_PER_ELEMENT;
}

function assertMoveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("palette move count must be a non-negative safe integer");
  }
}

function assertMoveRange(move: Readonly<PaletteMoveUpload>): void {
  if (!(move.commands instanceof ArrayBuffer)) {
    throw new TypeError("palette move commands must be an ArrayBuffer");
  }
  assertMoveCount(move.count);
  if (move.mode !== "dense" && move.mode !== "dense-transform") return;
  if (!Number.isSafeInteger(move.baseSlot) || move.baseSlot < 0 || move.baseSlot > 0xffff_ffff) {
    throw new TypeError("dense palette move baseSlot must be a uint32 safe integer");
  }
  const end = move.baseSlot + move.count;
  if (!Number.isSafeInteger(end) || end > 0x1_0000_0000) {
    throw new RangeError("dense palette move slot range exceeds uint32 capacity");
  }
}

function assertTransformPackInput(
  dest: ArrayBuffer,
  data: Float32Array,
  slots: Uint32Array,
  count: number,
  effectBase: number,
  originX: Float32Array | undefined,
  originY: Float32Array | undefined,
): void {
  if (!(dest instanceof ArrayBuffer)) {
    throw new TypeError("palette transform destination must be an ArrayBuffer");
  }
  if (!(data instanceof Float32Array)) {
    throw new TypeError("palette transform data must be a Float32Array");
  }
  if (!(slots instanceof Uint32Array)) {
    throw new TypeError("palette transform slots must be a Uint32Array");
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > slots.length) {
    throw new RangeError("palette transform count exceeds the slot list");
  }
  if (dest.byteLength < count * PALETTE_TRANSFORM_COMMAND_STRIDE) {
    throw new RangeError("palette transform destination is shorter than the packed count");
  }
  if ((originX === undefined) !== (originY === undefined)) {
    throw new TypeError("palette transform origins must provide both x and y columns");
  }
  if (
    originX !== undefined &&
    (!(originX instanceof Float32Array) || !(originY instanceof Float32Array))
  ) {
    throw new TypeError("palette transform origins must be Float32Array columns");
  }
  assertEffectBase(data, effectBase);
}

function assertEffectBase(data: Float32Array, effectBase: number): void {
  if (!Number.isSafeInteger(effectBase) || effectBase < 0 || effectBase % 2 !== 0) {
    throw new TypeError("palette effectBase must be a non-negative even texel index");
  }
  if (effectBase === 0) return;
  const capacity = effectBase / 2;
  if (effectBase * 4 + capacity * 4 > data.length) {
    throw new RangeError("palette effect region exceeds the transform data");
  }
}
