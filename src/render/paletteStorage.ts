import { planComputeCullStorageBytes } from "../culling/computeCull";

export type PalettePath = "texture" | "storage";

/** Fill-only record floats. Matches `TRANSFORM_PALETTE_STRIDE / 4`. */
export const PALETTE_ORIGIN_FLOATS = 8;
export const PALETTE_PATCH_WORKGROUP = 256;

/** One move command: slot, x, y, pad. After the first full upload the GPU table owns x/y. */
export const PALETTE_MOVE_STRIDE = 16;
export const PALETTE_MOVE_WORDS = PALETTE_MOVE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
export const PALETTE_MOVE_UNIFORM_BYTES = 16;

export interface PalettePathInput {
  readonly adapter: "webgl" | "webgpu" | "unknown" | "detached";
  readonly maxStorageBuffersInVertexStage: number;
  readonly maxStorageBufferBindingSize: number;
  readonly paletteBytes: number;
}

export interface PaletteMoveUpload {
  readonly commands: ArrayBuffer;
  readonly count: number;
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

/** Bytes for one packed move-command upload. Sparse and dense storms share this size. */
export function paletteMoveUploadBytes(count: number): number {
  if (count <= 0) return 0;
  return count * PALETTE_MOVE_STRIDE;
}

/** Command buffer plus the move-count uniform. Camera-only frames stay at 0. */
export function paletteMoveDispatchBytes(count: number): number {
  if (count <= 0) return 0;
  return paletteMoveUploadBytes(count) + PALETTE_MOVE_UNIFORM_BYTES;
}

/**
 * Pack `slot`, `x`, `y` into 16-byte commands. `destIndex` is a command index so lane and content
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
export function applyPaletteMoves(
  data: Float32Array,
  commands: ArrayBuffer,
  count: number,
): number {
  const needed = paletteMoveUploadBytes(count);
  if (needed > commands.byteLength) {
    throw new RangeError("palette move command buffer is shorter than the packed count");
  }
  const uints = new Uint32Array(commands);
  const floats = new Float32Array(commands);
  const floatsPerLabel = PALETTE_ORIGIN_FLOATS;
  let written = 0;
  for (let index = 0; index < count; index += 1) {
    const base = index * PALETTE_MOVE_WORDS;
    const slot = uints[base] ?? 0;
    const offset = slot * floatsPerLabel;
    if (offset + 1 >= data.length) continue;
    const nextX = floats[base + 1] ?? 0;
    const nextY = floats[base + 2] ?? 0;
    if (data[offset] === nextX && data[offset + 1] === nextY) continue;
    data[offset] = nextX;
    data[offset + 1] = nextY;
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
