import type { PalettePath } from "./paletteStorage";

export const GLYPH_VERTEX_GLSL = /* glsl */ `
#version 300 es

in vec2 aVertex;
in uint aProtoIndex;
in uint aPaletteIndex;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;
uniform sampler2D uTransformTexture;
uniform sampler2D uPrototype;
uniform float uPaletteWidth;
uniform float uEffectBase;

out vec2 vUv;
out vec4 vWorldColor;
flat out uint vMode;
flat out vec4 vEffects;
flat out vec4 vUvBounds;
flat out vec4 vFill;
flat out float vRasterScale;
flat out uint vTextureSlot;

vec4 paletteTexel(uint index) {
    uint width = uint(uPaletteWidth);
    return texelFetch(uTransformTexture, ivec2(int(index % width), int(index / width)), 0);
}

vec4 protoFetch(uint protoIndex, uint texelOffset) {
    int width = textureSize(uPrototype, 0).x;
    int texel = int(protoIndex) * 2 + int(texelOffset);
    return texelFetch(uPrototype, ivec2(texel % width, texel / width), 0);
}

vec3 unpackRgb(float packed) {
    uint value = uint(round(packed));
    return vec3(
        float((value >> 16u) & 255u),
        float((value >> 8u) & 255u),
        float(value & 255u)
    ) / 255.0;
}

void main(void) {
    vec4 proto0 = protoFetch(aProtoIndex, 0u);
    vec4 proto1 = protoFetch(aProtoIndex, 1u);
    vec4 instanceRect = vec4(
        unpackHalf2x16(floatBitsToUint(proto0.x)),
        unpackHalf2x16(floatBitsToUint(proto0.y))
    );
    vec4 instanceUv = vec4(
        unpackHalf2x16(floatBitsToUint(proto0.z)),
        unpackHalf2x16(floatBitsToUint(proto0.w))
    );
    uint metadata = uint(round(proto1.y)) | (uint(round(proto1.z)) << 16u);
    bool isActive = (metadata & 0x80000000u) != 0u;
    uint paletteBase = aPaletteIndex * 2u;
    vec4 transform0 = paletteTexel(paletteBase);
    vec4 transform1 = paletteTexel(paletteBase + 1u);
    vec2 rotation = unpackHalf2x16(floatBitsToUint(transform1.x));
    vec2 anchor = unpackHalf2x16(floatBitsToUint(transform1.y));
    vec2 localPosition = (instanceRect.xy + aVertex * instanceRect.zw - anchor)
        * transform0.zw;
    vec2 rotatedPosition = vec2(
        localPosition.x * rotation.y - localPosition.y * rotation.x,
        localPosition.x * rotation.x + localPosition.y * rotation.y
    );
    localPosition = rotatedPosition + transform0.xy;
    vec3 projected = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix
        * vec3(localPosition, 1.0);
    gl_Position = isActive ? vec4(projected.xy, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
    vUv = mix(instanceUv.xy, instanceUv.zw, aVertex);
    vWorldColor = uWorldColorAlpha * uColor;
    vMode = (metadata >> 16u) & 3u;
    uint aux = uint(round(transform1.w));
    vEffects = (aux & 65536u) != 0u
        ? paletteTexel(uint(uEffectBase) + aPaletteIndex)
        : vec4(0.0);
    vUvBounds = instanceUv;
    vFill = vec4(unpackRgb(transform1.z), transform1.w);
    vRasterScale = max(float((metadata >> 18u) & 8191u) / 64.0, 1.0);
    vTextureSlot = metadata & 255u;
}
`;

export const GLYPH_FRAGMENT_GLSL = /* glsl */ `
#version 300 es

precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAtlasR;
uniform sampler2DArray uAtlasRGBA;

in vec2 vUv;
in vec4 vWorldColor;
flat in uint vMode;
flat in vec4 vEffects;
flat in vec4 vUvBounds;
flat in vec4 vFill;
flat in float vRasterScale;
flat in uint vTextureSlot;

out vec4 finalColor;

float median3(vec3 value) {
    return max(min(value.r, value.g), min(max(value.r, value.g), value.b));
}

vec3 unpackRgb(float packed) {
    uint value = uint(round(packed));
    return vec3(
        float((value >> 16u) & 255u),
        float((value >> 8u) & 255u),
        float(value & 255u)
    ) / 255.0;
}

vec4 atlasSample(vec2 uv, vec2 uvDx, vec2 uvDy) {
    vec3 coord = vec3(uv, float(vTextureSlot));
    if (vMode == 0u || vMode == 3u) return textureGrad(uAtlasRGBA, coord, uvDx, uvDy);
    return textureGrad(uAtlasR, coord, uvDx, uvDy);
}

vec4 atlasSampleLod(vec2 uv) {
    vec3 coord = vec3(uv, float(vTextureSlot));
    if (vMode == 0u || vMode == 3u) return textureLod(uAtlasRGBA, coord, 0.0);
    return textureLod(uAtlasR, coord, 0.0);
}

vec4 boundedSample(vec2 uv) {
    bool inside = all(greaterThanEqual(uv, vUvBounds.xy))
        && all(lessThanEqual(uv, vUvBounds.zw));
    vec4 sampled = atlasSampleLod(clamp(uv, vUvBounds.xy, vUvBounds.zw));
    return inside ? sampled : vec4(0.0);
}

float coverageAt(vec2 uv, float smoothing) {
    vec4 sampled = boundedSample(uv);
    float distanceValue = vMode == 0u ? median3(sampled.rgb) : sampled.r;
    float distanceCoverage = smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    return vMode == 3u ? sampled.a : distanceCoverage;
}

vec4 premultipliedLayer(vec3 color, float alpha, float coverage) {
    float outputAlpha = alpha * coverage;
    return vec4(color * outputAlpha, outputAlpha);
}

vec4 over(vec4 top, vec4 bottom) {
    return top + bottom * (1.0 - top.a);
}

void main(void) {
    vec4 sampleColor = atlasSample(vUv, dFdx(vUv), dFdy(vUv));
    float distanceValue = vMode == 0u ? median3(sampleColor.rgb) : sampleColor.r;
    float smoothing = max(fwidth(distanceValue), 1.0 / 255.0);
    float fillCoverage = vMode == 3u
        ? sampleColor.a
        : smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    uint fillAlphaPacked = uint(round(vFill.a));
    float fillAlpha = float(fillAlphaPacked & 255u) / 255.0;
    float labelAlpha = float((fillAlphaPacked >> 8u) & 255u) / 255.0;
    vec4 fillTint = vec4(vFill.rgb * fillAlpha, fillAlpha);
    vec4 fill = vMode == 3u
        ? sampleColor * fillTint
        : vec4(fillTint.rgb * fillCoverage, fillTint.a * fillCoverage);
    vec2 atlasSize = (vMode == 0u || vMode == 3u)
        ? vec2(textureSize(uAtlasRGBA, 0).xy)
        : vec2(textureSize(uAtlasR, 0).xy);
    vec2 texel = vRasterScale / atlasSize;

    uint shadowPacked = uint(round(vEffects.w));
    uint strokePacked = uint(round(vEffects.y));
    uint shadowAlphaBits = ((strokePacked >> 20u) & 15u) | (((shadowPacked >> 20u) & 15u) << 4u);
    float shadowAlpha = float(shadowAlphaBits) / 255.0;
    vec4 composed = vec4(0.0);
    if (shadowAlpha > 0.0) {
        vec2 shadowOffset = vec2(
            float(int(shadowPacked & 255u) - 128),
            float(int((shadowPacked >> 8u) & 255u) - 128)
        ) * 0.25;
        float blur = float((shadowPacked >> 16u) & 15u);
        vec2 sourceUv = vUv - shadowOffset * texel;
        float shadowCoverage = coverageAt(sourceUv, smoothing);
        if (blur > 0.0) {
            vec2 blurUv = texel * blur;
            shadowCoverage = (
                shadowCoverage
                + coverageAt(sourceUv + vec2(blurUv.x, 0.0), smoothing)
                + coverageAt(sourceUv - vec2(blurUv.x, 0.0), smoothing)
                + coverageAt(sourceUv + vec2(0.0, blurUv.y), smoothing)
                + coverageAt(sourceUv - vec2(0.0, blurUv.y), smoothing)
            ) * 0.2;
        }
        composed = premultipliedLayer(unpackRgb(vEffects.z), shadowAlpha, shadowCoverage);
    }

    float strokeWidth = float(strokePacked & 4095u) / 16.0;
    float strokeAlpha = float((strokePacked >> 12u) & 255u) / 255.0;
    if (strokeWidth > 0.0 && strokeAlpha > 0.0) {
        vec2 radius = texel * strokeWidth;
        vec2 diagonal = radius * 0.70710678118;
        float expanded = fillCoverage;
        expanded = max(expanded, coverageAt(vUv + vec2(radius.x, 0.0), smoothing));
        expanded = max(expanded, coverageAt(vUv - vec2(radius.x, 0.0), smoothing));
        expanded = max(expanded, coverageAt(vUv + vec2(0.0, radius.y), smoothing));
        expanded = max(expanded, coverageAt(vUv - vec2(0.0, radius.y), smoothing));
        expanded = max(expanded, coverageAt(vUv + diagonal, smoothing));
        expanded = max(expanded, coverageAt(vUv - diagonal, smoothing));
        expanded = max(expanded, coverageAt(vUv + vec2(diagonal.x, -diagonal.y), smoothing));
        expanded = max(expanded, coverageAt(vUv + vec2(-diagonal.x, diagonal.y), smoothing));
        float strokeCoverage = max(0.0, expanded - fillCoverage);
        vec4 stroke = premultipliedLayer(unpackRgb(vEffects.x), strokeAlpha, strokeCoverage);
        composed = over(stroke, composed);
    }

    finalColor = over(fill, composed) * labelAlpha * vWorldColor;
}
`;

const GLYPH_SHADER_WGSL_TEXTURE = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
};

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
};

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@group(2) @binding(0) var uAtlasR: texture_2d_array<f32>;
@group(2) @binding(1) var uAtlasRGBA: texture_2d_array<f32>;
@group(2) @binding(2) var uSampler: sampler;
@group(2) @binding(3) var uTransformTexture: texture_2d<f32>;

struct GlyphUniforms {
    uPaletteWidth: f32,
    uEffectBase: f32,
};

@group(2) @binding(4) var<uniform> glyphUniforms: GlyphUniforms;
@group(2) @binding(5) var uPrototype: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) worldColor: vec4<f32>,
    @location(2) @interpolate(flat) mode: u32,
    @location(3) @interpolate(flat) effects: vec4<f32>,
    @location(4) @interpolate(flat) uvBounds: vec4<f32>,
    @location(5) @interpolate(flat) fill: vec4<f32>,
    @location(6) @interpolate(flat) rasterScale: f32,
    @location(7) @interpolate(flat) textureSlot: u32,
};

fn paletteIndex(linear: u32, width: u32) -> vec2<i32> {
    return vec2<i32>(i32(linear % width), i32(linear / width));
}

fn protoFetch(proto: u32, texelOffset: u32) -> vec4<f32> {
    let width = textureDimensions(uPrototype).x;
    let texel = proto * 2u + texelOffset;
    return textureLoad(uPrototype, paletteIndex(texel, width), 0);
}

@vertex
fn mainVertex(
    @location(0) aVertex: vec2<f32>,
    @location(1) aProtoIndex: u32,
    @location(2) aPaletteIndex: u32,
) -> VertexOutput {
    let proto0 = protoFetch(aProtoIndex, 0u);
    let proto1 = protoFetch(aProtoIndex, 1u);
    let instanceRect = vec4<f32>(
        unpack2x16float(bitcast<u32>(proto0.x)),
        unpack2x16float(bitcast<u32>(proto0.y)),
    );
    let instanceUv = vec4<f32>(
        unpack2x16float(bitcast<u32>(proto0.z)),
        unpack2x16float(bitcast<u32>(proto0.w)),
    );
    let metadata = u32(round(proto1.y)) | (u32(round(proto1.z)) << 16u);
    let isActive = (metadata & 0x80000000u) != 0u;
    let paletteWidth = u32(glyphUniforms.uPaletteWidth);
    let paletteBase = aPaletteIndex * 2u;
    let transform0 = textureLoad(uTransformTexture, paletteIndex(paletteBase, paletteWidth), 0);
    let transform1 = textureLoad(uTransformTexture, paletteIndex(paletteBase + 1u, paletteWidth), 0);
    let rotation = unpack2x16float(bitcast<u32>(transform1.x));
    let anchor = unpack2x16float(bitcast<u32>(transform1.y));
    let aux = u32(round(transform1.w));
    let effects = select(
        vec4<f32>(0.0),
        textureLoad(
            uTransformTexture,
            paletteIndex(u32(glyphUniforms.uEffectBase) + aPaletteIndex, paletteWidth),
            0,
        ),
        (aux & 65536u) != 0u,
    );
    var localPosition = (instanceRect.xy + aVertex * instanceRect.zw - anchor)
        * transform0.zw;
    localPosition = vec2<f32>(
        localPosition.x * rotation.y - localPosition.y * rotation.x,
        localPosition.x * rotation.x + localPosition.y * rotation.y,
    ) + transform0.xy;
    let projected = globalUniforms.uProjectionMatrix
        * globalUniforms.uWorldTransformMatrix
        * localUniforms.uTransformMatrix
        * vec3<f32>(localPosition, 1.0);
    var clip = vec4<f32>(projected.xy, 0.0, 1.0);
    if (!isActive) {
        clip = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    }
    return VertexOutput(
        clip,
        mix(instanceUv.xy, instanceUv.zw, aVertex),
        globalUniforms.uWorldColorAlpha * localUniforms.uColor,
        (metadata >> 16u) & 3u,
        effects,
        instanceUv,
        vec4<f32>(unpackRgb(transform1.z), transform1.w),
        max(f32((metadata >> 18u) & 8191u) / 64.0, 1.0),
        metadata & 255u,
    );
}

fn median3(value: vec3<f32>) -> f32 {
    return max(min(value.r, value.g), min(max(value.r, value.g), value.b));
}

fn unpackRgb(packed: f32) -> vec3<f32> {
    let value = u32(round(packed));
    return vec3<f32>(
        f32((value >> 16u) & 255u),
        f32((value >> 8u) & 255u),
        f32(value & 255u),
    ) / 255.0;
}

fn atlasSample(
    input: VertexOutput,
    uv: vec2<f32>,
    uvDx: vec2<f32>,
    uvDy: vec2<f32>,
) -> vec4<f32> {
    let layer = i32(input.textureSlot);
    if (input.mode == 0u || input.mode == 3u) {
        return textureSampleGrad(uAtlasRGBA, uSampler, uv, layer, uvDx, uvDy);
    }
    return textureSampleGrad(uAtlasR, uSampler, uv, layer, uvDx, uvDy);
}

fn atlasSampleLevel(input: VertexOutput, uv: vec2<f32>) -> vec4<f32> {
    let layer = i32(input.textureSlot);
    if (input.mode == 0u || input.mode == 3u) {
        return textureSampleLevel(uAtlasRGBA, uSampler, uv, layer, 0.0);
    }
    return textureSampleLevel(uAtlasR, uSampler, uv, layer, 0.0);
}

fn boundedSample(input: VertexOutput, uv: vec2<f32>) -> vec4<f32> {
    let inside = all(uv >= input.uvBounds.xy) && all(uv <= input.uvBounds.zw);
    let sampled = atlasSampleLevel(input, clamp(uv, input.uvBounds.xy, input.uvBounds.zw));
    return select(vec4<f32>(0.0), sampled, inside);
}

fn coverageAt(input: VertexOutput, uv: vec2<f32>, smoothing: f32) -> f32 {
    let sampled = boundedSample(input, uv);
    let distanceValue = select(sampled.r, median3(sampled.rgb), input.mode == 0u);
    let distanceCoverage = smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    return select(distanceCoverage, sampled.a, input.mode == 3u);
}

fn premultipliedLayer(color: vec3<f32>, alpha: f32, coverage: f32) -> vec4<f32> {
    let outputAlpha = alpha * coverage;
    return vec4<f32>(color * outputAlpha, outputAlpha);
}

fn over(top: vec4<f32>, bottom: vec4<f32>) -> vec4<f32> {
    return top + bottom * (1.0 - top.a);
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    let sampleColor = atlasSample(input, input.uv, dpdx(input.uv), dpdy(input.uv));
    let distanceValue = select(sampleColor.r, median3(sampleColor.rgb), input.mode == 0u);
    let smoothing = max(fwidth(distanceValue), 1.0 / 255.0);
    let distanceCoverage = smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    let fillCoverage = select(distanceCoverage, sampleColor.a, input.mode == 3u);
    let fillAlphaPacked = u32(round(input.fill.a));
    let fillAlpha = f32(fillAlphaPacked & 255u) / 255.0;
    let labelAlpha = f32((fillAlphaPacked >> 8u) & 255u) / 255.0;
    let fillTint = vec4<f32>(input.fill.rgb * fillAlpha, fillAlpha);
    let distanceColor = vec4<f32>(
        fillTint.rgb * fillCoverage,
        fillTint.a * fillCoverage,
    );
    let fill = select(distanceColor, sampleColor * fillTint, input.mode == 3u);
    let atlasSize = select(
        vec2<f32>(textureDimensions(uAtlasR)),
        vec2<f32>(textureDimensions(uAtlasRGBA)),
        input.mode == 0u || input.mode == 3u,
    );
    let texel = input.rasterScale / atlasSize;

    let shadowPacked = u32(round(input.effects.w));
    let strokePacked = u32(round(input.effects.y));
    let shadowAlphaBits = ((strokePacked >> 20u) & 15u)
        | (((shadowPacked >> 20u) & 15u) << 4u);
    let shadowAlpha = f32(shadowAlphaBits) / 255.0;
    var composed = vec4<f32>(0.0);
    if (shadowAlpha > 0.0) {
        let shadowOffset = vec2<f32>(
            f32(i32(shadowPacked & 255u) - 128),
            f32(i32((shadowPacked >> 8u) & 255u) - 128),
        ) * 0.25;
        let blur = f32((shadowPacked >> 16u) & 15u);
        let sourceUv = input.uv - shadowOffset * texel;
        var shadowCoverage = coverageAt(input, sourceUv, smoothing);
        if (blur > 0.0) {
            let blurUv = texel * blur;
            shadowCoverage = (
                shadowCoverage
                + coverageAt(input, sourceUv + vec2<f32>(blurUv.x, 0.0), smoothing)
                + coverageAt(input, sourceUv - vec2<f32>(blurUv.x, 0.0), smoothing)
                + coverageAt(input, sourceUv + vec2<f32>(0.0, blurUv.y), smoothing)
                + coverageAt(input, sourceUv - vec2<f32>(0.0, blurUv.y), smoothing)
            ) * 0.2;
        }
        composed = premultipliedLayer(unpackRgb(input.effects.z), shadowAlpha, shadowCoverage);
    }

    let strokeWidth = f32(strokePacked & 4095u) / 16.0;
    let strokeAlpha = f32((strokePacked >> 12u) & 255u) / 255.0;
    if (strokeWidth > 0.0 && strokeAlpha > 0.0) {
        let radius = texel * strokeWidth;
        let diagonal = radius * 0.70710678118;
        var expanded = fillCoverage;
        expanded = max(expanded, coverageAt(input, input.uv + vec2<f32>(radius.x, 0.0), smoothing));
        expanded = max(expanded, coverageAt(input, input.uv - vec2<f32>(radius.x, 0.0), smoothing));
        expanded = max(expanded, coverageAt(input, input.uv + vec2<f32>(0.0, radius.y), smoothing));
        expanded = max(expanded, coverageAt(input, input.uv - vec2<f32>(0.0, radius.y), smoothing));
        expanded = max(expanded, coverageAt(input, input.uv + diagonal, smoothing));
        expanded = max(expanded, coverageAt(input, input.uv - diagonal, smoothing));
        expanded = max(
            expanded,
            coverageAt(input, input.uv + vec2<f32>(diagonal.x, -diagonal.y), smoothing),
        );
        expanded = max(
            expanded,
            coverageAt(input, input.uv + vec2<f32>(-diagonal.x, diagonal.y), smoothing),
        );
        let strokeCoverage = max(0.0, expanded - fillCoverage);
        let stroke = premultipliedLayer(unpackRgb(input.effects.x), strokeAlpha, strokeCoverage);
        composed = over(stroke, composed);
    }

    return over(fill, composed) * labelAlpha * input.worldColor;
}
`;

const GLYPH_SHADER_WGSL_STORAGE = GLYPH_SHADER_WGSL_TEXTURE.replace(
  "@group(2) @binding(3) var uTransformTexture: texture_2d<f32>;",
  "@group(2) @binding(3) var<storage, read> uTransforms: array<vec4<f32>>;",
)
  .replace(
    "    let paletteWidth = u32(glyphUniforms.uPaletteWidth);\n    let paletteBase = aPaletteIndex * 2u;\n    let transform0 = textureLoad(uTransformTexture, paletteIndex(paletteBase, paletteWidth), 0);\n    let transform1 = textureLoad(uTransformTexture, paletteIndex(paletteBase + 1u, paletteWidth), 0);",
    "    let paletteBase = aPaletteIndex * 2u;\n    let transform0 = uTransforms[paletteBase];\n    let transform1 = uTransforms[paletteBase + 1u];",
  )
  .replace(
    `        textureLoad(
            uTransformTexture,
            paletteIndex(u32(glyphUniforms.uEffectBase) + aPaletteIndex, paletteWidth),
            0,
        )`,
    "        uTransforms[u32(glyphUniforms.uEffectBase) + aPaletteIndex]",
  );

export const GLYPH_SHADER_WGSL = GLYPH_SHADER_WGSL_TEXTURE;

export function glyphShaderWgsl(path: PalettePath): string {
  switch (path) {
    case "texture":
      return GLYPH_SHADER_WGSL_TEXTURE;
    case "storage":
      return GLYPH_SHADER_WGSL_STORAGE;
    default: {
      const _exhaustive: never = path;
      return _exhaustive;
    }
  }
}
