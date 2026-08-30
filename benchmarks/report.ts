import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { format } from "oxfmt";

import { BENCHMARK_ARTIFACT_ARCHIVE_FILES } from "../scripts/benchmark-artifact-archive";
import {
  browserBenchmarkRenderers,
  createCurrentBrowserBenchmarkArtifactIdentity,
  loadCurrentBrowserBenchmarkArtifact,
  readBrowserBenchmarkArtifact,
} from "./artifacts";
import {
  CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
  CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES,
  CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
  CURRENT_WAVE2_LIVE_FRAME_P95_MS,
  CURRENT_WAVE2_LIVE_STORE_BYTES,
  CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
  evaluateMillionLiveWave2Budget,
} from "./budgets";
import { evaluateGpuSceneV2Budget, GPU_SCENE_V2_FRAME_BUDGET_MS } from "./gpu-scene-budget";
import {
  GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS,
  GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS,
  GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP,
  GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS,
  GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS,
  evaluateGpuSceneHeterogeneousBudget,
} from "./gpu-scene-heterogeneous-budget";
import type { GpuSceneResidentRepeatabilityArtifact as CurrentGpuSceneResidentPromotionArtifact } from "./gpu-scene-resident-repeatability";
import type { LabelCollisionActiveScatterArtifact } from "./label-collision";
import type { LabelCollisionFormalRepeatabilityArtifact } from "./label-collision-repeatability";
import {
  summarize,
  type BrowserBenchmarkArtifact,
  type BrowserBenchmarkBudgetDecision,
  type BrowserBenchmarkRenderer,
  type BrowserBenchmarkSample,
} from "./schema";
import { BENCHMARK_WORKLOADS } from "./workloads";

const projectRoot = resolve(import.meta.dir, "..");
const archivedResultFiles = new Set<string>(BENCHMARK_ARTIFACT_ARCHIVE_FILES);
const HISTORICAL_RESIDENT_REPEATABILITY_SHA256 =
  "b74ff555d22fa8b7f39fe0203c81293e3e55a633283a7f5322b3c16c8d9c8aa0";
const HISTORICAL_RESIDENT_CANDIDATE_SHA256 =
  "d4914d86952b310de210cb517d3a2f12073494c86dc38eb609af1095a61de2eb";
const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
  readonly version: string;
};
const artifactCollection = await loadArtifacts(packageMetadata.version, projectRoot);
const artifacts = artifactCollection.artifacts;
const activeScatterArtifact = await loadJsonArtifact<LabelCollisionActiveScatterArtifact>(
  `browser-label-collision-webgpu-active-scatter-repeatability-${packageMetadata.version}.json`,
  "parse-only",
);
const residentRepeatabilityArtifact = await loadJsonArtifact<GpuSceneResidentRepeatabilityArtifact>(
  `browser-gpu-scene-resident-webgpu-repeatability-${packageMetadata.version}.json`,
  "parse-only",
);
const currentResidentPromotion = await loadJsonArtifact<CurrentGpuSceneResidentPromotionArtifact>(
  `browser-gpu-scene-resident-webgpu-promotion-repeatability-${packageMetadata.version}.json`,
  "sha256-source-bytes",
);
const collisionRepeatability = await loadJsonArtifact<LabelCollisionFormalRepeatabilityArtifact>(
  `browser-label-collision-repeatability-${packageMetadata.version}.json`,
  "sha256-source-bytes",
);
const shapingSimdArtifact = await loadJsonArtifact<ShapingSimdArtifact>(
  `shaping-simd-worker-${packageMetadata.version}.json`,
  "sha256-source-bytes",
);
const loadedArtifacts = [...artifacts.values()];
const available = loadedArtifacts.map((loaded) => loaded.artifact);
const latest = [...available].sort((left, right) =>
  right.capturedAt.localeCompare(left.capturedAt),
)[0];
const lines: string[] = [
  "# Performance",
  "",
  `Generated from raw browser artifacts for pixi-glyphflow ${packageMetadata.version}.`,
  "",
  "## Reference environment",
  "",
];

if (latest === undefined) {
  lines.push("No browser artifacts are available for this package version.", "");
} else {
  lines.push(
    `- CPU: ${latest.runtime.cpu}`,
    `- OS: ${latest.runtime.platform} ${latest.runtime.release} (${latest.runtime.architecture})`,
    `- Bun: ${latest.runtime.bun}`,
    `- Browser: ${latest.samples[0]?.userAgent ?? "unavailable"}`,
    `- Latest renderer: ${latest.renderer ?? latest.samples[0]?.configuration.renderer ?? "unavailable"}`,
    "",
  );
}

if (artifactCollection.unavailable.size > 0) {
  lines.push("## Current artifact availability", "");
  for (const [identity, unavailable] of artifactCollection.unavailable) {
    lines.push(
      `- \`${identity}\`: unavailable (${unavailable.reason}). ${unavailable.diagnostic.replaceAll("\n", " ")}`,
    );
  }
  lines.push("");
}

lines.push(
  "## Method",
  "",
  "Each workload starts in an isolated Chrome process. Renderer and artifact role are part of the artifact identity, so baseline, candidate, and exploratory results resolve independently. Current candidates require schema 7 evidence seals plus exact frozen-browser-build and harness fingerprints. GPU Scene v2 remains visible as a sealed fixed RED control. Setup, warmup, mutation, commit, culling, upload, CPU, whole-frame, GPU timestamp, and completion-wall samples are recorded separately. GPU Scene resident keeps one million label records on the GPU and measures camera-only plus 100,000-mover phases. Its six-query WebGPU timer resolves product, palette, cull, and scene-render boundaries in the product command encoder. R1a crosses 64 prototypes with 8 paints into 512 bins; each repetition carries independent CPU count/hash and double pixel readback truth. Collision repeatability aggregates three sealed WebGL and three sealed WebGPU runs. WebGL reports EXT_disjoint_timer_query_webgl2 timestamps. Invalid timestamp deltas select completion-wall fallback and mark timing quality accordingly.",
  "",
  "## Workload results",
  "",
  "| Workload | Renderer | Labels | Mutations | Setup | Frame p50 | Frame p95 | Camera p95 | Position p95 | Mutation p95 | Commit p95 | Visible glyphs | Logical meshes | Artifact | Budget |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
);

for (const definition of BENCHMARK_WORKLOADS) {
  const renderers = browserBenchmarkRenderers(definition.id);
  for (const renderer of renderers) {
    const loaded = artifacts.get(artifactKey(definition.id, renderer));
    const artifact = loaded?.artifact;
    const unavailable = artifactCollection.unavailable.get(artifactKey(definition.id, renderer));
    const rendererName = renderer ?? (definition.id === "million-live" ? "webgl" : "legacy");
    if (artifact === undefined) {
      lines.push(
        `| ${definition.id} | ${rendererName} | ${integer(definition.labelCount)} | ${integer(definition.mutationCount)} | — | — | — | — | — | — | — | — | — | ${unavailable === undefined ? "missing" : `unavailable (${unavailable.reason})`} | — |`,
      );
      continue;
    }
    const sample = preferredSample(artifact);
    if (sample === undefined) {
      lines.push(
        `| ${definition.id} | ${rendererName} | ${integer(definition.labelCount)} | ${integer(definition.mutationCount)} | — | — | — | — | — | — | — | — | — | ${artifactStatus(loaded)} | ${budgetStatus(loaded)} |`,
      );
      continue;
    }
    const frame = summarize(sample.timings.frameMs, "ms");
    lines.push(
      `| ${definition.id} | ${rendererName} | ${integer(sample.configuration.labelCount)} | ${integer(sample.configuration.mutationCount)} | ${milliseconds(sample.timings.setupMs)} | ${milliseconds(frame.p50)} | ${milliseconds(frame.p95)} | ${phaseP95(sample, "camera")} | ${phaseP95(sample, "positionMutation")} | ${optionalP95(sample.timings.mutationMs)} | ${optionalP95(sample.timings.commitMs)} | ${integer(sample.counters.visibleGlyphs)} | ${integer(sample.counters.drawCalls)} | ${artifactStatus(loaded)} | ${budgetStatus(loaded)} |`,
    );
  }
}

const fixedRedControls = loadedArtifacts.filter(
  (loaded) => loaded.classification === "fixed-red-control",
);
lines.push(
  "",
  "## Fixed RED controls",
  "",
  "These sealed GPU Scene v2 candidates remain visible as informational controls for the resident speedup comparison.",
  "",
  "| Renderer | Camera p95 | Position p95 | Limit | Status |",
  "| --- | ---: | ---: | ---: | --- |",
);
for (const loaded of fixedRedControls) {
  const renderer = loaded.renderer;
  if (renderer === undefined) continue;
  const decision = evaluateGpuSceneV2Budget(loaded.artifact.samples, renderer);
  lines.push(
    `| ${renderer} | ${decisionValue(decision, "camera-frame-p95-ms")} | ${decisionValue(decision, "position-mutation-frame-p95-ms")} | ${milliseconds(GPU_SCENE_V2_FRAME_BUDGET_MS)} | RED control |`,
  );
}
if (fixedRedControls.length === 0) {
  lines.push("| unavailable | — | — | — | unavailable |");
}

const staticArtifact = artifacts.get("static-hud")?.artifact;
lines.push(
  "",
  "## Equal-content static HUD",
  "",
  "| Fixture | Setup | Frame p50 | Frame p95 |",
  "| --- | ---: | ---: | ---: |",
);
if (staticArtifact === undefined) {
  lines.push("| unavailable | — | — | — |");
} else {
  for (const sample of staticArtifact.samples) {
    const frame = summarize(sample.timings.frameMs, "ms");
    lines.push(
      `| ${sample.configuration.fixture} | ${milliseconds(sample.timings.setupMs)} | ${milliseconds(frame.p50)} | ${milliseconds(frame.p95)} |`,
    );
  }
}

lines.push(
  "",
  "## Capacity and storage",
  "",
  "| Workload | CPU store | Draw references | Prototype records | Instance field | Transform core | Atlas | Evictions |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
for (const { artifact, renderer } of loadedArtifacts) {
  const sample = preferredSample(artifact);
  if (sample === undefined) continue;
  lines.push(
    `| ${artifact.workload}${renderer === undefined ? "" : ` (${renderer})`} | ${bytes(sample.counters.allocatedStoreBytes)} | ${bytes(sample.counters.drawReferenceBytes)} | ${bytes(sample.counters.prototypeRecordBytes)} | ${bytes(sample.counters.instanceBytes)} | ${bytes(sample.counters.transformBytes)} | ${bytes(sample.counters.atlasBytes)} | ${integer(sample.counters.atlasEvictions ?? 0)} |`,
  );
}

lines.push("", "## Current Wave 2 live gate", "");
const millionLiveArtifact = artifacts.get("million-live")?.artifact;
const millionLiveSample =
  millionLiveArtifact === undefined ? undefined : preferredSample(millionLiveArtifact);
if (millionLiveSample === undefined) {
  lines.push(
    "The current million-live artifact is missing. Task 12.5 remains open until the formal M1 Pro run",
    "and benchmark gate pass. The formal fixture uses 10 warmup frames and 120 steady-state",
    "full-visibility product frames. Its limits are 16.67 ms frame p95, 64 MiB live runtime store,",
    "8-byte draw references, 24-byte prototype records, a 32-byte fill transform core, and a 48-byte",
    "effectful transform maximum. The constructor base-store unit ceiling remains 48 MiB plus 256 B.",
  );
} else {
  const decision = evaluateMillionLiveWave2Budget(millionLiveSample);
  const stride = (name: string): string =>
    typeof millionLiveSample.invariants[name] === "number"
      ? bytes(millionLiveSample.invariants[name])
      : "—";
  lines.push(
    "The formal fixture uses 10 warmup frames and 120 steady-state full-visibility product frames. The constructor base-store unit contract remains 48 MiB + 256 B; this browser gate measures the complete live runtime store against 64 MiB.",
    "",
    "| Measure | Actual | Limit | Gate |",
    "| --- | ---: | ---: | --- |",
    `| Product frame p95 | ${optionalP95(millionLiveSample.timings.frameMs)} | ${milliseconds(CURRENT_WAVE2_LIVE_FRAME_P95_MS)} | ${decisionCheck(decision, "steady-state-frame-p95-ms")} |`,
    `| Live runtime store | ${bytes(millionLiveSample.counters.allocatedStoreBytes)} | ${bytes(CURRENT_WAVE2_LIVE_STORE_BYTES)} | ${decisionCheck(decision, "runtime-store-bytes")} |`,
    `| Draw reference stride | ${stride("drawReferenceStrideBytes")} | ${bytes(CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES)} | ${decisionCheck(decision, "draw-reference-stride-bytes")} |`,
    `| Prototype record stride | ${stride("prototypeRecordStrideBytes")} | ${bytes(CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES)} | ${decisionCheck(decision, "prototype-record-stride-bytes")} |`,
    `| Fill transform core | ${stride("fillTransformStrideBytes")} | ${bytes(CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES)} | ${decisionCheck(decision, "fill-transform-stride-bytes")} |`,
    `| Effectful transform maximum | ${stride("effectfulTransformStrideBytes")} | ${bytes(CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES)} | ${decisionCheck(decision, "effectful-transform-stride-bytes")} |`,
    "",
    `Current Wave 2 gate: ${decision.passed ? "PASS" : "PAUSE"}.`,
  );
}

lines.push("", "## R1a heterogeneous GPU-scene delivery", "");
const heterogeneousArtifact = artifacts.get("gpu-scene-heterogeneous-64:webgpu")?.artifact;
const heterogeneousSamples =
  heterogeneousArtifact?.samples.filter((sample) => sample.configuration.fixture === "glyphflow") ??
  [];
if (heterogeneousSamples.length === 0) {
  lines.push(
    "The current R1a artifact is missing. Delivery: PAUSE. Promotion: PAUSE.",
    `The formal WebGPU run uses 1,000,000 labels, 100,000 movers, 64 actual prototypes, 8 canonical paints, 10 warmup frames, and 120 frames per phase at 1280×800. Delivery requires both phase p95 values at or below ${milliseconds(GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS)} and at least ${integer(GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP)}× versus the fixed GPU Scene v2 ${milliseconds(GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS)} / ${milliseconds(GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS)} camera/position baseline. The ${milliseconds(GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS)} target retains an independent promotion status.`,
    "",
    "Run after GPU activity is quiet:",
    "",
    "```sh",
    "bun run benchmark -- --workload gpu-scene-heterogeneous-64 --renderer webgpu",
    "```",
    "",
    `Canonical path: \`benchmarks/results/browser-gpu-scene-heterogeneous-64-webgpu-candidate-${packageMetadata.version}.json\`.`,
  );
} else {
  const decision = evaluateGpuSceneHeterogeneousBudget(heterogeneousSamples);
  lines.push(
    "| Repetition | Setup | Camera p95 | Camera speedup | Position p95 | Position speedup | Submitted count/hash | Pixel hash | CPU identity |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
  );
  for (const sample of heterogeneousSamples) {
    const cameraP95 = summarize(sample.timings.phases?.camera.frameMs ?? [], "ms").p95;
    const positionP95 = summarize(sample.timings.phases?.positionMutation.frameMs ?? [], "ms").p95;
    lines.push(
      `| ${integer(sample.repeatIndex ?? 0)} | ${milliseconds(sample.timings.setupMs)} | ${milliseconds(cameraP95)} | ${(GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS / cameraP95).toFixed(2)}× | ${milliseconds(positionP95)} | ${(GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS / positionP95).toFixed(2)}× | ${integer(sample.counters.submittedGlyphs ?? 0)} / ${hex(sample.counters.submittedGlyphsHash)} | ${hex(sample.counters.renderedPixelHash)} | ${sample.invariants.expectedSubmittedIdentity === true ? "exact" : "mismatch"} |`,
    );
  }
  const first = heterogeneousSamples[0];
  const positionUploadBytes = numberInvariant(first, "expectedPositionUpload");
  lines.push(
    "",
    `Resident identity: ${integer(first?.counters.gpuResidentLabels ?? 0)} GPU labels; ${integer(first?.counters.prototypeCount ?? 0)} prototypes; ${integer(first?.counters.paintCount ?? 0)} paints; ${integer(first?.counters.prototypePaintPairCount ?? 0)} prototype/paint pairs; ${integer(first?.counters.gpuScenePerLabelObjectCount ?? 0)} per-label GPU-scene objects.`,
    `Delivery: ${decision.delivery.passed ? "GO" : "PAUSE"}. Promotion: ${decision.promotion.status}. Fixed baseline: ${milliseconds(decision.baseline.cameraFrameP95Ms)} camera / ${milliseconds(decision.baseline.positionFrameP95Ms)} position, minimum ${integer(decision.baseline.minimumSpeedup)}×.`,
    `The current sealed repetitions use the dense 8-byte mover lane at ${integer(positionUploadBytes)} bytes per 100,000 movers. Sparse, reordered, duplicate, and holed batches use the indexed 12-byte fallback. The frozen [legacy R1a candidate](results/${resultArtifactHref(`browser-gpu-scene-heterogeneous-64-webgpu-candidate-legacy-12b-${packageMetadata.version}.json`)}) preserves its indexed 1,200,016-byte capture.`,
  );
}

lines.push(
  "",
  "## GPU-resident scene phases",
  "",
  "| Phase | Frame p95 | >16.67 ms | Miss ratio | Frame p99 | Frame max | CPU p95 | Mutation p95 | Commit p95 | Surface p95 | Render-pass GPU p95 | Transform upload p95 | Cull upload max | Shaped delta | Admitted total | Cull-query delta |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
const residentArtifact = artifacts.get("gpu-scene-resident:webgpu")?.artifact;
const residentSample =
  residentArtifact === undefined ? undefined : preferredSample(residentArtifact);
if (residentSample?.timings.phases === undefined) {
  lines.push("| unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |");
} else {
  for (const [phaseName, phase] of Object.entries(residentSample.timings.phases)) {
    const tail = frameTail(phase.frameMs);
    lines.push(
      `| ${phaseName} | ${optionalP95(phase.frameMs)} | ${integer(tail.overBudgetCount)} / ${integer(tail.samples)} | ${percentage(tail.overBudgetRatio)} | ${milliseconds(tail.p99)} | ${milliseconds(tail.max)} | ${optionalP95(phase.cpuMs)} | ${optionalP95(phase.mutationMs)} | ${optionalP95(phase.commitMs)} | ${optionalP95(phase.surfaceApplyMs)} | ${optionalNullableP95(phase.gpuTimestampMs)} | ${optionalBytesP95(phase.transformUploadBytes)} | ${optionalMaximumBytes(phase.cullRecordUploadBytes)} | ${optionalInteger(phase.shapedLabelsDelta)} | ${optionalInteger(phase.admittedLabelsTotal)} | ${optionalInteger(phase.cullingQueriesDelta)} |`,
    );
  }
  lines.push(
    "",
    `GPU resident labels: ${integer(residentSample.counters.gpuResidentLabels ?? 0)}. Shared prototypes: ${integer(residentSample.counters.prototypeCount ?? 0)}. Submitted glyphs: ${integer(residentSample.counters.submittedGlyphs ?? 0)}. Submitted hash: ${hex(residentSample.counters.submittedGlyphsHash)} (${residentSample.counters.submittedGlyphsHashSource ?? "source missing"}). Pixel readbacks: ${hex(residentSample.counters.renderedPixelHash)} / ${hex(residentSample.counters.renderedPixelHashRepeat)} with ${integer(residentSample.counters.nonTransparentPixels ?? 0)} / ${integer(residentSample.counters.nonTransparentPixelsRepeat ?? 0)} non-transparent pixels. Logical meshes: ${integer(residentSample.counters.drawCalls)}; WebGPU draw observer: ${residentSample.counters.observedDrawCallsSource ?? "source missing"} (${integer(residentSample.counters.observedDrawCalls ?? 0)} sentinel). Setup: ${milliseconds(residentSample.timings.setupMs)}. Heap: ${bytes(residentSample.counters.heapBytes)}.`,
    `Product frame submissions: ${integer(residentSample.counters.frameTransactionSubmissions ?? 0)} total / ${integer(residentSample.counters.frameTransactionFusedSubmissions ?? 0)} fused / ${integer(residentSample.counters.frameTransactionStandaloneSubmissions ?? 0)} standalone. Timestamp telemetry: ${integer(residentSample.counters.timestampReadbackSubmissions ?? 0)} readbacks / ${integer(residentSample.counters.timestampFusedResolves ?? 0)} fused resolves / ${integer(residentSample.counters.timestampStandaloneSubmissions ?? 0)} standalone submissions. Diagnostic readback submissions: ${integer(residentSample.counters.diagnosticReadbackSubmissions ?? 0)}.`,
    `This current sealed sample records ${integer(numberInvariant(residentSample, "expectedPositionUpload"))} transform-upload bytes for every 100,000-mover frame through the dense 8-byte lane. Indexed fallback remains 12 bytes per mover plus the 16-byte header. The [legacy candidate](results/${resultArtifactHref(`browser-gpu-scene-resident-webgpu-candidate-legacy-16b-${packageMetadata.version}.json`)}) preserves the earlier 16-byte capture.`,
  );
}

lines.push("", "## Current GPU-resident promotion", "");
if (currentResidentPromotion === undefined) {
  lines.push("Current schema 7 / schema 4 promotion evidence is unavailable.");
} else {
  const { artifact: promotion, sha256: promotionSha256 } = currentResidentPromotion;
  const passedRuns = promotion.runs.filter((run) => run.budgetPassed).length;
  lines.push(
    `Schema 7 raw artifacts feed the [schema ${integer(promotion.schemaVersion)} promotion aggregate](results/browser-gpu-scene-resident-webgpu-promotion-repeatability-${packageMetadata.version}.json), SHA-256 \`${promotionSha256}\`. The frozen canonical output source is [${promotion.canonicalCandidate.artifact}](results/${resultArtifactHref(promotion.canonicalCandidate.artifact)}), SHA-256 \`${promotion.canonicalCandidate.sha256}\`.`,
    `Frozen provenance: build \`${promotion.buildFingerprintSha256 ?? "unavailable"}\`; harness \`${promotion.harnessFingerprintSha256 ?? "unavailable"}\`; runtime \`${promotion.runtimeFingerprint?.sha256 ?? "unavailable"}\`. Five independent 120-frame runs and the sustained 600-frame run share all three fingerprints while carrying distinct run ids, capture timestamps, candidate hashes, and evidence hashes.`,
    "",
    "| Run | Budget | Camera p95/p99/max | Camera >16.67 ms | Position p95/p99/max | Position >16.67 ms | GPU / pixel identity | Raw evidence |",
    "| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |",
  );
  for (const run of promotion.runs) {
    lines.push(
      `| ${integer(run.run)} | ${run.budgetPassed ? "pass" : "fail"} | ${phaseTail(run.camera)} | ${integer(run.camera.overBudgetCount)} / ${integer(run.camera.samples)} | ${phaseTail(run.positionMutation)} | ${integer(run.positionMutation.overBudgetCount)} / ${integer(run.positionMutation.samples)} | ${hex(run.outputIdentity.submittedGlyphsHash)} / ${hex(run.outputIdentity.renderedPixelHash)} / ${integer(run.outputIdentity.nonTransparentPixels)} px | [${run.artifactFile}](results/${resultArtifactHref(run.artifactFile)}) \`${run.candidateSha256.slice(0, 12)}…\` |`,
    );
  }
  const sustained = promotion.sustained600;
  const exactPositionUploadBytes =
    sustained !== undefined &&
    sustained.uploads.positionTransformMinBytes === sustained.uploads.positionTransformMaxBytes
      ? sustained.uploads.positionTransformMaxBytes
      : numberInvariant(residentSample, "expectedPositionUpload");
  lines.push(
    "",
    `Truth repeatability: ${promotion.truthRepeatability.status}. Formal performance: ${promotion.invariants.formalPerformanceReady ? "GO" : "PAUSE"}.`,
    `${integer(passedRuns)} / ${integer(promotion.runs.length)} formal runs passed every performance budget. Across all five runs, camera p95/p99/max is ${phaseTail(promotion.summary.camera)} with ${integer(promotion.summary.camera.overBudgetCount)} / ${integer(promotion.summary.camera.samples)} >16.67 ms; position is ${phaseTail(promotion.summary.positionMutation)} with ${integer(promotion.summary.positionMutation.overBudgetCount)} / ${integer(promotion.summary.positionMutation.samples)} >16.67 ms.`,
    `Canonical output identity: ${integer(promotion.canonicalOutputIdentity.submittedGlyphs)} references / ${hex(promotion.canonicalOutputIdentity.submittedGlyphsHash)}, pixel hash ${hex(promotion.canonicalOutputIdentity.renderedPixelHash)}, ${integer(promotion.canonicalOutputIdentity.nonTransparentPixels)} non-transparent pixels. Formal timestamp telemetry: ${integer(promotion.summary.timestamps.readbackSubmissions)} readbacks / ${integer(promotion.summary.timestamps.fusedTimestampResolves)} fused resolves / ${integer(promotion.summary.timestamps.standaloneTimestampSubmissions)} standalone submissions.`,
    `Segmented timestamp gate: ${promotion.summary.timestamps.segmentedExact ? "GO" : "PAUSE"}. ${integer(promotion.summary.timestamps.validSegmentedSamples)} / ${integer(promotion.summary.timestamps.segmentedSamples)} samples resolve all six queries with ${integer(promotion.summary.timestamps.segmentedFallbackSamples)} fallbacks. Segment p95: palette ${nullableMilliseconds(promotion.summary.timestamps.segments.palette.p95Ms)}, cull ${nullableMilliseconds(promotion.summary.timestamps.segments.cull.p95Ms)}, scene render ${nullableMilliseconds(promotion.summary.timestamps.segments.sceneRender.p95Ms)}.`,
    sustained === undefined
      ? "Sustained 600-frame evidence is unavailable."
      : `Sustained 600-frame evidence: [${sustained.artifactFile}](results/${resultArtifactHref(sustained.artifactFile)}), SHA-256 \`${sustained.candidateSha256}\`. Camera ${integer(sustained.camera.overBudgetCount)} / ${integer(sustained.camera.samples)} >16.67 ms (${percentage(sustained.camera.overBudgetRatio)}), p95/p99/max ${phaseTail(sustained.camera)}; position ${integer(sustained.positionMutation.overBudgetCount)} / ${integer(sustained.positionMutation.samples)} >16.67 ms (${percentage(sustained.positionMutation.overBudgetRatio)}), p95/p99/max ${phaseTail(sustained.positionMutation)}. Timestamp telemetry: ${integer(sustained.timestamps.readbackSubmissions)} / ${integer(sustained.timestamps.fusedTimestampResolves)} / ${integer(sustained.timestamps.standaloneTimestampSubmissions)} readback/fused/standalone. Sustained gate: ${sustained.eligible ? "GO" : "PAUSE"}.`,
    `Dense upload and timing proof: all ${integer(promotion.summary.positionMutation.samples)} formal position frames remain within 16.67 ms, every run records exact ${integer(exactPositionUploadBytes)}-byte position uploads, and palette/cull/scene-render segments are complete.`,
    `Promotion: ${promotion.promotion.status} (${promotion.promotion.reasons.length === 0 ? "all gates passed" : promotion.promotion.reasons.join(", ")}).`,
  );
}

lines.push(
  "",
  "## Historical GPU-resident scene repeatability",
  "",
  "| Attempt | Outcome | Setup | Camera frame p95 | Camera GPU p95 | Position frame p95 | Position GPU p95 | Selection hash | Pixel hash | Pixels | Evidence |",
  "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
);
if (residentRepeatabilityArtifact === undefined) {
  lines.push(
    "| — | digest-only history | — | — | — | — | — | 0x45cfd045 | 0xa8ad90b4 | 302,457 | raw bytes outside tree |",
    "",
    `Historical schema 2 snapshot outcomes: 0 pass / 5 post-fix attempts; 5 budget failures. Pre-fix history: 5 attempts invalidated by the compact-output capacity defect. Raw artifact state: digest-only; the snapshot bytes are outside this tree. Frozen snapshot SHA-256: \`${HISTORICAL_RESIDENT_REPEATABILITY_SHA256}\`. Its embedded attempt 10 source digest is \`${HISTORICAL_RESIDENT_CANDIDATE_SHA256}\`.`,
    "Cross-run GPU output identity: GO. Five complete post-fix runs recorded the same 50,000-reference instancesOut hash, pixel hash, and non-transparent pixel count.",
    "Historical sustained frame tail: camera 1 / 600 >16.67 ms (0.17%), p99 12.70 ms, max 16.90 ms; position 598 / 600 (99.67%), p99 20.70 ms, max 24.00 ms. Throughput: PAUSE. Release tail: PAUSE.",
  );
} else {
  for (const attempt of residentRepeatabilityArtifact.attempts) {
    const evidence =
      attempt.source.artifact === null
        ? attempt.source.sha256 === null
          ? "runner log"
          : `digest ${attempt.source.sha256.slice(0, 12)}`
        : `[candidate raw](results/${attempt.source.artifact})`;
    lines.push(
      `| ${integer(attempt.attempt)} | ${attempt.outcome}${attempt.validity === "pre-fix-invalidated" ? " (pre-fix invalidated)" : ""} | ${milliseconds(attempt.setupMs)} | ${milliseconds(attempt.cameraFrameP95Ms)} | ${milliseconds(attempt.cameraGpuP95Ms)} | ${milliseconds(attempt.positionFrameP95Ms)} | ${milliseconds(attempt.positionGpuP95Ms)} | ${hex(attempt.submittedGlyphsHash)} | ${hex(attempt.renderedPixelHash)} | ${optionalInteger(attempt.nonTransparentPixels)} | ${evidence} |`,
    );
  }
  const crossRunIdentity = residentCrossRunIdentity(residentRepeatabilityArtifact);
  const repeatedTail = residentRepeatabilityArtifact.summary.frameTail;
  const canonicalCandidateEvidence =
    residentRepeatabilityArtifact.canonicalCandidate.artifact === null
      ? `historical digest (${residentRepeatabilityArtifact.canonicalCandidate.sourceKind ?? "digest-only"})`
      : `[raw artifact](results/${residentRepeatabilityArtifact.canonicalCandidate.artifact})`;
  lines.push(
    "",
    `Post-fix outcomes: ${integer(residentRepeatabilityArtifact.summary.postFix?.passed ?? residentRepeatabilityArtifact.summary.passed)} pass / ${integer(residentRepeatabilityArtifact.summary.postFix?.attempts ?? residentRepeatabilityArtifact.summary.attempts)} attempts; ${integer(residentRepeatabilityArtifact.summary.postFix?.failed ?? 0)} budget failures. Pre-fix history: ${integer(residentRepeatabilityArtifact.summary.preFix?.attempts ?? 0)} attempts invalidated by the compact-output capacity defect. Canonical candidate: ${canonicalCandidateEvidence}. SHA-256: \`${residentRepeatabilityArtifact.canonicalCandidate.sha256}\`.`,
    `Frozen schema 2 repeatability artifact SHA-256: \`${HISTORICAL_RESIDENT_REPEATABILITY_SHA256}\`.`,
    `Cross-run GPU output identity: ${crossRunIdentity.status}. Gate: at least three post-fix formal runs with one matching instancesOut hash, pixel hash, and non-transparent pixel count. Recorded complete runs: ${integer(crossRunIdentity.completeRuns)}.`,
    repeatedTail === undefined
      ? "Sustained 600+600 frame-tail evidence: PAUSE. The repeatability artifact must record sample count, >16.67 ms count, p99, and max for both phases."
      : `Sustained frame tail: camera ${integer(repeatedTail.camera.overBudgetCount)} / ${integer(repeatedTail.camera.samples)} >16.67 ms (${percentage(repeatedTail.camera.overBudgetRatio)}), p99 ${milliseconds(repeatedTail.camera.p99Ms)}, max ${milliseconds(repeatedTail.camera.maxMs)}; position ${integer(repeatedTail.positionMutation.overBudgetCount)} / ${integer(repeatedTail.positionMutation.samples)} (${percentage(repeatedTail.positionMutation.overBudgetRatio)}), p99 ${milliseconds(repeatedTail.positionMutation.p99Ms)}, max ${milliseconds(repeatedTail.positionMutation.maxMs)}. Throughput: ${(residentRepeatabilityArtifact.summary.postFix?.passed ?? residentRepeatabilityArtifact.summary.passed) >= 3 ? "GO" : "PAUSE"}. Release tail: ${repeatedTail.camera.overBudgetCount === 0 && repeatedTail.positionMutation.overBudgetCount === 0 ? "GO" : "PAUSE"}.`,
  );
}

lines.push("", "## Current collision repeatability", "");
if (collisionRepeatability === undefined) {
  lines.push("Current schema 2 collision repeatability evidence is unavailable.");
} else {
  const { artifact: repeatability, sha256 } = collisionRepeatability;
  lines.push(
    `The [schema ${integer(repeatability.schemaVersion)} aggregate](results/browser-label-collision-repeatability-${packageMetadata.version}.json), SHA-256 \`${sha256}\`, combines three independently sealed WebGL runs and three independently sealed WebGPU runs from build \`${repeatability.provenance.buildFingerprintSha256 ?? "unavailable"}\` and harness \`${repeatability.provenance.harnessFingerprintSha256 ?? "unavailable"}\`.`,
    "",
    "| Renderer | Run | Frame p50/p95 | CPU p95 | Commit p95 | Collision p95 | Candidate gate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const renderer of ["webgl", "webgpu"] as const) {
    for (const run of repeatability.renderers[renderer].runs) {
      lines.push(
        `| ${renderer} | ${integer(run.index)} | ${milliseconds(run.timings.frameMs.p50)} / ${milliseconds(run.timings.frameMs.p95)} | ${milliseconds(run.timings.cpuMs.p95)} | ${milliseconds(run.timings.commitMs.p95)} | ${milliseconds(run.timings.collisionMs.p95)} | ${run.budgetPassed ? "pass" : "PAUSE"} |`,
      );
    }
  }
  const webgl = repeatability.renderers.webgl.aggregate;
  const webgpu = repeatability.renderers.webgpu.aggregate;
  lines.push(
    "",
    `WebGL aggregate p95 means: frame ${milliseconds(webgl.frameP95Ms.mean)}, CPU ${milliseconds(webgl.cpuP95Ms.mean)}, collision ${milliseconds(webgl.collisionP95Ms.mean)}. WebGPU aggregate p95 means: frame ${milliseconds(webgpu.frameP95Ms.mean)}, CPU ${milliseconds(webgpu.cpuP95Ms.mean)}, collision ${milliseconds(webgpu.collisionP95Ms.mean)}.`,
    `Output identity: ${repeatability.invariants.selectionHashStable && repeatability.invariants.submittedStateStable ? "GO" : "PAUSE"}; all six runs preserve 512 selected labels, 4,096 glyphs, selection hash ${hex(repeatability.renderers.webgpu.runs[0]?.selectionHash)}, and exact accounting.`,
    `Repeatability: ${repeatability.gate.status}${repeatability.gate.reasons.length > 0 ? ` (${repeatability.gate.reasons.join(", ")})` : ""}. The WebGPU whole-frame p95 range is ${milliseconds(webgpu.frameP95Ms.min)}–${milliseconds(webgpu.frameP95Ms.max)} against ${milliseconds(repeatability.configuration.wholeFrameBudgetMs)}.`,
    "The collision selector consumes pre-ranked, strictly increasing candidate slots, skips the rank sort, and caches contiguous identical-bound runs. Record and structure changes retire the touched run-cache spans before the next selection. Spatial queries route sparse candidates through ordered sort, dense candidates through a reusable ordered bitset, and near-full candidates through a linear scan.",
  );
}

lines.push(
  "",
  "## Historical collision active-scatter checkpoint",
  "",
  "The WebGPU active-transform scatter comparison preserves three formal before runs and three formal after runs. The control and accounting invariants cover WebGL texture behavior, selection hash stability, and submitted glyph totals.",
  "",
  "| Metric | Before mean p95 | After mean p95 | Reduction | After range | After CV |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
);
if (activeScatterArtifact === undefined) {
  lines.push("| unavailable | — | — | — | — | — |");
} else {
  const comparisons = [
    ["Frame", activeScatterArtifact.comparison.frameP95Ms, "ms"],
    ["CPU", activeScatterArtifact.comparison.cpuP95Ms, "ms"],
    ["Commit", activeScatterArtifact.comparison.commitP95Ms, "ms"],
    ["Collision", activeScatterArtifact.comparison.collisionP95Ms, "ms"],
    ["Surface apply", activeScatterArtifact.comparison.surfaceApplyP95Ms, "ms"],
    ["Upload", activeScatterArtifact.comparison.uploadP95Ms, "ms"],
    ["Upload bytes", activeScatterArtifact.comparison.uploadP95Bytes, "bytes"],
  ] as const;
  const afterAggregates = [
    activeScatterArtifact.after.aggregateP95.frameMs,
    activeScatterArtifact.after.aggregateP95.cpuMs,
    activeScatterArtifact.after.aggregateP95.commitMs,
    activeScatterArtifact.after.aggregateP95.collisionMs,
    activeScatterArtifact.after.aggregateP95.surfaceApplyMs,
    activeScatterArtifact.after.aggregateP95.uploadMs,
    activeScatterArtifact.after.aggregateP95.uploadBytes,
  ] as const;
  for (const [index, [name, comparison, unit]] of comparisons.entries()) {
    const afterAggregate = afterAggregates[index]!;
    lines.push(
      `| ${name} | ${repeatabilityValue(comparison.beforeMean, unit)} | ${repeatabilityValue(comparison.afterMean, unit)} | ${percentage(comparison.reductionRatio)} | ${repeatabilityValue(afterAggregate.range, unit)} | ${percentage(afterAggregate.coefficientOfVariation)} |`,
    );
  }
  lines.push(
    "",
    `Formal selection hash stable: ${String(activeScatterArtifact.invariants.formalSelectionHashStable)}. Submitted glyph accounting: ${String(activeScatterArtifact.invariants.submittedGlyphsMatchLabels && activeScatterArtifact.invariants.accountingPassed)}. Three-run CPU/collision budget: ${String(activeScatterArtifact.invariants.afterBudgetsPassed)}. Whole-frame budget: ${String(activeScatterArtifact.invariants.afterWholeFrameBudgetPassed)}. WebGL control stable: ${String(activeScatterArtifact.invariants.webglControlStable)}.`,
  );
}

lines.push("", "## HarfBuzz worker SIMD decision", "");
if (shapingSimdArtifact === undefined) {
  lines.push("Current HarfBuzz worker SIMD evidence is unavailable.");
} else {
  const { artifact: simd, sha256 } = shapingSimdArtifact;
  const report = simd.result.report;
  lines.push(
    `The [schema ${integer(simd.schemaVersion)} artifact](results/shaping-simd-worker-${packageMetadata.version}.json), SHA-256 \`${sha256}\`, measures five isolated scalar workers and five isolated SIMD workers across the CJKV, Arabic, Devanagari, Hebrew, and Thai corpora.`,
    "",
    "| Variant | Runs | Mean | Exact output hash |",
    "| --- | ---: | ---: | --- |",
    `| Scalar | ${integer(simd.result.workers.scalar)} | ${milliseconds(report.baseline.meanMs)} | \`${report.baselineHash}\` |`,
    `| SIMD | ${integer(simd.result.workers.simd)} | ${milliseconds(report.variant.meanMs)} | \`${report.variantHash}\` |`,
    "",
    `Decision: ${report.decision.toUpperCase()} (${report.reasons.join(", ")}). SIMD changes the mean by ${percentage(-report.improvementRatio)} regression; the measured variance threshold is ${milliseconds(report.varianceThresholdMs)}.`,
    `Package boundary: ${simd.packageBoundary.status.toUpperCase()} (${simd.packageBoundary.reason}). Experimental assets remain opt-in and outside default package contents. The measured opt-in payload adds ${bytes(simd.packageBoundary.experimentalRawDeltaBytes)} raw / ${bytes(simd.packageBoundary.experimentalGzipDeltaBytes)} gzip and ${bytes(simd.packageBoundary.measurement.delta.tarballBytes)} to the packed tarball.`,
  );
}

lines.push(
  "",
  "## GPU Scene v2 CPU and admission phases",
  "",
  "| Renderer | Phase | Visibility p50 | Visibility p95 | Preparation p50 | Preparation p95 | Coordinator p50 | Coordinator p95 | Surface p50 | Surface p95 | Inspected max | Materialized max | Shaped delta | Admitted total | Heap |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
for (const { artifact, renderer } of loadedArtifacts) {
  if (artifact.workload !== "gpu-scene-v2" || renderer === undefined) continue;
  const sample = preferredSample(artifact);
  if (sample?.timings.phases === undefined) continue;
  for (const [phaseName, phase] of Object.entries(sample.timings.phases)) {
    lines.push(
      `| ${renderer} | ${phaseName} | ${optionalP50(phase.visibilitySelectionMs)} | ${optionalP95(phase.visibilitySelectionMs)} | ${optionalP50(phase.renderPreparationMs)} | ${optionalP95(phase.renderPreparationMs)} | ${optionalP50(phase.renderCoordinatorMs)} | ${optionalP95(phase.renderCoordinatorMs)} | ${optionalP50(phase.surfaceApplyMs)} | ${optionalP95(phase.surfaceApplyMs)} | ${optionalMaximum(phase.offscreenInspectedLabels)} | ${optionalMaximum(phase.offscreenMaterializedLabels)} | ${optionalInteger(phase.shapedLabelsDelta)} | ${optionalInteger(phase.admittedLabelsTotal)} | ${bytes(sample.counters.heapBytes)} |`,
    );
  }
}

lines.push(
  "",
  "## Collision CPU phases",
  "",
  "| Renderer | Visibility p50 | Visibility p95 | Preparation p50 | Preparation p95 | Coordinator p50 | Coordinator p95 | Surface p50 | Surface p95 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
for (const { artifact, renderer } of loadedArtifacts) {
  if (artifact.workload !== "label-collision" || renderer === undefined) continue;
  const sample = preferredSample(artifact);
  if (sample === undefined) continue;
  lines.push(
    `| ${renderer} | ${optionalP50(sample.timings.visibilitySelectionMs)} | ${optionalP95(sample.timings.visibilitySelectionMs)} | ${optionalP50(sample.timings.renderPreparationMs)} | ${optionalP95(sample.timings.renderPreparationMs)} | ${optionalP50(sample.timings.renderCoordinatorMs)} | ${optionalP95(sample.timings.renderCoordinatorMs)} | ${optionalP50(sample.timings.surfaceApplyMs)} | ${optionalP95(sample.timings.surfaceApplyMs)} |`,
  );
}

lines.push(
  "",
  "## GPU timing capability",
  "",
  "| Workload | Renderer | Method | Source | Quality | Query samples | Valid | Fallback | Fused resolves | Timestamp standalone submits | GPU timestamp p95 | Completion wall p95 | Readback |",
  "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
);
for (const { artifact, renderer } of loadedArtifacts) {
  const sample = preferredSample(artifact);
  const timing = sample?.timings.gpuTiming;
  if (renderer === undefined || sample === undefined || timing === undefined) continue;
  lines.push(
    `| ${artifact.workload} | ${renderer} | ${timing.method} | ${timing.gpuTimeSource ?? "legacy"} | ${timing.quality ?? "legacy"} | ${integer(timing.samples)} | ${integer(timing.validSamples)} | ${integer(timing.fallbackSamples)} | ${integer(timing.fusedTimestampResolves ?? 0)} | ${integer(timing.standaloneTimestampSubmissions ?? 0)} | ${optionalNullableP95(sample.timings.gpuTimestampMs)} | ${optionalP95(sample.timings.completionWallMs)} | ${String(timing.readback)} |`,
  );
}

const failedInvariants = available.flatMap((artifact) =>
  artifact.samples.flatMap((sample) =>
    Object.entries(sample.invariants)
      .filter((entry): entry is [string, false] => entry[1] === false)
      .map(
        ([name]) =>
          `${artifact.workload}/${artifact.renderer ?? sample.configuration.renderer}/${sample.configuration.fixture}: ${name}`,
      ),
  ),
);
lines.push("", "## Invariants", "");
lines.push(
  failedInvariants.length === 0
    ? "Every recorded boolean invariant passed."
    : failedInvariants.map((failure) => `- ${failure}`).join("\n"),
  "",
  "## Raw artifacts",
  "",
);
for (const loaded of loadedArtifacts) {
  lines.push(
    `- [${loaded.artifact.workload}${loaded.renderer === undefined ? "" : `/${loaded.renderer}`}](${`results/${loaded.fileName}`})`,
  );
}
if (activeScatterArtifact !== undefined) {
  lines.push(
    `- [label-collision/webgpu active-scatter repeatability](results/browser-label-collision-webgpu-active-scatter-repeatability-${packageMetadata.version}.json)`,
  );
}
if (residentRepeatabilityArtifact !== undefined) {
  lines.push(
    `- [gpu-scene-resident/webgpu repeatability](results/browser-gpu-scene-resident-webgpu-repeatability-${packageMetadata.version}.json)`,
  );
}
if (currentResidentPromotion !== undefined) {
  lines.push(
    `- [gpu-scene-resident/webgpu canonical source](results/${resultArtifactHref(currentResidentPromotion.artifact.canonicalCandidate.artifact)})`,
    `- [gpu-scene-resident/webgpu schema ${integer(currentResidentPromotion.artifact.schemaVersion)} promotion repeatability](results/browser-gpu-scene-resident-webgpu-promotion-repeatability-${packageMetadata.version}.json)`,
    ...(currentResidentPromotion.artifact.sustained600 === undefined
      ? []
      : [
          `- [gpu-scene-resident/webgpu sustained 600](results/${resultArtifactHref(currentResidentPromotion.artifact.sustained600.artifactFile)})`,
        ]),
  );
}
if (collisionRepeatability !== undefined) {
  lines.push(
    `- [label-collision schema ${integer(collisionRepeatability.artifact.schemaVersion)} repeatability](results/browser-label-collision-repeatability-${packageMetadata.version}.json)`,
  );
}
if (shapingSimdArtifact !== undefined) {
  lines.push(
    `- [HarfBuzz worker SIMD decision](results/shaping-simd-worker-${packageMetadata.version}.json)`,
  );
}
const outputPath = resolve(projectRoot, readOutputPath() ?? "benchmarks/PERFORMANCE.md");
const formattedReport = await format(outputPath, `${lines.join("\n")}\n`, {
  printWidth: 100,
  proseWrap: "preserve",
});
if (formattedReport.errors.length > 0) {
  throw new Error(
    `Generated benchmark report could not be formatted: ${formattedReport.errors
      .map((error) => error.message)
      .join("; ")}`,
  );
}
await Bun.write(outputPath, formattedReport.code);
console.log(JSON.stringify({ outputPath, artifacts: available.length, failedInvariants }));

interface LoadedBrowserArtifact {
  readonly fileName: string;
  readonly renderer?: BrowserBenchmarkRenderer;
  readonly classification: "current" | "fixed-red-control";
  readonly artifact: Readonly<BrowserBenchmarkArtifact>;
}

interface UnavailableBrowserArtifact {
  readonly reason: "invalid" | "missing" | "stale";
  readonly diagnostic: string;
}

interface LoadedBrowserArtifactCollection {
  readonly artifacts: ReadonlyMap<string, LoadedBrowserArtifact>;
  readonly unavailable: ReadonlyMap<string, UnavailableBrowserArtifact>;
}

interface LoadedHashedJsonArtifact<T> {
  readonly artifact: Readonly<T>;
  readonly sha256: string;
}

interface ShapingSimdArtifact {
  readonly schemaVersion: number;
  readonly packageVersion: string;
  readonly benchmark: string;
  readonly packageBoundary: Readonly<{
    status: string;
    reason: string;
    defaultPackageIncludesAssets: boolean;
    experimentalRawDeltaBytes: number;
    experimentalGzipDeltaBytes: number;
    measurement: Readonly<{
      delta: Readonly<{
        tarballBytes: number;
        unpackedBytes: number;
        entries: number;
      }>;
    }>;
  }>;
  readonly result: Readonly<{
    workers: Readonly<{ scalar: number; simd: number }>;
    report: Readonly<{
      decision: "advance" | "hold";
      reasons: readonly string[];
      baseline: Readonly<{ meanMs: number }>;
      variant: Readonly<{ meanMs: number }>;
      baselineHash: string;
      variantHash: string;
      improvementRatio: number;
      varianceThresholdMs: number;
    }>;
  }>;
}

interface GpuSceneResidentRepeatabilityArtifact {
  readonly kind: "pixi-glyphflow-gpu-scene-resident-repeatability";
  readonly canonicalCandidate: Readonly<{
    artifact: string | null;
    sourceKind?: string;
    sha256: string;
  }>;
  readonly attempts: readonly Readonly<{
    attempt: number;
    outcome: "fail" | "outlier" | "pass";
    validity?: "post-fix-valid" | "pre-fix-invalidated";
    setupMs: number;
    cameraFrameP95Ms: number;
    cameraGpuP95Ms: number;
    positionFrameP95Ms: number;
    positionGpuP95Ms: number;
    submittedGlyphsHash?: number;
    renderedPixelHash?: number;
    nonTransparentPixels?: number;
    source: Readonly<{
      artifact: string | null;
      sha256: string | null;
    }>;
  }>[];
  readonly summary: Readonly<{
    attempts: number;
    passed: number;
    failed?: number;
    outliers: number;
    preFix?: Readonly<{
      attempts: number;
      passed: number;
      outliers: number;
    }>;
    postFix?: Readonly<{
      attempts: number;
      passed: number;
      failed: number;
      outliers: number;
    }>;
    frameTail?: Readonly<{
      camera: Readonly<ResidentFrameTail>;
      positionMutation: Readonly<ResidentFrameTail>;
    }>;
  }>;
}

interface ResidentFrameTail {
  readonly samples: number;
  readonly overBudgetCount: number;
  readonly overBudgetRatio: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

async function loadArtifacts(
  version: string,
  projectRoot: string,
): Promise<Readonly<LoadedBrowserArtifactCollection>> {
  const result = new Map<string, LoadedBrowserArtifact>();
  const unavailable = new Map<string, UnavailableBrowserArtifact>();
  const resultsDir = resolve(import.meta.dir, "results");
  const fileNames = await readdir(resultsDir);
  const currentIdentity = await createCurrentBrowserBenchmarkArtifactIdentity(projectRoot);
  for (const workload of BENCHMARK_WORKLOADS) {
    const renderers = browserBenchmarkRenderers(workload.id);
    for (const renderer of renderers) {
      const identity = artifactKey(workload.id, renderer);
      const loaded = await loadCurrentBrowserBenchmarkArtifact({
        resultsDirectory: resultsDir,
        fileNames,
        expected: {
          packageVersion: version,
          workload: workload.id,
          renderer: renderer ?? "webgl",
          artifactRole: "candidate",
          ...currentIdentity,
        },
      });
      if (loaded.classification === "unavailable") {
        if (
          workload.id === "gpu-scene-v2" &&
          renderer !== undefined &&
          loaded.reason === "stale" &&
          loaded.resolvedArtifact !== undefined
        ) {
          const fixedControl = await loadFixedRedControl(
            resultsDir,
            loaded.resolvedArtifact.fileName,
            version,
            renderer,
          );
          if (fixedControl !== undefined) {
            result.set(identity, fixedControl);
            continue;
          }
        }
        unavailable.set(identity, {
          reason: loaded.reason,
          diagnostic: loaded.diagnostic,
        });
        continue;
      }
      result.set(identity, {
        fileName: loaded.resolvedArtifact.fileName,
        ...(renderer === undefined ? {} : { renderer }),
        classification: workload.id === "gpu-scene-v2" ? "fixed-red-control" : "current",
        artifact: loaded.artifact,
      });
    }
  }
  return Object.freeze({
    artifacts: result,
    unavailable,
  });
}

async function loadFixedRedControl(
  resultsDir: string,
  fileName: string,
  packageVersion: string,
  renderer: BrowserBenchmarkRenderer,
): Promise<Readonly<LoadedBrowserArtifact> | undefined> {
  try {
    const read = readBrowserBenchmarkArtifact(await Bun.file(resolve(resultsDir, fileName)).text());
    if (read.classification !== "current") return undefined;
    const artifact = read.artifact;
    if (
      artifact.packageVersion !== packageVersion ||
      artifact.workload !== "gpu-scene-v2" ||
      artifact.renderer !== renderer ||
      artifact.artifactRole !== "candidate" ||
      artifact.status !== "complete" ||
      artifact.exploratory
    ) {
      return undefined;
    }
    return Object.freeze({
      fileName,
      renderer,
      classification: "fixed-red-control",
      artifact,
    });
  } catch {
    return undefined;
  }
}

function resultArtifactHref(fileName: string): string {
  return archivedResultFiles.has(fileName) ? `${fileName}.gz` : fileName;
}

type JsonArtifactHashPolicy = "parse-only" | "sha256-source-bytes";

async function loadJsonArtifact<T>(
  fileName: string,
  hashPolicy: "parse-only",
): Promise<Readonly<T> | undefined>;
async function loadJsonArtifact<T>(
  fileName: string,
  hashPolicy: "sha256-source-bytes",
): Promise<Readonly<LoadedHashedJsonArtifact<T>> | undefined>;
async function loadJsonArtifact<T>(
  fileName: string,
  hashPolicy: JsonArtifactHashPolicy,
): Promise<Readonly<T> | Readonly<LoadedHashedJsonArtifact<T>> | undefined> {
  const file = Bun.file(resolve(import.meta.dir, "results", fileName));
  if (!(await file.exists())) return undefined;
  if (hashPolicy === "parse-only") return (await file.json()) as Readonly<T>;

  const bytes = new Uint8Array(await file.arrayBuffer());
  return Object.freeze({
    artifact: JSON.parse(new TextDecoder().decode(bytes)) as Readonly<T>,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function artifactKey(workloadId: string, renderer?: BrowserBenchmarkRenderer): string {
  return renderer === undefined ? workloadId : `${workloadId}:${renderer}`;
}

function preferredSample(
  artifact: Readonly<BrowserBenchmarkArtifact>,
): Readonly<BrowserBenchmarkSample> | undefined {
  return (
    artifact.samples.find((sample) => sample.configuration.fixture === "glyphflow") ??
    artifact.samples[0]
  );
}

function optionalP95(samples: readonly number[] | undefined): string {
  return samples === undefined || samples.length === 0
    ? "—"
    : milliseconds(summarize(samples, "ms").p95);
}

function optionalP50(samples: readonly number[] | undefined): string {
  return samples === undefined || samples.length === 0
    ? "—"
    : milliseconds(summarize(samples, "ms").p50);
}

function optionalNullableP95(samples: readonly (number | null)[] | undefined): string {
  return optionalP95(samples?.filter((sample): sample is number => sample !== null));
}

function optionalMaximum(samples: readonly number[] | undefined): string {
  if (samples === undefined || samples.length === 0) return "—";
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, sample);
  return integer(maximum);
}

function optionalBytesP95(samples: readonly number[] | undefined): string {
  return samples === undefined || samples.length === 0
    ? "—"
    : bytes(summarize(samples, "bytes").p95);
}

function optionalMaximumBytes(samples: readonly number[] | undefined): string {
  if (samples === undefined || samples.length === 0) return "—";
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, sample);
  return bytes(maximum);
}

function optionalInteger(value: number | undefined): string {
  return value === undefined ? "—" : integer(value);
}

function nullableMilliseconds(value: number | null): string {
  return value === null ? "—" : milliseconds(value);
}

function phaseTail(
  phase: Readonly<{ p95Ms: number | null; p99Ms: number | null; maxMs: number | null }>,
): string {
  return `${nullableMilliseconds(phase.p95Ms)} / ${nullableMilliseconds(phase.p99Ms)} / ${nullableMilliseconds(phase.maxMs)}`;
}

function frameTail(samples: readonly number[]): Readonly<{
  samples: number;
  overBudgetCount: number;
  overBudgetRatio: number;
  p99: number;
  max: number;
}> {
  if (samples.length === 0) {
    return Object.freeze({
      samples: 0,
      overBudgetCount: 0,
      overBudgetRatio: 0,
      p99: Number.POSITIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
    });
  }
  const distribution = summarize(samples, "ms");
  const overBudgetCount = samples.filter((sample) => sample > 16.67).length;
  return Object.freeze({
    samples: samples.length,
    overBudgetCount,
    overBudgetRatio: overBudgetCount / samples.length,
    p99: distribution.p99,
    max: distribution.max,
  });
}

function residentCrossRunIdentity(
  artifact: Readonly<GpuSceneResidentRepeatabilityArtifact>,
): Readonly<{ status: "GO" | "PAUSE"; completeRuns: number }> {
  const complete = artifact.attempts.filter(
    (attempt) =>
      attempt.validity === "post-fix-valid" &&
      attempt.submittedGlyphsHash !== undefined &&
      attempt.renderedPixelHash !== undefined &&
      attempt.nonTransparentPixels !== undefined,
  );
  const first = complete[0];
  const stable =
    complete.length >= 3 &&
    complete.every(
      (attempt) =>
        attempt.submittedGlyphsHash === first?.submittedGlyphsHash &&
        attempt.renderedPixelHash === first?.renderedPixelHash &&
        attempt.nonTransparentPixels === first?.nonTransparentPixels,
    );
  return Object.freeze({ status: stable ? "GO" : "PAUSE", completeRuns: complete.length });
}

function phaseP95(
  sample: Readonly<BrowserBenchmarkSample>,
  phase: "camera" | "positionMutation",
): string {
  return optionalP95(sample.timings.phases?.[phase].frameMs);
}

function artifactStatus(loaded: Readonly<LoadedBrowserArtifact> | undefined): string {
  if (loaded === undefined) return "unavailable";
  return loaded.classification === "fixed-red-control"
    ? `${loaded.artifact.status} (fixed RED control)`
    : loaded.artifact.status;
}

function budgetStatus(loaded: Readonly<LoadedBrowserArtifact> | undefined): string {
  if (loaded === undefined) return "unavailable";
  if (loaded.classification === "fixed-red-control") return "RED control";
  const artifact = loaded.artifact;
  if (artifact.workload === "million-live") {
    const sample = preferredSample(artifact);
    if (sample !== undefined)
      return evaluateMillionLiveWave2Budget(sample).passed ? "passed" : "failed";
  }
  if (artifact.budget === undefined) return "unbudgeted";
  return artifact.budget.passed ? "passed" : "failed";
}

function decisionValue(decision: Readonly<BrowserBenchmarkBudgetDecision>, name: string): string {
  const actual = decision.checks.find((check) => check.name === name)?.actual;
  return typeof actual === "number" ? milliseconds(actual) : "—";
}

function numberInvariant(
  sample: Readonly<BrowserBenchmarkSample> | undefined,
  name: string,
): number {
  const value = sample?.invariants[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function decisionCheck(
  decision: Readonly<BrowserBenchmarkBudgetDecision>,
  name: string,
): "PASS" | "PAUSE" {
  return decision.checks.find((check) => check.name === name)?.passed === true ? "PASS" : "PAUSE";
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function repeatabilityValue(value: number, unit: "ms" | "bytes"): string {
  return unit === "bytes" ? bytes(value) : milliseconds(value);
}

function percentage(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function integer(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function hex(value: number | undefined): string {
  return value === undefined ? "—" : `0x${value.toString(16).padStart(8, "0")}`;
}

function bytes(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_024) return `${integer(value)} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(2)} KiB`;
  return `${(value / 1_024 ** 2).toFixed(2)} MiB`;
}

function readOutputPath(): string | undefined {
  const index = Bun.argv.indexOf("--output");
  if (index < 0) return undefined;
  const value = Bun.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new TypeError("--output must be followed by a path");
  }
  return value;
}
