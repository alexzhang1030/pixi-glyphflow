const EXPLORATORY_SUFFIX = "-exploratory";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export interface BrowserArtifactName {
  readonly version: string;
  readonly exploratory: boolean;
}

export interface ResolvedBrowserArtifact {
  readonly fileName: string;
  readonly version: string;
  readonly current: boolean;
}

export function browserArtifactFileName(
  workloadId: string,
  version: string,
  exploratory = false,
): string {
  return `browser-${workloadId}-${version}${exploratory ? EXPLORATORY_SUFFIX : ""}.json`;
}

export function parseBrowserArtifactName(
  fileName: string,
  workloadId: string,
): BrowserArtifactName | undefined {
  const prefix = `browser-${workloadId}-`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".json")) return undefined;
  const rest = fileName.slice(prefix.length, -".json".length);
  const exploratory = rest.endsWith(EXPLORATORY_SUFFIX);
  const version = exploratory ? rest.slice(0, -EXPLORATORY_SUFFIX.length) : rest;
  if (SEMVER.exec(version) === null) return undefined;

  return { version, exploratory };
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
  options: { requireCurrent?: boolean } = {},
): ResolvedBrowserArtifact | undefined {
  let latest: ResolvedBrowserArtifact | undefined;
  for (const fileName of fileNames) {
    const parsed = parseBrowserArtifactName(fileName, workloadId);
    if (parsed === undefined || parsed.exploratory) continue;
    if (compareSemver(parsed.version, packageVersion) > 0) continue;
    const resolved: ResolvedBrowserArtifact = {
      fileName,
      version: parsed.version,
      current: parsed.version === packageVersion,
    };
    if (resolved.current) return resolved;
    if (latest === undefined || compareSemver(resolved.version, latest.version) > 0) {
      latest = resolved;
    }
  }

  return options.requireCurrent === true ? undefined : latest;
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
