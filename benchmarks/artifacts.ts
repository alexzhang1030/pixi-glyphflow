import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { BROWSER_BENCHMARK_HARNESS_PATHS } from "./harness-launcher";
import type {
  BrowserBenchmarkArtifact,
  BrowserBenchmarkArtifactPayload,
  BrowserBenchmarkArtifactRole,
  BrowserBenchmarkBuildManifestEntry,
  BrowserBenchmarkHarnessManifestEntry,
  BrowserBenchmarkRenderer,
  BrowserBenchmarkWorkload,
  HistoricalBrowserBenchmarkArtifactV6,
} from "./schema";
import { BENCHMARK_SCHEMA_VERSION, HISTORICAL_BENCHMARK_SCHEMA_VERSION } from "./schema";

const EXPLORATORY_SUFFIX = "-exploratory";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RENDERER_IDENTITY = /^(webgl|webgpu)-(baseline|candidate)-(.+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export { BROWSER_BENCHMARK_HARNESS_PATHS } from "./harness-launcher";

class StaleCurrentBrowserBenchmarkArtifactError extends TypeError {}

export interface BrowserArtifactName {
  readonly version: string;
  readonly exploratory: boolean;
  readonly renderer?: BrowserBenchmarkRenderer;
  readonly artifactRole?: BrowserBenchmarkArtifactRole;
}

export interface ResolvedBrowserArtifact {
  readonly fileName: string;
  readonly version: string;
  readonly current: boolean;
  readonly renderer?: BrowserBenchmarkRenderer;
  readonly artifactRole?: BrowserBenchmarkArtifactRole;
}

export type BrowserBenchmarkArtifactFreshness =
  | Readonly<{ classification: "missing" }>
  | Readonly<{ classification: "stale"; artifact: Readonly<ResolvedBrowserArtifact> }>
  | Readonly<{ classification: "current"; artifact: Readonly<ResolvedBrowserArtifact> }>;

export interface CurrentBrowserBenchmarkArtifactExpectation {
  readonly packageVersion: string;
  readonly workload: BrowserBenchmarkWorkload;
  readonly renderer: BrowserBenchmarkRenderer;
  readonly artifactRole: BrowserBenchmarkArtifactRole;
  readonly buildFingerprintSha256: string;
  readonly harnessFingerprintSha256: string;
}

export interface CurrentBrowserBenchmarkArtifactIdentity {
  readonly buildFingerprintSha256: string;
  readonly harnessFingerprintSha256: string;
}

export type FixedHistoricalBrowserBenchmarkArtifact = Omit<
  BrowserBenchmarkArtifact,
  "artifactRole" | "provenance" | "renderer" | "schemaVersion"
> & {
  readonly schemaVersion: 3 | typeof HISTORICAL_BENCHMARK_SCHEMA_VERSION;
  readonly renderer?: BrowserBenchmarkRenderer;
  readonly artifactRole?: BrowserBenchmarkArtifactRole;
  readonly provenance?: never;
};

export interface FixedHistoricalBrowserBenchmarkArtifactExpectation {
  readonly packageVersion: string;
  readonly currentPackageVersion: string;
  readonly workload: BrowserBenchmarkWorkload;
  readonly renderer?: BrowserBenchmarkRenderer;
  readonly artifactRole?: BrowserBenchmarkArtifactRole;
}

export type CurrentBrowserBenchmarkArtifactLoadResult =
  | Readonly<{
      classification: "current";
      resolvedArtifact: Readonly<ResolvedBrowserArtifact>;
      artifact: Readonly<BrowserBenchmarkArtifact>;
    }>
  | Readonly<{
      classification: "unavailable";
      reason: "invalid" | "missing" | "stale";
      diagnostic: string;
      resolvedArtifact?: Readonly<ResolvedBrowserArtifact>;
    }>;

export type BrowserBenchmarkArtifactReadResult =
  | Readonly<{
      classification: "current";
      schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
      artifact: Readonly<BrowserBenchmarkArtifact>;
    }>
  | Readonly<{
      classification: "historical";
      schemaVersion: typeof HISTORICAL_BENCHMARK_SCHEMA_VERSION;
      reason: "schema-6-without-build-provenance";
      artifact: Readonly<HistoricalBrowserBenchmarkArtifactV6>;
    }>;

export function createBrowserBenchmarkRunId(): string {
  return randomUUID();
}

export async function createBrowserBenchmarkHarnessManifest(
  projectRoot: string,
): Promise<readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[]> {
  const entries: BrowserBenchmarkHarnessManifestEntry[] = [];
  for (const path of BROWSER_BENCHMARK_HARNESS_PATHS) {
    const file = resolve(projectRoot, path);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError(`Browser benchmark harness path must be a regular file: ${path}`);
    }
    const bytes = await readFile(file);
    entries.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }

  return normalizeCurrentHarnessManifest(entries);
}

export function browserBenchmarkHarnessFingerprintSha256(
  manifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[],
): string {
  return sha256(canonicalJsonBytes(normalizeHarnessManifest(manifest)));
}

export async function verifyBrowserBenchmarkHarnessManifest(
  projectRoot: string,
  expectedManifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[],
): Promise<boolean> {
  try {
    const expected = normalizeHarnessManifest(expectedManifest);
    const current = await createBrowserBenchmarkHarnessManifest(projectRoot);
    return canonicalJson(current) === canonicalJson(expected);
  } catch {
    return false;
  }
}

export async function createBrowserBenchmarkBuildManifest(
  projectRoot: string,
): Promise<readonly Readonly<BrowserBenchmarkBuildManifestEntry>[]> {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-build-manifest-"));
  try {
    return await createBrowserBenchmarkFrozenBuild(projectRoot, outputDirectory);
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}

export async function createCurrentBrowserBenchmarkArtifactIdentity(
  projectRoot: string,
): Promise<Readonly<CurrentBrowserBenchmarkArtifactIdentity>> {
  const [buildManifest, harnessManifest] = await Promise.all([
    createBrowserBenchmarkBuildManifest(projectRoot),
    createBrowserBenchmarkHarnessManifest(projectRoot),
  ]);
  return Object.freeze({
    buildFingerprintSha256: browserBenchmarkBuildFingerprintSha256(buildManifest),
    harnessFingerprintSha256: browserBenchmarkHarnessFingerprintSha256(harnessManifest),
  });
}

export async function createBrowserBenchmarkFrozenBuild(
  projectRoot: string,
  outputDirectory: string,
  options: Readonly<{ entry?: string }> = {},
): Promise<readonly Readonly<BrowserBenchmarkBuildManifestEntry>[]> {
  await assertSafeFrozenBuildDirectory(projectRoot, outputDirectory);
  const { build } = await import("vite");
  await build({
    root: projectRoot,
    configFile: false,
    logLevel: "error",
    resolve: {
      alias: [
        {
          find: resolve(projectRoot, "src/shaping/worker/text-worker.js"),
          replacement: resolve(projectRoot, "src/worker/text-worker.ts"),
        },
        {
          find: resolve(projectRoot, "src/hb-gpu/worker.js"),
          replacement: resolve(projectRoot, "src/hb-gpu/worker.ts"),
        },
      ],
    },
    worker: { format: "es" },
    build: {
      assetsInlineLimit: 0,
      emptyOutDir: false,
      modulePreload: { polyfill: false },
      outDir: outputDirectory,
      sourcemap: false,
      write: true,
      rollupOptions: {
        input: resolve(projectRoot, options.entry ?? "playground/benchmark.html"),
      },
    },
  });
  const manifest = await readBrowserBenchmarkBuildManifest(outputDirectory);
  for (const entry of manifest) {
    const bytes = await readFile(resolve(outputDirectory, entry.path));
    if (
      containsUtf8(bytes, projectRoot) ||
      containsUtf8(bytes, projectRoot.replaceAll("\\", "/"))
    ) {
      throw new TypeError(
        `Browser benchmark build output contains its absolute root: ${entry.path}`,
      );
    }
  }

  return manifest;
}

export async function readBrowserBenchmarkBuildManifest(
  outputDirectory: string,
): Promise<readonly Readonly<BrowserBenchmarkBuildManifestEntry>[]> {
  const entries: BrowserBenchmarkBuildManifestEntry[] = [];
  const files = await collectBuildFiles(outputDirectory);
  for (const file of files) {
    const bytes = await readFile(file);
    entries.push({
      path: relative(outputDirectory, file).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }

  return normalizeBuildManifest(entries);
}

export function browserBenchmarkBuildFingerprintSha256(
  manifest: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[],
): string {
  return sha256(canonicalJsonBytes(normalizeBuildManifest(manifest)));
}

export function createBrowserBenchmarkArtifact(
  payload: Readonly<BrowserBenchmarkArtifactPayload>,
  options: Readonly<{
    runId: string;
    buildManifest: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[];
    harnessManifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
  }>,
): Readonly<BrowserBenchmarkArtifact> {
  if (payload.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(
      `Browser benchmark artifact payload schema must be ${String(BENCHMARK_SCHEMA_VERSION)}`,
    );
  }
  if (!UUID_V4.test(options.runId)) {
    throw new TypeError("Browser benchmark runId must be a lowercase UUID v4");
  }
  const buildManifest = normalizeBuildManifest(options.buildManifest);
  const harnessManifest = normalizeCurrentHarnessManifest(options.harnessManifest);
  const unsigned = {
    ...payload,
    provenance: Object.freeze({
      runId: options.runId,
      buildFingerprintSha256: browserBenchmarkBuildFingerprintSha256(buildManifest),
      buildManifest,
      harnessFingerprintSha256: browserBenchmarkHarnessFingerprintSha256(harnessManifest),
      harnessManifest,
      evidenceSha256: "",
    }),
  } satisfies BrowserBenchmarkArtifact;
  const artifact = {
    ...unsigned,
    provenance: Object.freeze({
      ...unsigned.provenance,
      evidenceSha256: browserBenchmarkEvidenceSha256(unsigned),
    }),
  } satisfies BrowserBenchmarkArtifact;

  return Object.freeze(artifact);
}

export function browserBenchmarkEvidenceSha256(artifact: unknown): string {
  const record = browserArtifactRecord(artifact);
  const provenance = browserProvenanceRecord(record.provenance);
  const { evidenceSha256: _evidenceSha256, ...unsignedProvenance } = provenance;

  return sha256(
    canonicalJsonBytes({
      ...record,
      provenance: unsignedProvenance,
    }),
  );
}

export function verifyBrowserBenchmarkArtifactEvidence(
  artifact: unknown,
): artifact is Readonly<BrowserBenchmarkArtifact> {
  try {
    const record = browserArtifactRecord(artifact);
    if (record.schemaVersion !== BENCHMARK_SCHEMA_VERSION) return false;
    const provenance = browserProvenanceRecord(record.provenance);
    if (typeof provenance.runId !== "string" || !UUID_V4.test(provenance.runId)) return false;
    if (
      typeof provenance.buildFingerprintSha256 !== "string" ||
      !SHA256.test(provenance.buildFingerprintSha256) ||
      !Array.isArray(provenance.buildManifest)
    ) {
      return false;
    }
    const buildManifest = normalizeBuildManifest(
      provenance.buildManifest as BrowserBenchmarkBuildManifestEntry[],
    );
    if (canonicalJson(provenance.buildManifest) !== canonicalJson(buildManifest)) return false;
    if (
      provenance.buildFingerprintSha256 !== browserBenchmarkBuildFingerprintSha256(buildManifest)
    ) {
      return false;
    }
    if (
      typeof provenance.harnessFingerprintSha256 !== "string" ||
      !SHA256.test(provenance.harnessFingerprintSha256) ||
      !Array.isArray(provenance.harnessManifest)
    ) {
      return false;
    }
    const harnessManifest = normalizeHarnessManifest(
      provenance.harnessManifest as BrowserBenchmarkHarnessManifestEntry[],
    );
    if (canonicalJson(provenance.harnessManifest) !== canonicalJson(harnessManifest)) return false;
    if (
      provenance.harnessFingerprintSha256 !==
      browserBenchmarkHarnessFingerprintSha256(harnessManifest)
    ) {
      return false;
    }
    return (
      typeof provenance.evidenceSha256 === "string" &&
      SHA256.test(provenance.evidenceSha256) &&
      provenance.evidenceSha256 === browserBenchmarkEvidenceSha256(record)
    );
  } catch {
    return false;
  }
}

export function serializeBrowserBenchmarkArtifact(
  artifact: Readonly<BrowserBenchmarkArtifact>,
): string {
  if (!verifyBrowserBenchmarkArtifactEvidence(artifact)) {
    throw new TypeError("Browser benchmark artifact evidence SHA-256 does not match its payload");
  }

  return `${JSON.stringify(artifact, undefined, 2)}\n`;
}

export function readBrowserBenchmarkArtifact(
  serialized: string,
): BrowserBenchmarkArtifactReadResult {
  const parsed: unknown = JSON.parse(serialized);
  const record = browserArtifactRecord(parsed);
  if (record.schemaVersion === HISTORICAL_BENCHMARK_SCHEMA_VERSION) {
    return Object.freeze({
      classification: "historical",
      schemaVersion: HISTORICAL_BENCHMARK_SCHEMA_VERSION,
      reason: "schema-6-without-build-provenance",
      artifact: parsed as HistoricalBrowserBenchmarkArtifactV6,
    });
  }
  if (record.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported browser benchmark schema: ${String(record.schemaVersion)}`);
  }
  if (!verifyBrowserBenchmarkArtifactEvidence(parsed)) {
    throw new TypeError("Browser benchmark artifact evidence SHA-256 does not match its payload");
  }

  return Object.freeze({
    classification: "current",
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    artifact: parsed,
  });
}

export function readCurrentBrowserBenchmarkArtifact(
  serialized: string,
  expected: Readonly<CurrentBrowserBenchmarkArtifactExpectation>,
): Readonly<BrowserBenchmarkArtifact> {
  const read = readBrowserBenchmarkArtifact(serialized);
  if (read.classification !== "current") {
    throw new TypeError(
      `Current browser artifact requires schema ${String(BENCHMARK_SCHEMA_VERSION)}`,
    );
  }
  const artifact = read.artifact;
  if (artifact.packageVersion !== expected.packageVersion) {
    throw new TypeError("Current browser artifact package version does not match the gate");
  }
  if (artifact.workload !== expected.workload) {
    throw new TypeError("Current browser artifact workload does not match the gate");
  }
  if (artifact.renderer !== expected.renderer) {
    throw new TypeError("Current browser artifact renderer does not match the gate");
  }
  if (artifact.artifactRole !== expected.artifactRole) {
    throw new TypeError("Current browser artifact role does not match the gate");
  }
  if (artifact.status !== "complete") {
    throw new TypeError("Current browser artifact status must be complete");
  }
  if (artifact.exploratory === true) {
    throw new TypeError("Current browser artifact gate requires formal workload defaults");
  }
  if (artifact.provenance.buildFingerprintSha256 !== expected.buildFingerprintSha256) {
    throw new StaleCurrentBrowserBenchmarkArtifactError(
      "Current browser artifact does not match the current browser build fingerprint",
    );
  }
  if (artifact.provenance.harnessFingerprintSha256 !== expected.harnessFingerprintSha256) {
    throw new StaleCurrentBrowserBenchmarkArtifactError(
      "Current browser artifact does not match the current benchmark harness fingerprint",
    );
  }

  return artifact;
}

export function readFixedHistoricalBrowserBenchmarkArtifact(
  serialized: string,
  expected: Readonly<FixedHistoricalBrowserBenchmarkArtifactExpectation>,
): Readonly<FixedHistoricalBrowserBenchmarkArtifact> {
  const parsed: unknown = JSON.parse(serialized);
  const record = browserArtifactRecord(parsed);
  if (compareSemver(expected.packageVersion, expected.currentPackageVersion) >= 0) {
    throw new TypeError("Fixed historical browser artifact version must precede current package");
  }
  if (record.schemaVersion !== 3 && record.schemaVersion !== HISTORICAL_BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(
      `Fixed historical browser artifact requires schema 3 or ${String(HISTORICAL_BENCHMARK_SCHEMA_VERSION)}`,
    );
  }
  if (record.packageVersion !== expected.packageVersion) {
    throw new TypeError(
      "Fixed historical browser artifact package version does not match its path",
    );
  }
  if (record.workload !== expected.workload) {
    throw new TypeError("Fixed historical browser artifact workload does not match its path");
  }
  if (expected.renderer !== undefined && record.renderer !== undefined) {
    if (record.renderer !== expected.renderer) {
      throw new TypeError("Fixed historical browser artifact renderer does not match its path");
    }
  }
  if (expected.artifactRole !== undefined && record.artifactRole !== undefined) {
    if (record.artifactRole !== expected.artifactRole) {
      throw new TypeError("Fixed historical browser artifact role does not match its path");
    }
  }
  if (record.status !== "complete") {
    throw new TypeError("Fixed historical browser artifact status must be complete");
  }
  if (record.exploratory === true) {
    throw new TypeError("Fixed historical browser artifact must use formal workload defaults");
  }
  if (!Array.isArray(record.samples)) {
    throw new TypeError("Fixed historical browser artifact samples must be an array");
  }

  return parsed as FixedHistoricalBrowserBenchmarkArtifact;
}

export async function loadCurrentBrowserBenchmarkArtifact(
  options: Readonly<{
    resultsDirectory: string;
    fileNames: readonly string[];
    expected: Readonly<CurrentBrowserBenchmarkArtifactExpectation>;
  }>,
): Promise<CurrentBrowserBenchmarkArtifactLoadResult> {
  const { expected } = options;
  const freshness = resolveBrowserArtifactFreshness(
    expected.workload,
    expected.packageVersion,
    options.fileNames,
    isRendererScopedBrowserWorkload(expected.workload)
      ? { renderer: expected.renderer, artifactRole: expected.artifactRole }
      : {},
  );
  if (freshness.classification === "missing") {
    return Object.freeze({
      classification: "unavailable",
      reason: "missing",
      diagnostic: `Current browser artifact is missing for ${expected.workload}/${expected.renderer} at package ${expected.packageVersion}`,
    });
  }
  if (freshness.classification === "stale") {
    return Object.freeze({
      classification: "unavailable",
      reason: "stale",
      diagnostic: `Current browser artifact is stale for ${expected.workload}/${expected.renderer}: expected package ${expected.packageVersion}, found ${freshness.artifact.version}`,
      resolvedArtifact: freshness.artifact,
    });
  }

  try {
    const serialized = await readFile(
      resolve(options.resultsDirectory, freshness.artifact.fileName),
      "utf8",
    );
    return Object.freeze({
      classification: "current",
      resolvedArtifact: freshness.artifact,
      artifact: readCurrentBrowserBenchmarkArtifact(serialized, expected),
    });
  } catch (error: unknown) {
    return Object.freeze({
      classification: "unavailable",
      reason: error instanceof StaleCurrentBrowserBenchmarkArtifactError ? "stale" : "invalid",
      diagnostic: `${freshness.artifact.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      resolvedArtifact: freshness.artifact,
    });
  }
}

export function browserBenchmarkArtifactFileName(options: {
  readonly workload: BrowserBenchmarkWorkload;
  readonly renderer: BrowserBenchmarkRenderer;
  readonly artifactRole: BrowserBenchmarkArtifactRole;
  readonly packageVersion: string;
  readonly exploratory: boolean;
}): string {
  const rendererScoped = isRendererScopedBrowserWorkload(options.workload);
  const identity = rendererScoped
    ? `${options.workload}-${options.renderer}-${options.artifactRole}`
    : options.workload;

  return `browser-${identity}-${options.packageVersion}${options.exploratory ? EXPLORATORY_SUFFIX : ""}.json`;
}

export function isRendererScopedBrowserWorkload(workloadId: string): boolean {
  return (
    workloadId === "gpu-scene-heterogeneous-64" ||
    workloadId === "gpu-scene-resident" ||
    workloadId === "gpu-scene-v2" ||
    workloadId === "label-collision"
  );
}

export function browserBenchmarkRenderers(
  workloadId: string,
): readonly (BrowserBenchmarkRenderer | undefined)[] {
  if (workloadId === "gpu-scene-heterogeneous-64" || workloadId === "gpu-scene-resident") {
    return ["webgpu"];
  }
  return isRendererScopedBrowserWorkload(workloadId) ? ["webgl", "webgpu"] : [undefined];
}

export function parseBrowserArtifactName(
  fileName: string,
  workloadId: string,
): BrowserArtifactName | undefined {
  const prefix = `browser-${workloadId}-`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".json")) return undefined;
  const rest = fileName.slice(prefix.length, -".json".length);
  const exploratory = rest.endsWith(EXPLORATORY_SUFFIX);
  const identity = exploratory ? rest.slice(0, -EXPLORATORY_SUFFIX.length) : rest;
  const rendererIdentity = RENDERER_IDENTITY.exec(identity);
  const renderer = rendererIdentity?.[1] as BrowserBenchmarkRenderer | undefined;
  const artifactRole = rendererIdentity?.[2] as BrowserBenchmarkArtifactRole | undefined;
  const version = rendererIdentity?.[3] ?? identity;
  if (SEMVER.exec(version) === null) return undefined;

  return {
    version,
    exploratory,
    ...(renderer === undefined ? {} : { renderer }),
    ...(artifactRole === undefined ? {} : { artifactRole }),
  };
}

export function compareSemver(left: string, right: string): number {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  if (leftParts[0] !== rightParts[0]) return leftParts[0] - rightParts[0];
  if (leftParts[1] !== rightParts[1]) return leftParts[1] - rightParts[1];

  return leftParts[2] - rightParts[2];
}

export function resolveBrowserArtifact(
  workloadId: string,
  packageVersion: string,
  fileNames: readonly string[],
  options: {
    requireCurrent?: boolean;
    renderer?: BrowserBenchmarkRenderer;
    artifactRole?: BrowserBenchmarkArtifactRole;
  } = {},
): ResolvedBrowserArtifact | undefined {
  let latest: ResolvedBrowserArtifact | undefined;
  for (const fileName of fileNames) {
    const parsed = parseBrowserArtifactName(fileName, workloadId);
    if (parsed === undefined || parsed.exploratory) continue;
    const identityRequested = options.renderer !== undefined || options.artifactRole !== undefined;
    if (!identityRequested && parsed.renderer !== undefined) continue;
    if (options.renderer !== undefined && parsed.renderer !== options.renderer) continue;
    if (options.artifactRole !== undefined && parsed.artifactRole !== options.artifactRole)
      continue;
    if (compareSemver(parsed.version, packageVersion) > 0) continue;
    const resolved: ResolvedBrowserArtifact = {
      fileName,
      version: parsed.version,
      current: parsed.version === packageVersion,
      ...(parsed.renderer === undefined ? {} : { renderer: parsed.renderer }),
      ...(parsed.artifactRole === undefined ? {} : { artifactRole: parsed.artifactRole }),
    };
    if (resolved.current) return resolved;
    if (latest === undefined || compareSemver(resolved.version, latest.version) > 0) {
      latest = resolved;
    }
  }

  return options.requireCurrent === true ? undefined : latest;
}

export function resolveBrowserArtifactFreshness(
  workloadId: string,
  packageVersion: string,
  fileNames: readonly string[],
  options: Readonly<{
    renderer?: BrowserBenchmarkRenderer;
    artifactRole?: BrowserBenchmarkArtifactRole;
  }> = {},
): BrowserBenchmarkArtifactFreshness {
  const artifact = resolveBrowserArtifact(workloadId, packageVersion, fileNames, options);
  if (artifact === undefined) return Object.freeze({ classification: "missing" });

  return Object.freeze({
    classification: artifact.current ? "current" : "stale",
    artifact,
  });
}

function semverParts(version: string): readonly [number, number, number] {
  const match = SEMVER.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new RangeError(`Invalid artifact version: ${version}`);
  }

  return [Number(major), Number(minor), Number(patch)];
}

function normalizeBuildManifest(
  manifest: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[],
): readonly Readonly<BrowserBenchmarkBuildManifestEntry>[] {
  if (manifest.length === 0) {
    throw new RangeError("Browser benchmark build manifest must contain at least one output");
  }
  const paths = new Set<string>();
  const normalized = manifest.map((entry) => {
    const path = entry.path.replaceAll("\\", "/");
    if (
      path.length === 0 ||
      isAbsolute(path) ||
      /^[a-z]:\//i.test(path) ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new TypeError(`Browser benchmark build path must be relative and normalized: ${path}`);
    }
    if (paths.has(path)) {
      throw new TypeError(`Browser benchmark build path is duplicated: ${path}`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new TypeError(`Browser benchmark build byte count is invalid: ${String(entry.bytes)}`);
    }
    if (!SHA256.test(entry.sha256)) {
      throw new TypeError(`Browser benchmark build SHA-256 is invalid: ${entry.sha256}`);
    }
    paths.add(path);

    return Object.freeze({ path, bytes: entry.bytes, sha256: entry.sha256 });
  });
  normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return Object.freeze(normalized);
}

function normalizeHarnessManifest(
  manifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[],
): readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] {
  return normalizeBuildManifest(manifest);
}

function normalizeCurrentHarnessManifest(
  manifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[],
): readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] {
  const normalized = normalizeHarnessManifest(manifest);
  if (
    normalized.length !== BROWSER_BENCHMARK_HARNESS_PATHS.length ||
    normalized.some((entry, index) => entry.path !== BROWSER_BENCHMARK_HARNESS_PATHS[index])
  ) {
    throw new TypeError("Browser benchmark harness manifest must cover the exact control closure");
  }

  return normalized;
}

async function assertSafeFrozenBuildDirectory(
  projectRoot: string,
  outputDirectory: string,
): Promise<void> {
  const projectPath = resolve(projectRoot);
  const outputPath = resolve(outputDirectory);
  const temporaryPath = resolve(tmpdir());
  const [resolvedProjectRoot, resolvedOutputDirectory, resolvedTemporaryDirectory, outputStat] =
    await Promise.all([
      realpath(projectPath),
      realpath(outputPath),
      realpath(temporaryPath),
      lstat(outputPath),
    ]);
  if (
    pathContains(projectPath, outputPath) ||
    pathContains(outputPath, projectPath) ||
    pathContains(resolvedProjectRoot, resolvedOutputDirectory) ||
    pathContains(resolvedOutputDirectory, resolvedProjectRoot)
  ) {
    throw new TypeError("Browser benchmark output directory must be outside the project root");
  }
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new TypeError("Browser benchmark output directory must be a direct temporary directory");
  }

  const relativeOutput = pathContains(temporaryPath, outputPath)
    ? relative(temporaryPath, outputPath)
    : pathContains(resolvedTemporaryDirectory, outputPath)
      ? relative(resolvedTemporaryDirectory, outputPath)
      : undefined;
  if (
    relativeOutput === undefined ||
    relativeOutput === "" ||
    resolve(resolvedTemporaryDirectory, relativeOutput) !== resolvedOutputDirectory
  ) {
    throw new TypeError("Browser benchmark output directory must be a direct temporary directory");
  }
  if ((await readdir(resolvedOutputDirectory)).length > 0) {
    throw new TypeError("Browser benchmark output directory must be empty");
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function browserArtifactRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Browser benchmark artifact must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.benchmark !== "browser-workloads") {
    throw new TypeError("Browser benchmark artifact kind is invalid");
  }

  return record;
}

function browserProvenanceRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Browser benchmark provenance must be a JSON object");
  }

  return value as Record<string, unknown>;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectBuildFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBuildFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new TypeError(`Browser benchmark build output must be a regular file: ${path}`);
    }
  }

  return files;
}

function containsUtf8(bytes: Uint8Array, text: string): boolean {
  if (text.length === 0) return false;
  const needle = new TextEncoder().encode(text);
  outer: for (let start = 0; start <= bytes.length - needle.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[start + index] !== needle[index]) continue outer;
    }
    return true;
  }

  return false;
}
