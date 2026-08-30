import { type BufferImageSource, type Texture, type WebGLRenderer } from "pixi.js";

import { cleanupBestEffortOrThrow } from "./cleanup";
import { GlyphMesh, type GlyphMeshOptions } from "./GlyphMesh";
import { FLOAT_TEXEL_BYTES, packedFloatTexelView, webglFloatPaletteRects } from "./pack";
import type {
  BackendAtlasArray,
  BackendAtlasPage,
  BackendColorAtlasCopy,
  BackendDestroyResources,
  BackendMeshBindings,
  PixiRendererPlatform,
} from "./PixiRendererPlatform";
import { bindMeshResources } from "./PixiRendererResources";
import { TRANSFORM_EFFECT_STRIDE, TRANSFORM_PALETTE_STRIDE } from "./TransformPalette";
import type { DirtyByteRange } from "./types";

const WEBGL_UPLOAD_CALL_COST_BYTES = 4_096;
const WEBGL_PALETTE_MERGE_GAP_BYTES = 256;
const WEBGL_MIN_PALETTE_WIDTH = 64;

interface MutableByteRange {
  offset: number;
  length: number;
}

export class WebGL2RendererBackendAdapter implements PixiRendererPlatform {
  readonly kind = "webgl" as const;
  readonly #renderer: WebGLRenderer;
  #destroyed = false;

  readonly computeCullPass = undefined;
  readonly paletteStoragePass = undefined;

  constructor(renderer: WebGLRenderer) {
    this.#renderer = renderer;
  }

  get maxTextureSize(): number {
    const size = this.#renderer.gl.getParameter(this.#renderer.gl.MAX_TEXTURE_SIZE);
    return typeof size === "number" && size > 0 ? size : 4096;
  }

  prepareComputeCull(): undefined {
    return undefined;
  }

  preparePaletteStorage(): undefined {
    return undefined;
  }

  planPaletteTextureWidth(texelCount: number, _preferredWidth: number): number {
    const limit = this.maxTextureSize;
    let width = Math.min(WEBGL_MIN_PALETTE_WIDTH, limit);
    while (Math.ceil(texelCount / width) > limit && width < limit) {
      width = Math.min(limit, width * 2);
    }
    return width;
  }

  initializeAtlasArray(array: BackendAtlasArray): void {
    if (array.source.destroyed || array.source.style === null) {
      throw new Error("Cannot initialize a destroyed atlas array");
    }
    const gl = this.#renderer.gl;
    const resource = this.#renderer.texture.getGlSource(array.source);
    withAtlasUnpack(gl, () => {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, resource.texture);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        resource.internalFormat,
        array.width,
        array.height,
        array.layerCapacity,
        0,
        resource.format,
        resource.type,
        null,
      );
    });
  }

  migrateAtlasArray(): false {
    return false;
  }

  uploadAtlas(
    page: BackendAtlasPage,
    x: number,
    y: number,
    width: number,
    height: number,
    pixels: Uint8Array,
  ): void {
    const gl = this.#renderer.gl;
    const resource = this.#renderer.texture.getGlSource(page.array.source);
    withAtlasUnpack(gl, () => {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, resource.texture);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        x,
        y,
        page.info.layer,
        width,
        height,
        1,
        resource.format,
        resource.type,
        pixels,
      );
    });
  }

  async copyColorAtlasToArray(
    _source: GPUTexture,
    _copies: readonly Readonly<BackendColorAtlasCopy>[],
  ): Promise<false> {
    return false;
  }

  initializeTexture(source: BufferImageSource): void {
    this.#renderer.texture.getGlSource(source);
  }

  uploadFloatTextureRanges(
    source: BufferImageSource,
    data: Float32Array,
    textureWidth: number,
    ranges: readonly Readonly<DirtyByteRange>[],
  ): Readonly<{ bytes: number; writes: number }> {
    let bytes = 0;
    let writes = 0;
    const gl = this.#renderer.gl;
    const resource = this.#renderer.texture.getGlSource(source);
    const rects = webglFloatPaletteRects(ranges, textureWidth);
    withFloatUnpack(gl, () => {
      gl.bindTexture(resource.target, resource.texture);
      for (const rect of rects) {
        const texels = rect.width * rect.height;
        gl.texSubImage2D(
          resource.target,
          0,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          resource.format,
          resource.type,
          packedFloatTexelView(data, rect.texel, texels),
        );
        bytes += texels * FLOAT_TEXEL_BYTES;
        writes += 1;
      }
    });
    return { bytes, writes };
  }

  planPaletteTextureRanges(
    ranges: readonly Readonly<DirtyByteRange>[],
    activePaletteIndices: readonly number[],
    effectBase: number,
  ): readonly Readonly<DirtyByteRange>[] {
    const liveRanges = activePaletteRanges(activePaletteIndices, effectBase);
    return uploadCost(liveRanges) < uploadCost(ranges) ? liveRanges : ranges;
  }

  preparePaletteTextureUpload(texture: Texture, meshes: Iterable<GlyphMesh>): void {
    for (const mesh of meshes) mesh.unbindPaletteTexture();
    this.#renderer.texture.unbind(texture);
    const gl = this.#renderer.gl;
    const resource = this.#renderer.texture.getGlSource(texture.source);
    const combinedUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    const previous = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    for (let unit = 0; unit < combinedUnits; unit += 1) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (gl.getParameter(gl.TEXTURE_BINDING_2D) === resource.texture) {
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    gl.activeTexture(previous);
  }

  createMesh(options: GlyphMeshOptions): GlyphMesh {
    return new GlyphMesh(options);
  }

  bindMesh(mesh: GlyphMesh, bindings: Readonly<BackendMeshBindings>): void {
    bindMeshResources(mesh, bindings);
  }

  initializeMesh(mesh: GlyphMesh): void {
    this.#renderer.buffer.updateBuffer(mesh.instanceBuffer);
  }

  destroyMesh(mesh: GlyphMesh): void {
    cleanupBestEffortOrThrow([() => mesh.removeFromParent(), () => mesh.destroy()]);
  }

  destroy(resources: Readonly<BackendDestroyResources>): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    cleanupBestEffortOrThrow([
      ...Array.from(resources.meshes, (mesh) => () => this.destroyMesh(mesh)),
      ...Array.from(resources.atlasTextures, (texture) => () => texture.destroy(true)),
      () => resources.paletteTexture.destroy(true),
      () => resources.prototypeTexture.destroy(true),
    ]);
  }
}

function withFloatUnpack(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  write: () => void,
): void {
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  const previousFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const previousPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  let previousRowLength = 0;
  let previousSkipPixels = 0;
  let previousSkipRows = 0;
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (isWebGL2Context(gl)) {
    previousRowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH) as number;
    previousSkipPixels = gl.getParameter(gl.UNPACK_SKIP_PIXELS) as number;
    previousSkipRows = gl.getParameter(gl.UNPACK_SKIP_ROWS) as number;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }
  try {
    write();
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, previousFlipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
    if (isWebGL2Context(gl)) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, previousRowLength);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, previousSkipPixels);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, previousSkipRows);
    }
  }
}

function activePaletteRanges(
  activePaletteIndices: readonly number[],
  effectBase: number,
): readonly Readonly<DirtyByteRange>[] {
  const ranges: MutableByteRange[] = [];
  const effectByteBase = effectBase * FLOAT_TEXEL_BYTES;
  for (const index of activePaletteIndices) {
    ranges.push({ offset: index * TRANSFORM_PALETTE_STRIDE, length: TRANSFORM_PALETTE_STRIDE });
    if (effectBase > 0) {
      ranges.push({
        offset: effectByteBase + index * TRANSFORM_EFFECT_STRIDE,
        length: TRANSFORM_EFFECT_STRIDE,
      });
    }
  }
  ranges.sort((left, right) => left.offset - right.offset);
  const merged: MutableByteRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      range.offset <= previous.offset + previous.length + WEBGL_PALETTE_MERGE_GAP_BYTES
    ) {
      previous.length = Math.max(previous.length, range.offset + range.length - previous.offset);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function uploadCost(ranges: readonly Readonly<DirtyByteRange>[]): number {
  return ranges.reduce((cost, range) => cost + range.length + WEBGL_UPLOAD_CALL_COST_BYTES, 0);
}

function isWebGL2Context(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): gl is WebGL2RenderingContext {
  return "UNPACK_ROW_LENGTH" in gl;
}

function withAtlasUnpack(gl: WebGL2RenderingContext, write: () => void): void {
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  const previousFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const previousPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  try {
    write();
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, previousFlipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
  }
}
