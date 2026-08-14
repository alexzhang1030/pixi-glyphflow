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
out vec4 vColor;
flat out uint vMode;

vec4 paletteTexel(uint index) {
    uint width = uint(uPaletteWidth);
    return texelFetch(uTransformTexture, ivec2(int(index % width), int(index / width)), 0);
}

void main(void) {
    bool isActive = (aMetadata & 0x80000000u) != 0u;
    uint paletteBase = aPaletteIndex * 3u;
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
    vColor = uWorldColorAlpha * uColor * paletteColor;
    vMode = (aMetadata >> 16u) & 3u;
}
`;

export const GLYPH_FRAGMENT_GLSL = /* glsl */ `
#version 300 es

precision highp float;
precision highp int;

uniform sampler2D uTexture;

in vec2 vUv;
in vec4 vColor;
flat in uint vMode;

out vec4 finalColor;

float median3(vec3 value) {
    return max(min(value.r, value.g), min(max(value.r, value.g), value.b));
}

void main(void) {
    vec4 sampleColor = texture(uTexture, vUv);
    if (vMode == 3u) {
        finalColor = sampleColor * vColor;
        return;
    }

    float distanceValue = vMode == 0u ? median3(sampleColor.rgb) : sampleColor.r;
    float smoothing = max(fwidth(distanceValue), 1.0 / 255.0);
    float coverage = smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    finalColor = vec4(vColor.rgb * coverage, vColor.a * coverage);
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
    @location(1) color: vec4<f32>,
    @location(2) @interpolate(flat) mode: u32,
};

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
    let paletteBase = aPaletteIndex * 3u;
    let transform0Index = vec2<i32>(i32(paletteBase % paletteWidth), i32(paletteBase / paletteWidth));
    let transform1Linear = paletteBase + 1u;
    let transform1Index = vec2<i32>(
        i32(transform1Linear % paletteWidth),
        i32(transform1Linear / paletteWidth),
    );
    let colorLinear = paletteBase + 2u;
    let colorIndex = vec2<i32>(i32(colorLinear % paletteWidth), i32(colorLinear / paletteWidth));
    let transform0 = textureLoad(uTransformTexture, transform0Index, 0);
    let transform1 = textureLoad(uTransformTexture, transform1Index, 0);
    let paletteColor = textureLoad(uTransformTexture, colorIndex, 0);
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
        globalUniforms.uWorldColorAlpha * localUniforms.uColor * paletteColor,
        (aMetadata >> 16u) & 3u,
    );
}

fn median3(value: vec3<f32>) -> f32 {
    return max(min(value.r, value.g), min(max(value.r, value.g), value.b));
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    let sampleColor = textureSample(uTexture, uSampler, input.uv);
    let distanceValue = select(sampleColor.r, median3(sampleColor.rgb), input.mode == 0u);
    let smoothing = max(fwidth(distanceValue), 1.0 / 255.0);
    let coverage = smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    let distanceColor = vec4<f32>(input.color.rgb * coverage, input.color.a * coverage);
    return select(distanceColor, sampleColor * input.color, input.mode == 3u);
}
`;
