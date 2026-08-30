import {
  type Buffer,
  type BufferImageSource,
  type Renderer,
  type Texture,
  type WebGLRenderer,
  type WebGPURenderer,
} from "pixi.js";

import type { AtlasPageInfo } from "../atlas/types";
import type { ComputeCullPass } from "./ComputeCullPass";
import { GlyphMesh, type GlyphMeshOptions } from "./GlyphMesh";
import type { PaletteStoragePass } from "./PaletteStoragePass";
import { bindMeshResources } from "./PixiRendererResources";
import type { DirtyByteRange } from "./types";
import { WebGL2RendererBackendAdapter } from "./WebGL2RendererBackend";
import type { WebGPUFrameTransactionStats } from "./WebGPUFrameTransaction";
import { WebGPURendererBackendAdapter } from "./WebGPURendererBackend";

export interface PixiRendererPlatform {
  readonly kind: "webgl" | "webgpu" | "unknown";
  readonly maxTextureSize: number;
  readonly computeCullPass: ComputeCullPass | undefined;
  readonly paletteStoragePass: PaletteStoragePass | undefined;
  readonly frameTransactionStats?: Readonly<WebGPUFrameTransactionStats> | undefined;
  planPaletteTextureWidth(texelCount: number, preferredWidth: number): number;
  prepareComputeCull(
    computeCull: boolean | "auto",
    structurallyEligible: boolean,
  ): ComputeCullPass | undefined;
  preparePaletteStorage(paletteBytes: number): PreparedPaletteStorage | undefined;
  initializeAtlasArray(array: BackendAtlasArray): void;
  /** A true result owns retirement of `previous` after the queued migration completes. */
  migrateAtlasArray(previous: BackendAtlasArray, next: BackendAtlasArray): boolean;
  uploadAtlas(
    page: BackendAtlasPage,
    x: number,
    y: number,
    width: number,
    height: number,
    pixels: Uint8Array,
  ): void;
  copyColorAtlasToArray(
    source: GPUTexture,
    copies: readonly Readonly<BackendColorAtlasCopy>[],
  ): Promise<boolean>;
  initializeTexture(source: BufferImageSource): void;
  uploadFloatTextureRanges(
    source: BufferImageSource,
    data: Float32Array,
    textureWidth: number,
    ranges: readonly Readonly<DirtyByteRange>[],
  ): Readonly<{ bytes: number; writes: number }>;
  planPaletteTextureRanges(
    ranges: readonly Readonly<DirtyByteRange>[],
    activePaletteIndices: readonly number[],
    effectBase: number,
  ): readonly Readonly<DirtyByteRange>[];
  preparePaletteTextureUpload(texture: Texture, meshes: Iterable<GlyphMesh>): void;
  createMesh(options: GlyphMeshOptions): GlyphMesh;
  bindMesh(mesh: GlyphMesh, bindings: Readonly<BackendMeshBindings>): void;
  initializeMesh(mesh: GlyphMesh): void;
  destroyMesh(mesh: GlyphMesh): void;
  destroy(resources: Readonly<BackendDestroyResources>): void;
}

export interface PreparedPaletteStorage {
  readonly pass: PaletteStoragePass;
  readonly replaced: boolean;
}

export interface BackendAtlasArray {
  kind: "r" | "rgba";
  width: number;
  height: number;
  layerCapacity: number;
  layerCount: number;
  source: BufferImageSource;
  texture: Texture;
  initialized: boolean;
  dummy: boolean;
}

export interface BackendAtlasPage {
  readonly info: Readonly<AtlasPageInfo>;
  readonly pixels: Uint8Array;
  array: BackendAtlasArray;
}

export interface BackendColorAtlasCopy {
  readonly destination: BackendAtlasPage;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly destinationX: number;
  readonly destinationY: number;
  readonly width: number;
  readonly height: number;
}

export interface BackendMeshBindings {
  readonly atlasTextures: readonly [Texture, Texture];
  readonly bindAtlas: boolean;
  readonly paletteTexture: Texture;
  readonly paletteWidth: number;
  readonly effectBase: number;
  readonly paletteStorage?: Buffer;
  readonly prototypeTexture: Texture;
  readonly prototypeWidth: number;
}

export interface BackendDestroyResources {
  readonly meshes: Iterable<GlyphMesh>;
  readonly atlasTextures: Iterable<Texture>;
  readonly paletteTexture: Texture;
  readonly prototypeTexture: Texture;
}

export function createPixiRendererPlatform(renderer: Renderer): PixiRendererPlatform {
  if (isWebGLRenderer(renderer)) return new WebGL2RendererBackendAdapter(renderer);
  if (isWebGPURenderer(renderer)) return new WebGPURendererBackendAdapter(renderer);
  return new FallbackRendererBackendAdapter();
}

class FallbackRendererBackendAdapter implements PixiRendererPlatform {
  readonly kind = "unknown" as const;
  readonly maxTextureSize = 4096;
  readonly computeCullPass = undefined;
  readonly paletteStoragePass = undefined;

  prepareComputeCull(): undefined {
    return undefined;
  }

  planPaletteTextureWidth(_texelCount: number, preferredWidth: number): number {
    return preferredWidth;
  }

  preparePaletteStorage(): undefined {
    return undefined;
  }

  initializeAtlasArray(array: BackendAtlasArray): void {
    array.source.update();
  }

  migrateAtlasArray(): false {
    return false;
  }

  uploadAtlas(): void {}

  async copyColorAtlasToArray(): Promise<false> {
    return false;
  }

  initializeTexture(source: BufferImageSource): void {
    source.update();
  }

  uploadFloatTextureRanges(
    source: BufferImageSource,
    data: Float32Array,
    _textureWidth: number,
    ranges: readonly Readonly<DirtyByteRange>[],
  ): Readonly<{ bytes: number; writes: number }> {
    if (ranges.length === 0) return { bytes: 0, writes: 0 };
    source.update();
    return { bytes: data.byteLength, writes: 1 };
  }

  planPaletteTextureRanges(
    ranges: readonly Readonly<DirtyByteRange>[],
    _activePaletteIndices: readonly number[],
    _effectBase: number,
  ): readonly Readonly<DirtyByteRange>[] {
    return ranges;
  }

  preparePaletteTextureUpload(): void {}

  createMesh(options: GlyphMeshOptions): GlyphMesh {
    return new GlyphMesh(options);
  }

  bindMesh(mesh: GlyphMesh, bindings: Readonly<BackendMeshBindings>): void {
    bindMeshResources(mesh, bindings);
  }

  initializeMesh(mesh: GlyphMesh): void {
    mesh.instanceBuffer.update();
  }

  destroyMesh(mesh: GlyphMesh): void {
    mesh.removeFromParent();
    mesh.destroy();
  }

  destroy(resources: Readonly<BackendDestroyResources>): void {
    for (const mesh of resources.meshes) this.destroyMesh(mesh);
    for (const texture of resources.atlasTextures) texture.destroy(true);
    resources.paletteTexture.destroy(true);
    resources.prototypeTexture.destroy(true);
  }
}

function isWebGLRenderer(renderer: Renderer): renderer is WebGLRenderer {
  return "gl" in renderer;
}

function isWebGPURenderer(renderer: Renderer): renderer is WebGPURenderer {
  return "gpu" in renderer;
}
