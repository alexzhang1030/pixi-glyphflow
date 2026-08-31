import type { BLEND_MODES, TextStyleOptions } from "pixi.js";

import {
  commitGlyphAtlasRenderFrame,
  discardGlyphAtlasRenderFrame,
  GlyphAtlas,
  requestGlyphAtlasRenderToken,
  stageGlyphAtlasRenderToken,
} from "../atlas/GlyphAtlas";
import { resolveGlyphIdentity } from "../atlas/glyphIdentity";
import { RasterProviderDisposedError, sameRenderScope } from "../atlas/types";
import type {
  AtlasGlyphRaster,
  GlyphAtlasOptions,
  GlyphCacheKey,
  GlyphMode,
  GlyphRaster,
  RasterGlyphProviderOptions,
  RasterGlyphRequest,
  RenderToken,
  RenderTokenScope,
} from "../atlas/types";
import type { AtlasCommit } from "../atlas/types";
import { encodeCacheKey } from "../cache/cacheKey";
import type { FontRegistry } from "../FontRegistry";
import { LayoutEngine } from "../layout/LayoutEngine";
import {
  isLeasedPositionedRun,
  ownedPositionedRun,
  releasePositionedRun,
  retainPositionedRun,
} from "../layout/PositionedRunLease";
import type { LayoutResult, PositionedRun, TextLayoutInput } from "../layout/types";
import { createControlledTeardown } from "../lifecycle/ControlledTeardown";
import type { TrustedGlyphRun } from "../shaping/TrustedGlyphRun";
import { TextDirty } from "../store/types";
import type { TextLayoutOptions, TextShapingOptions } from "../types";
import { cleanupBestEffort } from "./cleanup";
import { GlyphInstanceStore } from "./GlyphInstanceStore";
import type { GpuResidentAdmitColumn } from "./GpuResidentScene";
import {
  GPU_SCENE_MAX_PAINTS,
  GPU_SCENE_MAX_PROTOTYPES,
  GpuSceneCompiler,
  type GpuScenePlan,
  type GpuScenePrototypeBinding,
} from "./GpuSceneCompiler";
import type { OutlineRenderingPlugin, OutlineRenderingRasterRequest } from "./outline/types";
import { canonicalFillPaint, TransformPalette } from "./TransformPalette";
import type {
  GlyphInstanceBatch,
  GlyphInstanceStoreOptions,
  TransformPaletteOptions,
} from "./types";

export interface RenderLabelSnapshot {
  readonly sourceRevision: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly zIndex: number;
  readonly order: number;
  readonly blendMode: BLEND_MODES;
  readonly alpha: number;
  readonly visible: boolean;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly style: Readonly<TextStyleOptions>;
  readonly layout?: Readonly<TextLayoutOptions>;
  readonly shaping?: Readonly<TextShapingOptions>;
  /** Projected font height in device pixels. Present on the regular label path. */
  readonly projectedHeightPx?: number;
}

export interface RenderChange {
  readonly slot: number;
  readonly mask: number;
  readonly snapshot: Readonly<RenderLabelSnapshot> | undefined;
  readonly trustedRun?: TrustedGlyphRun;
  /** Transform dirty is only x/y; patch palette texels without rewriting fill/effects. */
  readonly positionOnly?: boolean;
  /** Drop the draw state but keep the run, instances, and palette. */
  readonly retainResources?: boolean;
}

export interface RenderLayoutEngineLike {
  layout(labelId: number, sourceRevision: number, input: TextLayoutInput): LayoutResult;
  destroy(): void;
}

export interface GlyphProviderLike {
  rasterize(request: RasterGlyphRequest): Promise<Readonly<GlyphRaster>>;
  destroy(): void | Promise<void>;
}

export interface RenderCoordinatorOptions {
  readonly registry: FontRegistry;
  readonly layoutEngine?: RenderLayoutEngineLike;
  readonly glyphProvider?: GlyphProviderLike;
  /** Dynamic canvas and MSDF rasterizer configuration used by the default glyph provider. */
  readonly rasterizerOptions?: RasterGlyphProviderOptions;
  /** Explicitly opt into analytic outline rasterization for eligible HarfBuzz glyphs. */
  readonly glyphMode?: "auto" | "outline";
  /** Caller-owned side-entry plugin used when `glyphMode` is `outline`. */
  readonly outline?: OutlineRenderingPlugin;
  readonly atlas?: GlyphAtlas;
  readonly instances?: GlyphInstanceStore;
  readonly transforms?: TransformPalette;
  readonly atlasOptions?: GlyphAtlasOptions;
  readonly instanceOptions?: GlyphInstanceStoreOptions;
  readonly transformOptions?: TransformPaletteOptions;
}

export interface RenderCommitResult {
  readonly revision: number;
  readonly stale: boolean;
  readonly appliedLabels: number;
  readonly glyphs: number;
  readonly atlasUploads: number;
  readonly atlasCommit: Readonly<AtlasCommit>;
  readonly drawOrderChanged: boolean;
}

/** Shared-string content storm: one layout, then share + palette x/y for a slot column. */
export interface ContentLaneInput {
  readonly slots: Uint32Array;
  readonly count: number;
  readonly xy: Float32Array;
  readonly text: string;
  readonly style: Readonly<TextStyleOptions>;
  readonly projectedHeightPx?: number;
  /** Storage palette patches x/y on the GPU; skip the CPU 32-byte scatter. */
  readonly writePalettePositions?: boolean;
}

interface PreparedAdmitColumn {
  readonly group: AdmitLaneGroup;
  readonly run: Readonly<PositionedRun>;
  readonly ownedRun: Readonly<PositionedRun>;
  readonly snapshot: Readonly<RenderLabelSnapshot>;
}

/** First-seen fill-only column: one layout, share, full palette write, draw-state insert. */
export interface AdmitLaneGroup {
  readonly slots: Uint32Array;
  readonly count: number;
  readonly xy: Float32Array;
  readonly orders: Uint32Array;
  readonly text: string;
  readonly style: Readonly<TextStyleOptions>;
  readonly projectedHeightPx?: number;
}

/** GPU-resident first-seen group. Slot traversal must preserve transparent draw order. */
export interface ResidentAdmitLaneGroup extends AdmitLaneGroup {
  readonly zIndex: number;
  readonly blendMode: BLEND_MODES;
  readonly rotations?: Float32Array;
  readonly layout?: Readonly<TextLayoutOptions>;
  /** Pre-layout geometry candidate assigned by the bounded GPU-scene compiler. */
  readonly prototypeCandidateIndex?: number;
}

export type ResidentPrototypeColumn = GpuResidentAdmitColumn;

export interface ResidentAdmitLaneResult extends RenderCommitResult {
  readonly residentColumns: readonly Readonly<ResidentPrototypeColumn>[];
  /** Internal bounded-plan outcome consumed by TextLayer's deterministic fallback path. */
  readonly residentFallbackReason?: "device-limit";
}

export interface ResidentAdmitLaneOptions {
  readonly mode?: "append" | "rebind";
  /** Complete-scene device capacity check, called after layout and before raster/atlas work. */
  readonly capacityFits?: (recordCount: number, drawInstanceCount: number) => boolean;
}

export interface RenderDrawState {
  readonly slot: number;
  readonly zIndex: number;
  readonly order: number;
  readonly blendMode: BLEND_MODES;
}

export interface RenderCoordinatorStats {
  readonly revisions: number;
  readonly staleRevisions: number;
  readonly appliedLabels: number;
  readonly shapedLabels: number;
  readonly transformOnlyLabels: number;
  readonly removedLabels: number;
  readonly glyphs: number;
  readonly pendingGlyphs: number;
  readonly staleGlyphResults: number;
  readonly residentLabels: number;
  readonly residentPrototypeCount: number;
  /** Resident labels own typed palette/record columns and zero coordinator objects per label. */
  readonly residentPerLabelObjectCount: 0;
  readonly lastLayoutMs: number;
  readonly lastInstanceWriteMs: number;
  readonly lastPaletteWriteMs: number;
}

interface PreparedChange {
  readonly change: RenderChange;
  readonly run?: Readonly<PositionedRun>;
  readonly ownedRun?: Readonly<PositionedRun>;
}

interface BuiltGlyphInstances {
  readonly batch: GlyphInstanceBatch;
  readonly atlasKeys: readonly GlyphCacheKey[];
}

interface PreparedResidentColumn {
  readonly group: ResidentAdmitLaneGroup;
  readonly run: Readonly<PositionedRun>;
  readonly ownedRun: Readonly<PositionedRun>;
  readonly snapshot: Readonly<RenderLabelSnapshot>;
}

interface PreparedSharedColumn {
  readonly run: Readonly<PositionedRun>;
  readonly ownedRun: Readonly<PositionedRun>;
  readonly snapshot: Readonly<RenderLabelSnapshot>;
}

const EMPTY_ATLAS_COMMIT: Readonly<AtlasCommit> = Object.freeze({
  entries: Object.freeze([]),
  uploads: Object.freeze([]),
  externalUploads: Object.freeze([]),
  evictedKeys: Object.freeze([]),
});

interface GlyphRasterPlan {
  readonly baseMode: GlyphMode;
  readonly identityMode: GlyphMode;
  readonly identityVariationKey: string;
  readonly outlineRequest?: Readonly<OutlineRenderingRasterRequest>;
}

const LAYER_LIFECYCLE_EPOCH = Symbol("pixi-glyphflow render lifecycle epoch");
type LayerRenderCoordinatorOptions = RenderCoordinatorOptions & {
  readonly [LAYER_LIFECYCLE_EPOCH]: number;
};

/** @internal Construct a coordinator whose render tokens carry the owning layer epoch. */
export function createLayerRenderCoordinator(
  options: Omit<RenderCoordinatorOptions, "registry">,
  registry: FontRegistry,
  lifecycleEpoch: number,
): RenderCoordinator {
  if (!Number.isSafeInteger(lifecycleEpoch) || lifecycleEpoch < 0) {
    throw new TypeError("Render lifecycle epoch must be a non-negative safe integer");
  }
  const coordinatorOptions: LayerRenderCoordinatorOptions = {
    ...options,
    registry,
    [LAYER_LIFECYCLE_EPOCH]: lifecycleEpoch,
  };
  return new RenderCoordinator(coordinatorOptions);
}

export class RenderCoordinator {
  readonly instances: GlyphInstanceStore;
  readonly transforms: TransformPalette;
  readonly atlas: GlyphAtlas;
  readonly #layout: RenderLayoutEngineLike;
  readonly #provider: GlyphProviderLike;
  readonly #ownsLayout: boolean;
  readonly #ownsProvider: boolean;
  readonly #ownsAtlas: boolean;
  readonly #ownsInstances: boolean;
  readonly #ownsTransforms: boolean;
  readonly #runs = new Map<number, Readonly<PositionedRun>>();
  readonly #drawStates = new Map<number, Readonly<RenderDrawState>>();
  readonly #pendingGlyphs = new Map<GlyphCacheKey, Promise<void>>();
  readonly #pendingGlyphTokens = new Map<GlyphCacheKey, Readonly<RenderToken>>();
  readonly #slotAtlasKeys = new Map<number, readonly GlyphCacheKey[]>();
  readonly #atlasKeyRefs = new Map<GlyphCacheKey, number>();
  readonly #residentPrototypeSlots = new Set<number>();
  #nextResidentPrototypeSlot = 0;
  #residentCompiler: GpuSceneCompiler | undefined;
  #pendingAtlasCommit: Readonly<AtlasCommit> | undefined;
  readonly #pendingAtlasPins: GlyphCacheKey[] = [];
  #batchPositions = new Float32Array(0);
  #batchUvs = new Float32Array(0);
  #batchPalette = new Uint32Array(0);
  #batchPages = new Uint16Array(0);
  #batchModes = new Uint8Array(0);
  #batchScales = new Float32Array(0);
  #admitFillSlots = new Uint32Array(0);
  #admitFillXy = new Float32Array(0);
  readonly #seenAtlasKeys = new Set<GlyphCacheKey>();
  #ticket = 0;
  #revisions = 0;
  #staleRevisions = 0;
  #appliedLabels = 0;
  #shapedLabels = 0;
  #transformOnlyLabels = 0;
  #removedLabels = 0;
  #lastAddedOrder = 0;
  #needsDrawSort = false;
  #nonZeroZStates = 0;
  #drawStateList: Readonly<RenderDrawState>[] = [];
  #drawStatesDirty = true;
  #drawListEpoch = 0;
  readonly #ensuredRuns = new Map<Readonly<PositionedRun>, Map<string, Promise<void> | "done">>();
  readonly #runLeases = new Map<Readonly<RenderTokenScope>, Set<Readonly<PositionedRun>>>();
  #ensuredTicket = 0;
  readonly #registry: FontRegistry;
  readonly #destinationIdentity = Object.freeze({});
  #lifecycleEpoch = 0;
  #activeScope: Readonly<RenderTokenScope> | undefined;
  #runsByStyle = new WeakMap<object, Map<string, LayoutResult>>();
  readonly #prototypeByRun = new WeakMap<object, Map<string, number>>();
  readonly #slotPrototypeVariants = new Map<number, string>();
  #internRevision = -1;
  #lastLayoutMs = 0;
  #lastInstanceWriteMs = 0;
  #lastPaletteWriteMs = 0;
  #staleGlyphResults = 0;
  #residentLabels = 0;
  #drawRebuildPending = false;
  readonly #tinySdf: boolean;
  readonly #outline: OutlineRenderingPlugin | undefined;
  #destroyed = false;
  #destroyPromise: Promise<void> | undefined;

  constructor(options: RenderCoordinatorOptions) {
    this.#layout = options.layoutEngine ?? new LayoutEngine(options.registry);
    this.#provider =
      options.glyphProvider ??
      new LazyRasterGlyphProvider(options.registry, options.rasterizerOptions);
    this.atlas = options.atlas ?? new GlyphAtlas(options.atlasOptions);
    this.instances = options.instances ?? new GlyphInstanceStore(options.instanceOptions);
    this.transforms = options.transforms ?? new TransformPalette(options.transformOptions);
    this.#ownsLayout = options.layoutEngine === undefined;
    this.#ownsProvider = options.glyphProvider === undefined;
    this.#ownsAtlas = options.atlas === undefined;
    this.#ownsInstances = options.instances === undefined;
    this.#ownsTransforms = options.transforms === undefined;
    this.#registry = options.registry;
    this.#lifecycleEpoch =
      LAYER_LIFECYCLE_EPOCH in options
        ? (options as LayerRenderCoordinatorOptions)[LAYER_LIFECYCLE_EPOCH]
        : 0;
    this.#tinySdf = options.rasterizerOptions?.tinySdf === true;
    if (options.glyphMode === "outline" && options.outline === undefined) {
      throw new TypeError("glyphMode outline requires an outline rendering plugin");
    }
    this.#outline = options.glyphMode === "outline" ? options.outline : undefined;
  }

  get outlineEnabled(): boolean {
    return this.#outline !== undefined;
  }

  async commit(
    revision: number,
    changes: readonly RenderChange[],
  ): Promise<Readonly<RenderCommitResult>> {
    this.#assertActive();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError("Render revision must be a non-negative safe integer");
    }
    validateChanges(changes);
    this.#lastLayoutMs = 0;
    this.#lastInstanceWriteMs = 0;
    this.#lastPaletteWriteMs = 0;
    const scope = this.#beginRender();
    try {
      const prepareStart = performance.now();
      const preparedOrPending = this.#prepareChanges(changes, scope);
      const prepared = isPromise(preparedOrPending) ? await preparedOrPending : preparedOrPending;
      this.#lastLayoutMs = performance.now() - prepareStart;
      if (!this.#isScopeCurrent(scope)) {
        this.#discardAtlas(scope);
        this.#staleRevisions += 1;
        return this.#result(revision, true, 0, EMPTY_ATLAS_COMMIT, false);
      }

      const atlasCommit = this.#commitAtlas(scope);
      let appliedLabels = 0;
      let shapedLabels = 0;
      let transformOnlyLabels = 0;
      let removedLabels = 0;
      let drawOrderChanged = false;
      let wroteInstances = false;
      const writeStart = performance.now();
      for (const item of prepared) {
        const { change, run } = item;
        if (change.snapshot === undefined) {
          const removedState = this.#drawStates.get(change.slot);
          if (removedState !== undefined) {
            this.#drawStates.delete(change.slot);
            if (removedState.zIndex !== 0) this.#nonZeroZStates -= 1;
            drawOrderChanged = true;
            this.#drawRebuildPending = true;
            this.#drawStatesDirty = true;
            this.#drawListEpoch += 1;
          }
          if (change.retainResources === true) {
            appliedLabels += 1;
            continue;
          }
          this.#forgetPrototype(change.slot);
          this.#runs.delete(change.slot);
          this.#releaseSlotKeys(change.slot);
          const instanceStart = performance.now();
          this.instances.remove(change.slot);
          const paletteStart = performance.now();
          this.#lastInstanceWriteMs += paletteStart - instanceStart;
          this.transforms.remove(change.slot);
          this.#lastPaletteWriteMs += performance.now() - paletteStart;
          removedLabels += 1;
          appliedLabels += 1;
          continue;
        }
        if (run === undefined) {
          throw new Error(`Prepared render run missing for slot ${String(change.slot)}`);
        }
        const previousDrawState = this.#drawStates.get(change.slot);
        if (
          previousDrawState === undefined ||
          previousDrawState.zIndex !== change.snapshot.zIndex ||
          previousDrawState.order !== change.snapshot.order ||
          previousDrawState.blendMode !== change.snapshot.blendMode
        ) {
          if (
            change.snapshot.zIndex !== 0 &&
            (previousDrawState === undefined || previousDrawState.zIndex === 0)
          ) {
            this.#nonZeroZStates += 1;
          } else if (
            change.snapshot.zIndex === 0 &&
            previousDrawState !== undefined &&
            previousDrawState.zIndex !== 0
          ) {
            this.#nonZeroZStates -= 1;
          }
          if (previousDrawState === undefined) {
            // Ascending zero-z inserts append in sorted position; anything else must re-sort.
            if (change.snapshot.order < this.#lastAddedOrder || this.#nonZeroZStates > 0) {
              this.#needsDrawSort = true;
            }
            this.#lastAddedOrder = Math.max(this.#lastAddedOrder, change.snapshot.order);
          } else if (
            previousDrawState.zIndex !== change.snapshot.zIndex ||
            previousDrawState.order !== change.snapshot.order
          ) {
            this.#needsDrawSort = true;
          }
          this.#drawStates.set(
            change.slot,
            Object.freeze({
              slot: change.slot,
              zIndex: change.snapshot.zIndex,
              order: change.snapshot.order,
              blendMode: change.snapshot.blendMode,
            }),
          );
          drawOrderChanged = true;
          this.#drawRebuildPending = true;
          this.#drawStatesDirty = true;
        }
        const sourceChanged = this.#sourceChanged(change);
        if (sourceChanged) {
          const ownedRun = item.ownedRun ?? run;
          this.#writeInstances(change.slot, run, change.snapshot, ownedRun);
          wroteInstances = true;
          shapedLabels += 1;
        } else {
          transformOnlyLabels += 1;
        }
        const keepFill =
          change.positionOnly === true &&
          change.snapshot.anchorX === 0 &&
          change.snapshot.anchorY === 0;
        if (
          keepFill &&
          this.transforms.setPosition(change.slot, change.snapshot.x, change.snapshot.y)
        ) {
          appliedLabels += 1;
          continue;
        }
        this.transforms.set(
          change.slot,
          {
            x: change.snapshot.x,
            y: change.snapshot.y,
            scaleX: change.snapshot.scaleX,
            scaleY: change.snapshot.scaleY,
            rotation: change.snapshot.rotation,
            alpha: change.snapshot.alpha,
            visible: change.snapshot.visible,
            anchorX: change.snapshot.anchorX,
            anchorY: change.snapshot.anchorY,
            fill: change.snapshot.style.fill,
            stroke: change.snapshot.style.stroke,
            dropShadow: change.snapshot.style.dropShadow,
          },
          run.bounds,
        );
        appliedLabels += 1;
      }
      const writeMs = performance.now() - writeStart;
      if (wroteInstances) this.#lastInstanceWriteMs = writeMs;
      else this.#lastPaletteWriteMs = writeMs;
      const result = this.#result(
        revision,
        false,
        appliedLabels,
        atlasCommit,
        drawOrderChanged || this.#drawRebuildPending,
      );
      this.#releaseRunLeases(scope);
      this.#acceptAtlasCommit();
      this.#revisions += 1;
      this.#appliedLabels += appliedLabels;
      this.#shapedLabels += shapedLabels;
      this.#transformOnlyLabels += transformOnlyLabels;
      this.#removedLabels += removedLabels;
      this.#drawRebuildPending = false;
      return result;
    } catch (error: unknown) {
      cleanupBestEffort([() => this.#discardAtlas(scope)]);
      throw error;
    }
  }

  /**
   * Position-only movers bypass the per-label change pipeline: sorted slot and xy columns patch
   * palette texels directly. Draw states, runs, and instances are untouched.
   */
  applyPositionLane(
    slots: Uint32Array,
    count: number,
    xy: Float32Array,
  ): Readonly<RenderCommitResult> {
    this.#assertActive();
    validatePackedLane("Position lane", count, slots, xy);
    const paletteStart = performance.now();
    const written = this.transforms.writePositions(slots, count, xy);
    this.#lastPaletteWriteMs += performance.now() - paletteStart;
    this.#transformOnlyLabels += count;
    this.#appliedLabels += count;

    const result = this.#result(0, false, written, EMPTY_ATLAS_COMMIT, this.#drawRebuildPending);
    this.#drawRebuildPending = false;
    return result;
  }

  /** Count a position storm that the GPU storage table will patch. */
  notePositionLane(count: number): Readonly<RenderCommitResult> {
    this.#assertActive();
    assertLaneCount("Position lane", count);
    this.#transformOnlyLabels += count;
    this.#appliedLabels += count;
    const result = this.#result(0, false, count, EMPTY_ATLAS_COMMIT, this.#drawRebuildPending);
    this.#drawRebuildPending = false;
    return result;
  }

  /**
   * Broadcast text-plus-position: layout once, share the prototype range, patch palette x/y. Draw
   * states stay; callers must already have a palette row per slot (rendered labels).
   */
  async applyContentLane(input: ContentLaneInput): Promise<Readonly<RenderCommitResult>> {
    this.#assertActive();
    validatePackedLane("Content lane", input.count, input.slots, input.xy);
    if (input.count <= 0) {
      const result = this.#result(0, false, 0, EMPTY_ATLAS_COMMIT, this.#drawRebuildPending);
      this.#drawRebuildPending = false;
      return result;
    }
    const scope = this.#beginRender();
    try {
      const prepareStart = performance.now();
      const prepared = await this.#prepareSharedColumn(
        input.text,
        input.style,
        input.slots[0] ?? 0,
        scope,
        input.projectedHeightPx,
      );
      this.#lastLayoutMs = performance.now() - prepareStart;
      if (prepared === undefined) {
        this.#discardAtlas(scope);
        this.#staleRevisions += 1;
        return this.#result(0, true, 0, EMPTY_ATLAS_COMMIT, false);
      }

      const atlasCommit = this.#commitAtlas(scope);
      const writeStart = performance.now();
      this.#writeInstanceColumn(
        input.slots,
        input.count,
        prepared.run,
        prepared.ownedRun,
        prepared.snapshot,
      );
      if (input.writePalettePositions !== false) {
        this.transforms.writePositions(input.slots, input.count, input.xy);
      }
      this.#lastInstanceWriteMs = performance.now() - writeStart;
      const result = this.#result(0, false, input.count, atlasCommit, this.#drawRebuildPending);
      this.#releaseRunLeases(scope);
      this.#acceptAtlasCommit();
      this.#shapedLabels += input.count;
      this.#appliedLabels += input.count;
      this.#revisions += 1;
      this.#drawRebuildPending = false;
      return result;
    } catch (error: unknown) {
      cleanupBestEffort([() => this.#discardAtlas(scope)]);
      throw error;
    }
  }

  /**
   * First-seen fill-only groups: layout once per (text, style), share the prototype, write full
   * palette rows, insert zero-z draw states. Unique groups prepare in parallel so a tight-view
   * first-seen wave is not the sum of each string's layout and raster. Callers must place spatial
   * AABBs after this returns.
   */
  async applyAdmitLane(groups: readonly AdmitLaneGroup[]): Promise<Readonly<RenderCommitResult>> {
    this.#assertActive();
    for (const group of groups) {
      validatePackedLane("Admit lane", group.count, group.slots, group.xy, group.orders);
    }
    if (groups.length === 0) {
      const result = this.#result(0, false, 0, EMPTY_ATLAS_COMMIT, this.#drawRebuildPending);
      this.#drawRebuildPending = false;
      return result;
    }
    const scope = this.#beginRender();
    try {
      const prepareStart = performance.now();
      const queued: AdmitLaneGroup[] = [];
      for (const group of groups) {
        if (group.count <= 0) continue;
        queued.push(group);
      }
      const columns = await Promise.all(
        queued.map((group) =>
          this.#prepareSharedColumn(
            group.text,
            group.style,
            group.slots[0] ?? 0,
            scope,
            group.projectedHeightPx,
          ).then((column) => ({ group, column })),
        ),
      );
      const prepared: PreparedAdmitColumn[] = [];
      for (const item of columns) {
        if (item.column === undefined) {
          this.#discardAtlas(scope);
          this.#lastLayoutMs = performance.now() - prepareStart;
          this.#staleRevisions += 1;
          return this.#result(0, true, 0, EMPTY_ATLAS_COMMIT, false);
        }
        prepared.push({ group: item.group, ...item.column });
      }
      this.#lastLayoutMs = performance.now() - prepareStart;

      const atlasCommit = this.#commitAtlas(scope);
      const writeStart = performance.now();
      let applied = 0;
      let drawOrderChanged = false;
      for (const item of prepared) {
        this.#writeInstanceColumn(
          item.group.slots,
          item.group.count,
          item.run,
          item.ownedRun,
          item.snapshot,
        );
        if (this.#admitDrawStates(item.group)) drawOrderChanged = true;
        applied += item.group.count;
      }
      this.#writeAdmitFills(prepared);
      this.#lastInstanceWriteMs = performance.now() - writeStart;
      const result = this.#result(
        0,
        false,
        applied,
        atlasCommit,
        drawOrderChanged || this.#drawRebuildPending,
      );
      this.#releaseRunLeases(scope);
      this.#acceptAtlasCommit();
      this.#shapedLabels += applied;
      this.#appliedLabels += applied;
      this.#revisions += 1;
      this.#drawRebuildPending = false;
      return result;
    } catch (error: unknown) {
      cleanupBestEffort([() => this.#discardAtlas(scope)]);
      throw error;
    }
  }

  /**
   * Build one prototype per resident (text, style) group and write every label palette row through
   * typed columns. Cull records point directly at the prototype range; coordinator run, draw,
   * prototype-key, and atlas-key state stays prototype-scoped.
   */
  async applyResidentAdmitLane(
    groups: readonly ResidentAdmitLaneGroup[],
    compiler?: GpuSceneCompiler,
    options: Readonly<ResidentAdmitLaneOptions> = {},
  ): Promise<Readonly<ResidentAdmitLaneResult> | undefined> {
    this.#assertActive();
    if (groups.length > GPU_SCENE_MAX_PROTOTYPES * GPU_SCENE_MAX_PAINTS) return undefined;
    for (const group of groups) {
      validatePackedLane("Resident admit lane", group.count, group.slots, group.xy, group.orders);
    }
    if (!residentAdmitLaneEligible(groups)) return undefined;
    if (groups.length === 0) {
      const result = this.#residentResult(0, EMPTY_ATLAS_COMMIT, this.#drawRebuildPending, []);
      this.#drawRebuildPending = false;
      return result;
    }
    let sceneCompiler = compiler ?? this.#residentCompiler;
    if (sceneCompiler === undefined) {
      let recordStart = 0xffff_ffff;
      for (const group of groups) {
        if (group.count > 0) recordStart = Math.min(recordStart, group.slots[0] ?? recordStart);
      }
      sceneCompiler = new GpuSceneCompiler({
        recordStart: recordStart === 0xffff_ffff ? 0 : recordStart,
      });
      this.#residentCompiler = sceneCompiler;
    }
    const candidatePrototypeIndices = new Uint8Array(groups.length);
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group === undefined || group.count <= 0) continue;
      const pair = sceneCompiler.admitCandidate(group.text, group.style, group.layout);
      if (pair === undefined) return undefined;
      const prototypeCandidateIndex = Math.floor(pair / GPU_SCENE_MAX_PAINTS);
      if (
        group.prototypeCandidateIndex !== undefined &&
        group.prototypeCandidateIndex !== prototypeCandidateIndex
      ) {
        return undefined;
      }
      candidatePrototypeIndices[index] = prototypeCandidateIndex;
    }
    const scope = this.#beginRender();
    let scenePlan: Readonly<GpuScenePlan> | undefined;
    try {
      const prepareStart = performance.now();
      const queued: ResidentAdmitLaneGroup[] = [];
      const queuedPrototypeIndices: number[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        if (group === undefined || group.count <= 0) continue;
        queued.push(group);
        queuedPrototypeIndices.push(candidatePrototypeIndices[index] ?? 0);
      }
      const sourceGroups: ResidentAdmitLaneGroup[] = [];
      const sourceByPrototype = new Int16Array(GPU_SCENE_MAX_PROTOTYPES).fill(-1);
      const queuedSources = new Uint8Array(queued.length);
      for (let index = 0; index < queued.length; index += 1) {
        const prototypeCandidateIndex = queuedPrototypeIndices[index] ?? 0;
        let sourceIndex = sourceByPrototype[prototypeCandidateIndex] ?? -1;
        if (sourceIndex < 0) {
          sourceIndex = sourceGroups.length;
          sourceByPrototype[prototypeCandidateIndex] = sourceIndex;
          const group = queued[index];
          if (group === undefined) throw new Error("Resident candidate source is unavailable");
          sourceGroups.push(group);
        }
        queuedSources[index] = sourceIndex;
      }
      const sourceColumns = await Promise.all(
        sourceGroups.map((group) =>
          this.#prepareSharedLayout(
            group.text,
            group.style,
            group.slots[0] ?? 0,
            scope,
            group.projectedHeightPx,
            group.layout,
          ),
        ),
      );
      for (const column of sourceColumns) {
        if (column !== undefined) continue;
        this.#discardAtlas(scope);
        this.#lastLayoutMs = performance.now() - prepareStart;
        this.#staleRevisions += 1;
        return this.#residentResult(0, EMPTY_ATLAS_COMMIT, false, []);
      }
      const prepared: PreparedResidentColumn[] = [];
      for (let index = 0; index < queued.length; index += 1) {
        const group = queued[index];
        const column = sourceColumns[queuedSources[index] ?? 0];
        if (group === undefined || column === undefined) {
          throw new Error("Resident prepared source is unavailable");
        }
        prepared.push({ group, ...column });
      }

      let recordCount = 0;
      let drawInstanceCount = 0;
      const drawableGlyphs = new Uint32Array(sourceColumns.length);
      for (let sourceIndex = 0; sourceIndex < sourceColumns.length; sourceIndex += 1) {
        const source = sourceColumns[sourceIndex];
        if (source === undefined) throw new Error("Resident prepared source is unavailable");
        let drawable = 0;
        for (let glyphIndex = 0; glyphIndex < source.run.glyphCount; glyphIndex += 1) {
          if (!isEmptyInkGlyph(source.run, glyphIndex)) drawable += 1;
        }
        drawableGlyphs[sourceIndex] = drawable;
      }
      for (let index = 0; index < queued.length; index += 1) {
        const group = queued[index];
        if (group === undefined) throw new Error("Resident prepared group is unavailable");
        const sourceIndex = queuedSources[index] ?? 0;
        recordCount += group.count;
        drawInstanceCount += group.count * (drawableGlyphs[sourceIndex] ?? 0);
        if (
          !Number.isSafeInteger(recordCount) ||
          !Number.isSafeInteger(drawInstanceCount) ||
          recordCount > 0xffff_ffff ||
          drawInstanceCount > 0xffff_ffff
        ) {
          this.#discardAtlas(scope);
          this.#lastLayoutMs = performance.now() - prepareStart;
          return Object.freeze({
            ...this.#residentResult(0, EMPTY_ATLAS_COMMIT, false, []),
            residentFallbackReason: "device-limit",
          });
        }
      }
      if (options.capacityFits?.(recordCount, drawInstanceCount) === false) {
        this.#discardAtlas(scope);
        this.#lastLayoutMs = performance.now() - prepareStart;
        return Object.freeze({
          ...this.#residentResult(0, EMPTY_ATLAS_COMMIT, false, []),
          residentFallbackReason: "device-limit",
        });
      }

      const compiled = sceneCompiler.compile(
        prepared.map((item) => ({
          slots: item.group.slots,
          count: item.group.count,
          xy: item.group.xy,
          ...(item.group.rotations === undefined ? {} : { rotations: item.group.rotations }),
          orders: item.group.orders,
          run: item.run,
          rasterIdentity: this.#residentRasterIdentity(item.run, item.snapshot),
          paint: canonicalFillPaint(item.group.style.fill),
        })),
        options.mode ?? "append",
      );
      if (compiled.status === "unsupported") {
        this.#discardAtlas(scope);
        return undefined;
      }
      scenePlan = compiled;

      const missingGlyphs: Promise<void>[] = [];
      for (const source of sourceColumns) {
        if (source === undefined) throw new Error("Resident prepared source is unavailable");
        const missing = this.#ensureMissingGlyphs(source.run, source.snapshot, scope);
        if (missing !== undefined) missingGlyphs.push(missing);
      }
      if (missingGlyphs.length > 0) await Promise.all(missingGlyphs);
      if (!this.#isScopeCurrent(scope)) {
        this.#discardAtlas(scope);
        this.#lastLayoutMs = performance.now() - prepareStart;
        this.#staleRevisions += 1;
        return this.#residentResult(0, EMPTY_ATLAS_COMMIT, false, []);
      }
      this.#lastLayoutMs = performance.now() - prepareStart;

      const atlasCommit = this.#commitAtlas(scope);
      const writeStart = performance.now();
      const residentColumns: ResidentPrototypeColumn[] = [];
      let drawOrderChanged = false;
      const bound = new Uint8Array(scenePlan.prototypeCount);
      for (const column of scenePlan.columns) {
        if (bound[column.prototypeIndex] === 1) continue;
        bound[column.prototypeIndex] = 1;
        let binding = sceneCompiler.prototypeBinding(column.prototypeIndex);
        if (binding === undefined) {
          const source = prepared[column.sourceIndex];
          if (source === undefined) throw new Error("GPU scene prototype source is unavailable");
          const prototype = this.#writeResidentPrototype(source);
          if (prototype.drawOrderChanged) drawOrderChanged = true;
          binding = Object.freeze({
            prototypeId: prototype.slot,
            instanceOffset: prototype.offset,
            instanceCount: prototype.count,
            localBounds: new Float32Array([
              source.run.bounds.x,
              source.run.bounds.y,
              source.run.bounds.width,
              source.run.bounds.height,
            ]),
          }) satisfies Readonly<GpuScenePrototypeBinding>;
          sceneCompiler.bindPrototype(column.prototypeIndex, binding);
        }
      }
      for (const column of scenePlan.columns) {
        const binding = sceneCompiler.prototypeBinding(column.prototypeIndex);
        if (binding === undefined) throw new Error("GPU scene prototype binding is unavailable");
        residentColumns.push({
          slots: column.slots,
          count: column.count,
          xy: column.xy,
          ...(column.rotations === undefined ? {} : { rotations: column.rotations }),
          orders: column.orders,
          localBounds: binding.localBounds,
          prototypeId: binding.prototypeId,
          instanceOffset: binding.instanceOffset,
          instanceCount: binding.instanceCount,
          zIndex: 0,
          blendMode: "normal",
        });
        this.transforms.writeCanonicalFills(
          column.slots,
          column.count,
          column.xy,
          sceneCompiler.paint(column.paintIndex),
          column.rotations,
        );
      }
      this.#lastInstanceWriteMs = performance.now() - writeStart;
      const result = this.#residentResult(
        scenePlan.recordCount,
        atlasCommit,
        drawOrderChanged || this.#drawRebuildPending,
        residentColumns,
      );
      this.#releaseRunLeases(scope);
      this.#acceptAtlasCommit();
      this.#shapedLabels += sourceColumns.length;
      this.#appliedLabels += scenePlan.recordCount;
      if (scenePlan.mode === "append") this.#residentLabels += scenePlan.recordCount;
      this.#revisions += 1;
      this.#drawRebuildPending = false;
      return result;
    } catch (error: unknown) {
      cleanupBestEffort([
        () => {
          if (scenePlan !== undefined) sceneCompiler.rollback(scenePlan);
        },
        () => this.#discardAtlas(scope),
      ]);
      throw error;
    }
  }

  getRun(slot: number): Readonly<PositionedRun> | undefined {
    this.#assertActive();
    return this.#runs.get(slot);
  }

  /**
   * True when this (text, style) already has a layout intern, including an in-flight promise.
   * Compute-cull uses it to admit ring-only copies without rastering a unique miss.
   */
  hasInternedLayout(input: {
    readonly text: string;
    readonly style: Readonly<TextStyleOptions>;
    readonly layout?: Readonly<TextLayoutOptions>;
    readonly shaping?: Readonly<TextShapingOptions>;
  }): boolean {
    this.#assertActive();
    const snapshot: RenderLabelSnapshot = {
      ...contentLaneSnapshot(input.text, input.style),
      ...(input.layout === undefined ? {} : { layout: input.layout }),
      ...(input.shaping === undefined ? {} : { shaping: input.shaping }),
    };
    return this.#lookupIntern(snapshot) !== undefined;
  }

  getDrawStates(): readonly Readonly<RenderDrawState>[] {
    this.#assertActive();
    if (!this.#drawStatesDirty && !this.#needsDrawSort) return this.#drawStateList;
    const states = Array.from(this.#drawStates.values());
    if (this.#needsDrawSort) {
      states.sort((left, right) => left.zIndex - right.zIndex || left.order - right.order);
      this.#needsDrawSort = false;
      this.#drawListEpoch += 1;
    }
    this.#drawStateList = states;
    this.#drawStatesDirty = false;
    return states;
  }

  /**
   * Changes when the draw-state list is re-sorted or loses entries. While it holds still, new draw
   * states only append, so packed cull-record prefixes stay valid.
   */
  get drawListEpoch(): number {
    return this.#drawListEpoch;
  }

  get stats(): Readonly<RenderCoordinatorStats> {
    return Object.freeze({
      revisions: this.#revisions,
      staleRevisions: this.#staleRevisions,
      appliedLabels: this.#appliedLabels,
      shapedLabels: this.#shapedLabels,
      transformOnlyLabels: this.#transformOnlyLabels,
      removedLabels: this.#removedLabels,
      glyphs: this.instances.stats.activeInstances,
      pendingGlyphs: this.#pendingGlyphs.size,
      staleGlyphResults: this.#staleGlyphResults,
      residentLabels: this.#residentLabels,
      residentPrototypeCount: this.#residentPrototypeSlots.size,
      residentPerLabelObjectCount: 0,
      lastLayoutMs: this.#lastLayoutMs,
      lastInstanceWriteMs: this.#lastInstanceWriteMs,
      lastPaletteWriteMs: this.#lastPaletteWriteMs,
    });
  }

  /** Detach immediately, finish every owned release once, and report the first failure. */
  destroy(): Promise<void> {
    const existing = this.#destroyPromise;
    if (existing !== undefined) return existing;

    const teardown = createControlledTeardown();
    this.#destroyPromise = teardown.promise;
    this.#destroyed = true;
    const activeScope = this.#activeScope;
    const leasedRuns = Array.from(this.#runLeases.values(), (runs) => [...runs]).flat();
    const pendingAtlasCommit = this.#pendingAtlasCommit;
    const pinnedAtlasKeys = [...this.#atlasKeyRefs.keys()];
    this.#activeScope = undefined;
    this.#pendingAtlasCommit = undefined;
    this.#pendingAtlasPins.length = 0;
    this.#runLeases.clear();
    this.#lifecycleEpoch += 1;
    this.#ticket += 1;
    this.#runs.clear();
    this.#drawStates.clear();
    this.#drawStateList = [];
    this.#drawStatesDirty = true;
    this.#needsDrawSort = false;
    this.#drawRebuildPending = false;
    this.#nonZeroZStates = 0;
    this.#pendingGlyphs.clear();
    this.#pendingGlyphTokens.clear();
    this.#slotPrototypeVariants.clear();
    this.#clearIntern();
    this.#slotAtlasKeys.clear();
    this.#atlasKeyRefs.clear();
    this.#residentPrototypeSlots.clear();
    this.#residentLabels = 0;
    this.#ensuredRuns.clear();
    this.#seenAtlasKeys.clear();

    let providerTeardown: Promise<void> | undefined;
    const cleanupSteps: Array<() => void> = [];
    if (activeScope !== undefined) {
      cleanupSteps.push(() => {
        this.#staleGlyphResults += discardGlyphAtlasRenderFrame(this.atlas, activeScope);
      });
    }
    for (const run of leasedRuns) cleanupSteps.push(() => releasePositionedRun(run));
    if (pendingAtlasCommit !== undefined) {
      for (const upload of pendingAtlasCommit.externalUploads) {
        cleanupSteps.push(() => upload.release());
      }
    }
    for (const key of pinnedAtlasKeys) cleanupSteps.push(() => this.atlas.unpin(key));
    if (this.#ownsLayout) cleanupSteps.push(() => this.#layout.destroy());
    if (this.#ownsProvider) {
      cleanupSteps.push(() => {
        const pending = this.#provider.destroy();
        if (pending !== undefined) providerTeardown = Promise.resolve(pending);
      });
    }
    if (this.#ownsAtlas) cleanupSteps.push(() => this.atlas.destroy());
    if (this.#ownsInstances) cleanupSteps.push(() => this.instances.destroy());
    if (this.#ownsTransforms) cleanupSteps.push(() => this.transforms.destroy());
    const failure = cleanupBestEffort(cleanupSteps);

    if (providerTeardown === undefined) {
      if (failure === undefined) teardown.resolve();
      else teardown.reject(failure.error);
    } else {
      void providerTeardown.then(
        () => {
          if (failure === undefined) teardown.resolve();
          else teardown.reject(failure.error);
        },
        (error: unknown) => teardown.reject(failure?.error ?? error),
      );
    }

    return teardown.promise;
  }

  #prepareChanges(
    changes: readonly RenderChange[],
    scope: Readonly<RenderTokenScope>,
  ): PreparedChange[] | Promise<PreparedChange[]> {
    const prepared: PreparedChange[] = [];
    const pending: Promise<void>[] = [];
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (change === undefined) throw new Error("Render change list is incomplete");
      const item = this.#prepare(change, scope);
      if (isPromise(item)) {
        pending.push(
          item.then((ready) => {
            prepared[index] = ready;
          }),
        );
        continue;
      }
      prepared[index] = item;
    }
    if (pending.length === 0) return prepared;
    return Promise.all(pending).then(() => prepared);
  }

  #sourceChanged(change: RenderChange): boolean {
    return (
      (change.mask & (TextDirty.Content | TextDirty.Style)) !== 0 ||
      this.#runs.get(change.slot) === undefined
    );
  }

  #prepare(
    change: RenderChange,
    scope: Readonly<RenderTokenScope>,
  ): PreparedChange | Promise<PreparedChange> {
    const snapshot = change.snapshot;
    if (snapshot === undefined) {
      return { change };
    }
    const sourceChanged = this.#sourceChanged(change);
    if (!sourceChanged) {
      const run = this.#runs.get(change.slot);
      if (run === undefined) {
        throw new Error(`Render run missing for transform slot ${String(change.slot)}`);
      }
      return { change, run };
    }

    if (change.trustedRun !== undefined) {
      return this.#finishPrepare(change, snapshot, scope, change.trustedRun);
    }
    const interned = this.#lookupIntern(snapshot);
    if (interned !== undefined) {
      if (isPromise(interned)) {
        return interned.then((run) => this.#finishPrepare(change, snapshot, scope, run));
      }
      return this.#finishPrepare(change, snapshot, scope, interned);
    }
    const laidOut = this.#layout.layout(change.slot, snapshot.sourceRevision, {
      text: snapshot.text,
      style: snapshot.style,
      ...snapshot.layout,
      ...snapshot.shaping,
    });
    this.#storeIntern(snapshot, laidOut);
    if (isPromise(laidOut)) {
      return laidOut.then((run) => {
        this.#storeIntern(snapshot, run);
        return this.#finishPrepare(change, snapshot, scope, run);
      });
    }
    return this.#finishPrepare(change, snapshot, scope, laidOut);
  }

  #finishPrepare(
    change: RenderChange,
    snapshot: Readonly<RenderLabelSnapshot>,
    scope: Readonly<RenderTokenScope>,
    run: Readonly<PositionedRun>,
  ): PreparedChange | Promise<PreparedChange> {
    if (!this.#trackRunLease(scope, run) || !this.#isScopeCurrent(scope)) {
      return { change, run };
    }
    const missing = this.#ensureMissingGlyphs(run, snapshot, scope);
    if (missing === undefined) return { change, run, ownedRun: ownedPositionedRun(run) };
    return missing.then(() => ({
      change,
      run,
      ...(!this.#isScopeCurrent(scope) ? {} : { ownedRun: ownedPositionedRun(run) }),
    }));
  }

  /** Duplicate strings share one run object; raster-plan variants remain independent. */
  #ensureMissingGlyphs(
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
    scope: Readonly<RenderTokenScope>,
  ): Promise<void> | undefined {
    if (this.#ensuredTicket !== this.#ticket) {
      this.#ensuredRuns.clear();
      this.#ensuredTicket = this.#ticket;
    }
    const variantKey = this.#rasterVariantKey(run, snapshot);
    let variants = this.#ensuredRuns.get(run);
    const cached = variants?.get(variantKey);
    if (cached === "done") return undefined;
    if (cached !== undefined) return cached;
    const missing: Promise<void>[] = [];
    for (let index = 0; index < run.glyphCount; index += 1) {
      const pending = this.#ensureGlyph(run, index, snapshot, scope);
      if (pending !== undefined) missing.push(pending);
    }
    if (variants === undefined) {
      variants = new Map();
      this.#ensuredRuns.set(run, variants);
    }
    if (missing.length === 0) {
      variants.set(variantKey, "done");
      return undefined;
    }
    const settled = Promise.all(missing).then(() => undefined);
    variants.set(variantKey, settled);
    return settled;
  }

  #rasterVariantKey(run: Readonly<PositionedRun>, snapshot: Readonly<RenderLabelSnapshot>): string {
    const rasterVariants: string[] = [];
    for (let index = 0; index < run.glyphCount; index += 1) {
      if (isEmptyInkGlyph(run, index)) {
        rasterVariants.push("empty");
        continue;
      }
      const plan = this.#glyphRasterPlan(run, index, snapshot, run.glyphIds[index] ?? 0);
      rasterVariants.push(
        encodeCacheKey([plan.baseMode, plan.identityMode, plan.identityVariationKey]),
      );
    }
    return encodeCacheKey([
      String(resolveFontSize(snapshot.style.fontSize)),
      String(snapshot.style.fontWeight ?? "normal"),
      ...rasterVariants,
    ]);
  }

  #residentRasterIdentity(
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): string {
    const identities: string[] = [];
    for (let index = 0; index < run.glyphCount; index += 1) {
      if (isEmptyInkGlyph(run, index)) {
        identities.push("empty");
        continue;
      }
      const glyphId = run.glyphIds[index] ?? 0;
      const plan = this.#glyphRasterPlan(run, index, snapshot, glyphId);
      const identity = resolveGlyphIdentity({
        fontFamily: run.fontFamily,
        ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
        fontRevision: run.fontRevision,
        glyphId,
        glyphText: lazyGlyphText(run, index, glyphId),
        variationKey: plan.identityVariationKey,
        fontSize: resolveFontSize(snapshot.style.fontSize),
        fontWeight: snapshot.style.fontWeight ?? "normal",
        mode: plan.identityMode,
      });
      identities.push(
        typeof identity.key === "number"
          ? `number:${String(identity.key)}`
          : `string:${identity.key}`,
      );
    }
    return encodeCacheKey(identities);
  }

  #ensureGlyph(
    run: Readonly<PositionedRun>,
    index: number,
    snapshot: Readonly<RenderLabelSnapshot>,
    scope: Readonly<RenderTokenScope>,
  ): Promise<void> | undefined {
    if (isEmptyInkGlyph(run, index)) return;
    const glyphId = run.glyphIds[index] ?? 0;
    const glyphText = lazyGlyphText(run, index, glyphId);
    const plan = this.#glyphRasterPlan(run, index, snapshot, glyphId);
    const identity = resolveGlyphIdentity({
      fontFamily: run.fontFamily,
      ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
      fontRevision: run.fontRevision,
      glyphId,
      glyphText,
      variationKey: plan.identityVariationKey,
      fontSize: resolveFontSize(snapshot.style.fontSize),
      fontWeight: snapshot.style.fontWeight ?? "normal",
      mode: plan.identityMode,
    });
    const key = identity.key;
    if (this.atlas.get(key) !== undefined) {
      return;
    }
    const pending = this.#pendingGlyphs.get(key);
    const pendingToken = this.#pendingGlyphTokens.get(key);
    if (
      pending !== undefined &&
      pendingToken !== undefined &&
      sameRenderScope(pendingToken, scope)
    ) {
      return pending;
    }

    const token = requestGlyphAtlasRenderToken(this.atlas, key, scope, snapshot.sourceRevision);
    let promise: Promise<void>;
    promise = this.#rasterizeGlyph(plan, {
      family: run.fontFamily,
      ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
      fontRevision: run.fontRevision,
      glyphId,
      glyphText: glyphText === "" ? resolveGlyphText(run, index) : glyphText,
      variationKey: run.variationKey ?? "",
      fontSize: identity.fontSize,
      fontWeight: identity.fontWeight,
      mode: plan.baseMode,
    })
      .then((raster) => {
        if (!this.#isScopeCurrent(token)) {
          releaseExternalGlyphRaster(raster);
          this.#rejectRenderToken(token);
          return;
        }
        if (!stageGlyphAtlasRenderToken(this.atlas, token, raster)) {
          this.#rejectRenderToken(token);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof RasterProviderDisposedError && !this.#isScopeCurrent(token)) {
          this.#rejectRenderToken(token);
          return;
        }
        throw error;
      })
      .finally(() => {
        if (this.#pendingGlyphs.get(key) === promise) {
          this.#pendingGlyphs.delete(key);
          this.#pendingGlyphTokens.delete(key);
        }
      });
    this.#pendingGlyphs.set(key, promise);
    this.#pendingGlyphTokens.set(key, token);
    return promise;
  }

  #rasterizeGlyph(
    plan: Readonly<GlyphRasterPlan>,
    fallbackRequest: Readonly<RasterGlyphRequest>,
  ): Promise<Readonly<AtlasGlyphRaster>> {
    const request = plan.outlineRequest;
    const outline = this.#outline;
    if (request === undefined || outline === undefined) {
      return this.#provider.rasterize(fallbackRequest);
    }
    return outline.rasterize(request).then<Readonly<AtlasGlyphRaster>>((result) => {
      switch (result.status) {
        case "ready":
          return result.raster;
        case "empty":
        case "fallback":
          return this.#provider.rasterize(fallbackRequest);
        case "failed":
          throw new Error(`Outline glyph raster failed (${result.reason}): ${result.message}`);
      }
    });
  }

  #prepareSharedColumn(
    text: string,
    style: Readonly<TextStyleOptions>,
    slotHint: number,
    scope: Readonly<RenderTokenScope>,
    projectedHeightPx?: number,
  ): Promise<Readonly<PreparedSharedColumn> | undefined> {
    const prepared = this.#prepareSharedLayout(text, style, slotHint, scope, projectedHeightPx);
    if (isPromise(prepared)) {
      return prepared.then((resolved) => this.#finishSharedColumn(resolved, scope));
    }
    return Promise.resolve(this.#finishSharedColumn(prepared, scope));
  }

  #finishSharedColumn(
    prepared: Readonly<PreparedSharedColumn> | undefined,
    scope: Readonly<RenderTokenScope>,
  ):
    | Readonly<PreparedSharedColumn>
    | Promise<Readonly<PreparedSharedColumn> | undefined>
    | undefined {
    if (prepared === undefined) return undefined;
    const missing = this.#ensureMissingGlyphs(prepared.run, prepared.snapshot, scope);
    if (missing === undefined) return this.#isScopeCurrent(scope) ? prepared : undefined;
    return missing.then(() => (this.#isScopeCurrent(scope) ? prepared : undefined));
  }

  #prepareSharedLayout(
    text: string,
    style: Readonly<TextStyleOptions>,
    slotHint: number,
    scope: Readonly<RenderTokenScope>,
    projectedHeightPx?: number,
    layout?: Readonly<TextLayoutOptions>,
  ):
    | Readonly<PreparedSharedColumn>
    | Promise<Readonly<PreparedSharedColumn> | undefined>
    | undefined {
    const snapshot = {
      ...contentLaneSnapshot(text, style, projectedHeightPx),
      ...(layout === undefined ? {} : { layout }),
    };
    const interned = this.#lookupIntern(snapshot);
    if (interned !== undefined) {
      return isPromise(interned)
        ? interned.then((run) => this.#finishSharedLayout(run, snapshot, scope))
        : this.#finishSharedLayout(interned, snapshot, scope);
    }
    const laidOut = this.#layout.layout(slotHint, 1, { text, style, ...layout });
    this.#storeIntern(snapshot, laidOut);
    if (isPromise(laidOut)) {
      return laidOut.then((run) => {
        this.#storeIntern(snapshot, run);
        return this.#finishSharedLayout(run, snapshot, scope);
      });
    }
    return this.#finishSharedLayout(laidOut, snapshot, scope);
  }

  #finishSharedLayout(
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
    scope: Readonly<RenderTokenScope>,
  ): Readonly<PreparedSharedColumn> | undefined {
    if (!this.#trackRunLease(scope, run) || !this.#isScopeCurrent(scope)) return undefined;
    return { run, ownedRun: ownedPositionedRun(run), snapshot };
  }

  #admitDrawStates(group: AdmitLaneGroup): boolean {
    let changed = false;
    for (let index = 0; index < group.count; index += 1) {
      const slot = group.slots[index];
      const order = group.orders[index];
      if (slot === undefined || order === undefined) {
        throw new Error("Admit lane slot list is incomplete");
      }
      const previous = this.#drawStates.get(slot);
      if (
        previous !== undefined &&
        previous.zIndex === 0 &&
        previous.order === order &&
        previous.blendMode === "normal"
      ) {
        continue;
      }
      if (previous === undefined) {
        if (order < this.#lastAddedOrder || this.#nonZeroZStates > 0) {
          this.#needsDrawSort = true;
        }
        this.#lastAddedOrder = Math.max(this.#lastAddedOrder, order);
      } else if (previous.zIndex !== 0 || previous.order !== order) {
        this.#needsDrawSort = true;
      }
      this.#drawStates.set(
        slot,
        Object.freeze({
          slot,
          zIndex: 0,
          order,
          blendMode: "normal",
        }),
      );
      changed = true;
      this.#drawRebuildPending = true;
      this.#drawStatesDirty = true;
    }
    return changed;
  }

  /**
   * Unique admit groups still write instances per string. Palette rows that share a fill identity
   * (interned style.fill) become one writeFills. Distinct fills stay separate.
   */
  #writeAdmitFills(prepared: readonly PreparedAdmitColumn[]): void {
    if (prepared.length === 0) return;
    if (prepared.length === 1) {
      const group = prepared[0]?.group;
      if (group === undefined) return;
      this.transforms.writeFills(group.slots, group.count, group.xy, group.style.fill);
      return;
    }
    const buckets = new Map<unknown, PreparedAdmitColumn[]>();
    for (const item of prepared) {
      const fill = item.group.style.fill;
      let bucket = buckets.get(fill);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(fill, bucket);
      }
      bucket.push(item);
    }
    for (const [fill, bucket] of buckets) {
      if (bucket.length === 1) {
        const group = bucket[0]?.group;
        if (group === undefined) continue;
        this.transforms.writeFills(group.slots, group.count, group.xy, fill);
        continue;
      }
      let count = 0;
      for (const item of bucket) count += item.group.count;
      this.#ensureAdmitFillCapacity(count);
      let offset = 0;
      for (const item of bucket) {
        const group = item.group;
        this.#admitFillSlots.set(group.slots.subarray(0, group.count), offset);
        this.#admitFillXy.set(group.xy.subarray(0, group.count * 2), offset * 2);
        offset += group.count;
      }
      this.transforms.writeFills(this.#admitFillSlots, count, this.#admitFillXy, fill);
    }
  }

  #ensureAdmitFillCapacity(count: number): void {
    if (this.#admitFillSlots.length >= count) return;
    let capacity = this.#admitFillSlots.length === 0 ? 16 : this.#admitFillSlots.length;
    while (capacity < count) capacity *= 2;
    this.#admitFillSlots = new Uint32Array(capacity);
    this.#admitFillXy = new Float32Array(capacity * 2);
  }

  #writeResidentPrototype(item: Readonly<PreparedResidentColumn>): {
    readonly slot: number;
    readonly offset: number;
    readonly count: number;
    readonly drawOrderChanged: boolean;
  } {
    const variantKey = this.#rasterVariantKey(item.run, item.snapshot);
    const interned = this.#prototypeByRun.get(item.ownedRun)?.get(variantKey);
    let slot =
      interned !== undefined && this.instances.getRange(interned) !== undefined
        ? interned
        : undefined;
    if (slot === undefined) {
      while (this.instances.getRange(this.#nextResidentPrototypeSlot) !== undefined) {
        this.#nextResidentPrototypeSlot += 1;
      }
      slot = this.#nextResidentPrototypeSlot++;
      this.transforms.reserve(slot + 1);
      this.#writeInstances(slot, item.run, item.snapshot, item.ownedRun, variantKey);
    }
    const range = this.instances.getRange(slot);
    if (range === undefined) {
      throw new Error(`Resident prototype range ${String(slot)} is unavailable`);
    }
    this.#residentPrototypeSlots.add(slot);
    const drawOrderChanged = this.#admitResidentDrawState(
      slot,
      item.group.orders[0] ?? 0,
      item.group.blendMode,
    );
    return { slot, offset: range.offset, count: range.count, drawOrderChanged };
  }

  #admitResidentDrawState(slot: number, order: number, blendMode: BLEND_MODES): boolean {
    if (this.#drawStates.has(slot)) return false;
    if (order < this.#lastAddedOrder || this.#nonZeroZStates > 0) this.#needsDrawSort = true;
    this.#lastAddedOrder = Math.max(this.#lastAddedOrder, order);
    this.#drawStates.set(
      slot,
      Object.freeze({
        slot,
        zIndex: 0,
        order,
        blendMode,
      }),
    );
    this.#drawStatesDirty = true;
    this.#drawRebuildPending = true;
    return true;
  }

  /**
   * Shared-string column: build or reuse one prototype, shareMany the rest, retain atlas keys once
   * per unique previous set.
   */
  #writeInstanceColumn(
    slots: Uint32Array,
    count: number,
    run: Readonly<PositionedRun>,
    ownedRun: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): void {
    if (count <= 0) return;
    const variantKey = this.#rasterVariantKey(run, snapshot);
    const prototype = this.#prototypeByRun.get(ownedRun)?.get(variantKey);
    const source =
      prototype !== undefined && this.instances.getRange(prototype) !== undefined
        ? prototype
        : undefined;
    if (source === undefined) {
      const first = slots[0];
      if (first === undefined) throw new Error("Content lane slot list is incomplete");
      this.#writeInstances(first, run, snapshot, ownedRun, variantKey);
      if (count === 1) return;
      if (this.instances.shareMany(first, slots, count) !== count) {
        for (let index = 1; index < count; index += 1) {
          const slot = slots[index];
          if (slot === undefined) throw new Error("Content lane slot list is incomplete");
          this.#writeInstances(slot, run, snapshot, ownedRun, variantKey);
        }
        return;
      }
      this.#bindInstanceColumn(slots, 1, count, ownedRun, variantKey, first);
      return;
    }
    if (this.instances.shareMany(source, slots, count) !== count) {
      for (let index = 0; index < count; index += 1) {
        const slot = slots[index];
        if (slot === undefined) throw new Error("Content lane slot list is incomplete");
        this.#writeInstances(slot, run, snapshot, ownedRun, variantKey);
      }
      return;
    }
    this.#bindInstanceColumn(slots, 0, count, ownedRun, variantKey, source);
  }

  #bindInstanceColumn(
    slots: Uint32Array,
    start: number,
    count: number,
    run: Readonly<PositionedRun>,
    variantKey: string,
    keySource: number,
  ): void {
    const keys = this.#slotAtlasKeys.get(keySource);
    for (let index = start; index < count; index += 1) {
      const slot = slots[index];
      if (slot === undefined) throw new Error("Content lane slot list is incomplete");
      this.#rememberPrototype(slot, run, variantKey);
    }
    if (keys !== undefined) this.#retainSlotKeysColumn(slots, start, count, keys);
    else {
      for (let index = start; index < count; index += 1) {
        const slot = slots[index];
        if (slot !== undefined && slot !== keySource) this.#releaseSlotKeys(slot);
      }
    }
  }

  #retainSlotKeysColumn(
    slots: Uint32Array,
    start: number,
    count: number,
    keys: readonly GlyphCacheKey[],
  ): void {
    let extra = 0;
    const previousSets: Array<readonly GlyphCacheKey[]> = [];
    for (let index = start; index < count; index += 1) {
      const slot = slots[index];
      if (slot === undefined) continue;
      const previous = this.#slotAtlasKeys.get(slot);
      if (previous === keys) continue;
      this.#slotAtlasKeys.set(slot, keys);
      extra += 1;
      if (previous !== undefined) previousSets.push(previous);
    }
    if (extra > 0) {
      for (const key of keys) {
        const held = this.#atlasKeyRefs.get(key) ?? 0;
        this.#atlasKeyRefs.set(key, held + extra);
        if (held === 0) this.atlas.pin(key);
      }
    }
    for (const previous of previousSets) this.#releaseKeys(previous);
  }

  #writeInstances(
    slot: number,
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
    ownedRun: Readonly<PositionedRun> = run,
    variantKey: string = this.#rasterVariantKey(run, snapshot),
  ): void {
    const runPrototype = this.#prototypeByRun.get(ownedRun)?.get(variantKey);
    const prototype =
      runPrototype !== undefined && runPrototype !== slot ? runPrototype : undefined;
    if (prototype !== undefined && this.instances.share(prototype, slot)) {
      const prototypeKeys = this.#slotAtlasKeys.get(prototype);
      if (prototypeKeys !== undefined) {
        if (this.#slotAtlasKeys.get(slot) !== prototypeKeys) {
          this.#retainSlotKeys(slot, prototypeKeys);
        }
      } else this.#releaseSlotKeys(slot);
    } else {
      const built = this.#buildInstances(slot, run, snapshot);
      this.instances.set(slot, built.batch, { skipEquality: true });
      this.#retainSlotKeys(slot, built.atlasKeys);
    }
    this.#rememberPrototype(slot, ownedRun, variantKey);
  }

  /** Pin the label's atlas entries so eviction cannot reuse rectangles live instances sample. */
  #retainSlotKeys(slot: number, keys: readonly GlyphCacheKey[]): void {
    for (const key of keys) {
      const count = this.#atlasKeyRefs.get(key) ?? 0;
      this.#atlasKeyRefs.set(key, count + 1);
      if (count === 0) this.atlas.pin(key);
    }
    const previous = this.#slotAtlasKeys.get(slot);
    this.#slotAtlasKeys.set(slot, keys);
    if (previous !== undefined) this.#releaseKeys(previous);
  }

  #releaseSlotKeys(slot: number): void {
    const keys = this.#slotAtlasKeys.get(slot);
    if (keys === undefined) return;
    this.#slotAtlasKeys.delete(slot);
    this.#releaseKeys(keys);
  }

  #releaseKeys(keys: readonly GlyphCacheKey[]): void {
    for (const key of keys) {
      const count = this.#atlasKeyRefs.get(key) ?? 0;
      if (count <= 1) {
        this.#atlasKeyRefs.delete(key);
        this.atlas.unpin(key);
      } else {
        this.#atlasKeyRefs.set(key, count - 1);
      }
    }
  }

  #rememberPrototype(slot: number, run: Readonly<PositionedRun>, variantKey: string): void {
    this.#forgetPrototype(slot);
    this.#runs.set(slot, run);
    this.#slotPrototypeVariants.set(slot, variantKey);
    let variants = this.#prototypeByRun.get(run);
    if (variants === undefined) {
      variants = new Map();
      this.#prototypeByRun.set(run, variants);
    }
    if (variants.get(variantKey) === undefined) variants.set(variantKey, slot);
  }

  #forgetPrototype(slot: number): void {
    const run = this.#runs.get(slot);
    const variantKey = this.#slotPrototypeVariants.get(slot);
    this.#slotPrototypeVariants.delete(slot);
    if (run === undefined || variantKey === undefined) return;
    const variants = this.#prototypeByRun.get(run);
    if (variants?.get(variantKey) === slot) {
      variants.delete(variantKey);
      if (variants.size === 0) this.#prototypeByRun.delete(run);
    }
  }

  #lookupIntern(snapshot: Readonly<RenderLabelSnapshot>): LayoutResult | undefined {
    this.#syncInternRevision();
    return retainInternedResult(
      this.#runsByStyle.get(snapshot.style)?.get(styleInternRequestKey(snapshot)),
    );
  }

  #storeIntern(snapshot: Readonly<RenderLabelSnapshot>, result: LayoutResult): void {
    this.#syncInternRevision();
    const stored = isPromise(result) ? result : ownedPositionedRun(result);
    let byRequest = this.#runsByStyle.get(snapshot.style);
    if (byRequest === undefined) {
      byRequest = new Map();
      this.#runsByStyle.set(snapshot.style, byRequest);
    }
    byRequest.set(styleInternRequestKey(snapshot), stored);
  }

  #syncInternRevision(): void {
    const revision = this.#registry.stats.revision;
    if (revision === this.#internRevision) return;
    this.#clearIntern();
    this.#internRevision = revision;
  }

  #clearIntern(): void {
    this.#runsByStyle = new WeakMap();
    this.#internRevision = -1;
  }

  #beginRender(): Readonly<RenderTokenScope> {
    if (this.#activeScope !== undefined) this.#discardAtlas(this.#activeScope);
    const scope = this.#nextRenderScope();
    this.#activeScope = scope;
    return scope;
  }

  #commitAtlas(scope: Readonly<RenderTokenScope>): Readonly<AtlasCommit> {
    const fresh = commitGlyphAtlasRenderFrame(this.atlas, scope);
    if (this.#activeScope !== undefined && sameRenderScope(this.#activeScope, scope)) {
      this.#activeScope = undefined;
    }
    if (atlasCommitHasChanges(fresh)) {
      for (const entry of fresh.entries) {
        const count = this.#atlasKeyRefs.get(entry.key) ?? 0;
        this.#atlasKeyRefs.set(entry.key, count + 1);
        if (count === 0) this.atlas.pin(entry.key);
        this.#pendingAtlasPins.push(entry.key);
      }
      this.#pendingAtlasCommit = mergeAtlasCommits(this.#pendingAtlasCommit, fresh);
    }
    return this.#pendingAtlasCommit ?? EMPTY_ATLAS_COMMIT;
  }

  #acceptAtlasCommit(): void {
    const pins = this.#pendingAtlasPins.splice(0);
    this.#pendingAtlasCommit = undefined;
    this.#releaseKeys(pins);
  }

  #discardAtlas(scope: Readonly<RenderTokenScope>): void {
    if (this.#activeScope !== undefined && sameRenderScope(this.#activeScope, scope)) {
      this.#activeScope = undefined;
    }
    const failure = cleanupBestEffort([
      () => {
        this.#staleGlyphResults += discardGlyphAtlasRenderFrame(this.atlas, scope);
      },
      () => this.#releaseRunLeases(scope),
    ]);
    if (failure !== undefined) throw failure.error;
  }

  #trackRunLease(scope: Readonly<RenderTokenScope>, run: Readonly<PositionedRun>): boolean {
    if (!isLeasedPositionedRun(run)) return true;
    if (this.#activeScope === undefined || !sameRenderScope(this.#activeScope, scope)) {
      releasePositionedRun(run);
      return false;
    }
    let runs = this.#runLeases.get(scope);
    if (runs === undefined) {
      runs = new Set();
      this.#runLeases.set(scope, runs);
    }
    runs.add(run);
    return true;
  }

  #releaseRunLeases(scope: Readonly<RenderTokenScope>): void {
    const runs = this.#runLeases.get(scope);
    if (runs === undefined) return;
    this.#runLeases.delete(scope);
    const failure = cleanupBestEffort(Array.from(runs, (run) => () => releasePositionedRun(run)));
    if (failure !== undefined) throw failure.error;
  }

  #nextRenderScope(): Readonly<RenderTokenScope> {
    if (this.#ticket === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Render commit ticket capacity exhausted");
    }
    this.#ticket += 1;
    return Object.freeze({
      lifecycleEpoch: this.#lifecycleEpoch,
      commitTicket: this.#ticket,
      fontRegistryRevision: this.#registry.stats.revision,
      destinationIdentity: this.#destinationIdentity,
    });
  }

  #isScopeCurrent(scope: Readonly<RenderTokenScope>): boolean {
    return (
      !this.#destroyed &&
      scope.lifecycleEpoch === this.#lifecycleEpoch &&
      scope.commitTicket === this.#ticket &&
      scope.fontRegistryRevision === this.#registry.stats.revision &&
      scope.destinationIdentity === this.#destinationIdentity
    );
  }

  #rejectRenderToken(token: Readonly<RenderToken>): void {
    const invalidatesCurrentScope = this.#isScopeCurrent(token);
    this.#staleGlyphResults += 1;
    this.#discardAtlas(token);
    if (!invalidatesCurrentScope) return;
    this.#ticket += 1;
  }

  #buildInstances(
    slot: number,
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): Readonly<BuiltGlyphInstances> {
    const glyphCount = run.glyphCount;
    this.#ensureBatchCapacity(glyphCount);
    const uniqueKeys: GlyphCacheKey[] = [];
    const seenKeys = this.#seenAtlasKeys;
    seenKeys.clear();
    let write = 0;
    for (let index = 0; index < glyphCount; index += 1) {
      if (isEmptyInkGlyph(run, index)) continue;
      const glyphId = run.glyphIds[index] ?? 0;
      const glyphText = lazyGlyphText(run, index, glyphId);
      const plan = this.#glyphRasterPlan(run, index, snapshot, glyphId);
      const identity = resolveGlyphIdentity({
        fontFamily: run.fontFamily,
        ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
        fontRevision: run.fontRevision,
        glyphId,
        glyphText,
        variationKey: plan.identityVariationKey,
        fontSize: resolveFontSize(snapshot.style.fontSize),
        fontWeight: snapshot.style.fontWeight ?? "normal",
        mode: plan.identityMode,
      });
      const key = identity.key;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueKeys.push(key);
      }
      const entry = this.atlas.get(key);
      if (entry === undefined) {
        throw new Error(`Atlas entry missing for positioned glyph: ${String(key)}`);
      }
      const outputOffset = write * 4;
      const rasterScale = entry.metrics?.rasterScale ?? 1;
      this.#batchPositions[outputOffset] =
        (run.x[index] ?? 0) + (entry.metrics?.bearingX ?? 0) - run.bounds.x;
      this.#batchPositions[outputOffset + 1] =
        (run.y[index] ?? 0) - (entry.metrics?.bearingY ?? 0) - run.bounds.y;
      this.#batchPositions[outputOffset + 2] = entry.width / rasterScale;
      this.#batchPositions[outputOffset + 3] = entry.height / rasterScale;
      this.#batchUvs[outputOffset] = entry.u0;
      this.#batchUvs[outputOffset + 1] = entry.v0;
      this.#batchUvs[outputOffset + 2] = entry.u1;
      this.#batchUvs[outputOffset + 3] = entry.v1;
      this.#batchPalette[write] = slot;
      this.#batchPages[write] = entry.layer;
      this.#batchModes[write] = modeCode(entry.mode);
      this.#batchScales[write] = rasterScale;
      write += 1;
    }
    return {
      batch: {
        positions: this.#batchPositions.subarray(0, write * 4),
        uvs: this.#batchUvs.subarray(0, write * 4),
        paletteIndices: this.#batchPalette.subarray(0, write),
        pages: this.#batchPages.subarray(0, write),
        modes: this.#batchModes.subarray(0, write),
        rasterScales: this.#batchScales.subarray(0, write),
      },
      atlasKeys: uniqueKeys,
    };
  }

  #ensureBatchCapacity(count: number): void {
    if (this.#batchPalette.length >= count) return;
    let capacity = this.#batchPalette.length === 0 ? 16 : this.#batchPalette.length;
    while (capacity < count) capacity *= 2;
    this.#batchPositions = new Float32Array(capacity * 4);
    this.#batchUvs = new Float32Array(capacity * 4);
    this.#batchPalette = new Uint32Array(capacity);
    this.#batchPages = new Uint16Array(capacity);
    this.#batchModes = new Uint8Array(capacity);
    this.#batchScales = new Float32Array(capacity);
  }

  #result(
    revision: number,
    stale: boolean,
    appliedLabels: number,
    atlasCommit: Readonly<AtlasCommit>,
    drawOrderChanged: boolean,
  ): Readonly<RenderCommitResult> {
    return Object.freeze({
      revision,
      stale,
      appliedLabels,
      glyphs: this.instances.stats.activeInstances,
      atlasUploads: atlasCommit.uploads.length + atlasCommit.externalUploads.length,
      atlasCommit,
      drawOrderChanged,
    });
  }

  #residentResult(
    appliedLabels: number,
    atlasCommit: Readonly<AtlasCommit>,
    drawOrderChanged: boolean,
    residentColumns: readonly Readonly<ResidentPrototypeColumn>[],
  ): Readonly<ResidentAdmitLaneResult> {
    return Object.freeze({
      ...this.#result(0, false, appliedLabels, atlasCommit, drawOrderChanged),
      residentColumns: Object.freeze([...residentColumns]),
    });
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("RenderCoordinator has been destroyed");
    }
  }

  #glyphMode(run: Readonly<PositionedRun>, index: number): GlyphMode {
    if (run.source === "harfbuzz") return this.#tinySdf ? "sdf" : "msdf";
    const text = resolveGlyphText(run, index);
    return /\p{Extended_Pictographic}/u.test(text) ? "color" : "alpha";
  }

  #glyphRasterPlan(
    run: Readonly<PositionedRun>,
    index: number,
    snapshot: Readonly<RenderLabelSnapshot>,
    glyphId: number,
  ): Readonly<GlyphRasterPlan> {
    const baseMode = this.#glyphMode(run, index);
    const variationKey = run.variationKey ?? "";
    const projectedHeightPx = snapshot.projectedHeightPx;
    const outline = this.#outline;
    if (
      outline === undefined ||
      run.source !== "harfbuzz" ||
      projectedHeightPx === undefined ||
      outline.route(projectedHeightPx).path !== "outline"
    ) {
      return { baseMode, identityMode: baseMode, identityVariationKey: variationKey };
    }
    const rasterPixelHeight = outline.rasterPixelHeight(projectedHeightPx);
    const fontSize = resolveFontSize(snapshot.style.fontSize);
    return {
      baseMode,
      identityMode: "color",
      identityVariationKey: encodeCacheKey([variationKey, "outline", String(rasterPixelHeight)]),
      outlineRequest: Object.freeze({
        family: run.fontFamily,
        fontRevision: run.fontRevision,
        glyphId,
        variationKey,
        fontSize,
        projectedHeightPx,
        rasterPixelHeight,
        advance: run.xAdvance[index] ?? 0,
      }),
    };
  }
}

/** @internal Resident records traverse slots directly, so slot order must equal draw order. */
export function residentAdmitLaneEligible(
  groups: readonly Readonly<ResidentAdmitLaneGroup>[],
): boolean {
  for (const group of groups) {
    if (
      group.zIndex !== 0 ||
      group.blendMode !== "normal" ||
      !Number.isSafeInteger(group.count) ||
      group.count < 0 ||
      !(group.slots instanceof Uint32Array) ||
      !(group.xy instanceof Float32Array) ||
      !(group.orders instanceof Uint32Array) ||
      group.count > group.slots.length ||
      group.count > group.orders.length ||
      group.count * 2 > group.xy.length ||
      (group.rotations !== undefined &&
        (!(group.rotations instanceof Float32Array) || group.count > group.rotations.length))
    ) {
      return false;
    }
    let previousSlot = -1;
    let previousOrder = -1;
    for (let index = 0; index < group.count; index += 1) {
      const slot = group.slots[index];
      const order = group.orders[index];
      if (slot === undefined || order === undefined) return false;
      if (slot <= previousSlot || order <= previousOrder) return false;
      previousSlot = slot;
      previousOrder = order;
    }
  }
  return true;
}

class LazyRasterGlyphProvider implements GlyphProviderLike {
  readonly #registry: FontRegistry;
  readonly #options: RasterGlyphProviderOptions | undefined;
  #pending: Promise<GlyphProviderLike> | undefined;
  #destroyed = false;

  constructor(registry: FontRegistry, options: RasterGlyphProviderOptions | undefined) {
    this.#registry = registry;
    this.#options = options;
  }

  async rasterize(request: RasterGlyphRequest): Promise<Readonly<GlyphRaster>> {
    const provider = await this.#get();
    if (this.#destroyed) throw new RasterProviderDisposedError();
    return provider.rasterize(request);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) return;
    await pending.then(
      async (provider) => provider.destroy(),
      () => undefined,
    );
  }

  #get(): Promise<GlyphProviderLike> {
    if (this.#destroyed) return Promise.reject(new RasterProviderDisposedError());
    const current = this.#pending;
    if (current !== undefined) return current;
    const pending = import("../atlas/RasterGlyphProvider").then(
      ({ RasterGlyphProvider }) => new RasterGlyphProvider(this.#registry, this.#options),
    );
    this.#pending = pending;
    void pending.catch(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });

    return pending;
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function retainInternedResult(result: LayoutResult | undefined): LayoutResult | undefined {
  if (result === undefined) return undefined;
  return isPromise(result) ? result.then((run) => retainPositionedRun(run)) : result;
}

function contentLaneSnapshot(
  text: string,
  style: Readonly<TextStyleOptions>,
  projectedHeightPx?: number,
): Readonly<RenderLabelSnapshot> {
  return {
    sourceRevision: 1,
    text,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    zIndex: 0,
    order: 0,
    blendMode: "normal",
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style,
    ...(projectedHeightPx === undefined ? {} : { projectedHeightPx }),
  };
}

function styleInternRequestKey(snapshot: Readonly<RenderLabelSnapshot>): string {
  const shaping = snapshot.shaping;
  const variations =
    shaping?.variations === undefined
      ? ""
      : encodeCacheKey(
          Object.entries(shaping.variations)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([axis, value]) => encodeCacheKey([axis, String(value)])),
        );
  return encodeCacheKey([
    snapshot.text,
    snapshot.layout?.writingMode ?? "",
    shaping?.direction ?? "",
    shaping?.language ?? "",
    shaping?.script ?? "",
    encodeCacheKey(shaping?.features ?? []),
    variations,
  ]);
}

function releaseExternalGlyphRaster(raster: Readonly<AtlasGlyphRaster>): void {
  if ("source" in raster) raster.release();
}

function atlasCommitHasChanges(commit: Readonly<AtlasCommit>): boolean {
  return (
    commit.entries.length > 0 ||
    commit.uploads.length > 0 ||
    commit.externalUploads.length > 0 ||
    commit.evictedKeys.length > 0
  );
}

function mergeAtlasCommits(
  retained: Readonly<AtlasCommit> | undefined,
  fresh: Readonly<AtlasCommit>,
): Readonly<AtlasCommit> {
  if (retained === undefined) return fresh;
  return Object.freeze({
    entries: Object.freeze([...retained.entries, ...fresh.entries]),
    uploads: Object.freeze([...retained.uploads, ...fresh.uploads]),
    externalUploads: Object.freeze([...retained.externalUploads, ...fresh.externalUploads]),
    evictedKeys: Object.freeze([...retained.evictedKeys, ...fresh.evictedKeys]),
  });
}

const MAX_RENDER_SLOT = 0x100_0000 - 1;

function assertLaneCount(name: string, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${name} count must be a non-negative safe integer`);
  }
}

function validatePackedLane(
  name: string,
  count: number,
  slots: Uint32Array,
  xy: Float32Array,
  orders?: Uint32Array,
): void {
  assertLaneCount(name, count);
  if (!(slots instanceof Uint32Array)) throw new TypeError(`${name} slots must be a Uint32Array`);
  if (!(xy instanceof Float32Array)) throw new TypeError(`${name} xy must be a Float32Array`);
  if (orders !== undefined && !(orders instanceof Uint32Array)) {
    throw new TypeError(`${name} orders must be a Uint32Array`);
  }
  if (slots.length < count) throw new TypeError(`${name} slot list is shorter than count`);
  if (xy.length < count * 2) {
    throw new TypeError(`${name} xy must contain one packed pair per slot`);
  }
  if (orders !== undefined && orders.length < count) {
    throw new TypeError(`${name} order list is shorter than count`);
  }
  for (let index = 0; index < count; index += 1) {
    const slot = slots[index];
    if (slot === undefined || slot > MAX_RENDER_SLOT) {
      throw new RangeError(`${name} slot exceeds the render capacity domain`);
    }
  }
}

function validateChanges(changes: readonly RenderChange[]): void {
  for (const change of changes) {
    if (!Number.isSafeInteger(change.slot) || change.slot < 0) {
      throw new TypeError("Render change slot must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(change.mask) || change.mask <= 0 || (change.mask & ~7) !== 0) {
      throw new TypeError("Render change mask contains unsupported domains");
    }
  }
}

/**
 * Packed default-axis identities use the font-local glyph id. Exact cluster text stays lazy until a
 * raster miss needs it; variation identities use the run's canonical axis key.
 */
function lazyGlyphText(run: Readonly<PositionedRun>, index: number, glyphId: number): string {
  return glyphId > 0 && run.source === "harfbuzz" ? "" : resolveGlyphText(run, index);
}

/**
 * Spaces, other White_Space (except Ogham U+1680, which paints), and default-ignorable scalars have
 * no 0.5 contour. Skip generation and instance quads. Trusted runs stay caller-owned. Ligatures and
 * shared-cluster marks stay, including RTL cluster order.
 */
function isEmptyInkGlyph(run: Readonly<PositionedRun>, index: number): boolean {
  if (run.source === "trusted") return false;
  const key = run.glyphKeys?.[index];
  if (key !== undefined && key.length > 0) {
    const codePoint = key.codePointAt(0);
    if (codePoint === undefined) return false;
    const units = codePoint > 0xffff ? 2 : 1;
    return key.length === units && isEmptyInkCodePoint(codePoint);
  }
  const cluster = run.clusters[index] ?? 0;
  const codePoint = run.text.codePointAt(cluster);
  if (codePoint === undefined) return false;
  const units = codePoint > 0xffff ? 2 : 1;
  const exactEnd = run.clusterEnds?.[index];
  if (exactEnd !== undefined) {
    return exactEnd === cluster + units && isEmptyInkCodePoint(codePoint);
  }
  const end = cluster + units;
  let glyphAtEnd = end >= run.text.length;
  for (let other = 0; other < run.glyphCount; other += 1) {
    if (other === index) continue;
    const otherCluster = run.clusters[other] ?? 0;
    if (otherCluster === cluster || (otherCluster > cluster && otherCluster < end)) {
      return false;
    }
    if (otherCluster === end) glyphAtEnd = true;
  }
  if (!glyphAtEnd && end < run.text.length) return false;
  return isEmptyInkCodePoint(codePoint);
}

const EMPTY_INK_RE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

function isEmptyInkCodePoint(codePoint: number): boolean {
  if (codePoint === 0x1680) return false;
  if (codePoint < 0x80) {
    return (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      codePoint === 0x0d ||
      codePoint === 0x20
    );
  }
  return EMPTY_INK_RE.test(String.fromCodePoint(codePoint));
}

function resolveGlyphText(run: Readonly<PositionedRun>, index: number): string {
  const key = run.glyphKeys?.[index];
  if (key !== undefined && key.length > 0) return key;
  const cluster = run.clusters[index] ?? 0;
  const clusterEnd = run.clusterEnds?.[index];
  if (clusterEnd !== undefined && clusterEnd > cluster && clusterEnd <= run.text.length) {
    return run.text.slice(cluster, clusterEnd);
  }
  const suffix = run.text.slice(cluster);
  return Array.from(suffix)[0] ?? "�";
}

function resolveFontSize(value: number | string | undefined): number {
  const resolved = typeof value === "number" ? value : Number.parseFloat(value ?? "26");
  return Number.isFinite(resolved) && resolved > 0 ? resolved : 26;
}

function modeCode(mode: GlyphMode): number {
  if (mode === "msdf") return 0;
  if (mode === "sdf") return 1;
  if (mode === "alpha") return 2;
  return 3;
}
