import { describe, expect, test } from "bun:test";

import { TextLayer } from "../src";

describe("TextLayer commit and maintenance", () => {
  test("publishes coalesced dirty domains and reports zero work for no-op commits", async () => {
    const layer = new TextLayer();
    const [first, second] = layer.createMany([{ text: "one" }, { text: "two" }]);

    expect(layer.stats.pendingDirtyLabels).toBe(2);
    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastCommitDirtyLabels: 2,
      lastCommitContentLabels: 2,
      lastCommitTransformLabels: 2,
      lastCommitStyleLabels: 2,
    });

    layer.update(first!, { x: 10 });
    layer.update(first!, { y: 20 });
    layer.update(second!, { style: { fill: 0xff0000 } });
    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastCommitDirtyLabels: 2,
      lastCommitContentLabels: 0,
      lastCommitTransformLabels: 1,
      lastCommitStyleLabels: 1,
    });

    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastCommitDirtyLabels: 0,
      lastCommitContentLabels: 0,
      lastCommitTransformLabels: 0,
      lastCommitStyleLabels: 0,
    });

    layer.destroy();
  });

  test("shrinks reserved capacity while preserving identities and snapshots", async () => {
    const layer = new TextLayer({ initialCapacity: 1_024 });
    const first = layer.create({ text: "one", x: 1 });
    const second = layer.create({ text: "two", x: 2 });
    await layer.commit();

    const result = layer.compact();

    expect(result.beforeCapacity).toBe(1_024);
    expect(result.afterCapacity).toBe(16);
    expect(result.releasedBytes).toBeGreaterThan(0);
    expect(layer.get(first)).toMatchObject({ text: "one", x: 1 });
    expect(layer.get(second)).toMatchObject({ text: "two", x: 2 });
    expect(Number(await layer.commit())).toBe(1);

    layer.destroy();
  });
});
