import { GLYPH_INSTANCE_STRIDE } from "../render/types";
import type { BoundsData } from "./types";

export type CullPath = "cpu-grid" | "compute-cull";
export type CullResidency = "viewport" | "all";

/**
 * Who is shaped and instanced. The million-label product keeps the CPU viewport set. Compute cull
 * must not switch this to the full world — the instance store caps at 16,777,216 glyphs
 * (`0x100_0000`), and 1,000,000 multilingual labels overflow it.
 */
export function cullResidency(cullingEnabled: boolean, hasViewportBounds: boolean): CullResidency {
  return cullingEnabled && hasViewportBounds ? "viewport" : "all";
}

export const CULL_RECORD_STRIDE = 32;
export const CULL_WORKGROUP = 256;

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

/** Axis-aligned test used by both the CPU reference and the WebGPU compute pass. */
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
  const view = new DataView(buffer);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const offset = index * CULL_RECORD_STRIDE;
    view.setFloat32(offset, record.minX, true);
    view.setFloat32(offset + 4, record.minY, true);
    view.setFloat32(offset + 8, record.maxX, true);
    view.setFloat32(offset + 12, record.maxY, true);
    view.setUint32(offset + 16, record.instanceOffset, true);
    view.setUint32(offset + 20, record.instanceCount, true);
  }
  return buffer;
}

/**
 * Compact visible glyph instances in record order (already z then insertion order). This is the CPU
 * reference for the WebGPU prefix-sum + scatter pass.
 */
export function compactVisibleInstances(
  records: ArrayBuffer,
  recordCount: number,
  instances: ArrayBuffer,
  viewport: CullViewport,
): CompactInstancesResult {
  const view = new DataView(records);
  const source = new Uint8Array(instances);
  const counts = new Uint32Array(recordCount);
  let instanceCount = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const offset = index * CULL_RECORD_STRIDE;
    const visible = aabbVisible(
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
      view.getFloat32(offset + 12, true),
      viewport,
    );
    const count = visible ? view.getUint32(offset + 20, true) : 0;
    counts[index] = count;
    instanceCount += count;
  }
  const compact = new Uint8Array(instanceCount * GLYPH_INSTANCE_STRIDE);
  let write = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const count = counts[index] ?? 0;
    if (count === 0) continue;
    const offset = index * CULL_RECORD_STRIDE;
    const instanceOffset = view.getUint32(offset + 16, true);
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
