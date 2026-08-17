import {
  Buffer,
  BufferUsage,
  Geometry,
  GlProgram,
  GpuProgram,
  Mesh,
  Shader,
  ShaderStage,
  type Texture,
} from "pixi.js";

import { GLYPH_FRAGMENT_GLSL, GLYPH_SHADER_WGSL, GLYPH_VERTEX_GLSL } from "./shaders";
import { GLYPH_INSTANCE_STRIDE, GLYPH_TEXTURE_BANK_SIZE } from "./types";

type TextureBank = readonly [
  Texture,
  Texture,
  Texture,
  Texture,
  Texture,
  Texture,
  Texture,
  Texture,
];

export interface GlyphMeshOptions {
  readonly texture: Texture;
  /** Consecutive atlas pages available to this draw, starting with `texture`. */
  readonly textures?: readonly Texture[];
  readonly paletteTexture: Texture;
  readonly paletteWidth: number;
  readonly effectBase?: number;
  readonly instanceData: ArrayBuffer;
  readonly instanceCount: number;
  readonly shader?: Shader;
}

export class GlyphMesh extends Mesh<Geometry, Shader> {
  readonly instanceBuffer: Buffer;
  readonly #ownedGeometry: Geometry;
  readonly #ownedShader: Shader;

  constructor(options: GlyphMeshOptions) {
    validateInstanceData(options.instanceData, options.instanceCount);
    if (!Number.isSafeInteger(options.paletteWidth) || options.paletteWidth <= 0) {
      throw new TypeError("paletteWidth must be a positive safe integer");
    }
    const textures = normalizeTextureBank(options.texture, options.textures);
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
        aInstanceRect: {
          buffer: instanceBuffer,
          format: "float16x4",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 0,
          instance: true,
        },
        aInstanceUv: {
          buffer: instanceBuffer,
          format: "unorm16x4",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 8,
          instance: true,
        },
        aPaletteIndex: {
          buffer: instanceBuffer,
          format: "uint32",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 16,
          instance: true,
        },
        aMetadata: {
          buffer: instanceBuffer,
          format: "uint32",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 20,
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
          vertex: { source: GLYPH_SHADER_WGSL, entryPoint: "mainVertex" },
          fragment: { source: GLYPH_SHADER_WGSL, entryPoint: "mainFragment" },
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
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 1,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 2,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 3,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 4,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 5,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 6,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 7,
                visibility: ShaderStage.FRAGMENT,
                texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
              },
              {
                binding: 8,
                visibility: ShaderStage.FRAGMENT,
                sampler: { type: "filtering" },
              },
              {
                binding: 9,
                visibility: ShaderStage.VERTEX,
                texture: {
                  sampleType: "unfilterable-float",
                  viewDimension: "2d",
                  multisampled: false,
                },
              },
              {
                binding: 10,
                visibility: ShaderStage.VERTEX,
                buffer: { type: "uniform" },
              },
            ],
          ],
        }),
        resources: {
          uTexture0: textures[0].source,
          uTexture1: textures[1].source,
          uTexture2: textures[2].source,
          uTexture3: textures[3].source,
          uTexture4: textures[4].source,
          uTexture5: textures[5].source,
          uTexture6: textures[6].source,
          uTexture7: textures[7].source,
          uSampler: textures[0].source.style,
          uTransformTexture: options.paletteTexture.source,
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
  }

  updateInstances(data: ArrayBuffer, instanceCount: number): void {
    validateInstanceData(data, instanceCount);
    if (this.instanceBuffer.data.buffer !== data) {
      this.instanceBuffer.data = new Uint8Array(data);
    } else {
      this.instanceBuffer.update(instanceCount * GLYPH_INSTANCE_STRIDE);
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
    const bank = normalizeTextureBank(textures[0], textures);
    this.texture = bank[0];
    this.#ownedShader.resources.uTexture0 = bank[0].source;
    this.#ownedShader.resources.uTexture1 = bank[1].source;
    this.#ownedShader.resources.uTexture2 = bank[2].source;
    this.#ownedShader.resources.uTexture3 = bank[3].source;
    this.#ownedShader.resources.uTexture4 = bank[4].source;
    this.#ownedShader.resources.uTexture5 = bank[5].source;
    this.#ownedShader.resources.uTexture6 = bank[6].source;
    this.#ownedShader.resources.uTexture7 = bank[7].source;
    this.#ownedShader.resources.uSampler = bank[0].source.style;
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
  }

  override destroy(): void {
    if (this.destroyed) return;
    super.destroy();
    this.#ownedGeometry.destroy(true);
    this.#ownedShader.destroy(false);
  }
}

function validateInstanceData(data: ArrayBuffer, instanceCount: number): void {
  if (!(data instanceof ArrayBuffer)) {
    throw new TypeError("instanceData must be an ArrayBuffer");
  }
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0) {
    throw new TypeError("instanceCount must be a non-negative safe integer");
  }
  if (instanceCount * GLYPH_INSTANCE_STRIDE > data.byteLength) {
    throw new RangeError("instanceCount exceeds the supplied instanceData capacity");
  }
}

function normalizeTextureBank(
  primary: Texture | undefined,
  textures: readonly Texture[] | undefined,
): TextureBank {
  if (primary === undefined) throw new TypeError("texture bank must contain at least one texture");
  const supplied = textures ?? [primary];
  if (supplied.length === 0 || supplied.length > GLYPH_TEXTURE_BANK_SIZE) {
    throw new RangeError(
      `texture bank must contain between 1 and ${String(GLYPH_TEXTURE_BANK_SIZE)} textures`,
    );
  }
  if (supplied[0] !== primary) {
    throw new TypeError("texture must be the first texture-bank entry");
  }
  return [
    supplied[0] ?? primary,
    supplied[1] ?? primary,
    supplied[2] ?? primary,
    supplied[3] ?? primary,
    supplied[4] ?? primary,
    supplied[5] ?? primary,
    supplied[6] ?? primary,
    supplied[7] ?? primary,
  ];
}
