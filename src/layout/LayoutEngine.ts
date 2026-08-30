import { encodeCacheKey } from "../cache/cacheKey";
import { FontRegistry } from "../FontRegistry";
import type { HarfBuzzShapeInput } from "../shaping/types";
import { canonicalizeVariations } from "../shaping/variationKey";
import {
  inheritPositionedRunLease,
  ownedPositionedRun,
  releasePositionedRun,
  retainPositionedRun,
} from "./PositionedRunLease";
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
    if (this.#destroyed) throw new Error("LayoutEngine has been destroyed");
    assertIdentity("labelId", labelId);
    assertIdentity("sourceRevision", sourceRevision);
    const variationCacheKey = assertInput(input);
    this.#layouts += 1;
    return this.#layoutFrom({
      labelId,
      sourceRevision,
      input,
      direction: input.direction ?? detectDirection(input.text),
      families: this.#resolveFamilies(input.style.fontFamily),
      variationCacheKey,
      startIndex: 0,
      missingRun: undefined,
    });
  }

  #layoutFrom(walk: LayoutWalk): LayoutResult {
    try {
      return this.#layoutFromUnchecked(walk);
    } catch (error) {
      return throwAfterPositionedRunCleanup(error, takeMissingRun(walk));
    }
  }

  #layoutFromUnchecked(walk: LayoutWalk): LayoutResult {
    const { input, direction, families } = walk;
    for (let index = walk.startIndex; index < families.length; index += 1) {
      const family = families[index];
      if (family === undefined) continue;
      const registered = this.#registry.get(family);
      if (registered?.kind === "binary") {
        const shaped = this.#shape(walk, {
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
          const missingRun = takeMissingRun(walk);
          return shaped.then(
            (run) => {
              if (hasCompleteGlyphCoverage(run)) {
                return completeLayoutRun(run, input, missingRun);
              }
              if (missingRun !== undefined) {
                try {
                  releasePositionedRuns(run);
                } catch (error) {
                  return throwAfterPositionedRunCleanup(error, missingRun);
                }
              }

              return this.#layoutFrom({
                ...walk,
                startIndex: index + 1,
                missingRun: missingRun ?? run,
              });
            },
            (error: unknown) => throwAfterPositionedRunCleanup(error, missingRun),
          );
        }
        if (hasCompleteGlyphCoverage(shaped)) {
          return completeLayoutRun(shaped, input, takeMissingRun(walk));
        }
        if (walk.missingRun === undefined) {
          walk.missingRun = shaped;
        } else {
          try {
            releasePositionedRuns(shaped);
          } catch (error) {
            return throwAfterPositionedRunCleanup(error, takeMissingRun(walk));
          }
        }
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
      if (isPromise(laidOut)) {
        const missingRun = takeMissingRun(walk);
        return laidOut.then(
          (run) => completeLayoutRun(run, input, missingRun),
          (error: unknown) => throwAfterPositionedRunCleanup(error, missingRun),
        );
      }
      return completeLayoutRun(laidOut, input, takeMissingRun(walk));
    }

    const missingRun = takeMissingRun(walk);
    if (missingRun !== undefined) return completeLayoutRun(missingRun, input, undefined);
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

  #shape(walk: LayoutWalk, input: HarfBuzzShapeInput): LayoutResult {
    const key = shapeCacheKey(input, walk.variationCacheKey);
    const cached = this.#shapeCache.get(key);
    if (cached !== undefined) {
      this.#shapeCache.delete(key);
      this.#shapeCache.set(key, cached);
      return isPromise(cached) ? cached.then((run) => retainPositionedRun(run)) : cached;
    }

    this.#harfbuzzLayouts += 1;
    const pending = this.#harfbuzz.shape(walk.labelId, walk.sourceRevision, input);
    this.#shapeCache.set(key, pending);
    void pending.then(
      (run) => {
        if (this.#shapeCache.get(key) === pending) {
          this.#shapeCache.delete(key);
          this.#shapeCache.set(key, ownedPositionedRun(run));
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
  readonly variationCacheKey: string;
  readonly startIndex: number;
  missingRun: Readonly<PositionedRun> | undefined;
}

function takeMissingRun(walk: LayoutWalk): Readonly<PositionedRun> | undefined {
  const run = walk.missingRun;
  walk.missingRun = undefined;
  return run;
}

function completeLayoutRun(
  run: Readonly<PositionedRun>,
  input: Readonly<TextLayoutInput>,
  discardedRun: Readonly<PositionedRun> | undefined,
): Readonly<PositionedRun> {
  let result: Readonly<PositionedRun>;
  try {
    result = applyWritingMode(run, input);
  } catch (error) {
    return throwAfterPositionedRunCleanup(error, discardedRun, run);
  }

  try {
    releasePositionedRuns(discardedRun);
  } catch (error) {
    return throwAfterPositionedRunCleanup(error, result);
  }
  return result;
}

function releasePositionedRuns(...runs: readonly (Readonly<PositionedRun> | undefined)[]): void {
  const seen = new Set<Readonly<PositionedRun>>();
  let firstError: unknown;
  let failed = false;
  for (const run of runs) {
    if (run === undefined || seen.has(run)) continue;
    seen.add(run);
    try {
      releasePositionedRun(run);
    } catch (error) {
      if (!failed) {
        firstError = error;
        failed = true;
      }
    }
  }
  if (failed) throw firstError;
}

function throwAfterPositionedRunCleanup(
  primaryError: unknown,
  ...runs: readonly (Readonly<PositionedRun> | undefined)[]
): never {
  try {
    releasePositionedRuns(...runs);
  } catch {
    // The primary operation defines the rejection while every cleanup still runs.
  }
  throw primaryError;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function hasCompleteGlyphCoverage(run: Readonly<PositionedRun>): boolean {
  return run.glyphCount === 0 || !run.glyphIds.includes(0);
}

function shapeCacheKey(input: HarfBuzzShapeInput, variationCacheKey: string): string {
  return encodeCacheKey([
    input.family,
    String(input.fontRevision ?? 0),
    String(input.fontSize),
    input.direction ?? "",
    input.language ?? "",
    input.script ?? "",
    ...(input.features ?? []),
    variationCacheKey,
    input.text,
  ]);
}

function assertIdentity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertInput(input: TextLayoutInput): string {
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
  const variationCacheKey = canonicalizeVariations(input.variations).cacheKey;
  if (
    input.writingMode !== undefined &&
    input.writingMode !== "horizontal-tb" &&
    input.writingMode !== "vertical-rl"
  ) {
    throw new TypeError("writingMode must be horizontal-tb or vertical-rl");
  }
  return variationCacheKey;
}

function applyWritingMode(
  run: Readonly<PositionedRun>,
  input: Readonly<TextLayoutInput>,
): Readonly<PositionedRun> {
  if (input.writingMode === undefined || input.writingMode === "horizontal-tb") return run;
  if (run.glyphCount === 0) {
    return inheritPositionedRunLease(run, {
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
  const fontSize = resolveFontSize(input.style.fontSize);
  const letterSpacing = input.style.letterSpacing;
  const spacing =
    typeof letterSpacing === "number" && Number.isFinite(letterSpacing) ? letterSpacing : 0;
  const advance = fontSize + spacing;
  const inlineAdvance = advance > 0 ? advance : fontSize;
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

  return inheritPositionedRunLease(run, {
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
