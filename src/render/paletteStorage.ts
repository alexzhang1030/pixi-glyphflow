import { planComputeCullStorageBytes } from "../culling/computeCull";

export type PalettePath = "texture" | "storage";

/** Fill-only record floats. Matches `TRANSFORM_PALETTE_STRIDE / 4`. */
export const PALETTE_ORIGIN_FLOATS = 8;
export const PALETTE_PATCH_WORKGROUP = 256;

export interface PalettePathInput {
  readonly adapter: "webgl" | "webgpu" | "unknown" | "detached";
  readonly maxStorageBuffersInVertexStage: number;
  readonly maxStorageBufferBindingSize: number;
  readonly paletteBytes: number;
}

export interface PaletteMoveRange {
  readonly minSlot: number;
  readonly maxSlot: number;
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

export function paletteMoveRange(
  slots: Uint32Array,
  count: number,
  capacity: number,
): PaletteMoveRange | undefined {
  if (count <= 0) return undefined;
  let minSlot = 0xffff_ffff;
  let maxSlot = 0;
  let seen = 0;
  for (let index = 0; index < count; index += 1) {
    const slot = slots[index] ?? 0;
    if (slot >= capacity) continue;
    if (slot < minSlot) minSlot = slot;
    if (slot > maxSlot) maxSlot = slot;
    seen += 1;
  }
  if (seen === 0) return undefined;
  return { minSlot, maxSlot };
}

/** Bytes uploaded for origin columns. Dense storms write one span; sparse storms write movers. */
export function originColumnUploadBytes(range: PaletteMoveRange, moverCount = 0): number {
  const spanSlots = range.maxSlot - range.minSlot + 1;
  const spanBytes = spanSlots * Float32Array.BYTES_PER_ELEMENT * 2;
  if (moverCount <= 0 || spanSlots <= moverCount * 4) return spanBytes;
  return moverCount * Float32Array.BYTES_PER_ELEMENT * 2;
}

export function applyPaletteMoves(
  data: Float32Array,
  slots: Uint32Array,
  count: number,
  originX: Float32Array,
  originY: Float32Array,
): number {
  const floatsPerLabel = PALETTE_ORIGIN_FLOATS;
  let written = 0;
  for (let index = 0; index < count; index += 1) {
    const slot = slots[index] ?? 0;
    const offset = slot * floatsPerLabel;
    if (offset + 1 >= data.length) continue;
    const nextX = originX[slot] ?? 0;
    const nextY = originY[slot] ?? 0;
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
