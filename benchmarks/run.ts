type BenchmarkWorkloadDefinition = import("./workloads").BenchmarkWorkloadDefinition;
type BrowserBenchmarkArtifactPayload = import("./schema").BrowserBenchmarkArtifactPayload;
type BrowserBenchmarkArtifactRole = import("./schema").BrowserBenchmarkArtifactRole;
type BrowserBenchmarkFixture = import("./schema").BrowserBenchmarkFixture;
type BrowserBenchmarkHarnessManifestEntry = import("./schema").BrowserBenchmarkHarnessManifestEntry;
type BrowserBenchmarkPageState = import("./schema").BrowserBenchmarkPageState;
type BrowserBenchmarkSample = import("./schema").BrowserBenchmarkSample;
type BrowserBenchmarkWorkload = import("./schema").BrowserBenchmarkWorkload;
type BrowserGpuAdapterIdentity = import("./schema").BrowserGpuAdapterIdentity;

const FROZEN_ROOT_ENV = "PIXI_GLYPHFLOW_BENCHMARK_FROZEN_HARNESS_ROOT";
const HARNESS_MANIFEST_ENV = "PIXI_GLYPHFLOW_BENCHMARK_HARNESS_MANIFEST";
const PROJECT_ROOT_ENV = "PIXI_GLYPHFLOW_BENCHMARK_PROJECT_ROOT";
const BOOTSTRAP_HARNESS_PATHS: readonly string[] = Object.freeze([
  "benchmarks/artifacts.ts",
  "benchmarks/budgets.ts",
  "benchmarks/gpu-scene-budget.ts",
  "benchmarks/gpu-scene-heterogeneous-budget.ts",
  "benchmarks/gpu-scene-resident-budget.ts",
  "benchmarks/gpu-scene-resident-repeatability.ts",
  "benchmarks/gpu-scene-resident-truth.ts",
  "benchmarks/harness-launcher.ts",
  "benchmarks/index.ts",
  "benchmarks/label-collision-budget.ts",
  "benchmarks/label-collision-repeatability.ts",
  "benchmarks/label-collision.ts",
  "benchmarks/run.ts",
  "benchmarks/runtime.ts",
  "benchmarks/schema.ts",
  "benchmarks/workloads.ts",
  "bun.lock",
  "package.json",
]);

const frozenRootValue = process.env[FROZEN_ROOT_ENV];
if (frozenRootValue === undefined) {
  throw new Error("Browser benchmark runner requires a frozen harness launch");
}
await runFrozenBenchmark(frozenRootValue);

async function runFrozenBenchmark(frozenRootValue: string): Promise<void> {
  const harnessManifest = readBootstrapHarnessManifest(process.env[HARNESS_MANIFEST_ENV]);
  if (!(await verifyBootstrapHarnessManifest(frozenRootValue, harnessManifest))) {
    throw new Error("Frozen browser benchmark harness does not match its launch manifest");
  }

  const [
    { mkdir, mkdtemp, realpath, rm },
    { tmpdir },
    { dirname, resolve },
    { chromium },
    { preview },
    artifacts,
    gpuSceneHeterogeneousBudget,
    gpuSceneBudget,
    gpuSceneResidentBudget,
    labelCollisionBudget,
    runtime,
    schema,
    workloads,
  ] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
    import("@playwright/test"),
    import("vite"),
    import("./artifacts"),
    import("./gpu-scene-heterogeneous-budget"),
    import("./gpu-scene-budget"),
    import("./gpu-scene-resident-budget"),
    import("./label-collision-budget"),
    import("./runtime"),
    import("./schema"),
    import("./workloads"),
  ]);
  const frozenRoot = await realpath(resolve(frozenRootValue));
  if (frozenRoot !== (await realpath(resolve(import.meta.dir, "..")))) {
    throw new Error("Frozen browser benchmark root does not match the executing runner");
  }
  if (!(await artifacts.verifyBrowserBenchmarkHarnessManifest(frozenRoot, harnessManifest))) {
    throw new Error("Frozen browser benchmark harness changed before execution");
  }
  const projectRootValue = process.env[PROJECT_ROOT_ENV];
  if (projectRootValue === undefined) {
    throw new Error("Browser benchmark project root is unavailable");
  }
  const projectRoot = resolve(projectRootValue);
  const packageMetadata = (await Bun.file(resolve(frozenRoot, "package.json")).json()) as {
    readonly version: string;
  };
  const options = readOptions(workloads.getBenchmarkWorkload, workloads.isBenchmarkWorkload);
  const progressEnabled = Bun.argv.includes("--progress");
  const progress = (stage: string): void => {
    if (progressEnabled) console.error(`[benchmark] ${stage}`);
  };
  progress("options-ready");
  const runId = artifacts.createBrowserBenchmarkRunId();
  progress("harness-manifest-ready");
  const buildDirectory = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-benchmark-build-"));
  try {
    const buildManifest = await artifacts.createBrowserBenchmarkFrozenBuild(
      projectRoot,
      buildDirectory,
    );
    progress("frozen-build-ready");
    const defaults = workloads.getBenchmarkWorkload(options.workload);
    const exploratory =
      options.labels !== defaults.labelCount ||
      options.mutations !== defaults.mutationCount ||
      options.warmupFrames !== defaults.warmupFrames ||
      options.sampleFrames !== defaults.sampleFrames;
    const fixtures: readonly BrowserBenchmarkFixture[] =
      options.fixture === undefined
        ? options.workload === "static-hud"
          ? ["text", "bitmap-text", "glyphflow", "html-text"]
          : ["glyphflow"]
        : [options.fixture];
    const server = await preview({
      root: projectRoot,
      configFile: false,
      logLevel: "error",
      build: { outDir: buildDirectory },
      preview: {
        host: "127.0.0.1",
        port: 40_000 + (process.pid % 20_000),
        strictPort: false,
      },
    });
    progress("frozen-preview-listening");
    const samples: BrowserBenchmarkSample[] = [];
    const failures: Array<{
      readonly fixture: BrowserBenchmarkFixture;
      readonly repeatIndex?: number;
      readonly status: "capacity-limit";
      readonly detail: string;
    }> = [];

    try {
      const address = server.httpServer?.address();
      if (address === null || address === undefined || typeof address === "string") {
        throw new Error("Vite benchmark server address is unavailable");
      }
      const repetitionCount = workloads.browserBenchmarkRepetitions(options.workload);
      for (const fixture of fixtures) {
        for (let repeatIndex = 1; repeatIndex <= repetitionCount; repeatIndex += 1) {
          progress(`browser-launch:${fixture}:repeat-${String(repeatIndex)}`);
          const browser = await chromium.launch({ channel: "chrome", headless: true });
          try {
            progress(`browser-ready:${fixture}:repeat-${String(repeatIndex)}`);
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("console", (message) => {
              if (message.type() === "error") errors.push(message.text());
            });
            page.on("pageerror", (error) => errors.push(error.message));
            const parameters = new URLSearchParams({
              fixture,
              workload: options.workload,
              renderer: options.renderer,
              labels: String(options.labels),
              mutations: String(options.mutations),
              warmup: String(options.warmupFrames),
              frames: String(options.sampleFrames),
            });
            await page.goto(
              `http://127.0.0.1:${String(address.port)}/playground/benchmark.html?${parameters.toString()}`,
            );
            progress(`page-loaded:${fixture}:repeat-${String(repeatIndex)}`);
            await withTimeout(
              page.waitForFunction(
                () =>
                  (window as typeof window & { __glyphflowBenchmark?: BrowserBenchmarkPageState })
                    .__glyphflowBenchmark?.done === true,
                undefined,
                { polling: runtime.BENCHMARK_STATUS_POLLING_MS, timeout: options.timeoutMs },
              ),
              options.timeoutMs,
              `${fixture} repeat ${String(repeatIndex)} benchmark exceeded ${String(options.timeoutMs)} ms`,
            );
            progress(`workload-complete:${fixture}:repeat-${String(repeatIndex)}`);
            const state = await page.evaluate(
              () =>
                (window as typeof window & { __glyphflowBenchmark: BrowserBenchmarkPageState })
                  .__glyphflowBenchmark,
            );
            if (state.error !== undefined || state.result === undefined || errors.length > 0) {
              throw new Error(
                [
                  state.error,
                  state.result === undefined ? "Browser benchmark returned no result" : undefined,
                  ...errors,
                ]
                  .filter((line): line is string => line !== undefined && line.length > 0)
                  .join("\n"),
              );
            }
            samples.push(Object.freeze({ ...state.result, repeatIndex }));
          } catch (error: unknown) {
            failures.push({
              fixture,
              repeatIndex,
              status: "capacity-limit",
              detail: error instanceof Error ? error.message : String(error),
            });
          } finally {
            await browser.close();
          }
        }
      }
    } finally {
      await server.close();
    }
    const postRunBuildManifest = await artifacts.readBrowserBenchmarkBuildManifest(buildDirectory);
    if (
      artifacts.browserBenchmarkBuildFingerprintSha256(postRunBuildManifest) !==
      artifacts.browserBenchmarkBuildFingerprintSha256(buildManifest)
    ) {
      throw new Error("Frozen browser benchmark build changed during execution");
    }

    const budget = !exploratory
      ? options.workload === "gpu-scene-heterogeneous-64"
        ? gpuSceneHeterogeneousBudget.evaluateGpuSceneHeterogeneousBudget(samples)
        : options.workload === "gpu-scene-resident"
          ? gpuSceneResidentBudget.evaluateGpuSceneResidentBudget(samples)
          : options.workload === "gpu-scene-v2"
            ? gpuSceneBudget.evaluateGpuSceneV2Budget(samples, options.renderer)
            : options.workload === "label-collision"
              ? labelCollisionBudget.evaluateLabelCollisionBudget(samples, options.renderer)
              : undefined
      : undefined;
    const gpuAdapter = resolveGpuAdapterIdentity(samples, options.renderer);
    const artifactPayload: BrowserBenchmarkArtifactPayload = {
      schemaVersion: schema.BENCHMARK_SCHEMA_VERSION,
      benchmark: "browser-workloads",
      packageVersion: packageMetadata.version,
      capturedAt: new Date().toISOString(),
      runtime: runtime.benchmarkRuntime(),
      workload: options.workload,
      renderer: options.renderer,
      artifactRole: options.artifactRole,
      status: failures.length === 0 ? "complete" : "capacity-limit",
      ...(exploratory ? { exploratory: true } : {}),
      ...(gpuAdapter === undefined ? {} : { gpuAdapter }),
      samples,
      failures,
      ...(budget === undefined ? {} : { budget }),
      summaries: Object.fromEntries(
        samples.map((sample) => [
          sampleKey(sample),
          {
            setup: schema.summarize([sample.timings.setupMs], "ms"),
            frame: schema.summarize(sample.timings.frameMs, "ms"),
          },
        ]),
      ),
    };
    const artifact = artifacts.createBrowserBenchmarkArtifact(artifactPayload, {
      runId,
      buildManifest,
      harnessManifest,
    });
    if (!(await artifacts.verifyBrowserBenchmarkHarnessManifest(frozenRoot, harnessManifest))) {
      throw new Error("Frozen browser benchmark harness changed during execution");
    }
    const outputPath =
      options.output === undefined
        ? resolve(
            projectRoot,
            `benchmarks/results/${artifacts.browserBenchmarkArtifactFileName({
              workload: options.workload,
              renderer: options.renderer,
              artifactRole: options.artifactRole,
              packageVersion: packageMetadata.version,
              exploratory,
            })}`,
          )
        : resolve(projectRoot, options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, artifacts.serializeBrowserBenchmarkArtifact(artifact));
    console.log(
      JSON.stringify({
        outputPath,
        runId: artifact.provenance.runId,
        buildFingerprintSha256: artifact.provenance.buildFingerprintSha256,
        harnessFingerprintSha256: artifact.provenance.harnessFingerprintSha256,
        evidenceSha256: artifact.provenance.evidenceSha256,
        workload: options.workload,
        renderer: options.renderer,
        artifactRole: options.artifactRole,
        fixtures: samples.map((sample) => sample.configuration.fixture),
        repetitions: samples.map((sample) => sample.repeatIndex ?? 1),
        failures,
        frameP95Ms: Object.fromEntries(
          samples.map((sample) => [
            sampleKey(sample),
            schema.summarize(sample.timings.frameMs, "ms").p95,
          ]),
        ),
        ...(options.workload === "gpu-scene-v2" ||
        options.workload === "gpu-scene-resident" ||
        options.workload === "gpu-scene-heterogeneous-64"
          ? {
              phaseP95Ms: Object.fromEntries(
                samples.map((sample) => [
                  sampleKey(sample),
                  {
                    camera: sample.timings.phases
                      ? schema.summarize(sample.timings.phases.camera.frameMs, "ms").p95
                      : undefined,
                    positionMutation: sample.timings.phases
                      ? schema.summarize(sample.timings.phases.positionMutation.frameMs, "ms").p95
                      : undefined,
                  },
                ]),
              ),
            }
          : {}),
        ...(artifact.budget === undefined ? {} : { budget: artifact.budget }),
      }),
    );
    if (failures.length > 0 || artifact.budget?.passed === false) process.exitCode = 1;
  } finally {
    await rm(buildDirectory, { force: true, recursive: true });
  }
}

function sampleKey(sample: Readonly<BrowserBenchmarkSample>): string {
  return sample.repeatIndex === undefined
    ? sample.configuration.fixture
    : `${sample.configuration.fixture}-repeat-${String(sample.repeatIndex)}`;
}

function resolveGpuAdapterIdentity(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
  renderer: "webgl" | "webgpu",
): Readonly<BrowserGpuAdapterIdentity> | undefined {
  const first = samples[0]?.gpuAdapter;
  if (renderer === "webgl" || samples.length === 0) return undefined;
  if (first === undefined) {
    throw new Error("WebGPU benchmark sample omitted its adapter identity");
  }
  const identity = JSON.stringify(first);
  if (samples.some((sample) => JSON.stringify(sample.gpuAdapter) !== identity)) {
    throw new Error("WebGPU benchmark adapter identity changed across samples");
  }

  return first;
}

interface RunOptions {
  readonly workload: BrowserBenchmarkWorkload;
  readonly fixture: BrowserBenchmarkFixture | undefined;
  readonly renderer: "webgl" | "webgpu";
  readonly artifactRole: BrowserBenchmarkArtifactRole;
  readonly labels: number;
  readonly mutations: number;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly timeoutMs: number;
  readonly output: string | undefined;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function readOptions(
  getBenchmarkWorkload: (
    workload: BrowserBenchmarkWorkload,
  ) => Readonly<BenchmarkWorkloadDefinition>,
  isBenchmarkWorkload: (value: string) => value is BrowserBenchmarkWorkload,
): Readonly<RunOptions> {
  const workload = (readArgument("--workload") ?? "static-hud") as BrowserBenchmarkWorkload;
  const fixture = readArgument("--fixture") as BrowserBenchmarkFixture | undefined;
  const renderer = readRenderer();
  const artifactRole = readArtifactRole();
  if (
    fixture !== undefined &&
    !["text", "bitmap-text", "html-text", "glyphflow"].includes(fixture)
  ) {
    throw new TypeError(`Unknown benchmark fixture: ${fixture}`);
  }
  if (!isBenchmarkWorkload(workload)) {
    throw new TypeError(`Unknown benchmark workload: ${workload}`);
  }
  if (
    (workload === "gpu-scene-heterogeneous-64" || workload === "gpu-scene-resident") &&
    renderer !== "webgpu"
  ) {
    throw new TypeError(`${workload} requires "--renderer webgpu"`);
  }
  const defaults = getBenchmarkWorkload(workload);

  return Object.freeze({
    workload,
    fixture,
    renderer,
    artifactRole,
    labels: readPositiveInteger("--labels", defaults.labelCount),
    mutations: readPositiveInteger("--mutations", defaults.mutationCount),
    warmupFrames: readNonNegativeInteger("--warmup", defaults.warmupFrames),
    sampleFrames: readPositiveInteger("--frames", defaults.sampleFrames),
    timeoutMs: readPositiveInteger("--timeout", defaults.timeoutMs),
    output: readArgument("--output"),
  });
}

function readArtifactRole(): BrowserBenchmarkArtifactRole {
  const value = readArgument("--artifact-role") ?? "candidate";
  if (value === "baseline" || value === "candidate") return value;
  throw new TypeError('--artifact-role must be "baseline" or "candidate"');
}

function readRenderer(): "webgl" | "webgpu" {
  const value = readArgument("--renderer") ?? "webgl";
  if (value === "webgl" || value === "webgpu") return value;
  throw new TypeError('--renderer must be "webgl" or "webgpu"');
}

function readArgument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be followed by a positive safe integer`);
  }

  return value;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be followed by a non-negative safe integer`);
  }

  return value;
}

function readBootstrapHarnessManifest(
  serialized: string | undefined,
): readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] {
  if (serialized === undefined) throw new Error("Browser benchmark launch manifest is unavailable");
  const parsed: unknown = JSON.parse(serialized);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== BOOTSTRAP_HARNESS_PATHS.length ||
    parsed.some(
      (entry, index) =>
        typeof entry !== "object" ||
        entry === null ||
        (entry as { path?: unknown }).path !== BOOTSTRAP_HARNESS_PATHS[index],
    )
  ) {
    throw new TypeError("Browser benchmark launch manifest is invalid");
  }

  return parsed as readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
}

async function verifyBootstrapHarnessManifest(
  frozenRoot: string,
  manifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[],
): Promise<boolean> {
  const [{ createHash }, { lstat, readFile }, { isAbsolute, resolve }] = await Promise.all([
    import("node:crypto"),
    import("node:fs/promises"),
    import("node:path"),
  ]);
  try {
    for (const entry of manifest) {
      if (
        typeof entry.path !== "string" ||
        entry.path.length === 0 ||
        isAbsolute(entry.path) ||
        entry.path
          .split("/")
          .some((segment) => segment === "" || segment === "." || segment === "..") ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
      ) {
        return false;
      }
      const path = resolve(frozenRoot, entry.path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const bytes = await readFile(path);
      if (
        bytes.byteLength !== entry.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
