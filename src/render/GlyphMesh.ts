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

import type { PalettePath } from "./paletteStorage";
import { GLYPH_FRAGMENT_GLSL, glyphShaderWgsl, GLYPH_VERTEX_GLSL } from "./shaders";
import { GLYPH_DRAW_STRIDE, GLYPH_PROTO_TEXTURE_WIDTH, GLYPH_TEXTURE_BANK_SIZE } from "./types";

/** Owned sampler. Do not bind `source.style` — destroying that source nulls it. */
const ATLAS_SAMPLER_STYLE = new TextureStyle({
  addressMode: "clamp-to-edge",
  scaleMode: "linear",
});

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
  readonly shader?: Shader;
}

export class GlyphMesh extends Mesh<Geometry, Shader> {
  readonly instanceBuffer: Buffer;
  readonly #ownedGeometry: Geometry;
  readonly #ownedShader: Shader;
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
            source: glyphShaderWgsl(options.palettePath ?? "texture"),
            entryPoint: "mainVertex",
          },
          fragment: {
            source: glyphShaderWgsl(options.palettePath ?? "texture"),
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
              paletteVertexBinding(options.palettePath ?? "texture"),
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
          uTransformTexture: options.paletteTexture.source,
          ...(options.paletteStorage === undefined ? {} : { uTransforms: options.paletteStorage }),
          uPrototype: options.prototypeTexture.source,
          glyphUniforms: {
            uPaletteWidth: { value: options.paletteWidth, type: "f32" },
            uEffectBase: { value: options.effectBase ?? 0, type: "f32" },
          },
        },
      });
    super({ geometry, shader, texture: options.texture });
    this.instanceBuffer = instanceBuffer;
    this.#ownedGeometry = geometry;
    this.#ownedShader = shader;
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
    validateInstanceData(this.instanceBuffer.data.buffer as ArrayBuffer, instanceCount);
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
    this.#ownedShader.resources.uTransformTexture = texture.source;
    this.#ownedShader.resources.glyphUniforms.uniforms.uPaletteWidth = width;
    this.#ownedShader.resources.glyphUniforms.uniforms.uEffectBase = effectBase;
    this.#bindPrototype();
  }

  /** Drop the live palette sampler so a later GPU rewrite is not a bound vertex texture. */
  unbindPaletteTexture(): void {
    this.#ownedShader.resources.uTransformTexture = Texture.EMPTY.source;
  }

  setPaletteStorage(buffer: Buffer): void {
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

function paletteVertexBinding(path: PalettePath): {
  binding: number;
  visibility: number;
  texture?: {
    sampleType: "unfilterable-float";
    viewDimension: "2d";
    multisampled: false;
  };
  buffer?: { type: "read-only-storage" };
} {
  switch (path) {
    case "texture":
      return {
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

function validateInstanceData(data: ArrayBuffer, instanceCount: number): void {
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
