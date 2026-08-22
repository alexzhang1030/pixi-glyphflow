/** Edge of the encoded field. Matches the shader `smoothstep(0.5, …)` contour. */
const TINY_SDF_EDGE = 0.5;
export const TINY_SDF_RADIUS = 8;

const INF = 1e20;

// Miss bursts raster many glyphs back to back; grow-only scratch keeps the EDT allocation-free.
let outsideScratch = new Float64Array(0);
let insideScratch = new Float64Array(0);
let edtSource = new Float64Array(0);
let edtDest = new Float64Array(0);
let edtSites = new Int32Array(0);
let edtBounds = new Float64Array(0);

/** Encode an 8-bit alpha mask as a single-channel SDF with the edge at 0.5. */
export function encodeTinySdf(
  alpha: Uint8Array,
  width: number,
  height: number,
  radius: number = TINY_SDF_RADIUS,
): Uint8Array {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new TypeError("SDF width must be a positive safe integer");
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError("SDF height must be a positive safe integer");
  }
  if (alpha.length !== width * height) {
    throw new TypeError("SDF alpha length differs from width * height");
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new TypeError("SDF radius must be a positive finite number");
  }

  const area = width * height;
  if (outsideScratch.length < area) {
    outsideScratch = new Float64Array(area);
    insideScratch = new Float64Array(area);
  }
  const outside = outsideScratch;
  const inside = insideScratch;
  for (let index = 0; index < alpha.length; index += 1) {
    const filled = (alpha[index] ?? 0) >= 128;
    outside[index] = filled ? INF : 0;
    inside[index] = filled ? 0 : INF;
  }
  edt(outside, width, height);
  edt(inside, width, height);

  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    const signed = Math.sqrt(inside[index] ?? 0) - Math.sqrt(outside[index] ?? 0);
    const t = TINY_SDF_EDGE - TINY_SDF_EDGE * clamp(signed / radius, -1, 1);
    pixels[index] = Math.round(t * 255);
  }
  return pixels;
}

function edt(grid: Float64Array, width: number, height: number): void {
  const length = Math.max(width, height);
  if (edtSource.length < length) {
    edtSource = new Float64Array(length);
    edtDest = new Float64Array(length);
    edtSites = new Int32Array(length);
    edtBounds = new Float64Array(length + 1);
  }
  const source = edtSource;
  const dest = edtDest;
  const sites = edtSites;
  const bounds = edtBounds;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) source[y] = grid[y * width + x] ?? INF;
    edt1d(source, dest, sites, bounds, height);
    for (let y = 0; y < height; y += 1) grid[y * width + x] = dest[y] ?? INF;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) source[x] = grid[y * width + x] ?? INF;
    edt1d(source, dest, sites, bounds, width);
    for (let x = 0; x < width; x += 1) grid[y * width + x] = dest[x] ?? INF;
  }
}

function edt1d(
  source: Float64Array,
  dest: Float64Array,
  sites: Int32Array,
  bounds: Float64Array,
  count: number,
): void {
  if (count === 0) return;
  let envelope = 0;
  sites[0] = 0;
  bounds[0] = -INF;
  bounds[1] = INF;
  for (let query = 1; query < count; query += 1) {
    let previous = sites[envelope] ?? 0;
    let split = parabolaIntersection(source, previous, query);
    while (envelope > 0 && split <= (bounds[envelope] ?? -INF)) {
      envelope -= 1;
      previous = sites[envelope] ?? 0;
      split = parabolaIntersection(source, previous, query);
    }
    envelope += 1;
    sites[envelope] = query;
    bounds[envelope] = split;
    bounds[envelope + 1] = INF;
  }
  envelope = 0;
  for (let query = 0; query < count; query += 1) {
    while ((bounds[envelope + 1] ?? INF) < query) envelope += 1;
    const site = sites[envelope] ?? 0;
    const offset = query - site;
    dest[query] = offset * offset + (source[site] ?? INF);
  }
}

function parabolaIntersection(source: Float64Array, left: number, right: number): number {
  const span = right - left;
  if (span === 0) return INF;
  return (
    ((source[right] ?? INF) - (source[left] ?? INF) + right * right - left * left) / (2 * span)
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
