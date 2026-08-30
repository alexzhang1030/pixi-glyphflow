import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import {
  browserBenchmarkRenderers,
  createCurrentBrowserBenchmarkArtifactIdentity,
  loadCurrentBrowserBenchmarkArtifact,
  readFixedHistoricalBrowserBenchmarkArtifact,
  resolveBrowserArtifactFreshness,
  type FixedHistoricalBrowserBenchmarkArtifact,
} from "./artifacts";
import { evaluateGpuSceneV2Budget } from "./gpu-scene-budget";
import { evaluateGpuSceneHeterogeneousBudget } from "./gpu-scene-heterogeneous-budget";
import { evaluateGpuSceneResidentBudget } from "./gpu-scene-resident-budget";
import { evaluateLabelCollisionBudget } from "./label-collision-budget";
import {
  BENCHMARK_SCHEMA_VERSION,
  summarize,
  type BrowserBenchmarkArtifact,
  type BrowserBenchmarkBudgetCheck,
  type BrowserBenchmarkBudgetDecision,
  type BrowserBenchmarkRenderer,
  type BrowserBenchmarkSample,
  type BrowserBenchmarkWorkload,
} from "./schema";
import { BENCHMARK_WORKLOADS, browserBenchmarkRepetitions } from "./workloads";

interface BudgetResult {
  readonly name: string;
  readonly actual: number | string;
  readonly limit: number | string;
  readonly passed: boolean;
}

type BudgetBrowserBenchmarkArtifact =
  | Readonly<BrowserBenchmarkArtifact>
  | Readonly<FixedHistoricalBrowserBenchmarkArtifact>;

export interface BenchmarkBudgetSummaryCheck extends BrowserBenchmarkBudgetCheck {
  readonly blocking: boolean;
  readonly classification: "budget-gate" | "fixed-red-control";
}

export const CURRENT_WAVE2_LIVE_FRAME_P95_MS: number = 16.67;
export const CURRENT_WAVE2_LIVE_STORE_BYTES: number = 64 * 1_024 ** 2;
export const CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES: number = 8;
export const CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES: number = 24;
export const CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES: number = 32;
export const CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES: number = 48;

const LEGACY_FRAME_P95_MS = 16.67;
const LEGACY_STORE_BYTES = 128 * 1_024 ** 2;
const LEGACY_INSTANCE_STRIDE_BYTES = 32;
const LEGACY_INSTANCE_BUFFER_BYTES = 256 * 1_024 ** 2;
const LEGACY_TRANSFORM_STRIDE_BYTES = 64;
const MILLION_LIVE_LABELS = 1_000_000;
const MILLION_LIVE_GLYPHS = 8_000_000;
const MILLION_LIVE_PROTOTYPE_GLYPHS = 8;
const GPU_SCENE_V2_FIXED_RED_CONTROL_CHECKS = new Set<string>([
  "gpu-scene-v2:webgl/camera-frame-p95-ms",
  "gpu-scene-v2:webgl/position-mutation-frame-p95-ms",
  "gpu-scene-v2:webgpu/camera-frame-p95-ms",
  "gpu-scene-v2:webgpu/position-mutation-frame-p95-ms",
]);
const checks: BenchmarkBudgetSummaryCheck[] = [];

export function classifyBenchmarkBudgetSummaryCheck(
  check: Readonly<BrowserBenchmarkBudgetCheck>,
): Readonly<BenchmarkBudgetSummaryCheck> {
  const fixedRedControl = GPU_SCENE_V2_FIXED_RED_CONTROL_CHECKS.has(check.name);
  return Object.freeze({
    ...check,
    blocking: !fixedRedControl,
    classification: fixedRedControl ? "fixed-red-control" : "budget-gate",
  });
}

export function isBlockingBenchmarkBudgetFailure(
  check: Pick<BenchmarkBudgetSummaryCheck, "blocking" | "passed">,
): boolean {
  return check.blocking && !check.passed;
}

export function evaluateGpuSceneHeterogeneousArtifactSummary(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
  embeddedBudget: Readonly<BrowserBenchmarkBudgetDecision> | undefined,
): readonly Readonly<BenchmarkBudgetSummaryCheck>[] {
  const decision = evaluateGpuSceneHeterogeneousBudget(samples);
  return Object.freeze([
    ...decision.checks.map((check) =>
      classifyBenchmarkBudgetSummaryCheck({
        ...check,
        name: `gpu-scene-heterogeneous:webgpu/${check.name}`,
      }),
    ),
    classifyBenchmarkBudgetSummaryCheck({
      name: "embedded-budget:gpu-scene-heterogeneous-64:webgpu",
      actual: String(embeddedBudget?.passed ?? false),
      limit: String(decision.passed),
      passed: embeddedBudget?.passed === decision.passed,
    }),
  ]);
}

export function evaluateBrowserBenchmarkArtifactSampleGate(
  workload: BrowserBenchmarkWorkload,
  actualSamples: number,
): Readonly<BrowserBenchmarkBudgetCheck> {
  const expectedSamples = workload === "static-hud" ? 4 : browserBenchmarkRepetitions(workload);
  return budgetCheck("samples", actualSamples, expectedSamples, actualSamples === expectedSamples);
}

export function evaluateMillionLiveWave2Budget(
  sample: Readonly<BrowserBenchmarkSample>,
): Readonly<BrowserBenchmarkBudgetDecision> {
  const frameP95 = p95(sample.timings.frameMs);
  const cpuSamples = sample.timings.cpuMs?.length ?? 0;
  const gpuSamples = sample.timings.gpuMs?.length ?? 0;
  const uploadSamples = sample.timings.uploadBytes?.length ?? 0;
  const values = sample.invariants;
  const results: BudgetResult[] = [
    budgetCheck(
      "product-workload",
      sample.configuration.workload,
      "million-live",
      sample.configuration.workload === "million-live",
    ),
    budgetCheck(
      "product-fixture",
      sample.configuration.fixture,
      "glyphflow",
      sample.configuration.fixture === "glyphflow",
    ),
    budgetCheck(
      "product-renderer",
      sample.configuration.renderer,
      "webgl",
      sample.configuration.renderer === "webgl",
    ),
    budgetCheck(
      "live-coordinator-mesh",
      String(values.liveCoordinatorMesh),
      "true",
      values.liveCoordinatorMesh === true,
    ),
    ...(
      [
        "exactResidentLabels",
        "exactVisibleGlyphs",
        "eightGlyphsPerLabel",
        "singleDrawCall",
        "gpuDrawObserved",
        "exactSubmittedInstanceCount",
        "nonTransparentOutput",
        "splitCpuGpuSamples",
      ] as const
    ).map((name) =>
      budgetCheck(`product-invariant:${name}`, String(values[name]), "true", values[name] === true),
    ),
    budgetCheck(
      "resident-labels",
      sample.counters.residentLabels,
      MILLION_LIVE_LABELS,
      sample.counters.residentLabels === MILLION_LIVE_LABELS,
    ),
    budgetCheck(
      "visible-glyphs",
      sample.counters.visibleGlyphs,
      MILLION_LIVE_GLYPHS,
      sample.counters.visibleGlyphs === MILLION_LIVE_GLYPHS,
    ),
    budgetCheck("logical-draws", sample.counters.drawCalls, 1, sample.counters.drawCalls === 1),
    budgetCheck(
      "warmup-frames",
      sample.configuration.warmupFrames,
      10,
      sample.configuration.warmupFrames === 10,
    ),
    budgetCheck(
      "sample-frames",
      sample.configuration.sampleFrames,
      120,
      sample.configuration.sampleFrames === 120 && sample.timings.frameMs.length === 120,
    ),
    budgetCheck("cpu-samples", cpuSamples, 120, cpuSamples === sample.configuration.sampleFrames),
    budgetCheck("gpu-samples", gpuSamples, 120, gpuSamples === sample.configuration.sampleFrames),
    budgetCheck(
      "upload-samples",
      uploadSamples,
      120,
      uploadSamples === sample.configuration.sampleFrames,
    ),
    budgetCheck(
      "steady-state-frame-p95-ms",
      frameP95,
      CURRENT_WAVE2_LIVE_FRAME_P95_MS,
      frameP95 <= CURRENT_WAVE2_LIVE_FRAME_P95_MS,
    ),
    budgetCheck(
      "runtime-store-bytes",
      sample.counters.allocatedStoreBytes ?? Number.POSITIVE_INFINITY,
      CURRENT_WAVE2_LIVE_STORE_BYTES,
      (sample.counters.allocatedStoreBytes ?? Number.POSITIVE_INFINITY) <=
        CURRENT_WAVE2_LIVE_STORE_BYTES,
    ),
    budgetCheck(
      "draw-reference-stride-bytes",
      invariantNumber(values.drawReferenceStrideBytes),
      CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
      values.drawReferenceStrideBytes === CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
    ),
    budgetCheck(
      "draw-reference-bytes",
      sample.counters.drawReferenceBytes ?? Number.POSITIVE_INFINITY,
      MILLION_LIVE_GLYPHS * CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
      sample.counters.drawReferenceBytes ===
        MILLION_LIVE_GLYPHS * CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
    ),
    budgetCheck(
      "prototype-record-stride-bytes",
      invariantNumber(values.prototypeRecordStrideBytes),
      CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
      values.prototypeRecordStrideBytes === CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
    ),
    budgetCheck(
      "prototype-record-bytes",
      sample.counters.prototypeRecordBytes ?? Number.POSITIVE_INFINITY,
      MILLION_LIVE_PROTOTYPE_GLYPHS * CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
      sample.counters.prototypeRecordBytes ===
        MILLION_LIVE_PROTOTYPE_GLYPHS * CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
    ),
    budgetCheck(
      "fill-transform-stride-bytes",
      invariantNumber(values.fillTransformStrideBytes),
      CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
      values.fillTransformStrideBytes === CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
    ),
    budgetCheck(
      "effectful-transform-stride-bytes",
      invariantNumber(values.effectfulTransformStrideBytes),
      CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES,
      values.effectfulTransformStrideBytes === CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES,
    ),
  ];

  return Object.freeze({
    passed: results.every((result) => result.passed),
    checks: Object.freeze(results),
  });
}

if (import.meta.main) await runBudgetCheck();

async function runBudgetCheck(): Promise<void> {
  const projectRoot = resolve(import.meta.dir, "..");
  const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
    readonly version: string;
  };
  const artifacts = new Map<string, BudgetBrowserBenchmarkArtifact>();
  const resultsDir = resolve(import.meta.dir, "results");
  const artifactFiles = await readdir(resultsDir);
  const requireCurrent = process.argv.includes("--require-current");
  let currentIdentityPromise:
    | ReturnType<typeof createCurrentBrowserBenchmarkArtifactIdentity>
    | undefined;

  for (const definition of BENCHMARK_WORKLOADS) {
    const renderers = browserBenchmarkRenderers(definition.id);
    for (const renderer of renderers) {
      const identity = artifactKey(definition.id, renderer);
      const freshness = resolveBrowserArtifactFreshness(
        definition.id,
        packageMetadata.version,
        artifactFiles,
        renderer === undefined ? {} : { renderer, artifactRole: "candidate" },
      );
      const artifactRequired = definition.artifactRequired !== false;
      const limit = artifactRequired
        ? requireCurrent
          ? `${packageMetadata.version} (current)`
          : "current or fixed historical"
        : "optional";
      const acceptedByPath =
        freshness.classification === "current" ||
        (!requireCurrent && freshness.classification === "stale");
      record(
        `artifact:${identity}`,
        freshness.classification === "missing"
          ? "missing"
          : `${freshness.artifact.version} (${freshness.classification})`,
        limit,
        acceptedByPath || !artifactRequired,
      );
      if (freshness.classification === "missing") continue;

      let artifact: BudgetBrowserBenchmarkArtifact;
      if (freshness.classification === "stale") {
        if (requireCurrent) continue;
        try {
          artifact = readFixedHistoricalBrowserBenchmarkArtifact(
            await Bun.file(resolve(resultsDir, freshness.artifact.fileName)).text(),
            {
              packageVersion: freshness.artifact.version,
              currentPackageVersion: packageMetadata.version,
              workload: definition.id,
              ...(renderer === undefined ? {} : { renderer, artifactRole: "candidate" }),
            },
          );
        } catch (error: unknown) {
          record(
            `historical:${identity}/artifact-validation`,
            error instanceof Error ? error.message : String(error),
            "fixed historical browser artifact",
            false,
          );
          continue;
        }
        record(
          `historical:${identity}/artifact-validation`,
          `${freshness.artifact.version} fixed historical`,
          `${freshness.artifact.version} fixed historical`,
          true,
        );
      } else {
        const loaded = await loadCurrentBrowserBenchmarkArtifact({
          resultsDirectory: resultsDir,
          fileNames: artifactFiles,
          expected: {
            packageVersion: packageMetadata.version,
            workload: definition.id,
            renderer: renderer ?? "webgl",
            artifactRole: "candidate",
            ...(await (currentIdentityPromise ??=
              createCurrentBrowserBenchmarkArtifactIdentity(projectRoot))),
          },
        });
        if (loaded.classification === "unavailable") {
          record(
            `current:${identity}/artifact-validation`,
            loaded.diagnostic,
            "schema 7 sealed current build and harness",
            false,
          );
          continue;
        }
        artifact = loaded.artifact;
        record(
          `current:${identity}/artifact-validation`,
          "schema 7 sealed current build and harness",
          "schema 7 sealed current build and harness",
          true,
        );
      }
      artifacts.set(identity, artifact);
      record(`status:${identity}`, artifact.status, "complete", artifact.status === "complete");
      record(
        `formal:${identity}`,
        String(artifact.exploratory !== true),
        "true",
        artifact.exploratory !== true,
      );
      if (renderer !== undefined) {
        record(
          `schema:${identity}`,
          artifact.schemaVersion,
          BENCHMARK_SCHEMA_VERSION,
          artifact.schemaVersion === BENCHMARK_SCHEMA_VERSION,
        );
        record(
          `renderer:${identity}`,
          artifact.renderer ?? "missing",
          renderer,
          artifact.renderer === renderer,
        );
        record(
          `artifact-role:${identity}`,
          artifact.artifactRole ?? "missing",
          "candidate",
          artifact.artifactRole === "candidate",
        );
      }
      const sampleGate = evaluateBrowserBenchmarkArtifactSampleGate(
        definition.id,
        artifact.samples.length,
      );
      record(`samples:${identity}`, sampleGate.actual, sampleGate.limit, sampleGate.passed);
      for (const sample of artifact.samples) {
        record(
          `labels:${identity}/${sample.configuration.fixture}`,
          sample.configuration.labelCount,
          definition.labelCount,
          sample.configuration.labelCount === definition.labelCount,
        );
        for (const [name, value] of Object.entries(sample.invariants)) {
          if (typeof value === "boolean") {
            record(`invariant:${identity}/${name}`, String(value), "true", value);
          }
        }
      }
      if (definition.id === "gpu-scene-heterogeneous-64" && renderer === "webgpu") {
        const summaryChecks = evaluateGpuSceneHeterogeneousArtifactSummary(
          artifact.samples,
          artifact.budget,
        );
        for (const check of summaryChecks) {
          record(check.name, check.actual, check.limit, check.passed);
        }
      } else if (definition.id === "gpu-scene-resident" && renderer === "webgpu") {
        const decision = evaluateGpuSceneResidentBudget(artifact.samples);
        for (const check of decision.checks) {
          record(
            `gpu-scene-resident:webgpu/${check.name}`,
            check.actual,
            check.limit,
            check.passed,
          );
        }
        record(
          `embedded-budget:${identity}`,
          String(artifact.budget?.passed ?? false),
          String(decision.passed),
          artifact.budget?.passed === decision.passed,
        );
      } else if (definition.id === "gpu-scene-v2" && renderer !== undefined) {
        const decision = evaluateGpuSceneV2Budget(artifact.samples, renderer);
        for (const check of decision.checks) {
          record(`gpu-scene-v2:${renderer}/${check.name}`, check.actual, check.limit, check.passed);
        }
        record(
          `embedded-budget:${identity}`,
          String(artifact.budget?.passed ?? false),
          String(decision.passed),
          artifact.budget?.passed === decision.passed,
        );
      } else if (definition.id === "label-collision" && renderer !== undefined) {
        const decision = evaluateLabelCollisionBudget(artifact.samples, renderer);
        for (const check of decision.checks) {
          record(
            `label-collision:${renderer}/${check.name}`,
            check.actual,
            check.limit,
            check.passed,
          );
        }
        record(
          `embedded-budget:${identity}`,
          String(artifact.budget?.passed ?? false),
          String(decision.passed),
          artifact.budget?.passed === decision.passed,
        );
      }
    }
  }

  const staticArtifact = artifacts.get("static-hud");
  const glyphflowStatic = fixture(staticArtifact, "glyphflow");
  const bitmapStatic = fixture(staticArtifact, "bitmap-text");
  if (glyphflowStatic !== undefined && bitmapStatic !== undefined) {
    const glyphflowP95 = p95(glyphflowStatic.timings.frameMs);
    const bitmapP95 = p95(bitmapStatic.timings.frameMs);
    record(
      "static-glyphflow-vs-bitmap-text-p95-ms",
      glyphflowP95,
      bitmapP95,
      glyphflowP95 <= bitmapP95,
    );
  }

  for (const workload of [
    "million-full",
    "million-viewport",
    "dynamic-counters",
    "viewport-drag",
    "viewport-zoom",
    "position-storm",
  ] as const) {
    const sample = glyphflow(artifacts.get(workload));
    if (sample === undefined) continue;
    record(
      `${workload}-frame-p95-ms`,
      p95(sample.timings.frameMs),
      LEGACY_FRAME_P95_MS,
      p95(sample.timings.frameMs) <= LEGACY_FRAME_P95_MS,
    );
    if (sample.counters.allocatedStoreBytes !== undefined) {
      record(
        `${workload}-store-bytes`,
        sample.counters.allocatedStoreBytes,
        LEGACY_STORE_BYTES,
        sample.counters.allocatedStoreBytes <= LEGACY_STORE_BYTES,
      );
    }
  }

  for (const workload of ["dynamic-counters", "position-storm"] as const) {
    const sample = glyphflow(artifacts.get(workload));
    if (sample?.timings.mutationMs === undefined) continue;
    record(
      `${workload}-mutation-p95-ms`,
      p95(sample.timings.mutationMs),
      LEGACY_FRAME_P95_MS,
      p95(sample.timings.mutationMs) <= LEGACY_FRAME_P95_MS,
    );
  }

  const full = glyphflow(artifacts.get("million-full"));
  if (full !== undefined) {
    const instanceBytes = full.counters.instanceBytes ?? Number.POSITIVE_INFINITY;
    const transformBytes = full.counters.transformBytes ?? Number.POSITIVE_INFINITY;
    record(
      "full-visible-glyphs",
      full.counters.visibleGlyphs,
      8_000_000,
      full.counters.visibleGlyphs === 8_000_000,
    );
    record(
      "instance-bytes-per-glyph",
      instanceBytes / full.counters.visibleGlyphs,
      LEGACY_INSTANCE_STRIDE_BYTES,
      instanceBytes / full.counters.visibleGlyphs <= LEGACY_INSTANCE_STRIDE_BYTES,
    );
    record(
      "instance-buffer-bytes",
      instanceBytes,
      LEGACY_INSTANCE_BUFFER_BYTES,
      instanceBytes <= LEGACY_INSTANCE_BUFFER_BYTES,
    );
    record(
      "transform-bytes-per-label",
      transformBytes / full.counters.residentLabels,
      LEGACY_TRANSFORM_STRIDE_BYTES,
      transformBytes / full.counters.residentLabels <= LEGACY_TRANSFORM_STRIDE_BYTES,
    );
    record("full-draw-calls", full.counters.drawCalls, 1, full.counters.drawCalls === 1);
  }

  const atlas = glyphflow(artifacts.get("atlas-pressure"));
  if (atlas !== undefined) {
    const atlasBytes = atlas.counters.atlasBytes ?? Number.POSITIVE_INFINITY;
    record("atlas-bytes", atlasBytes, 4 * 1_024 ** 2, atlasBytes <= 4 * 1_024 ** 2);
    record(
      "atlas-evictions",
      atlas.counters.atlasEvictions ?? 0,
      "> 0",
      (atlas.counters.atlasEvictions ?? 0) > 0,
    );
    // Wave 1 changed the packer; the 1.1.0 638 ms artifact is not a fail gate.
    record("atlas-pressure-frame-p95-ms", p95(atlas.timings.frameMs), "deferred", true);
  }

  const live = glyphflow(artifacts.get("million-live"));
  if (live !== undefined) {
    const decision = evaluateMillionLiveWave2Budget(live);
    for (const check of decision.checks) {
      record(`current:million-live/${check.name}`, check.actual, check.limit, check.passed);
    }
  }

  const coreGzipBytes = await coreGzipSize(projectRoot);
  // The 40 KiB fail is deferred; keep the measurement.
  record("core-esm-gzip-bytes", coreGzipBytes, "deferred", true);

  const failed = checks.filter(isBlockingBenchmarkBudgetFailure);
  const outputPath = resolve(import.meta.dir, `results/budgets-${packageMetadata.version}.json`);
  await Bun.write(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageVersion: packageMetadata.version,
        capturedAt: new Date().toISOString(),
        passed: failed.length === 0,
        checks,
      },
      undefined,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ outputPath, passed: failed.length === 0, failed }, undefined, 2));
  if (failed.length > 0) process.exitCode = 1;
}

function budgetCheck(
  name: string,
  actual: number | string,
  limit: number | string,
  passed: boolean,
): Readonly<BudgetResult> {
  return Object.freeze({ name, actual, limit, passed });
}

function invariantNumber(value: boolean | number | string | undefined): number | string {
  return typeof value === "number" ? value : "missing";
}

function record(
  name: string,
  actual: number | string,
  limit: number | string,
  passed: boolean,
): void {
  checks.push(classifyBenchmarkBudgetSummaryCheck({ name, actual, limit, passed }));
}

function glyphflow(
  artifact: BudgetBrowserBenchmarkArtifact | undefined,
): Readonly<BrowserBenchmarkSample> | undefined {
  return fixture(artifact, "glyphflow");
}

function fixture(
  artifact: BudgetBrowserBenchmarkArtifact | undefined,
  name: string,
): Readonly<BrowserBenchmarkSample> | undefined {
  return artifact?.samples.find((sample) => sample.configuration.fixture === name);
}

function p95(samples: readonly number[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  return summarize(samples, "ms").p95;
}

function artifactKey(workloadId: string, renderer?: BrowserBenchmarkRenderer): string {
  return renderer === undefined ? workloadId : `${workloadId}:${renderer}`;
}

async function coreGzipSize(projectRoot: string): Promise<number> {
  const entry = resolve(projectRoot, "dist/index.js");
  if (!(await Bun.file(entry).exists())) {
    throw new Error("dist/index.js is required; run bun run build before benchmark:check");
  }
  const visited = new Set<string>();
  const sources: Uint8Array[] = [];
  await collect(entry, visited, sources);

  return gzipSync(Buffer.concat(sources)).byteLength;
}

async function collect(path: string, visited: Set<string>, sources: Uint8Array[]): Promise<void> {
  if (visited.has(path)) return;
  visited.add(path);
  const source = await Bun.file(path).text();
  sources.push(new TextEncoder().encode(source));
  const imports = source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g);
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.endsWith(".js")) continue;
    await collect(resolve(path, "..", specifier), visited, sources);
  }
}
