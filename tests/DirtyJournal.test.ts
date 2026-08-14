import { describe, expect, test } from "bun:test";

import { DirtyJournal } from "../src/store/DirtyJournal";
import { TextDirty } from "../src/store/types";

describe("DirtyJournal", () => {
  test("coalesces slots and publishes precise dirty-domain counts", () => {
    const journal = new DirtyJournal(2);
    const visited: Array<readonly [number, number]> = [];

    journal.record(0, TextDirty.Content);
    journal.record(0, TextDirty.Transform);
    journal.record(1, TextDirty.Style);

    expect(journal.pending).toMatchObject({
      labels: 2,
      mask: TextDirty.Content | TextDirty.Transform | TextDirty.Style,
    });
    expect(journal.publish((slot, mask) => visited.push([slot, mask]))).toEqual({
      labels: 2,
      content: 1,
      transform: 1,
      style: 1,
      mask: TextDirty.Content | TextDirty.Transform | TextDirty.Style,
    });
    expect(visited).toEqual([
      [0, TextDirty.Content | TextDirty.Transform],
      [1, TextDirty.Style],
    ]);
    expect(journal.pending).toEqual({ labels: 0, mask: TextDirty.None });
  });

  test("grows geometrically and releases storage", () => {
    const journal = new DirtyJournal(1);

    journal.reserve(1_000);
    journal.record(999, TextDirty.Transform);
    expect(journal.capacity).toBe(1_024);
    expect(journal.allocatedBytes).toBeGreaterThan(0);

    journal.dispose();
    expect(journal.capacity).toBe(0);
    expect(journal.allocatedBytes).toBe(0);
  });
});
