export const GLYPH_VERTEX_GLSL = /* glsl */ `
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

out vec2 vUv;
out vec4 vColor;
flat out uint vMode;

void main(void) {
    bool active = (aMetadata & 0x80000000u) != 0u;
    vec2 localPosition = aInstanceRect.xy + aVertex * aInstanceRect.zw;
    vec3 projected = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix
        * vec3(localPosition, 1.0);
    gl_Position = active ? vec4(projected.xy, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
    vUv = mix(aInstanceUv.xy, aInstanceUv.zw, aVertex);
    vColor = uWorldColorAlpha * uColor;
    vMode = (aMetadata >> 16u) & 3u;
}
`;

export const GLYPH_FRAGMENT_GLSL = /* glsl */ `
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
    let active = (aMetadata & 0x80000000u) != 0u;
    let localPosition = aInstanceRect.xy + aVertex * aInstanceRect.zw;
    let projected = globalUniforms.uProjectionMatrix
        * globalUniforms.uWorldTransformMatrix
        * localUniforms.uTransformMatrix
        * vec3<f32>(localPosition, 1.0);
    var clip = vec4<f32>(projected.xy, 0.0, 1.0);
    if (!active) {
        clip = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    }
    let paletteGuard = f32(aPaletteIndex & 0u);
    return VertexOutput(
        clip,
        mix(aInstanceUv.xy, aInstanceUv.zw, aVertex),
        globalUniforms.uWorldColorAlpha * localUniforms.uColor + vec4<f32>(paletteGuard),
        (aMetadata >> 16u) & 3u,
    );
}

fn median3(value: vec3<f32>) -> f32 {
    return max(min(value.r, value.g), min(max(value.r, value.g), value.b));
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    let sampleColor = textureSample(uTexture, uSampler, input.uv);
    if (input.mode == 3u) {
        return sampleColor * input.color;
    }
    var distanceValue = sampleColor.r;
    if (input.mode == 0u) {
        distanceValue = median3(sampleColor.rgb);
    }
    let smoothing = max(fwidth(distanceValue), 1.0 / 255.0);
    let coverage = smoothstep(0.5 - smoothing, 0.5 + smoothing, distanceValue);
    return vec4<f32>(input.color.rgb * coverage, input.color.a * coverage);
}
`;
