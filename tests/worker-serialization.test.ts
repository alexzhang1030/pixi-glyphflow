import { describe, expect, test } from "bun:test";

import type { PositionedRun } from "../src/layout/types";
import { serializeWorkerRun, workerRunTransferables } from "../src/worker/serializeWorkerRun";

describe("worker run serialization", () => {
  test("copies cluster ends, preserves variation identity, and transfers every typed column", () => {
    const clusterEnds = new Uint32Array([2, 4]);
    const run: Readonly<PositionedRun> = {
      source: "harfbuzz",
      text: "abcd",
      fontFamily: "Fixture",
      fontRevision: 7,
      glyphCount: 2,
      direction: "ltr",
      glyphIds: new Uint32Array([10, 11]),
      clusters: new Uint32Array([0, 2]),
      clusterEnds,
      variationKey: "wdth=90,wght=650",
      x: new Float32Array([0, 8]),
      y: new Float32Array(2),
      xAdvance: new Float32Array([8, 9]),
      yAdvance: new Float32Array(2),
      lineIndices: new Uint32Array(2),
      bounds: { x: 0, y: -10, width: 17, height: 12 },
    };

    const serialized = serializeWorkerRun(run, 9);
    expect(serialized.fontRevision).toBe(9);
    expect(serialized.clusterEnds).not.toBe(clusterEnds);
    expect([...serialized.clusterEnds!]).toEqual([2, 4]);
    expect(serialized.variationKey).toBe("wdth=90,wght=650");

    const transfer = workerRunTransferables(serialized);
    expect(transfer).toHaveLength(8);
    expect(transfer).toContain(serialized.clusterEnds!.buffer);
  });
});
