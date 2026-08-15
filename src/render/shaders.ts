export const GLYPH_VERTEX_GLSL = /* glsl */ `
#version 300 es

in vec2 aVertex;
in vec4 aInstanceRect;
in vec4 aInstanceUv;
in uint aPaletteIndex;
in uint aMetadata;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;
uniform sampler2D uTransformTexture;
uniform float uPaletteWidth;

out vec2 vUv;
out vec4 vWorldColor;
flat out uint vMode;
flat out vec4 vEffects;
flat out vec4 vUvBounds;
flat out vec4 vFill;
flat out float vRasterScale;

vec4 paletteTexel(uint index) {
    uint width = uint(uPaletteWidth);
    return texelFetch(uTransformTexture, ivec2(int(index % width), int(index / width)), 0);
}

void main(void) {
    bool isActive = (aMetadata & 0x80000000u) != 0u;
    uint paletteBase = aPaletteIndex * 4u;
    vec4 transform0 = paletteTexel(paletteBase);
    vec4 transform1 = paletteTexel(paletteBase + 1u);
    vec4 paletteColor = paletteTexel(paletteBase + 2u);
    vec2 localPosition = (aInstanceRect.xy + aVertex * aInstanceRect.zw - transform1.zw)
        * transform0.zw;
    vec2 rotatedPosition = vec2(
        localPosition.x * transform1.y - localPosition.y * transform1.x,
        localPosition.x * transform1.x + localPosition.y * transform1.y
    );
    localPosition = rotatedPosition + transform0.xy;
    vec3 projected = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix
        * vec3(localPosition, 1.0);
    gl_Position = isActive ? vec4(projected.xy, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
    vUv = mix(aInstanceUv.xy, aInstanceUv.zw, aVertex);
    vWorldColor = uWorldColorAlpha * uColor;
    vMode = (aMetadata >> 16u) & 3u;
    vEffects = paletteTexel(paletteBase + 3u);
    vUvBounds = aInstanceUv;
    vFill = paletteColor;
    vRasterScale = max(float((aMetadata >> 18u) & 8191u) / 64.0, 1.0);
}
`;

export const GLYPH_FRAGMENT_GLSL = /* glsl */ `
#version 300 es

precision highp float;
precision highp int;

uniform sampler2D uTexture;

in vec2 vUv;
in vec4 vWorldColor;
flat in uint vMode;
flat in vec4 vEffects;
flat in vec4 vUvBounds;
flat in vec4 vFill;
flat in float vRasterScale;

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

vec4 boundedSample(vec2 uv) {
    bool inside = all(greaterThanEqual(uv, vUvBounds.xy))
        && all(lessThanEqual(uv, vUvBounds.zw));
    vec4 sampled = textureLod(uTexture, clamp(uv, vUvBounds.xy, vUvBounds.zw), 0.0);
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
    vec4 sampleColor = texture(uTexture, vUv);
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
    vec2 texel = vRasterScale / vec2(textureSize(uTexture, 0));

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

export const GLYPH_SHADER_WGSL = /* wgsl */ `
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
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTransformTexture: texture_2d<f32>;

struct GlyphUniforms {
    uPaletteWidth: f32,
};

@group(2) @binding(3) var<uniform> glyphUniforms: GlyphUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) worldColor: vec4<f32>,
    @location(2) @interpolate(flat) mode: u32,
    @location(3) @interpolate(flat) effects: vec4<f32>,
    @location(4) @interpolate(flat) uvBounds: vec4<f32>,
    @location(5) @interpolate(flat) fill: vec4<f32>,
    @location(6) @interpolate(flat) rasterScale: f32,
};

fn paletteIndex(linear: u32, width: u32) -> vec2<i32> {
    return vec2<i32>(i32(linear % width), i32(linear / width));
}

@vertex
fn mainVertex(
    @location(0) aVertex: vec2<f32>,
    @location(1) aInstanceRect: vec4<f32>,
    @location(2) aInstanceUv: vec4<f32>,
    @location(3) aPaletteIndex: u32,
    @location(4) aMetadata: u32,
) -> VertexOutput {
    let isActive = (aMetadata & 0x80000000u) != 0u;
    let paletteWidth = u32(glyphUniforms.uPaletteWidth);
    let paletteBase = aPaletteIndex * 4u;
    let transform0 = textureLoad(uTransformTexture, paletteIndex(paletteBase, paletteWidth), 0);
    let transform1 = textureLoad(uTransformTexture, paletteIndex(paletteBase + 1u, paletteWidth), 0);
    let paletteColor = textureLoad(uTransformTexture, paletteIndex(paletteBase + 2u, paletteWidth), 0);
    let effects = textureLoad(uTransformTexture, paletteIndex(paletteBase + 3u, paletteWidth), 0);
    var localPosition = (aInstanceRect.xy + aVertex * aInstanceRect.zw - transform1.zw)
        * transform0.zw;
    localPosition = vec2<f32>(
        localPosition.x * transform1.y - localPosition.y * transform1.x,
        localPosition.x * transform1.x + localPosition.y * transform1.y,
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
        mix(aInstanceUv.xy, aInstanceUv.zw, aVertex),
        globalUniforms.uWorldColorAlpha * localUniforms.uColor,
        (aMetadata >> 16u) & 3u,
        effects,
        aInstanceUv,
        paletteColor,
        max(f32((aMetadata >> 18u) & 8191u) / 64.0, 1.0),
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

fn boundedSample(input: VertexOutput, uv: vec2<f32>) -> vec4<f32> {
    let inside = all(uv >= input.uvBounds.xy) && all(uv <= input.uvBounds.zw);
    let sampled = textureSampleLevel(
        uTexture,
        uSampler,
        clamp(uv, input.uvBounds.xy, input.uvBounds.zw),
        0.0,
    );
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
    let sampleColor = textureSample(uTexture, uSampler, input.uv);
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
    let texel = input.rasterScale / vec2<f32>(textureDimensions(uTexture));

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
