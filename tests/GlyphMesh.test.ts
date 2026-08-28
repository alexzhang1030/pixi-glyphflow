import { describe, expect, test } from "bun:test";

import { GpuProgram, Shader, Texture } from "pixi.js";

import {
  GLYPH_ATLAS_ARRAY_LAYERS,
  GLYPH_DRAW_STRIDE,
  GLYPH_TEXTURE_BANK_SIZE,
  GlyphMesh,
} from "../src/advanced";
import {
  GLYPH_FRAGMENT_GLSL,
  GLYPH_SHADER_WGSL,
  GLYPH_VERTEX_GLSL,
  glyphShaderWgsl,
} from "../src/render/shaders";

function meshOptions(
  overrides: Partial<ConstructorParameters<typeof GlyphMesh>[0]> = {},
): ConstructorParameters<typeof GlyphMesh>[0] {
  return {
    texture: Texture.WHITE,
    paletteTexture: Texture.WHITE,
    paletteWidth: 1,
    prototypeTexture: Texture.WHITE,
    prototypeWidth: 1,
    instanceData: new ArrayBuffer(32),
    instanceCount: 0,
    ...overrides,
  };
}

describe("GlyphMesh", () => {
  test("bounds the public atlas arrays", () => {
    expect(() => new GlyphMesh(meshOptions({ textures: [] }))).toThrow(
      "atlas arrays must contain between 1 and 2 textures",
    );

    expect(
      () =>
        new GlyphMesh(
          meshOptions({
            textures: Array.from({ length: GLYPH_TEXTURE_BANK_SIZE + 1 }, () => Texture.WHITE),
          }),
        ),
    ).toThrow("atlas arrays must contain between 1 and 2 textures");
  });

  test("builds one instanced quad geometry for WebGL and WebGPU", () => {
    const draw = new ArrayBuffer(GLYPH_DRAW_STRIDE * 2);
    const mesh = new GlyphMesh({
      ...meshOptions({ instanceData: draw, instanceCount: 2 }),
      shader: new Shader({
        gpuProgram: GpuProgram.from({
          vertex: { source: GLYPH_SHADER_WGSL, entryPoint: "mainVertex" },
          fragment: { source: GLYPH_SHADER_WGSL, entryPoint: "mainFragment" },
        }),
        resources: {
          uAtlasR: Texture.WHITE.source,
          uAtlasRGBA: Texture.WHITE.source,
          uSampler: Texture.WHITE.source.style,
          uTransformTexture: Texture.WHITE.source,
          uPrototype: Texture.WHITE.source,
          glyphUniforms: {
            uPaletteWidth: { value: 1, type: "f32" },
            uEffectBase: { value: 0, type: "f32" },
          },
        },
      }),
    });

    expect(mesh.geometry.instanceCount).toBe(2);
    expect(mesh.geometry.getAttribute("aProtoIndex")).toMatchObject({
      format: "uint32",
      stride: 8,
      offset: 0,
      instance: true,
    });
    expect(mesh.geometry.getAttribute("aPaletteIndex")).toMatchObject({
      format: "uint32",
      stride: 8,
      offset: 4,
      instance: true,
    });
    expect(mesh.geometry.getAttribute("aInstanceRect")).toBeUndefined();
    expect(mesh.shader?.compatibleRenderers).toBe(2);

    const replacement = new ArrayBuffer(GLYPH_DRAW_STRIDE * 4);
    mesh.updateInstances(replacement, 4);
    expect(mesh.geometry.instanceCount).toBe(4);
    expect(mesh.instanceBuffer.data.buffer).toBe(replacement);

    mesh.destroy();
  });

  test("owns the atlas sampler so destroying a page cannot null the bind", () => {
    const mesh = new GlyphMesh({
      ...meshOptions(),
      shader: new Shader({
        gpuProgram: GpuProgram.from({
          vertex: { source: GLYPH_SHADER_WGSL, entryPoint: "mainVertex" },
          fragment: { source: GLYPH_SHADER_WGSL, entryPoint: "mainFragment" },
        }),
        resources: {
          uAtlasR: Texture.WHITE.source,
          uAtlasRGBA: Texture.WHITE.source,
          uSampler: Texture.WHITE.source.style,
          uTransformTexture: Texture.WHITE.source,
          uPrototype: Texture.WHITE.source,
          glyphUniforms: {
            uPaletteWidth: { value: 1, type: "f32" },
            uEffectBase: { value: 0, type: "f32" },
          },
        },
      }),
    });
    mesh.setTextures([Texture.WHITE, Texture.WHITE]);
    expect(mesh.shader?.resources.uSampler).not.toBe(mesh.texture.source.style);
    mesh.destroy();
  });

  test("keeps the prototype sampler after a palette rebind", () => {
    const prototypeTexture = Texture.WHITE;
    const mesh = new GlyphMesh({
      ...meshOptions({ prototypeTexture }),
      shader: new Shader({
        gpuProgram: GpuProgram.from({
          vertex: { source: GLYPH_SHADER_WGSL, entryPoint: "mainVertex" },
          fragment: { source: GLYPH_SHADER_WGSL, entryPoint: "mainFragment" },
        }),
        resources: {
          uAtlasR: Texture.WHITE.source,
          uAtlasRGBA: Texture.WHITE.source,
          uSampler: Texture.WHITE.source.style,
          uTransformTexture: Texture.WHITE.source,
          uPrototype: prototypeTexture.source,
          glyphUniforms: {
            uPaletteWidth: { value: 1, type: "f32" },
            uEffectBase: { value: 0, type: "f32" },
          },
        },
      }),
    });
    mesh.setPaletteTexture(Texture.WHITE, 2, 4);
    expect(mesh.shader?.resources.uPrototype).toBe(prototypeTexture.source);
    mesh.destroy();
  });

  test("keeps equivalent distance-field and color branches in paired shader sources", () => {
    expect(GLYPH_VERTEX_GLSL).toContain("uint aProtoIndex");
    expect(GLYPH_VERTEX_GLSL).toContain("protoFetch(aProtoIndex");
    expect(GLYPH_VERTEX_GLSL).toContain("uint(round(proto1.y))");
    expect(GLYPH_SHADER_WGSL).toContain("aProtoIndex: u32");
    expect(GLYPH_SHADER_WGSL).toContain("fn protoFetch");
    expect(GLYPH_SHADER_WGSL).toContain("u32(round(proto1.y))");
    expect(GLYPH_VERTEX_GLSL).toContain("uTransformTexture");
    expect(GLYPH_VERTEX_GLSL).toContain("uPrototype");
    expect(GLYPH_VERTEX_GLSL).toContain("textureSize(uPrototype");
    expect(GLYPH_VERTEX_GLSL).toContain("uEffectBase");
    expect(GLYPH_VERTEX_GLSL).toContain("unpackHalf2x16");
    expect(GLYPH_VERTEX_GLSL).toContain("vRasterScale");
    expect(GLYPH_VERTEX_GLSL).toContain("metadata & 255u");
    expect(GLYPH_FRAGMENT_GLSL).toContain("median3");
    expect(GLYPH_FRAGMENT_GLSL).toContain("precision highp sampler2DArray");
    expect(GLYPH_FRAGMENT_GLSL).toContain("uniform sampler2DArray uAtlasR");
    expect(GLYPH_FRAGMENT_GLSL).toContain("uniform sampler2DArray uAtlasRGBA");
    expect(GLYPH_FRAGMENT_GLSL).toContain("textureSize(uAtlasR, 0).xy");
    expect(GLYPH_FRAGMENT_GLSL).toContain("vMode == 3u");
    expect(GLYPH_SHADER_WGSL).toContain("fn median3");
    expect(GLYPH_SHADER_WGSL).toContain("uEffectBase");
    expect(GLYPH_SHADER_WGSL).toContain("unpack2x16float");
    expect(GLYPH_SHADER_WGSL).toContain("textureLoad(uTransformTexture");
    expect(glyphShaderWgsl("texture")).toContain("var uTransformTexture: texture_2d<f32>");
    expect(glyphShaderWgsl("texture")).toContain("textureLoad(uTransformTexture");
    expect(glyphShaderWgsl("storage")).toContain(
      "var<storage, read> uTransforms: array<vec4<f32>>",
    );
    expect(glyphShaderWgsl("storage")).toContain("uTransforms[paletteBase]");
    expect(glyphShaderWgsl("storage")).not.toContain("textureLoad(uTransformTexture");
    expect(glyphShaderWgsl("storage")).not.toContain("var uTransformTexture");
    expect(GLYPH_SHADER_WGSL).toContain("var uPrototype");
    expect(GLYPH_SHADER_WGSL).toContain("@group(2) @binding(0) var uAtlasR: texture_2d_array");
    expect(GLYPH_SHADER_WGSL).toContain("@group(2) @binding(1) var uAtlasRGBA: texture_2d_array");
    expect(GLYPH_SHADER_WGSL).toContain("metadata & 255u");
    expect(GLYPH_SHADER_WGSL).toContain("input.mode == 3u");
    expect(GLYPH_TEXTURE_BANK_SIZE).toBe(2);
    expect(GLYPH_ATLAS_ARRAY_LAYERS).toBe(256);
    expect(GLYPH_DRAW_STRIDE).toBe(8);
  });
});
