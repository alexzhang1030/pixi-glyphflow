import {
  Buffer,
  BufferUsage,
  Geometry,
  GlProgram,
  GpuProgram,
  Mesh,
  Shader,
  ShaderStage,
  Texture,
  TextureStyle,
} from "pixi.js";

import { readyPalettePath, type PalettePath } from "./paletteStorage";
import {
  GLYPH_FRAGMENT_GLSL,
  glyphShaderWgsl,
  GLYPH_VERTEX_GLSL,
  type GlyphShaderVariant,
} from "./shaders";
import { GLYPH_DRAW_STRIDE, GLYPH_PROTO_TEXTURE_WIDTH, GLYPH_TEXTURE_BANK_SIZE } from "./types";

/** Owned sampler. Do not bind `source.style` — destroying that source nulls it. */
const ATLAS_SAMPLER_STYLE = new TextureStyle({
  addressMode: "clamp-to-edge",
  scaleMode: "linear",
});

export const RESIDENT_RUN_MIN_GLYPHS = 2;
export const RESIDENT_RUN_MAX_GLYPHS = 8;
const RESIDENT_PROTO_FLOATS_PER_GLYPH = 8;
const RESIDENT_RUN_UNIFORM_VEC4S = RESIDENT_RUN_MAX_GLYPHS * 2;
const RESIDENT_RUN_UNIFORM_FLOATS = RESIDENT_RUN_UNIFORM_VEC4S * 4;

export interface GlyphMeshOptions {
  readonly texture: Texture;
  /**
   * Atlas arrays bound to this draw: `[atlasR, atlasRGBA]`. `texture` must be the R array. A single
   * texture is bound to both arrays (tests and empty placeholders).
   */
  readonly textures?: readonly Texture[];
  readonly paletteTexture: Texture;
  readonly paletteWidth: number;
  /** WebGPU storage table. Ignored on the texture path and by WebGL. */
  readonly paletteStorage?: Buffer;
  readonly palettePath?: PalettePath;
  readonly prototypeTexture: Texture;
  readonly prototypeWidth?: number;
  readonly effectBase?: number;
  readonly instanceData: ArrayBuffer;
  readonly instanceCount: number;
  /** Built-in WebGPU program. The resident fill variant requires the storage palette path. */
  readonly shaderVariant?: GlyphShaderVariant;
  /** Packed RGBA32F prototype texels for a resident uniform variant. */
  readonly residentPrototype?: Float32Array;
  /** Absolute prototype index represented by the first run-uniform glyph. */
  readonly residentPrototypeBase?: number;
  readonly shader?: Shader;
}

export class GlyphMesh extends Mesh<Geometry, Shader> {
  readonly instanceBuffer: Buffer;
  readonly palettePath: PalettePath;
  readonly #ownedGeometry: Geometry;
  readonly #ownedShader: Shader;
  readonly #shaderVariant: GlyphShaderVariant;
  readonly #residentPrototypeFloats: number;
  #prototypeTexture: Texture;

  constructor(options: GlyphMeshOptions) {
    validateInstanceData(options.instanceData, options.instanceCount);
    if (!Number.isSafeInteger(options.paletteWidth) || options.paletteWidth <= 0) {
      throw new TypeError("paletteWidth must be a positive safe integer");
    }
    const prototypeWidth = options.prototypeWidth ?? GLYPH_PROTO_TEXTURE_WIDTH;
    if (!Number.isSafeInteger(prototypeWidth) || prototypeWidth <= 0) {
      throw new TypeError("prototypeWidth must be a positive safe integer");
    }
    const [atlasR, atlasRGBA] = normalizeAtlasArrays(options.texture, options.textures);
    const palettePath = readyPalettePath(
      options.palettePath ?? "texture",
      options.paletteStorage !== undefined,
    );
    const shaderVariant =
      palettePath === "storage" ? (options.shaderVariant ?? "general") : "general";
    const residentPrototype = options.residentPrototype;
    const residentPrototypeFloats = validateResidentPrototype(
      shaderVariant,
      residentPrototype,
      options.residentPrototypeBase,
    );
    const vertexBuffer = new Buffer({
      data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      usage: BufferUsage.VERTEX,
      label: "pixi-glyphflow-quad",
    });
    const instanceBuffer = new Buffer({
      data: new Uint8Array(options.instanceData),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: "pixi-glyphflow-instances",
      shrinkToFit: false,
    });
    const geometry = new Geometry({
      label: "pixi-glyphflow-geometry",
      attributes: {
        aVertex: { buffer: vertexBuffer, format: "float32x2" },
        aProtoIndex: {
          buffer: instanceBuffer,
          format: "uint32",
          stride: GLYPH_DRAW_STRIDE,
          offset: 0,
          instance: true,
        },
        aPaletteIndex: {
          buffer: instanceBuffer,
          format: "uint32",
          stride: GLYPH_DRAW_STRIDE,
          offset: 4,
          instance: true,
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
      topology: "triangle-list",
      instanceCount: options.instanceCount,
    });
    const shader =
      options.shader ??
      new Shader({
        glProgram: GlProgram.from({
          name: "pixi-glyphflow",
          vertex: GLYPH_VERTEX_GLSL,
          fragment: GLYPH_FRAGMENT_GLSL,
        }),
        gpuProgram: GpuProgram.from({
          name: "pixi-glyphflow",
          vertex: {
            source: glyphShaderWgsl(palettePath, shaderVariant),
            entryPoint: "mainVertex",
          },
          fragment: {
            source: glyphShaderWgsl(palettePath, shaderVariant),
            entryPoint: "mainFragment",
          },
          gpuLayout: [
            [
              {
                binding: 0,
                visibility: ShaderStage.VERTEX,
                buffer: { type: "uniform" },
              },
            ],
            [
              {
                binding: 0,
                visibility: ShaderStage.VERTEX,
                buffer: { type: "uniform" },
              },
            ],
            [
              {
                binding: 0,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d-array", multisampled: false },
              },
              {
                binding: 1,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d-array", multisampled: false },
              },
              {
                binding: 2,
                visibility: ShaderStage.FRAGMENT,
                sampler: { type: "filtering" },
              },
              paletteVertexBinding(palettePath),
              {
                binding: 4,
                visibility: ShaderStage.VERTEX,
                buffer: { type: "uniform" },
              },
              {
                binding: 5,
                visibility: ShaderStage.VERTEX,
                texture: {
                  sampleType: "unfilterable-float",
                  viewDimension: "2d",
                  multisampled: false,
                },
              },
            ],
          ],
        }),
        resources: {
          uAtlasR: atlasR.source,
          uAtlasRGBA: atlasRGBA.source,
          uSampler: ATLAS_SAMPLER_STYLE,
          ...glyphPaletteResources(palettePath, options.paletteTexture, options.paletteStorage),
          uPrototype: options.prototypeTexture.source,
          glyphUniforms: glyphUniformResources(
            options.paletteWidth,
            options.effectBase ?? 0,
            shaderVariant,
            residentPrototype,
            options.residentPrototypeBase,
          ),
        },
      });
    super({ geometry, shader, texture: options.texture });
    this.instanceBuffer = instanceBuffer;
    this.palettePath = palettePath;
    this.#ownedGeometry = geometry;
    this.#ownedShader = shader;
    this.#shaderVariant = shaderVariant;
    this.#residentPrototypeFloats = residentPrototypeFloats;
    this.#prototypeTexture = options.prototypeTexture;
    this.onRender = this.#bindPrototype;
  }

  updateInstances(data: ArrayBuffer, instanceCount: number): void {
    validateInstanceData(data, instanceCount);
    if (this.instanceBuffer.data.buffer !== data) {
      this.instanceBuffer.data = new Uint8Array(data);
    } else {
      this.instanceBuffer.update(instanceCount * GLYPH_DRAW_STRIDE);
    }
    this.geometry.instanceCount = instanceCount;
  }

  setInstanceCount(instanceCount: number): void {
    validateInstanceData(this.instanceBuffer.data.buffer, instanceCount);
    this.geometry.instanceCount = instanceCount;
  }

  setTexture(texture: Texture): void {
    this.setTextures([texture]);
  }

  setTextures(textures: readonly Texture[]): void {
    const [atlasR, atlasRGBA] = normalizeAtlasArrays(textures[0], textures);
    this.texture = atlasR;
    this.#ownedShader.resources.uAtlasR = atlasR.source;
    this.#ownedShader.resources.uAtlasRGBA = atlasRGBA.source;
    this.#ownedShader.resources.uSampler = ATLAS_SAMPLER_STYLE;
  }

  setPaletteTexture(texture: Texture, width: number, effectBase = 0): void {
    if (!Number.isSafeInteger(width) || width <= 0) {
      throw new TypeError("palette width must be a positive safe integer");
    }
    if (!Number.isFinite(effectBase) || effectBase < 0) {
      throw new TypeError("effectBase must be a finite non-negative number");
    }
    if (this.palettePath === "texture") {
      this.#ownedShader.resources.uTransformTexture = texture.source;
    }
    this.#ownedShader.resources.glyphUniforms.uniforms.uPaletteWidth = width;
    this.#ownedShader.resources.glyphUniforms.uniforms.uEffectBase = effectBase;
    this.#bindPrototype();
  }

  /** Drop the live palette sampler so a later GPU rewrite is not a bound vertex texture. */
  unbindPaletteTexture(): void {
    if (this.palettePath === "texture") {
      this.#ownedShader.resources.uTransformTexture = Texture.EMPTY.source;
    }
  }

  setPaletteStorage(buffer: Buffer): void {
    if (this.palettePath !== "storage") return;
    this.#ownedShader.resources.uTransforms = buffer;
    this.#bindPrototype();
  }

  setPrototypeTexture(texture: Texture, width: number): void {
    if (!Number.isSafeInteger(width) || width <= 0) {
      throw new TypeError("prototype width must be a positive safe integer");
    }
    this.#prototypeTexture = texture;
    this.#bindPrototype();
  }

  setResidentPrototype(prototype: Float32Array): void {
    const group = this.#ownedShader.resources.glyphUniforms;
    if (this.#shaderVariant === "resident-fill-single") {
      if (!(prototype instanceof Float32Array) || prototype.length < 8) {
        throw new TypeError("single-glyph resident shader requires two prototype texels");
      }
      const proto0 = group.uniforms.uResidentProto0;
      const proto1 = group.uniforms.uResidentProto1;
      if (!(proto0 instanceof Float32Array) || !(proto1 instanceof Float32Array)) {
        throw new Error("single-glyph resident uniforms are unavailable on this mesh");
      }
      proto0.set(prototype.subarray(0, 4));
      proto1.set(prototype.subarray(4, 8));
      group.update();
      return;
    }
    if (this.#shaderVariant === "resident-fill-run") {
      if (
        !(prototype instanceof Float32Array) ||
        prototype.length !== this.#residentPrototypeFloats
      ) {
        throw new TypeError("resident run update must preserve the packed prototype count");
      }
      const protos = group.uniforms.uResidentProtos;
      if (!(protos instanceof Float32Array) || protos.length !== RESIDENT_RUN_UNIFORM_FLOATS) {
        throw new Error("resident run uniforms are unavailable on this mesh");
      }
      protos.fill(0);
      protos.set(prototype);
      group.update();
      return;
    }
    throw new Error("resident prototype uniforms are unavailable on this mesh");
  }

  #bindPrototype = (): void => {
    this.#ownedShader.resources.uPrototype = this.#prototypeTexture.source;
  };

  override destroy(): void {
    if (this.destroyed) return;
    this.onRender = null;
    super.destroy();
    this.#ownedGeometry.destroy(true);
    this.#ownedShader.destroy(false);
  }
}

export interface GlyphPaletteBindSpec {
  readonly resourceName: "uTransformTexture" | "uTransforms";
  readonly binding: 3;
  readonly visibility: number;
  readonly texture?: {
    sampleType: "unfilterable-float";
    viewDimension: "2d";
    multisampled: false;
  };
  readonly buffer?: { type: "read-only-storage" };
}

/** Group 2 binding 3 for the requested palette path. Names must match WGSL and resources. */
export function glyphPaletteBindSpec(path: PalettePath): GlyphPaletteBindSpec {
  switch (path) {
    case "texture":
      return {
        resourceName: "uTransformTexture",
        binding: 3,
        visibility: ShaderStage.VERTEX,
        texture: {
          sampleType: "unfilterable-float",
          viewDimension: "2d",
          multisampled: false,
        },
      };
    case "storage":
      return {
        resourceName: "uTransforms",
        binding: 3,
        visibility: ShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      };
    default: {
      const _exhaustive: never = path;
      return _exhaustive;
    }
  }
}

function paletteVertexBinding(path: PalettePath): GPUBindGroupLayoutEntry {
  const spec = glyphPaletteBindSpec(path);
  if (spec.texture !== undefined) {
    return { binding: spec.binding, visibility: spec.visibility, texture: spec.texture };
  }
  return {
    binding: spec.binding,
    visibility: spec.visibility,
    buffer: { type: "read-only-storage" },
  };
}

/**
 * Pixi puts resource names missing from the GPU program into group 99. That group's bind-group
 * layout is undefined, so the first WebGPU `createBindGroup` throws. Storage WGSL has `uTransforms`
 * only. Texture WGSL has `uTransformTexture` only.
 */
export function glyphPaletteResources(
  path: PalettePath,
  paletteTexture: Texture,
  paletteStorage: Buffer | undefined,
): { readonly uTransformTexture: Texture["source"] } | { readonly uTransforms: Buffer } {
  switch (path) {
    case "texture":
      return { uTransformTexture: paletteTexture.source };
    case "storage":
      if (paletteStorage === undefined) {
        throw new TypeError("storage palette path requires paletteStorage");
      }
      return { uTransforms: paletteStorage };
    default: {
      const _exhaustive: never = path;
      return _exhaustive;
    }
  }
}

function validateInstanceData(data: ArrayBufferLike, instanceCount: number): void {
  if (!(data instanceof ArrayBuffer)) {
    throw new TypeError("instanceData must be an ArrayBuffer");
  }
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0) {
    throw new TypeError("instanceCount must be a non-negative safe integer");
  }
  if (instanceCount * GLYPH_DRAW_STRIDE > data.byteLength) {
    throw new RangeError("instanceCount exceeds the supplied instanceData capacity");
  }
}

function normalizeAtlasArrays(
  primary: Texture | undefined,
  textures: readonly Texture[] | undefined,
): readonly [Texture, Texture] {
  if (primary === undefined) throw new TypeError("atlas arrays must contain at least one texture");
  const supplied = textures ?? [primary];
  if (supplied.length === 0 || supplied.length > GLYPH_TEXTURE_BANK_SIZE) {
    throw new RangeError(
      `atlas arrays must contain between 1 and ${String(GLYPH_TEXTURE_BANK_SIZE)} textures`,
    );
  }
  if (supplied[0] !== primary) {
    throw new TypeError("texture must be the first atlas-array entry");
  }
  return [supplied[0] ?? primary, supplied[1] ?? primary];
}

function glyphUniformResources(
  paletteWidth: number,
  effectBase: number,
  shaderVariant: GlyphShaderVariant,
  residentPrototype: Float32Array | undefined,
  residentPrototypeBase: number | undefined,
): Record<
  string,
  { readonly value: number | Float32Array; readonly type: string; readonly size?: number }
> {
  const uniforms: Record<
    string,
    { readonly value: number | Float32Array; readonly type: string; readonly size?: number }
  > = {
    uPaletteWidth: { value: paletteWidth, type: "f32" },
    uEffectBase: { value: effectBase, type: "f32" },
  };
  if (shaderVariant === "resident-fill-single" && residentPrototype !== undefined) {
    uniforms.uResidentProto0 = { value: residentPrototype.subarray(0, 4), type: "vec4<f32>" };
    uniforms.uResidentProto1 = { value: residentPrototype.subarray(4, 8), type: "vec4<f32>" };
  }
  if (shaderVariant === "resident-fill-run" && residentPrototype !== undefined) {
    const protos = new Float32Array(RESIDENT_RUN_UNIFORM_FLOATS);
    protos.set(residentPrototype);
    uniforms.uResidentProtoBase = { value: residentPrototypeBase ?? 0, type: "i32" };
    uniforms.uResidentProtoPadding = { value: 0, type: "f32" };
    uniforms.uResidentProtos = {
      value: protos,
      type: "f32",
      size: RESIDENT_RUN_UNIFORM_FLOATS,
    };
  }
  return uniforms;
}

function validateResidentPrototype(
  shaderVariant: GlyphShaderVariant,
  prototype: Float32Array | undefined,
  base: number | undefined,
): number {
  if (shaderVariant === "resident-fill-single") {
    if (
      !(prototype instanceof Float32Array) ||
      prototype.length < RESIDENT_PROTO_FLOATS_PER_GLYPH
    ) {
      throw new TypeError("single-glyph resident shader requires two prototype texels");
    }
    return RESIDENT_PROTO_FLOATS_PER_GLYPH;
  }
  if (shaderVariant === "resident-fill-run") {
    if (!(prototype instanceof Float32Array)) {
      throw new TypeError("resident run shader requires 2 to 8 packed prototypes");
    }
    const glyphs = prototype.length / RESIDENT_PROTO_FLOATS_PER_GLYPH;
    if (
      !Number.isSafeInteger(glyphs) ||
      glyphs < RESIDENT_RUN_MIN_GLYPHS ||
      glyphs > RESIDENT_RUN_MAX_GLYPHS
    ) {
      throw new TypeError("resident run shader requires 2 to 8 packed prototypes");
    }
    const resolvedBase = base ?? 0;
    if (!Number.isSafeInteger(resolvedBase) || resolvedBase < 0 || resolvedBase > 0x7fff_ffff) {
      throw new TypeError("resident prototype base must be a non-negative i32");
    }
    return prototype.length;
  }
  return 0;
}
