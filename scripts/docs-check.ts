import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const documentationFiles = [
  "README.md",
  "docs/accessibility.md",
  "docs/api.md",
  "docs/architecture.md",
  "docs/fonts.md",
  "docs/getting-started.md",
  "docs/migration.md",
  "docs/performance.md",
] as const;
const requiredApiTerms = [
  "TextLayer",
  "FontRegistry",
  "createMany",
  "updateMany",
  "updatePositions",
  "updateTextPositions",
  "createGroup",
  "setGroupVisible",
  "TextGroupId",
  "vertical-rl",
  "showAll",
  "hideAll",
  "commit",
  "bindViewport",
  "ViewportBinding",
  "AccessibilityAdapter",
  "HarfBuzzWorkerShaper",
  "GlyphAtlas",
  "GlyphMesh",
  "uiSdfPrebuilt",
  "charsetSdfPrebuilt",
] as const;
const copiedFeatureName = `${"heat"}${"map"}`;
const forbiddenSourceTraces = [
  new RegExp(`pixi[-_]${copiedFeatureName}`, "iu"),
  new RegExp(`visual[-_]${copiedFeatureName}`, "iu"),
];
const failures: string[] = [];
const contents = new Map<string, string>();

for (const relativePath of documentationFiles) {
  const absolutePath = resolve(projectRoot, relativePath);
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    failures.push(`${relativePath}: missing documentation file`);
    continue;
  }
  const content = await file.text();
  contents.set(relativePath, content);
  const prose = content.replaceAll(/```[\s\S]*?```/gu, "");
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(prose)) {
    failures.push(`${relativePath}: project documentation must use English prose`);
  }
  for (const pattern of forbiddenSourceTraces) {
    if (pattern.test(content))
      failures.push(`${relativePath}: contains a copied-source identifier`);
  }
  await validateLinks(relativePath, content);
}

const api = contents.get("docs/api.md") ?? "";
for (const term of requiredApiTerms) {
  if (!api.includes(term)) failures.push(`docs/api.md: missing public API term ${term}`);
}

const readme = contents.get("README.md") ?? "";
for (const command of [
  "bun run check",
  "bun run benchmark:check",
  "bun run docs:check",
  "bun run playground:build",
]) {
  if (!readme.includes(command)) failures.push(`README.md: missing documented command ${command}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      files: documentationFiles.length,
      links: "valid",
      apiTerms: requiredApiTerms.length,
    }),
  );
}

async function validateLinks(relativePath: string, content: string): Promise<void> {
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (
      target === undefined ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const path = target.split("#", 1)[0];
    if (path === undefined || path.length === 0) continue;
    const absoluteTarget = resolve(projectRoot, dirname(relativePath), path);
    try {
      await stat(absoluteTarget);
    } catch {
      failures.push(`${relativePath}: broken local link ${target}`);
    }
  }
}
