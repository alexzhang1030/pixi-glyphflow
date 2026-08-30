import { describe, expect, test } from "bun:test";

import type { TextStyleOptions } from "pixi.js";

import type { PositionedRun } from "../src/layout/types";
import { GpuSceneCompiler, type GpuSceneCompilerColumn } from "../src/render/GpuSceneCompiler";
import { canonicalFillPaint } from "../src/render/TransformPalette";

describe("GpuSceneCompiler", () => {
  test("bounds value-semantic prototype candidate discovery at the 65th fresh style", () => {
    const compiler = new GpuSceneCompiler();
    let inspected = 0;
    for (let index = 0; index < 1_000_000; index += 1) {
      inspected += 1;
      const candidate = compiler.admitCandidate(`candidate-${String(index)}`, {
        fontFamily: `Fixture-${String(index)}`,
        fontSize: 16,
        fill: 0xffffff,
      });
      if (candidate === undefined) break;
    }

    expect(inspected).toBe(65);
    expect(compiler.candidatePrototypeCount).toBe(64);
    expect(compiler.candidatePaintCount).toBe(1);
  });

  test("bounds exact canonical paint discovery at the ninth paint", () => {
    const compiler = new GpuSceneCompiler();
    let inspected = 0;
    for (let index = 0; index < 1_000_000; index += 1) {
      inspected += 1;
      const candidate = compiler.admitCandidate("shared", {
        fontFamily: "Fixture",
        fontSize: 16,
        fill: index,
      });
      if (candidate === undefined) break;
    }

    expect(inspected).toBe(9);
    expect(compiler.candidatePrototypeCount).toBe(1);
    expect(compiler.candidatePaintCount).toBe(8);
  });

  test("merges render-equivalent fresh styles while keeping paint independent", () => {
    const compiler = new GpuSceneCompiler();
    const red = compiler.admitCandidate("A", {
      fill: 0xff0000,
      fontSize: 16,
      fontFamily: "Fixture",
    });
    const sameRed = compiler.admitCandidate("A", {
      fontFamily: "Fixture",
      fontSize: 16,
      fill: "#ff0000",
    });
    const sameDefault = compiler.admitCandidate("A", {
      fontFamily: "Fixture",
      fontSize: 16,
      wordWrapWidth: undefined,
      fill: "#ff0000",
    } as unknown as TextStyleOptions);
    const green = compiler.admitCandidate("A", {
      fontFamily: "Fixture",
      fill: 0x00ff00,
      fontSize: 16,
    });

    expect(red).toBe(sameRed);
    expect(red).toBe(sameDefault);
    expect(green).not.toBe(red);
    expect(compiler.candidatePrototypeCount).toBe(1);
    expect(compiler.candidatePaintCount).toBe(2);
  });

  test("declines geometry styles that cannot form a stable value key", () => {
    const compiler = new GpuSceneCompiler();
    const style = {
      fontFamily: (() => "Fixture") as unknown as string,
      fontSize: 16,
      fill: 0xffffff,
    } satisfies TextStyleOptions;

    expect(compiler.admitCandidate("A", style)).toBeUndefined();
    expect(compiler.candidatePrototypeCount).toBe(0);
    expect(compiler.candidatePaintCount).toBe(0);
  });

  test("compiles interleaved paints independently from exact prototype geometry", () => {
    const compiler = new GpuSceneCompiler();
    const geometry = run("A", 0);
    const result = expectReadyCompile(
      compiler.compile([
        column([0, 4], [1, 5], geometry, "alpha:16", 0xff0000),
        column([1, 5], [2, 6], run("A-copy", 0), "alpha:16", "#ff0000"),
        column([2, 6], [3, 7], run("B", 12), "alpha:16", 0x00ff00),
        column([3, 7], [4, 8], run("B-copy", 12), "alpha:16", "#00ff00"),
      ]),
    );
    expect(result).toMatchObject({
      recordStart: 0,
      recordCount: 8,
      prototypeCount: 2,
      paintCount: 2,
    });
    expect(Array.from(result.newPrototypeIndices)).toEqual([0, 1]);
    expect(Array.from(result.newPrototypeSources)).toEqual([0, 2]);
    expect(
      result.columns.map((entry) => ({
        prototypeIndex: entry.prototypeIndex,
        paintIndex: entry.paintIndex,
        slots: Array.from(entry.slots),
      })),
    ).toEqual([
      { prototypeIndex: 0, paintIndex: 0, slots: [0, 1, 4, 5] },
      { prototypeIndex: 1, paintIndex: 1, slots: [2, 3, 6, 7] },
    ]);
  });

  test("uses exact prototype comparison inside a collided hash bucket", () => {
    const compiler = new GpuSceneCompiler({ prototypeHash: () => 7 });
    const result = expectReadyCompile(
      compiler.compile([
        column([0], [1], run("left", 0), "alpha:16", 0xffffff),
        column([1], [2], run("right", 3), "alpha:16", 0xffffff),
        column([2], [3], run("left-copy", 0), "alpha:16", 0xffffff),
      ]),
    );
    expect(result.prototypeCount).toBe(2);
    expect(Array.from(result.newPrototypeSources)).toEqual([0, 1]);
    expect(result.columns.map((entry) => Array.from(entry.slots))).toEqual([[0, 2], [1]]);
  });

  test("keeps the 64 prototype and 8 exact paint limits transactional", () => {
    const prototypeCompiler = new GpuSceneCompiler();
    const prototypes = Array.from({ length: 64 }, (_, index) =>
      column([index], [index + 1], run(`p${String(index)}`, index), "alpha:16", 0xffffff),
    );
    const acceptedPrototypes = expectReadyCompile(prototypeCompiler.compile(prototypes));
    expect(acceptedPrototypes.prototypeCount).toBe(64);
    expect(
      prototypeCompiler.compile([column([64], [65], run("overflow", 100), "alpha:16", 0xffffff)]),
    ).toEqual({ status: "unsupported", reason: "unsupported-scene" });
    const reusedPrototype = prototypeCompiler.compile([
      column([64], [65], run("existing", 0), "alpha:16", 0xffffff),
    ]);
    expect(reusedPrototype).toMatchObject({
      status: "ready",
      recordStart: 64,
      recordCount: 1,
      prototypeCount: 64,
    });

    const paintCompiler = new GpuSceneCompiler();
    const paints = Array.from({ length: 8 }, (_, index) => ({
      ...column([index], [index + 1], run("shared", 0), "alpha:16", 0xffffff),
      paint: { colorBits: index, alphaBits: 0x3f80_0000 },
    }));
    const acceptedPaints = expectReadyCompile(paintCompiler.compile(paints));
    expect(acceptedPaints.paintCount).toBe(8);
    expect(
      paintCompiler.compile([
        {
          ...column([8], [9], run("shared", 0), "alpha:16", 0xffffff),
          paint: { colorBits: 8, alphaBits: 0x3f80_0000 },
        },
      ]),
    ).toEqual({ status: "unsupported", reason: "unsupported-scene" });
    const reusedPaint = paintCompiler.compile([
      {
        ...column([8], [9], run("shared", 0), "alpha:16", 0xffffff),
        paint: { colorBits: 0, alphaBits: 0x3f80_0000 },
      },
    ]);
    expect(reusedPaint).toMatchObject({
      status: "ready",
      recordStart: 8,
      recordCount: 1,
      paintCount: 8,
    });
  });

  test("accepts every interleaved pair in the bounded 64 by 8 matrix", () => {
    const compiler = new GpuSceneCompiler();
    const columns = Array.from({ length: 64 * 8 }, (_, slot) => {
      const prototype = slot % 64;
      const paint = Math.floor(slot / 64);
      return {
        ...column(
          [slot],
          [slot + 1],
          run(`p${String(prototype)}`, prototype),
          "alpha:16",
          0xffffff,
        ),
        paint: { colorBits: paint, alphaBits: 0x3f80_0000 },
      };
    });

    const result = expectReadyCompile(compiler.compile(columns));
    expect(result).toMatchObject({
      recordCount: 512,
      prototypeCount: 64,
      paintCount: 8,
    });
    expect(result.columns).toHaveLength(512);
  });

  test("separates font revision, variation, and raster identity boundaries", () => {
    const compiler = new GpuSceneCompiler();
    const base = run("base", 0);
    const result = compiler.compile([
      column([0], [1], base, "alpha:16", 0xffffff),
      column([1], [2], { ...base, text: "revision", fontRevision: 4 }, "alpha:16", 0xffffff),
      column(
        [2],
        [3],
        { ...base, text: "variation", variationKey: "wght=600" },
        "alpha:16",
        0xffffff,
      ),
      column([3], [4], { ...base, text: "raster" }, "color:16", 0xffffff),
    ]);

    expect(result).toMatchObject({ status: "ready", prototypeCount: 4, paintCount: 1 });
  });

  test("retains an exact immutable GPU binding per prototype", () => {
    const compiler = new GpuSceneCompiler();
    const result = compiler.compile([column([0], [1], run("bound", 0), "alpha:16", 0xffffff)]);
    expect(result.status).toBe("ready");
    compiler.bindPrototype(0, {
      prototypeId: 9,
      instanceOffset: 11,
      instanceCount: 2,
      localBounds: new Float32Array([-1, -2, 8, 10]),
    });

    expect(compiler.prototypeBinding(0)).toMatchObject({
      prototypeId: 9,
      instanceOffset: 11,
      instanceCount: 2,
    });
    expect(() =>
      compiler.bindPrototype(0, {
        prototypeId: 10,
        instanceOffset: 11,
        instanceCount: 2,
        localBounds: new Float32Array([-1, -2, 8, 10]),
      }),
    ).toThrow("GPU scene prototype binding changed");
  });
});

function expectReadyCompile(result: ReturnType<GpuSceneCompiler["compile"]>) {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Fixture scene was declined");
  return result;
}

function column(
  slots: readonly number[],
  orders: readonly number[],
  positionedRun: Readonly<PositionedRun>,
  rasterIdentity: string,
  fill: unknown,
): GpuSceneCompilerColumn {
  const xy = new Float32Array(slots.length * 2);
  for (let index = 0; index < slots.length; index += 1) {
    xy[index * 2] = (slots[index] ?? 0) * 10;
    xy[index * 2 + 1] = (slots[index] ?? 0) * 20;
  }
  return {
    slots: Uint32Array.from(slots),
    count: slots.length,
    xy,
    orders: Uint32Array.from(orders),
    run: positionedRun,
    rasterIdentity,
    paint: canonicalFillPaint(fill),
  };
}

function run(text: string, shift: number): Readonly<PositionedRun> {
  return Object.freeze({
    source: "bitmap",
    text,
    fontFamily: "Fixture",
    fontRevision: 3,
    variationKey: "wght=500",
    glyphCount: 1,
    direction: "ltr",
    glyphIds: new Uint32Array([65]),
    glyphKeys: Object.freeze(["A"]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([shift]),
    y: new Float32Array([8]),
    xAdvance: new Float32Array([8]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    bounds: Object.freeze({ x: shift, y: 0, width: 8, height: 10 }),
  });
}
