/** Rehydrate version-1 sparse glyph strips into a premultiplied RGBA8 atlas. */
export const SPARSE_STRIP_COMPUTE_WGSL: string = /* wgsl */ `
const GLYPH_WORDS: u32 = 32u;
const HEADER_WIDTH: u32 = 3u;
const HEADER_HEIGHT: u32 = 4u;
const META_ATLAS_X: u32 = 12u;
const META_ATLAS_Y: u32 = 13u;
const META_ROW_OFFSET: u32 = 14u;
const META_RECORD_WORD_OFFSET: u32 = 15u;
const META_COVERAGE_BYTE_OFFSET: u32 = 16u;
const META_COLOR_R: u32 = 18u;
const META_COLOR_G: u32 = 19u;
const META_COLOR_B: u32 = 20u;
const META_COLOR_A: u32 = 21u;

const RECORD_WORDS: u32 = 4u;
const RECORD_TILE_X0: u32 = 1u;
const RECORD_TILE_X1: u32 = 2u;
const RECORD_COVERAGE_OFFSET: u32 = 3u;
const TILE_SIZE: u32 = 4u;
const SOLID_COVERAGE: u32 = 0xffffffffu;

struct DispatchMetadata {
    glyph_base: u32,
    glyph_count: u32,
    reserved_0: u32,
    reserved_1: u32,
}

@group(0) @binding(0) var<storage, read> glyph_words: array<u32>;
@group(0) @binding(1) var<storage, read> row_offsets: array<u32>;
@group(0) @binding(2) var<storage, read> strip_words: array<u32>;
@group(0) @binding(3) var<storage, read> coverage_words: array<u32>;
@group(0) @binding(4) var color_atlas: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> dispatch_metadata: DispatchMetadata;

fn coverage_byte(byte_index: u32) -> f32 {
    let word = coverage_words[byte_index >> 2u];
    let shift = (byte_index & 3u) * 8u;
    return f32((word >> shift) & 0xffu) / 255.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.z >= dispatch_metadata.glyph_count) {
        return;
    }
    let glyph_index = dispatch_metadata.glyph_base + invocation.z;
    let glyph_base = glyph_index * GLYPH_WORDS;
    let width = glyph_words[glyph_base + HEADER_WIDTH];
    let height = glyph_words[glyph_base + HEADER_HEIGHT];
    if (invocation.x >= width || invocation.y >= height) {
        return;
    }

    let tile_x = invocation.x / TILE_SIZE;
    let tile_y = invocation.y / TILE_SIZE;
    let row_base = glyph_words[glyph_base + META_ROW_OFFSET];
    let row_start = row_offsets[row_base + tile_y];
    let row_end = row_offsets[row_base + tile_y + 1u];
    let records_base = glyph_words[glyph_base + META_RECORD_WORD_OFFSET];
    let coverage_base = glyph_words[glyph_base + META_COVERAGE_BYTE_OFFSET];
    var coverage = 0.0;
    for (var record = row_start; record < row_end; record += 1u) {
        let strip_base = records_base + record * RECORD_WORDS;
        let tile_x0 = strip_words[strip_base + RECORD_TILE_X0];
        let tile_x1 = strip_words[strip_base + RECORD_TILE_X1];
        if (tile_x < tile_x0) {
            break;
        }
        if (tile_x >= tile_x1) {
            continue;
        }
        let coverage_offset = strip_words[strip_base + RECORD_COVERAGE_OFFSET];
        if (coverage_offset == SOLID_COVERAGE) {
            coverage = 1.0;
        } else {
            let local_x = invocation.x & 3u;
            let local_y = invocation.y & 3u;
            let byte_index = coverage_base + coverage_offset + local_y * TILE_SIZE + local_x;
            coverage = coverage_byte(byte_index);
        }
        break;
    }

    let color = vec4<f32>(
        bitcast<f32>(glyph_words[glyph_base + META_COLOR_R]),
        bitcast<f32>(glyph_words[glyph_base + META_COLOR_G]),
        bitcast<f32>(glyph_words[glyph_base + META_COLOR_B]),
        bitcast<f32>(glyph_words[glyph_base + META_COLOR_A]),
    );
    let alpha = color.a * coverage;
    let destination = vec2<i32>(
        i32(glyph_words[glyph_base + META_ATLAS_X] + invocation.x),
        i32(glyph_words[glyph_base + META_ATLAS_Y] + invocation.y),
    );
    textureStore(color_atlas, destination, vec4<f32>(color.rgb * alpha, alpha));
}
`;
