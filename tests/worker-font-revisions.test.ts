import { describe, expect, test } from "bun:test";

import { WorkerFontRevisions } from "../src/worker/WorkerFontRevisions";

describe("WorkerFontRevisions", () => {
  test("keeps a family high-water revision across unregister and equal-revision reload", () => {
    const revisions = new WorkerFontRevisions();

    expect(revisions.beginRegistration("Fixture", 3)).toBe(true);
    revisions.activate("Fixture", 3);
    expect(revisions.beginRegistration("Fixture", 3)).toBe(false);
    expect(revisions.unregister("Fixture")).toBe(true);
    expect(revisions.active("Fixture")).toBeUndefined();
    expect(() => revisions.beginRegistration("Fixture", 2)).toThrow(
      "Worker font revision 2 precedes current revision 3",
    );
    expect(revisions.beginRegistration("Fixture", 3)).toBe(true);
    revisions.activate("Fixture", 3);
    expect(revisions.active("Fixture")).toBe(3);
  });
});
