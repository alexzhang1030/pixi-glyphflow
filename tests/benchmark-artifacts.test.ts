import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import {
  BROWSER_BENCHMARK_HARNESS_PATHS,
  browserBenchmarkArtifactFileName,
  browserBenchmarkBuildFingerprintSha256,
  browserBenchmarkEvidenceSha256,
  browserBenchmarkHarnessFingerprintSha256,
  createBrowserBenchmarkArtifact,
  createBrowserBenchmarkBuildManifest,
  createBrowserBenchmarkFrozenBuild,
  createBrowserBenchmarkHarnessManifest,
  createBrowserBenchmarkRunId,
  loadCurrentBrowserBenchmarkArtifact,
  parseBrowserArtifactName,
  readBrowserBenchmarkArtifact,
  readCurrentBrowserBenchmarkArtifact,
  readFixedHistoricalBrowserBenchmarkArtifact,
  readBrowserBenchmarkBuildManifest,
  resolveBrowserArtifact,
  resolveBrowserArtifactFreshness,
  serializeBrowserBenchmarkArtifact,
  verifyBrowserBenchmarkHarnessManifest,
  verifyBrowserBenchmarkArtifactEvidence,
} from "../benchmarks/artifacts";
import { freezeBrowserBenchmarkHarness } from "../benchmarks/harness-launcher";
import {
  BENCHMARK_SCHEMA_VERSION,
  type BrowserBenchmarkArtifactPayload,
  type BrowserBenchmarkHarnessManifestEntry,
} from "../benchmarks/schema";

const HARNESS_MANIFEST: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] = Object.freeze(
  BROWSER_BENCHMARK_HARNESS_PATHS.map((path, index) =>
    Object.freeze({
      path,
      bytes: index + 1,
      sha256: (index + 1).toString(16).padStart(64, "0"),
    }),
  ),
);
const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function createTemporaryRoot(prefix: string): Promise<string> {
  return mkdtemp(resolve(tmpdir(), prefix));
}

async function copyBenchmarkHarness(
  destinationRoot: string,
  paths: readonly string[] = BROWSER_BENCHMARK_HARNESS_PATHS,
): Promise<void> {
  for (const path of paths) {
    const destination = resolve(destinationRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(PROJECT_ROOT, path), destination);
  }
}

describe("browser benchmark artifact identity", () => {
  test("round-trips renderer, role, version, and exploratory status", () => {
    const fileName = browserBenchmarkArtifactFileName({
      workload: "gpu-scene-v2",
      renderer: "webgpu",
      artifactRole: "candidate",
      packageVersion: "1.2.0",
      exploratory: true,
    });

    expect(fileName).toBe("browser-gpu-scene-v2-webgpu-candidate-1.2.0-exploratory.json");
    expect(parseBrowserArtifactName(fileName, "gpu-scene-v2")).toEqual({
      version: "1.2.0",
      exploratory: true,
      renderer: "webgpu",
      artifactRole: "candidate",
    });
  });

  test("resolves one formal renderer and role without crossing artifact identities", () => {
    const resolved = resolveBrowserArtifact(
      "gpu-scene-v2",
      "1.2.0",
      [
        "browser-gpu-scene-v2-1.2.0.json",
        "browser-gpu-scene-v2-webgl-candidate-1.2.0.json",
        "browser-gpu-scene-v2-webgpu-baseline-1.2.0.json",
        "browser-gpu-scene-v2-webgpu-candidate-1.2.0-exploratory.json",
        "browser-gpu-scene-v2-webgpu-candidate-1.2.0.json",
      ],
      { renderer: "webgpu", artifactRole: "candidate", requireCurrent: true },
    );

    expect(resolved).toEqual({
      fileName: "browser-gpu-scene-v2-webgpu-candidate-1.2.0.json",
      version: "1.2.0",
      current: true,
      renderer: "webgpu",
      artifactRole: "candidate",
    });
  });

  test("keeps legacy workload resolution compatible", () => {
    expect(
      resolveBrowserArtifact("million-viewport", "1.2.0", [
        "browser-million-viewport-1.1.0.json",
        "browser-million-viewport-1.2.0-exploratory.json",
      ]),
    ).toEqual({
      fileName: "browser-million-viewport-1.1.0.json",
      version: "1.1.0",
      current: false,
    });
  });

  test("classifies missing, stale, and current artifact paths", () => {
    expect(resolveBrowserArtifactFreshness("million-live", "1.2.0", [])).toEqual({
      classification: "missing",
    });
    expect(
      resolveBrowserArtifactFreshness("million-live", "1.2.0", ["browser-million-live-1.1.0.json"]),
    ).toMatchObject({
      classification: "stale",
      artifact: { version: "1.1.0", current: false },
    });
    expect(
      resolveBrowserArtifactFreshness("million-live", "1.2.0", [
        "browser-million-live-1.1.0.json",
        "browser-million-live-1.2.0.json",
      ]),
    ).toMatchObject({
      classification: "current",
      artifact: { version: "1.2.0", current: true },
    });
  });

  test("classifies the renderer-scoped R1a artifact without crossing role or exploratory identity", () => {
    const files = [
      "browser-gpu-scene-heterogeneous-64-webgpu-baseline-1.2.0.json",
      "browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.1.0.json",
      "browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0-exploratory.json",
    ];
    expect(
      resolveBrowserArtifactFreshness("gpu-scene-heterogeneous-64", "1.2.0", [], {
        renderer: "webgpu",
        artifactRole: "candidate",
      }),
    ).toEqual({ classification: "missing" });
    expect(
      resolveBrowserArtifactFreshness("gpu-scene-heterogeneous-64", "1.2.0", files, {
        renderer: "webgpu",
        artifactRole: "candidate",
      }),
    ).toMatchObject({
      classification: "stale",
      artifact: { version: "1.1.0", renderer: "webgpu", artifactRole: "candidate" },
    });
    expect(
      resolveBrowserArtifactFreshness(
        "gpu-scene-heterogeneous-64",
        "1.2.0",
        [...files, "browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0.json"],
        { renderer: "webgpu", artifactRole: "candidate" },
      ),
    ).toMatchObject({
      classification: "current",
      artifact: { version: "1.2.0", renderer: "webgpu", artifactRole: "candidate" },
    });
  });

  test("fingerprints a stable browser bundle manifest including worker and Wasm assets", async () => {
    const first = await createBrowserBenchmarkBuildManifest(PROJECT_ROOT);
    const second = await createBrowserBenchmarkBuildManifest(PROJECT_ROOT);

    expect(first).toEqual(second);
    expect(first.some((entry) => entry.path === "playground/benchmark.html")).toBe(true);
    expect(first.some((entry) => /worker.*\.js$/i.test(entry.path))).toBe(true);
    expect(first.some((entry) => entry.path.endsWith(".wasm"))).toBe(true);
    expect(
      first.every(
        (entry) =>
          !entry.path.startsWith("/") &&
          !entry.path.includes(PROJECT_ROOT) &&
          /^[0-9a-f]{64}$/.test(entry.sha256),
      ),
    ).toBe(true);
    expect(browserBenchmarkBuildFingerprintSha256(first)).toBe(
      browserBenchmarkBuildFingerprintSha256([...first].reverse()),
    );
  });

  test("fingerprints stable Node runner semantics and responds to polling changes", async () => {
    const first = await createBrowserBenchmarkHarnessManifest(PROJECT_ROOT);
    const second = await createBrowserBenchmarkHarnessManifest(PROJECT_ROOT);

    expect(first).toEqual(second);
    expect(first.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "benchmarks/artifacts.ts",
        "benchmarks/run.ts",
        "benchmarks/runtime.ts",
        "benchmarks/gpu-scene-resident-budget.ts",
        "benchmarks/schema.ts",
        "benchmarks/workloads.ts",
        "package.json",
        "bun.lock",
      ]),
    );
    expect(
      first.every(
        (entry) =>
          !entry.path.startsWith("/") &&
          !entry.path.includes(PROJECT_ROOT) &&
          /^[0-9a-f]{64}$/.test(entry.sha256),
      ),
    ).toBe(true);
    expect(browserBenchmarkHarnessFingerprintSha256(first)).toBe(
      browserBenchmarkHarnessFingerprintSha256([...first].reverse()),
    );

    const temporaryRoot = await createTemporaryRoot("glyphflow-harness-fingerprint-");
    try {
      await copyBenchmarkHarness(
        temporaryRoot,
        first.map((entry) => entry.path),
      );
      const before = await createBrowserBenchmarkHarnessManifest(temporaryRoot);
      expect(await verifyBrowserBenchmarkHarnessManifest(temporaryRoot, before)).toBe(true);
      const runPath = resolve(temporaryRoot, "benchmarks/run.ts");
      const runSource = await readFile(runPath, "utf8");
      expect(runSource).toContain("polling: runtime.BENCHMARK_STATUS_POLLING_MS");
      await writeFile(
        runPath,
        runSource.replace("polling: runtime.BENCHMARK_STATUS_POLLING_MS", "polling: 101"),
      );
      const after = await createBrowserBenchmarkHarnessManifest(temporaryRoot);

      expect(await verifyBrowserBenchmarkHarnessManifest(temporaryRoot, before)).toBe(false);
      expect(browserBenchmarkHarnessFingerprintSha256(after)).not.toBe(
        browserBenchmarkHarnessFingerprintSha256(before),
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("executes the frozen helper bytes when the source helper drifts after loading", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-frozen-harness-race-");
    const sourceRoot = resolve(temporaryRoot, "source");
    const frozenRoot = resolve(temporaryRoot, "frozen");
    try {
      await copyBenchmarkHarness(sourceRoot);
      await mkdir(frozenRoot);
      const frozenManifest = await freezeBrowserBenchmarkHarness(sourceRoot, frozenRoot);
      const frozenRuntime = (await import(
        `${pathToFileURL(resolve(frozenRoot, "benchmarks/runtime.ts")).href}?fixture=${crypto.randomUUID()}`
      )) as { readonly BENCHMARK_STATUS_POLLING_MS: number };
      expect(frozenRuntime.BENCHMARK_STATUS_POLLING_MS).toBe(100);

      const sourceRuntimePath = resolve(sourceRoot, "benchmarks/runtime.ts");
      const sourceRuntime = await readFile(sourceRuntimePath, "utf8");
      await writeFile(
        sourceRuntimePath,
        sourceRuntime.replace(
          "BENCHMARK_STATUS_POLLING_MS = 100",
          "BENCHMARK_STATUS_POLLING_MS = 101",
        ),
      );
      const sourceManifest = await createBrowserBenchmarkHarnessManifest(sourceRoot);
      const readbackManifest = await createBrowserBenchmarkHarnessManifest(frozenRoot);

      expect(readbackManifest).toEqual(frozenManifest);
      expect(await verifyBrowserBenchmarkHarnessManifest(frozenRoot, frozenManifest)).toBe(true);
      expect(browserBenchmarkHarnessFingerprintSha256(sourceManifest)).not.toBe(
        browserBenchmarkHarnessFingerprintSha256(frozenManifest),
      );
      expect(frozenRuntime.BENCHMARK_STATUS_POLLING_MS).toBe(100);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("terminates when the loaded launcher source changes before freezing", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-launcher-race-");
    const sourceRoot = resolve(temporaryRoot, "source");
    const frozenRoot = resolve(temporaryRoot, "frozen");
    try {
      await copyBenchmarkHarness(sourceRoot);
      const launcherPath = resolve(sourceRoot, "benchmarks/harness-launcher.ts");
      const loadedLauncher = (await import(
        `${pathToFileURL(launcherPath).href}?fixture=${crypto.randomUUID()}`
      )) as typeof import("../benchmarks/harness-launcher");
      await writeFile(launcherPath, `${await readFile(launcherPath, "utf8")}\n// drift\n`);
      await mkdir(frozenRoot);

      await expect(
        loadedLauncher.freezeBrowserBenchmarkHarness(sourceRoot, frozenRoot),
      ).rejects.toThrow("launcher changed after module loading");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("terminates launcher drift when its source root is provided through a symlink alias", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-launcher-alias-race-");
    const sourceRoot = resolve(temporaryRoot, "source");
    const sourceAlias = resolve(temporaryRoot, "source-alias");
    const frozenRoot = resolve(temporaryRoot, "frozen");
    try {
      await copyBenchmarkHarness(sourceRoot);
      await symlink(sourceRoot, sourceAlias, "dir");
      const launcherPath = resolve(sourceRoot, "benchmarks/harness-launcher.ts");
      const loadedLauncher = (await import(
        `${pathToFileURL(launcherPath).href}?fixture=${crypto.randomUUID()}`
      )) as typeof import("../benchmarks/harness-launcher");
      await writeFile(launcherPath, `${await readFile(launcherPath, "utf8")}\n// alias drift\n`);
      await mkdir(frozenRoot);

      await expect(
        loadedLauncher.freezeBrowserBenchmarkHarness(sourceAlias, frozenRoot),
      ).rejects.toThrow("launcher changed after module loading");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("terminates when the loaded launcher changes after an earlier entry is copied", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-launcher-mid-copy-race-");
    const sourceRoot = resolve(temporaryRoot, "source");
    const frozenRoot = resolve(temporaryRoot, "frozen");
    try {
      await copyBenchmarkHarness(sourceRoot);
      const launcherPath = resolve(sourceRoot, "benchmarks/harness-launcher.ts");
      const loadedLauncher = (await import(
        `${pathToFileURL(launcherPath).href}?fixture=${crypto.randomUUID()}`
      )) as typeof import("../benchmarks/harness-launcher");
      await mkdir(frozenRoot);

      await expect(
        loadedLauncher.freezeBrowserBenchmarkHarness(sourceRoot, frozenRoot, {
          afterEntryCopied: async (path) => {
            if (path === "benchmarks/artifacts.ts") {
              await writeFile(
                launcherPath,
                `${await readFile(launcherPath, "utf8")}\n// mid-copy drift\n`,
              );
            }
          },
        }),
      ).rejects.toThrow("launcher changed after module loading");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("terminates when frozen launcher bytes differ from restored loaded source", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-launcher-manifest-race-");
    const sourceRoot = resolve(temporaryRoot, "source");
    const frozenRoot = resolve(temporaryRoot, "frozen");
    try {
      await copyBenchmarkHarness(sourceRoot);
      const launcherPath = resolve(sourceRoot, "benchmarks/harness-launcher.ts");
      const originalLauncherSource = await readFile(launcherPath, "utf8");
      const loadedLauncher = (await import(
        `${pathToFileURL(launcherPath).href}?fixture=${crypto.randomUUID()}`
      )) as typeof import("../benchmarks/harness-launcher");
      await mkdir(frozenRoot);

      await expect(
        loadedLauncher.freezeBrowserBenchmarkHarness(sourceRoot, frozenRoot, {
          afterEntryCopied: async (path) => {
            if (path === "benchmarks/artifacts.ts") {
              await writeFile(launcherPath, `${originalLauncherSource}\n// transient drift\n`);
            }
            if (path === "benchmarks/index.ts") {
              await writeFile(launcherPath, originalLauncherSource);
            }
          },
        }),
      ).rejects.toThrow("Frozen browser benchmark launcher differs from the loaded launcher");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("keeps frozen execution bytes bound to the manifest after source drift", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-provenance-fixture-");
    const sourceRoot = resolve(temporaryRoot, "source");
    const buildRoot = resolve(temporaryRoot, "build");
    try {
      await cp(new URL("./fixtures/benchmark-provenance", import.meta.url), sourceRoot, {
        recursive: true,
      });
      await mkdir(buildRoot);
      const manifest = await createBrowserBenchmarkFrozenBuild(sourceRoot, buildRoot, {
        entry: "index.html",
      });
      const fingerprint = browserBenchmarkBuildFingerprintSha256(manifest);

      await writeFile(
        resolve(sourceRoot, "entry.ts"),
        'document.body.dataset.provenanceFixture = "drifted-after-build";\n',
      );

      const frozenManifest = await readBrowserBenchmarkBuildManifest(buildRoot);
      const bundleEntry = frozenManifest.find((entry) => entry.path.endsWith(".js"));
      if (bundleEntry === undefined) throw new Error("Expected a frozen JavaScript bundle");
      const frozenBundle = await readFile(resolve(buildRoot, bundleEntry.path), "utf8");
      const executionDocument = { body: { dataset: {} as Record<string, string> } };
      runInNewContext(frozenBundle, { document: executionDocument });

      expect(frozenManifest).toEqual(manifest);
      expect(browserBenchmarkBuildFingerprintSha256(frozenManifest)).toBe(fingerprint);
      expect(executionDocument.body.dataset.provenanceFixture).toBe("frozen-before-source-drift");
      expect(frozenBundle).toContain("frozen-before-source-drift");
      expect(frozenBundle).not.toContain("drifted-after-build");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("preserves the project when its root is selected as the frozen build target", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-provenance-safety-");
    const sourceRoot = resolve(temporaryRoot, "project");
    const sentinel = resolve(sourceRoot, "root-sentinel.txt");
    try {
      await cp(new URL("./fixtures/benchmark-provenance", import.meta.url), sourceRoot, {
        recursive: true,
      });
      await writeFile(sentinel, "root-sentinel");

      await expect(
        createBrowserBenchmarkFrozenBuild(sourceRoot, sourceRoot, { entry: "index.html" }),
      ).rejects.toThrow("outside the project root");
      expect(await readFile(sentinel, "utf8")).toBe("root-sentinel");
      expect(await readFile(resolve(sourceRoot, "entry.ts"), "utf8")).toContain(
        "frozen-before-source-drift",
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("preserves an ancestor directory selected as the frozen build target", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-provenance-safety-");
    const sourceRoot = resolve(temporaryRoot, "project");
    const sentinel = resolve(temporaryRoot, "ancestor-sentinel.txt");
    try {
      await cp(new URL("./fixtures/benchmark-provenance", import.meta.url), sourceRoot, {
        recursive: true,
      });
      await writeFile(sentinel, "ancestor-sentinel");

      await expect(
        createBrowserBenchmarkFrozenBuild(sourceRoot, temporaryRoot, { entry: "index.html" }),
      ).rejects.toThrow("outside the project root");
      expect(await readFile(sentinel, "utf8")).toBe("ancestor-sentinel");
      expect(await readFile(resolve(sourceRoot, "entry.ts"), "utf8")).toContain(
        "frozen-before-source-drift",
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("preserves a non-empty frozen build target", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-provenance-safety-");
    const sourceRoot = resolve(temporaryRoot, "project");
    const outputRoot = resolve(temporaryRoot, "occupied-output");
    const sentinel = resolve(outputRoot, "output-sentinel.txt");
    try {
      await cp(new URL("./fixtures/benchmark-provenance", import.meta.url), sourceRoot, {
        recursive: true,
      });
      await mkdir(outputRoot);
      await writeFile(sentinel, "output-sentinel");

      await expect(
        createBrowserBenchmarkFrozenBuild(sourceRoot, outputRoot, { entry: "index.html" }),
      ).rejects.toThrow("must be empty");
      expect(await readFile(sentinel, "utf8")).toBe("output-sentinel");
      expect(await readdir(outputRoot)).toEqual(["output-sentinel.txt"]);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("preserves a direct symbolic-link build target", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-provenance-safety-");
    const sourceRoot = resolve(temporaryRoot, "project");
    const realOutputRoot = resolve(temporaryRoot, "real-output");
    const aliasOutputRoot = resolve(temporaryRoot, "alias-output");
    const sentinel = resolve(temporaryRoot, "symlink-sentinel.txt");
    try {
      await cp(new URL("./fixtures/benchmark-provenance", import.meta.url), sourceRoot, {
        recursive: true,
      });
      await mkdir(realOutputRoot);
      await symlink(realOutputRoot, aliasOutputRoot, "dir");
      await writeFile(sentinel, "symlink-sentinel");

      await expect(
        createBrowserBenchmarkFrozenBuild(sourceRoot, aliasOutputRoot, { entry: "index.html" }),
      ).rejects.toThrow("direct temporary directory");
      expect(await readFile(sentinel, "utf8")).toBe("symlink-sentinel");
      expect(await readdir(realOutputRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("preserves a build target reached through a symbolic-link parent", async () => {
    const temporaryRoot = await createTemporaryRoot("glyphflow-provenance-safety-");
    const sourceRoot = resolve(temporaryRoot, "project");
    const realParent = resolve(temporaryRoot, "real-parent");
    const realOutputRoot = resolve(realParent, "build");
    const aliasParent = resolve(temporaryRoot, "alias-parent");
    const aliasOutputRoot = resolve(aliasParent, "build");
    const sentinel = resolve(realParent, "symlink-parent-sentinel.txt");
    try {
      await cp(new URL("./fixtures/benchmark-provenance", import.meta.url), sourceRoot, {
        recursive: true,
      });
      await mkdir(realOutputRoot, { recursive: true });
      await writeFile(sentinel, "symlink-parent-sentinel");
      await symlink(realParent, aliasParent, "dir");

      await expect(
        createBrowserBenchmarkFrozenBuild(sourceRoot, aliasOutputRoot, { entry: "index.html" }),
      ).rejects.toThrow("direct temporary directory");
      expect(await readFile(sentinel, "utf8")).toBe("symlink-parent-sentinel");
      expect(await readdir(realOutputRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("creates a unique UUID for every runner invocation", () => {
    const first = createBrowserBenchmarkRunId();
    const second = createBrowserBenchmarkRunId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  test("seals canonical artifact evidence and preserves it through JSON round trips", () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "58dbbd8e-f544-4707-8a6e-b3b2a35396ae",
      buildManifest: [
        { path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) },
        { path: "assets/worker.js", bytes: 4, sha256: "b".repeat(64) },
      ],
      harnessManifest: HARNESS_MANIFEST,
    });
    const serialized = serializeBrowserBenchmarkArtifact(artifact);
    const read = readBrowserBenchmarkArtifact(serialized);

    expect(read.classification).toBe("current");
    if (read.classification !== "current") throw new Error("Expected a current artifact");
    expect(read.artifact).toEqual(artifact);
    expect(serializeBrowserBenchmarkArtifact(read.artifact)).toBe(serialized);
    expect(verifyBrowserBenchmarkArtifactEvidence(read.artifact)).toBe(true);
    expect(browserBenchmarkEvidenceSha256(read.artifact)).toBe(artifact.provenance.evidenceSha256);
    expect(artifact.provenance.harnessManifest).toEqual(HARNESS_MANIFEST);
    expect(artifact.provenance.harnessFingerprintSha256).toBe(
      browserBenchmarkHarnessFingerprintSha256(HARNESS_MANIFEST),
    );
  });

  test("accepts only sealed artifacts from the current build and harness", () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "58dbbd8e-f544-4707-8a6e-b3b2a35396ae",
      buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
      harnessManifest: HARNESS_MANIFEST,
    });
    const expected = {
      packageVersion: "1.2.0",
      workload: "gpu-scene-resident" as const,
      renderer: "webgpu" as const,
      artifactRole: "candidate" as const,
      buildFingerprintSha256: artifact.provenance.buildFingerprintSha256,
      harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
    };

    expect(readCurrentBrowserBenchmarkArtifact(JSON.stringify(artifact), expected)).toEqual(
      artifact,
    );
    expect(() =>
      readCurrentBrowserBenchmarkArtifact(JSON.stringify(artifact), {
        ...expected,
        buildFingerprintSha256: "c".repeat(64),
      }),
    ).toThrow("current browser build fingerprint");
    expect(() =>
      readCurrentBrowserBenchmarkArtifact(JSON.stringify(artifact), {
        ...expected,
        harnessFingerprintSha256: "d".repeat(64),
      }),
    ).toThrow("current benchmark harness fingerprint");
  });

  test("marks a current-name candidate from an older build unavailable", async () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "58dbbd8e-f544-4707-8a6e-b3b2a35396ae",
      buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
      harnessManifest: HARNESS_MANIFEST,
    });
    const resultsDirectory = await createTemporaryRoot("glyphflow-current-artifact-");
    const fileName = "browser-gpu-scene-resident-webgpu-candidate-1.2.0.json";
    try {
      await writeFile(
        resolve(resultsDirectory, fileName),
        serializeBrowserBenchmarkArtifact(artifact),
      );

      const loaded = await loadCurrentBrowserBenchmarkArtifact({
        resultsDirectory,
        fileNames: [fileName],
        expected: {
          packageVersion: "1.2.0",
          workload: "gpu-scene-resident",
          renderer: "webgpu",
          artifactRole: "candidate",
          buildFingerprintSha256: "c".repeat(64),
          harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
        },
      });

      expect(loaded).toMatchObject({
        classification: "unavailable",
        reason: "stale",
      });
      if (loaded.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(loaded.diagnostic).toContain("current browser build fingerprint");
    } finally {
      await rm(resultsDirectory, { force: true, recursive: true });
    }
  });

  test("marks an evidence-sealed incomplete current candidate unavailable", async () => {
    const artifact = createBrowserBenchmarkArtifact(
      { ...browserArtifactPayload(), status: "capacity-limit" },
      {
        runId: "a83fa2af-f095-4f41-872d-284c1d578c24",
        buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
        harnessManifest: HARNESS_MANIFEST,
      },
    );
    const resultsDirectory = await createTemporaryRoot("glyphflow-current-artifact-");
    const fileName = "browser-gpu-scene-resident-webgpu-candidate-1.2.0.json";
    try {
      await writeFile(
        resolve(resultsDirectory, fileName),
        serializeBrowserBenchmarkArtifact(artifact),
      );

      const loaded = await loadCurrentBrowserBenchmarkArtifact({
        resultsDirectory,
        fileNames: [fileName],
        expected: {
          packageVersion: "1.2.0",
          workload: "gpu-scene-resident",
          renderer: "webgpu",
          artifactRole: "candidate",
          buildFingerprintSha256: artifact.provenance.buildFingerprintSha256,
          harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
        },
      });

      expect(loaded).toMatchObject({
        classification: "unavailable",
        reason: "invalid",
      });
      if (loaded.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(loaded.diagnostic).toContain("status must be complete");
    } finally {
      await rm(resultsDirectory, { force: true, recursive: true });
    }
  });

  test("loads one valid current candidate and diagnoses every seal boundary", async () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "42f9e23a-f417-4253-a4d9-42f94550a9ed",
      buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
      harnessManifest: HARNESS_MANIFEST,
    });
    const resultsDirectory = await createTemporaryRoot("glyphflow-current-artifact-");
    const fileName = "browser-gpu-scene-resident-webgpu-candidate-1.2.0.json";
    const expected = {
      packageVersion: "1.2.0",
      workload: "gpu-scene-resident" as const,
      renderer: "webgpu" as const,
      artifactRole: "candidate" as const,
      buildFingerprintSha256: artifact.provenance.buildFingerprintSha256,
      harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
    };
    const load = async (value: unknown, expectation = expected) => {
      await writeFile(resolve(resultsDirectory, fileName), JSON.stringify(value));
      return loadCurrentBrowserBenchmarkArtifact({
        resultsDirectory,
        fileNames: [fileName],
        expected: expectation,
      });
    };
    try {
      expect(await load(artifact)).toMatchObject({ classification: "current", artifact });

      const olderHarness = await load(artifact, {
        ...expected,
        harnessFingerprintSha256: "d".repeat(64),
      });
      expect(olderHarness).toMatchObject({ classification: "unavailable", reason: "stale" });
      if (olderHarness.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(olderHarness.diagnostic).toContain("current benchmark harness fingerprint");

      const tamperedEvidence = structuredClone(artifact) as unknown as Record<string, unknown>;
      tamperedEvidence.capturedAt = "2026-08-29T12:00:01.000Z";
      const tampered = await load(tamperedEvidence);
      expect(tampered).toMatchObject({ classification: "unavailable", reason: "invalid" });
      if (tampered.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(tampered.diagnostic).toContain("evidence SHA-256");

      const wrongRole = createBrowserBenchmarkArtifact(
        { ...browserArtifactPayload(), artifactRole: "baseline" },
        {
          runId: "14733550-d0e8-4133-9ae9-cd40a02d21ed",
          buildManifest: artifact.provenance.buildManifest,
          harnessManifest: HARNESS_MANIFEST,
        },
      );
      const roleResult = await load(wrongRole);
      expect(roleResult).toMatchObject({ classification: "unavailable", reason: "invalid" });
      if (roleResult.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(roleResult.diagnostic).toContain("role does not match");

      const schemaResult = await load({
        ...browserArtifactPayload(),
        schemaVersion: 6,
        samples: [],
      });
      expect(schemaResult).toMatchObject({ classification: "unavailable", reason: "invalid" });
      if (schemaResult.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(schemaResult.diagnostic).toContain("requires schema 7");

      const wrongPackage = createBrowserBenchmarkArtifact(
        { ...browserArtifactPayload(), packageVersion: "1.1.0" },
        {
          runId: "9f2d560d-78d4-42f5-8820-dab277f6a63d",
          buildManifest: artifact.provenance.buildManifest,
          harnessManifest: HARNESS_MANIFEST,
        },
      );
      const packageResult = await load(wrongPackage);
      expect(packageResult).toMatchObject({ classification: "unavailable", reason: "invalid" });
      if (packageResult.classification !== "unavailable") {
        throw new Error("Expected an unavailable current artifact");
      }
      expect(packageResult.diagnostic).toContain("package version does not match");
    } finally {
      await rm(resultsDirectory, { force: true, recursive: true });
    }
  });

  test("classifies missing and stale current candidates as unavailable", async () => {
    const expected = {
      packageVersion: "1.2.0",
      workload: "gpu-scene-v2" as const,
      renderer: "webgpu" as const,
      artifactRole: "candidate" as const,
      buildFingerprintSha256: "a".repeat(64),
      harnessFingerprintSha256: "b".repeat(64),
    };

    const missing = await loadCurrentBrowserBenchmarkArtifact({
      resultsDirectory: "/unused",
      fileNames: [],
      expected,
    });
    const stale = await loadCurrentBrowserBenchmarkArtifact({
      resultsDirectory: "/unused",
      fileNames: ["browser-gpu-scene-v2-webgpu-candidate-1.1.0.json"],
      expected,
    });

    expect(missing).toMatchObject({ classification: "unavailable", reason: "missing" });
    expect(stale).toMatchObject({
      classification: "unavailable",
      reason: "stale",
      resolvedArtifact: { version: "1.1.0" },
    });
    if (missing.classification !== "unavailable" || stale.classification !== "unavailable") {
      throw new Error("Expected unavailable current artifacts");
    }
    expect(missing.diagnostic).toContain("is missing");
    expect(stale.diagnostic).toContain("expected package 1.2.0, found 1.1.0");
  });

  test("binds the formal R1a artifact to its exact workload, renderer, and role", () => {
    const artifact = createBrowserBenchmarkArtifact(
      {
        ...browserArtifactPayload(),
        workload: "gpu-scene-heterogeneous-64",
      },
      {
        runId: "61bb647e-a4f4-4fb7-acf3-302b55d529d6",
        buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
        harnessManifest: HARNESS_MANIFEST,
      },
    );
    const expected = {
      packageVersion: "1.2.0",
      workload: "gpu-scene-heterogeneous-64" as const,
      renderer: "webgpu" as const,
      artifactRole: "candidate" as const,
      buildFingerprintSha256: artifact.provenance.buildFingerprintSha256,
      harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
    };

    expect(readCurrentBrowserBenchmarkArtifact(JSON.stringify(artifact), expected)).toEqual(
      artifact,
    );
    expect(() =>
      readCurrentBrowserBenchmarkArtifact(JSON.stringify(artifact), {
        ...expected,
        workload: "gpu-scene-resident",
      }),
    ).toThrow("workload does not match");
  });

  test("reads an intrinsically sealed older harness closure while the current R1a gate rejects it", () => {
    const artifact = createBrowserBenchmarkArtifact(
      {
        ...browserArtifactPayload(),
        workload: "gpu-scene-heterogeneous-64",
      },
      {
        runId: "b9b0908a-59eb-4f90-a59b-e3104c3acdb7",
        buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
        harnessManifest: HARNESS_MANIFEST,
      },
    );
    const older = structuredClone(artifact) as unknown as {
      provenance: {
        harnessManifest: BrowserBenchmarkHarnessManifestEntry[];
        harnessFingerprintSha256: string;
        evidenceSha256: string;
      };
    };
    older.provenance.harnessManifest = older.provenance.harnessManifest.filter(
      (entry) => entry.path !== "benchmarks/gpu-scene-heterogeneous-budget.ts",
    );
    older.provenance.harnessFingerprintSha256 = browserBenchmarkHarnessFingerprintSha256(
      older.provenance.harnessManifest,
    );
    older.provenance.evidenceSha256 = browserBenchmarkEvidenceSha256(older);

    expect(readBrowserBenchmarkArtifact(JSON.stringify(older))).toMatchObject({
      classification: "current",
    });
    expect(() =>
      readCurrentBrowserBenchmarkArtifact(JSON.stringify(older), {
        packageVersion: "1.2.0",
        workload: "gpu-scene-heterogeneous-64",
        renderer: "webgpu",
        artifactRole: "candidate",
        buildFingerprintSha256: artifact.provenance.buildFingerprintSha256,
        harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
      }),
    ).toThrow("current benchmark harness fingerprint");
  });

  test("detects a copied artifact whose capturedAt changed", () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "58dbbd8e-f544-4707-8a6e-b3b2a35396ae",
      buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
      harnessManifest: HARNESS_MANIFEST,
    });
    const copied = structuredClone(artifact) as unknown as Record<string, unknown>;
    copied.capturedAt = "2026-08-29T12:00:01.000Z";

    expect(verifyBrowserBenchmarkArtifactEvidence(copied)).toBe(false);
    expect(() => readBrowserBenchmarkArtifact(JSON.stringify(copied))).toThrow("evidence SHA-256");
  });

  test("rejects a resealed artifact whose build fingerprint disagrees with its manifest", () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "58dbbd8e-f544-4707-8a6e-b3b2a35396ae",
      buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
      harnessManifest: HARNESS_MANIFEST,
    });
    const forged = structuredClone(artifact) as unknown as {
      provenance: { buildFingerprintSha256: string; evidenceSha256: string };
    };
    forged.provenance.buildFingerprintSha256 = "c".repeat(64);
    forged.provenance.evidenceSha256 = browserBenchmarkEvidenceSha256(forged);

    expect(verifyBrowserBenchmarkArtifactEvidence(forged)).toBe(false);
    expect(() => readBrowserBenchmarkArtifact(JSON.stringify(forged))).toThrow("evidence SHA-256");
  });

  test("rejects resealed harness manifest and fingerprint tampering", () => {
    const artifact = createBrowserBenchmarkArtifact(browserArtifactPayload(), {
      runId: "58dbbd8e-f544-4707-8a6e-b3b2a35396ae",
      buildManifest: [{ path: "assets/benchmark.js", bytes: 3, sha256: "a".repeat(64) }],
      harnessManifest: HARNESS_MANIFEST,
    });
    const manifestTamper = structuredClone(artifact) as unknown as {
      provenance: {
        harnessManifest: Array<{ path: string; bytes: number; sha256: string }>;
        evidenceSha256: string;
      };
    };
    manifestTamper.provenance.harnessManifest[0]!.bytes += 1;
    manifestTamper.provenance.evidenceSha256 = browserBenchmarkEvidenceSha256(manifestTamper);
    const fingerprintTamper = structuredClone(artifact) as unknown as {
      provenance: { harnessFingerprintSha256: string; evidenceSha256: string };
    };
    fingerprintTamper.provenance.harnessFingerprintSha256 = "f".repeat(64);
    fingerprintTamper.provenance.evidenceSha256 = browserBenchmarkEvidenceSha256(fingerprintTamper);

    expect(verifyBrowserBenchmarkArtifactEvidence(manifestTamper)).toBe(false);
    expect(verifyBrowserBenchmarkArtifactEvidence(fingerprintTamper)).toBe(false);
    expect(() => readBrowserBenchmarkArtifact(JSON.stringify(manifestTamper))).toThrow(
      "evidence SHA-256",
    );
    expect(() => readBrowserBenchmarkArtifact(JSON.stringify(fingerprintTamper))).toThrow(
      "evidence SHA-256",
    );
  });

  test("reads schema 6 artifacts with an explicit historical classification", () => {
    const historical = {
      ...browserArtifactPayload(),
      schemaVersion: 6,
      samples: [],
    };

    const read = readBrowserBenchmarkArtifact(JSON.stringify(historical));

    expect(read).toMatchObject({
      classification: "historical",
      schemaVersion: 6,
      reason: "schema-6-without-build-provenance",
    });
    expect(() =>
      readCurrentBrowserBenchmarkArtifact(JSON.stringify(historical), {
        packageVersion: "1.2.0",
        workload: "gpu-scene-resident",
        renderer: "webgpu",
        artifactRole: "candidate",
        buildFingerprintSha256: "a".repeat(64),
        harnessFingerprintSha256: "b".repeat(64),
      }),
    ).toThrow("requires schema 7");
  });

  test("reads a fixed schema 3 baseline through the historical path", () => {
    const historical = {
      ...browserArtifactPayload(),
      schemaVersion: 3,
      packageVersion: "1.1.0",
      workload: "million-viewport",
      renderer: undefined,
      artifactRole: undefined,
      samples: [],
    };
    const serialized = JSON.stringify(historical);

    expect(
      readFixedHistoricalBrowserBenchmarkArtifact(serialized, {
        packageVersion: "1.1.0",
        currentPackageVersion: "1.2.0",
        workload: "million-viewport",
      }),
    ).toMatchObject({
      schemaVersion: 3,
      packageVersion: "1.1.0",
      workload: "million-viewport",
      status: "complete",
    });
    expect(() =>
      readFixedHistoricalBrowserBenchmarkArtifact(serialized, {
        packageVersion: "1.0.0",
        currentPackageVersion: "1.2.0",
        workload: "million-viewport",
      }),
    ).toThrow("package version does not match its path");
    expect(() =>
      readFixedHistoricalBrowserBenchmarkArtifact(serialized, {
        packageVersion: "1.1.0",
        currentPackageVersion: "1.1.0",
        workload: "million-viewport",
      }),
    ).toThrow("must precede current package");
  });
});

function browserArtifactPayload(): BrowserBenchmarkArtifactPayload {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmark: "browser-workloads",
    packageVersion: "1.2.0",
    capturedAt: "2026-08-29T12:00:00.000Z",
    runtime: {
      bun: "1.4.0",
      cpu: "Apple M1 Pro",
      platform: "darwin",
      release: "25.6.0",
      architecture: "arm64",
    },
    workload: "gpu-scene-resident",
    renderer: "webgpu",
    artifactRole: "candidate",
    status: "complete",
    samples: [],
    failures: [],
    summaries: {},
  };
}
