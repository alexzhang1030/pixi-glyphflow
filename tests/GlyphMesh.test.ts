import { describe, expect, test } from "bun:test";

import { GpuProgram, Shader, Texture } from "pixi.js";

import { GlyphInstanceStore, GlyphMesh } from "../src/advanced";
import { GLYPH_FRAGMENT_GLSL, GLYPH_SHADER_WGSL, GLYPH_VERTEX_GLSL } from "../src/render/shaders";

describe("GlyphMesh", () => {
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
          uTexture: Texture.WHITE.source,
          uSampler: Texture.WHITE.source.style,
        },
      }),
    });

    expect(mesh.geometry.instanceCount).toBe(2);
    expect(mesh.geometry.getAttribute("aInstanceRect")).toMatchObject({
      format: "float32x4",
      stride: 32,
      offset: 0,
      instance: true,
    });
    expect(mesh.geometry.getAttribute("aInstanceUv")).toMatchObject({
      format: "unorm16x4",
      stride: 32,
      offset: 16,
      instance: true,
    });
    expect(mesh.shader?.compatibleRenderers).toBe(2);

    const replacement = new ArrayBuffer(32 * 4);
    mesh.updateInstances(replacement, 4);
    expect(mesh.geometry.instanceCount).toBe(4);
    expect(mesh.instanceBuffer.data.buffer).toBe(replacement);

    mesh.destroy();
    instances.destroy();
  });

  test("keeps equivalent distance-field and color branches in paired shader sources", () => {
    expect(GLYPH_VERTEX_GLSL).toContain("aInstanceRect");
    expect(GLYPH_VERTEX_GLSL).toContain("uTransformTexture");
    expect(GLYPH_VERTEX_GLSL).toContain("vRasterScale");
    expect(GLYPH_FRAGMENT_GLSL).toContain("median3");
    expect(GLYPH_FRAGMENT_GLSL).toContain("vRasterScale / vec2(textureSize");
    expect(GLYPH_FRAGMENT_GLSL).toContain("vMode == 3u");
    expect(GLYPH_SHADER_WGSL).toContain("fn median3");
    expect(GLYPH_SHADER_WGSL).toContain("textureLoad(uTransformTexture");
    expect(GLYPH_SHADER_WGSL).toContain("input.rasterScale / vec2<f32>(textureDimensions");
    expect(GLYPH_SHADER_WGSL).toContain("input.mode == 3u");
  });
});
