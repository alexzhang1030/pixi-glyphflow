import { type BufferImageSource, type Texture, type WebGPURenderer } from "pixi.js";

import { resolveCullPath } from "../culling/computeCull";
import { cleanupBestEffort, cleanupBestEffortOrThrow } from "./cleanup";
import { ComputeCullPass } from "./ComputeCullPass";
import { GlyphMesh, type GlyphMeshOptions } from "./GlyphMesh";
import {
  FLOAT_TEXEL_BYTES,
  packedFloatTexelView,
  packGpuTextureRows,
  paletteUploadRects,
} from "./pack";
import { resolvePalettePath } from "./paletteStorage";
import { PaletteStoragePass } from "./PaletteStoragePass";
import type {
  BackendAtlasArray,
  BackendAtlasPage,
  BackendColorAtlasCopy,
  BackendDestroyResources,
  BackendMeshBindings,
  PixiRendererPlatform,
  PreparedPaletteStorage,
} from "./PixiRendererPlatform";
import { bindMeshResources } from "./PixiRendererResources";
import type { DirtyByteRange } from "./types";
import { WebGPUFrameTransaction, type WebGPUFrameTransactionStats } from "./WebGPUFrameTransaction";

export interface WebGpuRendererPassFactories {
  createComputeCullPass(
    renderer: WebGPURenderer,
    frameTransaction?: WebGPUFrameTransaction,
  ): ComputeCullPass;
  createPaletteStoragePass(
    renderer: WebGPURenderer,
    frameTransaction?: WebGPUFrameTransaction,
  ): PaletteStoragePass;
}

const DEFAULT_PASS_FACTORIES: WebGpuRendererPassFactories = {
  createComputeCullPass: (renderer, frameTransaction) =>
    new ComputeCullPass(renderer, frameTransaction),
  createPaletteStoragePass: (renderer, frameTransaction) =>
    new PaletteStoragePass(renderer, frameTransaction),
};

export class WebGPURendererBackendAdapter implements PixiRendererPlatform {
  readonly kind = "webgpu" as const;
  readonly #renderer: WebGPURenderer;
  readonly #passFactories: WebGpuRendererPassFactories;
  readonly #meshes = new Set<GlyphMesh>();
  readonly #frameTransaction: WebGPUFrameTransaction | undefined;
  #computeCullPass: ComputeCullPass | undefined;
  #paletteStoragePass: PaletteStoragePass | undefined;
  #computeCullUnavailableDevice: GPUDevice | undefined;
  #computeCullRetryDevice: GPUDevice | undefined;
  #computeCullDevice: GPUDevice | undefined;
  #paletteStorageUnavailableDevice: GPUDevice | undefined;
  #destroyed = false;

  constructor(
    renderer: WebGPURenderer,
    passFactories: WebGpuRendererPassFactories = DEFAULT_PASS_FACTORIES,
  ) {
    this.#renderer = renderer;
    this.#passFactories = passFactories;
    this.#frameTransaction = createFrameTransaction(renderer);
  }

  get maxTextureSize(): number {
    const size = this.#renderer.gpu?.device?.limits.maxTextureDimension2D;
    return typeof size === "number" && size > 0 ? size : 8192;
  }

  get computeCullPass(): ComputeCullPass | undefined {
    return this.#computeCullPass;
  }

  get paletteStoragePass(): PaletteStoragePass | undefined {
    return this.#paletteStoragePass;
  }

  get frameTransactionStats(): Readonly<WebGPUFrameTransactionStats> | undefined {
    return this.#frameTransaction?.stats;
  }

  prepareComputeCull(
    computeCull: boolean | "auto",
    structurallyEligible: boolean,
  ): ComputeCullPass | undefined {
    if (this.#destroyed) return undefined;
    if (!structurallyEligible) return undefined;
    const device = this.#renderer.gpu?.device;
    if (device === undefined) return undefined;
    if (this.#computeCullUnavailableDevice === device) return undefined;
    if (this.#computeCullRetryDevice === device) return undefined;
    if (
      resolveCullPath({
        adapter: this.kind,
        computeCull,
        deviceReady: true,
      }) === "cpu-grid"
    ) {
      return undefined;
    }
    const existing = this.#computeCullPass;
    const pass =
      existing ?? this.#passFactories.createComputeCullPass(this.#renderer, this.#frameTransaction);
    if (!pass.initialize()) {
      const transientHookFailure = pass.initializationFailureKind === "hook-transient";
      if (existing === undefined) pass.destroy();
      if (transientHookFailure) this.#deferComputeCullRetry(device);
      else this.#computeCullUnavailableDevice = device;
      return undefined;
    }
    this.#computeCullUnavailableDevice = undefined;
    this.#computeCullRetryDevice = undefined;
    const deviceChanged =
      this.#computeCullDevice !== undefined && this.#computeCullDevice !== device;
    this.#computeCullDevice = device;
    if (deviceChanged) {
      this.#paletteStoragePass?.bindResidentCullRecords(undefined);
      this.#paletteStoragePass?.initialize();
    }
    this.#computeCullPass = pass;
    return pass;
  }

  planPaletteTextureWidth(_texelCount: number, preferredWidth: number): number {
    return preferredWidth;
  }

  preparePaletteStorage(paletteBytes: number): PreparedPaletteStorage | undefined {
    if (this.#destroyed) return undefined;
    const device = this.#renderer.gpu?.device;
    if (device === undefined) return undefined;
    if (this.#paletteStorageUnavailableDevice === device) return undefined;
    if (
      resolvePalettePath({
        adapter: this.kind,
        maxStorageBuffersInVertexStage: device.limits.maxStorageBuffersInVertexStage ?? 0,
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        paletteBytes,
      }) === "texture"
    ) {
      return undefined;
    }
    const existing = this.#paletteStoragePass;
    const pass =
      existing ??
      this.#passFactories.createPaletteStoragePass(this.#renderer, this.#frameTransaction);
    if (!pass.initialize()) {
      if (existing === undefined) pass.destroy();
      this.#paletteStorageUnavailableDevice = device;
      return undefined;
    }
    this.#paletteStorageUnavailableDevice = undefined;
    this.#paletteStoragePass = pass;
    const ensured = pass.ensureTransforms(paletteBytes, (buffer) => {
      for (const mesh of this.#meshes) {
        if (mesh.palettePath === "storage") mesh.setPaletteStorage(buffer);
      }
    });
    if (!ensured.ok) return undefined;
    return { pass, replaced: ensured.replaced };
  }

  initializeAtlasArray(array: BackendAtlasArray): void {
    if (array.source.destroyed || array.source.style === null) {
      throw new Error("Cannot initialize a destroyed atlas array");
    }
    this.#renderer.texture.getGpuSource(array.source);
  }

  migrateAtlasArray(previous: BackendAtlasArray, next: BackendAtlasArray): boolean {
    if (
      previous.dummy ||
      !previous.initialized ||
      previous.layerCount === 0 ||
      previous.width !== next.width ||
      previous.height !== next.height
    ) {
      return false;
    }
    this.initializeAtlasArray(next);
    next.initialized = true;
    const source = this.#renderer.texture.getGpuSource(previous.source);
    const destination = this.#renderer.texture.getGpuSource(next.source);
    const encoder = this.#renderer.gpu.device.createCommandEncoder({
      label: "pixi-glyphflow-atlas-array-migration",
    });
    for (let layer = 0; layer < previous.layerCount; layer += 1) {
      encoder.copyTextureToTexture(
        { texture: source, origin: { x: 0, y: 0, z: layer } },
        { texture: destination, origin: { x: 0, y: 0, z: layer } },
        { width: previous.width, height: previous.height, depthOrArrayLayers: 1 },
      );
    }
    const queue = this.#renderer.gpu.device.queue;
    queue.submit([encoder.finish()]);
    const retire = (): void => {
      cleanupBestEffort([
        () => previous.texture.destroy(true),
        () => {
          if (!previous.source.destroyed) previous.source.destroy();
        },
      ]);
    };
    void queue.onSubmittedWorkDone().then(retire, retire);
    return true;
  }

  uploadAtlas(
    page: BackendAtlasPage,
    x: number,
    y: number,
    width: number,
    height: number,
    pixels: Uint8Array,
  ): void {
    const texture = this.#renderer.texture.getGpuSource(page.array.source);
    const packed = packGpuTextureRows(pixels, width, height, page.array.kind === "r" ? 1 : 4);
    this.#renderer.gpu.device.queue.writeTexture(
      { texture, origin: { x, y, z: page.info.layer } },
      packed.data,
      { bytesPerRow: packed.bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
  }

  async copyColorAtlasToArray(
    source: GPUTexture,
    copies: readonly Readonly<BackendColorAtlasCopy>[],
  ): Promise<true> {
    if (copies.length === 0) return true;
    const encoder = this.#renderer.gpu.device.createCommandEncoder({
      label: "pixi-glyphflow-outline-color-array-copy",
    });
    for (const copy of copies) {
      const destination = this.#renderer.texture.getGpuSource(copy.destination.array.source);
      encoder.copyTextureToTexture(
        { texture: source, origin: { x: copy.sourceX, y: copy.sourceY, z: 0 } },
        {
          texture: destination,
          origin: {
            x: copy.destinationX,
            y: copy.destinationY,
            z: copy.destination.info.layer,
          },
        },
        { width: copy.width, height: copy.height, depthOrArrayLayers: 1 },
      );
    }
    this.#renderer.gpu.device.queue.submit([encoder.finish()]);
    await this.#renderer.gpu.device.queue.onSubmittedWorkDone();
    return true;
  }

  initializeTexture(source: BufferImageSource): void {
    this.#renderer.texture.getGpuSource(source);
  }

  uploadFloatTextureRanges(
    source: BufferImageSource,
    data: Float32Array,
    textureWidth: number,
    ranges: readonly Readonly<DirtyByteRange>[],
  ): Readonly<{ bytes: number; writes: number }> {
    let bytes = 0;
    let writes = 0;
    const texture = this.#renderer.texture.getGpuSource(source);
    for (const range of ranges) {
      for (const rect of paletteUploadRects(range.offset, range.length, textureWidth)) {
        const texels = rect.width * rect.height;
        this.#renderer.gpu.device.queue.writeTexture(
          { texture, origin: { x: rect.x, y: rect.y, z: 0 } },
          packedFloatTexelView(data, rect.texel, texels),
          { bytesPerRow: rect.width * FLOAT_TEXEL_BYTES, rowsPerImage: rect.height },
          { width: rect.width, height: rect.height, depthOrArrayLayers: 1 },
        );
        bytes += texels * FLOAT_TEXEL_BYTES;
        writes += 1;
      }
    }
    return { bytes, writes };
  }

  planPaletteTextureRanges(
    ranges: readonly Readonly<DirtyByteRange>[],
    _activePaletteIndices: readonly number[],
    _effectBase: number,
  ): readonly Readonly<DirtyByteRange>[] {
    return ranges;
  }

  preparePaletteTextureUpload(_texture: Texture, _meshes: Iterable<GlyphMesh>): void {}

  createMesh(options: GlyphMeshOptions): GlyphMesh {
    const mesh = new GlyphMesh(options);
    this.#meshes.add(mesh);
    return mesh;
  }

  bindMesh(mesh: GlyphMesh, bindings: Readonly<BackendMeshBindings>): void {
    bindMeshResources(mesh, bindings);
  }

  initializeMesh(mesh: GlyphMesh): void {
    this.#renderer.buffer.updateBuffer(mesh.instanceBuffer);
  }

  destroyMesh(mesh: GlyphMesh): void {
    this.#meshes.delete(mesh);
    this.#retireMesh(mesh, this.#computeCullPass);
  }

  destroy(resources: Readonly<BackendDestroyResources>): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const meshes = Array.from(resources.meshes);
    const atlasTextures = Array.from(resources.atlasTextures);
    const computeCullPass = this.#computeCullPass;
    const paletteStoragePass = this.#paletteStoragePass;
    this.#computeCullPass = undefined;
    this.#paletteStoragePass = undefined;
    this.#meshes.clear();
    const retire = (): void => {
      cleanupBestEffortOrThrow([
        ...meshes.map((mesh) => () => this.#retireMesh(mesh, computeCullPass)),
        () => computeCullPass?.destroy(),
        () => paletteStoragePass?.destroy(),
        ...atlasTextures.map((texture) => () => texture.destroy(true)),
        () => resources.paletteTexture.destroy(true),
        () => resources.prototypeTexture.destroy(true),
      ]);
    };
    const transaction = this.#frameTransaction;
    if (transaction === undefined) retire();
    else transaction.destroy(retire);
  }

  #retireMesh(mesh: GlyphMesh, computeCullPass: ComputeCullPass | undefined): void {
    cleanupBestEffortOrThrow([
      () => computeCullPass?.untrackGeometry(mesh.geometry),
      () => mesh.removeFromParent(),
      () => mesh.destroy(),
    ]);
  }

  #deferComputeCullRetry(device: GPUDevice): void {
    this.#computeCullRetryDevice = device;
    queueMicrotask(() => {
      if (!this.#destroyed && this.#computeCullRetryDevice === device) {
        this.#computeCullRetryDevice = undefined;
      }
    });
  }
}

function createFrameTransaction(renderer: WebGPURenderer): WebGPUFrameTransaction | undefined {
  const encoder = renderer.encoder as WebGPURenderer["encoder"] | undefined;
  if (
    encoder === undefined ||
    typeof encoder.renderStart !== "function" ||
    typeof encoder.postrender !== "function"
  ) {
    return undefined;
  }
  return new WebGPUFrameTransaction(renderer);
}
