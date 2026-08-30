import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  BENCHMARK_ARTIFACT_ARCHIVE_FILES,
  materializeBenchmarkArtifacts,
  readBenchmarkArtifactBytes,
  verifyBenchmarkArtifactArchives,
} from "../scripts/benchmark-artifact-archive";

const resultsDirectory = resolve(import.meta.dir, "../benchmarks/results");
const manifestPath = resolve(resultsDirectory, "browser-artifact-archives-1.2.0.json");

test("keeps archived formal browser evidence byte-exact and materializable", async () => {
  const manifest = await verifyBenchmarkArtifactArchives(resultsDirectory, manifestPath);
  expect(manifest.artifacts.map((entry) => entry.file)).toEqual([
    ...BENCHMARK_ARTIFACT_ARCHIVE_FILES,
  ]);
  expect(manifest.artifacts.every((entry) => entry.archiveBytes < entry.bytes)).toBe(true);

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "glyphflow-artifact-archive-"));
  try {
    for (const entry of manifest.artifacts) {
      await Bun.write(
        resolve(temporaryDirectory, entry.archive),
        await readFile(resolve(resultsDirectory, entry.archive)),
      );
    }
    await Bun.write(manifestPathFor(temporaryDirectory), JSON.stringify(manifest));
    await materializeBenchmarkArtifacts(temporaryDirectory, manifestPathFor(temporaryDirectory));

    for (const entry of manifest.artifacts) {
      expect(await readBenchmarkArtifactBytes(resolve(temporaryDirectory, entry.file))).toEqual(
        await readBenchmarkArtifactBytes(resolve(resultsDirectory, entry.archive)),
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function manifestPathFor(directory: string): string {
  return resolve(directory, "browser-artifact-archives-1.2.0.json");
}
