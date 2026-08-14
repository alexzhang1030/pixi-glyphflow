import type { RunBounds, TextDirection } from "../layout/types";

export interface TrustedGlyphRunInput {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontRevision: number;
  readonly atlasId: string;
  readonly direction?: TextDirection;
  readonly glyphIds: Readonly<Uint32Array>;
  readonly clusters: Readonly<Uint32Array>;
  readonly x: Readonly<Float32Array>;
  readonly y: Readonly<Float32Array>;
  readonly xAdvance: Readonly<Float32Array>;
  readonly yAdvance: Readonly<Float32Array>;
  readonly lineIndices: Readonly<Uint32Array>;
  readonly glyphKeys?: readonly string[];
  readonly bounds: Readonly<RunBounds>;
}

export interface TrustedGlyphRun {
  readonly source: "trusted";
  readonly sourceRevision: number;
  readonly text: string;
  readonly fontFamily: string;
  readonly fontRevision: number;
  readonly atlasId: string;
  readonly glyphCount: number;
  readonly direction: TextDirection;
  readonly glyphIds: Readonly<Uint32Array>;
  readonly clusters: Readonly<Uint32Array>;
  readonly x: Readonly<Float32Array>;
  readonly y: Readonly<Float32Array>;
  readonly xAdvance: Readonly<Float32Array>;
  readonly yAdvance: Readonly<Float32Array>;
  readonly lineIndices: Readonly<Uint32Array>;
  readonly glyphKeys?: readonly string[];
  readonly bounds: Readonly<RunBounds>;
}

const owners = new WeakMap<TrustedGlyphRun, object>();

export function createTrustedGlyphRun(
  owner: object,
  sourceRevision: number,
  input: TrustedGlyphRunInput,
): TrustedGlyphRun {
  assertInput(sourceRevision, input);
  const run: TrustedGlyphRun = Object.freeze({
    source: "trusted",
    sourceRevision,
    text: input.text,
    fontFamily: input.fontFamily,
    fontRevision: input.fontRevision,
    atlasId: input.atlasId,
    glyphCount: input.glyphIds.length,
    direction: input.direction ?? "ltr",
    glyphIds: input.glyphIds,
    clusters: input.clusters,
    x: input.x,
    y: input.y,
    xAdvance: input.xAdvance,
    yAdvance: input.yAdvance,
    lineIndices: input.lineIndices,
    ...(input.glyphKeys === undefined ? {} : { glyphKeys: input.glyphKeys }),
    bounds: Object.freeze({ ...input.bounds }),
  });
  owners.set(run, owner);

  return run;
}

export function assertTrustedGlyphRunOwner(owner: object, run: TrustedGlyphRun): void {
  if (owners.get(run) !== owner) {
    throw new TypeError("Trusted glyph run belongs to another TextLayer");
  }
}

function assertInput(sourceRevision: number, input: TrustedGlyphRunInput): void {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) {
    throw new TypeError("sourceRevision must be a positive safe integer");
  }
  if (typeof input.text !== "string") {
    throw new TypeError("Trusted glyph run text must be a string");
  }
  assertNonEmptyString("fontFamily", input.fontFamily);
  assertNonEmptyString("atlasId", input.atlasId);
  if (!Number.isSafeInteger(input.fontRevision) || input.fontRevision < 0) {
    throw new TypeError("fontRevision must be a non-negative safe integer");
  }
  if (input.direction !== undefined && input.direction !== "ltr" && input.direction !== "rtl") {
    throw new TypeError("direction must be ltr or rtl");
  }
  if (!(input.glyphIds instanceof Uint32Array)) {
    throw new TypeError("glyphIds must be a Uint32Array");
  }
  if (!(input.clusters instanceof Uint32Array)) {
    throw new TypeError("clusters must be a Uint32Array");
  }
  if (!(input.x instanceof Float32Array)) {
    throw new TypeError("x must be a Float32Array");
  }
  if (!(input.y instanceof Float32Array)) {
    throw new TypeError("y must be a Float32Array");
  }
  if (!(input.xAdvance instanceof Float32Array)) {
    throw new TypeError("xAdvance must be a Float32Array");
  }
  if (!(input.yAdvance instanceof Float32Array)) {
    throw new TypeError("yAdvance must be a Float32Array");
  }
  if (!(input.lineIndices instanceof Uint32Array)) {
    throw new TypeError("lineIndices must be a Uint32Array");
  }

  const glyphCount = input.glyphIds.length;
  const lengths = [
    input.clusters.length,
    input.x.length,
    input.y.length,
    input.xAdvance.length,
    input.yAdvance.length,
    input.lineIndices.length,
  ];
  if (lengths.some((length) => length !== glyphCount)) {
    throw new TypeError("Trusted glyph run arrays must have equal lengths");
  }
  if (input.glyphKeys !== undefined && input.glyphKeys.length !== glyphCount) {
    throw new TypeError("glyphKeys must contain one key per glyph");
  }
  if (
    !Number.isFinite(input.bounds.x) ||
    !Number.isFinite(input.bounds.y) ||
    !Number.isFinite(input.bounds.width) ||
    !Number.isFinite(input.bounds.height) ||
    input.bounds.width < 0 ||
    input.bounds.height < 0
  ) {
    throw new TypeError("Trusted glyph run bounds must be finite and non-negative");
  }
}

function assertNonEmptyString(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
