import { resolve } from "node:path";

import { summarize, type BrowserBenchmarkArtifact, type BrowserBenchmarkSample } from "./schema";
import { BENCHMARK_WORKLOADS } from "./workloads";

const projectRoot = resolve(import.meta.dir, "..");
const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
  readonly version: string;
};
const artifacts = await loadArtifacts(packageMetadata.version);
const available = artifacts.filter(
  (artifact): artifact is BrowserBenchmarkArtifact => artifact !== undefined,
);
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
    "- Renderer: WebGL 2 with explicit GPU completion before each measured frame",
    "",
  );
}

lines.push(
  "## Method",
  "",
  "Each workload starts in an isolated Chrome process. Setup, warmup, mutation, commit, culling, and frame samples are recorded separately. The full-visibility fixture submits one instanced draw containing eight million glyphs. Viewport workloads use pixi-viewport drag, deceleration, wheel, pinch, zoom, and camera rotation events over one million resident labels.",
  "",
  "## Workload results",
  "",
  "| Workload | Labels | Mutations | Setup | Frame p50 | Frame p95 | Mutation p95 | Commit p95 | Visible glyphs | Draws | Status |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
);

for (let index = 0; index < BENCHMARK_WORKLOADS.length; index += 1) {
  const definition = BENCHMARK_WORKLOADS[index];
  const artifact = artifacts[index];
  if (definition === undefined) continue;
  if (artifact === undefined) {
    lines.push(
      `| ${definition.id} | ${integer(definition.labelCount)} | ${integer(definition.mutationCount)} | — | — | — | — | — | — | — | missing |`,
    );
    continue;
  }
  const sample = preferredSample(artifact);
  if (sample === undefined) {
    lines.push(
      `| ${definition.id} | ${integer(definition.labelCount)} | ${integer(definition.mutationCount)} | — | — | — | — | — | — | — | ${artifact.status} |`,
    );
    continue;
  }
  const frame = summarize(sample.timings.frameMs, "ms");
  lines.push(
    `| ${definition.id} | ${integer(sample.configuration.labelCount)} | ${integer(sample.configuration.mutationCount)} | ${milliseconds(sample.timings.setupMs)} | ${milliseconds(frame.p50)} | ${milliseconds(frame.p95)} | ${optionalP95(sample.timings.mutationMs)} | ${optionalP95(sample.timings.commitMs)} | ${integer(sample.counters.visibleGlyphs)} | ${integer(sample.counters.drawCalls)} | ${artifact.status} |`,
  );
}

const staticArtifact = available.find((artifact) => artifact.workload === "static-hud");
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
  "| Workload | CPU store | Glyph instances | Transform palette | Atlas | Evictions |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const artifact of available) {
  const sample = preferredSample(artifact);
  if (sample === undefined) continue;
  lines.push(
    `| ${artifact.workload} | ${bytes(sample.counters.allocatedStoreBytes)} | ${bytes(sample.counters.instanceBytes)} | ${bytes(sample.counters.transformBytes)} | ${bytes(sample.counters.atlasBytes)} | ${integer(sample.counters.atlasEvictions ?? 0)} |`,
  );
}

const failedInvariants = available.flatMap((artifact) =>
  artifact.samples.flatMap((sample) =>
    Object.entries(sample.invariants)
      .filter((entry): entry is [string, false] => entry[1] === false)
      .map(([name]) => `${artifact.workload}/${sample.configuration.fixture}: ${name}`),
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
for (const workload of BENCHMARK_WORKLOADS) {
  const file = `results/browser-${workload.id}-${packageMetadata.version}.json`;
  lines.push(`- [${workload.id}](${file})`);
}
lines.push("");

const outputPath = resolve(import.meta.dir, "PERFORMANCE.md");
await Bun.write(outputPath, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ outputPath, artifacts: available.length, failedInvariants }));

async function loadArtifacts(
  version: string,
): Promise<readonly (BrowserBenchmarkArtifact | undefined)[]> {
  return Promise.all(
    BENCHMARK_WORKLOADS.map(async (workload) => {
      const file = Bun.file(
        resolve(import.meta.dir, `results/browser-${workload.id}-${version}.json`),
      );
      if (!(await file.exists())) return undefined;
      return (await file.json()) as BrowserBenchmarkArtifact;
    }),
  );
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

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function integer(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function bytes(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_024) return `${integer(value)} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(2)} KiB`;
  return `${(value / 1_024 ** 2).toFixed(2)} MiB`;
}
