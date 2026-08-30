import { describe, expect, test } from "bun:test";

import { Buffer, BufferUsage, GpuProgram, Shader, Texture } from "pixi.js";

import {
  GLYPH_ATLAS_ARRAY_LAYERS,
  GLYPH_DRAW_STRIDE,
  GLYPH_TEXTURE_BANK_SIZE,
  GlyphMesh,
} from "../src/advanced";
import { glyphPaletteBindSpec, glyphPaletteResources } from "../src/render/GlyphMesh";
import type { PalettePath } from "../src/render/paletteStorage";
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
      shader: textureShader(),
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
      shader: textureShader(),
    });
    mesh.setTextures([Texture.WHITE, Texture.WHITE]);
    expect(mesh.shader?.resources.uSampler).not.toBe(mesh.texture.source.style);
    mesh.destroy();
  });

  test("keeps the prototype sampler after a palette rebind", () => {
    const prototypeTexture = Texture.WHITE;
    const mesh = new GlyphMesh({
      ...meshOptions({ prototypeTexture }),
      shader: textureShader(prototypeTexture),
    });
    mesh.setPaletteTexture(Texture.WHITE, 2, 4);
    expect(mesh.shader?.resources.uPrototype).toBe(prototypeTexture.source);
    mesh.unbindPaletteTexture();
    expect(mesh.shader?.resources.uTransformTexture).toBe(Texture.EMPTY.source);
    expect(mesh.shader?.resources.uPrototype).toBe(prototypeTexture.source);
    mesh.setPaletteTexture(Texture.WHITE, 2, 4);
    expect(mesh.shader?.resources.uTransformTexture).toBe(Texture.WHITE.source);
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

  test("uses a fill-only storage shader for the GPU-resident lane", () => {
    const resident = glyphShaderWgsl("storage", "resident-fill");

    expect(resident).toContain("var<storage, read> uTransforms: array<vec4<f32>>");
    expect(resident).toContain("let transform0 = uTransforms[paletteBase]");
    expect(resident).toContain("let transform1 = uTransforms[paletteBase + 1u]");
    expect(resident.match(/uTransforms\[/g)).toHaveLength(2);
    expect(resident).toContain("input.mode == 0u || input.mode == 3u");
    expect(resident).toContain("input.mode == 3u");
    expect(resident).toContain("if (fillCoverage == 0.0)");
    expect(resident).toContain("discard;");
    expect(resident).toContain("fillAlphaPacked");
    expect(resident).toContain("labelAlpha");
    expect(resident).toContain("input.worldColor");
    expect(resident).toContain("input.mode == 4u");
    expect(resident).toContain("fill + referenceParity * (1.0 - fill.a)");
    expect(resident).not.toContain("input.effects");
    expect(resident).not.toContain("input.uvBounds");
    expect(resident).not.toContain("input.rasterScale");
    expect(resident).not.toContain("fn coverageAt");
    expect(resident).not.toContain("textureSampleLevel");
    expect(resident).not.toContain("shadowPacked");
    expect(resident).not.toContain("strokePacked");
    expect(glyphShaderWgsl("texture", "resident-fill")).toBe(glyphShaderWgsl("texture"));
    expect(glyphShaderWgsl("texture", "resident-fill-run")).toBe(glyphShaderWgsl("texture"));
  });

  test("moves a single resident prototype into the mesh uniform", () => {
    const resident = glyphShaderWgsl("storage", "resident-fill-single");
    const storage = storageBuffer("pixi-glyphflow-single-prototype-palette");
    const prototype = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

    expect(
      () =>
        new GlyphMesh(
          meshOptions({
            palettePath: "storage",
            paletteStorage: storage,
            shaderVariant: "resident-fill-single",
          }),
        ),
    ).toThrow("single-glyph resident shader requires two prototype texels");

    const restoreDocument = installNullCanvasDocument();
    try {
      const mesh = new GlyphMesh(
        meshOptions({
          palettePath: "storage",
          paletteStorage: storage,
          shaderVariant: "resident-fill-single",
          residentPrototype: prototype,
        }),
      );

      expect(resident).toContain("uResidentProto0: vec4<f32>");
      expect(resident).toContain("uResidentProto1: vec4<f32>");
      expect(resident).toContain("let proto0 = glyphUniforms.uResidentProto0");
      expect(resident).toContain("let proto1 = glyphUniforms.uResidentProto1");
      expect(resident).not.toContain("textureLoad(uPrototype");
      expect(mesh.shader?.resources.glyphUniforms.uniforms.uResidentProto0).toEqual(
        prototype.subarray(0, 4),
      );
      expect(mesh.shader?.resources.glyphUniforms.uniforms.uResidentProto1).toEqual(
        prototype.subarray(4, 8),
      );

      mesh.destroy();
    } finally {
      restoreDocument();
    }
  });

  test("moves a continuous resident prototype run into one fixed uniform array", () => {
    const resident = glyphShaderWgsl("storage", "resident-fill-run");
    const storage = storageBuffer("pixi-glyphflow-run-prototype-palette");
    const prototypes = Float32Array.from({ length: 5 * 8 }, (_, index) => index + 1);

    expect(
      () =>
        new GlyphMesh(
          meshOptions({
            palettePath: "storage",
            paletteStorage: storage,
            shaderVariant: "resident-fill-run",
          }),
        ),
    ).toThrow("resident run shader requires 2 to 8 packed prototypes");
    for (const residentPrototype of [new Float32Array(8), new Float32Array(9 * 8)]) {
      expect(
        () =>
          new GlyphMesh(
            meshOptions({
              palettePath: "storage",
              paletteStorage: storage,
              shaderVariant: "resident-fill-run",
              residentPrototype,
            }),
          ),
      ).toThrow("resident run shader requires 2 to 8 packed prototypes");
    }

    const restoreDocument = installNullCanvasDocument();
    try {
      const mesh = new GlyphMesh(
        meshOptions({
          palettePath: "storage",
          paletteStorage: storage,
          shaderVariant: "resident-fill-run",
          residentPrototype: prototypes,
          residentPrototypeBase: 7,
        }),
      );
      const uniformGroup = mesh.shader?.resources.glyphUniforms;
      const uniforms = uniformGroup?.uniforms;
      const packed = uniforms?.uResidentProtos as Float32Array;

      expect(resident).toContain("uResidentProtoBase: i32");
      expect(resident).toContain("uResidentProtoPadding: f32");
      expect(resident).toContain("uResidentProtos: array<vec4<f32>, 16>");
      expect(resident).toContain("proto - u32(glyphUniforms.uResidentProtoBase)");
      expect(resident).toContain("glyphUniforms.uResidentProtos[glyph * 2u + texelOffset]");
      expect(resident).not.toContain("textureLoad(uPrototype");
      expect(uniforms?.uResidentProtoBase).toBe(7);
      expect(uniformGroup?.uniformStructures.uResidentProtos).toMatchObject({
        type: "f32",
        size: 64,
      });
      expect(Array.from(packed.subarray(0, prototypes.length))).toEqual(Array.from(prototypes));
      expect(Array.from(packed.subarray(prototypes.length))).toEqual(
        Array.from(new Float32Array(8 * 8 - prototypes.length)),
      );

      const replacement = Float32Array.from(prototypes, (value) => value + 100);
      mesh.setResidentPrototype(replacement);
      expect(Array.from(packed.subarray(0, replacement.length))).toEqual(Array.from(replacement));
      expect(() => mesh.setResidentPrototype(new Float32Array(4 * 8))).toThrow(
        "resident run update must preserve the packed prototype count",
      );

      mesh.destroy();
    } finally {
      storage.destroy();
      restoreDocument();
    }
  });

  test("keeps texture and storage palette binds on matching names", () => {
    const storage = storageBuffer("pixi-glyphflow-test-palette-storage");
    const shared = {
      uAtlasR: Texture.WHITE.source,
      uAtlasRGBA: Texture.WHITE.source,
      uSampler: Texture.WHITE.source.style,
      uPrototype: Texture.WHITE.source,
      glyphUniforms: {
        uPaletteWidth: { value: 1, type: "f32" },
        uEffectBase: { value: 0, type: "f32" },
      },
    };
    const storageProgram = GpuProgram.from({
      vertex: { source: glyphShaderWgsl("storage"), entryPoint: "mainVertex" },
      fragment: { source: glyphShaderWgsl("storage"), entryPoint: "mainFragment" },
    });
    const leftover = new Shader({
      gpuProgram: storageProgram,
      resources: {
        ...shared,
        uTransformTexture: Texture.WHITE.source,
        uTransforms: storage,
      },
    });
    const storageShader = new Shader({
      gpuProgram: storageProgram,
      resources: {
        ...shared,
        ...glyphPaletteResources("storage", Texture.WHITE, storage),
      },
    });
    const textureShader = new Shader({
      gpuProgram: GpuProgram.from({
        vertex: { source: glyphShaderWgsl("texture"), entryPoint: "mainVertex" },
        fragment: { source: glyphShaderWgsl("texture"), entryPoint: "mainFragment" },
      }),
      resources: {
        ...shared,
        ...glyphPaletteResources("texture", Texture.WHITE, undefined),
      },
    });

    expect(leftover.groups[99]).toBeDefined();
    assertPaletteBind(storageShader, "storage", storage);
    assertPaletteBind(textureShader, "texture", Texture.WHITE.source);

    const fallbackMesh = new GlyphMesh(
      meshOptions({ palettePath: "storage", shader: textureShader }),
    );
    const storageMesh = new GlyphMesh(
      meshOptions({
        palettePath: "storage",
        paletteStorage: storage,
        shader: storageShader,
      }),
    );
    expect(fallbackMesh.palettePath).toBe("texture");
    expect(storageMesh.palettePath).toBe("storage");
    storageMesh.setPaletteTexture(Texture.WHITE, 2, 4);
    storageMesh.unbindPaletteTexture();
    const shader = storageMesh.shader;
    expect(shader).not.toBeNull();
    if (shader === null) return;
    expect("uTransformTexture" in shader.resources).toBe(false);
    expect(shader.groups[99]).toBeUndefined();

    leftover.destroy();
    fallbackMesh.destroy();
    storageMesh.destroy();
  });
});

function textureShader(prototypeTexture = Texture.WHITE): Shader {
  return new Shader({
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
  });
}

function storageBuffer(label: string): Buffer {
  return new Buffer({
    size: 64,
    usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    label,
  });
}

function installNullCanvasDocument(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  });
  return () => {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", descriptor);
  };
}

function assertPaletteBind(
  shader: Shader,
  path: PalettePath,
  expected: Buffer | Texture["source"],
): void {
  const spec = glyphPaletteBindSpec(path);
  const otherName = spec.resourceName === "uTransformTexture" ? "uTransforms" : "uTransformTexture";
  const program = shader.gpuProgram;
  const source = glyphShaderWgsl(path);

  expect(program).toBeDefined();
  if (program === undefined) return;
  expect(source).toContain(`@group(2) @binding(${String(spec.binding)}`);
  expect(source).toContain(spec.resourceName);
  expect(source).not.toContain(otherName);
  expect(program.layout[2]?.[spec.resourceName]).toBe(spec.binding);
  expect(program.layout[2]?.[otherName]).toBeUndefined();
  expect(shader.resources[spec.resourceName]).toBe(expected);
  expect(otherName in shader.resources).toBe(false);
  expect(shader.groups[2]?.getResource(spec.binding)).toBe(expected);
  expect(shader.groups[99]).toBeUndefined();
}
