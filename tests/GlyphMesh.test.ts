import { describe, expect, test } from "bun:test";

import { GpuProgram, Shader, Texture } from "pixi.js";

import { GLYPH_TEXTURE_BANK_SIZE, GlyphInstanceStore, GlyphMesh } from "../src/advanced";
import { GLYPH_FRAGMENT_GLSL, GLYPH_SHADER_WGSL, GLYPH_VERTEX_GLSL } from "../src/render/shaders";

describe("GlyphMesh", () => {
  test("bounds the public atlas texture bank", () => {
    expect(
      () =>
        new GlyphMesh({
          texture: Texture.WHITE,
          textures: [],
          paletteTexture: Texture.WHITE,
          paletteWidth: 1,
          instanceData: new ArrayBuffer(32),
          instanceCount: 0,
        }),
    ).toThrow("texture bank must contain between 1 and 8 textures");

    expect(
      () =>
        new GlyphMesh({
          texture: Texture.WHITE,
          textures: Array.from({ length: GLYPH_TEXTURE_BANK_SIZE + 1 }, () => Texture.WHITE),
          paletteTexture: Texture.WHITE,
          paletteWidth: 1,
          instanceData: new ArrayBuffer(32),
          instanceCount: 0,
        }),
    ).toThrow("texture bank must contain between 1 and 8 textures");
  });

  test("builds one instanced quad geometry for WebGL and WebGPU", () => {
    const instances = new GlyphInstanceStore({ initialCapacity: 2 });
    instances.set(1, {
      positions: new Float32Array([0, 0, 10, 12, 10, 0, 8, 12]),
      uvs: new Float32Array([0, 0, 0.5, 1, 0.5, 0, 1, 1]),
      paletteIndices: new Uint32Array([0, 1]),
      pages: new Uint16Array([0, 0]),
      modes: new Uint8Array([0, 2]),
    });
    const mesh = new GlyphMesh({
      texture: Texture.WHITE,
      paletteTexture: Texture.WHITE,
      paletteWidth: 1,
      instanceData: instances.buffer,
      instanceCount: 2,
      shader: new Shader({
        gpuProgram: GpuProgram.from({
          vertex: { source: GLYPH_SHADER_WGSL, entryPoint: "mainVertex" },
          fragment: { source: GLYPH_SHADER_WGSL, entryPoint: "mainFragment" },
        }),
        resources: {
          uTexture0: Texture.WHITE.source,
          uTexture1: Texture.WHITE.source,
          uTexture2: Texture.WHITE.source,
          uTexture3: Texture.WHITE.source,
          uTexture4: Texture.WHITE.source,
          uTexture5: Texture.WHITE.source,
          uTexture6: Texture.WHITE.source,
          uTexture7: Texture.WHITE.source,
          uSampler: Texture.WHITE.source.style,
          uTransformTexture: Texture.WHITE.source,
          glyphUniforms: {
            uPaletteWidth: { value: 1, type: "f32" },
          },
        },
      }),
    });

    expect(mesh.geometry.instanceCount).toBe(2);
    expect(mesh.geometry.getAttribute("aInstanceRect")).toMatchObject({
      format: "float16x4",
      stride: 24,
      offset: 0,
      instance: true,
    });
    expect(mesh.geometry.getAttribute("aInstanceUv")).toMatchObject({
      format: "unorm16x4",
      stride: 24,
      offset: 8,
      instance: true,
    });
    expect(mesh.shader?.compatibleRenderers).toBe(2);

    const replacement = new ArrayBuffer(24 * 4);
    mesh.updateInstances(replacement, 4);
    expect(mesh.geometry.instanceCount).toBe(4);
    expect(mesh.instanceBuffer.data.buffer).toBe(replacement);

    mesh.destroy();
    instances.destroy();
  });

  test("keeps equivalent distance-field and color branches in paired shader sources", () => {
    expect(GLYPH_VERTEX_GLSL).toContain("aInstanceRect");
    expect(GLYPH_VERTEX_GLSL).toContain("uTransformTexture");
    expect(GLYPH_VERTEX_GLSL).toContain("uEffectBase");
    expect(GLYPH_VERTEX_GLSL).toContain("unpackHalf2x16");
    expect(GLYPH_VERTEX_GLSL).toContain("vRasterScale");
    expect(GLYPH_FRAGMENT_GLSL).toContain("median3");
    expect(GLYPH_FRAGMENT_GLSL).toContain("vRasterScale / vec2(textureSize");
    expect(GLYPH_FRAGMENT_GLSL).toContain("uniform sampler2D uTexture7");
    expect(GLYPH_FRAGMENT_GLSL).toContain("vTextureSlot == 6u");
    expect(GLYPH_FRAGMENT_GLSL).toContain("vMode == 3u");
    expect(GLYPH_SHADER_WGSL).toContain("fn median3");
    expect(GLYPH_SHADER_WGSL).toContain("uEffectBase");
    expect(GLYPH_SHADER_WGSL).toContain("unpack2x16float");
    expect(GLYPH_SHADER_WGSL).toContain("textureLoad(uTransformTexture");
    expect(GLYPH_SHADER_WGSL).toContain("input.rasterScale / vec2<f32>(textureDimensions");
    expect(GLYPH_SHADER_WGSL).toContain("@group(2) @binding(7) var uTexture7");
    expect(GLYPH_SHADER_WGSL).toContain("input.textureSlot == 6u");
    expect(GLYPH_SHADER_WGSL).toContain("input.mode == 3u");
    expect(GLYPH_TEXTURE_BANK_SIZE).toBe(8);
  });
});
