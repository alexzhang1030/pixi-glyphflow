import {
  BufferImageSource,
  Texture,
  type Container,
  type Renderer,
  type WebGLRenderer,
  type WebGPURenderer,
} from "pixi.js";

import type { AtlasCommit, AtlasPageInfo, GlyphMode } from "../atlas/types";
import { GlyphMesh } from "./GlyphMesh";
import type { RenderCommitResult, RenderCoordinator } from "./RenderCoordinator";
import { GLYPH_INSTANCE_STRIDE, type DirtyByteRange } from "./types";

const ACTIVE_BIT = 0x8000_0000;
const PAGE_MASK = 0x0000_ffff;
const PALETTE_BYTES_PER_TEXEL = 16;

interface AtlasTexturePage {
  readonly info: Readonly<AtlasPageInfo>;
  readonly pixels: Uint8Array;
  readonly source: BufferImageSource;
  readonly texture: Texture;
}

interface SurfaceMesh {
  readonly page: number;
  readonly mesh: GlyphMesh;
  data: ArrayBuffer;
  compact: boolean;
  initialized: boolean;
}

export interface RenderSurfaceStats {
  readonly adapter: "webgl" | "webgpu" | "unknown";
  readonly meshes: number;
  readonly atlasTextures: number;
  readonly submittedGlyphs: number;
  readonly atlasUploadBytes: number;
  readonly instanceUploadBytes: number;
  readonly transformUploadBytes: number;
  readonly instanceWrites: number;
  readonly transformWrites: number;
  readonly pageRebuilds: number;
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
  #destroyed = false;

  constructor(renderer: Renderer, owner: Container, coordinator: RenderCoordinator) {
    this.#renderer = renderer;
    this.#owner = owner;
    this.#coordinator = coordinator;
    this.#paletteData = coordinator.transforms.data;
    this.#paletteSource = createPaletteSource(coordinator);
    this.#paletteTexture = new Texture({ source: this.#paletteSource });
  }

  apply(result: Readonly<RenderCommitResult>): void {
    this.#assertActive();
    this.#applyAtlasCommit(result.atlasCommit);
    const transformRanges = this.#coordinator.transforms.consumeDirty();
    const instanceRanges = this.#coordinator.instances.consumeDirty();
    this.#syncPalette(transformRanges);
    if (instanceRanges.length > 0 || this.#meshes.size === 0) {
      this.#syncMeshes(instanceRanges);
    }
  }

  get stats(): Readonly<RenderSurfaceStats> {
    return Object.freeze({
      adapter: rendererKind(this.#renderer),
      meshes: this.#meshes.size,
      atlasTextures: this.#pages.size,
      submittedGlyphs: this.#submittedGlyphs,
      atlasUploadBytes: this.#atlasUploadBytes,
      instanceUploadBytes: this.#instanceUploadBytes,
      transformUploadBytes: this.#transformUploadBytes,
      instanceWrites: this.#instanceWrites,
      transformWrites: this.#transformWrites,
      pageRebuilds: this.#pageRebuilds,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    for (const surface of this.#meshes.values()) {
      surface.mesh.removeFromParent();
      surface.mesh.destroy();
    }
    this.#meshes.clear();
    for (const page of this.#pages.values()) page.texture.destroy(true);
    this.#pages.clear();
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
        surface.mesh.setPaletteTexture(this.#paletteTexture, stats.textureWidth);
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

  #syncMeshes(ranges: readonly Readonly<DirtyByteRange>[]): void {
    const store = this.#coordinator.instances;
    const storeStats = store.stats;
    if (storeStats.activeInstances === 0) {
      this.#destroyMeshes();
      this.#submittedGlyphs = 0;
      return;
    }
    const data = store.buffer;
    const view = new DataView(data);
    const counts = new Map<number, number>();
    for (let index = 0; index < storeStats.highWater; index += 1) {
      const metadata = view.getUint32(index * GLYPH_INSTANCE_STRIDE + 28, true);
      if ((metadata & ACTIVE_BIT) === 0) continue;
      const page = metadata & PAGE_MASK;
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    if (counts.size === 1 && storeStats.highWater <= storeStats.activeInstances * 2) {
      const page = counts.keys().next().value as number | undefined;
      if (page === undefined) throw new Error("Active glyph page is unavailable");
      this.#syncDirectMesh(page, data, storeStats.highWater, ranges);
      this.#submittedGlyphs = storeStats.activeInstances;
      return;
    }

    this.#syncCompactMeshes(data, view, storeStats.highWater, counts);
    this.#submittedGlyphs = storeStats.activeInstances;
  }

  #syncDirectMesh(
    page: number,
    data: ArrayBuffer,
    instanceCount: number,
    ranges: readonly Readonly<DirtyByteRange>[],
  ): void {
    for (const [pageId, surface] of this.#meshes) {
      if (pageId !== page) this.#destroyMesh(pageId, surface);
    }
    let surface = this.#meshes.get(page);
    if (surface === undefined) {
      surface = this.#createMesh(page, data, instanceCount, false);
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += data.byteLength;
      this.#instanceWrites += 1;
      return;
    }
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

  #syncCompactMeshes(
    source: ArrayBuffer,
    view: DataView,
    highWater: number,
    counts: ReadonlyMap<number, number>,
  ): void {
    for (const [page, surface] of this.#meshes) {
      if (!counts.has(page)) this.#destroyMesh(page, surface);
    }
    const buffers = new Map<number, ArrayBuffer>();
    const targets = new Map<number, Uint8Array>();
    const offsets = new Map<number, number>();
    for (const [page, count] of counts) {
      const current = this.#meshes.get(page);
      const capacity = nextPowerOfTwo(count);
      const buffer =
        current !== undefined &&
        current.compact &&
        current.data.byteLength >= capacity * GLYPH_INSTANCE_STRIDE
          ? current.data
          : new ArrayBuffer(capacity * GLYPH_INSTANCE_STRIDE);
      buffers.set(page, buffer);
      targets.set(page, new Uint8Array(buffer));
      offsets.set(page, 0);
    }
    const bytes = new Uint8Array(source);
    for (let index = 0; index < highWater; index += 1) {
      const metadata = view.getUint32(index * GLYPH_INSTANCE_STRIDE + 28, true);
      if ((metadata & ACTIVE_BIT) === 0) continue;
      const page = metadata & PAGE_MASK;
      const target = targets.get(page);
      const offset = offsets.get(page) ?? 0;
      if (target === undefined)
        throw new Error(`Compact glyph page ${String(page)} is unavailable`);
      const sourceOffset = index * GLYPH_INSTANCE_STRIDE;
      target.set(bytes.subarray(sourceOffset, sourceOffset + GLYPH_INSTANCE_STRIDE), offset);
      offsets.set(page, offset + GLYPH_INSTANCE_STRIDE);
    }
    for (const [page, count] of counts) {
      const buffer = buffers.get(page);
      if (buffer === undefined) throw new Error(`Compact buffer ${String(page)} is unavailable`);
      let surface = this.#meshes.get(page);
      if (surface === undefined) {
        surface = this.#createMesh(page, buffer, count, true);
      } else {
        surface.data = buffer;
        surface.compact = true;
        surface.mesh.updateInstances(buffer, count);
      }
      initializeBuffer(this.#renderer, surface.mesh);
      surface.initialized = true;
      this.#instanceUploadBytes += count * GLYPH_INSTANCE_STRIDE;
      this.#instanceWrites += 1;
    }
    this.#pageRebuilds += 1;
  }

  #createMesh(page: number, data: ArrayBuffer, count: number, compact: boolean): SurfaceMesh {
    const atlasPage = this.#ensureAtlasPage(page);
    const paletteWidth = this.#coordinator.transforms.stats.textureWidth;
    const mesh = new GlyphMesh({
      texture: atlasPage.texture,
      paletteTexture: this.#paletteTexture,
      paletteWidth,
      instanceData: data,
      instanceCount: count,
    });
    mesh.label = `pixi-glyphflow-page-${String(page)}`;
    this.#owner.addChild(mesh);
    const surface: SurfaceMesh = { page, mesh, data, compact, initialized: false };
    this.#meshes.set(page, surface);

    return surface;
  }

  #destroyMesh(page: number, surface: SurfaceMesh): void {
    surface.mesh.removeFromParent();
    surface.mesh.destroy();
    this.#meshes.delete(page);
  }

  #destroyMeshes(): void {
    for (const [page, surface] of this.#meshes) this.#destroyMesh(page, surface);
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
    gl.bindTexture(resource.target, resource.texture);
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
