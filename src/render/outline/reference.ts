import type {
  OutlineColor,
  OutlineCpuBitmap,
  OutlineRasterOptions,
  PreparedOutlineGlyph,
} from "./types";

const COORDINATE_SCALE = 4;
const CURVE_STRIDE = 8;
const LOOKUP_HEADER_WORDS = 4;
const BAND_RECORD_WORDS = 4;
const MIN_WEIGHT = 1 / 65_536;
const DEFAULT_COLOR = Object.freeze([1, 1, 1, 1] as const);

interface Point {
  readonly x: number;
  readonly y: number;
}

export function rasterizeOutlineCpu(
  glyph: Readonly<PreparedOutlineGlyph>,
  options: Readonly<OutlineRasterOptions>,
): Readonly<OutlineCpuBitmap> {
  const geometry = resolveRasterGeometry(glyph, options);
  const pixels = new Uint8Array(geometry.width * geometry.height * 4);
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      const renderX = glyph.quad.minX + (x - geometry.padding + 0.5) / geometry.scale;
      const renderY = glyph.quad.maxY - (y - geometry.padding + 0.5) / geometry.scale;
      const coverage = sampleOutlineCoverage(glyph, renderX, renderY, geometry.scale);
      writePremultipliedPixel(pixels, (y * geometry.width + x) * 4, geometry.color, coverage);
    }
  }
  return Object.freeze({
    width: geometry.width,
    height: geometry.height,
    bytesPerRow: geometry.width * 4,
    pixels,
  });
}

export function sampleOutlineCoverage(
  glyph: Readonly<PreparedOutlineGlyph>,
  renderX: number,
  renderY: number,
  pixelsPerUnit: number,
): number {
  if (![renderX, renderY, pixelsPerUnit].every(Number.isFinite) || pixelsPerUnit <= 0) {
    throw new TypeError("outline sample coordinates and pixelsPerUnit must be finite and positive");
  }
  const horizontalBand = selectBand(glyph, true, renderY, glyph.quad.minY, glyph.quad.height);
  const verticalBand = selectBand(glyph, false, renderX, glyph.quad.minX, glyph.quad.width);

  const horizontal = accumulateCoverage(
    glyph,
    horizontalBand,
    "horizontal",
    renderX,
    renderY,
    pixelsPerUnit,
  );
  const vertical = accumulateCoverage(
    glyph,
    verticalBand,
    "vertical",
    renderX,
    renderY,
    pixelsPerUnit,
  );
  const signedWeight =
    horizontal.coverage * horizontal.weight + vertical.coverage * vertical.weight;
  const weighted =
    Math.abs(signedWeight) / Math.max(horizontal.weight + vertical.weight, MIN_WEIGHT);
  const conservative = Math.min(Math.abs(horizontal.coverage), Math.abs(vertical.coverage));
  return clamp(Math.max(weighted, conservative), 0, 1);
}

interface RasterGeometry {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly scale: number;
  readonly color: OutlineColor;
}

export function resolveRasterGeometry(
  glyph: Readonly<PreparedOutlineGlyph>,
  options: Readonly<OutlineRasterOptions>,
): Readonly<RasterGeometry> {
  if (!Number.isSafeInteger(options.pixelHeight) || options.pixelHeight <= 0) {
    throw new TypeError("pixelHeight must be a positive safe integer");
  }
  const padding = options.padding ?? 1;
  if (!Number.isSafeInteger(padding) || padding < 0) {
    throw new TypeError("padding must be a non-negative safe integer");
  }
  if (glyph.quad.width <= 0 || glyph.quad.height <= 0) {
    throw new TypeError("a rasterized outline glyph must have positive quad area");
  }
  const color = options.color ?? DEFAULT_COLOR;
  if (color.length !== 4 || color.some((channel) => !Number.isFinite(channel))) {
    throw new TypeError("outline color must contain four finite channels");
  }
  const normalizedColor = Object.freeze(
    color.map((channel) => clamp(channel, 0, 1)) as [number, number, number, number],
  );
  const scale = options.pixelHeight / glyph.quad.height;
  const contentWidth = Math.max(1, Math.ceil(glyph.quad.width * scale));
  return Object.freeze({
    width: contentWidth + padding * 2,
    height: options.pixelHeight + padding * 2,
    padding,
    scale,
    color: normalizedColor,
  });
}

interface CoverageAccumulator {
  readonly coverage: number;
  readonly weight: number;
}

function accumulateCoverage(
  glyph: Readonly<PreparedOutlineGlyph>,
  bandRecord: number,
  direction: "horizontal" | "vertical",
  renderX: number,
  renderY: number,
  pixelsPerUnit: number,
): Readonly<CoverageAccumulator> {
  const lookup = glyph.spatialLookup;
  const count = readLookup(lookup, bandRecord);
  const split = readLookup(lookup, bandRecord + 3) / COORDINATE_SCALE;
  const rayCoordinate = direction === "horizontal" ? renderX : renderY;
  const leftRay = rayCoordinate < split;
  const listOffset = readLookup(lookup, bandRecord + (leftRay ? 2 : 1));
  let coverage = 0;
  let weight = 0;

  for (let listIndex = 0; listIndex < count; listIndex += 1) {
    const curveIndex = readLookup(lookup, listOffset + listIndex);
    const curve = readCurve(glyph.curveStorage, curveIndex);
    if (canStopCurveWalk(curve, direction, leftRay, renderX, renderY, pixelsPerUnit)) break;

    const p0 = Object.freeze({ x: curve.p0.x - renderX, y: curve.p0.y - renderY });
    const p1 = Object.freeze({ x: curve.p1.x - renderX, y: curve.p1.y - renderY });
    const p2 = Object.freeze({ x: curve.p2.x - renderX, y: curve.p2.y - renderY });
    const rootCode =
      direction === "horizontal" ? rootCodeFor(p0.y, p1.y, p2.y) : rootCodeFor(p0.x, p1.x, p2.x);
    if (rootCode === 0) continue;

    const a = Object.freeze({
      x: curve.p0.x - curve.p1.x * 2 + curve.p2.x,
      y: curve.p0.y - curve.p1.y * 2 + curve.p2.y,
    });
    const b = Object.freeze({ x: curve.p0.x - curve.p1.x, y: curve.p0.y - curve.p1.y });
    const roots = direction === "horizontal" ? solveHorizontal(a, b, p0) : solveVertical(a, b, p0);
    const firstRoot = roots[0] * pixelsPerUnit;
    const secondRoot = roots[1] * pixelsPerUnit;
    const firstCoverage = leftRay ? clamp(0.5 - firstRoot, 0, 1) : clamp(firstRoot + 0.5, 0, 1);
    const secondCoverage = leftRay ? clamp(0.5 - secondRoot, 0, 1) : clamp(secondRoot + 0.5, 0, 1);

    if ((rootCode & 1) !== 0) {
      coverage += direction === "horizontal" ? firstCoverage : -firstCoverage;
      weight = Math.max(weight, clamp(1 - Math.abs(firstRoot) * 2, 0, 1));
    }
    if (rootCode > 1) {
      coverage += direction === "horizontal" ? -secondCoverage : secondCoverage;
      weight = Math.max(weight, clamp(1 - Math.abs(secondRoot) * 2, 0, 1));
    }
  }

  return Object.freeze({ coverage: leftRay ? -coverage : coverage, weight });
}

function selectBand(
  glyph: Readonly<PreparedOutlineGlyph>,
  horizontal: boolean,
  coordinate: number,
  minimum: number,
  extent: number,
): number {
  const count = horizontal ? glyph.horizontalBandCount : glyph.verticalBandCount;
  const bandIndex = clamp(
    Math.floor(((coordinate - minimum) * count) / Math.max(extent, MIN_WEIGHT)),
    0,
    count - 1,
  );
  const recordIndex = horizontal ? bandIndex : glyph.horizontalBandCount + bandIndex;
  return LOOKUP_HEADER_WORDS + recordIndex * BAND_RECORD_WORDS;
}

interface Quadratic {
  readonly p0: Readonly<Point>;
  readonly p1: Readonly<Point>;
  readonly p2: Readonly<Point>;
}

function readCurve(storage: Float32Array, curveIndex: number): Readonly<Quadratic> {
  if (!Number.isInteger(curveIndex) || curveIndex < 0) {
    throw new TypeError("spatial lookup contains an invalid curve index");
  }
  const offset = curveIndex * CURVE_STRIDE;
  const x0 = storage[offset];
  const y0 = storage[offset + 1];
  const x1 = storage[offset + 2];
  const y1 = storage[offset + 3];
  const x2 = storage[offset + 4];
  const y2 = storage[offset + 5];
  if (
    x0 === undefined ||
    y0 === undefined ||
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined
  ) {
    throw new TypeError("spatial lookup references a missing curve");
  }
  return Object.freeze({
    p0: Object.freeze({ x: x0, y: y0 }),
    p1: Object.freeze({ x: x1, y: y1 }),
    p2: Object.freeze({ x: x2, y: y2 }),
  });
}

function canStopCurveWalk(
  curve: Readonly<Quadratic>,
  direction: "horizontal" | "vertical",
  leftRay: boolean,
  renderX: number,
  renderY: number,
  pixelsPerUnit: number,
): boolean {
  const values =
    direction === "horizontal"
      ? [curve.p0.x - renderX, curve.p1.x - renderX, curve.p2.x - renderX]
      : [curve.p0.y - renderY, curve.p1.y - renderY, curve.p2.y - renderY];
  return leftRay
    ? Math.min(...values) * pixelsPerUnit > 0.5
    : Math.max(...values) * pixelsPerUnit < -0.5;
}

function rootCodeFor(first: number, second: number, third: number): number {
  const signs = signBit(first) | (signBit(second) << 1) | (signBit(third) << 2);
  return (0x2e74 >> signs) & 0x0101;
}

function signBit(value: number): number {
  return value < 0 || Object.is(value, -0) ? 1 : 0;
}

function solveHorizontal(
  a: Readonly<Point>,
  b: Readonly<Point>,
  p0: Readonly<Point>,
): readonly [number, number] {
  const discriminant = Math.sqrt(Math.max(b.y * b.y - a.y * p0.y, 0));
  let first = (b.y - discriminant) / a.y;
  let second = (b.y + discriminant) / a.y;
  if (a.y === 0) {
    first = p0.y * (0.5 / b.y);
    second = first;
  }
  return Object.freeze([
    (a.x * first - b.x * 2) * first + p0.x,
    (a.x * second - b.x * 2) * second + p0.x,
  ]);
}

function solveVertical(
  a: Readonly<Point>,
  b: Readonly<Point>,
  p0: Readonly<Point>,
): readonly [number, number] {
  const discriminant = Math.sqrt(Math.max(b.x * b.x - a.x * p0.x, 0));
  let first = (b.x - discriminant) / a.x;
  let second = (b.x + discriminant) / a.x;
  if (a.x === 0) {
    first = p0.x * (0.5 / b.x);
    second = first;
  }
  return Object.freeze([
    (a.y * first - b.y * 2) * first + p0.y,
    (a.y * second - b.y * 2) * second + p0.y,
  ]);
}

function writePremultipliedPixel(
  pixels: Uint8Array,
  offset: number,
  color: OutlineColor,
  coverage: number,
): void {
  const alpha = clamp(color[3] * coverage, 0, 1);
  pixels[offset] = Math.round(color[0] * alpha * 255);
  pixels[offset + 1] = Math.round(color[1] * alpha * 255);
  pixels[offset + 2] = Math.round(color[2] * alpha * 255);
  pixels[offset + 3] = Math.round(alpha * 255);
}

function readLookup(storage: Int32Array, index: number): number {
  const value = storage[index];
  if (value === undefined) throw new TypeError("spatial lookup ended unexpectedly");
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
