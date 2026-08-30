export const HB_GPU_PACKED_BROWSER_SCHEMA_VERSION = 1;
export const HB_GPU_PACKED_PROJECTED_BYTES_CEILING: number = 64 * 1024 * 1024;
export const HB_GPU_PACKED_RENDER_WIDTH = 320;
export const HB_GPU_PACKED_RENDER_HEIGHT = 180;

export type HbGpuPackedBackend = "storage-buffer" | "rgba16sint";

export interface HbGpuPackedGlyph {
  readonly corpusId: string;
  readonly glyphId: number;
  readonly blobHex: string;
  readonly blobBytes: number;
  readonly extents: Readonly<{
    xBearing: number;
    yBearing: number;
    width: number;
    height: number;
  }>;
}

export interface HbGpuPackedArtifact {
  readonly schemaVersion: number;
  readonly harfbuzzVersion: string;
  readonly shaderSources: Readonly<{
    sharedVertex: string;
    sharedFragment: string;
    drawVertex: string;
    drawFragment: string;
  }>;
  readonly glyphs: readonly HbGpuPackedGlyph[];
  readonly corpusIds: readonly string[];
  readonly packedBlobBytes: number;
  readonly atlasPressureProjectedPackedBytes: number;
}

export interface HbGpuPackedAtlas {
  readonly bytes: Uint8Array;
  readonly glyphs: readonly Readonly<
    HbGpuPackedGlyph & {
      texelOffset: number;
    }
  >[];
}

export interface HbGpuPackedShader {
  readonly backend: HbGpuPackedBackend;
  readonly vertex: string;
  readonly fragment: string;
}

export function parseHbGpuPackedArtifact(value: unknown): Readonly<HbGpuPackedArtifact> {
  const artifact = record(value, "artifact");
  const harfbuzz = record(artifact.harfbuzz, "artifact.harfbuzz");
  const storage = record(artifact.storageModel, "artifact.storageModel");
  const sources = record(artifact.shaderSources, "artifact.shaderSources");
  const totals = record(artifact.totals, "artifact.totals");
  if (string(storage.encodedTexel, "artifact.storageModel.encodedTexel") !== "RGBA16I") {
    throw new TypeError("artifact.storageModel.encodedTexel must be RGBA16I");
  }
  if (integer(storage.encodedTexelBytes, "artifact.storageModel.encodedTexelBytes", 1) !== 8) {
    throw new TypeError("artifact.storageModel.encodedTexelBytes must be 8");
  }

  const corpusIds: string[] = [];
  const glyphs: HbGpuPackedGlyph[] = [];
  for (const [corpusIndex, corpusValue] of array(artifact.corpora, "artifact.corpora").entries()) {
    const corpusPath = `artifact.corpora[${String(corpusIndex)}]`;
    const corpus = record(corpusValue, corpusPath);
    const corpusId = string(corpus.id, `${corpusPath}.id`);
    corpusIds.push(corpusId);
    for (const [glyphIndex, glyphValue] of array(corpus.glyphs, `${corpusPath}.glyphs`).entries()) {
      const glyphPath = `${corpusPath}.glyphs[${String(glyphIndex)}]`;
      const glyph = record(glyphValue, glyphPath);
      const extents = record(glyph.extents, `${glyphPath}.extents`);
      const blobBytes = integer(glyph.blobCpuBytes, `${glyphPath}.blobCpuBytes`, 0);
      if (blobBytes % 8 !== 0) throw new TypeError(`${glyphPath}.blobCpuBytes must align to 8`);
      const blobHex = string(glyph.blobHex, `${glyphPath}.blobHex`);
      if (!/^(?:[0-9a-f]{2})*$/u.test(blobHex) || blobHex.length !== blobBytes * 2) {
        throw new TypeError(`${glyphPath}.blobHex must encode blobCpuBytes bytes`);
      }
      glyphs.push(
        Object.freeze({
          corpusId,
          glyphId: integer(glyph.glyphId, `${glyphPath}.glyphId`, 0),
          blobHex,
          blobBytes,
          extents: Object.freeze({
            xBearing: integer(extents.xBearing, `${glyphPath}.extents.xBearing`),
            yBearing: integer(extents.yBearing, `${glyphPath}.extents.yBearing`),
            width: integer(extents.width, `${glyphPath}.extents.width`),
            height: integer(extents.height, `${glyphPath}.extents.height`),
          }),
        }),
      );
    }
  }

  const packedBlobBytes = integer(totals.blobCpuBytes, "artifact.totals.blobCpuBytes", 0);
  if (glyphs.reduce((sum, glyph) => sum + glyph.blobBytes, 0) !== packedBlobBytes) {
    throw new TypeError("artifact glyph blobs must sum to totals.blobCpuBytes");
  }

  return Object.freeze({
    schemaVersion: integer(artifact.schemaVersion, "artifact.schemaVersion", 1),
    harfbuzzVersion: string(harfbuzz.version, "artifact.harfbuzz.version"),
    shaderSources: Object.freeze({
      sharedVertex: string(sources.sharedVertex, "artifact.shaderSources.sharedVertex"),
      sharedFragment: string(sources.sharedFragment, "artifact.shaderSources.sharedFragment"),
      drawVertex: string(sources.drawVertex, "artifact.shaderSources.drawVertex"),
      drawFragment: string(sources.drawFragment, "artifact.shaderSources.drawFragment"),
    }),
    glyphs: Object.freeze(glyphs),
    corpusIds: Object.freeze(corpusIds),
    packedBlobBytes,
    atlasPressureProjectedPackedBytes: integer(
      totals.atlasPressureProjectedPackedBytes,
      "artifact.totals.atlasPressureProjectedPackedBytes",
      0,
    ),
  });
}

export function concatPackedGlyphs(
  glyphs: readonly Readonly<HbGpuPackedGlyph>[],
): Readonly<HbGpuPackedAtlas> {
  const totalBytes = glyphs.reduce((sum, glyph) => sum + glyph.blobBytes, 0);
  const bytes = new Uint8Array(totalBytes);
  const indexed: (HbGpuPackedGlyph & { texelOffset: number })[] = [];
  let byteOffset = 0;
  for (const glyph of glyphs) {
    const decoded = decodePackedHex(glyph.blobHex);
    if (decoded.byteLength !== glyph.blobBytes) {
      throw new TypeError(`${glyph.corpusId}/${String(glyph.glyphId)} blob length changed`);
    }
    bytes.set(decoded, byteOffset);
    indexed.push(Object.freeze({ ...glyph, texelOffset: byteOffset / 8 }));
    byteOffset += decoded.byteLength;
  }
  return Object.freeze({ bytes, glyphs: Object.freeze(indexed) });
}

export function decodePackedHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value)) {
    throw new TypeError("packed hex must contain lowercase byte pairs");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function selectMultiscriptGlyphs(
  atlas: Readonly<HbGpuPackedAtlas>,
  corpusIds: readonly string[],
): readonly Readonly<HbGpuPackedGlyph & { texelOffset: number }>[] {
  return Object.freeze(
    corpusIds.map((corpusId) => {
      let glyph: (typeof atlas.glyphs)[number] | undefined;
      for (const candidate of atlas.glyphs) {
        if (
          candidate.corpusId !== corpusId ||
          candidate.blobBytes === 0 ||
          candidate.extents.width === 0 ||
          candidate.extents.height === 0 ||
          candidate.glyphId === 0
        ) {
          continue;
        }
        if (
          glyph === undefined ||
          candidate.blobBytes > glyph.blobBytes ||
          (candidate.blobBytes === glyph.blobBytes && candidate.glyphId < glyph.glyphId)
        ) {
          glyph = candidate;
        }
      }
      if (glyph === undefined) throw new Error(`${corpusId} has no renderable packed glyph`);
      return glyph;
    }),
  );
}

export function assemblePackedDrawWgsl(
  sources: Readonly<HbGpuPackedArtifact["shaderSources"]>,
  backend: HbGpuPackedBackend,
): Readonly<HbGpuPackedShader> {
  const pointerType = backend === "storage-buffer" ? "HbGpuPackedAtlas" : "HbGpuTextureAtlas";
  let fragment = `${sources.sharedFragment}\n${sources.drawFragment}`.replaceAll(
    /ptr<storage,\s*array<vec4<i32>>,\s*read>/gu,
    `ptr<storage, ${pointerType}, read>`,
  );
  const fetchStart = fragment.indexOf("fn hb_gpu_fetch");
  const fetchEnd = fragment.indexOf("fn _hb_gpu_calc_root_code", fetchStart);
  if (fetchStart < 0 || fetchEnd < 0) {
    throw new TypeError("HarfBuzz WGSL hb_gpu_fetch seam is unavailable");
  }

  const fetch =
    backend === "storage-buffer" ? PACKED_STORAGE_FETCH_WGSL : RGBA16SINT_TEXTURE_FETCH_WGSL;
  fragment = `${fragment.slice(0, fetchStart)}${fetch}\n${fragment.slice(fetchEnd)}`;
  const declarations =
    backend === "storage-buffer"
      ? PACKED_STORAGE_DECLARATIONS_WGSL
      : RGBA16SINT_TEXTURE_DECLARATIONS_WGSL;

  return Object.freeze({
    backend,
    vertex: GLYPH_VERTEX_WGSL,
    fragment: `${declarations}\n${fragment}\n${GLYPH_FRAGMENT_ENTRY_WGSL}`,
  });
}

const GLYPH_VERTEX_WGSL = /* wgsl */ `
struct GlyphInstance {
  rect: vec4f,
  placement: vec4f,
  glyphLoc: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) renderCoord: vec2f,
  @location(1) @interpolate(flat) glyphLoc: u32,
  @location(2) @interpolate(flat) corpus: u32,
}

@group(1) @binding(0) var<storage, read> instances: array<GlyphInstance>;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let glyph = instances[instanceIndex];
  let renderCoord = mix(glyph.rect.xy, glyph.rect.zw, corners[vertexIndex]);
  let pixel = vec2f(
    glyph.placement.x + renderCoord.x * glyph.placement.z,
    glyph.placement.y - renderCoord.y * glyph.placement.z
  );
  var output: VertexOutput;
  output.position = vec4f(
    pixel.x / ${String(HB_GPU_PACKED_RENDER_WIDTH / 2)}.0 - 1.0,
    1.0 - pixel.y / ${String(HB_GPU_PACKED_RENDER_HEIGHT / 2)}.0,
    0.0,
    1.0
  );
  output.renderCoord = renderCoord;
  output.glyphLoc = glyph.glyphLoc;
  output.corpus = u32(glyph.placement.w);
  return output;
}
`;

const PACKED_STORAGE_DECLARATIONS_WGSL = /* wgsl */ `
struct HbGpuPackedAtlas {
  texels: array<vec2<u32>>,
}
@group(0) @binding(0) var<storage, read> hb_gpu_atlas_binding: HbGpuPackedAtlas;
`;

const PACKED_STORAGE_FETCH_WGSL = /* wgsl */ `
fn hb_gpu_sign_extend_16(value: u32) -> i32 {
  return bitcast<i32>(value << 16u) >> 16u;
}

fn hb_gpu_fetch(hb_gpu_atlas: ptr<storage, HbGpuPackedAtlas, read>,
                offset: i32) -> vec4<i32> {
  let raw = (*hb_gpu_atlas).texels[u32(offset)];
  return vec4<i32>(
    hb_gpu_sign_extend_16(raw.x), bitcast<i32>(raw.x) >> 16u,
    hb_gpu_sign_extend_16(raw.y), bitcast<i32>(raw.y) >> 16u
  );
}
`;

const RGBA16SINT_TEXTURE_DECLARATIONS_WGSL = /* wgsl */ `
struct HbGpuTextureAtlas {
  width: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}
@group(0) @binding(0) var<storage, read> hb_gpu_atlas_binding: HbGpuTextureAtlas;
@group(0) @binding(1) var hb_gpu_atlas_texture: texture_2d<i32>;
`;

const RGBA16SINT_TEXTURE_FETCH_WGSL = /* wgsl */ `
fn hb_gpu_fetch(hb_gpu_atlas: ptr<storage, HbGpuTextureAtlas, read>,
                offset: i32) -> vec4<i32> {
  let width = (*hb_gpu_atlas).width;
  let index = u32(offset);
  return textureLoad(
    hb_gpu_atlas_texture,
    vec2<i32>(i32(index % width), i32(index / width)),
    0
  );
}
`;

const GLYPH_FRAGMENT_ENTRY_WGSL = /* wgsl */ `
struct FragmentInput {
  @location(0) renderCoord: vec2f,
  @location(1) @interpolate(flat) glyphLoc: u32,
  @location(2) @interpolate(flat) corpus: u32,
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4f {
  let colors = array<vec3f, 5>(
    vec3f(0.95, 0.30, 0.28),
    vec3f(0.20, 0.78, 0.95),
    vec3f(0.35, 0.90, 0.42),
    vec3f(0.82, 0.46, 0.96),
    vec3f(0.98, 0.73, 0.20)
  );
  let coverage = hb_gpu_draw(input.renderCoord, input.glyphLoc, &hb_gpu_atlas_binding);
  let color = colors[input.corpus % 5u];
  return vec4f(color * coverage, coverage);
}
`;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function integer(value: unknown, path: string, minimum = -Infinity): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${path} must be a safe integer at least ${String(minimum)}`);
  }
  return value;
}
