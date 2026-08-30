import { describe, expect, test } from "bun:test";

import { loadPackagedHarfBuzzRuntime } from "../benchmarks/shaping-simd/packaged-runtime";
import { FontRegistry } from "../src/FontRegistry";
import type { PositionedRun } from "../src/layout/types";
import { HarfBuzzShaper } from "../src/shaping/HarfBuzzShaper";

const corpora = [
  {
    id: "cjkv",
    family: "Noto Sans CJKV",
    font: "site/public/fonts/noto-sans-cjkv-demo.ttf",
    text: "字形測試",
    language: "zh",
    script: "Hani",
    direction: "ltr" as const,
  },
  {
    id: "arabic",
    family: "Noto Sans Arabic",
    font: "site/public/fonts/noto-sans-arabic-demo.ttf",
    text: "السلام عليكم",
    language: "ar",
    script: "Arab",
    direction: "rtl" as const,
  },
  {
    id: "devanagari",
    family: "Noto Sans Devanagari",
    font: "site/public/fonts/noto-sans-devanagari-demo.ttf",
    text: "नमस्ते दुनिया",
    language: "hi",
    script: "Deva",
    direction: "ltr" as const,
  },
  {
    id: "hebrew",
    family: "Noto Sans Hebrew",
    font: "site/public/fonts/noto-sans-hebrew-demo.ttf",
    text: "שלום עולם",
    language: "he",
    script: "Hebr",
    direction: "rtl" as const,
  },
  {
    id: "thai",
    family: "Noto Sans Thai",
    font: "site/public/fonts/noto-sans-thai-demo.ttf",
    text: "สวัสดีครับ",
    language: "th",
    script: "Thai",
    direction: "ltr" as const,
  },
] as const;

describe("packaged HarfBuzz shaping runtimes", () => {
  test("produce exact scalar and SIMD output for five scripts", async () => {
    const [scalar, simd] = await Promise.all([shapeCorpora("scalar"), shapeCorpora("simd")]);

    expect(scalar.map((entry) => entry.id)).toEqual(corpora.map((entry) => entry.id));
    expect(simd).toEqual(scalar);
  });
});

async function shapeCorpora(variant: "scalar" | "simd"): Promise<readonly RunSnapshot[]> {
  const registry = new FontRegistry();
  const runtime = await loadPackagedHarfBuzzRuntime(variant, {
    readWasm: (url) => Bun.file(url).bytes(),
  });
  const shaper = new HarfBuzzShaper(registry, { loadRuntime: () => Promise.resolve(runtime) });
  try {
    const snapshots: RunSnapshot[] = [];
    for (const corpus of corpora) {
      await registry.register({
        family: corpus.family,
        source: await Bun.file(new URL(`../${corpus.font}`, import.meta.url)).bytes(),
      });
      const run = await shaper.shape({
        family: corpus.family,
        text: corpus.text,
        fontSize: 32,
        language: corpus.language,
        script: corpus.script,
        direction: corpus.direction,
        features: ["kern=1", "liga=1"],
      });
      snapshots.push(snapshot(corpus.id, run));
    }

    return snapshots;
  } finally {
    shaper.destroy();
    registry.destroy();
  }
}

interface RunSnapshot {
  readonly id: string;
  readonly glyphCount: number;
  readonly direction: string;
  readonly glyphIds: readonly number[];
  readonly clusters: readonly number[];
  readonly clusterEnds: readonly number[];
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly xAdvance: readonly number[];
  readonly yAdvance: readonly number[];
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}

function snapshot(id: string, run: Readonly<PositionedRun>): Readonly<RunSnapshot> {
  return Object.freeze({
    id,
    glyphCount: run.glyphCount,
    direction: run.direction,
    glyphIds: [...run.glyphIds],
    clusters: [...run.clusters],
    clusterEnds: [...(run.clusterEnds ?? [])],
    x: [...run.x],
    y: [...run.y],
    xAdvance: [...run.xAdvance],
    yAdvance: [...run.yAdvance],
    bounds: { ...run.bounds },
  });
}
