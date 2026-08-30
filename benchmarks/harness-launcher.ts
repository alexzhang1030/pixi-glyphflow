import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_BENCHMARK_FROZEN_ROOT_ENV = "PIXI_GLYPHFLOW_BENCHMARK_FROZEN_HARNESS_ROOT";
export const BROWSER_BENCHMARK_HARNESS_MANIFEST_ENV = "PIXI_GLYPHFLOW_BENCHMARK_HARNESS_MANIFEST";
export const BROWSER_BENCHMARK_PROJECT_ROOT_ENV = "PIXI_GLYPHFLOW_BENCHMARK_PROJECT_ROOT";

/** Exact Node-side runner, sampling, budget, and promotion-control closure. */
export const BROWSER_BENCHMARK_HARNESS_PATHS: readonly string[] = Object.freeze([
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

export interface FrozenBrowserBenchmarkHarnessEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

const loadedLauncherPath = fileURLToPath(import.meta.url);
const loadedLauncherRoot = await realpath(resolve(dirname(loadedLauncherPath), ".."));
const loadedLauncherSha256 = sha256(await readFile(loadedLauncherPath));
const launcherManifestPath = "benchmarks/harness-launcher.ts";

export async function freezeBrowserBenchmarkHarness(
  sourceRoot: string,
  frozenRoot: string,
  options: Readonly<{
    afterEntryCopied?: (path: string) => void | Promise<void>;
  }> = {},
): Promise<readonly Readonly<FrozenBrowserBenchmarkHarnessEntry>[]> {
  const source = resolve(sourceRoot);
  const destination = resolve(frozenRoot);
  const sourceIdentity = await realpath(source);
  if (sourceIdentity === loadedLauncherRoot) {
    await assertLoadedLauncherUnchanged();
  }
  if (source === destination || relative(source, destination) === "") {
    throw new TypeError("Frozen benchmark harness root must differ from its source root");
  }
  const destinationStat = await lstat(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new TypeError("Frozen benchmark harness root must be a direct directory");
  }
  if ((await readdir(destination)).length > 0) {
    throw new TypeError("Frozen benchmark harness root must be empty");
  }

  const entries: FrozenBrowserBenchmarkHarnessEntry[] = [];
  for (const path of BROWSER_BENCHMARK_HARNESS_PATHS) {
    const sourcePath = resolve(source, path);
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new TypeError(`Browser benchmark harness path must be a regular file: ${path}`);
    }
    const bytes = await readFile(sourcePath);
    const destinationPath = resolve(destination, path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, bytes);
    await options.afterEntryCopied?.(path);

    const [sourceReadback, frozenReadback] = await Promise.all([
      readFile(sourcePath),
      readFile(destinationPath),
    ]);
    const digest = sha256(bytes);
    if (
      sourceReadback.byteLength !== bytes.byteLength ||
      sha256(sourceReadback) !== digest ||
      frozenReadback.byteLength !== bytes.byteLength ||
      sha256(frozenReadback) !== digest
    ) {
      throw new Error(`Browser benchmark harness changed while freezing: ${path}`);
    }
    entries.push(Object.freeze({ path, bytes: bytes.byteLength, sha256: digest }));
  }

  if (sourceIdentity === loadedLauncherRoot) {
    await assertLoadedLauncherUnchanged();
    const frozenLauncherEntry = entries.find((entry) => entry.path === launcherManifestPath);
    if (frozenLauncherEntry?.sha256 !== loadedLauncherSha256) {
      throw new Error("Frozen browser benchmark launcher differs from the loaded launcher");
    }
  }

  return Object.freeze(entries);
}

export async function launchFrozenBrowserBenchmarkHarness(
  sourceRoot: string,
  arguments_: readonly string[],
): Promise<number> {
  const source = resolve(sourceRoot);
  const frozenRoot = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-benchmark-harness-"));
  try {
    const manifest = await freezeBrowserBenchmarkHarness(source, frozenRoot);
    await symlink(resolve(source, "node_modules"), resolve(frozenRoot, "node_modules"), "dir");
    const child = Bun.spawn(
      [Bun.argv[0] ?? process.execPath, resolve(frozenRoot, "benchmarks/run.ts"), ...arguments_],
      {
        cwd: frozenRoot,
        env: {
          ...process.env,
          [BROWSER_BENCHMARK_FROZEN_ROOT_ENV]: frozenRoot,
          [BROWSER_BENCHMARK_HARNESS_MANIFEST_ENV]: JSON.stringify(manifest),
          [BROWSER_BENCHMARK_PROJECT_ROOT_ENV]: source,
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    return await child.exited;
  } finally {
    await rm(frozenRoot, { force: true, recursive: true });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertLoadedLauncherUnchanged(): Promise<void> {
  const currentLauncherSha256 = sha256(await readFile(loadedLauncherPath));
  if (currentLauncherSha256 !== loadedLauncherSha256) {
    throw new Error("Browser benchmark launcher changed after module loading");
  }
}

if (import.meta.main) {
  const sourceRoot = resolve(import.meta.dir, "..");
  process.exitCode = await launchFrozenBrowserBenchmarkHarness(sourceRoot, Bun.argv.slice(2));
}
