import { describe, expect, test } from "bun:test";

import {
  LABEL_COLLISION_RECORD_STRIDE,
  LABEL_COLLISION_RECORD_WGSL,
  LabelCollisionSelector,
  packLabelCollisionRecords,
  projectLabelCollisionAabb,
  writeLabelCollisionRecordAt,
} from "../src/culling/labelCollision";

describe("label collision CPU reference", () => {
  test("uses the WebGPU-compatible 32-byte record layout", () => {
    const records = packLabelCollisionRecords([
      {
        minX: 1,
        minY: 2,
        maxX: 11,
        maxY: 12,
        priority: 7,
        zIndex: 3,
        order: 9,
        slot: 17,
      },
    ]);

    expect(records.byteLength).toBe(LABEL_COLLISION_RECORD_STRIDE);
    expect(Array.from(new Float32Array(records).subarray(0, 6))).toEqual([1, 2, 11, 12, 7, 3]);
    expect(Array.from(new Uint32Array(records).subarray(6, 8))).toEqual([9, 17]);
    expect(LABEL_COLLISION_RECORD_WGSL).toContain("bounds: vec4<f32>");
    expect(LABEL_COLLISION_RECORD_WGSL).toContain("orderSlot: vec2<u32>");
  });

  test("keeps higher-priority labels and restores z/insertion draw order", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 10, minX: 0, maxX: 10, priority: 1, zIndex: 5, order: 1 }),
      box({ slot: 11, minX: 2, maxX: 12, priority: 9, zIndex: 0, order: 2 }),
      box({ slot: 12, minX: 20, maxX: 30, priority: 5, zIndex: 2, order: 3 }),
      box({ slot: 13, minX: 40, maxX: 50, priority: 4, zIndex: 2, order: 2 }),
    ]);
    const output = new Uint32Array(4);
    const result = new LabelCollisionSelector().select(records, 4, output);

    expect(result).toMatchObject({
      candidateCount: 4,
      selectedCount: 3,
      collisionCulledCount: 1,
      densityCulledCount: 0,
      selectionHash: hashSlots([11, 13, 12]),
    });
    expect(Array.from(output.subarray(0, result.selectedCount))).toEqual([11, 13, 12]);
  });

  test("uses insertion order as the stable equal-priority tie-break", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 20, minX: 0, maxX: 10, priority: 4, zIndex: 20, order: 2 }),
      box({ slot: 21, minX: 0, maxX: 10, priority: 4, zIndex: -20, order: 1 }),
    ]);
    const output = new Uint32Array(2);
    const result = new LabelCollisionSelector().select(records, 2, output);

    expect(result.selectedCount).toBe(1);
    expect(output[0]).toBe(21);
  });

  test("selects sparse resident records from a candidate slot list", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 0, minX: 100, maxX: 110, priority: 0, order: 0 }),
      box({ slot: 1, minX: 0, maxX: 10, priority: 2, order: 1 }),
      box({ slot: 2, minX: 100, maxX: 110, priority: 0, order: 2 }),
      box({ slot: 3, minX: 0, maxX: 10, priority: 9, order: 3 }),
      box({ slot: 4, minX: 100, maxX: 110, priority: 0, order: 4 }),
      box({ slot: 5, minX: 20, maxX: 30, priority: 4, order: 5 }),
    ]);
    const candidates = new Uint32Array([1, 3, 5]);
    const output = new Uint32Array(3);
    const result = new LabelCollisionSelector().selectCandidates(
      records,
      candidates,
      candidates.length,
      output,
    );

    expect(result).toMatchObject({ selectedCount: 2, collisionCulledCount: 1 });
    expect(Array.from(output.subarray(0, result.selectedCount))).toEqual([3, 5]);
  });

  test("selects a proven admission-ordered candidate list without changing output identity", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 0, minX: 0, maxX: 10, priority: 9, order: 0 }),
      box({ slot: 1, minX: 0, maxX: 10, priority: 8, order: 1 }),
      box({ slot: 2, minX: 20, maxX: 30, priority: 7, order: 2 }),
      box({ slot: 3, minX: 40, maxX: 50, priority: 6, order: 3 }),
    ]);
    const candidatesAndOutput = new Uint32Array([0, 1, 2, 3]);
    const result = new LabelCollisionSelector({ maxVisible: 3 }).selectRankedCandidates(
      records,
      candidatesAndOutput,
      candidatesAndOutput.length,
      candidatesAndOutput,
    );

    expect(result).toMatchObject({
      selectedCount: 3,
      collisionCulledCount: 1,
      densityCulledCount: 0,
      selectionHash: hashSlots([0, 2, 3]),
    });
    expect(Array.from(candidatesAndOutput.subarray(0, result.selectedCount))).toEqual([0, 2, 3]);
  });

  test("invalidates cached identical-bound runs when packed records change", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 0, minX: 0, maxX: 10, priority: 9, order: 0 }),
      box({ slot: 1, minX: 0, maxX: 10, priority: 8, order: 1 }),
      box({ slot: 2, minX: 40, maxX: 50, priority: 7, order: 2 }),
    ]);
    const floats = new Float32Array(records);
    const uints = new Uint32Array(records);
    const candidatesAndOutput = new Uint32Array([0, 1, 2]);
    const selector = new LabelCollisionSelector({ maxVisible: 3, validateRecords: false });

    const first = selector.selectRankedCandidates(
      records,
      candidatesAndOutput,
      candidatesAndOutput.length,
      candidatesAndOutput,
    );
    expect(Array.from(candidatesAndOutput.subarray(0, first.selectedCount))).toEqual([0, 2]);

    writeLabelCollisionRecordAt(
      floats,
      uints,
      1,
      box({ slot: 1, minX: 20, maxX: 30, priority: 8, order: 1 }),
    );
    selector.invalidateRecord(1);
    candidatesAndOutput.set([0, 1, 2]);
    const second = selector.selectRankedCandidates(
      records,
      candidatesAndOutput,
      candidatesAndOutput.length,
      candidatesAndOutput,
    );

    expect(Array.from(candidatesAndOutput.subarray(0, second.selectedCount))).toEqual([0, 1, 2]);
    selector.destroy();
  });

  test("invalidates every overlapping cached run containing a changed record", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 0, minX: 0, maxX: 10, priority: 9, order: 0 }),
      box({ slot: 1, minX: 0, maxX: 10, priority: 8, order: 1 }),
      box({ slot: 2, minX: 0, maxX: 10, priority: 7, order: 2 }),
      box({ slot: 3, minX: 0, maxX: 10, priority: 6, order: 3 }),
    ]);
    const floats = new Float32Array(records);
    const uints = new Uint32Array(records);
    const candidatesAndOutput = new Uint32Array(3);
    const selector = new LabelCollisionSelector({ maxVisible: 3, validateRecords: false });

    candidatesAndOutput.set([0, 1, 2]);
    selector.selectRankedCandidates(records, candidatesAndOutput, 3, candidatesAndOutput);
    candidatesAndOutput.set([1, 2, 3]);
    selector.selectRankedCandidates(records, candidatesAndOutput, 3, candidatesAndOutput);

    writeLabelCollisionRecordAt(
      floats,
      uints,
      2,
      box({ slot: 2, minX: 20, maxX: 30, priority: 7, order: 2 }),
    );
    selector.invalidateRecord(2);
    candidatesAndOutput.set([1, 2, 3]);
    const result = selector.selectRankedCandidates(
      records,
      candidatesAndOutput,
      candidatesAndOutput.length,
      candidatesAndOutput,
    );

    expect(Array.from(candidatesAndOutput.subarray(0, result.selectedCount))).toEqual([1, 2]);
    selector.destroy();
  });

  test("applies fixed screen-pixel padding and a global density ceiling", () => {
    const records = packLabelCollisionRecords([
      box({ slot: 1, minX: 0, maxX: 10, priority: 5, order: 1 }),
      box({ slot: 2, minX: 11, maxX: 21, priority: 4, order: 2 }),
      box({ slot: 3, minX: 40, maxX: 50, priority: 3, order: 3 }),
      box({ slot: 4, minX: 80, maxX: 90, priority: 2, order: 4 }),
    ]);
    const output = new Uint32Array(4);
    const result = new LabelCollisionSelector({ padding: 1, maxVisible: 2 }).select(
      records,
      4,
      output,
    );

    expect(Array.from(output.subarray(0, result.selectedCount))).toEqual([1, 3]);
    expect(result).toMatchObject({
      selectedCount: 2,
      collisionCulledCount: 1,
      densityCulledCount: 1,
    });
  });

  test("keeps identical zero-area records under strict overlap semantics", () => {
    const records = packLabelCollisionRecords([
      { ...box({ slot: 1, minX: 5, maxX: 5, priority: 2, order: 1 }), maxY: 0 },
      { ...box({ slot: 2, minX: 5, maxX: 5, priority: 1, order: 2 }), maxY: 0 },
    ]);
    const output = new Uint32Array(2);
    const result = new LabelCollisionSelector().select(records, 2, output);

    expect(result).toMatchObject({ selectedCount: 2, collisionCulledCount: 0 });
    expect(Array.from(output)).toEqual([1, 2]);
  });

  test("routes coordinates beyond safe grid integers through the spill path", () => {
    const coordinate = 2 ** 60;
    const extent = 2 ** 42;
    const records = packLabelCollisionRecords([
      box({ slot: 1, minX: coordinate, maxX: coordinate + extent, priority: 2, order: 1 }),
      box({ slot: 2, minX: coordinate, maxX: coordinate + extent, priority: 1, order: 2 }),
    ]);
    const output = new Uint32Array(2);
    const result = new LabelCollisionSelector().select(records, 2, output);

    expect(result).toMatchObject({ selectedCount: 1, collisionCulledCount: 1 });
    expect(output[0]).toBe(1);
  });

  test("projects local AABBs through the current screen transform", () => {
    expect(
      projectLabelCollisionAabb(
        { x: 1, y: 2, width: 3, height: 4 },
        { a: 2, b: 0, c: 0, d: 3, tx: 10, ty: -5 },
      ),
    ).toEqual({ minX: 12, minY: 1, maxX: 18, maxY: 13 });
  });
});

function box(
  input: Readonly<{
    slot: number;
    minX: number;
    maxX: number;
    priority: number;
    order: number;
    zIndex?: number;
  }>,
) {
  return {
    minX: input.minX,
    minY: 0,
    maxX: input.maxX,
    maxY: 10,
    priority: input.priority,
    zIndex: input.zIndex ?? 0,
    order: input.order,
    slot: input.slot,
  };
}

function hashSlots(slots: readonly number[]): number {
  let hash = 0x811c_9dc5;
  for (const slot of slots) {
    hash = Math.imul(hash ^ slot, 0x0100_0193) >>> 0;
  }
  return slots.length === 0 ? 0 : hash;
}
