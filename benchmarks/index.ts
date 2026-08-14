import { resolve } from "node:path";

import { BENCHMARK_WORKLOADS, isBenchmarkWorkload } from "./workloads";

const requestedWorkload = readArgument("--workload");
if (requestedWorkload !== undefined && !isBenchmarkWorkload(requestedWorkload)) {
  throw new TypeError(`Unknown benchmark workload: ${requestedWorkload}`);
}

if (requestedWorkload === undefined) {
  const forwarded = removeArgument(Bun.argv.slice(2), "--workload");
  for (const workload of BENCHMARK_WORKLOADS) {
    await runScript("run.ts", [...forwarded, "--workload", workload.id]);
  }
} else {
  await runScript("run.ts", Bun.argv.slice(2));
}

await runScript("report.ts", []);

async function runScript(file: string, arguments_: readonly string[]): Promise<void> {
  const process = Bun.spawn([Bun.argv[0] ?? "bun", resolve(import.meta.dir, file), ...arguments_], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${file} exited with code ${String(exitCode)}`);
}

function readArgument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

function removeArgument(arguments_: readonly string[], name: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === name) {
      index += 1;
      continue;
    }
    const argument = arguments_[index];
    if (argument !== undefined) output.push(argument);
  }

  return output;
}
