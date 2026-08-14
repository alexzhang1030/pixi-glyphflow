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
import { GLYPH_INSTANCE_STRIDE } from "./types";

export interface GlyphMeshOptions {
  readonly texture: Texture;
  readonly paletteTexture: Texture;
  readonly paletteWidth: number;
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
          format: "float32x4",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 0,
          instance: true,
        },
        aInstanceUv: {
          buffer: instanceBuffer,
          format: "unorm16x4",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 16,
          instance: true,
        },
        aPaletteIndex: {
          buffer: instanceBuffer,
          format: "uint32",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 24,
          instance: true,
        },
        aMetadata: {
          buffer: instanceBuffer,
          format: "uint32",
          stride: GLYPH_INSTANCE_STRIDE,
          offset: 28,
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
                sampler: { type: "filtering" },
              },
              {
                binding: 2,
                visibility: ShaderStage.VERTEX,
                texture: {
                  sampleType: "unfilterable-float",
                  viewDimension: "2d",
                  multisampled: false,
                },
              },
              {
                binding: 3,
                visibility: ShaderStage.VERTEX,
                buffer: { type: "uniform" },
              },
            ],
          ],
        }),
        resources: {
          uTexture: options.texture.source,
          uSampler: options.texture.source.style,
          uTransformTexture: options.paletteTexture.source,
          glyphUniforms: {
            uPaletteWidth: { value: options.paletteWidth, type: "f32" },
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
    this.texture = texture;
    this.#ownedShader.resources.uTexture = texture.source;
    this.#ownedShader.resources.uSampler = texture.source.style;
  }

  setPaletteTexture(texture: Texture, width: number): void {
    if (!Number.isSafeInteger(width) || width <= 0) {
      throw new TypeError("palette width must be a positive safe integer");
    }
    this.#ownedShader.resources.uTransformTexture = texture.source;
    this.#ownedShader.resources.glyphUniforms.uniforms.uPaletteWidth = width;
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
