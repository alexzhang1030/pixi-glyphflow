import { FontRegistry } from "../FontRegistry";
import type { HarfBuzzShapeInput } from "../shaping/types";
import type {
  BitmapLayoutInput,
  LayoutEngineOptions,
  LayoutEngineStats,
  LayoutResult,
  PositionedRun,
  PositionedRunShaper,
  TextDirection,
  TextLayoutInput,
} from "./types";

export class LayoutEngine {
  readonly #registry: FontRegistry;
  readonly #bitmap: NonNullable<LayoutEngineOptions["bitmapAdapter"]>;
  readonly #harfbuzz: PositionedRunShaper;
  readonly #ownsHarfBuzz: boolean;
  readonly #shapeCache = new Map<string, LayoutResult>();
  readonly #familyCache = new Map<string | readonly string[], readonly string[]>();
  #familyCacheRevision = -1;
  #layouts = 0;
  #bitmapLayouts = 0;
  #harfbuzzLayouts = 0;
  #destroyed = false;

  constructor(registry: FontRegistry, options: LayoutEngineOptions = {}) {
    this.#registry = registry;
    this.#bitmap = options.bitmapAdapter ?? new LazyBitmapLayoutAdapter();
    this.#harfbuzz = options.harfbuzzShaper ?? new LazyHarfBuzzWorkerShaper(registry);
    this.#ownsHarfBuzz = options.harfbuzzShaper === undefined;
  }

  layout(labelId: number, sourceRevision: number, input: TextLayoutInput): LayoutResult {
    this.#assertActive();
    assertIdentity("labelId", labelId);
    assertIdentity("sourceRevision", sourceRevision);
    assertInput(input);
    this.#layouts += 1;
    return this.#layoutFrom({
      labelId,
      sourceRevision,
      input,
      direction: input.direction ?? detectDirection(input.text),
      families: this.#resolveFamilies(input.style.fontFamily),
      startIndex: 0,
      missingRun: undefined,
    });
  }

  #layoutFrom(walk: LayoutWalk): LayoutResult {
    const { input, direction, families } = walk;
    for (let index = walk.startIndex; index < families.length; index += 1) {
      const family = families[index];
      if (family === undefined) continue;
      const registered = this.#registry.get(family);
      if (registered?.kind === "binary") {
        const shaped = this.#shape(walk.labelId, walk.sourceRevision, {
          family,
          text: input.text,
          fontSize: resolveFontSize(input.style.fontSize),
          fontRevision: registered.revision,
          direction,
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.script === undefined ? {} : { script: input.script }),
          ...(input.features === undefined ? {} : { features: input.features }),
          ...(input.variations === undefined ? {} : { variations: input.variations }),
        });
        if (isPromise(shaped)) {
          return shaped.then((run) => {
            if (hasCompleteGlyphCoverage(run)) return applyWritingMode(run, input);
            return this.#layoutFrom({
              ...walk,
              startIndex: index + 1,
              missingRun: walk.missingRun ?? run,
            });
          });
        }
        if (hasCompleteGlyphCoverage(shaped)) return applyWritingMode(shaped, input);
        walk.missingRun ??= shaped;
        continue;
      }

      const bitmapFamilies = families
        .slice(index)
        .filter((candidate) => this.#registry.get(candidate)?.kind !== "binary");
      const primary = bitmapFamilies[0] ?? family;
      const primaryFont = this.#registry.get(primary);
      this.#bitmapLayouts += 1;
      const laidOut = this.#bitmap.layout({
        text: input.text,
        style: {
          ...input.style,
          fontFamily: bitmapFamilies.length === 1 ? primary : bitmapFamilies,
        },
        fontRevision: primaryFont?.revision ?? 0,
        cacheRevision: this.#registry.stats.revision,
        direction,
        trimEnd: input.trimEnd ?? true,
        ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
        ...(input.ellipsis === undefined ? {} : { ellipsis: input.ellipsis }),
      });
      if (isPromise(laidOut)) return laidOut.then((run) => applyWritingMode(run, input));
      return applyWritingMode(laidOut, input);
    }

    if (walk.missingRun !== undefined) return applyWritingMode(walk.missingRun, input);
    throw new Error("Font fallback resolution produced no layout candidate");
  }

  get stats(): Readonly<LayoutEngineStats> {
    return Object.freeze({
      layouts: this.#layouts,
      bitmapLayouts: this.#bitmapLayouts,
      harfbuzzLayouts: this.#harfbuzzLayouts,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    if (this.#ownsHarfBuzz) {
      this.#harfbuzz.destroy?.();
    }
    this.#shapeCache.clear();
    this.#destroyed = true;
  }

  #shape(labelId: number, sourceRevision: number, input: HarfBuzzShapeInput): LayoutResult {
    const key = shapeCacheKey(input);
    const cached = this.#shapeCache.get(key);
    if (cached !== undefined) {
      this.#shapeCache.delete(key);
      this.#shapeCache.set(key, cached);
      return cached;
    }

    this.#harfbuzzLayouts += 1;
    const pending = this.#harfbuzz.shape(labelId, sourceRevision, input);
    this.#shapeCache.set(key, pending);
    void pending.then(
      (run) => {
        if (this.#shapeCache.get(key) === pending) {
          this.#shapeCache.delete(key);
          this.#shapeCache.set(key, run);
        }
      },
      () => {
        if (this.#shapeCache.get(key) === pending) this.#shapeCache.delete(key);
      },
    );
    while (this.#shapeCache.size > 1_000) {
      const oldest = this.#shapeCache.keys().next().value;
      if (oldest === undefined) break;
      this.#shapeCache.delete(oldest);
    }
    return pending;
  }

  /** Interned styles keep stable references, so identity keys hit for repeated stacks. */
  #resolveFamilies(value: string | string[] | undefined): readonly string[] {
    const revision = this.#registry.stats.revision;
    if (revision !== this.#familyCacheRevision) {
      this.#familyCache.clear();
      this.#familyCacheRevision = revision;
    }
    const key = value ?? "Arial";
    const cached = this.#familyCache.get(key);
    if (cached !== undefined) return cached;
    const requested = Array.isArray(value) ? value : [value ?? "Arial"];
    const resolved: string[] = [];
    const seen = new Set<string>();
    const active = new Set<string>();
    const append = (name: string): void => {
      if (active.has(name)) return;
      const fallback = this.#registry.getFallback(name);
      if (fallback !== undefined) {
        active.add(name);
        for (const family of fallback) append(family);
        active.delete(name);
        return;
      }
      if (seen.has(name)) return;
      seen.add(name);
      resolved.push(name);
    };
    for (const name of requested) {
      append(name);
    }

    const families = Object.freeze(resolved.length > 0 ? resolved : [requested[0] ?? "Arial"]);
    if (this.#familyCache.size >= 256) this.#familyCache.clear();
    this.#familyCache.set(key, families);
    return families;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("LayoutEngine has been destroyed");
    }
  }
}

class LazyBitmapLayoutAdapter {
  #adapter: { layout(input: BitmapLayoutInput): Readonly<PositionedRun> } | undefined;
  #pending: Promise<{ layout(input: BitmapLayoutInput): Readonly<PositionedRun> }> | undefined;

  layout(input: BitmapLayoutInput): LayoutResult {
    if (this.#adapter !== undefined) return this.#adapter.layout(input);
    return this.#get().then((adapter) => adapter.layout(input));
  }

  #get(): Promise<{ layout(input: BitmapLayoutInput): Readonly<PositionedRun> }> {
    if (this.#adapter !== undefined) return Promise.resolve(this.#adapter);
    const current = this.#pending;
    if (current !== undefined) return current;
    const pending = import("../pixi/compat/bitmapLayout").then(({ BitmapLayoutAdapter }) => {
      const adapter = new BitmapLayoutAdapter();
      this.#adapter = adapter;
      return adapter;
    });
    this.#pending = pending;
    void pending.catch(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });

    return pending;
  }
}

class LazyHarfBuzzWorkerShaper implements PositionedRunShaper {
  readonly #registry: FontRegistry;
  #pending: Promise<PositionedRunShaper> | undefined;

  constructor(registry: FontRegistry) {
    this.#registry = registry;
  }

  async shape(
    labelId: number,
    sourceRevision: number,
    input: HarfBuzzShapeInput,
  ): Promise<Readonly<PositionedRun>> {
    const shaper = await this.#get();
    return shaper.shape(labelId, sourceRevision, input);
  }

  destroy(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      void pending.then(
        (shaper) => shaper.destroy?.(),
        () => undefined,
      );
    }
  }

  #get(): Promise<PositionedRunShaper> {
    const current = this.#pending;
    if (current !== undefined) return current;
    const pending = import("../shaping/HarfBuzzWorkerShaper").then(
      ({ HarfBuzzWorkerShaper }) => new HarfBuzzWorkerShaper(this.#registry),
    );
    this.#pending = pending;
    void pending.catch(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });

    return pending;
  }
}

interface LayoutWalk {
  readonly labelId: number;
  readonly sourceRevision: number;
  readonly input: TextLayoutInput;
  readonly direction: TextDirection;
  readonly families: readonly string[];
  readonly startIndex: number;
  missingRun: Readonly<PositionedRun> | undefined;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function hasCompleteGlyphCoverage(run: Readonly<PositionedRun>): boolean {
  return run.glyphCount === 0 || !run.glyphIds.includes(0);
}

function shapeCacheKey(input: HarfBuzzShapeInput): string {
  const variations =
    input.variations === undefined
      ? ""
      : Object.entries(input.variations)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([axis, value]) => `${axis}=${String(value)}`)
          .join(",");
  return [
    input.family,
    input.fontRevision ?? 0,
    input.fontSize,
    input.direction ?? "",
    input.language ?? "",
    input.script ?? "",
    input.features?.join(",") ?? "",
    variations,
    input.text,
  ].join("\u0000");
}

function assertIdentity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertInput(input: TextLayoutInput): void {
  if (typeof input.text !== "string") {
    throw new TypeError("Layout text must be a string");
  }
  if (typeof input.style !== "object" || input.style === null) {
    throw new TypeError("Layout style must be an object");
  }
  if (
    input.maxLines !== undefined &&
    (!Number.isSafeInteger(input.maxLines) || input.maxLines <= 0)
  ) {
    throw new TypeError("maxLines must be a positive safe integer");
  }
  if (input.ellipsis !== undefined && typeof input.ellipsis !== "string") {
    throw new TypeError("ellipsis must be a string");
  }
  if (
    input.writingMode !== undefined &&
    input.writingMode !== "horizontal-tb" &&
    input.writingMode !== "vertical-rl"
  ) {
    throw new TypeError("writingMode must be horizontal-tb or vertical-rl");
  }
}

function applyWritingMode(
  run: Readonly<PositionedRun>,
  input: Readonly<TextLayoutInput>,
): Readonly<PositionedRun> {
  if (input.writingMode === undefined || input.writingMode === "horizontal-tb") return run;
  if (run.glyphCount === 0) {
    return Object.freeze({
      ...run,
      bounds: Object.freeze({ x: 0, y: 0, width: 0, height: 0 }),
    });
  }

  let lineCount = 0;
  for (let index = 0; index < run.glyphCount; index += 1) {
    lineCount = Math.max(lineCount, (run.lineIndices[index] ?? 0) + 1);
  }
  const lineAdvance = resolveLineAdvance(input, run, lineCount);
  const cursors = new Float32Array(lineCount);
  const x = new Float32Array(run.glyphCount);
  const y = new Float32Array(run.glyphCount);
  const xAdvance = new Float32Array(run.glyphCount);
  const yAdvance = new Float32Array(run.glyphCount);
  const cellStarts = new Float32Array(lineCount);
  const lastClusters = Array.from<number | undefined>({ length: lineCount });
  const inlineAdvance = resolveInlineAdvance(input);
  let height = 0;

  for (let index = 0; index < run.glyphCount; index += 1) {
    const line = run.lineIndices[index] ?? 0;
    const cluster = run.clusters[index] ?? 0;
    const continuesCluster = lastClusters[line] === cluster;
    const cellStart = continuesCluster ? (cellStarts[line] ?? 0) : (cursors[line] ?? 0);
    x[index] = (lineCount - line - 1) * lineAdvance;
    y[index] = cellStart;
    if (!continuesCluster) {
      cellStarts[line] = cellStart;
      lastClusters[line] = cluster;
      yAdvance[index] = inlineAdvance;
      cursors[line] = cellStart + inlineAdvance;
    }
    height = Math.max(height, cursors[line] ?? 0);
  }

  return Object.freeze({
    ...run,
    x,
    y,
    xAdvance,
    yAdvance,
    bounds: Object.freeze({ x: 0, y: 0, width: lineCount * lineAdvance, height }),
  });
}

function resolveLineAdvance(
  input: Readonly<TextLayoutInput>,
  run: Readonly<PositionedRun>,
  lineCount: number,
): number {
  const lineHeight = input.style.lineHeight;
  if (typeof lineHeight === "number" && Number.isFinite(lineHeight) && lineHeight > 0) {
    return lineHeight;
  }
  if (run.bounds.height > 0 && lineCount > 0) return run.bounds.height / lineCount;

  return resolveFontSize(input.style.fontSize);
}

function resolveInlineAdvance(input: Readonly<TextLayoutInput>): number {
  const fontSize = resolveFontSize(input.style.fontSize);
  const letterSpacing = input.style.letterSpacing;
  const spacing =
    typeof letterSpacing === "number" && Number.isFinite(letterSpacing) ? letterSpacing : 0;
  const advance = fontSize + spacing;

  return advance > 0 ? advance : fontSize;
}

function resolveFontSize(value: number | string | undefined): number {
  const resolved = typeof value === "number" ? value : Number.parseFloat(value ?? "26");
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError("fontSize must resolve to a positive finite number");
  }

  return resolved;
}

function detectDirection(text: string): TextDirection {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
      (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
      (codePoint >= 0xfe70 && codePoint <= 0xfeff)
    ) {
      return "rtl";
    }
    if (
      (codePoint >= 0x0041 && codePoint <= 0x005a) ||
      (codePoint >= 0x0061 && codePoint <= 0x007a) ||
      (codePoint >= 0x00c0 && codePoint <= 0x02af)
    ) {
      return "ltr";
    }
  }

  return "ltr";
}
