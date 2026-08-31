import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface PackageMetadata {
  readonly version: string;
  readonly devDependencies: Readonly<Record<string, string>>;
}

const projectRoot = resolve(import.meta.dir, "..");
const metadata = (await Bun.file(join(projectRoot, "package.json")).json()) as PackageMetadata;
const fixtureRoot = await mkdtemp(join(tmpdir(), "pixi-glyphflow-smoke-"));
const consumerRoot = join(fixtureRoot, "consumer");
const tarballName = `pixi-glyphflow-${metadata.version}.tgz`;

try {
  await run(["npm", "pack", "--ignore-scripts", "--pack-destination", fixtureRoot], projectRoot);

  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "pixi-glyphflow-consumer-smoke",
        private: true,
        type: "module",
        dependencies: {
          "pixi-glyphflow": `file:../${tarballName}`,
          "pixi.js": metadata.devDependencies["pixi.js"],
        },
      },
      undefined,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerRoot, "smoke.ts"),
    `import { TextLayer } from "pixi-glyphflow";

const layer = new TextLayer();
const id = layer.create({ text: "package smoke", x: 12, y: 24 });
layer.updateLabel(id, { text: "package smoke passed" });
layer.updateTransforms(new Float64Array([id]), new Float32Array([32, 48]), new Float32Array([0.5]));
const revision = await layer.commit();
const snapshot = layer.get(id);

if (Number(revision) !== 1 || snapshot?.text !== "package smoke passed" ||
    snapshot.x !== 32 || snapshot.y !== 48 || snapshot.rotation !== 0.5) {
  throw new Error("Packed package smoke test failed");
}

layer.destroy();
`,
  );

  await run(["bun", "install"], consumerRoot);
  await run(["bun", "smoke.ts"], consumerRoot);
  await run(
    [
      join(projectRoot, "node_modules", ".bin", "tsc"),
      "--noEmit",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--strict",
      "--skipLibCheck",
      "smoke.ts",
    ],
    consumerRoot,
  );

  console.log(`Packed runtime and TypeScript consumer smoke passed for ${tarballName}`);
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with code ${String(exitCode)}`);
  }
}
