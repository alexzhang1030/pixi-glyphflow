import type { Container, Renderer } from "pixi.js";

import type { AtlasCommit, AtlasExternalUpload, GlyphCacheKey } from "../atlas/types";
import type { CullPath } from "../culling/computeCull";
import type { TextLayerResidencyFallbackReason } from "../types";
import { cleanupBestEffort, type CleanupFailure } from "./cleanup";
import type { PaletteMoveUpload, PalettePath } from "./paletteStorage";
import {
  DefaultPixiRendererBackend,
  type PixiRendererBackend,
  type RenderColorAtlasCopy,
  type RenderColorAtlasSource,
  type RenderComputeCullUpdate,
  type RenderSurfaceStats,
  type SubmittedGlyphsDiagnostic,
} from "./PixiRendererBackend";
import type { RenderCommitResult, RenderCoordinator } from "./RenderCoordinator";

export type {
  RenderColorAtlasCopy,
  RenderColorAtlasSource,
  RenderComputeCullUpdate,
  RenderSurfaceStats,
  SubmittedGlyphsDiagnostic,
} from "./PixiRendererBackend";

/** Public lifecycle wrapper around the renderer-specific deep module seam. */
export class RenderSurface {
  readonly #backend: PixiRendererBackend;
  readonly #external = new Map<GlyphCacheKey, Readonly<AtlasExternalUpload>>();
  readonly #externalCopyRefs = new Map<Readonly<AtlasExternalUpload>, number>();
  readonly #retiredExternal = new Set<Readonly<AtlasExternalUpload>>();
  #lastUploadMs = 0;
  #externalDirty = false;
  #externalEpoch = 0;
  #destroyed = false;
  readonly #destroyedError = new Error("RenderSurface has been destroyed");

  constructor(
    renderer: Renderer,
    owner: Container,
    coordinator: RenderCoordinator,
    options: {
      readonly computeCull?: boolean | "auto";
      /** @internal Test and alternate-host injection seam. */
      readonly backend?: PixiRendererBackend;
    } = {},
  ) {
    this.#backend =
      options.backend ?? new DefaultPixiRendererBackend(renderer, owner, coordinator, options);
  }

  prepareCullPath(): CullPath {
    return this.#backend.prepareCullPath();
  }

  prepareGpuScene(): TextLayerResidencyFallbackReason | undefined {
    const prepare = this.#backend.prepareGpuScene;
    return prepare === undefined ? "setup-failed" : prepare.call(this.#backend);
  }

  /** Check complete resident record/draw storage without allocating GPU capacity. @internal */
  gpuSceneCapacityFits(recordCount: number, drawInstanceCount: number): boolean {
    return this.#backend.gpuSceneCapacityFits?.(recordCount, drawInstanceCount) ?? true;
  }

  residentFrameRecoveryRequired(): boolean {
    return this.#backend.residentFrameRecoveryRequired?.() ?? false;
  }

  preparePalettePath(): PalettePath {
    return this.#backend.preparePalettePath();
  }

  queuePaletteMoves(move: PaletteMoveUpload): void {
    this.#backend.queuePaletteMoves(move);
  }

  bindOriginColumns(originX: Float32Array, originY: Float32Array): void {
    this.#backend.bindOriginColumns(originX, originY);
  }

  dropIdleMeshes(): void {
    this.#backend.dropIdleMeshes();
  }

  refreshComputeCull(update: Readonly<RenderComputeCullUpdate>): CullPath {
    return this.#backend.refreshComputeCull(update);
  }

  rebuildCpuCull(update: Readonly<RenderComputeCullUpdate>): void {
    this.#backend.rebuildCpuCull(update);
  }

  flushPaletteStorage(): void {
    this.#backend.flushPaletteStorage();
  }

  readSubmittedGlyphs(): Promise<number> {
    return this.#backend.readSubmittedGlyphs();
  }

  readSubmittedGlyphsDiagnostic(): Promise<Readonly<SubmittedGlyphsDiagnostic> | undefined> {
    return this.#backend.readSubmittedGlyphsDiagnostic?.() ?? Promise.resolve(undefined);
  }

  copyColorAtlasToArray(
    source: Readonly<RenderColorAtlasSource>,
    copies: readonly Readonly<RenderColorAtlasCopy>[],
  ): Promise<boolean> {
    const started = performance.now();
    return this.#backend.copyColorAtlasToArray(source, copies).finally(() => {
      this.#lastUploadMs = performance.now() - started;
    });
  }

  async apply(
    result: Readonly<RenderCommitResult>,
    computeCull: Readonly<RenderComputeCullUpdate> | undefined = undefined,
  ): Promise<void> {
    if (this.#destroyed) {
      try {
        releaseAtlasCommitExternalUploads(result.atlasCommit);
      } catch {
        // The lifecycle error owns primary precedence after every incoming owner is settled.
      }
      throw this.#destroyedError;
    }
    const started = performance.now();
    let firstFailure: CleanupFailure | undefined;
    const captureFailure = (error: unknown): void => {
      firstFailure ??= { error };
    };
    try {
      const commit = result.atlasCommit;
      try {
        this.#adoptExternalUploads(commit);
      } catch (error: unknown) {
        captureFailure(error);
      }
      let backendApplied = true;
      try {
        this.#backend.apply(result, computeCull);
      } catch (error: unknown) {
        backendApplied = false;
        captureFailure(error);
      }
      const replay =
        this.#externalDirty ||
        commit.entries.length > 0 ||
        commit.uploads.length > 0 ||
        commit.externalUploads.length > 0;
      if (replay && backendApplied) {
        const externalEpoch = this.#externalEpoch;
        const copyUploads = [...this.#external.values()];
        let copySucceeded = true;
        for (const upload of copyUploads) this.#retainExternalCopy(upload);
        try {
          const bySource = new Map<
            Readonly<AtlasExternalUpload["source"]>,
            RenderColorAtlasCopy[]
          >();
          for (const upload of copyUploads) {
            let copies = bySource.get(upload.source);
            if (copies === undefined) {
              copies = [];
              bySource.set(upload.source, copies);
            }
            copies.push({
              page: upload.entry.page,
              sourceX: upload.sourceX,
              sourceY: upload.sourceY,
              destinationX: upload.entry.x,
              destinationY: upload.entry.y,
              width: upload.entry.width,
              height: upload.entry.height,
            });
          }
          this.#externalDirty = this.#external.size > 0;
          for (const [source, copies] of bySource) {
            if (this.#externalEpoch !== externalEpoch) break;
            if (!(await this.#backend.copyColorAtlasToArray(source, copies))) {
              throw new Error("Renderer cannot import an external color glyph atlas");
            }
          }
        } catch (error: unknown) {
          copySucceeded = false;
          if (this.#externalEpoch === externalEpoch) {
            this.#externalDirty = this.#external.size > 0;
          }
          captureFailure(error);
        } finally {
          try {
            this.#releaseExternalCopies(copyUploads);
          } catch (error: unknown) {
            captureFailure(error);
          }
        }
        if (copySucceeded && this.#externalEpoch === externalEpoch) this.#externalDirty = false;
      }
    } finally {
      this.#lastUploadMs = performance.now() - started;
    }
    if (firstFailure !== undefined) throw firstFailure.error;
  }

  get stats(): Readonly<RenderSurfaceStats> {
    return Object.freeze({ ...this.#backend.stats, lastUploadMs: this.#lastUploadMs });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const retained = [...this.#external.values()];
    this.#external.clear();
    this.#externalDirty = false;
    this.#externalEpoch += 1;
    const failure = cleanupBestEffort([
      () => this.#retireExternalUploads(retained),
      () => this.#backend.destroy(),
    ]);
    if (failure !== undefined) throw failure.error;
  }

  #adoptExternalUploads(commit: Readonly<AtlasCommit>): void {
    const retired: Readonly<AtlasExternalUpload>[] = [];
    let changed = false;
    for (const key of commit.evictedKeys) {
      const upload = this.#detachExternal(key);
      if (upload !== undefined) {
        retired.push(upload);
        changed = true;
      }
    }
    const incoming = new Map<GlyphCacheKey, Readonly<AtlasExternalUpload>>();
    for (const upload of commit.externalUploads) incoming.set(upload.entry.key, upload);
    for (const entry of commit.entries) {
      const retained = this.#external.get(entry.key);
      if (retained === undefined) continue;
      const replacement = incoming.get(entry.key);
      if (replacement === undefined || retained.entry.generation !== entry.generation) {
        const upload = this.#detachExternal(entry.key);
        if (upload !== undefined) {
          retired.push(upload);
          changed = true;
        }
      }
    }
    for (const upload of commit.externalUploads) {
      const previous = this.#external.get(upload.entry.key);
      if (previous === upload) continue;
      if (previous !== undefined) {
        this.#external.delete(upload.entry.key);
        retired.push(previous);
      }
      this.#external.set(upload.entry.key, upload);
      changed = true;
    }
    if (changed) {
      this.#externalEpoch += 1;
      this.#externalDirty = this.#external.size > 0;
    }
    if (commit.externalUploads.length > 0) this.#externalDirty = true;
    this.#retireExternalUploads(retired);
  }

  #detachExternal(key: GlyphCacheKey): Readonly<AtlasExternalUpload> | undefined {
    const upload = this.#external.get(key);
    if (upload === undefined) return undefined;
    this.#external.delete(key);
    return upload;
  }

  #retainExternalCopy(upload: Readonly<AtlasExternalUpload>): void {
    this.#externalCopyRefs.set(upload, (this.#externalCopyRefs.get(upload) ?? 0) + 1);
  }

  #releaseExternalCopies(uploads: readonly Readonly<AtlasExternalUpload>[]): void {
    const releasable = new Set<Readonly<AtlasExternalUpload>>();
    for (const upload of uploads) {
      const refs = this.#externalCopyRefs.get(upload);
      if (refs === undefined) continue;
      if (refs > 1) {
        this.#externalCopyRefs.set(upload, refs - 1);
        continue;
      }
      this.#externalCopyRefs.delete(upload);
      if (this.#retiredExternal.delete(upload)) releasable.add(upload);
    }
    const failure = cleanupBestEffort(Array.from(releasable, (upload) => () => upload.release()));
    if (failure !== undefined) throw failure.error;
  }

  #retireExternalUploads(uploads: readonly Readonly<AtlasExternalUpload>[]): void {
    const releasable = new Set<Readonly<AtlasExternalUpload>>();
    for (const upload of uploads) {
      if (this.#externalCopyRefs.has(upload)) {
        this.#retiredExternal.add(upload);
      } else {
        this.#retiredExternal.delete(upload);
        releasable.add(upload);
      }
    }
    const failure = cleanupBestEffort(Array.from(releasable, (upload) => () => upload.release()));
    if (failure !== undefined) throw failure.error;
  }
}

/** Release a commit that lost its render lifetime before a surface could adopt it. */
export function releaseAtlasCommitExternalUploads(commit: Readonly<AtlasCommit>): void {
  const uploads = new Set(commit.externalUploads);
  const failure = cleanupBestEffort(Array.from(uploads, (upload) => () => upload.release()));
  if (failure !== undefined) throw failure.error;
}
