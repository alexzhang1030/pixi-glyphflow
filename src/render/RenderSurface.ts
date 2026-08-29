import {
  BufferImageSource,
  Texture,
  type BLEND_MODES,
  type Buffer,
  type Container,
  type Renderer,
  type WebGLRenderer,
  type WebGPURenderer,
} from "pixi.js";

import {
  atlasArrayKind,
  GLYPH_ATLAS_ARRAY_LAYERS,
  type AtlasCommit,
  type AtlasPageInfo,
  type AtlasUpload,
  type GlyphMode,
} from "../atlas/types";
import {
  aabbVisible,
  computeCullStructurallyEligible,
  cullRecordWorldAabb,
  cullViewportsEqual,
  type CullAabbSpace,
  type CullPath,
  type CullRecordDirty,
  type CullViewport,
  resolveCullPath,
} from "../culling/computeCull";
import { ComputeCullPass } from "./ComputeCullPass";
import { GlyphMesh } from "./GlyphMesh";
import {
  allocatePrototypePixels,
  FLOAT_TEXEL_BYTES,
  packedFloatTexelView,
  packGpuTextureRows,
  paletteUploadRects,
  premultiplyRgba8,
  webglFloatPaletteRects,
  prototypeByteRange,
  prototypeTextureLayout,
  writeDrawInstance,
  writePrototypeGlyphs,
} from "./pack";
import {
  readyPalettePath,
  resolvePalettePath,
  type PaletteMoveUpload,
  type PalettePath,
} from "./paletteStorage";
import { PaletteStoragePass } from "./PaletteStoragePass";
import type { RenderCommitResult, RenderCoordinator, RenderDrawState } from "./RenderCoordinator";
import {
  GLYPH_DRAW_STRIDE,
  GLYPH_INSTANCE_STRIDE,
  GLYPH_PROTO_TEXTURE_WIDTH,
  type DirtyByteRange,
} from "./types";

const ACTIVE_BIT = 0x8000_0000;
function emptySegmentWalk(): SegmentWalk {
  return { segments: [], naturalOrder: true, count: 0, lastSourceIndex: -1 };
}

interface AtlasArray {
  kind: "r" | "rgba";
  format: "r8unorm" | "rgba8unorm";
  width: number;
  height: number;
  layerCapacity: number;
  layerCount: number;
  source: BufferImageSource;
  texture: Texture;
  initialized: boolean;
  dummy: boolean;
}

interface AtlasTexturePage {
  readonly info: Readonly<AtlasPageInfo>;
  readonly pixels: Uint8Array;
  array: AtlasArray;
}

interface SurfaceMesh {
  atlasGeneration: number;
  blendMode: BLEND_MODES;
  readonly mesh: GlyphMesh;
  data: ArrayBuffer;
  compact: boolean;
  initialized: boolean;
}

interface DrawSpan {
  readonly offset: number;
  count: number;
  readonly paletteIndex: number;
}

interface SegmentWalk {
  segments: DrawSegment[];
  naturalOrder: boolean;
  count: number;
  lastSourceIndex: number;
}

interface DrawSegmentCache extends SegmentWalk {
  drawEpoch: number;
  segmentEpoch: number;
  stateCount: number;
}

interface DrawSegment {
  readonly zIndex: number;
  readonly blendMode: BLEND_MODES;
  readonly spans: DrawSpan[];
  count: number;
}

export interface RenderComputeCullUpdate {
  /** The complete packed record buffer, so a stale GPU mirror can always resync in full. */
  readonly records: ArrayBuffer;
  readonly recordCount: number;
  readonly recordDirty: CullRecordDirty;
  readonly viewport: CullViewport;
  /** Local boxes plus palette origins when the GPU owns the world AABB. */
  readonly aabbSpace?: CullAabbSpace;
  /** Palette origins moved; re-cull even when records are clean. */
  readonly recompute?: boolean;
}

export interface RenderSurfaceStats {
  readonly adapter: "webgl" | "webgpu" | "unknown";
  readonly cullPath: CullPath;
  readonly palettePath: PalettePath;
  readonly meshes: number;
  readonly atlasTextures: number;
  readonly submittedGlyphs: number;
  readonly atlasUploadBytes: number;
  readonly instanceUploadBytes: number;
  readonly transformUploadBytes: number;
  readonly instanceWrites: number;
  readonly transformWrites: number;
  readonly pageRebuilds: number;
  readonly lastUploadMs: number;
}

export class RenderSurface {
  readonly #renderer: Renderer;
  readonly #owner: Container;
  readonly #coordinator: RenderCoordinator;
  readonly #pages = new Map<number, AtlasTexturePage>();
  #rArray: AtlasArray;
  #rgbaArray: AtlasArray;
  #atlasGeneration = 0;
  readonly #meshes = new Map<number, SurfaceMesh>();
  #paletteSource: BufferImageSource;
  #paletteTexture: Texture;
  #paletteData: Float32Array;
  #paletteInitialized = false;
  #protoSource: BufferImageSource;
  #protoTexture: Texture;
  #protoPixels: Float32Array;
  #protoWidth = GLYPH_PROTO_TEXTURE_WIDTH;
  #protoInitialized = false;
  #paletteGrew = false;
  #syncedDrawEpoch = -1;
  #syncedSegmentEpoch = -1;
  #submittedGlyphs = 0;
  #atlasUploadBytes = 0;
  #instanceUploadBytes = 0;
  #transformUploadBytes = 0;
  #instanceWrites = 0;
  #transformWrites = 0;
  #pageRebuilds = 0;
  #lastUploadMs = 0;
  #cullPass: ComputeCullPass | undefined;
  #cullPath: CullPath = "cpu-grid";
  #palettePass: PaletteStoragePass | undefined;
  #palettePath: PalettePath = "texture";
  #queuedMoves: PaletteMoveUpload | undefined;
  #originX: Float32Array | undefined;
  #originY: Float32Array | undefined;
  #storageSynced = false;
  #computeEligible = true;
  readonly #computeCull: boolean | "auto";
  #lastCullViewport: CullViewport | undefined;
  #segmentCache: DrawSegmentCache | undefined;
  #destroyed = false;

  constructor(
    renderer: Renderer,
    owner: Container,
    coordinator: RenderCoordinator,
    options: { readonly computeCull?: boolean | "auto" } = {},
  ) {
    this.#renderer = renderer;
    this.#owner = owner;
    this.#coordinator = coordinator;
    this.#computeCull = options.computeCull ?? "auto";
    this.#paletteData = coordinator.transforms.data;
    this.#paletteSource = createPaletteSource(coordinator);
    this.#paletteTexture = new Texture({ source: this.#paletteSource });
    this.#protoPixels = allocatePrototypePixels(GLYPH_PROTO_TEXTURE_WIDTH, 1);
    this.#protoSource = createPrototypeSource(this.#protoPixels, GLYPH_PROTO_TEXTURE_WIDTH, 1);
    this.#protoTexture = new Texture({ source: this.#protoSource });
    this.#rArray = createAtlasArray("r", 1, 1, 1, true);
    this.#rgbaArray = createAtlasArray("rgba", 1, 1, 1, true);
  }

  prepareCullPath(): CullPath {
    if (!isWebGPURenderer(this.#renderer)) return "cpu-grid";
    if (!this.#computeEligible) return "cpu-grid";
    const path = resolveCullPath({
      adapter: "webgpu",
      computeCull: this.#computeCull,
      deviceReady: this.#renderer.gpu?.device !== undefined,
    });
    if (path === "cpu-grid") return path;
    const pass = this.#cullPass ?? new ComputeCullPass(this.#renderer);
    if (!pass.initialize()) return "cpu-grid";
    this.#cullPass = pass;
    return "compute-cull";
  }

  preparePalettePath(): PalettePath {
    const previous = this.#palettePath;
    if (!isWebGPURenderer(this.#renderer)) {
      this.#palettePath = "texture";
      return this.#adoptPalettePath(previous);
    }
    const device = this.#renderer.gpu?.device;
    if (device === undefined) {
      this.#palettePath = "texture";
      return this.#adoptPalettePath(previous);
    }
    const path = resolvePalettePath({
      adapter: "webgpu",
      maxStorageBuffersInVertexStage: device.limits.maxStorageBuffersInVertexStage ?? 0,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      paletteBytes: this.#coordinator.transforms.data.byteLength,
    });
    if (path === "texture") {
      this.#palettePath = "texture";
      return this.#adoptPalettePath(previous);
    }
    const pass = this.#palettePass ?? new PaletteStoragePass(this.#renderer);
    if (!pass.initialize()) {
      this.#palettePath = "texture";
      return this.#adoptPalettePath(previous);
    }
    this.#palettePass = pass;
    const ensured = pass.ensureTransforms(this.#coordinator.transforms.data.byteLength);
    if (!ensured.ok) {
      this.#palettePath = "texture";
      return this.#adoptPalettePath(previous);
    }
    if (ensured.replaced && previous === "storage") {
      this.#storageSynced = false;
      for (const surface of this.#meshes.values()) {
        surface.mesh.setPaletteStorage(pass.transformBuffer);
      }
    }
    this.#palettePath = "storage";
    return this.#adoptPalettePath(previous);
  }

  queuePaletteMoves(move: PaletteMoveUpload): void {
    this.#queuedMoves = move;
  }

  bindOriginColumns(originX: Float32Array, originY: Float32Array): void {
    this.#originX = originX;
    this.#originY = originY;
  }

  dropIdleMeshes(): void {
    this.#assertActive();
    if (this.#coordinator.getDrawStates().length !== 0) return;
    this.#destroyMeshes();
  }

  refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    this.#assertActive();
    const uploadStart = performance.now();
    this.flushPaletteStorage();
    const path = this.#refreshComputeCull(update);
    this.#lastUploadMs = performance.now() - uploadStart;
    return path;
  }

  /** Upload dirty fill records and patch mover x/y on the storage table. Texture path no-ops. */
  flushPaletteStorage(): void {
    if (this.preparePalettePath() !== "storage") {
      this.#queuedMoves = undefined;
      return;
    }
    const pass = this.#palettePass;
    if (pass === undefined) return;
    const data = this.#coordinator.transforms.data;
    const ensured = pass.ensureTransforms(data.byteLength);
    if (!ensured.ok) {
      this.#fallbackPaletteToTexture();
      this.#syncPaletteTexture(data, [{ offset: 0, length: data.byteLength }]);
      return;
    }
    if (ensured.replaced) {
      this.#storageSynced = false;
      for (const surface of this.#meshes.values()) {
        surface.mesh.setPaletteStorage(pass.transformBuffer);
      }
    }
    if (!this.#storageSynced) {
      this.#transformUploadBytes += pass.uploadAllTransforms(data);
      this.#transformWrites += 1;
      this.#storageSynced = true;
    }
    const moves = this.#queuedMoves;
    this.#queuedMoves = undefined;
    if (moves === undefined || moves.count <= 0) return;
    this.#transformUploadBytes += pass.dispatchMoves(moves);
    this.#transformWrites += 1;
  }

  #refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    if (this.prepareCullPath() !== "compute-cull") {
      return this.#useCpuCull();
    }
    if (update.recordDirty === "all" && update.recordCount === 0) {
      this.#destroyMeshes();
    } else if (!this.#hasDirectComputeMesh()) this.#syncMeshes(update);
    const pass = this.#cullPass;
    const surface = this.#meshes.get(0);
    if (pass === undefined || surface === undefined || !this.#hasDirectComputeMesh()) {
      return this.#useCpuCull();
    }
    pass.trackGeometry(surface.mesh.geometry);
    const useGpuOrigin = update.aabbSpace === "local";
    const transforms = useGpuOrigin ? this.#palettePass?.gpuTransforms : undefined;
    if (useGpuOrigin && transforms === undefined) {
      this.#syncCompactDraw(update);
      return this.#useCpuCull();
    }
    // ensureCapacity resets the indirect args, so an idle frame must return before it.
    if (
      update.recordDirty === "none" &&
      update.recompute !== true &&
      pass.synced &&
      cullViewportsEqual(this.#lastCullViewport, update.viewport)
    ) {
      this.#cullPath = "compute-cull";
      return this.#cullPath;
    }
    const store = this.#coordinator.instances;
    const drawBytes = store.stats.activeInstances * GLYPH_DRAW_STRIDE;
    if (!pass.ensureCapacity(update.recordCount, drawBytes)) {
      return this.#useCpuCull();
    }
    pass.uploadRecords(update.records, update.recordCount, update.recordDirty);
    if (!pass.dispatch(update.viewport, { transforms, useGpuOrigin })) {
      this.#syncCompactDraw(update);
      return this.#useCpuCull();
    }
    this.#lastCullViewport = update.viewport;
    this.#cullPath = "compute-cull";
    return this.#cullPath;
  }

  apply(
    result: Readonly<RenderCommitResult>,
    computeCull: Readonly<RenderComputeCullUpdate> | undefined = undefined,
  ): void {
    this.#assertActive();
    const uploadStart = performance.now();
    this.#applyAtlasCommit(result.atlasCommit);
    const transformRanges = this.#coordinator.transforms.consumeDirty();
    const instanceRanges = this.#coordinator.instances.consumeDirty();
    this.#syncPalette(transformRanges);
    this.flushPaletteStorage();
    this.#syncPrototype(instanceRanges);
    const needsComputeRebuild = this.#needsComputeMeshRebuild(computeCull);
    const needDrawRebuild =
      result.drawOrderChanged ||
      this.#meshes.size === 0 ||
      needsComputeRebuild ||
      this.#syncedDrawEpoch !== this.#coordinator.drawListEpoch ||
      this.#syncedSegmentEpoch !== this.#coordinator.instances.segmentEpoch;
    if (this.#coordinator.getDrawStates().length === 0) {
      this.#destroyMeshes();
    } else if (needDrawRebuild) {
      this.#syncMeshes(computeCull);
    }
    if (computeCull === undefined) this.#useCpuCull();
    else this.#refreshComputeCull(computeCull);
    const paletteGrew = this.#paletteGrew;
    if (paletteGrew) {
      this.#refreshPrototypeTexture();
      this.#paletteGrew = false;
    }
    this.#bindMeshSources();
    this.#lastUploadMs = performance.now() - uploadStart;
  }

  get stats(): Readonly<RenderSurfaceStats> {
    return Object.freeze({
      adapter: rendererKind(this.#renderer),
      cullPath: this.#cullPath,
      palettePath: this.#palettePath,
      meshes: this.#meshes.size,
      atlasTextures: this.#pages.size,
      submittedGlyphs: this.#submittedGlyphs,
      atlasUploadBytes: this.#atlasUploadBytes,
      instanceUploadBytes: this.#instanceUploadBytes,
      transformUploadBytes: this.#transformUploadBytes,
      instanceWrites: this.#instanceWrites,
      transformWrites: this.#transformWrites,
      pageRebuilds: this.#pageRebuilds,
      lastUploadMs: this.#lastUploadMs,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    for (const surface of this.#meshes.values()) {
      this.#cullPass?.untrackGeometry(surface.mesh.geometry);
      surface.mesh.removeFromParent();
      surface.mesh.destroy();
    }
    this.#meshes.clear();
    this.#rArray.texture.destroy(true);
    this.#rgbaArray.texture.destroy(true);
    this.#pages.clear();
    this.#cullPass?.destroy();
    this.#cullPass = undefined;
    this.#cullPath = "cpu-grid";
    this.#palettePass?.destroy();
    this.#palettePass = undefined;
    this.#palettePath = "texture";
    this.#queuedMoves = undefined;
    this.#storageSynced = false;
    this.#lastCullViewport = undefined;
    this.#paletteTexture.destroy(true);
    this.#paletteData = new Float32Array();
    this.#protoTexture.destroy(true);
    this.#protoPixels = new Float32Array();
    this.#submittedGlyphs = 0;
    this.#destroyed = true;
  }

  #applyAtlasCommit(commit: Readonly<AtlasCommit>): void {
    const dirtyPages = new Map<number, Readonly<AtlasUpload>[]>();
    const dirtyArrays = new Set<AtlasArray>();
    const fullUploaded = new Set<AtlasArray>();
    for (const upload of commit.uploads) {
      const page = this.#ensureAtlasPage(upload.entry.page);
      const pixels = fourChannelMode(page.info.mode)
        ? premultiplyRgba8(upload.pixels)
        : upload.pixels;
      copyAtlasUpload(
        page,
        upload.entry.x,
        upload.entry.y,
        upload.entry.width,
        upload.entry.height,
        pixels,
      );
      const staged: Readonly<AtlasUpload> =
        pixels === upload.pixels ? upload : { entry: upload.entry, pixels };
      const uploads = dirtyPages.get(upload.entry.page);
      if (uploads === undefined) dirtyPages.set(upload.entry.page, [staged]);
      else uploads.push(staged);
      dirtyArrays.add(page.array);
    }
    for (const array of dirtyArrays) {
      // A mid-commit layer grow leaves the replaced array in this set after
      // #adoptAtlasArray destroys it. getGlSource on that source reads a null
      // style and throws addressModeU. See `.agents/docs/gotchas.md`.
      if (array.source.destroyed || array.source.style === null) continue;
      if (!array.initialized) {
        initializeAtlasArray(this.#renderer, array);
        array.initialized = true;
        fullUploaded.add(array);
        for (const page of this.#pages.values()) {
          if (page.array !== array) continue;
          uploadAtlasLayer(this.#renderer, page);
          this.#atlasUploadBytes += page.pixels.byteLength;
        }
      }
    }
    for (const [pageId, uploads] of dirtyPages) {
      const page = this.#pages.get(pageId);
      if (page === undefined || fullUploaded.has(page.array)) continue;
      const rectBytes = uploads.reduce((sum, upload) => sum + upload.pixels.byteLength, 0);
      if (rectBytes * 2 > page.pixels.byteLength) {
        uploadAtlasLayer(this.#renderer, page);
        this.#atlasUploadBytes += page.pixels.byteLength;
        continue;
      }
      uploadAtlasRects(this.#renderer, page, uploads);
      this.#atlasUploadBytes += rectBytes;
    }
  }

  #ensureAtlasPage(pageId: number): AtlasTexturePage {
    const existing = this.#pages.get(pageId);
    if (existing !== undefined) return existing;
    const info = this.#coordinator.atlas.getPage(pageId);
    if (info === undefined) throw new Error(`Atlas page ${String(pageId)} is unavailable`);
    const kind = atlasArrayKind(info.mode);
    const array = this.#adoptAtlasArray(kind, info);
    const page: AtlasTexturePage = {
      info,
      pixels: new Uint8Array(info.bytes),
      array,
    };
    this.#pages.set(pageId, page);
    array.layerCount = Math.max(array.layerCount, info.layer + 1);

    return page;
  }

  #adoptAtlasArray(kind: "r" | "rgba", info: Readonly<AtlasPageInfo>): AtlasArray {
    const current = kind === "r" ? this.#rArray : this.#rgbaArray;
    const needsReplace =
      current.dummy ||
      current.width !== info.width ||
      current.height !== info.height ||
      info.layer >= current.layerCapacity;
    if (!needsReplace) return current;
    const minLayers = Math.max(info.layer + 1, current.dummy ? 1 : current.layerCount);
    const next = createAtlasArray(kind, info.width, info.height, minLayers, false);
    const previous = current.texture;
    if (kind === "r") this.#rArray = next;
    else this.#rgbaArray = next;
    for (const page of this.#pages.values()) {
      if (atlasArrayKind(page.info.mode) === kind) page.array = next;
    }
    this.#atlasGeneration += 1;
    this.#pageRebuilds += 1;
    // Pixi BindGroup.destroy()s itself when a bound TextureSource is destroyed.
    // Point live meshes at `next` before tearing the old source down.
    this.#bindMeshSources();
    previous.destroy(true);
    return next;
  }

  #syncPalette(ranges: readonly Readonly<DirtyByteRange>[]): void {
    const data = this.#coordinator.transforms.data;
    if (this.preparePalettePath() === "storage") {
      this.#syncPaletteStorage(data, ranges);
      if (this.#palettePath === "storage") return;
    }
    this.#syncPaletteTexture(data, ranges);
  }

  #syncPaletteTexture(data: Float32Array, ranges: readonly Readonly<DirtyByteRange>[]): void {
    const stats = this.#coordinator.transforms.stats;
    if (data !== this.#paletteData) {
      const oldTexture = this.#paletteTexture;
      this.#paletteData = data;
      this.#paletteSource = createPaletteSource(this.#coordinator);
      this.#paletteTexture = new Texture({ source: this.#paletteSource });
      this.#paletteInitialized = false;
      for (const surface of this.#meshes.values()) {
        surface.mesh.setPaletteTexture(this.#paletteTexture, stats.textureWidth, stats.effectBase);
      }
      oldTexture.destroy(true);
      this.#paletteGrew = true;
    }
    if (ranges.length === 0) return;
    if (!this.#paletteInitialized) {
      initializeTexture(this.#renderer, this.#paletteSource);
      this.#paletteInitialized = true;
      this.#bindMeshSources();
      this.#transformUploadBytes += data.byteLength;
      this.#transformWrites += 1;
      return;
    }
    if (isWebGLRenderer(this.#renderer)) {
      // A bound rgba32float vertex palette rewritten with texSubImage2D/texImage2D blanks
      // the compositor on ANGLE/SwiftShader. Unbind the mesh sampler and GL units first.
      for (const surface of this.#meshes.values()) surface.mesh.unbindPaletteTexture();
      unbindWebGLPalette(this.#renderer, this.#paletteTexture);
      const uploaded = uploadFloatTextureRanges(
        this.#renderer,
        this.#paletteSource,
        data,
        stats.textureWidth,
        ranges,
      );
      this.#transformUploadBytes += uploaded.bytes;
      this.#transformWrites += uploaded.writes;
      unbindWebGLPalette(this.#renderer, this.#paletteTexture);
      this.#bindMeshSources();
      return;
    }
    const uploaded = uploadFloatTextureRanges(
      this.#renderer,
      this.#paletteSource,
      data,
      stats.textureWidth,
      ranges,
    );
    this.#transformUploadBytes += uploaded.bytes;
    this.#transformWrites += uploaded.writes;
  }

  #syncPaletteStorage(data: Float32Array, ranges: readonly Readonly<DirtyByteRange>[]): void {
    const grew = data !== this.#paletteData;
    if (grew) {
      this.#paletteData = data;
      this.#storageSynced = false;
      if (this.#originX !== undefined && this.#originY !== undefined) {
        this.#coordinator.transforms.refreshOrigins(this.#originX, this.#originY);
      }
    }
    if (!this.#storageSynced || ranges.length === 0) return;
    const pass = this.#palettePass;
    if (pass === undefined) return;
    if (!pass.ensureTransforms(data.byteLength).ok) {
      this.#fallbackPaletteToTexture();
      return;
    }
    this.#transformUploadBytes += pass.uploadTransforms(data, ranges);
    this.#transformWrites += 1;
  }

  #adoptPalettePath(previous: PalettePath): PalettePath {
    if (previous !== this.#palettePath && this.#meshes.size > 0) {
      this.#destroyMeshes();
    }
    return this.#palettePath;
  }

  #fallbackPaletteToTexture(): void {
    if (this.#originX !== undefined && this.#originY !== undefined) {
      this.#coordinator.transforms.refreshOrigins(this.#originX, this.#originY);
    }
    this.#queuedMoves = undefined;
    this.#storageSynced = false;
    this.#paletteInitialized = false;
    this.#palettePath = "texture";
    if (this.#meshes.size > 0) this.#destroyMeshes();
  }

  #bindMeshSources(): void {
    const stats = this.#coordinator.transforms.stats;
    const textures = this.#atlasTextures();
    const storage = this.#readyPaletteStorage();
    for (const surface of this.#meshes.values()) {
      surface.mesh.setPaletteTexture(this.#paletteTexture, stats.textureWidth, stats.effectBase);
      if (storage !== undefined) surface.mesh.setPaletteStorage(storage);
      surface.mesh.setPrototypeTexture(this.#protoTexture, this.#protoWidth);
      if (surface.atlasGeneration !== this.#atlasGeneration) {
        surface.atlasGeneration = this.#atlasGeneration;
        surface.mesh.setTextures(textures);
      }
    }
  }

  #readyPaletteStorage(): Buffer | undefined {
    if (this.#palettePath !== "storage") return undefined;
    const pass = this.#palettePass;
    if (pass === undefined || !pass.hasGpuTransforms) return undefined;
    return pass.transformBuffer;
  }

  #useReadyPaletteForMeshes(): void {
    if (this.#palettePath === "storage" && this.#readyPaletteStorage() === undefined) {
      this.#fallbackPaletteToTexture();
    }
  }

  #atlasTextures(): readonly [Texture, Texture] {
    return [this.#rArray.texture, this.#rgbaArray.texture];
  }

  /** Rewrite the live store into the existing proto texture. See `.agents/docs/gotchas.md`. */
  #refreshPrototypeTexture(): void {
    const highWater = this.#coordinator.instances.stats.highWater;
    if (this.#protoPixels.length === 0) return;
    writePrototypeGlyphs(this.#protoPixels, this.#coordinator.instances.buffer, 0, highWater);
    this.#protoSource.update();
    const uploaded = uploadFloatTextureRanges(
      this.#renderer,
      this.#protoSource,
      this.#protoPixels,
      this.#protoWidth,
      [{ offset: 0, length: this.#protoPixels.byteLength }],
    );
    initializeTexture(this.#renderer, this.#protoSource);
    this.#protoInitialized = true;
    this.#instanceUploadBytes += uploaded.bytes;
    this.#instanceWrites += uploaded.writes;
  }

  #adoptPrototypePixels(pixels: Float32Array, width: number): void {
    const oldTexture = this.#protoTexture;
    this.#protoPixels = pixels;
    this.#protoWidth = width;
    this.#protoSource = createPrototypeSource(pixels, width, pixels.length / (width * 4));
    this.#protoTexture = new Texture({ source: this.#protoSource });
    this.#protoInitialized = false;
    for (const surface of this.#meshes.values()) {
      surface.mesh.setPrototypeTexture(this.#protoTexture, width);
    }
    oldTexture.destroy(true);
  }

  #syncPrototype(ranges: readonly Readonly<DirtyByteRange>[]): void {
    const store = this.#coordinator.instances;
    const highWater = store.stats.highWater;
    if (highWater === 0 && ranges.length === 0) return;
    const maxSize = rendererMaxTextureSize(this.#renderer);
    const layout = prototypeTextureLayout(highWater, maxSize);
    const needed = layout.width * layout.height * 4;
    if (this.#protoPixels.length !== needed || this.#protoWidth !== layout.width) {
      const pixels = allocatePrototypePixels(layout.width, layout.height);
      writePrototypeGlyphs(pixels, store.buffer, 0, highWater);
      this.#adoptPrototypePixels(pixels, layout.width);
    } else {
      for (const range of ranges) {
        const startGlyph = Math.floor(range.offset / GLYPH_INSTANCE_STRIDE);
        const endGlyph = Math.ceil((range.offset + range.length) / GLYPH_INSTANCE_STRIDE);
        writePrototypeGlyphs(
          this.#protoPixels,
          store.buffer,
          startGlyph,
          Math.max(0, endGlyph - startGlyph),
        );
      }
    }
    if (ranges.length === 0 && this.#protoInitialized) return;
    if (!this.#protoInitialized) {
      initializeTexture(this.#renderer, this.#protoSource);
      this.#protoInitialized = true;
      this.#instanceUploadBytes += this.#protoPixels.byteLength;
      this.#instanceWrites += 1;
      return;
    }
    const protoRanges = ranges.map((range) => prototypeByteRange(range.offset, range.length));
    const uploaded = uploadFloatTextureRanges(
      this.#renderer,
      this.#protoSource,
      this.#protoPixels,
      this.#protoWidth,
      protoRanges,
    );
    this.#instanceUploadBytes += uploaded.bytes;
    this.#instanceWrites += uploaded.writes;
  }

  #syncMeshes(computeCull: Readonly<RenderComputeCullUpdate> | undefined): void {
    this.#useReadyPaletteForMeshes();
    const store = this.#coordinator.instances;
    const storeStats = store.stats;
    if (storeStats.activeInstances === 0 || this.#coordinator.getDrawStates().length === 0) {
      this.#destroyMeshes();
      return;
    }
    const data = store.buffer;
    const view = new DataView(data);
    const draw = this.#buildDrawSegments(view);
    this.#computeEligible = computeCullStructurallyEligible({
      segmentCount: draw.segments.length,
      highWater: storeStats.highWater,
      activeInstances: storeStats.activeInstances,
    });
    if (this.#computeEligible && computeCull !== undefined) {
      const segment = draw.segments[0];
      if (segment === undefined) throw new Error("Active glyph segment is unavailable");
      this.#syncComputeMesh(segment.blendMode);
      this.#submittedGlyphs = storeStats.activeInstances;
      this.#markDrawSynced();
      return;
    }
    const compactDraw =
      computeCull === undefined
        ? draw
        : this.#buildDrawSegments(
            view,
            this.#visibleCullRecords(
              computeCull.records,
              computeCull.viewport,
              computeCull.recordCount,
              computeCull.aabbSpace,
            ),
          );
    this.#syncCompactMeshes(compactDraw.segments);
    this.#submittedGlyphs = compactDraw.count;
    this.#markDrawSynced();
  }

  #markDrawSynced(): void {
    this.#syncedDrawEpoch = this.#coordinator.drawListEpoch;
    this.#syncedSegmentEpoch = this.#coordinator.instances.segmentEpoch;
  }

  /** Full walks are cached; while both epochs hold, states only append and pages are stable. */
  #buildDrawSegments(
    view: DataView,
    included: Uint8Array | undefined = undefined,
  ): Readonly<{
    segments: DrawSegment[];
    naturalOrder: boolean;
    count: number;
  }> {
    const states = this.#coordinator.getDrawStates();
    if (included !== undefined) {
      const walk = emptySegmentWalk();
      this.#appendDrawSegments(walk, view, states, 0, included);
      return walk;
    }
    const drawEpoch = this.#coordinator.drawListEpoch;
    const segmentEpoch = this.#coordinator.instances.segmentEpoch;
    const cached = this.#segmentCache;
    if (
      cached !== undefined &&
      cached.drawEpoch === drawEpoch &&
      cached.segmentEpoch === segmentEpoch &&
      cached.stateCount <= states.length
    ) {
      if (cached.stateCount < states.length) {
        this.#appendDrawSegments(cached, view, states, cached.stateCount, undefined);
        cached.stateCount = states.length;
      }
      return cached;
    }
    const walk: DrawSegmentCache = {
      ...emptySegmentWalk(),
      drawEpoch,
      segmentEpoch,
      stateCount: states.length,
    };
    this.#appendDrawSegments(walk, view, states, 0, undefined);
    if (walk.segments.reduce((sum, segment) => sum + segment.count, 0) !== walk.count) {
      throw new Error("Draw segment glyph count differs from active instance count");
    }
    this.#segmentCache = walk;
    return walk;
  }

  #appendDrawSegments(
    walk: SegmentWalk,
    view: DataView,
    states: readonly Readonly<RenderDrawState>[],
    startIndex: number,
    included: Uint8Array | undefined,
  ): void {
    const segments = walk.segments;
    for (let stateIndex = startIndex; stateIndex < states.length; stateIndex += 1) {
      if (included !== undefined && included[stateIndex] !== 1) continue;
      const state = states[stateIndex];
      if (state === undefined) throw new Error("Draw state list is incomplete");
      const range = this.#coordinator.instances.getRange(state.slot);
      if (range === undefined) continue;
      walk.count += range.count;
      for (let index = 0; index < range.count; index += 1) {
        const sourceIndex = range.offset + index;
        const metadata = view.getUint32(sourceIndex * GLYPH_INSTANCE_STRIDE + 20, true);
        if ((metadata & ACTIVE_BIT) === 0) {
          throw new Error(`Inactive glyph found in label range ${String(state.slot)}`);
        }
        if (sourceIndex <= walk.lastSourceIndex) walk.naturalOrder = false;
        walk.lastSourceIndex = sourceIndex;
        let segment = segments[segments.length - 1];
        if (
          segment === undefined ||
          segment.zIndex !== state.zIndex ||
          segment.blendMode !== state.blendMode
        ) {
          segment = {
            zIndex: state.zIndex,
            blendMode: state.blendMode,
            spans: [],
            count: 0,
          };
          segments.push(segment);
        }
        const span = segment.spans[segment.spans.length - 1];
        if (
          span !== undefined &&
          span.offset + span.count === sourceIndex &&
          span.paletteIndex === state.slot
        ) {
          span.count += 1;
        } else {
          segment.spans.push({ offset: sourceIndex, count: 1, paletteIndex: state.slot });
        }
        segment.count += 1;
      }
    }
  }

  #visibleCullRecords(
    records: ArrayBuffer,
    viewport: CullViewport,
    recordCount: number,
    aabbSpace: CullAabbSpace = "world",
  ): Uint8Array {
    const states = this.#coordinator.getDrawStates();
    if (recordCount !== states.length) {
      throw new Error("Cull record count differs from draw state count");
    }
    const floats = new Float32Array(records);
    const uints = new Uint32Array(records);
    const included = new Uint8Array(recordCount);
    for (let index = 0; index < recordCount; index += 1) {
      const box = cullRecordWorldAabb(
        floats,
        uints,
        index,
        aabbSpace,
        this.#originX,
        this.#originY,
      );
      included[index] = Number(
        aabbVisible(box.minX, box.minY, box.maxX, box.maxY, viewport),
      );
    }
    return included;
  }

  #syncComputeMesh(blendMode: BLEND_MODES): void {
    this.#useReadyPaletteForMeshes();
    for (const [key, surface] of this.#meshes) {
      if (key !== 0) this.#destroyMesh(key, surface);
    }
    let surface = this.#meshes.get(0);
    const dummy =
      surface !== undefined && !surface.compact && surface.data.byteLength >= GLYPH_DRAW_STRIDE
        ? surface.data
        : new ArrayBuffer(GLYPH_DRAW_STRIDE);
    if (surface === undefined) {
      surface = this.#createMesh(0, blendMode, dummy, 1, false);
      // Indirect draw binds the compute pass compact buffer. Leave the dummy unread.
      surface.initialized = false;
      return;
    }
    this.#configureMesh(surface, blendMode, 0);
    surface.compact = false;
    if (surface.data !== dummy) {
      surface.data = dummy;
      surface.mesh.updateInstances(dummy, 1);
    } else {
      surface.mesh.setInstanceCount(1);
    }
    surface.initialized = false;
  }

  #syncCompactMeshes(segments: readonly DrawSegment[]): void {
    for (const [key, surface] of this.#meshes) {
      if (key >= segments.length) this.#destroyMesh(key, surface);
    }
    for (let key = 0; key < segments.length; key += 1) {
      const segment = segments[key];
      if (segment === undefined) throw new Error(`Draw segment ${String(key)} is unavailable`);
      const current = this.#meshes.get(key);
      const capacity = nextPowerOfTwo(segment.count);
      const buffer =
        current !== undefined &&
        current.compact &&
        current.data.byteLength >= capacity * GLYPH_DRAW_STRIDE
          ? current.data
          : new ArrayBuffer(capacity * GLYPH_DRAW_STRIDE);
      const words = new Uint32Array(buffer);
      let write = 0;
      for (const span of segment.spans) {
        for (let glyph = 0; glyph < span.count; glyph += 1) {
          writeDrawInstance(words, write, span.offset + glyph, span.paletteIndex);
          write += 1;
        }
      }
      let surface = current;
      if (surface === undefined) {
        surface = this.#createMesh(key, segment.blendMode, buffer, segment.count, true);
      } else {
        this.#configureMesh(surface, segment.blendMode, key);
        this.#cullPass?.untrackGeometry(surface.mesh.geometry);
        surface.data = buffer;
        surface.compact = true;
        surface.mesh.updateInstances(buffer, segment.count);
      }
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += segment.count * GLYPH_DRAW_STRIDE;
      this.#instanceWrites += 1;
    }
    this.#orderSegmentMeshes(segments.length);
    this.#pageRebuilds += 1;
  }

  #orderSegmentMeshes(count: number): void {
    for (let key = 0; key < count; key += 1) {
      const surface = this.#meshes.get(key);
      if (surface !== undefined) this.#owner.addChild(surface.mesh);
    }
  }

  #createMesh(
    key: number,
    blendMode: BLEND_MODES,
    data: ArrayBuffer,
    count: number,
    compact: boolean,
  ): SurfaceMesh {
    const textures = this.#atlasTextures();
    const paletteStats = this.#coordinator.transforms.stats;
    const paletteStorage = this.#readyPaletteStorage();
    const mesh = new GlyphMesh({
      texture: textures[0],
      textures,
      paletteTexture: this.#paletteTexture,
      paletteWidth: paletteStats.textureWidth,
      palettePath: readyPalettePath(this.#palettePath, paletteStorage !== undefined),
      ...(paletteStorage === undefined ? {} : { paletteStorage }),
      prototypeTexture: this.#protoTexture,
      prototypeWidth: this.#protoWidth,
      effectBase: paletteStats.effectBase,
      instanceData: data,
      instanceCount: count,
    });
    mesh.label = `pixi-glyphflow-segment-${String(key)}`;
    mesh.blendMode = blendMode;
    this.#owner.addChild(mesh);
    const surface: SurfaceMesh = {
      atlasGeneration: this.#atlasGeneration,
      blendMode,
      mesh,
      data,
      compact,
      initialized: false,
    };
    this.#meshes.set(key, surface);

    return surface;
  }

  #configureMesh(surface: SurfaceMesh, blendMode: BLEND_MODES, key: number): void {
    if (surface.atlasGeneration !== this.#atlasGeneration) {
      surface.atlasGeneration = this.#atlasGeneration;
      surface.mesh.setTextures(this.#atlasTextures());
    }
    if (surface.blendMode !== blendMode) {
      surface.blendMode = blendMode;
      surface.mesh.blendMode = blendMode;
    }
    surface.mesh.label = `pixi-glyphflow-segment-${String(key)}`;
    this.#owner.addChild(surface.mesh);
  }

  #destroyMesh(key: number, surface: SurfaceMesh): void {
    this.#cullPass?.untrackGeometry(surface.mesh.geometry);
    surface.mesh.removeFromParent();
    surface.mesh.destroy();
    this.#meshes.delete(key);
  }

  #destroyMeshes(): void {
    for (const [key, surface] of this.#meshes) this.#destroyMesh(key, surface);
    this.#submittedGlyphs = 0;
    this.#syncedDrawEpoch = -1;
    this.#syncedSegmentEpoch = -1;
  }

  #hasDirectComputeMesh(): boolean {
    const direct = this.#meshes.get(0);
    return this.#meshes.size === 1 && direct !== undefined && !direct.compact;
  }

  #needsComputeMeshRebuild(computeCull: Readonly<RenderComputeCullUpdate> | undefined): boolean {
    return computeCull !== undefined && this.#computeEligible && !this.#hasDirectComputeMesh();
  }

  #syncCompactDraw(update: Readonly<RenderComputeCullUpdate>): void {
    this.#useReadyPaletteForMeshes();
    const store = this.#coordinator.instances;
    if (store.stats.activeInstances === 0) {
      this.#destroyMeshes();
      return;
    }
    const view = new DataView(store.buffer);
    const draw = this.#buildDrawSegments(
      view,
      this.#visibleCullRecords(
        update.records,
        update.viewport,
        update.recordCount,
        update.aabbSpace,
      ),
    );
    this.#syncCompactMeshes(draw.segments);
    this.#submittedGlyphs = draw.count;
    this.#markDrawSynced();
  }

  #useCpuCull(): CullPath {
    for (const surface of this.#meshes.values()) {
      this.#cullPass?.untrackGeometry(surface.mesh.geometry);
    }
    this.#cullPass?.invalidateSync();
    this.#cullPath = "cpu-grid";
    this.#lastCullViewport = undefined;
    return this.#cullPath;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("RenderSurface has been destroyed");
  }
}

function createPrototypeSource(
  pixels: Float32Array,
  width: number,
  height: number,
): BufferImageSource {
  return new BufferImageSource({
    resource: pixels,
    width,
    height,
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
    label: "pixi-glyphflow-prototypes",
  });
}

function rendererMaxTextureSize(renderer: Renderer): number {
  if (isWebGLRenderer(renderer)) {
    const size = renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE);
    return typeof size === "number" && size > 0 ? size : 4096;
  }
  if (isWebGPURenderer(renderer)) {
    const size = renderer.gpu?.device?.limits.maxTextureDimension2D;
    return typeof size === "number" && size > 0 ? size : 8192;
  }
  return 4096;
}

function createPaletteSource(coordinator: RenderCoordinator): BufferImageSource {
  const stats = coordinator.transforms.stats;
  return new BufferImageSource({
    resource: coordinator.transforms.data,
    width: stats.textureWidth,
    height: stats.textureHeight,
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
    label: "pixi-glyphflow-transforms",
  });
}

function copyAtlasUpload(
  page: AtlasTexturePage,
  x: number,
  y: number,
  width: number,
  height: number,
  pixels: Uint8Array,
): void {
  const bytesPerPixel = glyphBytesPerPixel(page.info.mode);
  const sourceRowBytes = width * bytesPerPixel;
  const targetRowBytes = page.info.width * bytesPerPixel;
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * sourceRowBytes;
    const targetOffset = (y + row) * targetRowBytes + x * bytesPerPixel;
    page.pixels.set(pixels.subarray(sourceOffset, sourceOffset + sourceRowBytes), targetOffset);
  }
}

function createAtlasArray(
  kind: "r" | "rgba",
  width: number,
  height: number,
  minLayers: number,
  dummy: boolean,
): AtlasArray {
  const layerCapacity = nextLayerCapacity(minLayers);
  const format = kind === "r" ? "r8unorm" : "rgba8unorm";
  const bytesPerPixel = kind === "r" ? 1 : 4;
  const source = new BufferImageSource({
    // Unused: Pixi's buffer uploader is 2D-only. uploadMethodId below skips it.
    resource: new Uint8Array(bytesPerPixel),
    width,
    height,
    format,
    dimensions: "2d",
    viewDimension: "2d-array",
    arrayLayerCount: layerCapacity,
    scaleMode: "linear",
    autoGenerateMipmaps: false,
    // Four-channel pages are premultiplied in copyAtlasUpload. Array uploads cannot
    // use UNPACK_PREMULTIPLY_ALPHA / UNPACK_FLIP_Y, so both formats stay raw.
    alphaMode: "no-premultiply-alpha",
    label: `pixi-glyphflow-atlas-${kind}`,
  });
  // Not in Pixi's uploader map, so getGlSource uses texImage3D (empty 2d-array) instead of
  // texImage2D, and getGpuSource allocates without an unaligned writeTexture of this stub.
  source.uploadMethodId = "glyphflow-atlas-array";
  return {
    kind,
    format,
    width,
    height,
    layerCapacity,
    layerCount: 0,
    source,
    texture: new Texture({ source }),
    initialized: false,
    dummy,
  };
}

function nextLayerCapacity(needed: number): number {
  let capacity = 1;
  while (capacity < needed) capacity *= 2;
  return Math.min(capacity, GLYPH_ATLAS_ARRAY_LAYERS);
}

/**
 * Pixi's BufferImageSource uploaders are 2D-only. Allocate the array ourselves, then write layers
 * with texSubImage3D / writeTexture. Do not call source.update() on these arrays.
 */
function initializeAtlasArray(renderer: Renderer, array: AtlasArray): void {
  if (array.source.destroyed || array.source.style === null) {
    throw new Error("Cannot initialize a destroyed atlas array");
  }
  if (isWebGLRenderer(renderer)) {
    const gl = renderer.gl;
    const resource = renderer.texture.getGlSource(array.source);
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
    return;
  }
  if (isWebGPURenderer(renderer)) {
    renderer.texture.getGpuSource(array.source);
    return;
  }
  array.source.update();
}

function uploadAtlasLayer(renderer: Renderer, page: AtlasTexturePage): void {
  uploadAtlasVolume(renderer, page, 0, 0, page.info.width, page.info.height, page.pixels);
}

/** One new glyph must not re-upload its whole layer; write the staged rectangles instead. */
function uploadAtlasRects(
  renderer: Renderer,
  page: AtlasTexturePage,
  uploads: readonly Readonly<AtlasUpload>[],
): void {
  for (const upload of uploads) {
    uploadAtlasVolume(
      renderer,
      page,
      upload.entry.x,
      upload.entry.y,
      upload.entry.width,
      upload.entry.height,
      upload.pixels,
    );
  }
}

function uploadAtlasVolume(
  renderer: Renderer,
  page: AtlasTexturePage,
  x: number,
  y: number,
  width: number,
  height: number,
  pixels: Uint8Array,
): void {
  const layer = page.info.layer;
  if (isWebGLRenderer(renderer)) {
    const gl = renderer.gl;
    const resource = renderer.texture.getGlSource(page.array.source);
    withAtlasUnpack(gl, () => {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, resource.texture);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        x,
        y,
        layer,
        width,
        height,
        1,
        resource.format,
        resource.type,
        pixels,
      );
    });
    return;
  }
  if (isWebGPURenderer(renderer)) {
    const texture = renderer.texture.getGpuSource(page.array.source);
    const bytesPerPixel = glyphBytesPerPixel(page.info.mode);
    const packed = packGpuTextureRows(pixels, width, height, bytesPerPixel);
    renderer.gpu.device.queue.writeTexture(
      { texture, origin: { x, y, z: layer } },
      packed.data,
      {
        bytesPerRow: packed.bytesPerRow,
        rowsPerImage: height,
      },
      { width, height, depthOrArrayLayers: 1 },
    );
    return;
  }
}

/**
 * ANGLE / SwiftShader FLOAT uploads also honor leftover UNPACK_ROW_LENGTH / SKIP_*. A 39-texel
 * mid-row write then reads as a full 1024-texel row from a short copy and poisons the table.
 */
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

function isWebGL2Context(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): gl is WebGL2RenderingContext {
  return "UNPACK_ROW_LENGTH" in gl;
}

/** WebGL forbids UNPACK_FLIP_Y and UNPACK_PREMULTIPLY_ALPHA on 3D / array uploads. */
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

function unbindWebGLPalette(renderer: WebGLRenderer, texture: Texture): void {
  renderer.texture.unbind(texture);
  const gl = renderer.gl;
  const resource = renderer.texture.getGlSource(texture.source);
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

function initializeTexture(renderer: Renderer, source: BufferImageSource): void {
  if (isWebGLRenderer(renderer)) renderer.texture.getGlSource(source);
  else if (isWebGPURenderer(renderer)) renderer.texture.getGpuSource(source);
  else source.update();
}

function initializeBuffer(renderer: Renderer, mesh: GlyphMesh): void {
  if (isWebGLRenderer(renderer)) renderer.buffer.updateBuffer(mesh.instanceBuffer);
  else if (isWebGPURenderer(renderer)) renderer.buffer.updateBuffer(mesh.instanceBuffer);
  else mesh.instanceBuffer.update();
}

function uploadFloatTextureRanges(
  renderer: Renderer,
  source: BufferImageSource,
  data: Float32Array,
  textureWidth: number,
  ranges: readonly Readonly<DirtyByteRange>[],
): Readonly<{ bytes: number; writes: number }> {
  let bytes = 0;
  let writes = 0;
  if (isWebGLRenderer(renderer)) {
    const gl = renderer.gl;
    const resource = renderer.texture.getGlSource(source);
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
  } else if (isWebGPURenderer(renderer)) {
    const texture = renderer.texture.getGpuSource(source);
    for (const range of ranges) {
      for (const rect of paletteUploadRects(range.offset, range.length, textureWidth)) {
        const texels = rect.width * rect.height;
        renderer.gpu.device.queue.writeTexture(
          { texture, origin: { x: rect.x, y: rect.y, z: 0 } },
          packedFloatTexelView(data, rect.texel, texels),
          { bytesPerRow: rect.width * FLOAT_TEXEL_BYTES, rowsPerImage: rect.height },
          { width: rect.width, height: rect.height, depthOrArrayLayers: 1 },
        );
        bytes += texels * FLOAT_TEXEL_BYTES;
        writes += 1;
      }
    }
  } else if (ranges.length > 0) {
    source.update();
    bytes = data.byteLength;
    writes = 1;
  }

  return { bytes, writes };
}

function glyphBytesPerPixel(mode: GlyphMode): number {
  return mode === "alpha" || mode === "sdf" ? 1 : 4;
}

function fourChannelMode(mode: GlyphMode): boolean {
  switch (mode) {
    case "alpha":
    case "sdf":
      return false;
    case "msdf":
    case "color":
      return true;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function rendererKind(renderer: Renderer): RenderSurfaceStats["adapter"] {
  if (isWebGLRenderer(renderer)) return "webgl";
  if (isWebGPURenderer(renderer)) return "webgpu";
  return "unknown";
}

function isWebGLRenderer(renderer: Renderer): renderer is WebGLRenderer {
  return "gl" in renderer;
}

function isWebGPURenderer(renderer: Renderer): renderer is WebGPURenderer {
  return "gpu" in renderer;
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
