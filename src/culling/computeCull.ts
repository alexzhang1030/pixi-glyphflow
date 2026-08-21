import { GLYPH_INSTANCE_STRIDE } from "../render/types";
import type { BoundsData } from "./types";

export type CullPath = "cpu-grid" | "compute-cull";
export type CullResidency = "viewport" | "all";

export const CULL_RECORD_STRIDE = 32;
export const CULL_WORKGROUP = 256;
const FLOATS_PER_RECORD = CULL_RECORD_STRIDE / Float32Array.BYTES_PER_ELEMENT;

export interface CullViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly padding: number;
}

export interface CullRecordInput {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly instanceOffset: number;
  readonly instanceCount: number;
}

export interface CompactInstancesResult {
  readonly compact: Uint8Array;
  readonly instanceCount: number;
  readonly indirect: Uint32Array;
}

export interface ResidencyRefreshInput {
  readonly cullPath: CullPath;
  readonly hasLabelChanges: boolean;
  readonly visibilityDirty: boolean;
  readonly instanced: CullViewport | undefined;
  readonly draw: CullViewport | undefined;
}

/**
 * Who is shaped and instanced. The million-label product keeps the CPU viewport set. Compute cull
 * must not switch this to the full world. The instance store caps at 16,777,216 glyphs.
 */
export function cullResidency(cullingEnabled: boolean, hasViewportBounds: boolean): CullResidency {
  return cullingEnabled && hasViewportBounds ? "viewport" : "all";
}

export function resolveCullPath(input: {
  readonly adapter: "webgl" | "webgpu" | "unknown" | "detached";
  readonly computeCull: boolean | "auto";
  readonly deviceReady: boolean;
}): CullPath {
  if (input.computeCull === false || input.adapter !== "webgpu" || !input.deviceReady) {
    return "cpu-grid";
  }
  return "compute-cull";
}

export function shouldRefreshResidency(input: ResidencyRefreshInput): boolean {
  if (input.hasLabelChanges || input.visibilityDirty) return true;
  switch (input.cullPath) {
    case "cpu-grid":
      return true;
    case "compute-cull":
      return (
        input.instanced === undefined ||
        input.draw === undefined ||
        !workingSetContains(input.instanced, input.draw)
      );
    default: {
      const _exhaustive: never = input.cullPath;
      return _exhaustive;
    }
  }
}

export function aabbVisible(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  viewport: CullViewport,
): boolean {
  const left = viewport.x - viewport.padding;
  const top = viewport.y - viewport.padding;
  const right = viewport.x + viewport.width + viewport.padding;
  const bottom = viewport.y + viewport.height + viewport.padding;
  return maxX >= left && minX <= right && maxY >= top && minY <= bottom;
}

export function packCullRecords(records: readonly CullRecordInput[]): ArrayBuffer {
  const buffer = new ArrayBuffer(records.length * CULL_RECORD_STRIDE);
  const floats = new Float32Array(buffer);
  const uints = new Uint32Array(buffer);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const base = index * FLOATS_PER_RECORD;
    floats[base] = record.minX;
    floats[base + 1] = record.minY;
    floats[base + 2] = record.maxX;
    floats[base + 3] = record.maxY;
    uints[base + 4] = record.instanceOffset;
    uints[base + 5] = record.instanceCount;
  }
  return buffer;
}

export function compactVisibleInstances(
  records: ArrayBuffer,
  recordCount: number,
  instances: ArrayBuffer,
  viewport: CullViewport,
): CompactInstancesResult {
  const floats = new Float32Array(records);
  const uints = new Uint32Array(records);
  const counts = new Uint32Array(recordCount);
  let instanceCount = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const base = index * FLOATS_PER_RECORD;
    const visible = aabbVisible(
      floats[base] ?? 0,
      floats[base + 1] ?? 0,
      floats[base + 2] ?? 0,
      floats[base + 3] ?? 0,
      viewport,
    );
    const count = visible ? (uints[base + 5] ?? 0) : 0;
    counts[index] = count;
    instanceCount += count;
  }
  const compact = new Uint8Array(instanceCount * GLYPH_INSTANCE_STRIDE);
  const source = new Uint8Array(instances);
  let write = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const count = counts[index] ?? 0;
    if (count === 0) continue;
    const instanceOffset = uints[index * FLOATS_PER_RECORD + 4] ?? 0;
    const byteLength = count * GLYPH_INSTANCE_STRIDE;
    compact.set(
      source.subarray(
        instanceOffset * GLYPH_INSTANCE_STRIDE,
        instanceOffset * GLYPH_INSTANCE_STRIDE + byteLength,
      ),
      write * GLYPH_INSTANCE_STRIDE,
    );
    write += count;
  }
  return {
    compact,
    instanceCount,
    indirect: createIndirectArgs(instanceCount),
  };
}

export function createIndirectArgs(instanceCount: number): Uint32Array {
  return new Uint32Array([6, instanceCount, 0, 0, 0]);
}

export function viewportFromBounds(bounds: BoundsData, padding: number): CullViewport {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    padding,
  };
}

/** One viewport of travel before the CPU hash grid runs again. */
export function workingSetSlack(viewport: CullViewport): number {
  return Math.max(viewport.width, viewport.height);
}

export function expandWorkingSet(draw: CullViewport, slack: number): CullViewport {
  const pad = draw.padding + slack;
  return {
    x: draw.x - pad,
    y: draw.y - pad,
    width: draw.width + pad * 2,
    height: draw.height + pad * 2,
    padding: 0,
  };
}

export function workingSetContains(instanced: CullViewport, draw: CullViewport): boolean {
  const left = draw.x - draw.padding;
  const top = draw.y - draw.padding;
  const right = draw.x + draw.width + draw.padding;
  const bottom = draw.y + draw.height + draw.padding;
  return (
    left >= instanced.x &&
    top >= instanced.y &&
    right <= instanced.x + instanced.width &&
    bottom <= instanced.y + instanced.height
  );
}
