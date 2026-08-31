import {
  BufferImageSource,
  Texture,
  type BLEND_MODES,
  type Buffer,
  type Container,
  type Renderer,
} from "pixi.js";

import { atlasArrayKind, type AtlasPageInfo, type AtlasUpload } from "../atlas/types";
import {
  computeCullStructurallyEligible,
  cullViewportsEqual,
  type CullAabbSpace,
  type CullPath,
  type CullRecordDirty,
  type CullViewport,
} from "../culling/computeCull";
import type { TextLayerResidencyFallbackReason } from "../types";
import { cleanupBestEffort, cleanupBestEffortOrThrow } from "./cleanup";
import type { ComputeCullSubmittedGlyphsDiagnostic } from "./ComputeCullPass";
import { GlyphDrawPlanner, type DrawSegment } from "./GlyphDrawPlanner";
import { GlyphMesh, RESIDENT_RUN_MAX_GLYPHS } from "./GlyphMesh";
import {
  allocatePrototypePixels,
  premultiplyRgba8,
  prototypeByteRange,
  prototypeTextureLayout,
  writeDrawInstance,
  writePrototypeGlyphs,
} from "./pack";
import {
  PALETTE_TRANSFORM_SCATTER_MAX_LABELS,
  planPaletteTransformUpload,
  readyPalettePath,
  type PaletteMoveUpload,
  type PalettePath,
} from "./paletteStorage";
import type { PaletteStoragePass } from "./PaletteStoragePass";
import {
  createPixiRendererPlatform,
  type BackendAtlasArray,
  type BackendAtlasPage,
  type BackendColorAtlasCopy,
  type BackendMeshBindings,
  type PixiRendererPlatform,
} from "./PixiRendererPlatform";
import {
  copyAtlasUpload,
  createAtlasArray,
  createPaletteSource,
  createPrototypeSource,
  fourChannelMode,
  type RenderColorAtlasCopy,
  type RenderColorAtlasSource,
  validateColorAtlasCopy,
  validateColorAtlasSource,
} from "./PixiRendererResources";
import type { RenderCommitResult, RenderCoordinator, RenderDrawState } from "./RenderCoordinator";
import type { GlyphShaderVariant } from "./shaders";
import {
  GLYPH_DRAW_STRIDE,
  GLYPH_INSTANCE_STRIDE,
  GLYPH_PROTO_TEXELS_PER_GLYPH,
  GLYPH_PROTO_TEXTURE_WIDTH,
  type DirtyByteRange,
} from "./types";

export { createPixiRendererPlatform } from "./PixiRendererPlatform";
export type { RenderColorAtlasCopy, RenderColorAtlasSource } from "./PixiRendererResources";
export type SubmittedGlyphsDiagnostic = ComputeCullSubmittedGlyphsDiagnostic;

type AtlasArray = BackendAtlasArray;
type AtlasTexturePage = BackendAtlasPage;

interface SurfaceMesh {
  atlasGeneration: number;
  blendMode: BLEND_MODES;
  readonly mesh: GlyphMesh;
  data: ArrayBuffer;
  compact: boolean;
  readonly shaderVariant: GlyphShaderVariant;
  readonly residentPrototypeIndex: number | undefined;
  readonly residentPrototypeCount: number | undefined;
  residentPrototypeContentEpoch: number | undefined;
  residentPrototypeFingerprint: Uint32Array | undefined;
}

export interface RenderComputeCullUpdate {
  /** The complete packed record buffer, so a stale GPU mirror can always resync in full. */
  readonly records: ArrayBuffer;
  readonly recordCount: number;
  readonly recordDirty: CullRecordDirty;
  /** Resident scenes provide the full logical glyph upper bound for compact-output sizing. */
  readonly drawInstanceCount?: number;
  /** GPU-resident prototype bounds. Presence selects the fused palette + record patch path. */
  readonly localBounds?: Float32Array;
  readonly localBoundsCount?: number;
  readonly localBoundsDirty?: "all" | "none";
  readonly viewport: CullViewport;
  /** Viewport residency stores local boxes when the storage palette owns live origins. */
  readonly aabbSpace?: CullAabbSpace;
  /** Palette origins changed while the local cull records stayed clean. */
  readonly recompute?: boolean;
}

interface PaletteFlushResult {
  readonly ok: boolean;
  readonly moved: boolean;
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
  readonly cullRecordUploadBytes?: number;
  readonly instanceWrites: number;
  readonly transformWrites: number;
  readonly pageRebuilds: number;
  readonly lastUploadMs: number;
  readonly frameTransactionSubmissions?: number;
  readonly frameTransactionFusedSubmissions?: number;
  readonly frameTransactionStandaloneSubmissions?: number;
}

export interface PixiRendererBackend {
  prepareGpuScene?(): TextLayerResidencyFallbackReason | undefined;
  gpuSceneCapacityFits?(recordCount: number, drawInstanceCount: number): boolean;
  residentFrameRecoveryRequired?(): boolean;
  prepareCullPath(): CullPath;
  preparePalettePath(): PalettePath;
  queuePaletteMoves(move: PaletteMoveUpload): void;
  bindOriginColumns(originX: Float32Array, originY: Float32Array, rotationBits?: Uint16Array): void;
  dropIdleMeshes(): void;
  refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath;
  rebuildCpuCull(update: Readonly<RenderComputeCullUpdate>): void;
  flushPaletteStorage(): void;
  readSubmittedGlyphs(): Promise<number>;
  readSubmittedGlyphsDiagnostic?(): Promise<Readonly<SubmittedGlyphsDiagnostic> | undefined>;
  copyColorAtlasToArray(
    source: Readonly<RenderColorAtlasSource>,
    copies: readonly Readonly<RenderColorAtlasCopy>[],
  ): Promise<boolean>;
  apply(
    result: Readonly<RenderCommitResult>,
    computeCull?: Readonly<RenderComputeCullUpdate>,
  ): void;
  readonly stats: Readonly<RenderSurfaceStats>;
  destroy(): void;
}

export class DefaultPixiRendererBackend implements PixiRendererBackend {
  readonly #platform: PixiRendererPlatform;
  readonly #owner: Container;
  readonly #coordinator: RenderCoordinator;
  readonly #drawPlanner: GlyphDrawPlanner;
  readonly #pages = new Map<number, AtlasTexturePage>();
  readonly #pendingAtlasUploads: Readonly<AtlasUpload>[] = [];
  #rArray: AtlasArray;
  #rgbaArray: AtlasArray;
  #atlasGeneration = 0;
  readonly #meshes = new Map<number, SurfaceMesh>();
  #paletteSource: BufferImageSource;
  #paletteTexture: Texture;
  #paletteData: Float32Array;
  #paletteWidth: number;
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
  #cullRecordUploadBytes = 0;
  #instanceWrites = 0;
  #transformWrites = 0;
  #pageRebuilds = 0;
  #lastUploadMs = 0;
  #cullPath: CullPath = "cpu-grid";
  #palettePath: PalettePath = "texture";
  #queuedMoves: PaletteMoveUpload | undefined;
  #originX: Float32Array | undefined;
  #originY: Float32Array | undefined;
  #rotationBits: Uint16Array | undefined;
  #activePaletteSlots = new Uint32Array(0);
  #storageSynced = false;
  #storageNeedsOriginRefresh = false;
  #computeEligible = true;
  readonly #computeCull: boolean | "auto";
  #lastCullViewport: CullViewport | undefined;
  #acknowledgedFrameFailures = 0;
  #recoveryFailureTarget = 0;
  #recoveryFusedBaseline: number | undefined;
  #atlasFullSyncRequired = false;
  #paletteFullSyncRequired = false;
  #prototypeFullSyncRequired = false;
  #drawRebuildRequired = false;
  #prototypeContentEpoch = 0;
  #destroyed = false;

  constructor(
    renderer: Renderer,
    owner: Container,
    coordinator: RenderCoordinator,
    options: { readonly computeCull?: boolean | "auto" } = {},
  ) {
    const platform = createPixiRendererPlatform(renderer);
    let paletteSource: BufferImageSource | undefined;
    let paletteTexture: Texture | undefined;
    let protoSource: BufferImageSource | undefined;
    let protoTexture: Texture | undefined;
    let rArray: AtlasArray | undefined;
    let rgbaArray: AtlasArray | undefined;
    try {
      const drawPlanner = new GlyphDrawPlanner(coordinator);
      const computeCull = options.computeCull ?? "auto";
      const paletteData = coordinator.transforms.data;
      const paletteWidth = platform.planPaletteTextureWidth(
        paletteData.length / 4,
        coordinator.transforms.stats.textureWidth,
      );
      paletteSource = createPaletteSource(coordinator, paletteWidth);
      paletteTexture = new Texture({ source: paletteSource });
      const protoPixels = allocatePrototypePixels(GLYPH_PROTO_TEXTURE_WIDTH, 1);
      protoSource = createPrototypeSource(protoPixels, GLYPH_PROTO_TEXTURE_WIDTH, 1);
      protoTexture = new Texture({ source: protoSource });
      rArray = createAtlasArray("r", 1, 1, 1, true);
      rgbaArray = createAtlasArray("rgba", 1, 1, 1, true);

      this.#platform = platform;
      this.#owner = owner;
      this.#coordinator = coordinator;
      this.#drawPlanner = drawPlanner;
      this.#computeCull = computeCull;
      this.#paletteData = paletteData;
      this.#paletteWidth = paletteWidth;
      this.#paletteSource = paletteSource;
      this.#paletteTexture = paletteTexture;
      this.#protoPixels = protoPixels;
      this.#protoSource = protoSource;
      this.#protoTexture = protoTexture;
      this.#rArray = rArray;
      this.#rgbaArray = rgbaArray;
    } catch (error: unknown) {
      cleanupBestEffort([
        () => destroyTextureAndSource(rgbaArray?.texture, rgbaArray?.source),
        () => destroyTextureAndSource(rArray?.texture, rArray?.source),
        () => destroyTextureAndSource(protoTexture, protoSource),
        () => destroyTextureAndSource(paletteTexture, paletteSource),
        () =>
          platform.destroy({
            meshes: [],
            atlasTextures: [],
            paletteTexture: Texture.EMPTY,
            prototypeTexture: Texture.EMPTY,
          }),
      ]);
      throw error;
    }
  }

  prepareCullPath(): CullPath {
    return this.#platform.prepareComputeCull(this.#computeCull, this.#computeEligible) === undefined
      ? "cpu-grid"
      : "compute-cull";
  }

  prepareGpuScene(): TextLayerResidencyFallbackReason | undefined {
    if (this.#platform.kind === "unknown") return "renderer-unavailable";
    if (this.#platform.kind === "webgl") return "webgpu-required";
    if (this.#platform.prepareComputeCull(this.#computeCull, true) === undefined) {
      return "compute-cull-unavailable";
    }
    if (this.preparePalettePath() !== "storage") return "storage-palette-unavailable";
    return undefined;
  }

  gpuSceneCapacityFits(recordCount: number, drawInstanceCount: number): boolean {
    const pass = this.#platform.prepareComputeCull(this.#computeCull, true);
    const drawBytes = planGlyphDrawBytes(drawInstanceCount);
    return drawBytes !== undefined && pass?.canFitCapacity(recordCount, drawBytes) === true;
  }

  residentFrameRecoveryRequired(): boolean {
    const transaction = this.#platform.frameTransactionStats;
    if (transaction === undefined) return false;
    const baseline = this.#recoveryFusedBaseline;
    const computeRequiresFullSync = this.#platform.computeCullPass?.requiresFullSync === true;
    if (
      baseline !== undefined &&
      transaction.fusedSubmissions > baseline &&
      !computeRequiresFullSync
    ) {
      this.#acknowledgedFrameFailures = this.#recoveryFailureTarget;
      this.#recoveryFusedBaseline = undefined;
      this.#platform.paletteStoragePass?.acknowledgeFullSync();
    }
    const passRequiresFullSync =
      this.#platform.paletteStoragePass?.requiresFullSync === true || computeRequiresFullSync;
    if (passRequiresFullSync || transaction.failedWork > this.#acknowledgedFrameFailures) {
      if (
        this.#recoveryFusedBaseline === undefined ||
        transaction.failedWork > this.#recoveryFailureTarget
      ) {
        this.#recoveryFailureTarget = transaction.failedWork;
        this.#recoveryFusedBaseline = transaction.fusedSubmissions;
      }
      return true;
    }
    return this.#recoveryFusedBaseline !== undefined;
  }

  preparePalettePath(): PalettePath {
    const previous = this.#palettePath;
    const prepared = this.#platform.preparePaletteStorage(
      this.#coordinator.transforms.data.byteLength,
    );
    if (prepared === undefined) {
      this.#palettePath = "texture";
      return this.#adoptPalettePath(previous);
    }
    if ((prepared.replaced && previous === "storage") || prepared.pass.requiresFullSync) {
      this.#storageSynced = false;
      this.#storageNeedsOriginRefresh = true;
    }
    this.#palettePath = "storage";
    return this.#adoptPalettePath(previous);
  }

  queuePaletteMoves(move: PaletteMoveUpload): void {
    this.#queuedMoves = move;
  }

  bindOriginColumns(
    originX: Float32Array,
    originY: Float32Array,
    rotationBits?: Uint16Array,
  ): void {
    this.#originX = originX;
    this.#originY = originY;
    this.#rotationBits = rotationBits;
  }

  dropIdleMeshes(): void {
    this.#assertActive();
    if (this.#coordinator.getDrawStates().length !== 0) return;
    this.#destroyMeshes();
  }

  refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    this.#assertActive();
    const uploadStart = performance.now();
    const path = this.#refreshComputeCull(update);
    this.#lastUploadMs = performance.now() - uploadStart;
    return path;
  }

  /** Rebuild compact draw state from caller-reconciled records after a resident GPU failure. */
  rebuildCpuCull(update: Readonly<RenderComputeCullUpdate>): void {
    this.#assertActive();
    const uploadStart = performance.now();
    const transformRanges = this.#coordinator.transforms.consumeDirty();
    this.#syncPalette(transformRanges, false);
    this.#syncCompactDraw(update);
    this.#useCpuCull();
    this.#bindMeshSources();
    this.#lastUploadMs = performance.now() - uploadStart;
  }

  /** Upload dirty fill records and patch mover x/y on the storage table. Texture path no-ops. */
  flushPaletteStorage(): void {
    this.#flushPaletteStorage(false);
  }

  #flushPaletteStorage(resident: boolean): Readonly<PaletteFlushResult> {
    if (this.preparePalettePath() !== "storage") {
      this.#queuedMoves = undefined;
      return { ok: !resident, moved: false };
    }
    const pass = this.#platform.paletteStoragePass;
    if (pass === undefined) return { ok: !resident, moved: false };
    if (!resident) pass.bindResidentCullRecords(undefined);
    const data = this.#coordinator.transforms.data;
    if (!this.#storageSynced) {
      const drawStates = this.#coordinator.getDrawStates();
      if (drawStates.length > 0) {
        if (resident) {
          this.#refreshStorageOriginsIfNeeded();
          this.#transformUploadBytes += pass.uploadAllTransforms(data);
        } else {
          const scattered = this.#tryScatterActivePaletteTransforms(
            pass,
            data,
            [{ offset: 0, length: data.byteLength }],
            drawStates,
          );
          if (scattered === undefined) {
            this.#refreshStorageOriginsIfNeeded();
            this.#transformUploadBytes += pass.uploadAllTransforms(data);
          } else {
            this.#transformUploadBytes += scattered;
          }
        }
        this.#transformWrites += 1;
      }
      this.#storageSynced = true;
      this.#storageNeedsOriginRefresh = false;
    }
    const moves = this.#queuedMoves;
    this.#queuedMoves = undefined;
    if (moves === undefined || moves.count <= 0) return { ok: true, moved: false };
    const dispatched = pass.dispatchMovesDetailed(moves);
    this.#transformUploadBytes += dispatched.uploadBytes;
    this.#cullRecordUploadBytes += dispatched.cullRecordUploadBytes;
    this.#transformWrites += dispatched.uploadWrites;
    return {
      ok: dispatched.ok && (!resident || dispatched.mode === "fused-resident"),
      moved: dispatched.ok && dispatched.patchedCullRecords > 0,
    };
  }

  /** Import a completed WebGPU outline atlas into allocated color-array pages. */
  async copyColorAtlasToArray(
    source: Readonly<RenderColorAtlasSource>,
    copies: readonly Readonly<RenderColorAtlasCopy>[],
  ): Promise<boolean> {
    this.#assertActive();
    try {
      validateColorAtlasSource(source);
      const backendCopies: BackendColorAtlasCopy[] = [];
      const arrays = new Set<AtlasArray>();
      for (const copy of copies) {
        const page = this.#ensureAtlasPage(copy.page);
        validateColorAtlasCopy(source, page, copy);
        arrays.add(page.array);
        backendCopies.push({ destination: page, ...copy });
      }
      for (const array of arrays) this.#initializeAtlasArray(array);
      const copied = await this.#platform.copyColorAtlasToArray(source.texture, backendCopies);
      if (copied) {
        this.#atlasUploadBytes += backendCopies.reduce(
          (bytes, copy) => bytes + copy.width * copy.height * 4,
          0,
        );
        this.#bindMeshSources();
      }
      return copied;
    } catch (error: unknown) {
      this.#requireFullApplySync();
      throw error;
    }
  }

  /** Read the latest indirect count on demand; regular commits keep a zero-readback hot path. */
  async readSubmittedGlyphs(): Promise<number> {
    this.#assertActive();
    if (this.#cullPath !== "compute-cull") return this.#submittedGlyphs;
    const observed = await this.#platform.computeCullPass?.readInstanceCount();
    if (observed !== undefined && !this.#destroyed) this.#submittedGlyphs = observed;
    return observed ?? this.#submittedGlyphs;
  }

  /** Read the compacted instance sequence on demand; regular commits keep a zero-readback path. */
  async readSubmittedGlyphsDiagnostic(): Promise<Readonly<SubmittedGlyphsDiagnostic> | undefined> {
    this.#assertActive();
    if (this.#cullPath !== "compute-cull") return undefined;
    const diagnostic = await this.#platform.computeCullPass?.readSubmittedGlyphsDiagnostic();
    if (diagnostic !== undefined && !this.#destroyed) {
      this.#submittedGlyphs = diagnostic.submittedGlyphs;
    }
    return diagnostic;
  }

  #refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    const resident = isGpuResidentCullUpdate(update);
    if (this.prepareCullPath() !== "compute-cull") {
      this.#flushPaletteStorage(false);
      return this.#fallbackComputeCull(update);
    }
    if (update.recordDirty === "all" && update.recordCount === 0) {
      this.#destroyMeshes();
    } else if (!this.#hasDirectComputeMesh()) this.#syncMeshes(update);
    const pass = this.#platform.computeCullPass;
    const surface = this.#meshes.get(0);
    if (pass === undefined || surface === undefined || !this.#hasDirectComputeMesh()) {
      this.#flushPaletteStorage(false);
      return this.#fallbackComputeCull(update);
    }
    pass.trackGeometry(surface.mesh.geometry);
    const useGpuOrigin = !resident && update.aabbSpace === "local";
    const originPalette = useGpuOrigin
      ? this.preparePalettePath() === "storage"
        ? this.#platform.paletteStoragePass
        : undefined
      : undefined;
    if (useGpuOrigin && originPalette === undefined) {
      this.#flushPaletteStorage(false);
      return this.#fallbackComputeCull(update);
    }
    const residentPalette = resident
      ? this.preparePalettePath() === "storage"
        ? this.#platform.paletteStoragePass
        : undefined
      : undefined;
    if (resident && residentPalette === undefined) {
      this.#flushPaletteStorage(false);
      return this.#fallbackComputeCull(update);
    }
    const hasQueuedMoves = (this.#queuedMoves?.count ?? 0) > 0;
    if (
      update.recordDirty === "none" &&
      (!resident || update.localBoundsDirty === "none") &&
      update.recompute !== true &&
      pass.synced &&
      (!resident ||
        (residentPalette?.requiresFullSync === false && residentPalette.hasResidentLocalBounds)) &&
      (!useGpuOrigin || this.#storageSynced) &&
      !hasQueuedMoves &&
      cullViewportsEqual(this.#lastCullViewport, update.viewport)
    ) {
      const palette = this.#flushPaletteStorage(resident);
      if (!palette.ok) return this.#useCpuCull();
      this.#cullPath = "compute-cull";
      return this.#cullPath;
    }
    const store = this.#coordinator.instances;
    const drawInstanceCount = resident ? update.drawInstanceCount : store.stats.activeInstances;
    const drawBytes = planGlyphDrawBytes(drawInstanceCount);
    if (drawBytes === undefined || !pass.ensureCapacity(update.recordCount, drawBytes)) {
      this.#flushPaletteStorage(false);
      return this.#fallbackComputeCull(update);
    }
    pass.uploadRecords(update.records, update.recordCount, update.recordDirty);
    this.#cullRecordUploadBytes += pass.lastRecordUploadBytes;
    if (!pass.synced) {
      this.#flushPaletteStorage(false);
      return this.#fallbackComputeCull(update);
    }
    if (resident) {
      const palette = residentPalette;
      const records = pass.getResidentRecords();
      if (palette === undefined || !records.ok) {
        this.#flushPaletteStorage(false);
        return this.#fallbackComputeCull(update);
      }
      if (
        update.localBoundsDirty === "all" ||
        palette.requiresFullSync ||
        !palette.hasResidentLocalBounds
      ) {
        const localBounds = palette.ensureResidentLocalBounds(
          update.localBounds,
          update.localBoundsCount,
        );
        if (!localBounds.ok) {
          this.#flushPaletteStorage(false);
          return this.#fallbackComputeCull(update);
        }
      }
      if (!palette.bindResidentCullRecords(records).ok) {
        this.#flushPaletteStorage(false);
        return this.#fallbackComputeCull(update);
      }
    }
    const palette = this.#flushPaletteStorage(resident);
    if (!palette.ok) return this.#fallbackComputeCull(update);
    // ensureCapacity resets indirect args. Resident movers also require a fresh visibility pass.
    if (
      update.recordDirty === "none" &&
      update.recompute !== true &&
      pass.synced &&
      !pass.requiresFullSync &&
      (!resident || residentPalette?.requiresFullSync === false) &&
      !palette.moved &&
      cullViewportsEqual(this.#lastCullViewport, update.viewport)
    ) {
      this.#cullPath = "compute-cull";
      return this.#cullPath;
    }
    const transforms = useGpuOrigin ? originPalette?.gpuTransforms : undefined;
    const dispatched = useGpuOrigin
      ? transforms !== undefined &&
        pass.dispatch(update.viewport, { transforms, useGpuOrigin: true })
      : pass.dispatch(update.viewport);
    if (!dispatched) {
      this.#syncCompactDraw(update);
      return this.#useCpuCull();
    }
    if (resident && this.#platform.frameTransactionStats === undefined) {
      residentPalette?.acknowledgeFullSync();
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
    for (const upload of result.atlasCommit.uploads) this.#pendingAtlasUploads.push(upload);
    try {
      this.#applyAtlasUploads(this.#pendingAtlasUploads, this.#atlasFullSyncRequired);
      const consumedTransformRanges = this.#coordinator.transforms.consumeDirty();
      const consumedInstanceRanges = this.#coordinator.instances.consumeDirty();
      const transformRanges = this.#paletteFullSyncRequired
        ? fullDirtyRange(this.#coordinator.transforms.data.byteLength)
        : consumedTransformRanges;
      const instanceRanges = this.#prototypeFullSyncRequired
        ? fullDirtyRange(this.#coordinator.instances.stats.highWater * GLYPH_INSTANCE_STRIDE)
        : consumedInstanceRanges;
      if (this.#paletteFullSyncRequired) {
        this.#storageSynced = false;
        this.#storageNeedsOriginRefresh = true;
      }
      this.#syncPalette(transformRanges, result.drawOrderChanged || this.#drawRebuildRequired);
      this.#syncPrototype(instanceRanges);
      const needsComputeRebuild = this.#needsComputeMeshRebuild(computeCull);
      const needDrawRebuild =
        this.#drawRebuildRequired ||
        result.drawOrderChanged ||
        this.#meshes.size === 0 ||
        needsComputeRebuild ||
        this.#residentPrototypeRefreshRequired() ||
        this.#syncedDrawEpoch !== this.#coordinator.drawListEpoch ||
        this.#syncedSegmentEpoch !== this.#coordinator.instances.segmentEpoch;
      if (this.#coordinator.getDrawStates().length === 0) {
        this.#destroyMeshes();
      } else if (needDrawRebuild) {
        this.#syncMeshes(computeCull);
      }
      if (computeCull === undefined) {
        this.#flushPaletteStorage(false);
        this.#useCpuCull();
      } else this.#refreshComputeCull(computeCull);
      const paletteGrew = this.#paletteGrew;
      if (paletteGrew) {
        this.#refreshPrototypeTexture();
        this.#paletteGrew = false;
      }
      this.#bindMeshSources();
      this.#pendingAtlasUploads.length = 0;
      this.#atlasFullSyncRequired = false;
      this.#paletteFullSyncRequired = false;
      this.#prototypeFullSyncRequired = false;
      this.#drawRebuildRequired = false;
    } catch (error: unknown) {
      this.#requireFullApplySync();
      throw error;
    } finally {
      this.#lastUploadMs = performance.now() - uploadStart;
    }
  }

  get stats(): Readonly<RenderSurfaceStats> {
    const frameTransaction = this.#platform.frameTransactionStats;
    return Object.freeze({
      adapter: this.#platform.kind,
      cullPath: this.#cullPath,
      palettePath: this.#palettePath,
      meshes: this.#meshes.size,
      atlasTextures: this.#pages.size,
      submittedGlyphs: this.#submittedGlyphs,
      atlasUploadBytes: this.#atlasUploadBytes,
      instanceUploadBytes: this.#instanceUploadBytes,
      transformUploadBytes: this.#transformUploadBytes,
      cullRecordUploadBytes: this.#cullRecordUploadBytes,
      instanceWrites: this.#instanceWrites,
      transformWrites: this.#transformWrites,
      pageRebuilds: this.#pageRebuilds,
      lastUploadMs: this.#lastUploadMs,
      ...(frameTransaction === undefined
        ? {}
        : {
            frameTransactionSubmissions: frameTransaction.submissions,
            frameTransactionFusedSubmissions: frameTransaction.fusedSubmissions,
            frameTransactionStandaloneSubmissions: frameTransaction.standaloneSubmissions,
          }),
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    const resources = {
      meshes: Array.from(this.#meshes.values(), (surface) => surface.mesh),
      atlasTextures: [this.#rArray.texture, this.#rgbaArray.texture],
      paletteTexture: this.#paletteTexture,
      prototypeTexture: this.#protoTexture,
    };
    this.#destroyed = true;
    this.#meshes.clear();
    this.#pages.clear();
    this.#pendingAtlasUploads.length = 0;
    this.#cullPath = "cpu-grid";
    this.#palettePath = "texture";
    this.#queuedMoves = undefined;
    this.#storageSynced = false;
    this.#storageNeedsOriginRefresh = false;
    this.#activePaletteSlots = new Uint32Array(0);
    this.#lastCullViewport = undefined;
    this.#atlasFullSyncRequired = false;
    this.#paletteFullSyncRequired = false;
    this.#prototypeFullSyncRequired = false;
    this.#drawRebuildRequired = false;
    this.#prototypeContentEpoch = 0;
    this.#paletteData = new Float32Array();
    this.#protoPixels = new Float32Array();
    this.#submittedGlyphs = 0;
    this.#platform.destroy(resources);
  }

  #applyAtlasUploads(
    pendingUploads: readonly Readonly<AtlasUpload>[],
    fullSyncRequired: boolean,
  ): void {
    const dirtyPages = new Map<number, Readonly<AtlasUpload>[]>();
    const dirtyArrays = new Set<AtlasArray>();
    const fullUploaded = new Set<AtlasArray>();
    for (const upload of pendingUploads) {
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
    if (fullSyncRequired) {
      this.#uploadAllAtlasPages();
      return;
    }
    for (const array of dirtyArrays) {
      // A mid-commit layer grow leaves the replaced array in this set after
      // #adoptAtlasArray destroys it. getGlSource on that source reads a null
      // style and throws addressModeU. See `.agents/docs/gotchas.md`.
      if (array.source.destroyed || array.source.style === null) continue;
      if (this.#initializeAtlasArray(array)) {
        fullUploaded.add(array);
      }
    }
    for (const [pageId, uploads] of dirtyPages) {
      const page = this.#pages.get(pageId);
      if (page === undefined || fullUploaded.has(page.array)) continue;
      const rectBytes = uploads.reduce((sum, upload) => sum + upload.pixels.byteLength, 0);
      if (rectBytes * 2 > page.pixels.byteLength) {
        this.#platform.uploadAtlas(page, 0, 0, page.info.width, page.info.height, page.pixels);
        this.#atlasUploadBytes += page.pixels.byteLength;
        continue;
      }
      for (const upload of uploads) {
        this.#platform.uploadAtlas(
          page,
          upload.entry.x,
          upload.entry.y,
          upload.entry.width,
          upload.entry.height,
          upload.pixels,
        );
      }
      this.#atlasUploadBytes += rectBytes;
    }
  }

  #initializeAtlasArray(array: AtlasArray): boolean {
    if (array.initialized) return false;
    this.#platform.initializeAtlasArray(array);
    array.initialized = true;
    this.#uploadAtlasPages(array);
    return true;
  }

  #uploadAllAtlasPages(): void {
    const arrays = new Set<AtlasArray>();
    for (const page of this.#pages.values()) arrays.add(page.array);
    for (const array of arrays) {
      if (!this.#initializeAtlasArray(array)) this.#uploadAtlasPages(array);
    }
  }

  #uploadAtlasPages(array: AtlasArray): void {
    for (const page of this.#pages.values()) {
      if (page.array !== array) continue;
      this.#platform.uploadAtlas(page, 0, 0, page.info.width, page.info.height, page.pixels);
      this.#atlasUploadBytes += page.pixels.byteLength;
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
    const surfaces = Array.from(this.#meshes.values());
    const nextGeneration = this.#atlasGeneration + 1;
    const nextTextures: readonly [Texture, Texture] =
      kind === "r" ? [next.texture, this.#rgbaArray.texture] : [this.#rArray.texture, next.texture];
    let migrated: boolean;
    try {
      for (const surface of surfaces) {
        this.#bindSurfaceMesh(surface, true, { atlasTextures: nextTextures }, nextGeneration);
      }
      migrated = this.#platform.migrateAtlasArray(current, next);
    } catch (error: unknown) {
      cleanupBestEffort([
        ...surfaces.map(
          (surface) => () => this.#bindSurfaceMesh(surface, true, undefined, this.#atlasGeneration),
        ),
        () => destroyTextureAndSource(next.texture, next.source),
      ]);
      throw error;
    }
    if (kind === "r") this.#rArray = next;
    else this.#rgbaArray = next;
    for (const page of this.#pages.values()) {
      if (atlasArrayKind(page.info.mode) === kind) page.array = next;
    }
    this.#atlasGeneration = nextGeneration;
    this.#pageRebuilds += 1;
    if (!migrated) {
      cleanupBestEffort([() => destroyTextureAndSource(current.texture, current.source)]);
    }
    return next;
  }

  #syncPalette(ranges: readonly Readonly<DirtyByteRange>[], drawOrderChanged: boolean): void {
    const data = this.#coordinator.transforms.data;
    if (this.preparePalettePath() === "storage") {
      this.#syncPaletteStorage(data, ranges, drawOrderChanged);
      if (this.#palettePath === "storage") return;
    }
    this.#syncPaletteTexture(data, ranges, drawOrderChanged);
  }

  #syncPaletteTexture(
    data: Float32Array,
    ranges: readonly Readonly<DirtyByteRange>[],
    drawOrderChanged: boolean,
  ): void {
    const stats = this.#coordinator.transforms.stats;
    if (data !== this.#paletteData) {
      const oldData = this.#paletteData;
      const oldWidth = this.#paletteWidth;
      const oldSource = this.#paletteSource;
      const oldTexture = this.#paletteTexture;
      const nextWidth = this.#platform.planPaletteTextureWidth(data.length / 4, stats.textureWidth);
      const nextSource = createPaletteSource(this.#coordinator, nextWidth);
      const nextTexture = createTextureWithOwnedSource(nextSource);
      const surfaces = Array.from(this.#meshes.values());
      try {
        this.#platform.initializeTexture(nextSource);
        for (const surface of surfaces) {
          this.#bindSurfaceMesh(surface, false, {
            paletteTexture: nextTexture,
            paletteWidth: nextWidth,
          });
        }
      } catch (error: unknown) {
        cleanupBestEffort([
          ...surfaces.map(
            (surface) => () =>
              this.#bindSurfaceMesh(surface, false, {
                paletteTexture: oldTexture,
                paletteWidth: oldWidth,
              }),
          ),
          () => destroyTextureAndSource(nextTexture, nextSource),
        ]);
        this.#paletteData = oldData;
        throw error;
      }
      this.#paletteData = data;
      this.#paletteWidth = nextWidth;
      this.#paletteSource = nextSource;
      this.#paletteTexture = nextTexture;
      this.#paletteInitialized = true;
      this.#paletteGrew = true;
      this.#transformUploadBytes += data.byteLength;
      this.#transformWrites += 1;
      cleanupBestEffort([() => destroyTextureAndSource(oldTexture, oldSource)]);
      return;
    }
    if (ranges.length === 0) return;
    if (!this.#paletteInitialized) {
      this.#platform.initializeTexture(this.#paletteSource);
      this.#paletteInitialized = true;
      this.#bindMeshSources();
      this.#transformUploadBytes += data.byteLength;
      this.#transformWrites += 1;
      return;
    }
    let uploadRanges = ranges;
    if (drawOrderChanged) {
      const drawStates = this.#coordinator.getDrawStates();
      if (drawStates.length <= PALETTE_TRANSFORM_SCATTER_MAX_LABELS) {
        uploadRanges = this.#platform.planPaletteTextureRanges(
          ranges,
          drawStates.map((state) => state.slot),
          stats.effectBase,
        );
      }
    }
    if (uploadRanges.length === 0) return;
    const meshes = Array.from(this.#meshes.values(), (surface) => surface.mesh);
    this.#platform.preparePaletteTextureUpload(this.#paletteTexture, meshes);
    const uploaded = this.#platform.uploadFloatTextureRanges(
      this.#paletteSource,
      data,
      this.#paletteWidth,
      uploadRanges,
    );
    this.#transformUploadBytes += uploaded.bytes;
    this.#transformWrites += uploaded.writes;
    this.#platform.preparePaletteTextureUpload(this.#paletteTexture, meshes);
    this.#bindMeshSources();
  }

  #syncPaletteStorage(
    data: Float32Array,
    ranges: readonly Readonly<DirtyByteRange>[],
    drawOrderChanged: boolean,
  ): void {
    const grew = data !== this.#paletteData;
    if (grew) {
      this.#paletteData = data;
      this.#storageNeedsOriginRefresh ||= this.#storageSynced;
      this.#storageSynced = false;
    }
    if (!this.#storageSynced || ranges.length === 0) return;
    const pass = this.#platform.paletteStoragePass;
    if (pass === undefined) return;
    const drawStates = this.#coordinator.getDrawStates();
    const scattered = drawOrderChanged
      ? this.#tryScatterActivePaletteTransforms(pass, data, ranges, drawStates)
      : undefined;
    this.#transformUploadBytes += scattered ?? pass.uploadTransforms(data, ranges);
    this.#transformWrites += 1;
  }

  #tryScatterActivePaletteTransforms(
    pass: PaletteStoragePass,
    data: Float32Array,
    ranges: readonly Readonly<DirtyByteRange>[],
    drawStates: readonly Readonly<RenderDrawState>[],
  ): number | undefined {
    const plan = planPaletteTransformUpload(ranges, drawStates.length);
    if (plan.mode !== "scatter") return undefined;
    this.#ensureActivePaletteSlots(drawStates.length);
    for (let index = 0; index < drawStates.length; index += 1) {
      this.#activePaletteSlots[index] = drawStates[index]?.slot ?? 0;
    }
    const uploaded = pass.dispatchTransforms(
      data,
      this.#activePaletteSlots,
      drawStates.length,
      this.#coordinator.transforms.stats.effectBase,
      this.#originX,
      this.#originY,
    );
    return uploaded > 0 ? uploaded : undefined;
  }

  #ensureActivePaletteSlots(count: number): void {
    if (this.#activePaletteSlots.length >= count) return;
    this.#activePaletteSlots = new Uint32Array(nextPowerOfTwo(count));
  }

  #refreshStorageOriginsIfNeeded(): void {
    if (
      !this.#storageNeedsOriginRefresh ||
      this.#originX === undefined ||
      this.#originY === undefined
    ) {
      return;
    }
    this.#coordinator.transforms.refreshOrigins(this.#originX, this.#originY, this.#rotationBits);
  }

  #adoptPalettePath(previous: PalettePath): PalettePath {
    if (previous !== this.#palettePath && this.#meshes.size > 0) {
      this.#destroyMeshes();
    }
    return this.#palettePath;
  }

  #fallbackPaletteToTexture(): void {
    if (this.#originX !== undefined && this.#originY !== undefined) {
      this.#coordinator.transforms.refreshOrigins(this.#originX, this.#originY, this.#rotationBits);
    }
    this.#queuedMoves = undefined;
    this.#storageSynced = false;
    this.#storageNeedsOriginRefresh = false;
    this.#paletteInitialized = false;
    this.#palettePath = "texture";
    if (this.#meshes.size > 0) this.#destroyMeshes();
  }

  #bindMeshSources(): void {
    for (const surface of this.#meshes.values()) {
      this.#bindSurfaceMesh(surface, surface.atlasGeneration !== this.#atlasGeneration);
    }
  }

  #bindSurfaceMesh(
    surface: SurfaceMesh,
    bindAtlas: boolean,
    overrides: Readonly<
      Partial<
        Pick<
          BackendMeshBindings,
          | "atlasTextures"
          | "paletteTexture"
          | "paletteWidth"
          | "prototypeTexture"
          | "prototypeWidth"
        >
      >
    > = {},
    atlasGeneration: number = this.#atlasGeneration,
  ): void {
    const stats = this.#coordinator.transforms.stats;
    const paletteStorage = this.#readyPaletteStorage();
    this.#platform.bindMesh(surface.mesh, {
      atlasTextures: overrides.atlasTextures ?? this.#atlasTextures(),
      bindAtlas,
      paletteTexture: overrides.paletteTexture ?? this.#paletteTexture,
      paletteWidth: overrides.paletteWidth ?? this.#paletteWidth,
      effectBase: stats.effectBase,
      ...(paletteStorage === undefined ? {} : { paletteStorage }),
      prototypeTexture: overrides.prototypeTexture ?? this.#protoTexture,
      prototypeWidth: overrides.prototypeWidth ?? this.#protoWidth,
    });
    if (bindAtlas) surface.atlasGeneration = atlasGeneration;
  }

  #readyPaletteStorage(): Buffer | undefined {
    if (this.#palettePath !== "storage") return undefined;
    const pass = this.#platform.paletteStoragePass;
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
    this.#prototypeContentEpoch += 1;
    this.#protoSource.update();
    const uploaded = this.#platform.uploadFloatTextureRanges(
      this.#protoSource,
      this.#protoPixels,
      this.#protoWidth,
      [{ offset: 0, length: this.#protoPixels.byteLength }],
    );
    this.#platform.initializeTexture(this.#protoSource);
    this.#protoInitialized = true;
    this.#instanceUploadBytes += uploaded.bytes;
    this.#instanceWrites += uploaded.writes;
    const resident = this.#meshes.get(0);
    if (resident !== undefined) this.#refreshResidentPrototype(resident);
  }

  #adoptPrototypePixels(pixels: Float32Array, width: number): void {
    const oldPixels = this.#protoPixels;
    const oldWidth = this.#protoWidth;
    const oldSource = this.#protoSource;
    const oldTexture = this.#protoTexture;
    const nextSource = createPrototypeSource(pixels, width, pixels.length / (width * 4));
    const nextTexture = createTextureWithOwnedSource(nextSource);
    const surfaces = Array.from(this.#meshes.values());
    try {
      this.#platform.initializeTexture(nextSource);
      for (const surface of surfaces) {
        this.#bindSurfaceMesh(surface, false, {
          prototypeTexture: nextTexture,
          prototypeWidth: width,
        });
      }
    } catch (error: unknown) {
      cleanupBestEffort([
        ...surfaces.map(
          (surface) => () =>
            this.#bindSurfaceMesh(surface, false, {
              prototypeTexture: oldTexture,
              prototypeWidth: oldWidth,
            }),
        ),
        () => destroyTextureAndSource(nextTexture, nextSource),
      ]);
      this.#protoPixels = oldPixels;
      throw error;
    }
    this.#protoPixels = pixels;
    this.#protoWidth = width;
    this.#protoSource = nextSource;
    this.#protoTexture = nextTexture;
    this.#protoInitialized = true;
    this.#prototypeContentEpoch += 1;
    this.#instanceUploadBytes += pixels.byteLength;
    this.#instanceWrites += 1;
    cleanupBestEffort([() => destroyTextureAndSource(oldTexture, oldSource)]);
  }

  #syncPrototype(ranges: readonly Readonly<DirtyByteRange>[]): void {
    const store = this.#coordinator.instances;
    const highWater = store.stats.highWater;
    if (highWater === 0 && ranges.length === 0) return;
    const maxSize = this.#platform.maxTextureSize;
    const layout = prototypeTextureLayout(highWater, maxSize);
    const needed = layout.width * layout.height * 4;
    if (this.#protoPixels.length !== needed || this.#protoWidth !== layout.width) {
      const pixels = allocatePrototypePixels(layout.width, layout.height);
      writePrototypeGlyphs(pixels, store.buffer, 0, highWater);
      this.#adoptPrototypePixels(pixels, layout.width);
      return;
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
      if (ranges.length > 0) this.#prototypeContentEpoch += 1;
    }
    if (ranges.length === 0 && this.#protoInitialized) return;
    if (!this.#protoInitialized) {
      this.#platform.initializeTexture(this.#protoSource);
      this.#protoInitialized = true;
      this.#instanceUploadBytes += this.#protoPixels.byteLength;
      this.#instanceWrites += 1;
      return;
    }
    const protoRanges = ranges.map((range) => prototypeByteRange(range.offset, range.length));
    const uploaded = this.#platform.uploadFloatTextureRanges(
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
    const draw = this.#drawPlanner.build(view);
    this.#computeEligible = computeCullStructurallyEligible({
      segmentCount: draw.segments.length,
      highWater: storeStats.highWater,
      activeInstances: storeStats.activeInstances,
    });
    if (this.#computeEligible && computeCull !== undefined) {
      const segment = draw.segments[0];
      if (segment === undefined) throw new Error("Active glyph segment is unavailable");
      const prototypeSpan = segment.spans.length === 1 ? segment.spans[0] : undefined;
      const shaderVariant = glyphShaderVariantForCull(
        computeCull,
        this.#palettePath,
        prototypeSpan,
      );
      let residentPrototypeIndex: number | undefined;
      let residentPrototypeCount: number | undefined;
      if (shaderVariant === "resident-fill-single" || shaderVariant === "resident-fill-run") {
        if (prototypeSpan === undefined) {
          throw new Error("Resident uniform draw is missing its continuous prototype span");
        }
        residentPrototypeIndex = prototypeSpan.offset;
        residentPrototypeCount = prototypeSpan.count;
      }
      this.#syncComputeMesh(
        segment.blendMode,
        shaderVariant,
        residentPrototypeIndex,
        residentPrototypeCount,
      );
      this.#submittedGlyphs = storeStats.activeInstances;
      this.#markDrawSynced();
      return;
    }
    const compactDraw =
      computeCull === undefined
        ? draw
        : this.#drawPlanner.build(
            view,
            this.#drawPlanner.visibleCullRecords(
              computeCull.records,
              computeCull.viewport,
              computeCull.recordCount,
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

  #syncComputeMesh(
    blendMode: BLEND_MODES,
    shaderVariant: GlyphShaderVariant,
    residentPrototypeIndex: number | undefined,
    residentPrototypeCount: number | undefined,
  ): void {
    this.#useReadyPaletteForMeshes();
    for (const [key, surface] of this.#meshes) {
      if (key !== 0) this.#destroyMesh(key, surface);
    }
    let surface = this.#meshes.get(0);
    if (
      surface !== undefined &&
      (surface.shaderVariant !== shaderVariant ||
        surface.residentPrototypeIndex !== residentPrototypeIndex ||
        surface.residentPrototypeCount !== residentPrototypeCount)
    ) {
      this.#destroyMesh(0, surface);
      surface = undefined;
    }
    if (surface !== undefined) this.#refreshResidentPrototype(surface);
    const dummy =
      surface !== undefined && !surface.compact && surface.data.byteLength >= GLYPH_DRAW_STRIDE
        ? surface.data
        : new ArrayBuffer(GLYPH_DRAW_STRIDE);
    if (surface === undefined) {
      surface = this.#createMesh(
        0,
        blendMode,
        dummy,
        1,
        false,
        shaderVariant,
        residentPrototypeIndex,
        residentPrototypeCount,
      );
      // Indirect draw binds the compute pass compact buffer. Leave the dummy unread.
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
  }

  #syncCompactMeshes(segments: readonly DrawSegment[]): void {
    for (const [key, surface] of this.#meshes) {
      if (key >= segments.length) this.#destroyMesh(key, surface);
    }
    for (let key = 0; key < segments.length; key += 1) {
      const segment = segments[key];
      if (segment === undefined) throw new Error(`Draw segment ${String(key)} is unavailable`);
      let current = this.#meshes.get(key);
      if (current !== undefined && current.shaderVariant !== "general") {
        this.#destroyMesh(key, current);
        current = undefined;
      }
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
        surface = this.#createMesh(key, segment.blendMode, buffer, segment.count, true, "general");
      } else {
        this.#configureMesh(surface, segment.blendMode, key);
        this.#platform.computeCullPass?.untrackGeometry(surface.mesh.geometry);
        surface.data = buffer;
        surface.compact = true;
        surface.mesh.updateInstances(buffer, segment.count);
      }
      this.#platform.initializeMesh(surface.mesh);
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
    shaderVariant: GlyphShaderVariant,
    residentPrototypeIndex: number | undefined = undefined,
    residentPrototypeCount: number | undefined = undefined,
  ): SurfaceMesh {
    const textures = this.#atlasTextures();
    const paletteStats = this.#coordinator.transforms.stats;
    const paletteStorage = this.#readyPaletteStorage();
    const residentPrototype =
      residentPrototypeIndex === undefined || residentPrototypeCount === undefined
        ? undefined
        : this.#residentPrototype(residentPrototypeIndex, residentPrototypeCount);
    const mesh = this.#platform.createMesh({
      texture: textures[0],
      textures,
      paletteTexture: this.#paletteTexture,
      paletteWidth: this.#paletteWidth,
      palettePath: readyPalettePath(this.#palettePath, paletteStorage !== undefined),
      ...(paletteStorage === undefined ? {} : { paletteStorage }),
      prototypeTexture: this.#protoTexture,
      prototypeWidth: this.#protoWidth,
      effectBase: paletteStats.effectBase,
      instanceData: data,
      instanceCount: count,
      shaderVariant,
      ...(residentPrototype === undefined ? {} : { residentPrototype }),
      ...(residentPrototypeIndex === undefined
        ? {}
        : { residentPrototypeBase: residentPrototypeIndex }),
    });
    try {
      mesh.label = `pixi-glyphflow-segment-${String(key)}`;
      mesh.blendMode = blendMode;
      this.#owner.addChild(mesh);
    } catch (error: unknown) {
      cleanupBestEffort([() => this.#platform.destroyMesh(mesh)]);
      throw error;
    }
    const surface: SurfaceMesh = {
      atlasGeneration: this.#atlasGeneration,
      blendMode,
      mesh,
      data,
      compact,
      shaderVariant,
      residentPrototypeIndex,
      residentPrototypeCount,
      residentPrototypeContentEpoch:
        residentPrototypeIndex === undefined ? undefined : this.#prototypeContentEpoch,
      residentPrototypeFingerprint:
        residentPrototype === undefined
          ? undefined
          : residentPrototypeFingerprint(residentPrototype),
    };
    this.#meshes.set(key, surface);

    return surface;
  }

  #residentPrototype(index: number, count: number): Float32Array {
    const floatsPerPrototype = GLYPH_PROTO_TEXELS_PER_GLYPH * 4;
    const start = index * floatsPerPrototype;
    const end = start + count * floatsPerPrototype;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > RESIDENT_RUN_MAX_GLYPHS ||
      end > this.#protoPixels.length
    ) {
      throw new RangeError("Resident prototype span exceeds the prototype texture mirror");
    }
    return this.#protoPixels.slice(start, end);
  }

  #residentPrototypeRefreshRequired(): boolean {
    const surface = this.#meshes.get(0);
    return (
      surface !== undefined &&
      residentVariantUsesPrototypeUniform(surface.shaderVariant) &&
      surface.residentPrototypeContentEpoch !== this.#prototypeContentEpoch
    );
  }

  #refreshResidentPrototype(surface: SurfaceMesh): void {
    const index = surface.residentPrototypeIndex;
    const count = surface.residentPrototypeCount;
    if (
      !residentVariantUsesPrototypeUniform(surface.shaderVariant) ||
      index === undefined ||
      count === undefined ||
      surface.residentPrototypeContentEpoch === this.#prototypeContentEpoch
    ) {
      return;
    }
    const prototype = this.#residentPrototype(index, count);
    const fingerprint = residentPrototypeFingerprint(prototype);
    if (!residentPrototypeFingerprintsEqual(surface.residentPrototypeFingerprint, fingerprint)) {
      surface.mesh.setResidentPrototype(prototype);
      surface.residentPrototypeFingerprint = fingerprint;
    }
    surface.residentPrototypeContentEpoch = this.#prototypeContentEpoch;
  }

  #configureMesh(surface: SurfaceMesh, blendMode: BLEND_MODES, key: number): void {
    if (surface.atlasGeneration !== this.#atlasGeneration) {
      this.#bindSurfaceMesh(surface, true);
    }
    if (surface.blendMode !== blendMode) {
      surface.blendMode = blendMode;
      surface.mesh.blendMode = blendMode;
    }
    surface.mesh.label = `pixi-glyphflow-segment-${String(key)}`;
    this.#owner.addChild(surface.mesh);
  }

  #destroyMesh(key: number, surface: SurfaceMesh): void {
    this.#meshes.delete(key);
    this.#platform.destroyMesh(surface.mesh);
  }

  #destroyMeshes(): void {
    const surfaces = Array.from(this.#meshes);
    this.#submittedGlyphs = 0;
    this.#syncedDrawEpoch = -1;
    this.#syncedSegmentEpoch = -1;
    cleanupBestEffortOrThrow(
      surfaces.map(
        ([key, surface]) =>
          () =>
            this.#destroyMesh(key, surface),
      ),
    );
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
    const draw = isGpuResidentCullUpdate(update)
      ? this.#drawPlanner.buildResidentCullRecords(
          update.records,
          update.viewport,
          update.recordCount,
        )
      : this.#drawPlanner.build(
          view,
          this.#drawPlanner.visibleCullRecords(
            update.records,
            update.viewport,
            update.recordCount,
            update.aabbSpace,
            this.#originX,
            this.#originY,
          ),
        );
    this.#syncCompactMeshes(draw.segments);
    this.#submittedGlyphs = draw.count;
    this.#markDrawSynced();
  }

  #fallbackComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    if (this.#hasDirectComputeMesh()) this.#syncCompactDraw(update);
    return this.#useCpuCull();
  }

  #useCpuCull(): CullPath {
    for (const surface of this.#meshes.values()) {
      this.#platform.computeCullPass?.untrackGeometry(surface.mesh.geometry);
    }
    this.#platform.computeCullPass?.invalidateSync();
    this.#platform.paletteStoragePass?.bindResidentCullRecords(undefined);
    this.#cullPath = "cpu-grid";
    this.#lastCullViewport = undefined;
    return this.#cullPath;
  }

  #requireFullApplySync(): void {
    this.#atlasFullSyncRequired = true;
    this.#paletteFullSyncRequired = true;
    this.#prototypeFullSyncRequired = true;
    this.#drawRebuildRequired = true;
    this.#storageSynced = false;
    this.#storageNeedsOriginRefresh = true;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("RenderSurface has been destroyed");
  }
}

function destroyTextureAndSource(
  texture: Texture | undefined,
  source: BufferImageSource | undefined,
): void {
  cleanupBestEffortOrThrow([
    () => texture?.destroy(true),
    () => {
      if (source !== undefined && !source.destroyed) source.destroy();
    },
  ]);
}

function createTextureWithOwnedSource(source: BufferImageSource): Texture {
  try {
    return new Texture({ source });
  } catch (error: unknown) {
    cleanupBestEffort([() => source.destroy()]);
    throw error;
  }
}

function fullDirtyRange(byteLength: number): readonly Readonly<DirtyByteRange>[] {
  return byteLength === 0 ? [] : [{ offset: 0, length: byteLength }];
}

function residentPrototypeFingerprint(prototype: Float32Array): Uint32Array {
  return new Uint32Array(prototype.buffer, prototype.byteOffset, prototype.length).slice();
}

function residentPrototypeFingerprintsEqual(
  previous: Uint32Array | undefined,
  current: Uint32Array,
): boolean {
  if (previous?.length !== current.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  return true;
}

function residentVariantUsesPrototypeUniform(variant: GlyphShaderVariant): boolean {
  return variant === "resident-fill-single" || variant === "resident-fill-run";
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}

/** @internal Plan compact output bytes within JS integer and WebGPU indirect-count bounds. */
export function planGlyphDrawBytes(drawInstanceCount: number): number | undefined {
  if (
    !Number.isSafeInteger(drawInstanceCount) ||
    drawInstanceCount < 0 ||
    drawInstanceCount > 0xffff_ffff
  ) {
    return undefined;
  }
  const bytes = drawInstanceCount * GLYPH_DRAW_STRIDE;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function isGpuResidentCullUpdate(
  update: Readonly<RenderComputeCullUpdate>,
): update is Readonly<RenderComputeCullUpdate> & {
  readonly localBounds: Float32Array;
  readonly localBoundsCount: number;
  readonly localBoundsDirty: "all" | "none";
  readonly drawInstanceCount: number;
} {
  return (
    update.localBounds instanceof Float32Array &&
    Number.isSafeInteger(update.localBoundsCount) &&
    typeof update.drawInstanceCount === "number" &&
    (update.localBoundsDirty === "all" || update.localBoundsDirty === "none")
  );
}

/** @internal Select the resident program only while the resident update owns a storage palette. */
export function glyphShaderVariantForCull(
  update: Readonly<RenderComputeCullUpdate> | undefined,
  palettePath: PalettePath,
  residentPrototypeSpan:
    | Readonly<{ readonly offset: number; readonly count: number }>
    | undefined = undefined,
): GlyphShaderVariant {
  if (update === undefined || palettePath !== "storage" || !isGpuResidentCullUpdate(update)) {
    return "general";
  }
  const residentPrototypeGlyphs = residentPrototypeSpan?.count;
  if (
    Number.isSafeInteger(residentPrototypeGlyphs) &&
    residentPrototypeGlyphs !== undefined &&
    residentPrototypeGlyphs >= 2 &&
    residentPrototypeGlyphs <= RESIDENT_RUN_MAX_GLYPHS
  ) {
    return "resident-fill-run";
  }
  return residentPrototypeGlyphs === 1 ? "resident-fill-single" : "resident-fill";
}
