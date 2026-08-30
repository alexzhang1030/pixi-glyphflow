import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";

const ARCHIVE_SCHEMA_VERSION = 1;
const DEFAULT_RESULTS_DIRECTORY = resolve(import.meta.dir, "../benchmarks/results");
const DEFAULT_MANIFEST_PATH = resolve(
  DEFAULT_RESULTS_DIRECTORY,
  "browser-artifact-archives-1.2.0.json",
);

export const BENCHMARK_ARTIFACT_ARCHIVE_FILES: readonly string[] = Object.freeze([
  "browser-gpu-scene-heterogeneous-64-webgpu-candidate-legacy-12b-1.2.0.json",
  "browser-gpu-scene-heterogeneous-64-webgpu-formal-1-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-candidate-legacy-16b-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-fastlane-fused-600-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-formal-1-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-formal-2-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-formal-3-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-formal-4-1.2.0.json",
  "browser-label-collision-webgl-formal-1-1.2.0.json",
  "browser-label-collision-webgl-formal-2-1.2.0.json",
  "browser-label-collision-webgpu-formal-1-1.2.0.json",
  "browser-label-collision-webgpu-formal-2-1.2.0.json",
] as const);

export const BENCHMARK_ARTIFACT_COMPACT_FILES: readonly string[] = Object.freeze([
  "browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0.json",
  "browser-gpu-scene-resident-webgpu-candidate-1.2.0.json",
  "browser-gpu-scene-v2-webgl-candidate-1.2.0.json",
  "browser-gpu-scene-v2-webgpu-candidate-1.2.0.json",
  "browser-label-collision-webgl-candidate-1.2.0.json",
  "browser-label-collision-webgpu-candidate-1.2.0.json",
  "browser-million-live-1.2.0.json",
] as const);

const COMPACT_REFERENCE_FILES = Object.freeze([
  "browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json",
  "browser-label-collision-repeatability-1.2.0.json",
] as const);

export interface BenchmarkArtifactArchiveEntry {
  readonly file: string;
  readonly archive: string;
  readonly bytes: number;
  readonly archiveBytes: number;
  readonly sha256: string;
}

export interface BenchmarkArtifactArchiveManifest {
  readonly schemaVersion: number;
  readonly artifacts: readonly BenchmarkArtifactArchiveEntry[];
}

export interface BenchmarkArtifactCompactResult {
  readonly files: readonly Readonly<{
    file: string;
    beforeBytes: number;
    bytes: number;
    sha256: string;
  }>[];
  readonly references: readonly Readonly<{ file: string; sha256: string }>[];
}

type ArtifactPath = string | URL;

export async function readBenchmarkArtifactBytes(path: ArtifactPath): Promise<Uint8Array> {
  if (hasGzipSuffix(path)) return decompress(await readFile(path));

  try {
    return Uint8Array.from(await readFile(path));
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
    return decompress(await readFile(withGzipSuffix(path)));
  }
}

export async function archiveBenchmarkArtifacts(
  resultsDirectory: string = DEFAULT_RESULTS_DIRECTORY,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<BenchmarkArtifactArchiveManifest> {
  const artifacts: BenchmarkArtifactArchiveEntry[] = [];
  for (const file of BENCHMARK_ARTIFACT_ARCHIVE_FILES) {
    const source = Uint8Array.from(await readFile(resolve(resultsDirectory, file)));
    const archive = `${file}.gz`;
    const compressed = deterministicGzip(source);
    await writeFile(resolve(resultsDirectory, archive), compressed);
    artifacts.push({
      file,
      archive,
      bytes: source.byteLength,
      archiveBytes: compressed.byteLength,
      sha256: sha256(source),
    });
  }

  const manifest = Object.freeze({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    artifacts: Object.freeze(artifacts.map((entry) => Object.freeze(entry))),
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  return manifest;
}

export async function verifyBenchmarkArtifactArchives(
  resultsDirectory: string = DEFAULT_RESULTS_DIRECTORY,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<BenchmarkArtifactArchiveManifest> {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as BenchmarkArtifactArchiveManifest;
  validateManifest(manifest);

  for (const entry of manifest.artifacts) {
    const archive = await readFile(resolve(resultsDirectory, entry.archive));
    if (archive.byteLength !== entry.archiveBytes) {
      throw new Error(`Benchmark archive byte count changed: ${entry.archive}`);
    }
    validateSource(entry, decompress(archive));
  }
  return manifest;
}

export async function materializeBenchmarkArtifacts(
  resultsDirectory: string = DEFAULT_RESULTS_DIRECTORY,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<BenchmarkArtifactArchiveManifest> {
  const manifest = await verifyBenchmarkArtifactArchives(resultsDirectory, manifestPath);
  for (const entry of manifest.artifacts) {
    const destination = resolve(resultsDirectory, entry.file);
    const source = decompress(await readFile(resolve(resultsDirectory, entry.archive)));
    try {
      validateSource(entry, await readFile(destination));
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
      await writeFile(destination, source);
    }
  }
  return manifest;
}

export async function compactBenchmarkArtifacts(
  resultsDirectory: string = DEFAULT_RESULTS_DIRECTORY,
): Promise<BenchmarkArtifactCompactResult> {
  const hashes = new Map<string, string>();
  const files = [];
  for (const file of BENCHMARK_ARTIFACT_COMPACT_FILES) {
    const path = resolve(resultsDirectory, file);
    const source = await readFile(path);
    const compact = new TextEncoder().encode(`${JSON.stringify(JSON.parse(source.toString()))}\n`);
    await writeFile(path, compact);
    const digest = sha256(compact);
    hashes.set(file, digest);
    files.push({ file, beforeBytes: source.byteLength, bytes: compact.byteLength, sha256: digest });
  }

  const references = [];
  for (const file of COMPACT_REFERENCE_FILES) {
    const path = resolve(resultsDirectory, file);
    const artifact = JSON.parse(await readFile(path, "utf8")) as unknown;
    updateCandidateHashes(artifact, hashes);
    const serialized = `${JSON.stringify(artifact, undefined, 2)}\n`;
    await writeFile(path, serialized);
    references.push({ file, sha256: sha256(new TextEncoder().encode(serialized)) });
  }

  return Object.freeze({ files: Object.freeze(files), references: Object.freeze(references) });
}

function deterministicGzip(source: Uint8Array): Uint8Array {
  const compressed = gzipSync(source, { level: constants.Z_BEST_COMPRESSION });
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  return Uint8Array.from(compressed);
}

function updateCandidateHashes(value: unknown, hashes: ReadonlyMap<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) updateCandidateHashes(item, hashes);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const artifactFile = record.artifactFile;
  if (typeof artifactFile === "string") {
    const digest = hashes.get(artifactFile);
    if (digest !== undefined && typeof record.candidateSha256 === "string") {
      record.candidateSha256 = digest;
    }
  }
  for (const child of Object.values(record)) updateCandidateHashes(child, hashes);
}

function decompress(source: Uint8Array): Uint8Array {
  return Uint8Array.from(gunzipSync(source));
}

function validateManifest(manifest: BenchmarkArtifactArchiveManifest): void {
  if (manifest.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported benchmark archive schema: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.artifacts.length !== BENCHMARK_ARTIFACT_ARCHIVE_FILES.length) {
    throw new RangeError("Benchmark archive manifest does not cover the exact evidence set");
  }
  for (const [index, file] of BENCHMARK_ARTIFACT_ARCHIVE_FILES.entries()) {
    const entry = manifest.artifacts[index];
    if (entry?.file !== file || entry.archive !== `${file}.gz`) {
      throw new TypeError(`Benchmark archive manifest order changed at ${file}`);
    }
  }
}

function validateSource(entry: BenchmarkArtifactArchiveEntry, source: Uint8Array): void {
  if (source.byteLength !== entry.bytes) {
    throw new Error(`Benchmark artifact byte count changed: ${entry.file}`);
  }
  if (sha256(source) !== entry.sha256) {
    throw new Error(`Benchmark artifact SHA-256 changed: ${entry.file}`);
  }
}

function sha256(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function hasGzipSuffix(path: ArtifactPath): boolean {
  return path instanceof URL ? path.pathname.endsWith(".gz") : path.endsWith(".gz");
}

function withGzipSuffix(path: ArtifactPath): ArtifactPath {
  return path instanceof URL ? new URL(`${path.href}.gz`) : `${path}.gz`;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

if (import.meta.main) {
  const action = process.argv[2] ?? "verify";
  if (action === "compact") {
    console.log(JSON.stringify({ action, ...(await compactBenchmarkArtifacts()) }));
    process.exit(0);
  }
  const manifest =
    action === "archive"
      ? await archiveBenchmarkArtifacts()
      : action === "materialize"
        ? await materializeBenchmarkArtifacts()
        : action === "verify"
          ? await verifyBenchmarkArtifactArchives()
          : undefined;
  if (manifest === undefined) {
    throw new RangeError(`Unknown benchmark archive action: ${action}`);
  }
  console.log(
    JSON.stringify({
      action,
      artifacts: manifest.artifacts.length,
      bytes: manifest.artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
      archiveBytes: manifest.artifacts.reduce((sum, entry) => sum + entry.archiveBytes, 0),
    }),
  );
}
