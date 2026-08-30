/*
 * Analytic coverage math follows HarfBuzz's hb-gpu shared fragment helpers.
 *
 * Copyright (C) 2026 Behdad Esfahbod
 *
 * Permission is hereby granted, without written agreement and without license or royalty fees,
 * to use, copy, modify, and distribute this software and its documentation for any purpose,
 * provided that the above copyright notice and the following two paragraphs appear in all
 * copies of this software and its documentation.
 *
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL,
 * INCIDENTAL, OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS
 * DOCUMENTATION, EVEN IF THE COPYRIGHT HOLDER HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * THE COPYRIGHT HOLDER SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE SOFTWARE
 * PROVIDED HEREUNDER IS ON AN "AS IS" BASIS, AND THE COPYRIGHT HOLDER HAS NO OBLIGATION TO
 * PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
 */

export const OUTLINE_ANALYTIC_WGSL: string = /* wgsl */ `
struct GlyphMeta {
  atlas_rect: vec4<u32>,
  content: vec4<u32>,
  lookup: vec4<u32>,
  geometry: vec4<f32>,
  raster: vec4<f32>,
  color: vec4<f32>,
}

struct Curve {
  p0: vec2<f32>,
  p1: vec2<f32>,
  p2: vec2<f32>,
}

@group(0) @binding(0) var<storage, read> glyphs: array<GlyphMeta>;
@group(0) @binding(1) var<storage, read> curves: array<f32>;
@group(0) @binding(2) var<storage, read> spatial: array<i32>;

const LOOKUP_HEADER_WORDS: u32 = 4u;
const BAND_RECORD_WORDS: u32 = 4u;
const CURVE_WORDS: u32 = 8u;
const COORDINATE_SCALE: f32 = 4.0;
const MIN_WEIGHT: f32 = 1.0 / 65536.0;

fn curve_at(index: u32) -> Curve {
  let offset = index * CURVE_WORDS;
  var curve: Curve;
  curve.p0 = vec2<f32>(curves[offset], curves[offset + 1u]);
  curve.p1 = vec2<f32>(curves[offset + 2u], curves[offset + 3u]);
  curve.p2 = vec2<f32>(curves[offset + 4u], curves[offset + 5u]);
  return curve;
}

fn root_code(first: f32, second: f32, third: f32) -> u32 {
  let bit0 = bitcast<u32>(first) >> 31u;
  let bit1 = (bitcast<u32>(second) >> 31u) << 1u;
  let bit2 = (bitcast<u32>(third) >> 31u) << 2u;
  return (0x2e74u >> (bit0 | bit1 | bit2)) & 0x0101u;
}

fn solve_horizontal(a: vec2<f32>, b: vec2<f32>, p0: vec2<f32>) -> vec2<f32> {
  let discriminant = sqrt(max(b.y * b.y - a.y * p0.y, 0.0));
  var first = (b.y - discriminant) / a.y;
  var second = (b.y + discriminant) / a.y;
  if (a.y == 0.0) {
    first = p0.y * (0.5 / b.y);
    second = first;
  }
  return vec2<f32>(
    (a.x * first - b.x * 2.0) * first + p0.x,
    (a.x * second - b.x * 2.0) * second + p0.x,
  );
}

fn solve_vertical(a: vec2<f32>, b: vec2<f32>, p0: vec2<f32>) -> vec2<f32> {
  let discriminant = sqrt(max(b.x * b.x - a.x * p0.x, 0.0));
  var first = (b.x - discriminant) / a.x;
  var second = (b.x + discriminant) / a.x;
  if (a.x == 0.0) {
    first = p0.x * (0.5 / b.x);
    second = first;
  }
  return vec2<f32>(
    (a.y * first - b.y * 2.0) * first + p0.y,
    (a.y * second - b.y * 2.0) * second + p0.y,
  );
}

fn band_record(
  glyph: GlyphMeta,
  horizontal: bool,
  render_coord: vec2<f32>,
) -> u32 {
  let minimum = glyph.geometry.xy;
  let maximum = glyph.geometry.zw;
  let extents = max(maximum - minimum, vec2<f32>(MIN_WEIGHT));
  let band_counts = vec2<u32>(glyph.lookup.z, glyph.lookup.y);
  let axes = vec2<u32>(
    u32(clamp(
      i32((render_coord.x - minimum.x) * f32(band_counts.x) / extents.x),
      0,
      i32(band_counts.x) - 1,
    )),
    u32(clamp(
      i32((render_coord.y - minimum.y) * f32(band_counts.y) / extents.y),
      0,
      i32(band_counts.y) - 1,
    )),
  );
  let record_index = select(glyph.lookup.y + axes.x, axes.y, horizontal);
  return glyph.lookup.x + LOOKUP_HEADER_WORDS + record_index * BAND_RECORD_WORDS;
}

fn accumulate(
  glyph: GlyphMeta,
  record: u32,
  horizontal: bool,
  render_coord: vec2<f32>,
  pixels_per_unit: vec2<f32>,
) -> vec2<f32> {
  let count = spatial[record];
  let split = f32(spatial[record + 3u]) / COORDINATE_SCALE;
  let ray_coordinate = select(render_coord.y, render_coord.x, horizontal);
  let left_ray = ray_coordinate < split;
  let list_field = select(1u, 2u, left_ray);
  let list_offset = glyph.lookup.x + u32(spatial[record + list_field]);
  let ray_pixels_per_unit = select(pixels_per_unit.y, pixels_per_unit.x, horizontal);
  var coverage = 0.0;
  var weight = 0.0;

  for (var list_index = 0; list_index < count; list_index += 1) {
    let curve_index = glyph.lookup.w + u32(spatial[list_offset + u32(list_index)]);
    let curve = curve_at(curve_index);
    let residual0 = curve.p0 - render_coord;
    let residual1 = curve.p1 - render_coord;
    let residual2 = curve.p2 - render_coord;
    let ray_values = select(
      vec3<f32>(residual0.y, residual1.y, residual2.y),
      vec3<f32>(residual0.x, residual1.x, residual2.x),
      horizontal,
    );
    if (left_ray && min(min(ray_values.x, ray_values.y), ray_values.z) * ray_pixels_per_unit > 0.5) {
      break;
    }
    if (!left_ray && max(max(ray_values.x, ray_values.y), ray_values.z) * ray_pixels_per_unit < -0.5) {
      break;
    }

    let code = select(
      root_code(residual0.x, residual1.x, residual2.x),
      root_code(residual0.y, residual1.y, residual2.y),
      horizontal,
    );
    if (code == 0u) {
      continue;
    }
    let a = curve.p0 - curve.p1 * 2.0 + curve.p2;
    let b = curve.p0 - curve.p1;
    let roots = select(
      solve_vertical(a, b, residual0),
      solve_horizontal(a, b, residual0),
      horizontal,
    ) * ray_pixels_per_unit;
    let covered = select(
      clamp(roots + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0)),
      clamp(vec2<f32>(0.5) - roots, vec2<f32>(0.0), vec2<f32>(1.0)),
      left_ray,
    );
    if ((code & 1u) != 0u) {
      coverage += select(-covered.x, covered.x, horizontal);
      weight = max(weight, clamp(1.0 - abs(roots.x) * 2.0, 0.0, 1.0));
    }
    if (code > 1u) {
      coverage += select(covered.y, -covered.y, horizontal);
      weight = max(weight, clamp(1.0 - abs(roots.y) * 2.0, 0.0, 1.0));
    }
  }
  return vec2<f32>(select(coverage, -coverage, left_ray), weight);
}

fn outline_coverage(glyph: GlyphMeta, render_coord: vec2<f32>, pixels_per_unit: vec2<f32>) -> f32 {
  let horizontal = accumulate(
    glyph,
    band_record(glyph, true, render_coord),
    true,
    render_coord,
    pixels_per_unit,
  );
  let vertical = accumulate(
    glyph,
    band_record(glyph, false, render_coord),
    false,
    render_coord,
    pixels_per_unit,
  );
  let weighted = abs(horizontal.x * horizontal.y + vertical.x * vertical.y) /
    max(horizontal.y + vertical.y, MIN_WEIGHT);
  let conservative = min(abs(horizontal.x), abs(vertical.x));
  return clamp(max(weighted, conservative), 0.0, 1.0);
}
`;

export const OUTLINE_COMPUTE_WGSL: string = /* wgsl */ `${OUTLINE_ANALYTIC_WGSL}
@group(0) @binding(3) var color_atlas: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.z >= arrayLength(&glyphs)) {
    return;
  }
  let glyph = glyphs[invocation.z];
  if (invocation.x >= glyph.atlas_rect.z || invocation.y >= glyph.atlas_rect.w) {
    return;
  }
  let local = vec2<f32>(invocation.xy) - vec2<f32>(f32(glyph.content.x)) + vec2<f32>(0.5);
  let render_coord = vec2<f32>(
    glyph.geometry.x + local.x / glyph.raster.x,
    glyph.geometry.w - local.y / glyph.raster.x,
  );
  let coverage = outline_coverage(glyph, render_coord, vec2<f32>(glyph.raster.x));
  let alpha = clamp(glyph.color.a * coverage, 0.0, 1.0);
  let output_color = vec4<f32>(glyph.color.rgb * alpha, alpha);
  let atlas_coord = vec2<i32>(glyph.atlas_rect.xy + invocation.xy);
  textureStore(color_atlas, atlas_coord, output_color);
}
`;

export const OUTLINE_FRAGMENT_WGSL: string = /* wgsl */ `${OUTLINE_ANALYTIC_WGSL}
struct OutlineFragmentInput {
  @location(0) render_coord: vec2<f32>,
  @location(1) @interpolate(flat) glyph_index: u32,
  @location(2) color: vec4<f32>,
}

@fragment
fn outline_fragment(input: OutlineFragmentInput) -> @location(0) vec4<f32> {
  let glyph = glyphs[input.glyph_index];
  let pixels_per_unit = 1.0 / max(abs(fwidth(input.render_coord)), vec2<f32>(MIN_WEIGHT));
  let coverage = outline_coverage(glyph, input.render_coord, pixels_per_unit);
  let alpha = clamp(input.color.a * coverage, 0.0, 1.0);
  return vec4<f32>(input.color.rgb * alpha, alpha);
}
`;
