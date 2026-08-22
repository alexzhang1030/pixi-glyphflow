import {
  BufferImageSource,
  Texture,
  type BLEND_MODES,
  type Container,
  type Renderer,
  type WebGLRenderer,
  type WebGPURenderer,
} from "pixi.js";

import type { AtlasCommit, AtlasPageInfo, GlyphMode } from "../atlas/types";
import {
  aabbVisible,
  CULL_RECORD_STRIDE,
  computeCullStructurallyEligible,
  cullViewportsEqual,
  type CullPath,
  type CullRecordDirty,
  type CullViewport,
  resolveCullPath,
} from "../culling/computeCull";
import { ComputeCullPass } from "./ComputeCullPass";
import { GlyphMesh } from "./GlyphMesh";
import type { RenderCommitResult, RenderCoordinator } from "./RenderCoordinator";
import { GLYPH_INSTANCE_STRIDE, GLYPH_TEXTURE_BANK_SIZE, type DirtyByteRange } from "./types";

const ACTIVE_BIT = 0x8000_0000;
const PAGE_MASK = 0x0000_ffff;
const PALETTE_BYTES_PER_TEXEL = 16;
const EMPTY_DIRTY_RANGES: readonly Readonly<DirtyByteRange>[] = Object.freeze([]);

interface AtlasTexturePage {
  readonly info: Readonly<AtlasPageInfo>;
  readonly pixels: Uint8Array;
  readonly source: BufferImageSource;
  readonly texture: Texture;
}

interface SurfaceMesh {
  bank: number;
  textureCount: number;
  blendMode: BLEND_MODES;
  readonly mesh: GlyphMesh;
  data: ArrayBuffer;
  compact: boolean;
  initialized: boolean;
}

interface DrawSpan {
  readonly offset: number;
  count: number;
}

interface DrawSegment {
  readonly bank: number;
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
}

export interface RenderSurfaceStats {
  readonly adapter: "webgl" | "webgpu" | "unknown";
  readonly cullPath: CullPath;
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
  readonly #meshes = new Map<number, SurfaceMesh>();
  #paletteSource: BufferImageSource;
  #paletteTexture: Texture;
  #paletteData: Float32Array;
  #paletteInitialized = false;
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
  #computeEligible = true;
  readonly #computeCull: boolean | "auto";
  #lastCullViewport: CullViewport | undefined;
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

  dropIdleMeshes(): void {
    this.#assertActive();
    if (this.#coordinator.getDrawStates().length !== 0) return;
    this.#destroyMeshes();
  }

  refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    this.#assertActive();
    const uploadStart = performance.now();
    const path = this.#refreshComputeCull(update, EMPTY_DIRTY_RANGES);
    this.#lastUploadMs = performance.now() - uploadStart;
    return path;
  }

  #refreshComputeCull(
    update: Readonly<RenderComputeCullUpdate>,
    instanceRanges: readonly Readonly<DirtyByteRange>[],
  ): CullPath {
    if (this.prepareCullPath() !== "compute-cull") {
      return this.#useCpuCull();
    }
    if (update.recordDirty === "all" && update.recordCount === 0) {
      this.#destroyMeshes();
    } else if (!this.#hasDirectComputeMesh()) this.#syncMeshes([], update);
    const pass = this.#cullPass;
    const surface = this.#meshes.get(0);
    if (pass === undefined || surface === undefined || !this.#hasDirectComputeMesh()) {
      return this.#useCpuCull();
    }
    pass.trackGeometry(surface.mesh.geometry);
    // ensureCapacity resets the indirect args, so an idle frame must return before it.
    if (
      update.recordDirty === "none" &&
      instanceRanges.length === 0 &&
      pass.synced &&
      cullViewportsEqual(this.#lastCullViewport, update.viewport)
    ) {
      this.#cullPath = "compute-cull";
      return this.#cullPath;
    }
    const store = this.#coordinator.instances;
    const instanceBytes = store.stats.highWater * GLYPH_INSTANCE_STRIDE;
    if (!pass.ensureCapacity(update.recordCount, instanceBytes)) {
      return this.#useCpuCull();
    }
    pass.uploadRecords(update.records, update.recordCount, update.recordDirty);
    pass.uploadInstances(store.buffer, instanceBytes, instanceRanges);
    if (!pass.dispatch(update.viewport)) {
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
    const needsComputeRebuild = this.#needsComputeMeshRebuild(computeCull);
    const skipSegmentWalk =
      computeCull !== undefined &&
      this.#hasDirectComputeMesh() &&
      instanceRanges.length === 0 &&
      !needsComputeRebuild;
    if (this.#coordinator.getDrawStates().length === 0) {
      this.#destroyMeshes();
    } else if (
      !skipSegmentWalk &&
      (instanceRanges.length > 0 ||
        result.drawOrderChanged ||
        this.#meshes.size === 0 ||
        needsComputeRebuild)
    ) {
      this.#syncMeshes(instanceRanges, computeCull);
    }
    if (computeCull === undefined) this.#useCpuCull();
    else this.#refreshComputeCull(computeCull, instanceRanges);
    this.#lastUploadMs = performance.now() - uploadStart;
  }

  get stats(): Readonly<RenderSurfaceStats> {
    return Object.freeze({
      adapter: rendererKind(this.#renderer),
      cullPath: this.#cullPath,
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
    for (const page of this.#pages.values()) page.texture.destroy(true);
    this.#pages.clear();
    this.#cullPass?.destroy();
    this.#cullPass = undefined;
    this.#cullPath = "cpu-grid";
    this.#lastCullViewport = undefined;
    this.#paletteTexture.destroy(true);
    this.#paletteData = new Float32Array();
    this.#submittedGlyphs = 0;
    this.#destroyed = true;
  }

  #applyAtlasCommit(commit: Readonly<AtlasCommit>): void {
    const dirtyPages = new Set<number>();
    for (const upload of commit.uploads) {
      const page = this.#ensureAtlasPage(upload.entry.page);
      copyAtlasUpload(
        page,
        upload.entry.x,
        upload.entry.y,
        upload.entry.width,
        upload.entry.height,
        upload.pixels,
      );
      this.#atlasUploadBytes += upload.pixels.byteLength;
      dirtyPages.add(upload.entry.page);
    }
    for (const page of dirtyPages) this.#pages.get(page)?.source.update();
  }

  #ensureAtlasPage(pageId: number): AtlasTexturePage {
    const existing = this.#pages.get(pageId);
    if (existing !== undefined) return existing;
    const info = this.#coordinator.atlas.getPage(pageId);
    if (info === undefined) throw new Error(`Atlas page ${String(pageId)} is unavailable`);
    const pixels = new Uint8Array(info.bytes);
    const source = new BufferImageSource({
      resource: pixels,
      width: info.width,
      height: info.height,
      format: textureFormat(info.mode),
      scaleMode: "linear",
      autoGenerateMipmaps: false,
      alphaMode: "premultiply-alpha-on-upload",
      label: `pixi-glyphflow-atlas-${String(pageId)}`,
    });
    const page: AtlasTexturePage = {
      info,
      pixels,
      source,
      texture: new Texture({ source }),
    };
    this.#pages.set(pageId, page);

    return page;
  }

  #syncPalette(ranges: readonly Readonly<DirtyByteRange>[]): void {
    const data = this.#coordinator.transforms.data;
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
    }
    if (ranges.length === 0) return;
    if (!this.#paletteInitialized) {
      initializeTexture(this.#renderer, this.#paletteSource);
      this.#paletteInitialized = true;
      this.#transformUploadBytes += data.byteLength;
      this.#transformWrites += 1;
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

  #syncMeshes(
    ranges: readonly Readonly<DirtyByteRange>[],
    computeCull: Readonly<RenderComputeCullUpdate> | undefined,
  ): void {
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
    if (this.#computeEligible && (draw.naturalOrder || computeCull !== undefined)) {
      const segment = draw.segments[0];
      if (segment === undefined) throw new Error("Active glyph segment is unavailable");
      this.#syncDirectMesh(segment.bank, segment.blendMode, data, storeStats.highWater, ranges);
      this.#submittedGlyphs = storeStats.activeInstances;
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
            ),
          );
    this.#syncCompactMeshes(data, compactDraw.segments);
    this.#submittedGlyphs = compactDraw.count;
  }

  #buildDrawSegments(
    view: DataView,
    included: Uint8Array | undefined = undefined,
  ): Readonly<{
    segments: DrawSegment[];
    naturalOrder: boolean;
    count: number;
  }> {
    const segments: DrawSegment[] = [];
    let lastSourceIndex = -1;
    let naturalOrder = true;
    let count = 0;
    const states = this.#coordinator.getDrawStates();
    for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
      if (included !== undefined && included[stateIndex] !== 1) continue;
      const state = states[stateIndex];
      if (state === undefined) throw new Error("Draw state list is incomplete");
      const range = this.#coordinator.instances.getRange(state.slot);
      if (range === undefined) continue;
      count += range.count;
      for (let index = 0; index < range.count; index += 1) {
        const sourceIndex = range.offset + index;
        const metadata = view.getUint32(sourceIndex * GLYPH_INSTANCE_STRIDE + 20, true);
        if ((metadata & ACTIVE_BIT) === 0) {
          throw new Error(`Inactive glyph found in label range ${String(state.slot)}`);
        }
        if (sourceIndex <= lastSourceIndex) naturalOrder = false;
        lastSourceIndex = sourceIndex;
        const page = metadata & PAGE_MASK;
        const bank = Math.floor(page / GLYPH_TEXTURE_BANK_SIZE);
        let segment = segments[segments.length - 1];
        if (
          segment === undefined ||
          segment.bank !== bank ||
          segment.zIndex !== state.zIndex ||
          segment.blendMode !== state.blendMode
        ) {
          segment = {
            bank,
            zIndex: state.zIndex,
            blendMode: state.blendMode,
            spans: [],
            count: 0,
          };
          segments.push(segment);
        }
        const span = segment.spans[segment.spans.length - 1];
        if (span !== undefined && span.offset + span.count === sourceIndex) {
          span.count += 1;
        } else {
          segment.spans.push({ offset: sourceIndex, count: 1 });
        }
        segment.count += 1;
      }
    }
    if (segments.reduce((sum, segment) => sum + segment.count, 0) !== count) {
      throw new Error("Draw segment glyph count differs from active instance count");
    }
    return { segments, naturalOrder, count };
  }

  #visibleCullRecords(
    records: ArrayBuffer,
    viewport: CullViewport,
    recordCount: number,
  ): Uint8Array {
    const states = this.#coordinator.getDrawStates();
    if (recordCount !== states.length) {
      throw new Error("Cull record count differs from draw state count");
    }
    const floats = new Float32Array(records);
    const included = new Uint8Array(recordCount);
    const floatsPerRecord = CULL_RECORD_STRIDE / Float32Array.BYTES_PER_ELEMENT;
    for (let index = 0; index < recordCount; index += 1) {
      const offset = index * floatsPerRecord;
      included[index] = Number(
        aabbVisible(
          floats[offset] ?? 0,
          floats[offset + 1] ?? 0,
          floats[offset + 2] ?? 0,
          floats[offset + 3] ?? 0,
          viewport,
        ),
      );
    }
    return included;
  }

  #syncDirectMesh(
    bank: number,
    blendMode: BLEND_MODES,
    data: ArrayBuffer,
    instanceCount: number,
    ranges: readonly Readonly<DirtyByteRange>[],
  ): void {
    for (const [key, surface] of this.#meshes) {
      if (key !== 0) this.#destroyMesh(key, surface);
    }
    let surface = this.#meshes.get(0);
    if (surface === undefined) {
      surface = this.#createMesh(0, bank, blendMode, data, instanceCount, false);
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += data.byteLength;
      this.#instanceWrites += 1;
      return;
    }
    this.#configureMesh(surface, bank, blendMode, 0);
    surface.compact = false;
    if (surface.data !== data) {
      surface.data = data;
      surface.mesh.updateInstances(data, instanceCount);
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += data.byteLength;
      this.#instanceWrites += 1;
      return;
    }
    surface.mesh.setInstanceCount(instanceCount);
    if (!surface.initialized) {
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += data.byteLength;
      this.#instanceWrites += 1;
      return;
    }
    const uploaded = uploadBufferRanges(this.#renderer, surface.mesh, data, ranges);
    this.#instanceUploadBytes += uploaded.bytes;
    this.#instanceWrites += uploaded.writes;
  }

  #syncCompactMeshes(source: ArrayBuffer, segments: readonly DrawSegment[]): void {
    for (const [key, surface] of this.#meshes) {
      if (key >= segments.length) this.#destroyMesh(key, surface);
    }
    const bytes = new Uint8Array(source);
    for (let key = 0; key < segments.length; key += 1) {
      const segment = segments[key];
      if (segment === undefined) throw new Error(`Draw segment ${String(key)} is unavailable`);
      const current = this.#meshes.get(key);
      const capacity = nextPowerOfTwo(segment.count);
      const buffer =
        current !== undefined &&
        current.compact &&
        current.data.byteLength >= capacity * GLYPH_INSTANCE_STRIDE
          ? current.data
          : new ArrayBuffer(capacity * GLYPH_INSTANCE_STRIDE);
      const target = new Uint8Array(buffer);
      let targetOffset = 0;
      for (const span of segment.spans) {
        const sourceOffset = span.offset * GLYPH_INSTANCE_STRIDE;
        const byteLength = span.count * GLYPH_INSTANCE_STRIDE;
        target.set(bytes.subarray(sourceOffset, sourceOffset + byteLength), targetOffset);
        targetOffset += byteLength;
      }
      let surface = current;
      if (surface === undefined) {
        surface = this.#createMesh(
          key,
          segment.bank,
          segment.blendMode,
          buffer,
          segment.count,
          true,
        );
      } else {
        this.#configureMesh(surface, segment.bank, segment.blendMode, key);
        this.#cullPass?.untrackGeometry(surface.mesh.geometry);
        surface.data = buffer;
        surface.compact = true;
        surface.mesh.updateInstances(buffer, segment.count);
      }
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += segment.count * GLYPH_INSTANCE_STRIDE;
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
    bank: number,
    blendMode: BLEND_MODES,
    data: ArrayBuffer,
    count: number,
    compact: boolean,
  ): SurfaceMesh {
    const textures = this.#getTextureBank(bank);
    const primaryTexture = textures[0];
    if (primaryTexture === undefined) {
      throw new Error(`Atlas texture bank ${String(bank)} is unavailable`);
    }
    const paletteStats = this.#coordinator.transforms.stats;
    const mesh = new GlyphMesh({
      texture: primaryTexture,
      textures,
      paletteTexture: this.#paletteTexture,
      paletteWidth: paletteStats.textureWidth,
      effectBase: paletteStats.effectBase,
      instanceData: data,
      instanceCount: count,
    });
    mesh.label = `pixi-glyphflow-segment-${String(key)}-bank-${String(bank)}`;
    mesh.blendMode = blendMode;
    this.#owner.addChild(mesh);
    const surface: SurfaceMesh = {
      bank,
      textureCount: textures.length,
      blendMode,
      mesh,
      data,
      compact,
      initialized: false,
    };
    this.#meshes.set(key, surface);

    return surface;
  }

  #configureMesh(surface: SurfaceMesh, bank: number, blendMode: BLEND_MODES, key: number): void {
    const textures = this.#getTextureBank(bank);
    if (surface.bank !== bank || surface.textureCount !== textures.length) {
      surface.bank = bank;
      surface.textureCount = textures.length;
      surface.mesh.setTextures(textures);
    }
    if (surface.blendMode !== blendMode) {
      surface.blendMode = blendMode;
      surface.mesh.blendMode = blendMode;
    }
    surface.mesh.label = `pixi-glyphflow-segment-${String(key)}-bank-${String(bank)}`;
    this.#owner.addChild(surface.mesh);
  }

  #getTextureBank(bank: number): readonly Texture[] {
    const textures: Texture[] = [];
    const firstPage = bank * GLYPH_TEXTURE_BANK_SIZE;
    for (let slot = 0; slot < GLYPH_TEXTURE_BANK_SIZE; slot += 1) {
      const page = this.#pages.get(firstPage + slot);
      if (page === undefined) break;
      textures.push(page.texture);
    }
    return textures;
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
  }

  #hasDirectComputeMesh(): boolean {
    const direct = this.#meshes.get(0);
    return this.#meshes.size === 1 && direct !== undefined && !direct.compact;
  }

  #needsComputeMeshRebuild(computeCull: Readonly<RenderComputeCullUpdate> | undefined): boolean {
    return computeCull !== undefined && this.#computeEligible && !this.#hasDirectComputeMesh();
  }

  #syncCompactDraw(update: Readonly<RenderComputeCullUpdate>): void {
    const store = this.#coordinator.instances;
    if (store.stats.activeInstances === 0) {
      this.#destroyMeshes();
      return;
    }
    const view = new DataView(store.buffer);
    const draw = this.#buildDrawSegments(
      view,
      this.#visibleCullRecords(update.records, update.viewport, update.recordCount),
    );
    this.#syncCompactMeshes(store.buffer, draw.segments);
    this.#submittedGlyphs = draw.count;
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

function uploadBufferRanges(
  renderer: Renderer,
  mesh: GlyphMesh,
  data: ArrayBuffer,
  ranges: readonly Readonly<DirtyByteRange>[],
): Readonly<{ bytes: number; writes: number }> {
  let bytes = 0;
  let writes = 0;
  if (isWebGLRenderer(renderer)) {
    const gl = renderer.gl;
    const resource = renderer.buffer.getGlBuffer(mesh.instanceBuffer);
    gl.bindBuffer(resource.type, resource.buffer);
    for (const range of ranges) {
      gl.bufferSubData(
        resource.type,
        range.offset,
        new Uint8Array(data, range.offset, range.length),
      );
      bytes += range.length;
      writes += 1;
    }
  } else if (isWebGPURenderer(renderer)) {
    const resource = renderer.buffer.getGPUBuffer(mesh.instanceBuffer);
    for (const range of ranges) {
      renderer.gpu.device.queue.writeBuffer(
        resource,
        range.offset,
        data,
        range.offset,
        range.length,
      );
      bytes += range.length;
      writes += 1;
    }
  } else if (ranges.length > 0) {
    mesh.instanceBuffer.update();
    bytes = data.byteLength;
    writes = 1;
  }

  return { bytes, writes };
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
    const previousPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    gl.bindTexture(resource.target, resource.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      for (const range of ranges) {
        let texel = range.offset / PALETTE_BYTES_PER_TEXEL;
        let remaining = range.length / PALETTE_BYTES_PER_TEXEL;
        while (remaining > 0) {
          const x = texel % textureWidth;
          const y = Math.floor(texel / textureWidth);
          const width = Math.min(remaining, textureWidth - x);
          gl.texSubImage2D(
            resource.target,
            0,
            x,
            y,
            width,
            1,
            resource.format,
            resource.type,
            data.subarray(texel * 4, (texel + width) * 4),
          );
          texel += width;
          remaining -= width;
          bytes += width * PALETTE_BYTES_PER_TEXEL;
          writes += 1;
        }
      }
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
    }
  } else if (isWebGPURenderer(renderer)) {
    const texture = renderer.texture.getGpuSource(source);
    for (const range of ranges) {
      let texel = range.offset / PALETTE_BYTES_PER_TEXEL;
      let remaining = range.length / PALETTE_BYTES_PER_TEXEL;
      while (remaining > 0) {
        const x = texel % textureWidth;
        const y = Math.floor(texel / textureWidth);
        const width = Math.min(remaining, textureWidth - x);
        renderer.gpu.device.queue.writeTexture(
          { texture, origin: { x, y, z: 0 } },
          data.subarray(texel * 4, (texel + width) * 4),
          { bytesPerRow: width * PALETTE_BYTES_PER_TEXEL, rowsPerImage: 1 },
          { width, height: 1, depthOrArrayLayers: 1 },
        );
        texel += width;
        remaining -= width;
        bytes += width * PALETTE_BYTES_PER_TEXEL;
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

function textureFormat(mode: GlyphMode): "r8unorm" | "rgba8unorm" {
  return mode === "alpha" || mode === "sdf" ? "r8unorm" : "rgba8unorm";
}

function glyphBytesPerPixel(mode: GlyphMode): number {
  return mode === "alpha" || mode === "sdf" ? 1 : 4;
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
