import { describe, expect, test } from "bun:test";

import {
  DIRTY_ACCEPTED_GAP,
  DIRTY_MAX_RANGES,
  DIRTY_WHOLE_BUFFER_BPS,
  DirtyRanges,
} from "../src/render/DirtyRanges";

describe("DirtyRanges", () => {
  test("sorts and coalesces overlapping or adjacent byte ranges", () => {
    const ranges = new DirtyRanges();
    ranges.record(64, 32);
    ranges.record(0, 16);
    ranges.record(16, 16);
    ranges.record(80, 32);

    expect(ranges.publish()).toEqual([
      { offset: 0, length: 32 },
      { offset: 64, length: 48 },
    ]);
    expect(ranges.publish()).toEqual([]);
  });

  test("merges accepted gaps, collapses fragmented spans, and promotes a whole live buffer", () => {
    const gapped = new DirtyRanges();
    gapped.record(0, 32);
    gapped.record(32 + DIRTY_ACCEPTED_GAP, 16);
    expect(gapped.publish({ acceptedGap: DIRTY_ACCEPTED_GAP })).toEqual([
      { offset: 0, length: 32 + DIRTY_ACCEPTED_GAP + 16 },
    ]);

    const split = new DirtyRanges();
    split.record(0, 32);
    split.record(32 + DIRTY_ACCEPTED_GAP + 1, 16);
    expect(split.publish({ acceptedGap: DIRTY_ACCEPTED_GAP })).toEqual([
      { offset: 0, length: 32 },
      { offset: 32 + DIRTY_ACCEPTED_GAP + 1, length: 16 },
    ]);

    const fragmented = new DirtyRanges();
    for (let index = 0; index < DIRTY_MAX_RANGES + 1; index += 1) {
      fragmented.record(index * 1_024, 16);
    }
    expect(fragmented.publish({ maxRanges: DIRTY_MAX_RANGES })).toEqual([
      { offset: 0, length: DIRTY_MAX_RANGES * 1_024 + 16 },
    ]);

    const heavy = new DirtyRanges();
    heavy.record(0, 75);
    expect(heavy.publish({ liveBytes: 100, wholeBufferBps: DIRTY_WHOLE_BUFFER_BPS })).toEqual([
      { offset: 0, length: 100 },
    ]);
    const light = new DirtyRanges();
    light.record(0, 74);
    expect(light.publish({ liveBytes: 100, wholeBufferBps: DIRTY_WHOLE_BUFFER_BPS })).toEqual([
      { offset: 0, length: 74 },
    ]);
  });

  test("validates byte coordinates", () => {
    const ranges = new DirtyRanges();
    expect(() => ranges.record(-1, 1)).toThrow(TypeError);
    expect(() => ranges.record(0, 0)).toThrow(TypeError);
  });
});
