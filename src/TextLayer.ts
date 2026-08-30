import {
  Container,
  Matrix,
  type DestroyOptions,
  type Renderer,
  type TextStyleOptions,
} from "pixi.js";

import {
  aabbVisible,
  createOffscreenAdmitBudget,
  cullRecordMatchesLocal,
  cullResidency,
  cullViewportsEqual,
  DEFAULT_OFFSCREEN_ADMIT_BUDGET_BYTES,
  expandPrepareRing,
  expandWorkingSet,
  CULL_RECORD_STRIDE,
  gpuOwnsCullBoxes,
  planBudgetedOffscreenAdmissionWindow,
  planOffscreenAdmissionWindow,
  shouldDropSubpixelLod,
  shouldInstanceUnshaped,
  shouldPatchComputeCullLane,
  shouldQueryPrepareRing,
  shouldRefreshResidency,
  tryAdmitOffscreen,
  viewportFromBounds,
  workingSetContains,
  writeCullRecordAt,
  type CullAabbSpace,
  type CullPath,
  type CullRecordDirty,
  type CullViewport,
  type OffscreenAdmitBudget,
  type OffscreenAdmissionCursor,
} from "./culling/computeCull";
import {
  LABEL_COLLISION_RECORD_STRIDE,
  LabelCollisionSelector,
  projectLabelCollisionAabb,
  writeLabelCollisionRecordAt,
  type LabelCollisionRecordInput,
} from "./culling/labelCollision";
import { SpatialIndex } from "./culling/SpatialIndex";
import type {
  BoundsData,
  MutableBoundsData,
  MutableLabelCollisionAabb,
  PointLike,
  ScreenTransform,
} from "./culling/types";
import { FontRegistry } from "./FontRegistry";
import { createControlledTeardown, type ControlledTeardown } from "./lifecycle/ControlledTeardown";
import { cleanupBestEffort, type CleanupFailure } from "./render/cleanup";
import { GpuResidentScene } from "./render/GpuResidentScene";
import {
  GPU_SCENE_MAX_PAINTS,
  GPU_SCENE_MAX_PROTOTYPES,
  GpuSceneCompiler,
} from "./render/GpuSceneCompiler";
import {
  PALETTE_MOVE_STRIDE,
  packPaletteMoves,
  shouldWriteCpuPalettePositions,
  type PalettePath,
} from "./render/paletteStorage";
import {
  createLayerRenderCoordinator,
  RenderCoordinator,
  type AdmitLaneGroup,
  type ResidentAdmitLaneGroup,
  type ResidentAdmitLaneResult,
  type RenderChange,
  type RenderCommitResult,
  type RenderDrawState,
  type RenderLabelSnapshot,
} from "./render/RenderCoordinator";
import {
  RenderSurface,
  type RenderComputeCullUpdate,
  type SubmittedGlyphsDiagnostic,
} from "./render/RenderSurface";
import type { DirtyByteRange } from "./render/types";
import {
  assertTrustedGlyphRunOwner,
  createTrustedGlyphRun,
  type TrustedGlyphRun,
  type TrustedGlyphRunInput,
} from "./shaping/TrustedGlyphRun";
import { assertBlendMode } from "./store/blendModes";
import { TextStore, type TextStoreResidentPositionUpdates } from "./store/TextStore";
import {
  TextDirty,
  type TextDirtyMask,
  type MutableTextStoreLabel,
  type TextStoreLabelPatch,
  type TextStoreSnapshot,
} from "./store/types";
import type {
  TextGroupId,
  TextId,
  TextCompactionResult,
  TextLabelPatch,
  TextLabelSnapshot,
  TextLabelSpec,
  TextLayoutOptions,
  TextLayerOptions,
  TextLayerCullingOptions,
  TextLayerCollisionOptions,
  TextLayerResidency,
  TextLayerResidencyFallbackReason,
  TextLayerRenderingOptions,
  TextLayerStats,
  TextRevision,
  TextShapingOptions,
  TextUpdate,
} from "./types";

const EMPTY_STYLE: Readonly<TextStyleOptions> = Object.freeze({});
const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;
const FULL_CULL_VIEWPORT: CullViewport = Object.freeze({
  x: -1e9,
  y: -1e9,
  width: 2e9,
  height: 2e9,
  padding: 0,
});
export const TEXT_LAYER_COMMIT_EVENT = "glyphflow:commit";

interface TextGroupState {
  visible: boolean;
  readonly members: Set<TextId>;
}

interface LayerRenderChange extends RenderChange {
  readonly labelId?: TextId;
}

interface GpuResidentCommitPlan {
  readonly setup: boolean;
  readonly appendGroups?: readonly ResidentAdmitLaneGroup[];
  readonly moveBatch?: Readonly<TextStoreResidentPositionUpdates>;
  readonly moveSlots?: Uint32Array;
  readonly moveXy?: Float32Array;
  readonly removeSlots?: Uint32Array;
  readonly viewport: CullViewport;
}

interface DetachedRendererResources {
  readonly residentScene: GpuResidentScene | undefined;
  readonly surface: RenderSurface | undefined;
  readonly coordinator: RenderCoordinator | undefined;
  readonly pendingRenderResult: RenderCommitResult | undefined;
}

type MutableScreenTransform = {
  -readonly [Key in keyof ScreenTransform]: ScreenTransform[Key];
};

type MutableCollisionRecord = {
  -readonly [Key in keyof LabelCollisionRecordInput]: LabelCollisionRecordInput[Key];
};

/**
 * Dense, revisioned text state and the PixiJS scene-object seam for glyph rendering.
 *
 * Label mutations remain synchronous. {@link commit} publishes accepted work through one monotonic
 * revision and provides the async boundary used by shaping, atlas, and upload stages.
 */
export class TextLayer extends Container {
  readonly fonts: FontRegistry = new FontRegistry();
  readonly #store: TextStore;
  readonly #spatial: SpatialIndex;
  readonly #trustedRuns = new Map<TextId, TrustedGlyphRun>();
  readonly #shaping = new Map<TextId, Readonly<TextShapingOptions>>();
  readonly #layouts = new Map<TextId, Readonly<TextLayoutOptions>>();
  readonly #groups = new Map<TextGroupId, TextGroupState>();
  readonly #labelGroups = new Map<TextId, TextGroupId>();
  #revision = 0;
  #pendingMutations = 0;
  #acceptedMutations = 0;
  #commits = 0;
  #lastCommitDurationMs = 0;
  #lastCommitDirtyLabels = 0;
  #lastCommitContentLabels = 0;
  #lastCommitTransformLabels = 0;
  #lastCommitStyleLabels = 0;
  #lastLayoutMs = 0;
  #lastInstanceWriteMs = 0;
  #lastPaletteWriteMs = 0;
  #lastSpatialUpdateMs = 0;
  #lastUploadMs = 0;
  #lastVisibilitySelectionMs = 0;
  #lastRenderPreparationMs = 0;
  #lastRenderCoordinatorMs = 0;
  #lastSurfaceApplyMs = 0;
  #renderer: Renderer | undefined;
  readonly #renderingOptions: false | TextLayerRenderingOptions;
  #renderCoordinator: RenderCoordinator | undefined;
  #renderSurface: RenderSurface | undefined;
  #pendingRenderResult: RenderCommitResult | undefined;
  #gpuResidentScene: GpuResidentScene | undefined;
  #gpuSceneCompiler: GpuSceneCompiler | undefined;
  #gpuResidentPlannedRecordCount = 0;
  #gpuResidentEpoch = 0;
  #renderLifecycleEpoch = 0;
  #destroyStarted = false;
  readonly #teardown = createControlledTeardown();
  #rendererRelease: Promise<void> = Promise.resolve();
  #renderTail: Promise<void> = Promise.resolve();
  #lastCommitPromise: Promise<TextRevision> = Promise.resolve(0 as TextRevision);
  readonly #cullingEnabled: boolean;
  readonly #cullingPadding: number;
  readonly #computeCull: boolean | "auto";
  readonly #residencyRequested: TextLayerResidency;
  #residencyActive: TextLayerResidency = "viewport";
  #residencyFallbackReason: TextLayerResidencyFallbackReason | undefined;
  #gpuResidentLabels = 0;
  #gpuScenePrototypeCount = 0;
  #gpuScenePaintCount = 0;
  #lastSceneSetupMs = 0;
  readonly #lod: boolean;
  readonly #offscreenAdmitBudgetBytes: number;
  readonly #collisionEnabled: boolean;
  #collisionSelector: LabelCollisionSelector | undefined;
  #priorities: Float32Array | undefined;
  #collisionRecords = new ArrayBuffer(0);
  #collisionRecordFloats = new Float32Array(0);
  #collisionRecordUints = new Uint32Array(0);
  #collisionRecordValid = new Uint8Array(0);
  #collisionCandidateCount = 0;
  #collisionVisibleLabelCount = 0;
  #collisionCulledLabelCount = 0;
  #densityCulledLabelCount = 0;
  #collisionSelectionHash = 0;
  #lastCollisionMs = 0;
  #collisionCandidatesRanked = true;
  #collisionRankedHighSlot = -1;
  #collisionRankedLastPriority = Number.POSITIVE_INFINITY;
  #collisionTransformInitialized = false;
  readonly #collisionTransform: MutableScreenTransform = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: 0,
    ty: 0,
  };
  readonly #collisionAabbScratch: MutableLabelCollisionAabb = {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  };
  readonly #collisionRecordScratch: MutableCollisionRecord = {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    priority: 0,
    zIndex: 0,
    order: 0,
    slot: 0,
  };
  #lodWorldScaleY = 1;
  #outlineWorldScaleY = 1;
  #viewportBounds: Readonly<BoundsData> | undefined;
  #instancedViewport: CullViewport | undefined;
  #viewDirty = false;
  #visibilityDirty = true;
  #dirtyMasks: Uint8Array;
  #positionOnly: Uint8Array;
  #dirtySlots: Uint32Array;
  #bulkSlots: Uint32Array;
  #dirtyLength = 0;
  #visibleSlots: Uint32Array;
  #visibleMember: Uint8Array;
  #visibleCount = 0;
  #renderedEpochs: Uint32Array;
  #renderEpoch = 0;
  #renderSequence = 0;
  #cullRecords = new ArrayBuffer(0);
  #cullRecordFloats = new Float32Array(0);
  #cullRecordUints = new Uint32Array(0);
  #cullRecordSlots = new Uint32Array(0);
  #cullRecordIndex: Int32Array;
  #cullRecordCount = 0;
  #cullRecordEpoch = -1;
  #cullRecordSpace: CullAabbSpace = "world";
  readonly #cullRecordDirtyScratch: DirtyByteRange[] = [];
  #preparedRing: CullViewport | undefined;
  #offscreenAdmitDeferred = false;
  #offscreenAdmitGeneration = 0;
  #offscreenAdmitCursor: OffscreenAdmissionCursor | undefined;
  #offscreenAdmitRing: CullViewport | undefined;
  #offscreenAdmitRevision = -1;
  #offscreenAdmitCursorResets = 0;
  #offscreenAdmitCycles = 0;
  #lastOffscreenInspectedLabels = 0;
  #lastOffscreenMaterializedLabels = 0;
  #laneSlots: Uint32Array;
  #contentSlots: Uint32Array;
  #moveCommands = new ArrayBuffer(0);
  #boundOriginX: Float32Array | undefined;
  readonly #boundsScratch: MutableBoundsData = { x: 0, y: 0, width: 0, height: 0 };
  // Broadcast mutations reuse one text/style reference across the batch; estimating once
  // per identity pair removes an O(text) scan per label from bulk intake.
  #estimateTextRef: string | undefined;
  #estimateStyleRef: unknown;
  readonly #estimateScratch: MutableBoundsData = { x: 0, y: 0, width: 0, height: 0 };
  readonly #matrixScratch = new Matrix();
  readonly #labelScratch: MutableTextStoreLabel = {
    text: "",
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    zIndex: 0,
    blendMode: "normal",
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style: EMPTY_STYLE,
  };

  constructor(options: TextLayerOptions = {}) {
    super();
    this.#store =
      options.initialCapacity === undefined
        ? new TextStore()
        : new TextStore({ initialCapacity: options.initialCapacity });
    const culling = resolveCullingOptions(options.culling);
    this.#spatial = new SpatialIndex({ initialCapacity: this.#store.capacity });
    this.#cullingEnabled = culling.enabled;
    this.#cullingPadding = culling.padding;
    this.#computeCull = culling.computeCull;
    this.#residencyRequested = culling.residency;
    this.#lod = culling.lod;
    this.#offscreenAdmitBudgetBytes = culling.offscreenAdmitBudgetBytes;
    this.#collisionEnabled = culling.collision !== undefined;
    this.#collisionSelector =
      culling.collision === undefined
        ? undefined
        : new LabelCollisionSelector({ ...culling.collision, validateRecords: false });
    if (this.#collisionEnabled) this.#priorities = new Float32Array(this.#store.capacity);
    this.#viewportBounds = culling.bounds;
    this.#dirtyMasks = new Uint8Array(this.#store.capacity);
    this.#positionOnly = new Uint8Array(this.#store.capacity);
    this.#dirtySlots = new Uint32Array(this.#store.capacity);
    this.#bulkSlots = new Uint32Array(this.#store.capacity);
    this.#laneSlots = new Uint32Array(this.#store.capacity);
    this.#contentSlots = new Uint32Array(this.#store.capacity);
    this.#syncSpatialOrigins();
    this.#visibleSlots = new Uint32Array(this.#store.capacity);
    this.#visibleMember = new Uint8Array(this.#store.capacity);
    this.#renderedEpochs = new Uint32Array(this.#store.capacity);
    this.#cullRecordIndex = new Int32Array(this.#store.capacity).fill(-1);
    this.#renderer = undefined;
    this.#renderingOptions = options.rendering ?? {};
    if (options.renderer !== undefined) {
      this.#activateRendering(options.renderer);
    } else {
      this.#refreshResidencyCapability();
    }
  }

  /** Create one collision-free group identity owned by this layer. */
  createGroup(): TextGroupId {
    this.#assertActive();
    const group = Symbol("pixi-glyphflow TextGroup") as TextGroupId;
    this.#groups.set(group, { visible: true, members: new Set() });

    return group;
  }

  /** Check whether a group identity currently belongs to this layer. */
  hasGroup(group: TextGroupId): boolean {
    this.#assertActive();
    return this.#groups.has(group);
  }

  /** Set one group visibility mask and return the effective label change count. */
  setGroupVisible(group: TextGroupId, visible: boolean): number {
    this.#assertActive();
    if (typeof visible !== "boolean") {
      throw new TypeError("Group visibility must be a boolean");
    }
    const state = this.#requireGroup(group);
    if (state.visible === visible) return 0;
    state.visible = visible;

    let changed = 0;
    for (const id of state.members) {
      const slot = this.#store.slotOf(id);
      if (slot === undefined) continue;
      if (!this.#store.copyBoundsLabelAt(slot, this.#labelScratch)) continue;
      if (!this.#labelScratch.visible) continue;
      this.#store.markDirty(id, TextDirty.Transform);
      this.#spatial.setVisible(slot, visible);
      changed += 1;
    }
    if (changed > 0) this.#visibilityDirty = true;
    this.#recordMutation(TextDirty.Transform, changed);

    return changed;
  }

  /** Retire one group identity while retaining and detaching its labels. */
  removeGroup(group: TextGroupId): boolean {
    this.#assertActive();
    const state = this.#groups.get(group);
    if (state === undefined) return false;

    let changed = 0;
    for (const id of state.members) {
      this.#labelGroups.delete(id);
      if (state.visible) continue;
      const slot = this.#store.slotOf(id);
      if (slot === undefined) continue;
      if (!this.#store.copyBoundsLabelAt(slot, this.#labelScratch)) continue;
      if (!this.#labelScratch.visible) continue;
      this.#store.markDirty(id, TextDirty.Transform);
      this.#spatial.setVisible(slot, true);
      changed += 1;
    }
    this.#groups.delete(group);
    if (changed > 0) this.#visibilityDirty = true;
    this.#recordMutation(TextDirty.Transform, changed);

    return true;
  }

  /** Create one label and return its layer-local identity. */
  create(spec: TextLabelSpec): TextId {
    this.#assertActive();
    assertLabelSpec(spec);
    if (spec.group !== undefined) this.#requireGroup(spec.group);
    const layout = normalizeLayoutOptions(spec.layout);
    const shaping = normalizeShapingOptions(spec.shaping);
    const label = normalizeLabel(spec, this.#labelScratch);
    const id = this.#store.create(label);
    this.#syncSpatialOrigins();
    this.#initializePriority(id, spec.priority ?? 0);
    if (spec.group !== undefined) this.#associateGroup(id, spec.group);
    if (layout !== undefined) this.#layouts.set(id, layout);
    if (shaping !== undefined) this.#shaping.set(id, shaping);
    this.#indexLabel(id, label);
    if (this.#renderCoordinator === undefined) this.#visibilityDirty = true;
    this.#recordMutation(ALL_DIRTY, 1);

    return id;
  }

  /** Create a validated batch and return identities in input order. */
  createMany(specs: readonly TextLabelSpec[]): TextId[] {
    this.#assertActive();
    for (const spec of specs) {
      assertLabelSpec(spec);
      if (spec.group !== undefined) this.#requireGroup(spec.group);
    }
    const layouts = specs.map((spec) => normalizeLayoutOptions(spec.layout));
    const shapings = specs.map((spec) => normalizeShapingOptions(spec.shaping));
    this.#store.reserve(specs.length);
    this.#syncSpatialOrigins();
    this.#spatial.reserve(this.#store.capacity);

    const ids: TextId[] = [];
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      if (spec === undefined) throw new TypeError(`Missing label at index ${String(index)}`);
      const label = normalizeLabel(spec, this.#labelScratch);
      const id = this.#store.create(label);
      ids.push(id);
      this.#initializePriority(id, spec.priority ?? 0);
      if (spec.group !== undefined) this.#associateGroup(id, spec.group);
      const layout = layouts[index];
      if (layout !== undefined) this.#layouts.set(id, layout);
      const shaping = shapings[index];
      if (shaping !== undefined) this.#shaping.set(id, shaping);
      this.#indexLabel(id, label);
    }
    if (ids.length > 0 && this.#renderCoordinator === undefined) this.#visibilityDirty = true;
    this.#recordMutation(ALL_DIRTY, ids.length);

    return ids;
  }

  /** Return an immutable snapshot for a current identity. */
  get(id: TextId): Readonly<TextLabelSnapshot> | undefined {
    this.#assertActive();
    const snapshot = this.#store.get(id);
    if (snapshot === undefined) {
      return undefined;
    }

    const shaping = this.#shaping.get(id);
    const layout = this.#layouts.get(id);
    const group = this.#labelGroups.get(id);
    return Object.freeze({
      id: snapshot.id,
      sourceRevision: snapshot.sourceRevision,
      text: snapshot.text,
      x: snapshot.x,
      y: snapshot.y,
      scaleX: snapshot.scaleX,
      scaleY: snapshot.scaleY,
      rotation: snapshot.rotation,
      zIndex: snapshot.zIndex,
      priority: this.#priorityOf(id),
      blendMode: snapshot.blendMode,
      alpha: snapshot.alpha,
      visible: snapshot.visible,
      effectiveVisible: this.#isEffectivelyVisible(id, snapshot.visible),
      ...(group === undefined ? {} : { group }),
      anchor: Object.freeze({ x: snapshot.anchorX, y: snapshot.anchorY }),
      style: snapshot.style,
      ...(layout === undefined ? {} : { layout }),
      ...(shaping === undefined ? {} : { shaping }),
    });
  }

  /** Check whether an identity currently belongs to this layer. */
  has(id: TextId): boolean {
    this.#assertActive();
    return this.#store.has(id);
  }

  /** Apply one partial mutation and report whether state changed. */
  update(id: TextId, patch: TextLabelPatch): boolean {
    this.#assertActive();
    assertLabelPatch(patch);
    const groupPatch = normalizeGroupPatch(patch);
    if (groupPatch !== undefined && groupPatch !== null) this.#requireGroup(groupPatch);
    const nextGroup = groupPatch === null ? undefined : groupPatch;
    const groupChanged = groupPatch !== undefined && this.#labelGroups.get(id) !== nextGroup;
    const layoutPatch = normalizeLayoutPatch(patch);
    const nextLayout = layoutPatch === null ? undefined : layoutPatch;
    const layoutChanged =
      layoutPatch !== undefined && !equalLayout(this.#layouts.get(id), nextLayout);
    const shapingPatch = normalizeShapingPatch(patch);
    const nextShaping = shapingPatch === null ? undefined : shapingPatch;
    const shapingChanged =
      shapingPatch !== undefined && !equalShaping(this.#shaping.get(id), nextShaping);
    let dirty = this.#store.update(id, normalizePatch(patch));
    const priorityChanged = patch.priority !== undefined && this.#setPriority(id, patch.priority);
    if (priorityChanged) {
      this.#store.markDirty(id, TextDirty.Transform);
      dirty |= TextDirty.Transform;
    }
    if (groupChanged) {
      this.#moveGroup(id, nextGroup);
      this.#store.markDirty(id, TextDirty.Transform);
      dirty |= TextDirty.Transform;
    }
    if (layoutChanged || shapingChanged) {
      if ((dirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
        this.#store.markDirty(id, TextDirty.Style);
      } else {
        this.#store.markSourceDirty(id, TextDirty.Style);
      }
      if (layoutChanged) {
        if (nextLayout === undefined) this.#layouts.delete(id);
        else this.#layouts.set(id, nextLayout);
      }
      if (shapingChanged) {
        if (nextShaping === undefined) this.#shaping.delete(id);
        else this.#shaping.set(id, nextShaping);
      }
      dirty |= TextDirty.Style;
    }
    if (dirty !== TextDirty.None) {
      const snapshot = this.#store.get(id);
      if (snapshot === undefined) throw new Error("Updated label disappeared from its store");
      this.#indexLabel(id, snapshot);
      if (patch.visible !== undefined || groupChanged) this.#visibilityDirty = true;
    }
    if ((dirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
      this.#trustedRuns.delete(id);
    }
    this.#recordMutation(dirty, dirty === TextDirty.None ? 0 : 1);

    return dirty !== TextDirty.None;
  }

  /** Compatibility alias for the 0.0.x mutation name. */
  updateLabel(id: TextId, patch: TextLabelPatch): boolean {
    return this.update(id, patch);
  }

  /** Apply a validated mutation batch and return the number of changed entries. */
  updateMany(entries: readonly TextUpdate[]): number {
    this.#assertActive();
    if (this.#bulkSlots.length < entries.length) {
      this.#bulkSlots = growTypedArray(this.#bulkSlots, nextPowerOfTwo(entries.length));
    }
    const layoutPatches: NormalizedLayoutPatch[] = [];
    const shapingPatches: NormalizedShapingPatch[] = [];
    const groupPatches: NormalizedGroupPatch[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) throw new TypeError(`Missing update at index ${String(index)}`);
      const slot = this.#store.slotOf(entry.id);
      if (slot === undefined) {
        throw new RangeError(`Unknown or stale TextId: ${String(entry.id)}`);
      }
      assertLabelPatch(entry.patch);
      layoutPatches[index] = normalizeLayoutPatch(entry.patch);
      shapingPatches[index] = normalizeShapingPatch(entry.patch);
      const groupPatch = normalizeGroupPatch(entry.patch);
      if (groupPatch !== undefined && groupPatch !== null) this.#requireGroup(groupPatch);
      groupPatches[index] = groupPatch;
      this.#bulkSlots[index] = slot;
    }

    let changed = 0;
    let dirty = TextDirty.None as TextDirtyMask;
    const hasTrustedRuns = this.#trustedRuns.size > 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const slot = this.#bulkSlots[index];
      if (entry === undefined || slot === undefined) {
        throw new Error(`Validated update is unavailable at index ${String(index)}`);
      }
      let entryDirty = this.#store.updateAt(slot, normalizePatch(entry.patch));
      const priorityChanged =
        entry.patch.priority !== undefined && this.#setPriorityAt(slot, entry.patch.priority);
      if (priorityChanged) {
        this.#store.markDirty(entry.id, TextDirty.Transform);
        entryDirty |= TextDirty.Transform;
      }
      const groupPatch = groupPatches[index];
      const nextGroup = groupPatch === null ? undefined : groupPatch;
      const groupChanged =
        groupPatch !== undefined && this.#labelGroups.get(entry.id) !== nextGroup;
      if (groupChanged) {
        this.#moveGroup(entry.id, nextGroup);
        this.#store.markDirty(entry.id, TextDirty.Transform);
        entryDirty |= TextDirty.Transform;
      }
      const layoutPatch = layoutPatches[index];
      const nextLayout = layoutPatch === null ? undefined : layoutPatch;
      const layoutChanged =
        layoutPatch !== undefined && !equalLayout(this.#layouts.get(entry.id), nextLayout);
      const shapingPatch = shapingPatches[index];
      const nextShaping = shapingPatch === null ? undefined : shapingPatch;
      const shapingChanged =
        shapingPatch !== undefined && !equalShaping(this.#shaping.get(entry.id), nextShaping);
      if (layoutChanged || shapingChanged) {
        if ((entryDirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
          this.#store.markDirty(entry.id, TextDirty.Style);
        } else {
          this.#store.markSourceDirty(entry.id, TextDirty.Style);
        }
        if (layoutChanged) {
          if (nextLayout === undefined) this.#layouts.delete(entry.id);
          else this.#layouts.set(entry.id, nextLayout);
        }
        if (shapingChanged) {
          if (nextShaping === undefined) this.#shaping.delete(entry.id);
          else this.#shaping.set(entry.id, nextShaping);
        }
        entryDirty |= TextDirty.Style;
      }
      if (entryDirty !== TextDirty.None) {
        changed += 1;
        dirty |= entryDirty;
        if (hasTrustedRuns && (entryDirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
          this.#trustedRuns.delete(entry.id);
        }
        if (!this.#store.copyBoundsLabelAt(slot, this.#labelScratch)) {
          throw new Error("Updated label disappeared from its store");
        }
        this.#reindexCurrentSlot(slot, entry.id, this.#labelScratch);
        if (entry.patch.visible !== undefined || groupChanged) this.#visibilityDirty = true;
      }
    }
    this.#recordMutation(dirty, changed);

    return changed;
  }

  /** Show every current label and return the number whose visibility changed. */
  showAll(): number {
    return this.#setAllVisible(true);
  }

  /** Hide every current label and return the number whose visibility changed. */
  hideAll(): number {
    return this.#setAllVisible(false);
  }

  /** Apply packed x/y coordinates and return the number of changed labels. */
  updatePositions(
    ids: readonly TextId[] | Float64Array,
    positions: Float32Array | Float64Array,
  ): number {
    this.#assertActive();
    this.#syncSpatialOrigins();
    const residentScene =
      this.#residencyActive === "gpu-scene" ? this.#gpuResidentScene : undefined;
    let changed: number;
    if (residentScene === undefined) {
      changed = this.#store.updatePositions(ids, positions, (slot) => {
        this.#spatial.rehashCurrent(slot);
        this.#invalidateCollisionRecord(slot);
      });
    } else {
      changed = this.#store.updatePositions(
        ids,
        positions,
        undefined,
        true,
        // Reserve against the full validated input so the post-apply batch only writes.
        (_slots, count) => {
          this.#spatial.reserveDeferredRehash(count);
          residentScene.reservePositionNotes(count);
        },
        (slots, count) => {
          this.#spatial.deferRehashMany(slots, count);
          residentScene.notePositions(slots, count);
          if (this.#collisionEnabled) this.#invalidateCollisionRecords(slots, count);
        },
      );
    }
    this.#recordMutation(TextDirty.Transform, changed);

    return changed;
  }

  /** Apply broadcast or per-label text plus packed x/y columns in one transactional pass. */
  updateTextPositions(
    ids: readonly TextId[] | Float64Array,
    texts: string | readonly string[],
    positions: Float32Array | Float64Array,
  ): number {
    this.#assertActive();
    this.#syncSpatialOrigins();
    const hasTrustedRuns = this.#trustedRuns.size > 0;
    const result = this.#store.updateTextPositions(
      ids,
      texts,
      positions,
      (slot, index, contentChanged) => {
        if (contentChanged && hasTrustedRuns) {
          const id = ids[index];
          if (id !== undefined) this.#trustedRuns.delete(id as TextId);
        }
        const id = ids[index];
        if (id === undefined) throw new Error("Updated label identity is unavailable");
        // Same text: local box stays. The store origin already moved, so only rebucket.
        if (!contentChanged) {
          if (this.#residencyActive === "gpu-scene") this.#spatial.deferRehashCurrent(slot);
          else this.#spatial.rehashCurrent(slot);
          this.#invalidateCollisionRecord(slot);
          return;
        }
        this.#invalidateCollisionRecord(slot);
        // Rendered unit-transform labels get run bounds at commit (content lane or
        // object path). Skip the estimate rehash so a content storm is one spatial walk.
        if (
          this.#renderCoordinator === undefined ||
          this.#renderedEpochs[slot] === 0 ||
          !this.#store.anchorsZeroAt(slot) ||
          !this.#store.unitTransformAt(slot)
        ) {
          if (!this.#store.copyBoundsLabelAt(slot, this.#labelScratch)) {
            throw new Error("Updated label disappeared from its store");
          }
          this.#reindexCurrentSlot(slot, id as TextId, this.#labelScratch);
        }
      },
    );
    this.#recordMutation(result.mask, result.changed);

    return result.changed;
  }

  /** Remove one label and report whether it existed. */
  remove(id: TextId): boolean {
    this.#assertActive();
    const slot = this.#store.slotOf(id);
    const removed = this.#store.remove(id);
    if (removed) {
      if (slot === undefined) throw new Error("Removed label slot is unavailable");
      this.#spatial.remove(slot);
      this.#invalidateCollisionRecord(slot);
      if (this.#priorities !== undefined) this.#priorities[slot] = 0;
      this.#trustedRuns.delete(id);
      this.#layouts.delete(id);
      this.#shaping.delete(id);
      this.#detachGroup(id);
      this.#visibilityDirty = true;
    }
    this.#recordMutation(ALL_DIRTY, Number(removed));

    return removed;
  }

  /** Remove current identities and return the removal count. */
  removeMany(ids: readonly TextId[] | Float64Array): number {
    this.#assertActive();
    let removed = 0;
    for (const id of ids) {
      const currentId = id as TextId;
      const slot = this.#store.slotOf(currentId);
      if (this.#store.remove(currentId)) {
        if (slot === undefined) throw new Error("Removed label slot is unavailable");
        this.#spatial.remove(slot);
        this.#invalidateCollisionRecord(slot);
        if (this.#priorities !== undefined) this.#priorities[slot] = 0;
        this.#trustedRuns.delete(currentId);
        this.#layouts.delete(currentId);
        this.#shaping.delete(currentId);
        this.#detachGroup(currentId);
        removed += 1;
      }
    }
    if (removed > 0) this.#visibilityDirty = true;
    this.#recordMutation(ALL_DIRTY, removed);

    return removed;
  }

  /** Remove every label and return the previous label count. */
  clear(): number {
    this.#assertActive();
    const removed = this.#store.size;
    this.#labelGroups.clear();
    for (const state of this.#groups.values()) state.members.clear();
    if (removed > 0) {
      this.#store.clear();
      this.#spatial.clear();
      this.#trustedRuns.clear();
      this.#layouts.clear();
      this.#shaping.clear();
      this.#priorities?.fill(0);
      this.#collisionRecordValid.fill(0);
      this.#collisionSelector?.invalidateRunCache();
      this.#visibilityDirty = true;
      this.#recordMutation(ALL_DIRTY, removed);
    }
    this.#collisionCandidatesRanked = true;
    this.#collisionRankedHighSlot = -1;
    this.#collisionRankedLastPriority = Number.POSITIVE_INFINITY;

    return removed;
  }

  /** Shrink unused reserved CPU capacity while preserving every current identity. */
  compact(): Readonly<TextCompactionResult> {
    this.#assertActive();
    if (this.#gpuResidentScene !== undefined) {
      this.#deactivateGpuResidentScene("unsupported-scene");
      this.#refreshResidencyCapability();
    }
    const result = this.#store.compact();
    if (this.#priorities !== undefined && this.#priorities.length > result.afterCapacity) {
      this.#priorities = this.#priorities.slice(0, result.afterCapacity);
    }
    const collisionBytes = result.afterCapacity * LABEL_COLLISION_RECORD_STRIDE;
    if (this.#collisionRecords.byteLength > collisionBytes) {
      this.#collisionRecords = this.#collisionRecords.slice(0, collisionBytes);
      this.#collisionRecordFloats = new Float32Array(this.#collisionRecords);
      this.#collisionRecordUints = new Uint32Array(this.#collisionRecords);
      this.#collisionRecordValid = this.#collisionRecordValid.slice(0, result.afterCapacity);
      this.#collisionSelector?.invalidateRunCache();
    }
    this.#syncSpatialOrigins();
    return result;
  }

  /** Stamp a caller-validated positioned run with this layer and the label source revision. */
  createTrustedRun(id: TextId, input: TrustedGlyphRunInput): TrustedGlyphRun {
    this.#assertActive();
    const snapshot = this.#store.get(id);
    if (snapshot === undefined) {
      throw new RangeError(`Unknown or stale TextId: ${String(id)}`);
    }
    this.#assertTrustedRunSource(snapshot, input);

    return createTrustedGlyphRun(this, snapshot.sourceRevision, input);
  }

  /** Adopt a trusted run by reference and schedule its glyph content for the next commit. */
  adoptRun(id: TextId, run: TrustedGlyphRun): boolean {
    this.#assertActive();
    assertTrustedGlyphRunOwner(this, run);
    const snapshot = this.#store.get(id);
    if (snapshot === undefined) {
      throw new RangeError(`Unknown or stale TextId: ${String(id)}`);
    }
    this.#assertTrustedRunSource(snapshot, run);
    if (run.sourceRevision !== snapshot.sourceRevision) {
      throw new RangeError(
        `Trusted glyph run source revision ${String(run.sourceRevision)} is stale; current revision is ${String(snapshot.sourceRevision)}`,
      );
    }
    if (this.#trustedRuns.get(id) === run) {
      return false;
    }

    this.#trustedRuns.set(id, run);
    this.#indexLabel(id, snapshot, run.bounds);
    this.#store.markDirty(id, TextDirty.Content);
    this.#recordMutation(TextDirty.Content, 1);

    return true;
  }

  /** Return the currently adopted trusted run for a label. */
  getTrustedRun(id: TextId): TrustedGlyphRun | undefined {
    this.#assertActive();
    if (!this.#store.has(id)) {
      return undefined;
    }

    return this.#trustedRuns.get(id);
  }

  /** Set the layer-local viewport used by dense culling and schedule one visibility refresh. */
  setViewportBounds(bounds: BoundsData | undefined): void {
    this.#assertActive();
    if (bounds !== undefined) assertBoundsData(bounds);
    if (equalBounds(this.#viewportBounds, bounds)) return;
    this.#viewportBounds = bounds === undefined ? undefined : Object.freeze({ ...bounds });
    this.#viewDirty = true;
  }

  /** Read accepted label bounds in local or world coordinates. */
  getBoundsFor(
    id: TextId,
    output?: MutableBoundsData,
    space: "local" | "world" = "local",
  ): Readonly<BoundsData> | undefined {
    this.#assertActive();
    if (space !== "local" && space !== "world") {
      throw new TypeError('Bounds space must be "local" or "world"');
    }
    this.#flushGpuResidentSpatialMoves();
    const slot = this.#store.slotOf(id);
    if (slot === undefined) return undefined;
    const target = output ?? { x: 0, y: 0, width: 0, height: 0 };
    const bounds = this.#spatial.get(slot, target);
    if (bounds === undefined || space === "local") return bounds;

    return transformBounds(bounds, this.getGlobalTransform(this.#matrixScratch), target);
  }

  /** Return the topmost label from the last committed collision-selected set. */
  hitTest(point: PointLike, space: "local" | "world" = "local"): TextId | undefined {
    this.#assertActive();
    assertPointLike(point);
    if (space !== "local" && space !== "world") {
      throw new TypeError('Hit-test space must be "local" or "world"');
    }
    this.#flushGpuResidentSpatialMoves();
    const localPoint =
      space === "world"
        ? inverseTransformPoint(point, this.getGlobalTransform(this.#matrixScratch))
        : point;
    const slot = this.#spatial.hitTest(
      localPoint,
      this.#collisionEnabled ? this.#visibleMember : undefined,
    );
    if (slot === undefined) return undefined;

    return this.#store.snapshotAt(slot)?.id;
  }

  /** Publish accepted mutations as one monotonic revision. */
  commit(): Promise<TextRevision> {
    this.#assertActive();
    this.#lastOffscreenInspectedLabels = 0;
    this.#lastOffscreenMaterializedLabels = 0;
    this.#lastVisibilitySelectionMs = 0;
    this.#lastRenderPreparationMs = 0;
    this.#lastRenderCoordinatorMs = 0;
    this.#lastSurfaceApplyMs = 0;
    if (
      this.#gpuResidentScene !== undefined &&
      this.#renderSurface?.residentFrameRecoveryRequired() === true
    ) {
      this.#flushGpuResidentSpatialMoves();
      this.#viewDirty = true;
    }
    const hasOrdinaryLabelChanges = this.#store.pendingDirty.labels > 0;
    const hasResidentPositionChanges = this.#store.pendingResidentPositionUpdates > 0;
    const hasLabelChanges = hasOrdinaryLabelChanges || hasResidentPositionChanges;
    const collisionTransformChanged = this.#refreshCollisionTransform();
    const outlineEnabled = this.#renderCoordinator?.outlineEnabled === true;
    const outlineWorldScaleY = outlineEnabled ? this.#projectedWorldScaleY() : 1;
    const outlineScaleChanged = outlineEnabled && outlineWorldScaleY !== this.#outlineWorldScaleY;
    if (outlineEnabled) this.#outlineWorldScaleY = outlineWorldScaleY;
    if (
      !hasLabelChanges &&
      !this.#viewDirty &&
      !collisionTransformChanged &&
      !outlineScaleChanged
    ) {
      this.#lastCommitDurationMs = 0;
      this.#lastCommitDirtyLabels = 0;
      this.#lastCommitContentLabels = 0;
      this.#lastCommitTransformLabels = 0;
      this.#lastCommitStyleLabels = 0;
      this.#lastLayoutMs = 0;
      this.#lastInstanceWriteMs = 0;
      this.#lastPaletteWriteMs = 0;
      this.#lastSpatialUpdateMs = 0;
      this.#lastUploadMs = 0;
      this.#lastCollisionMs = 0;
      return this.#lastCommitPromise;
    }
    if (hasLabelChanges && this.#revision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("TextLayer revision capacity exhausted");
    }

    const start = performance.now();
    const coordinator = this.#renderCoordinator;
    const surface = this.#renderSurface;
    const lifecycleEpoch = this.#renderLifecycleEpoch;
    if (hasOrdinaryLabelChanges) this.#ensureScratchCapacity();
    const residentPositions = this.#store.takeResidentPositionUpdates();
    this.#dirtyLength = 0;
    const dirty = hasOrdinaryLabelChanges
      ? this.#store.publishDirty((slot, mask) => {
          this.#dirtyMasks[slot] = mask;
          this.#positionOnly[slot] = Number(this.#store.consumePositionOnly(slot));
          this.#dirtySlots[this.#dirtyLength] = slot;
          this.#dirtyLength += 1;
        })
      : {
          labels: 0,
          content: 0,
          transform: 0,
          style: 0,
          mask: TextDirty.None,
        };
    let dirtyLabels = dirty.labels;
    let dirtyTransforms = dirty.transform;
    if (residentPositions !== undefined) {
      if (dirty.labels === 0) {
        dirtyLabels = residentPositions.count;
        dirtyTransforms = residentPositions.count;
      } else {
        for (let index = 0; index < residentPositions.count; index += 1) {
          const slot = residentPositions.slots[index] ?? 0;
          const mask = this.#dirtyMasks[slot] ?? TextDirty.None;
          if (mask === TextDirty.None) dirtyLabels += 1;
          if ((mask & TextDirty.Transform) === 0) dirtyTransforms += 1;
        }
      }
    }
    if (hasLabelChanges) this.#revision += 1;
    const revision = this.#revision as TextRevision;
    this.#pendingMutations = 0;
    this.#commits += 1;
    this.#lastCommitDirtyLabels = dirtyLabels;
    this.#lastCommitContentLabels = dirty.content;
    this.#lastCommitTransformLabels = dirtyTransforms;
    this.#lastCommitStyleLabels = dirty.style;
    const gpuResidentCommit = this.#tryCommitGpuResidentScene(
      start,
      revision,
      coordinator,
      surface,
      lifecycleEpoch,
      residentPositions,
    );
    if (gpuResidentCommit !== undefined) return gpuResidentCommit;
    const cullPath = this.#resolveCullPath();
    const drawViewport = this.#drawViewport();
    const refreshResidency =
      shouldRefreshResidency({
        cullPath,
        visibilityDirty: this.#visibilityDirty,
        instanced: this.#instancedViewport,
        draw: drawViewport,
      }) ||
      (this.#collisionEnabled && (hasLabelChanges || this.#viewDirty || collisionTransformChanged));
    const cameraMoved = this.#viewDirty;
    this.#viewDirty = false;
    const worldScaleY = this.#lod
      ? outlineEnabled
        ? outlineWorldScaleY
        : this.#worldScaleY()
      : outlineWorldScaleY;
    const lodScaleChanged = this.#lod && worldScaleY !== this.#lodWorldScaleY;
    if (this.#lod) this.#lodWorldScaleY = worldScaleY;
    if (lodScaleChanged || outlineScaleChanged || collisionTransformChanged) {
      this.#invalidateOffscreenAdmission();
    }
    const spatialStart = performance.now();
    let changes: LayerRenderChange[] = [];
    let laneCount = 0;
    let contentCount = 0;
    let contentText: string | undefined;
    let contentStyle: Readonly<TextStyleOptions> | undefined;
    const admit = createAdmitCollector();
    const admitBudget = createOffscreenAdmitBudget({
      cullPath,
      budgetBytes: this.#offscreenAdmitBudgetBytes,
    });
    let scannedPrepareRing = false;
    if (refreshResidency) {
      const visibilityStart = performance.now();
      this.#visibleCount = this.#queryVisible(cullPath, drawViewport);
      this.#lastVisibilitySelectionMs = performance.now() - visibilityStart;
      this.#visibilityDirty = false;
      if (coordinator !== undefined) {
        const built = this.#buildRenderChanges(
          cullPath,
          drawViewport,
          admit,
          admitBudget,
          outlineScaleChanged,
        );
        changes = built.changes;
        laneCount = built.laneCount;
        scannedPrepareRing = true;
      }
    } else if (coordinator !== undefined) {
      if (lodScaleChanged || outlineScaleChanged) {
        const built = this.#buildRenderChanges(
          cullPath,
          drawViewport,
          admit,
          admitBudget,
          outlineScaleChanged,
        );
        changes = built.changes;
        laneCount = built.laneCount;
        scannedPrepareRing = true;
      } else {
        if (hasLabelChanges) {
          const dirty = this.#buildResidentDirtyChanges(admit, admitBudget);
          changes = dirty.changes;
          laneCount = dirty.laneCount;
          contentCount = dirty.contentCount;
          contentText = dirty.contentText;
          contentStyle = dirty.contentStyle;
        }
        if (cameraMoved && cullPath === "compute-cull" && drawViewport !== undefined) {
          const queryRing = shouldQueryPrepareRing({
            preparedRing: this.#preparedRing,
            draw: drawViewport,
            offscreenDeferred: this.#offscreenAdmitDeferred,
          });
          const preparedContainsDraw =
            this.#preparedRing !== undefined &&
            workingSetContains(this.#preparedRing, drawViewport);
          const ring = queryRing
            ? this.#offscreenAdmitDeferred && preparedContainsDraw
              ? this.#preparedRing
              : expandPrepareRing(drawViewport)
            : undefined;
          if (ring !== undefined) scannedPrepareRing = true;
          changes.push(...this.#buildUnshapedFirstSeen(admit, drawViewport, ring, admitBudget));
        }
        this.#finalizeAdmitDrafts(admit, this.#renderEpoch, admitBudget);
      }
    }
    if (admitBudget.deferred) this.#offscreenAdmitDeferred = true;
    else if (scannedPrepareRing) this.#offscreenAdmitDeferred = false;
    const admitGroups = this.#publishAdmitGroups(admit.drafts);
    const palettePath = this.#renderSurface?.preparePalettePath() ?? "texture";
    const writeCpuPalette = shouldWriteCpuPalettePositions(palettePath);
    // Copy the lane at publish time so later intake cannot skew what this revision draws.
    let laneSlots: Uint32Array | undefined;
    let laneXy: Float32Array | undefined;
    if (laneCount > 0) {
      laneSlots = this.#laneSlots.slice(0, laneCount);
      laneSlots.sort();
      if (writeCpuPalette) {
        laneXy = new Float32Array(laneCount * 2);
        this.#store.positionsInto(laneSlots, laneCount, laneXy);
      }
    }
    let contentSlots: Uint32Array | undefined;
    let contentXy: Float32Array | undefined;
    if (contentCount > 0 && contentText !== undefined && contentStyle !== undefined) {
      contentSlots = this.#contentSlots.slice(0, contentCount);
      contentSlots.sort();
      contentXy = new Float32Array(contentCount * 2);
      this.#store.positionsInto(contentSlots, contentCount, contentXy);
    } else {
      contentCount = 0;
    }
    const preparationEnd = performance.now();
    this.#lastSpatialUpdateMs = preparationEnd - spatialStart;
    this.#lastRenderPreparationMs = Math.max(
      0,
      this.#lastSpatialUpdateMs - this.#lastVisibilitySelectionMs,
    );
    this.#lastLayoutMs = 0;
    this.#lastInstanceWriteMs = 0;
    this.#lastPaletteWriteMs = 0;
    this.#lastUploadMs = 0;
    this.#clearDirtyMasks();

    const needsComputeDispatch = cullPath === "compute-cull";
    if (
      coordinator === undefined ||
      (changes.length === 0 &&
        laneCount === 0 &&
        contentCount === 0 &&
        admitGroups.length === 0 &&
        this.#pendingRenderResult === undefined &&
        !needsComputeDispatch)
    ) {
      if (this.#visibleCount === 0) this.#renderSurface?.dropIdleMeshes();
      this.#lastCommitDurationMs = performance.now() - start;
      this.#lastCommitPromise = this.#renderTail.then(() => {
        if (this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
          this.emit(TEXT_LAYER_COMMIT_EVENT, revision);
        }
        return revision;
      });
      return this.#lastCommitPromise;
    }

    let renderSequence = 0;
    if (changes.length > 0 || contentCount > 0 || admitGroups.length > 0) {
      if (this.#renderSequence === Number.MAX_SAFE_INTEGER) {
        throw new RangeError("TextLayer render sequence capacity exhausted");
      }
      this.#renderSequence += 1;
      renderSequence = this.#renderSequence;
    }
    const renderWork = this.#renderTail.then(async () => {
      if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) return;
      let surfaceAdoptedResult = false;
      const completedParts: RenderCommitResult[] = [];
      try {
        const coordinatorStart = performance.now();
        const commitResult =
          changes.length === 0 ? undefined : await coordinator.commit(renderSequence, changes);
        if (commitResult !== undefined) completedParts.push(commitResult);
        if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
          releaseRenderExternalUploads(...completedParts.splice(0));
          return;
        }
        if (commitResult !== undefined) {
          this.#lastLayoutMs = coordinator.stats.lastLayoutMs;
          this.#lastInstanceWriteMs = coordinator.stats.lastInstanceWriteMs;
          this.#lastPaletteWriteMs = coordinator.stats.lastPaletteWriteMs;
        }
        let contentResult: RenderCommitResult | undefined;
        if (
          contentSlots !== undefined &&
          contentXy !== undefined &&
          contentText !== undefined &&
          contentStyle !== undefined
        ) {
          contentResult = await coordinator.applyContentLane({
            slots: contentSlots,
            count: contentCount,
            xy: contentXy,
            text: contentText,
            style: contentStyle,
            ...(outlineEnabled
              ? {
                  projectedHeightPx:
                    resolvePositiveStyleNumber(contentStyle.fontSize, 26) * outlineWorldScaleY,
                }
              : {}),
            writePalettePositions: writeCpuPalette,
          });
          if (contentResult !== undefined) completedParts.push(contentResult);
          if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
            releaseRenderExternalUploads(...completedParts.splice(0));
            return;
          }
          this.#lastLayoutMs += coordinator.stats.lastLayoutMs;
          this.#lastInstanceWriteMs += coordinator.stats.lastInstanceWriteMs;
          this.#lastPaletteWriteMs += coordinator.stats.lastPaletteWriteMs;
        }
        let admitResult: RenderCommitResult | undefined;
        if (admitGroups.length > 0) {
          admitResult = await coordinator.applyAdmitLane(admitGroups);
          if (admitResult !== undefined) completedParts.push(admitResult);
          if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
            releaseRenderExternalUploads(...completedParts.splice(0));
            return;
          }
          this.#lastLayoutMs += coordinator.stats.lastLayoutMs;
          this.#lastInstanceWriteMs += coordinator.stats.lastInstanceWriteMs;
          this.#lastPaletteWriteMs += coordinator.stats.lastPaletteWriteMs;
        }
        let laneResult: RenderCommitResult | undefined;
        if (laneSlots !== undefined && laneCount > 0) {
          const laneStart = performance.now();
          laneResult =
            writeCpuPalette && laneXy !== undefined
              ? coordinator.applyPositionLane(laneSlots, laneCount, laneXy)
              : coordinator.notePositionLane(laneCount);
          if (laneResult !== undefined) completedParts.push(laneResult);
          this.#lastPaletteWriteMs += performance.now() - laneStart;
        }
        if (surface !== undefined && palettePath === "storage") {
          surface.bindOriginColumns(this.#store.xColumn, this.#store.yColumn);
          const moveCount = laneCount + (writeCpuPalette ? 0 : contentCount);
          if (moveCount > 0) {
            const commands = this.#ensureMoveCommands(moveCount);
            let packed = 0;
            if (laneSlots !== undefined && laneCount > 0) {
              packed += packPaletteMoves(
                commands,
                packed,
                laneSlots,
                laneCount,
                this.#store.xColumn,
                this.#store.yColumn,
              );
            }
            if (!writeCpuPalette && contentSlots !== undefined && contentCount > 0) {
              packed += packPaletteMoves(
                commands,
                packed,
                contentSlots,
                contentCount,
                this.#store.xColumn,
                this.#store.yColumn,
              );
            }
            if (packed > 0) {
              surface.queuePaletteMoves({ mode: "indexed", commands, count: packed });
            }
          }
        }
        const result = mergeRenderResults(
          this.#pendingRenderResult,
          commitResult,
          contentResult,
          admitResult,
          laneResult,
        );
        this.#lastRenderCoordinatorMs = performance.now() - coordinatorStart;
        const spatialWriteStart = performance.now();
        if (commitResult !== undefined) {
          for (const change of changes) {
            if (change.snapshot === undefined) continue;
            // Position-only movers already moved the store origin at intake. Content-plus-xy
            // that stayed on the object path (anchors, mixed text, shaping) still
            // replaced the local box with an estimate and must take the laid-out run.
            if (change.positionOnly === true && (change.mask & TextDirty.Content) === 0) continue;
            const run = coordinator.getRun(change.slot);
            const current = this.#store.snapshotAt(change.slot);
            if (
              run === undefined ||
              current === undefined ||
              change.labelId === undefined ||
              current.id !== change.labelId ||
              current.sourceRevision !== change.snapshot.sourceRevision
            ) {
              continue;
            }
            this.#spatial.set(
              change.slot,
              transformedLabelBounds(current, run.bounds, this.#boundsScratch),
              current.zIndex,
              this.#isEffectivelyVisible(current.id, current.visible),
            );
            this.#invalidateCollisionRecord(change.slot);
          }
        }
        if (contentSlots !== undefined && contentXy !== undefined && contentCount > 0) {
          const contentRun = coordinator.getRun(contentSlots[0] ?? 0);
          if (contentRun !== undefined) {
            this.#spatial.placeMany(contentSlots, contentCount, contentXy, contentRun.bounds);
            this.#invalidateCollisionRecords(contentSlots, contentCount);
          }
        }
        for (const group of admitGroups) {
          const admitRun = coordinator.getRun(group.slots[0] ?? 0);
          if (admitRun !== undefined) {
            this.#spatial.placeMany(group.slots, group.count, group.xy, admitRun.bounds);
            this.#invalidateCollisionRecords(group.slots, group.count);
          }
        }
        this.#lastSpatialUpdateMs += performance.now() - spatialWriteStart;
        const computeUpdate: RenderComputeCullUpdate | undefined =
          cullPath === "compute-cull"
            ? this.#buildComputeCullUpdate(
                coordinator,
                changes,
                laneSlots,
                laneCount,
                contentSlots,
                contentCount,
                drawViewport,
                palettePath,
              )
            : undefined;
        const surfaceStart = performance.now();
        if (result !== undefined && surface !== undefined) {
          surfaceAdoptedResult = true;
          this.#detachPendingRenderResult();
          completedParts.length = 0;
          await surface.apply(result, computeUpdate);
        } else if (result !== undefined) {
          const pendingRenderResult = this.#detachPendingRenderResult();
          const ownedParts = completedParts.splice(0);
          releaseRenderExternalUploads(pendingRenderResult, ...ownedParts);
        } else if (computeUpdate !== undefined) {
          surface?.refreshComputeCull(computeUpdate);
        }
        this.#lastSurfaceApplyMs = performance.now() - surfaceStart;
        this.#lastUploadMs = surface?.stats.lastUploadMs ?? 0;
      } catch (error: unknown) {
        const workCurrent = this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch);
        cleanupBestEffort([
          () => {
            if (surfaceAdoptedResult) return;
            if (workCurrent) this.#retainRenderResults(...completedParts.splice(0));
            else releaseRenderExternalUploads(...completedParts.splice(0));
          },
          () => {
            if (workCurrent) {
              this.#resetRenderedSet();
              this.#viewDirty = true;
            }
          },
        ]);
        throw error;
      }
    });
    this.#renderTail = renderWork.then(
      () => undefined,
      () => undefined,
    );
    this.#lastCommitPromise = renderWork.then(
      () => {
        this.#lastCommitDurationMs = performance.now() - start;
        if (this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
          this.emit(TEXT_LAYER_COMMIT_EVENT, revision);
        }
        return revision;
      },
      (error: unknown) => {
        if (this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
          this.#resetRenderedSet();
          this.#viewDirty = true;
        }
        throw error;
      },
    );

    return this.#lastCommitPromise;
  }

  #tryCommitGpuResidentScene(
    start: number,
    revision: TextRevision,
    coordinator: RenderCoordinator | undefined,
    surface: RenderSurface | undefined,
    lifecycleEpoch: number,
    residentPositions: Readonly<TextStoreResidentPositionUpdates> | undefined,
  ): Promise<TextRevision> | undefined {
    const fallback = (): undefined => {
      if (residentPositions !== undefined) {
        this.#materializeResidentPositionLease(residentPositions);
      }
      return undefined;
    };
    if (this.#residencyRequested !== "gpu-scene") return fallback();
    if (!this.#cullingEnabled) {
      this.#deactivateGpuResidentScene("unsupported-scene");
      return fallback();
    }
    if (coordinator === undefined || surface === undefined) return fallback();

    const scene = this.#gpuResidentScene;
    let plan: GpuResidentCommitPlan;
    if (scene === undefined && this.#gpuSceneCompiler === undefined) {
      if (this.#residencyFallbackReason !== undefined) return fallback();
      if (this.#store.size === 0) return fallback();
      const compiler = new GpuSceneCompiler();
      const groups = this.#buildGpuResidentGroups(compiler);
      if (groups === undefined) {
        this.#deactivateGpuResidentScene("unsupported-scene");
        return fallback();
      }
      this.#gpuSceneCompiler = compiler;
      this.#gpuResidentPlannedRecordCount = this.#store.size;
      plan = {
        setup: true,
        appendGroups: groups,
        ...(residentPositions === undefined ? {} : { moveBatch: residentPositions }),
        viewport: this.#drawViewport() ?? FULL_CULL_VIEWPORT,
      };
    } else {
      const compiler = this.#gpuSceneCompiler;
      if (compiler === undefined) {
        this.#deactivateGpuResidentScene("setup-failed");
        return fallback();
      }
      const movers: number[] = [];
      const removals: number[] = [];
      const appends: number[] = [];
      const publishedRecordCount = scene?.stats.recordCount ?? 0;
      const plannedRecordCount = Math.max(
        publishedRecordCount,
        this.#gpuResidentPlannedRecordCount,
      );
      for (let index = 0; index < this.#dirtyLength; index += 1) {
        const slot = this.#dirtySlots[index];
        if (slot === undefined) throw new Error("Dirty slot list is incomplete");
        if (!this.#store.occupiedAt(slot)) {
          removals.push(slot);
          continue;
        }
        const publishedActive = scene?.isActive(slot) === true;
        const publishedTombstone =
          scene !== undefined && slot < publishedRecordCount && !publishedActive;
        const plannedActive = slot < plannedRecordCount && !publishedTombstone;
        if (!publishedActive && !plannedActive) {
          if (slot < plannedRecordCount) {
            this.#deactivateGpuResidentScene("unsupported-scene");
            return fallback();
          }
          appends.push(slot);
          continue;
        }
        if (this.#positionOnly[slot] === 1 && this.#dirtyMasks[slot] === TextDirty.Transform) {
          movers.push(slot);
          continue;
        }
        this.#deactivateGpuResidentScene("unsupported-scene");
        return fallback();
      }

      let appendGroups: readonly ResidentAdmitLaneGroup[] | undefined;
      if (appends.length > 0) {
        const slots = Uint32Array.from(appends);
        slots.sort();
        for (let index = 0; index < slots.length; index += 1) {
          if (slots[index] !== plannedRecordCount + index) {
            this.#deactivateGpuResidentScene("unsupported-scene");
            return fallback();
          }
        }
        appendGroups = this.#buildGpuResidentGroups(compiler, slots, slots.length);
        if (appendGroups === undefined) {
          this.#deactivateGpuResidentScene("unsupported-scene");
          return fallback();
        }
        this.#gpuResidentPlannedRecordCount = plannedRecordCount + slots.length;
      }

      let moveSlots: Uint32Array | undefined;
      let moveXy: Float32Array | undefined;
      if (movers.length > 0) {
        if (residentPositions !== undefined) {
          this.#deactivateGpuResidentScene("unsupported-scene");
          return fallback();
        }
        moveSlots = Uint32Array.from(movers);
        moveSlots.sort();
        moveXy = new Float32Array(moveSlots.length * 2);
        this.#store.positionsInto(moveSlots, moveSlots.length, moveXy);
      }
      plan = {
        setup: false,
        ...(appendGroups === undefined ? {} : { appendGroups }),
        ...(residentPositions === undefined ? {} : { moveBatch: residentPositions }),
        ...(moveSlots === undefined || moveXy === undefined ? {} : { moveSlots, moveXy }),
        ...(removals.length === 0 ? {} : { removeSlots: Uint32Array.from(removals).sort() }),
        viewport: this.#drawViewport() ?? FULL_CULL_VIEWPORT,
      };
    }
    const compiler = this.#gpuSceneCompiler;
    if (compiler === undefined) {
      this.#deactivateGpuResidentScene("setup-failed");
      return fallback();
    }

    this.#viewDirty = false;
    this.#visibilityDirty = false;
    this.#lastVisibilitySelectionMs = 0;
    this.#lastRenderPreparationMs = 0;
    this.#lastSpatialUpdateMs = 0;
    this.#lastLayoutMs = 0;
    this.#lastInstanceWriteMs = 0;
    this.#lastPaletteWriteMs = 0;
    this.#lastUploadMs = 0;
    this.#clearDirtyMasks();
    const residentEpoch = this.#gpuResidentEpoch;

    const renderWork = this.#renderTail.then(async () => {
      let moveBatchOwned = plan.moveBatch !== undefined;
      const releaseMoveBatch = (): void => {
        if (!moveBatchOwned || plan.moveBatch === undefined) return;
        moveBatchOwned = false;
        this.#store.releaseResidentPositionUpdates(plan.moveBatch);
      };
      if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
        releaseMoveBatch();
        return;
      }
      if (residentEpoch !== this.#gpuResidentEpoch) {
        try {
          await this.#recoverGpuResidentStalePlan(coordinator, surface, lifecycleEpoch);
        } catch (error: unknown) {
          cleanupBestEffort([releaseMoveBatch]);
          throw error;
        }
        releaseMoveBatch();
        return;
      }
      const runResidentWork = async (): Promise<void> => {
        const setupStart = performance.now();
        let currentScene = this.#gpuResidentScene;
        let residentResult: Readonly<ResidentAdmitLaneResult> | undefined;
        let surfaceAdoptedResult = false;
        let recoveringViewport = false;
        const completedParts: RenderCommitResult[] = [];
        try {
          const groups = plan.appendGroups;
          if (groups !== undefined) {
            const coordinatorStart = performance.now();
            const baseRecordCount = currentScene?.stats.recordCount ?? 0;
            const baseDrawInstanceCount = currentScene?.stats.activeGlyphInstances ?? 0;
            residentResult = await coordinator.applyResidentAdmitLane(groups, compiler, {
              capacityFits: (recordCount, drawInstanceCount) =>
                surface.gpuSceneCapacityFits(
                  baseRecordCount + recordCount,
                  baseDrawInstanceCount + drawInstanceCount,
                ),
            });
            if (residentResult?.residentFallbackReason === "device-limit") {
              this.#lastRenderCoordinatorMs = performance.now() - coordinatorStart;
              this.#deactivateGpuResidentScene("device-limit");
              recoveringViewport = true;
              await this.#recoverGpuResidentStalePlan(coordinator, surface, lifecycleEpoch);
              recoveringViewport = false;
              return;
            }
            if (residentResult !== undefined) completedParts.push(residentResult);
            this.#lastRenderCoordinatorMs = performance.now() - coordinatorStart;
            if (
              !this.#isGpuResidentWorkCurrent(coordinator, surface, lifecycleEpoch, residentEpoch)
            ) {
              releaseRenderExternalUploads(...completedParts.splice(0));
              return;
            }
            if (residentResult === undefined) {
              this.#retainRenderResults(...completedParts.splice(0));
              this.#deactivateGpuResidentScene("unsupported-scene");
              recoveringViewport = true;
              await this.#recoverGpuResidentStalePlan(coordinator, surface, lifecycleEpoch);
              recoveringViewport = false;
              return;
            }
            const columns = residentResult.residentColumns;
            if (columns.length === 0) {
              this.#retainRenderResults(...completedParts.splice(0));
              this.#deactivateGpuResidentScene("setup-failed");
              return;
            }
            if (plan.setup) {
              currentScene = new GpuResidentScene({ initialCapacity: this.#store.capacity });
              currentScene.setupMany(columns);
              currentScene.bindOriginColumns(this.#store.xColumn, this.#store.yColumn);
            } else if (currentScene === undefined || !currentScene.appendMany(columns)) {
              this.#retainRenderResults(...completedParts.splice(0));
              this.#deactivateGpuResidentScene("unsupported-scene");
              return;
            }
            const spatialStart = performance.now();
            for (const column of columns) {
              this.#spatial.placeMany(column.slots, column.count, column.xy, {
                x: column.localBounds[0] ?? 0,
                y: column.localBounds[1] ?? 0,
                width: column.localBounds[2] ?? 0,
                height: column.localBounds[3] ?? 0,
              });
            }
            this.#lastSpatialUpdateMs += performance.now() - spatialStart;
          }
          if (currentScene === undefined) {
            this.#deactivateGpuResidentScene("setup-failed");
            return;
          }
          if (plan.moveBatch !== undefined) {
            const paletteStart = performance.now();
            const moves = currentScene.updatePositionsPacked(plan.moveBatch);
            surface.queuePaletteMoves(moves.paletteMoves);
            this.#lastPaletteWriteMs = performance.now() - paletteStart;
          } else if (plan.moveSlots !== undefined && plan.moveXy !== undefined) {
            const paletteStart = performance.now();
            const moves = currentScene.updatePositions(
              plan.moveSlots,
              plan.moveSlots.length,
              plan.moveXy,
            );
            surface.queuePaletteMoves(moves.paletteMoves);
            this.#lastPaletteWriteMs = performance.now() - paletteStart;
          }
          if (plan.removeSlots !== undefined) {
            currentScene.remove(plan.removeSlots, plan.removeSlots.length);
          }
          surface.bindOriginColumns(currentScene.originX, currentScene.originY);
          const computeUpdate = currentScene.snapshot(plan.viewport);
          const result = mergeRenderResults(this.#pendingRenderResult, residentResult);
          const surfaceStart = performance.now();
          if (result !== undefined) {
            surfaceAdoptedResult = true;
            this.#detachPendingRenderResult();
            completedParts.length = 0;
            await surface.apply(result, computeUpdate);
            if (
              !this.#isGpuResidentWorkCurrent(coordinator, surface, lifecycleEpoch, residentEpoch)
            ) {
              if (plan.setup) currentScene.destroy();
              return;
            }
          } else {
            surface.refreshComputeCull(computeUpdate);
          }
          this.#lastSurfaceApplyMs = performance.now() - surfaceStart;
          this.#lastUploadMs = surface.stats.lastUploadMs;
          if (surface.stats.cullPath !== "compute-cull") {
            currentScene.flushSpatialMoves(() => {});
            this.#spatial.flushDeferredRehash();
            const recoveryPaletteStart = performance.now();
            if (
              plan.moveBatch === undefined &&
              plan.moveSlots !== undefined &&
              plan.moveXy !== undefined
            ) {
              coordinator.applyPositionLane(plan.moveSlots, plan.moveSlots.length, plan.moveXy);
            }
            this.#recoverGpuResidentPositionLeases(coordinator);
            this.#lastPaletteWriteMs += performance.now() - recoveryPaletteStart;
            surface.rebuildCpuCull(currentScene.snapshot(plan.viewport));
            const visibleCount = this.#queryVisible("cpu-grid", plan.viewport);
            if (plan.setup) currentScene.destroy();
            this.#deactivateGpuResidentScene("device-limit");
            this.#visibleCount = visibleCount;
            return;
          }
          if (surface.stats.palettePath !== "storage") {
            if (plan.setup) currentScene.destroy();
            this.#deactivateGpuResidentScene("storage-palette-unavailable");
            return;
          }
          this.#gpuResidentScene = currentScene;
          this.#residencyActive = "gpu-scene";
          this.#residencyFallbackReason = undefined;
          const residentStats = currentScene.stats;
          this.#gpuResidentLabels = residentStats.activeLabels;
          this.#gpuScenePrototypeCount = compiler.prototypeCount;
          this.#gpuScenePaintCount = compiler.paintCount;
          this.#visibleCount = residentStats.activeLabels;
          if (plan.setup) this.#lastSceneSetupMs = performance.now() - setupStart;
        } catch (error: unknown) {
          const workCurrent = this.#isGpuResidentWorkCurrent(
            coordinator,
            surface,
            lifecycleEpoch,
            residentEpoch,
          );
          cleanupBestEffort([
            () => {
              if (surfaceAdoptedResult) return;
              if (workCurrent) this.#retainRenderResults(...completedParts.splice(0));
              else releaseRenderExternalUploads(...completedParts.splice(0));
            },
            () => {
              if (plan.setup && currentScene !== undefined) currentScene.destroy();
            },
            () => {
              if (workCurrent) this.#deactivateGpuResidentScene("setup-failed");
            },
          ]);
          if (!workCurrent && !recoveringViewport) return;
          throw error;
        }
      };
      try {
        await runResidentWork();
      } catch (error: unknown) {
        cleanupBestEffort([releaseMoveBatch]);
        throw error;
      }
      const cleanupFailure = cleanupBestEffort([releaseMoveBatch]);
      if (cleanupFailure !== undefined) throw cleanupFailure.error;
    });
    this.#renderTail = renderWork.then(
      () => undefined,
      () => undefined,
    );
    this.#lastCommitPromise = renderWork.then(() => {
      this.#lastCommitDurationMs = performance.now() - start;
      if (this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
        this.emit(TEXT_LAYER_COMMIT_EVENT, revision);
      }
      return revision;
    });
    return this.#lastCommitPromise;
  }

  #buildGpuResidentGroups(
    compiler: GpuSceneCompiler,
    selectedSlots?: Uint32Array,
    selectedCount = selectedSlots?.length ?? 0,
  ): readonly ResidentAdmitLaneGroup[] | undefined {
    type Draft = {
      readonly text: string;
      readonly style: Readonly<TextStyleOptions>;
      readonly prototypeCandidateIndex: number;
      count: number;
      write: number;
      slots: Uint32Array;
      orders: Uint32Array;
    };
    const drafts: Draft[] = [];
    const pairDrafts = new Int16Array(GPU_SCENE_MAX_PROTOTYPES * GPU_SCENE_MAX_PAINTS).fill(-1);
    const sourceCount = selectedSlots === undefined ? this.#store.capacity : selectedCount;
    let admittedCount = 0;
    for (let index = 0; index < sourceCount; index += 1) {
      const slot = selectedSlots === undefined ? index : selectedSlots[index];
      if (selectedSlots === undefined && !this.#store.occupiedAt(index)) continue;
      if (
        slot === undefined ||
        !this.#isAdmitLaneCandidate(slot) ||
        !this.#isGpuResidentSlotEffectivelyVisible(slot)
      ) {
        return undefined;
      }
      const text = this.#store.textAt(slot);
      const style = this.#store.styleAt(slot);
      if (text === undefined || style === undefined) return undefined;
      const order = this.#spatial.orderOf(slot);
      if (order === undefined) return undefined;
      const pair = compiler.admitCandidate(text, style);
      if (pair === undefined) return undefined;
      let draftIndex = pairDrafts[pair] ?? -1;
      let draft = draftIndex < 0 ? undefined : drafts[draftIndex];
      if (draft === undefined) {
        draftIndex = drafts.length;
        draft = {
          text,
          style,
          prototypeCandidateIndex: Math.floor(pair / GPU_SCENE_MAX_PAINTS),
          count: 0,
          write: 0,
          slots: new Uint32Array(0),
          orders: new Uint32Array(0),
        };
        pairDrafts[pair] = draftIndex;
        drafts.push(draft);
      }
      draft.count += 1;
      admittedCount += 1;
    }
    if (admittedCount === 0) return undefined;
    for (const draft of drafts) {
      draft.slots = new Uint32Array(draft.count);
      draft.orders = new Uint32Array(draft.count);
    }
    for (let index = 0; index < sourceCount; index += 1) {
      const slot = selectedSlots === undefined ? index : selectedSlots[index];
      if (slot === undefined || (selectedSlots === undefined && !this.#store.occupiedAt(slot))) {
        continue;
      }
      const text = this.#store.textAt(slot);
      const style = this.#store.styleAt(slot);
      const order = this.#spatial.orderOf(slot);
      if (text === undefined || style === undefined || order === undefined) return undefined;
      const pair = compiler.admitCandidate(text, style);
      const draft = pair === undefined ? undefined : drafts[pairDrafts[pair] ?? -1];
      if (draft === undefined) return undefined;
      draft.slots[draft.write] = slot;
      draft.orders[draft.write] = order;
      draft.write += 1;
    }
    return drafts.map((draft) => {
      const xy = new Float32Array(draft.count * 2);
      this.#store.positionsInto(draft.slots, draft.count, xy);
      return {
        slots: draft.slots,
        count: draft.count,
        xy,
        orders: draft.orders,
        text: draft.text,
        style: draft.style,
        zIndex: 0,
        blendMode: "normal",
        prototypeCandidateIndex: draft.prototypeCandidateIndex,
        ...(this.#renderCoordinator?.outlineEnabled === true
          ? {
              projectedHeightPx:
                resolvePositiveStyleNumber(draft.style.fontSize, 26) * this.#outlineWorldScaleY,
            }
          : {}),
      };
    });
  }

  #isGpuResidentSlotEffectivelyVisible(slot: number): boolean {
    const id = this.#store.idAt(slot);
    return id !== undefined && this.#isEffectivelyVisible(id, true);
  }

  #flushGpuResidentSpatialMoves(): number {
    this.#gpuResidentScene?.flushSpatialMoves(() => {});
    return this.#spatial.flushDeferredRehash();
  }

  #recoverGpuResidentPositionLeases(coordinator: RenderCoordinator): void {
    const uniqueSlots = new Set<number>();
    this.#store.visitResidentPositionLeases((batch) => {
      for (let index = 0; index < batch.count; index += 1) {
        uniqueSlots.add(batch.slots[index] ?? 0);
      }
    });
    if (uniqueSlots.size === 0) return;
    const slots = Uint32Array.from(uniqueSlots);
    slots.sort();
    const xy = new Float32Array(slots.length * 2);
    this.#store.positionsInto(slots, slots.length, xy);
    coordinator.applyPositionLane(slots, slots.length, xy);
  }

  async #recoverGpuResidentStalePlan(
    coordinator: RenderCoordinator,
    surface: RenderSurface,
    lifecycleEpoch: number,
  ): Promise<void> {
    const cullPath: CullPath = "cpu-grid";
    const draw = this.#drawViewport();
    const spatialStart = performance.now();
    this.#visibleCount = this.#queryVisible(cullPath, draw);
    const admit = createAdmitCollector();
    const admitBudget = createOffscreenAdmitBudget({
      cullPath,
      budgetBytes: this.#offscreenAdmitBudgetBytes,
    });
    const { changes, laneCount } = this.#buildRenderChanges(cullPath, draw, admit, admitBudget);
    const admitGroups = this.#publishAdmitGroups(admit.drafts);
    let laneSlots: Uint32Array | undefined;
    let laneXy: Float32Array | undefined;
    if (laneCount > 0) {
      laneSlots = this.#laneSlots.slice(0, laneCount);
      laneSlots.sort();
      laneXy = new Float32Array(laneCount * 2);
      this.#store.positionsInto(laneSlots, laneCount, laneXy);
    }
    this.#lastSpatialUpdateMs += performance.now() - spatialStart;

    let renderSequence = 0;
    if (changes.length > 0) {
      if (this.#renderSequence === Number.MAX_SAFE_INTEGER) {
        throw new RangeError("TextLayer render sequence capacity exhausted");
      }
      this.#renderSequence += 1;
      renderSequence = this.#renderSequence;
    }

    let commitResult: RenderCommitResult | undefined;
    let admitResult: RenderCommitResult | undefined;
    let surfaceAdoptedResult = false;
    const completedParts: RenderCommitResult[] = [];
    try {
      const coordinatorStart = performance.now();
      if (changes.length > 0) {
        commitResult = await coordinator.commit(renderSequence, changes);
        completedParts.push(commitResult);
        if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
          releaseRenderExternalUploads(...completedParts.splice(0));
          return;
        }
      }
      if (admitGroups.length > 0) {
        admitResult = await coordinator.applyAdmitLane(admitGroups);
        completedParts.push(admitResult);
        if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) {
          releaseRenderExternalUploads(...completedParts.splice(0));
          return;
        }
      }
      let laneResult: RenderCommitResult | undefined;
      if (laneSlots !== undefined && laneXy !== undefined) {
        laneResult = coordinator.applyPositionLane(laneSlots, laneCount, laneXy);
      }
      this.#lastRenderCoordinatorMs += performance.now() - coordinatorStart;

      const spatialWriteStart = performance.now();
      if (commitResult !== undefined) {
        for (const change of changes) {
          if (change.snapshot === undefined) continue;
          const run = coordinator.getRun(change.slot);
          const current = this.#store.snapshotAt(change.slot);
          if (
            run === undefined ||
            current === undefined ||
            change.labelId === undefined ||
            current.id !== change.labelId ||
            current.sourceRevision !== change.snapshot.sourceRevision
          ) {
            continue;
          }
          this.#spatial.set(
            change.slot,
            transformedLabelBounds(current, run.bounds, this.#boundsScratch),
            current.zIndex,
            this.#isEffectivelyVisible(current.id, current.visible),
          );
          this.#invalidateCollisionRecord(change.slot);
        }
      }
      for (const group of admitGroups) {
        const run = coordinator.getRun(group.slots[0] ?? 0);
        if (run !== undefined) {
          this.#spatial.placeMany(group.slots, group.count, group.xy, run.bounds);
          this.#invalidateCollisionRecords(group.slots, group.count);
        }
      }
      this.#visibleCount = this.#queryVisible(cullPath, draw);
      this.#lastSpatialUpdateMs += performance.now() - spatialWriteStart;
      const merged = mergeRenderResults(
        this.#pendingRenderResult,
        commitResult,
        admitResult,
        laneResult,
      );
      const result =
        merged === undefined || merged.drawOrderChanged
          ? merged
          : { ...merged, drawOrderChanged: true };
      if (result !== undefined) {
        const surfaceStart = performance.now();
        surfaceAdoptedResult = true;
        this.#detachPendingRenderResult();
        completedParts.length = 0;
        await surface.apply(result);
        this.#lastSurfaceApplyMs += performance.now() - surfaceStart;
        this.#lastUploadMs = surface.stats.lastUploadMs;
      } else if (this.#visibleCount === 0) {
        surface.dropIdleMeshes();
      }
      if (!this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)) return;
      this.#viewDirty = false;
      this.#visibilityDirty = false;
    } catch (error: unknown) {
      const workCurrent = this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch);
      cleanupBestEffort([
        () => {
          if (surfaceAdoptedResult) return;
          if (workCurrent) this.#retainRenderResults(...completedParts.splice(0));
          else releaseRenderExternalUploads(...completedParts.splice(0));
        },
        () => {
          if (workCurrent) {
            this.#resetRenderedSet();
            this.#viewDirty = true;
          }
        },
      ]);
      throw error;
    }
  }

  #deactivateGpuResidentScene(reason: TextLayerResidencyFallbackReason): void {
    const residentScene = this.#detachGpuResidentState(reason);
    this.#cleanupDetachedGpuResidentScene(residentScene);
  }

  #cleanupDetachedGpuResidentScene(residentScene: GpuResidentScene | undefined): void {
    const failure = cleanupBestEffort([
      () => this.#store.materializeResidentPositionUpdates(),
      () => residentScene?.flushSpatialMoves(() => {}),
      () => this.#spatial.flushDeferredRehash(),
      () => residentScene?.destroy(),
    ]);
    if (failure !== undefined) throw failure.error;
  }

  #detachGpuResidentState(reason: TextLayerResidencyFallbackReason): GpuResidentScene | undefined {
    const residentScene = this.#gpuResidentScene;
    this.#gpuResidentEpoch =
      this.#gpuResidentEpoch === Number.MAX_SAFE_INTEGER ? 0 : this.#gpuResidentEpoch + 1;
    this.#gpuResidentScene = undefined;
    this.#gpuSceneCompiler = undefined;
    this.#gpuResidentPlannedRecordCount = 0;
    this.#residencyActive = "viewport";
    this.#residencyFallbackReason = reason;
    this.#gpuResidentLabels = 0;
    this.#gpuScenePrototypeCount = 0;
    this.#gpuScenePaintCount = 0;
    this.#resetRenderedSet();
    this.#viewDirty = true;
    return residentScene;
  }

  #retainRenderResults(...parts: Array<RenderCommitResult | undefined>): void {
    this.#pendingRenderResult = mergeRenderResults(this.#pendingRenderResult, ...parts);
  }

  #detachPendingRenderResult(): RenderCommitResult | undefined {
    const pendingRenderResult = this.#pendingRenderResult;
    this.#pendingRenderResult = undefined;
    return pendingRenderResult;
  }

  #detachRendererState(): DetachedRendererResources {
    const residentScene = this.#detachGpuResidentState("renderer-unavailable");
    const surface = this.#renderSurface;
    const coordinator = this.#renderCoordinator;
    const pendingRenderResult = this.#detachPendingRenderResult();
    this.#renderer = undefined;
    this.#renderSurface = undefined;
    this.#renderCoordinator = undefined;
    this.#renderTail = Promise.resolve();
    this.#lastCommitPromise = Promise.resolve(this.#revision as TextRevision);
    this.#refreshResidencyCapability();
    return { residentScene, surface, coordinator, pendingRenderResult };
  }

  #releaseRendererResources(
    resources: Readonly<DetachedRendererResources>,
    primaryFailure?: Readonly<CleanupFailure>,
    priorTeardown?: Promise<void>,
  ): Promise<void> | undefined {
    const { residentScene, surface, coordinator, pendingRenderResult } = resources;
    if (
      residentScene === undefined &&
      surface === undefined &&
      coordinator === undefined &&
      pendingRenderResult === undefined
    ) {
      if (primaryFailure !== undefined) throw primaryFailure.error;
      return;
    }
    const release = createControlledTeardown();
    this.#rendererRelease = release.promise;
    let coordinatorTeardown: Promise<void> | undefined;
    const cleanupSteps: Array<() => void> = [];
    if (pendingRenderResult !== undefined) {
      cleanupSteps.push(() => releaseRenderExternalUploads(pendingRenderResult));
    }
    if (residentScene !== undefined) {
      cleanupSteps.push(() => this.#cleanupDetachedGpuResidentScene(residentScene));
    }
    if (surface !== undefined) cleanupSteps.push(() => surface.destroy());
    if (coordinator !== undefined) {
      cleanupSteps.push(() => {
        coordinatorTeardown = coordinator.destroy();
      });
    }
    const cleanupFailure = cleanupBestEffort(cleanupSteps);
    const failure = primaryFailure ?? cleanupFailure;
    const pending = combineTeardowns(priorTeardown, coordinatorTeardown);
    settleControlledTeardown(release, failure, pending);
    if (failure !== undefined) throw failure.error;
    return release.promise;
  }

  /** Associate the layer with the renderer that owns future glyph resources. */
  attach(renderer: Renderer): void {
    this.#assertActive();
    if (this.#renderer === renderer && this.#renderCoordinator !== undefined) {
      return;
    }
    this.#advanceRenderLifecycle();
    const resources = this.#detachRendererState();
    const release = this.#releaseRendererResources(resources);
    this.#activateRendering(renderer, release);
    this.#viewDirty = true;
  }

  /** Release the current renderer association. */
  detach(): void {
    this.#assertActive();
    this.#advanceRenderLifecycle();
    const resources = this.#detachRendererState();
    this.#releaseRendererResources(resources);
  }

  /** Read the latest submitted glyph count, including an explicit compute-indirect readback. */
  async readSubmittedGlyphs(): Promise<number> {
    this.#assertActive();
    await this.#renderTail;
    return this.#renderSurface?.readSubmittedGlyphs() ?? 0;
  }

  /** Read the ordered GPU-compacted draw sequence through an explicit diagnostic mapping. */
  async readSubmittedGlyphsDiagnostic(): Promise<Readonly<SubmittedGlyphsDiagnostic> | undefined> {
    this.#assertActive();
    await this.#renderTail;
    return this.#renderSurface?.readSubmittedGlyphsDiagnostic();
  }

  /** Read an immutable diagnostics snapshot. */
  get stats(): Readonly<TextLayerStats> {
    const store = this.#store.stats;
    const pendingDirty = this.#store.pendingDirtyIncludingResidentPositions;
    const render = this.#renderCoordinator?.stats;
    const surface = this.#renderSurface?.stats;
    const spatial = this.#spatial.stats;

    return Object.freeze({
      backend: "glyphflow-core",
      labelCount: store.size,
      capacity: store.capacity,
      pendingMutations: this.#pendingMutations,
      pendingDirtyMask: pendingDirty.mask,
      pendingDirtyLabels: pendingDirty.labels,
      revision: this.#revision as TextRevision,
      attached: this.#renderer !== undefined,
      acceptedMutations: this.#acceptedMutations,
      commits: this.#commits,
      numericStoreBytes: store.numericBytes,
      referenceSlotBytes: store.referenceSlotBytes,
      allocatedStoreBytes: store.allocatedBytes,
      lastCommitDurationMs: this.#lastCommitDurationMs,
      lastCommitDirtyLabels: this.#lastCommitDirtyLabels,
      lastCommitContentLabels: this.#lastCommitContentLabels,
      lastCommitTransformLabels: this.#lastCommitTransformLabels,
      lastCommitStyleLabels: this.#lastCommitStyleLabels,
      lastLayoutMs: this.#lastLayoutMs,
      lastInstanceWriteMs: this.#lastInstanceWriteMs,
      lastPaletteWriteMs: this.#lastPaletteWriteMs,
      lastSpatialUpdateMs: this.#lastSpatialUpdateMs,
      lastUploadMs: this.#lastUploadMs,
      lastVisibilitySelectionMs: this.#lastVisibilitySelectionMs,
      lastRenderPreparationMs: this.#lastRenderPreparationMs,
      lastRenderCoordinatorMs: this.#lastRenderCoordinatorMs,
      lastSurfaceApplyMs: this.#lastSurfaceApplyMs,
      glyphCount: render?.glyphs ?? 0,
      pendingGlyphCount: render?.pendingGlyphs ?? 0,
      shapedLabels: render?.shapedLabels ?? 0,
      transformOnlyLabels: render?.transformOnlyLabels ?? 0,
      removedRenderLabels: render?.removedLabels ?? 0,
      staleRenderRevisions: render?.staleRevisions ?? 0,
      visibleLabelCount: this.#visibleCount,
      culledLabelCount: Math.max(0, store.size - this.#visibleCount),
      spatialIndexBytes: spatial.allocatedBytes,
      cullingQueries: spatial.queries,
      residencyRequested: this.#residencyRequested,
      residencyActive: this.#residencyActive,
      residencyFallbackReason: this.#residencyFallbackReason,
      gpuResidentLabels: this.#gpuResidentLabels,
      gpuScenePrototypeCount: this.#gpuScenePrototypeCount,
      gpuScenePaintCount: this.#gpuScenePaintCount,
      gpuScenePerLabelObjectCount:
        this.#residencyActive === "gpu-scene"
          ? (this.#gpuResidentScene?.stats.perLabelObjectCount ?? 0)
          : 0,
      deferredSpatialLabels: this.#spatial.deferredRehashCount,
      cullRecordUploadBytes: surface?.cullRecordUploadBytes ?? 0,
      lastSceneSetupMs: this.#lastSceneSetupMs,
      offscreenInspectedLabels: this.#lastOffscreenInspectedLabels,
      offscreenMaterializedLabels: this.#lastOffscreenMaterializedLabels,
      offscreenAdmissionDeferred: this.#offscreenAdmitDeferred,
      offscreenAdmissionGeneration: this.#offscreenAdmitGeneration,
      offscreenAdmissionCursor: this.#offscreenAdmitCursor?.index ?? 0,
      offscreenAdmissionCursorResets: this.#offscreenAdmitCursorResets,
      offscreenAdmissionCycles: this.#offscreenAdmitCycles,
      collisionEnabled: this.#collisionEnabled,
      collisionCandidateCount: this.#collisionCandidateCount,
      collisionVisibleLabelCount: this.#collisionVisibleLabelCount,
      collisionCulledLabelCount: this.#collisionCulledLabelCount,
      densityCulledLabelCount: this.#densityCulledLabelCount,
      collisionSelectionHash: this.#collisionSelectionHash,
      lastCollisionMs: this.#lastCollisionMs,
      collisionRecordBytes:
        (this.#priorities?.byteLength ?? 0) +
        this.#collisionRecords.byteLength +
        this.#collisionRecordValid.byteLength +
        (this.#collisionSelector?.allocatedBytes ?? 0),
      rendererAdapter: this.#renderer === undefined ? "detached" : (surface?.adapter ?? "unknown"),
      cullPath: surface?.cullPath ?? "cpu-grid",
      palettePath: surface?.palettePath ?? "texture",
      frameTransactionSubmissions: surface?.frameTransactionSubmissions ?? 0,
      frameTransactionFusedSubmissions: surface?.frameTransactionFusedSubmissions ?? 0,
      frameTransactionStandaloneSubmissions: surface?.frameTransactionStandaloneSubmissions ?? 0,
      drawCalls: surface?.meshes ?? 0,
      submittedGlyphs: surface?.submittedGlyphs ?? 0,
      atlasTextureCount: surface?.atlasTextures ?? 0,
      instanceUploadBytes: surface?.instanceUploadBytes ?? 0,
      transformUploadBytes: surface?.transformUploadBytes ?? 0,
      atlasUploadBytes: surface?.atlasUploadBytes ?? 0,
    });
  }

  /** Observe every resource release launched by {@link destroy}; rejects with the first failure. */
  whenDestroyed(): Promise<void> {
    return this.#teardown.promise;
  }

  /** Observe completion and the first failure from the latest renderer release. */
  whenRendererReleased(): Promise<void> {
    return this.#rendererRelease;
  }

  /** Release state, renderer associations, and PixiJS resources. */
  override destroy(options: DestroyOptions = { children: true }): void {
    if (this.#destroyStarted) return;
    this.#destroyStarted = true;
    this.#advanceRenderLifecycle();

    const residentScene = this.#gpuResidentScene;
    const surface = this.#renderSurface;
    const coordinator = this.#renderCoordinator;
    const collisionSelector = this.#collisionSelector;
    const pendingRenderResult = this.#detachPendingRenderResult();
    this.#renderer = undefined;
    this.#gpuResidentScene = undefined;
    this.#gpuSceneCompiler = undefined;
    this.#renderSurface = undefined;
    this.#renderCoordinator = undefined;
    this.#collisionSelector = undefined;
    this.#renderTail = Promise.resolve();
    this.#lastCommitPromise = Promise.resolve(this.#revision as TextRevision);
    this.#residencyActive = "viewport";
    this.#residencyFallbackReason = "renderer-unavailable";
    this.#gpuResidentLabels = 0;
    this.#gpuScenePrototypeCount = 0;
    this.#gpuScenePaintCount = 0;
    this.#trustedRuns.clear();
    this.#layouts.clear();
    this.#shaping.clear();
    this.#labelGroups.clear();
    this.#groups.clear();
    this.#priorities = undefined;
    this.#collisionRecords = new ArrayBuffer(0);
    this.#collisionRecordFloats = new Float32Array(0);
    this.#collisionRecordUints = new Uint32Array(0);
    this.#collisionRecordValid = new Uint8Array(0);
    this.#resetRenderedSet();

    let coordinatorTeardown: Promise<void> | undefined;
    const cleanupSteps: Array<() => void> = [];
    if (pendingRenderResult !== undefined) {
      cleanupSteps.push(() => releaseRenderExternalUploads(pendingRenderResult));
    }
    if (residentScene !== undefined) cleanupSteps.push(() => residentScene.destroy());
    if (surface !== undefined) cleanupSteps.push(() => surface.destroy());
    if (coordinator !== undefined) {
      cleanupSteps.push(() => {
        coordinatorTeardown = coordinator.destroy();
      });
    }
    cleanupSteps.push(() => this.fonts.destroy());
    if (collisionSelector !== undefined) cleanupSteps.push(() => collisionSelector.destroy());
    cleanupSteps.push(
      () => this.#spatial.destroy(),
      () => this.#store.dispose(),
      () => super.destroy(options),
    );
    const failure = cleanupBestEffort(cleanupSteps);

    settleControlledTeardown(this.#teardown, failure, coordinatorTeardown);
    if (failure !== undefined) throw failure.error;
  }

  #recordMutation(dirty: TextDirtyMask, count: number): void {
    if (count === 0 || dirty === TextDirty.None) {
      return;
    }

    this.#pendingMutations += count;
    this.#acceptedMutations += count;
  }

  #associateGroup(id: TextId, group: TextGroupId): void {
    this.#requireGroup(group).members.add(id);
    this.#labelGroups.set(id, group);
  }

  #moveGroup(id: TextId, group: TextGroupId | undefined): void {
    this.#detachGroup(id);
    if (group === undefined) {
      return;
    }
    this.#associateGroup(id, group);
  }

  #detachGroup(id: TextId): void {
    const group = this.#labelGroups.get(id);
    if (group === undefined) return;
    this.#groups.get(group)?.members.delete(id);
    this.#labelGroups.delete(id);
  }

  #requireGroup(group: TextGroupId): TextGroupState {
    const state = this.#groups.get(group);
    if (state === undefined) {
      throw new RangeError("Unknown or stale TextGroupId");
    }

    return state;
  }

  #isEffectivelyVisible(id: TextId, labelVisible: boolean): boolean {
    if (!labelVisible) return false;
    const group = this.#labelGroups.get(id);
    return group === undefined || this.#groups.get(group)?.visible === true;
  }

  #initializePriority(id: TextId, priority: number): void {
    const slot = this.#store.slotOf(id);
    if (slot === undefined) throw new Error("Created label slot is unavailable");
    const next = Math.fround(priority);
    this.#extendCollisionAdmissionOrder(slot, next);
    if (this.#priorities === undefined && next === 0) return;
    this.#ensurePriorityCapacity(this.#store.capacity);
    this.#priorities![slot] = next;
    this.#invalidateCollisionRecord(slot);
  }

  #setPriority(id: TextId, priority: number): boolean {
    const slot = this.#store.slotOf(id);
    if (slot === undefined) throw new RangeError(`Unknown or stale TextId: ${String(id)}`);
    return this.#setPriorityAt(slot, priority);
  }

  #setPriorityAt(slot: number, priority: number): boolean {
    const next = Math.fround(priority);
    const current = this.#priorities?.[slot] ?? 0;
    if (current === next) return false;
    if (this.#collisionEnabled) this.#collisionCandidatesRanked = false;
    this.#ensurePriorityCapacity(this.#store.capacity);
    this.#priorities![slot] = next;
    this.#invalidateCollisionRecord(slot);
    return true;
  }

  #extendCollisionAdmissionOrder(slot: number, priority: number): void {
    if (!this.#collisionEnabled || !this.#collisionCandidatesRanked) return;
    if (slot <= this.#collisionRankedHighSlot || priority > this.#collisionRankedLastPriority) {
      this.#collisionCandidatesRanked = false;
      return;
    }
    this.#collisionRankedHighSlot = slot;
    this.#collisionRankedLastPriority = priority;
  }

  #priorityOf(id: TextId): number {
    const slot = this.#store.slotOf(id);
    return slot === undefined ? 0 : (this.#priorities?.[slot] ?? 0);
  }

  #ensurePriorityCapacity(capacity: number): void {
    if (this.#priorities === undefined) {
      this.#priorities = new Float32Array(capacity);
      return;
    }
    if (this.#priorities.length < capacity) {
      this.#priorities = growFloat32Array(this.#priorities, capacity);
    }
  }

  #refreshCollisionTransform(): boolean {
    if (!this.#collisionEnabled) return false;
    const matrix = this.getGlobalTransform(this.#matrixScratch);
    const current = this.#collisionTransform;
    const changed =
      !this.#collisionTransformInitialized ||
      current.a !== matrix.a ||
      current.b !== matrix.b ||
      current.c !== matrix.c ||
      current.d !== matrix.d ||
      current.tx !== matrix.tx ||
      current.ty !== matrix.ty;
    if (!changed) return false;
    current.a = matrix.a;
    current.b = matrix.b;
    current.c = matrix.c;
    current.d = matrix.d;
    current.tx = matrix.tx;
    current.ty = matrix.ty;
    this.#collisionTransformInitialized = true;
    this.#collisionRecordValid.fill(0);
    this.#collisionSelector?.invalidateRunCache();
    return true;
  }

  #setAllVisible(visible: boolean): number {
    this.#assertActive();
    const changed = this.#store.setAllVisible(visible);
    if (changed === 0) return 0;
    this.#spatial.setAllVisible(visible);
    if (visible) {
      for (const state of this.#groups.values()) {
        if (state.visible) continue;
        for (const id of state.members) {
          const slot = this.#store.slotOf(id);
          if (slot !== undefined) this.#spatial.setVisible(slot, false);
        }
      }
    }
    this.#visibilityDirty = true;
    this.#recordMutation(TextDirty.Transform, changed);

    return changed;
  }

  #activateRendering(renderer: Renderer, priorTeardown?: Promise<void>): void {
    if (this.#renderingOptions === false) {
      const fallbackReason = this.#prepareResidencyCapability(renderer, undefined);
      this.#renderer = renderer;
      this.#residencyActive = "viewport";
      this.#residencyFallbackReason = fallbackReason;
      return;
    }
    const coordinator = createLayerRenderCoordinator(
      this.#renderingOptions,
      this.fonts,
      this.#renderLifecycleEpoch,
    );
    let surface: RenderSurface | undefined;
    try {
      if ("gl" in renderer || "gpu" in renderer) {
        surface = new RenderSurface(renderer, this, coordinator, {
          computeCull: this.#computeCull,
        });
      }
      const fallbackReason = this.#prepareResidencyCapability(renderer, surface);
      this.#renderer = renderer;
      this.#renderCoordinator = coordinator;
      this.#renderSurface = surface;
      this.#residencyActive = "viewport";
      this.#residencyFallbackReason = fallbackReason;
    } catch (error: unknown) {
      this.#renderer = undefined;
      this.#renderCoordinator = undefined;
      this.#renderSurface = undefined;
      this.#refreshResidencyCapability();
      this.#releaseRendererResources(
        { residentScene: undefined, surface, coordinator, pendingRenderResult: undefined },
        { error },
        priorTeardown,
      );
      throw error;
    }
  }

  #refreshResidencyCapability(): void {
    this.#residencyActive = "viewport";
    this.#residencyFallbackReason = this.#prepareResidencyCapability(
      this.#renderer,
      this.#renderSurface,
    );
  }

  #prepareResidencyCapability(
    renderer: Renderer | undefined,
    surface: RenderSurface | undefined,
  ): TextLayerResidencyFallbackReason | undefined {
    if (this.#residencyRequested === "viewport") {
      return undefined;
    }
    if (this.#collisionEnabled) {
      return "collision-enabled";
    }
    if (renderer === undefined) {
      return "renderer-unavailable";
    }
    if (!("gpu" in renderer)) {
      return "gl" in renderer ? "webgpu-required" : "renderer-unavailable";
    }
    return surface?.prepareGpuScene() ?? (surface === undefined ? "setup-failed" : undefined);
  }

  #advanceRenderLifecycle(): void {
    this.#renderLifecycleEpoch =
      this.#renderLifecycleEpoch === Number.MAX_SAFE_INTEGER ? 0 : this.#renderLifecycleEpoch + 1;
  }

  #isRenderContextCurrent(
    coordinator: RenderCoordinator | undefined,
    surface: RenderSurface | undefined,
    lifecycleEpoch: number,
  ): boolean {
    return (
      !this.#destroyStarted &&
      !this.destroyed &&
      lifecycleEpoch === this.#renderLifecycleEpoch &&
      coordinator === this.#renderCoordinator &&
      surface === this.#renderSurface
    );
  }

  #isGpuResidentWorkCurrent(
    coordinator: RenderCoordinator,
    surface: RenderSurface,
    lifecycleEpoch: number,
    residentEpoch: number,
  ): boolean {
    return (
      residentEpoch === this.#gpuResidentEpoch &&
      this.#isRenderContextCurrent(coordinator, surface, lifecycleEpoch)
    );
  }

  #indexLabel(
    id: TextId,
    label: Readonly<TextStoreSnapshot> | Parameters<TextStore["create"]>[0],
    runBounds?: BoundsData,
  ): void {
    const slot = this.#store.slotOf(id);
    if (slot === undefined) throw new Error("Label slot is unavailable for spatial indexing");
    this.#indexSlot(slot, id, label, runBounds);
  }

  #indexSlot(
    slot: number,
    id: TextId,
    label: Readonly<TextStoreSnapshot> | Parameters<TextStore["create"]>[0],
    runBounds?: BoundsData,
  ): void {
    this.#spatial.set(
      slot,
      this.#labelBounds(label, runBounds),
      label.zIndex,
      this.#isEffectivelyVisible(id, label.visible),
    );
    this.#invalidateCollisionRecord(slot);
  }

  #reindexCurrentSlot(
    slot: number,
    id: TextId,
    label: Readonly<TextStoreSnapshot> | Parameters<TextStore["create"]>[0],
    runBounds?: BoundsData,
  ): void {
    this.#spatial.updateCurrent(
      slot,
      this.#labelBounds(label, runBounds),
      label.zIndex,
      this.#isEffectivelyVisible(id, label.visible),
    );
    this.#invalidateCollisionRecord(slot);
  }

  #invalidateCollisionRecord(slot: number): void {
    this.#collisionSelector?.invalidateRecord(slot);
    if (slot < this.#collisionRecordValid.length) this.#collisionRecordValid[slot] = 0;
  }

  #invalidateCollisionRecords(slots: Uint32Array, count: number): void {
    this.#collisionSelector?.invalidateRecords(slots, count);
    const valid = this.#collisionRecordValid;
    for (let index = 0; index < count; index += 1) {
      const slot = slots[index] ?? 0;
      if (slot < valid.length) valid[slot] = 0;
    }
  }

  #labelBounds(
    label: Readonly<TextStoreSnapshot> | Parameters<TextStore["create"]>[0],
    runBounds?: BoundsData,
  ): Readonly<BoundsData> {
    if (runBounds !== undefined) {
      return transformedLabelBounds(label, runBounds, this.#boundsScratch);
    }
    if (label.text !== this.#estimateTextRef || label.style !== this.#estimateStyleRef) {
      estimateTextBounds(label.text, label.style, this.#estimateScratch);
      this.#estimateTextRef = label.text;
      this.#estimateStyleRef = label.style;
    }
    return transformedLabelBounds(label, this.#estimateScratch, this.#boundsScratch);
  }

  #syncSpatialOrigins(): void {
    const x = this.#store.xColumn;
    if (x === this.#boundOriginX) return;
    const y = this.#store.yColumn;
    this.#spatial.bindOrigins(x, y);
    this.#gpuResidentScene?.bindOriginColumns(x, y);
    this.#boundOriginX = x;
  }

  #ensureMoveCommands(count: number): ArrayBuffer {
    const bytes = count * PALETTE_MOVE_STRIDE;
    if (this.#moveCommands.byteLength >= bytes) return this.#moveCommands;
    let capacity = Math.max(64 * PALETTE_MOVE_STRIDE, this.#moveCommands.byteLength * 2);
    while (capacity < bytes) capacity *= 2;
    this.#moveCommands = new ArrayBuffer(capacity);
    return this.#moveCommands;
  }

  #ensureScratchCapacity(): void {
    const required = Math.max(this.#store.capacity, this.#spatial.capacity);
    if (this.#priorities !== undefined && this.#priorities.length < this.#store.capacity) {
      this.#priorities = growFloat32Array(this.#priorities, this.#store.capacity);
    }
    if (this.#visibleSlots.length >= required) return;
    this.#dirtyMasks = growTypedArray(this.#dirtyMasks, required);
    this.#positionOnly = growTypedArray(this.#positionOnly, required);
    this.#dirtySlots = growTypedArray(this.#dirtySlots, required);
    this.#visibleSlots = growTypedArray(this.#visibleSlots, required);
    this.#visibleMember = growTypedArray(this.#visibleMember, required);
    this.#renderedEpochs = growTypedArray(this.#renderedEpochs, required);
    this.#bulkSlots = growTypedArray(this.#bulkSlots, required);
    this.#laneSlots = growTypedArray(this.#laneSlots, required);
    this.#contentSlots = growTypedArray(this.#contentSlots, required);
    if (this.#cullRecordIndex.length < required) {
      const next = new Int32Array(required).fill(-1);
      next.set(this.#cullRecordIndex);
      this.#cullRecordIndex = next;
    }
  }

  #drawViewport(): CullViewport | undefined {
    return this.#viewportBounds === undefined
      ? undefined
      : viewportFromBounds(this.#viewportBounds, this.#cullingPadding);
  }

  #queryVisible(cullPath: CullPath, draw: CullViewport | undefined): number {
    this.#flushGpuResidentSpatialMoves();
    this.#clearVisibleMembership();
    const residency = cullResidency(this.#cullingEnabled, this.#viewportBounds !== undefined);
    let count: number;
    switch (residency) {
      case "all":
        this.#instancedViewport = undefined;
        count = this.#spatial.queryAll(this.#visibleSlots);
        break;
      case "viewport": {
        const bounds = this.#viewportBounds;
        if (bounds === undefined || draw === undefined) {
          throw new Error("Viewport residency requires culling bounds");
        }
        if (this.#collisionEnabled) {
          this.#instancedViewport = draw;
          count = this.#spatial.query(bounds, this.#visibleSlots, this.#cullingPadding);
          break;
        }
        switch (cullPath) {
          case "cpu-grid":
            this.#instancedViewport = draw;
            count = this.#spatial.query(bounds, this.#visibleSlots, this.#cullingPadding);
            break;
          case "compute-cull": {
            const working = expandWorkingSet(draw, Math.max(draw.width, draw.height));
            this.#instancedViewport = working;
            count = this.#spatial.query(working, this.#visibleSlots, 0);
            break;
          }
          default: {
            const _exhaustive: never = cullPath;
            return _exhaustive;
          }
        }
        break;
      }
      default: {
        const _exhaustive: never = residency;
        return _exhaustive;
      }
    }
    if (this.#collisionEnabled) count = this.#selectCollisionCandidates(count);
    this.#stampVisibleMembership(count);
    return count;
  }

  #selectCollisionCandidates(candidateCount: number): number {
    const selector = this.#collisionSelector;
    if (selector === undefined) throw new Error("Label collision selector is unavailable");
    const start = performance.now();
    this.#ensureCollisionRecordCapacity(this.#store.capacity);
    for (let index = 0; index < candidateCount; index += 1) {
      const slot = this.#visibleSlots[index];
      if (slot === undefined) throw new Error("Collision candidate slot is unavailable");
      if (this.#collisionRecordValid[slot] === 1) continue;
      const bounds = this.#spatial.get(slot, this.#boundsScratch);
      const order = this.#spatial.orderOf(slot);
      const zIndex = this.#spatial.zIndexOf(slot);
      if (bounds === undefined || order === undefined || zIndex === undefined) {
        throw new Error("Collision candidate metadata is unavailable");
      }
      const projected = projectLabelCollisionAabb(
        bounds,
        this.#collisionTransform,
        this.#collisionAabbScratch,
      );
      const record = this.#collisionRecordScratch;
      record.minX = projected.minX;
      record.minY = projected.minY;
      record.maxX = projected.maxX;
      record.maxY = projected.maxY;
      record.priority = this.#priorities?.[slot] ?? 0;
      record.zIndex = zIndex;
      record.order = order;
      record.slot = slot;
      writeLabelCollisionRecordAt(
        this.#collisionRecordFloats,
        this.#collisionRecordUints,
        slot,
        record,
      );
      this.#collisionRecordValid[slot] = 1;
    }
    const selected = this.#collisionCandidatesRanked
      ? selector.selectRankedCandidates(
          this.#collisionRecords,
          this.#visibleSlots,
          candidateCount,
          this.#visibleSlots,
        )
      : selector.selectCandidates(
          this.#collisionRecords,
          this.#visibleSlots,
          candidateCount,
          this.#visibleSlots,
        );
    this.#collisionCandidateCount = selected.candidateCount;
    this.#collisionVisibleLabelCount = selected.selectedCount;
    this.#collisionCulledLabelCount = selected.collisionCulledCount;
    this.#densityCulledLabelCount = selected.densityCulledCount;
    this.#collisionSelectionHash = selected.selectionHash;
    this.#lastCollisionMs = performance.now() - start;
    return selected.selectedCount;
  }

  #ensureCollisionRecordCapacity(count: number): void {
    if (this.#collisionRecords.byteLength >= count * LABEL_COLLISION_RECORD_STRIDE) return;
    let capacity = Math.max(64, this.#collisionRecords.byteLength / LABEL_COLLISION_RECORD_STRIDE);
    while (capacity < count) capacity *= 2;
    const records = new ArrayBuffer(capacity * LABEL_COLLISION_RECORD_STRIDE);
    new Uint8Array(records).set(new Uint8Array(this.#collisionRecords));
    const valid = new Uint8Array(capacity);
    valid.set(this.#collisionRecordValid);
    this.#collisionRecords = records;
    this.#collisionRecordFloats = new Float32Array(this.#collisionRecords);
    this.#collisionRecordUints = new Uint32Array(this.#collisionRecords);
    this.#collisionRecordValid = valid;
  }

  #buildComputeCullUpdate(
    coordinator: RenderCoordinator,
    changes: readonly LayerRenderChange[],
    laneSlots: Uint32Array | undefined,
    laneCount: number,
    contentSlots: Uint32Array | undefined,
    contentCount: number,
    draw: CullViewport | undefined,
    palettePath: PalettePath,
  ): RenderComputeCullUpdate {
    const gpuOwn = gpuOwnsCullBoxes({ palettePath, cullPath: "compute-cull" });
    const space: CullAabbSpace = gpuOwn ? "local" : "world";
    const states = coordinator.getDrawStates();
    let recordDirty: CullRecordDirty = "none";
    if (
      coordinator.drawListEpoch !== this.#cullRecordEpoch ||
      states.length < this.#cullRecordCount ||
      space !== this.#cullRecordSpace
    ) {
      this.#packCullRecords(coordinator, states, space);
      recordDirty = "all";
    } else {
      const ranges = this.#cullRecordDirtyScratch;
      ranges.length = 0;
      const patched = this.#patchCullRecords(coordinator, changes, space, gpuOwn);
      if (patched !== undefined) ranges.push(patched);
      if (
        laneSlots !== undefined &&
        laneCount > 0 &&
        shouldPatchComputeCullLane({ gpuOwnsCullBoxes: gpuOwn, localBoxChanged: false })
      ) {
        const lanePatched = this.#patchLaneCullRecords(coordinator, laneSlots, laneCount, space);
        if (lanePatched !== undefined) ranges.push(lanePatched);
      }
      if (contentSlots !== undefined && contentCount > 0) {
        const contentLocalChanged = this.#contentLaneLocalChanged(
          contentSlots,
          contentCount,
          space,
        );
        if (
          shouldPatchComputeCullLane({
            gpuOwnsCullBoxes: gpuOwn,
            localBoxChanged: contentLocalChanged,
          })
        ) {
          const contentPatched = this.#patchLaneCullRecords(
            coordinator,
            contentSlots,
            contentCount,
            space,
          );
          if (contentPatched !== undefined) ranges.push(contentPatched);
        }
      }
      if (states.length > this.#cullRecordCount) {
        ranges.push(this.#appendCullRecords(coordinator, states, space));
      }
      if (ranges.length > 0) recordDirty = ranges;
    }
    return {
      records: this.#cullRecords,
      recordCount: this.#cullRecordCount,
      recordDirty,
      viewport: draw ?? FULL_CULL_VIEWPORT,
      aabbSpace: space,
      ...(gpuOwn && (laneCount > 0 || contentCount > 0) ? { recompute: true } : {}),
    };
  }

  #packCullRecords(
    coordinator: RenderCoordinator,
    states: readonly Readonly<RenderDrawState>[],
    space: CullAabbSpace,
  ): void {
    this.#clearCullRecordIndex();
    this.#ensureCullRecordCapacity(states.length);
    this.#writeCullRecords(coordinator, states, 0, space);
    this.#cullRecordCount = states.length;
    this.#cullRecordEpoch = coordinator.drawListEpoch;
    this.#cullRecordSpace = space;
  }

  /** While the draw-list epoch holds, states only append, so the packed prefix stays valid. */
  #appendCullRecords(
    coordinator: RenderCoordinator,
    states: readonly Readonly<RenderDrawState>[],
    space: CullAabbSpace,
  ): DirtyByteRange {
    const start = this.#cullRecordCount;
    this.#ensureCullRecordCapacity(states.length);
    this.#writeCullRecords(coordinator, states, start, space);
    this.#cullRecordCount = states.length;
    return {
      offset: start * CULL_RECORD_STRIDE,
      length: (states.length - start) * CULL_RECORD_STRIDE,
    };
  }

  #writeCullRecords(
    coordinator: RenderCoordinator,
    states: readonly Readonly<RenderDrawState>[],
    start: number,
    space: CullAabbSpace,
  ): void {
    for (let index = start; index < states.length; index += 1) {
      const state = states[index];
      if (state === undefined) throw new Error("Draw state list is incomplete");
      const range = coordinator.instances.getRange(state.slot);
      if (range === undefined) {
        throw new Error(`Cull instance range ${String(state.slot)} is unavailable`);
      }
      const box = this.#cullRecordAabb(state.slot, space);
      if (box === undefined) {
        throw new Error(`Cull bounds ${String(state.slot)} are unavailable`);
      }
      writeCullRecordAt(this.#cullRecordFloats, this.#cullRecordUints, index, {
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
        instanceOffset: range.offset,
        instanceCount: range.count,
        paletteIndex: state.slot,
      });
      this.#cullRecordSlots[index] = state.slot;
      this.#cullRecordIndex[state.slot] = index;
    }
  }

  /** Content edits can relocate instance ranges, so patches rewrite the whole record. */
  #patchCullRecords(
    coordinator: RenderCoordinator,
    changes: readonly LayerRenderChange[],
    space: CullAabbSpace,
    gpuOwn: boolean,
  ): DirtyByteRange | undefined {
    if (this.#cullRecordCount === 0) return undefined;
    let first = -1;
    let last = -1;
    for (const change of changes) {
      if (change.snapshot === undefined) continue;
      if (gpuOwn && change.positionOnly === true && (change.mask & TextDirty.Content) === 0) {
        continue;
      }
      const index = this.#cullRecordIndex[change.slot] ?? -1;
      if (index < 0) continue;
      const range = coordinator.instances.getRange(change.slot);
      if (range === undefined) continue;
      const box = this.#cullRecordAabb(change.slot, space);
      if (box === undefined) continue;
      writeCullRecordAt(this.#cullRecordFloats, this.#cullRecordUints, index, {
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
        instanceOffset: range.offset,
        instanceCount: range.count,
        paletteIndex: change.slot,
      });
      if (first < 0 || index < first) first = index;
      if (index > last) last = index;
    }
    if (first < 0) return undefined;
    return {
      offset: first * CULL_RECORD_STRIDE,
      length: (last - first + 1) * CULL_RECORD_STRIDE,
    };
  }

  #patchLaneCullRecords(
    coordinator: RenderCoordinator,
    laneSlots: Uint32Array,
    laneCount: number,
    space: CullAabbSpace,
  ): DirtyByteRange | undefined {
    if (this.#cullRecordCount === 0) return undefined;
    let first = -1;
    let last = -1;
    for (let position = 0; position < laneCount; position += 1) {
      const slot = laneSlots[position] ?? 0;
      const index = this.#cullRecordIndex[slot] ?? -1;
      if (index < 0) continue;
      const range = coordinator.instances.getRange(slot);
      if (range === undefined) continue;
      const box = this.#cullRecordAabb(slot, space);
      if (box === undefined) continue;
      writeCullRecordAt(this.#cullRecordFloats, this.#cullRecordUints, index, {
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
        instanceOffset: range.offset,
        instanceCount: range.count,
        paletteIndex: slot,
      });
      if (first < 0 || index < first) first = index;
      if (index > last) last = index;
    }
    if (first < 0) return undefined;
    return {
      offset: first * CULL_RECORD_STRIDE,
      length: (last - first + 1) * CULL_RECORD_STRIDE,
    };
  }

  #cullRecordAabb(
    slot: number,
    space: CullAabbSpace,
  ): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
    switch (space) {
      case "local": {
        const local = this.#spatial.getLocal(slot, this.#boundsScratch);
        if (local === undefined) return undefined;
        return {
          minX: local.x,
          minY: local.y,
          maxX: addF32(local.x, local.width),
          maxY: addF32(local.y, local.height),
        };
      }
      case "world": {
        const box = this.#spatial.get(slot, this.#boundsScratch);
        if (box === undefined) return undefined;
        return {
          minX: box.x,
          minY: box.y,
          maxX: addF32(box.x, box.width),
          maxY: addF32(box.y, box.height),
        };
      }
      default: {
        const _exhaustive: never = space;
        return _exhaustive;
      }
    }
  }

  #contentLaneLocalChanged(
    contentSlots: Uint32Array,
    contentCount: number,
    space: CullAabbSpace,
  ): boolean {
    if (space === "world") return true;
    for (let position = 0; position < contentCount; position += 1) {
      const slot = contentSlots[position] ?? 0;
      const index = this.#cullRecordIndex[slot] ?? -1;
      if (index < 0) continue;
      const local = this.#spatial.getLocal(slot, this.#boundsScratch);
      if (local === undefined) return true;
      return !cullRecordMatchesLocal(this.#cullRecordFloats, index, local);
    }
    return false;
  }

  #ensureCullRecordCapacity(count: number): void {
    if (this.#cullRecordSlots.length >= count) return;
    let capacity = Math.max(64, this.#cullRecordSlots.length * 2);
    while (capacity < count) capacity *= 2;
    const next = new ArrayBuffer(capacity * CULL_RECORD_STRIDE);
    const nextFloats = new Float32Array(next);
    nextFloats.set(this.#cullRecordFloats);
    this.#cullRecords = next;
    this.#cullRecordFloats = nextFloats;
    this.#cullRecordUints = new Uint32Array(next);
    const nextSlots = new Uint32Array(capacity);
    nextSlots.set(this.#cullRecordSlots);
    this.#cullRecordSlots = nextSlots;
  }

  #clearCullRecordIndex(): void {
    for (let index = 0; index < this.#cullRecordCount; index += 1) {
      const slot = this.#cullRecordSlots[index];
      if (slot !== undefined) this.#cullRecordIndex[slot] = -1;
    }
    this.#cullRecordCount = 0;
  }

  #resolveCullPath(): CullPath {
    if (!this.#cullingEnabled || this.#collisionEnabled) return "cpu-grid";
    return this.#renderSurface?.prepareCullPath() ?? "cpu-grid";
  }

  #buildResidentDirtyChanges(
    admit: AdmitCollector,
    budget: OffscreenAdmitBudget,
  ): {
    changes: LayerRenderChange[];
    laneCount: number;
    contentCount: number;
    contentText: string | undefined;
    contentStyle: Readonly<TextStyleOptions> | undefined;
  } {
    const changes: LayerRenderChange[] = [];
    let laneCount = 0;
    let contentCount = 0;
    let contentText: string | undefined;
    let contentStyle: Readonly<TextStyleOptions> | undefined;
    let contentMixed = false;
    const objectTightPairs = new WeakMap<Readonly<TextStyleOptions>, Set<string>>();
    const epoch = this.#renderEpoch;
    if (epoch === 0) {
      return { changes, laneCount, contentCount, contentText, contentStyle };
    }
    const cullPath = this.#resolveCullPath();
    const draw = this.#drawViewport();
    const ring = draw === undefined ? undefined : expandPrepareRing(draw);
    const coordinator = this.#renderCoordinator;
    for (let index = 0; index < this.#dirtyLength; index += 1) {
      const slot = this.#dirtySlots[index];
      if (slot === undefined) throw new Error("Dirty slot list is incomplete");
      const rendered = this.#renderedEpochs[slot] === epoch;
      if (this.#shouldDropLod(slot)) {
        if (rendered) {
          this.#renderedEpochs[slot] = 0;
          changes.push({
            slot,
            mask: ALL_DIRTY,
            snapshot: undefined,
            ...(cullPath === "compute-cull" ? { retainResources: true } : {}),
          });
        } else {
          this.#adoptVisibleResident(slot, cullPath, draw);
        }
        continue;
      }
      if (!rendered) {
        const admission = this.#unrenderedAdmission(slot, cullPath, ring, draw);
        if (admission.inResidency) this.#adoptVisibleSlot(slot);
        if (this.#positionOnly[slot] === 1 || !admission.shouldDraw) continue;
        const tight = cullPath === "cpu-grid" || this.#slotIntersectsTight(slot, draw);
        if (!tight) continue;
        if (this.#collectAdmit(slot, admit, true)) continue;
        this.#rememberContentPair(objectTightPairs, slot);
        const change = this.#renderChangeForSlot(
          slot,
          false,
          coordinator?.getRun(slot) !== undefined,
        );
        if (change !== undefined) {
          this.#renderedEpochs[slot] = epoch;
          changes.push(change);
        }
        continue;
      }
      // Rendered position-only movers take the columnar lane instead of the object pipeline.
      if (this.#positionOnly[slot] === 1 && this.#dirtyMasks[slot] === TextDirty.Transform) {
        this.#laneSlots[laneCount] = slot;
        laneCount += 1;
        continue;
      }
      if (!contentMixed && this.#isContentLaneCandidate(slot)) {
        const text = this.#store.textAt(slot);
        const style = this.#store.styleAt(slot);
        if (text === undefined || style === undefined) {
          contentMixed = true;
        } else if (contentText === undefined) {
          contentText = text;
          contentStyle = style;
          this.#contentSlots[contentCount] = slot;
          contentCount += 1;
          continue;
        } else if (text === contentText && style === contentStyle) {
          this.#contentSlots[contentCount] = slot;
          contentCount += 1;
          continue;
        } else {
          contentMixed = true;
        }
      }
      const change = this.#renderChangeForSlot(slot, true);
      if (change !== undefined) changes.push(change);
    }
    if (cullPath === "compute-cull" && ring !== undefined) {
      this.#scanFirstSeenQuery(ring, false, admit, epoch, changes, objectTightPairs, budget);
    }
    if (contentMixed && contentCount > 0) {
      for (let index = 0; index < contentCount; index += 1) {
        const slot = this.#contentSlots[index];
        if (slot === undefined) continue;
        const change = this.#renderChangeForSlot(slot, true);
        if (change !== undefined) changes.push(change);
      }
      return {
        changes,
        laneCount,
        contentCount: 0,
        contentText: undefined,
        contentStyle: undefined,
      };
    }
    return { changes, laneCount, contentCount, contentText, contentStyle };
  }

  #isAdmitLaneCandidate(slot: number): boolean {
    if (!this.#store.admitLaneAt(slot)) return false;
    const id = this.#store.idAt(slot);
    if (id === undefined) return false;
    return !this.#layouts.has(id) && !this.#shaping.has(id) && !this.#trustedRuns.has(id);
  }

  #collectAdmit(slot: number, admit: AdmitCollector, tight: boolean): boolean {
    if (admit.collected.has(slot)) return true;
    if (!this.#isAdmitLaneCandidate(slot)) return false;
    const text = this.#store.textAt(slot);
    const style = this.#store.styleAt(slot);
    if (text === undefined || style === undefined) return false;
    let byText = admit.byStyle.get(style);
    if (byText === undefined) {
      byText = new Map();
      admit.byStyle.set(style, byText);
    }
    let draft = byText.get(text);
    if (draft === undefined) {
      draft = { text, style, slots: [], tightSlots: [], offscreenSlots: [] };
      byText.set(text, draft);
      admit.drafts.push(draft);
    }
    admit.collected.add(slot);
    (tight ? draft.tightSlots : draft.offscreenSlots).push(slot);
    return true;
  }

  #publishAdmitGroups(drafts: readonly AdmitDraft[]): AdmitLaneGroup[] {
    const groups: AdmitLaneGroup[] = [];
    for (const draft of drafts) {
      const count = draft.slots.length;
      if (count <= 0) continue;
      const slots = Uint32Array.from(draft.slots);
      slots.sort();
      const xy = new Float32Array(count * 2);
      this.#store.positionsInto(slots, count, xy);
      const orders = new Uint32Array(count);
      for (let index = 0; index < count; index += 1) {
        const slot = slots[index];
        if (slot === undefined) throw new Error("Admit group slot list is incomplete");
        const order = this.#spatial.orderOf(slot);
        if (order === undefined) throw new Error("Admit group order is unavailable");
        orders[index] = order;
      }
      groups.push({
        slots,
        count,
        xy,
        orders,
        text: draft.text,
        style: draft.style,
        ...(this.#renderCoordinator?.outlineEnabled === true
          ? {
              projectedHeightPx:
                resolvePositiveStyleNumber(draft.style.fontSize, 26) * this.#outlineWorldScaleY,
            }
          : {}),
      });
    }
    return groups;
  }

  #isContentLaneCandidate(slot: number): boolean {
    const mask = this.#dirtyMasks[slot] ?? TextDirty.None;
    if ((mask & TextDirty.Content) === 0 || (mask & TextDirty.Style) !== 0) return false;
    if ((mask & TextDirty.Transform) !== 0 && this.#positionOnly[slot] !== 1) return false;
    if (!this.#store.anchorsZeroAt(slot) || !this.#store.unitTransformAt(slot)) return false;
    const id = this.#store.idAt(slot);
    if (id === undefined) return false;
    return !this.#layouts.has(id) && !this.#shaping.has(id) && !this.#trustedRuns.has(id);
  }

  #buildUnshapedFirstSeen(
    admit: AdmitCollector,
    draw: CullViewport,
    ring: CullViewport | undefined,
    budget: OffscreenAdmitBudget,
  ): LayerRenderChange[] {
    const epoch = this.#renderEpoch;
    const changes: LayerRenderChange[] = [];
    const objectTightPairs = new WeakMap<Readonly<TextStyleOptions>, Set<string>>();
    this.#scanFirstSeenQuery(draw, true, admit, epoch, changes, objectTightPairs, budget);
    if (ring !== undefined) {
      this.#preparedRing = ring;
      this.#scanFirstSeenQuery(ring, false, admit, epoch, changes, objectTightPairs, budget);
    }
    return changes;
  }

  #scanFirstSeenQuery(
    query: CullViewport,
    tight: boolean,
    admit: AdmitCollector,
    epoch: number,
    changes: LayerRenderChange[],
    objectTightPairs: WeakMap<Readonly<TextStyleOptions>, Set<string>>,
    budget: OffscreenAdmitBudget,
  ): void {
    if (!tight && budget.remainingInspections <= 0) {
      budget.deferred = true;
      return;
    }
    this.#ensureScratchCapacity();
    const count = this.#spatial.query(query, this.#bulkSlots, 0);
    const window = tight
      ? { start: 0, end: count, deferred: false }
      : this.#planOffscreenAdmissionWindow(query, count, budget);
    if (!tight) {
      this.#lastOffscreenInspectedLabels += window.end - window.start;
    }
    const coordinator = this.#renderCoordinator;
    for (let index = window.start; index < window.end; index += 1) {
      const slot = this.#bulkSlots[index];
      if (slot === undefined) throw new Error("First-seen slot list is incomplete");
      if (this.#shouldDropLod(slot)) continue;
      if (epoch !== 0 && this.#renderedEpochs[slot] === epoch) continue;
      if (coordinator?.getRun(slot) !== undefined) continue;
      if (this.#collectAdmit(slot, admit, tight)) continue;
      if (!tight && !this.#objectRingAdmits(slot, objectTightPairs)) continue;
      if (!tight && !tryAdmitOffscreen(budget)) continue;
      const change = this.#renderChangeForSlot(slot, false, false);
      if (change === undefined) continue;
      if (tight) this.#rememberContentPair(objectTightPairs, slot);
      else this.#lastOffscreenMaterializedLabels += 1;
      if (epoch !== 0) this.#renderedEpochs[slot] = epoch;
      changes.push(change);
    }
  }

  #planOffscreenAdmissionWindow(
    ring: CullViewport,
    candidateCount: number,
    budget: OffscreenAdmitBudget,
  ): ReturnType<typeof planOffscreenAdmissionWindow> {
    if (
      this.#offscreenAdmitRevision !== this.#revision ||
      !cullViewportsEqual(this.#offscreenAdmitRing, ring)
    ) {
      this.#offscreenAdmitGeneration =
        this.#offscreenAdmitGeneration === Number.MAX_SAFE_INTEGER
          ? 0
          : this.#offscreenAdmitGeneration + 1;
      this.#offscreenAdmitRing = ring;
      this.#offscreenAdmitRevision = this.#revision;
    }
    const window = planBudgetedOffscreenAdmissionWindow({
      generation: this.#offscreenAdmitGeneration,
      cursor: this.#offscreenAdmitCursor,
      candidateCount,
      budget,
    });
    this.#offscreenAdmitCursor = window.nextCursor;
    if (window.reset) this.#offscreenAdmitCursorResets += 1;
    if (window.completedCycle) this.#offscreenAdmitCycles += 1;
    return window;
  }

  #invalidateOffscreenAdmission(): void {
    this.#offscreenAdmitRevision = -1;
    this.#offscreenAdmitRing = undefined;
    this.#offscreenAdmitCursor = undefined;
  }

  #buildRenderChanges(
    cullPath: CullPath,
    draw: CullViewport | undefined,
    admit: AdmitCollector,
    budget: OffscreenAdmitBudget,
    forceSourceRefresh = false,
  ): { changes: LayerRenderChange[]; laneCount: number } {
    let previousEpoch = this.#renderEpoch;
    if (previousEpoch === 0xffff_ffff) {
      this.#renderedEpochs.fill(0);
      previousEpoch = 0;
    }
    const nextEpoch = previousEpoch + 1;
    const coordinator = this.#renderCoordinator;
    const changes: LayerRenderChange[] = [];
    let laneCount = 0;
    const ring = draw === undefined ? undefined : expandPrepareRing(draw);
    this.#preparedRing = cullPath === "compute-cull" ? ring : undefined;
    const objectRing: number[] = [];
    const objectTightPairs = new WeakMap<Readonly<TextStyleOptions>, Set<string>>();
    if (cullPath === "compute-cull" && draw !== undefined) {
      this.#scanFirstSeenQuery(draw, true, admit, nextEpoch, changes, objectTightPairs, budget);
    }
    for (let index = 0; index < this.#visibleCount; index += 1) {
      const slot = this.#visibleSlots[index];
      if (slot === undefined) throw new Error("Visible slot list is incomplete");
      const wasRendered = previousEpoch !== 0 && this.#renderedEpochs[slot] === previousEpoch;
      const dirtyMask = this.#dirtyMasks[slot] ?? TextDirty.None;
      const hasRun = coordinator?.getRun(slot) !== undefined;
      if (this.#shouldDropLod(slot)) continue;
      if (!hasRun && cullPath === "compute-cull") continue;
      if (!hasRun && !this.#unshapedVisible(slot, cullPath, ring)) continue;
      if (!hasRun && this.#collectAdmit(slot, admit, true)) continue;
      if (!hasRun && !this.#slotIntersectsTight(slot, draw)) {
        objectRing.push(slot);
        continue;
      }
      this.#renderedEpochs[slot] = nextEpoch;
      if (!hasRun) this.#rememberContentPair(objectTightPairs, slot);
      if (
        !forceSourceRefresh &&
        (wasRendered || hasRun) &&
        this.#positionOnly[slot] === 1 &&
        dirtyMask === TextDirty.Transform
      ) {
        this.#laneSlots[laneCount] = slot;
        laneCount += 1;
        continue;
      }
      if (!forceSourceRefresh && wasRendered && dirtyMask === TextDirty.None) continue;
      const change = this.#renderChangeForSlot(slot, wasRendered, hasRun, forceSourceRefresh);
      if (change === undefined) throw new Error("Visible label snapshot is unavailable");
      changes.push(change);
    }
    if (cullPath === "compute-cull" && ring !== undefined) {
      this.#scanFirstSeenQuery(ring, false, admit, nextEpoch, changes, objectTightPairs, budget);
    }
    this.#finalizeAdmitDrafts(admit, nextEpoch, budget);
    this.#admitObjectRing(objectRing, objectTightPairs, nextEpoch, changes, budget);
    for (const state of coordinator?.getDrawStates() ?? []) {
      if (this.#renderedEpochs[state.slot] === nextEpoch) continue;
      const gone = !this.#store.occupiedAt(state.slot);
      changes.push({
        slot: state.slot,
        mask: ALL_DIRTY,
        snapshot: undefined,
        ...(cullPath === "compute-cull" && !gone ? { retainResources: true } : {}),
      });
    }
    this.#renderEpoch = nextEpoch;

    return { changes, laneCount };
  }

  #materializeResidentPositionLease(batch: Readonly<TextStoreResidentPositionUpdates>): void {
    this.#ensureScratchCapacity();
    for (let index = 0; index < batch.count; index += 1) {
      const slot = batch.slots[index] ?? 0;
      const previous = this.#dirtyMasks[slot] ?? TextDirty.None;
      const transformStayedPositionOnly =
        (previous & TextDirty.Transform) === 0 || this.#positionOnly[slot] === 1;
      if (previous === TextDirty.None) {
        this.#dirtySlots[this.#dirtyLength] = slot;
        this.#dirtyLength += 1;
      }
      this.#dirtyMasks[slot] = previous | TextDirty.Transform;
      this.#positionOnly[slot] = Number(transformStayedPositionOnly);
    }
    this.#store.releaseResidentPositionUpdates(batch);
  }

  #clearDirtyMasks(): void {
    for (let index = 0; index < this.#dirtyLength; index += 1) {
      const slot = this.#dirtySlots[index];
      if (slot !== undefined) {
        this.#dirtyMasks[slot] = TextDirty.None;
        this.#positionOnly[slot] = 0;
      }
    }
    this.#dirtyLength = 0;
  }

  #resetRenderedSet(): void {
    this.#renderedEpochs.fill(0);
    this.#renderEpoch = 0;
    this.#instancedViewport = undefined;
    this.#preparedRing = undefined;
    this.#offscreenAdmitDeferred = false;
    this.#invalidateOffscreenAdmission();
    this.#clearCullRecordIndex();
    this.#cullRecordEpoch = -1;
    this.#cullRecordSpace = "world";
    this.#visibilityDirty = true;
  }

  #renderChangeForSlot(
    slot: number,
    wasRendered: boolean,
    hasRun = false,
    forceSourceRefresh = false,
  ): LayerRenderChange | undefined {
    const snapshot = this.#store.snapshotAt(slot);
    if (snapshot === undefined) return undefined;
    const order = this.#spatial.orderOf(slot);
    if (order === undefined) throw new Error("Visible label order is unavailable");
    const trustedRun = this.#trustedRuns.get(snapshot.id);
    const dirtyMask = this.#dirtyMasks[slot] ?? TextDirty.None;
    const refreshOutlineTransform =
      this.#renderCoordinator?.outlineEnabled === true &&
      this.#positionOnly[slot] !== 1 &&
      (dirtyMask & TextDirty.Transform) !== 0;
    const mask =
      forceSourceRefresh || refreshOutlineTransform
        ? dirtyMask | TextDirty.Style
        : wasRendered || hasRun
          ? dirtyMask === TextDirty.None
            ? TextDirty.Transform
            : dirtyMask
          : ALL_DIRTY;
    return {
      slot,
      labelId: snapshot.id,
      mask,
      snapshot: toRenderSnapshot(
        snapshot,
        order,
        this.#layouts.get(snapshot.id),
        this.#shaping.get(snapshot.id),
        this.#outlineWorldScaleY,
      ),
      ...(trustedRun === undefined ? {} : { trustedRun }),
      ...(wasRendered && this.#positionOnly[slot] === 1 ? { positionOnly: true } : {}),
    };
  }

  #unshapedVisible(slot: number, cullPath: CullPath, ring: CullViewport | undefined): boolean {
    const box = this.#spatial.get(slot, this.#boundsScratch);
    if (box === undefined) return false;
    return shouldInstanceUnshaped({
      cullPath,
      ring,
      minX: box.x,
      minY: box.y,
      maxX: addF32(box.x, box.width),
      maxY: addF32(box.y, box.height),
    });
  }

  #slotIntersectsTight(slot: number, draw: CullViewport | undefined): boolean {
    if (draw === undefined) return true;
    const box = this.#spatial.get(slot, this.#boundsScratch);
    if (box === undefined) return false;
    return aabbVisible(box.x, box.y, addF32(box.x, box.width), addF32(box.y, box.height), draw);
  }

  #internedAt(slot: number): boolean {
    const coordinator = this.#renderCoordinator;
    if (coordinator === undefined) return false;
    const text = this.#store.textAt(slot);
    const style = this.#store.styleAt(slot);
    if (text === undefined || style === undefined) return false;
    const id = this.#store.idAt(slot);
    const layout = id === undefined ? undefined : this.#layouts.get(id);
    const shaping = id === undefined ? undefined : this.#shaping.get(id);
    return coordinator.hasInternedLayout({
      text,
      style,
      ...(layout === undefined ? {} : { layout }),
      ...(shaping === undefined ? {} : { shaping }),
    });
  }

  #rememberContentPair(
    pairs: WeakMap<Readonly<TextStyleOptions>, Set<string>>,
    slot: number,
  ): void {
    const text = this.#store.textAt(slot);
    const style = this.#store.styleAt(slot);
    if (text === undefined || style === undefined) return;
    let texts = pairs.get(style);
    if (texts === undefined) {
      texts = new Set();
      pairs.set(style, texts);
    }
    texts.add(text);
  }

  #objectRingAdmits(
    slot: number,
    pairs: WeakMap<Readonly<TextStyleOptions>, Set<string>>,
  ): boolean {
    if (this.#internedAt(slot)) return true;
    const text = this.#store.textAt(slot);
    const style = this.#store.styleAt(slot);
    if (text === undefined || style === undefined) return false;
    return pairs.get(style)?.has(text) === true;
  }

  #admitObjectRing(
    slots: readonly number[],
    pairs: WeakMap<Readonly<TextStyleOptions>, Set<string>>,
    epoch: number,
    changes: LayerRenderChange[],
    budget: OffscreenAdmitBudget,
  ): void {
    for (const slot of slots) {
      if (!this.#objectRingAdmits(slot, pairs)) continue;
      if (!tryAdmitOffscreen(budget)) continue;
      const change = this.#renderChangeForSlot(slot, false, false);
      if (change === undefined) continue;
      this.#lastOffscreenMaterializedLabels += 1;
      if (epoch !== 0) this.#renderedEpochs[slot] = epoch;
      changes.push(change);
    }
  }

  #finalizeAdmitDrafts(admit: AdmitCollector, epoch: number, budget: OffscreenAdmitBudget): void {
    if (admit.drafts.length === 0) return;
    const kept: AdmitDraft[] = [];
    for (const draft of admit.drafts) {
      const slots = draft.tightSlots;
      const admitOffscreen =
        slots.length > 0 ||
        (this.#renderCoordinator?.hasInternedLayout({
          text: draft.text,
          style: draft.style,
        }) ??
          false);
      for (const slot of draft.offscreenSlots) {
        if (!admitOffscreen || !tryAdmitOffscreen(budget)) {
          admit.collected.delete(slot);
          continue;
        }
        slots.push(slot);
        this.#lastOffscreenMaterializedLabels += 1;
      }
      if (slots.length === 0) {
        admit.byStyle.get(draft.style)?.delete(draft.text);
        continue;
      }
      draft.slots = slots;
      draft.tightSlots = [];
      draft.offscreenSlots = [];
      for (const slot of slots) {
        if (epoch !== 0) this.#renderedEpochs[slot] = epoch;
      }
      kept.push(draft);
    }
    admit.drafts.length = 0;
    for (const draft of kept) admit.drafts.push(draft);
  }

  #isSlotEffectivelyVisible(slot: number): boolean {
    const snapshot = this.#store.snapshotAt(slot);
    return snapshot !== undefined && this.#isEffectivelyVisible(snapshot.id, snapshot.visible);
  }

  #unrenderedAdmission(
    slot: number,
    cullPath: CullPath,
    ring: CullViewport | undefined,
    draw: CullViewport | undefined,
  ): { inResidency: boolean; shouldDraw: boolean } {
    if (!this.#isSlotEffectivelyVisible(slot)) return { inResidency: false, shouldDraw: false };
    const box = this.#spatial.get(slot, this.#boundsScratch);
    if (box === undefined) return { inResidency: false, shouldDraw: false };
    const minX = box.x;
    const minY = box.y;
    const maxX = addF32(box.x, box.width);
    const maxY = addF32(box.y, box.height);
    switch (cullPath) {
      case "cpu-grid": {
        const inResidency = draw === undefined || aabbVisible(minX, minY, maxX, maxY, draw);
        return { inResidency, shouldDraw: inResidency };
      }
      case "compute-cull": {
        const working = this.#instancedViewport;
        const inResidency = working !== undefined && aabbVisible(minX, minY, maxX, maxY, working);
        const shouldDraw =
          inResidency && ring !== undefined && aabbVisible(minX, minY, maxX, maxY, ring);
        return { inResidency, shouldDraw };
      }
      default: {
        const _exhaustive: never = cullPath;
        return _exhaustive;
      }
    }
  }

  #adoptVisibleResident(slot: number, cullPath: CullPath, draw: CullViewport | undefined): void {
    if (!this.#unrenderedAdmission(slot, cullPath, undefined, draw).inResidency) return;
    this.#adoptVisibleSlot(slot);
  }

  #adoptVisibleSlot(slot: number): void {
    if (this.#visibleMember[slot] === 1) return;
    this.#visibleMember[slot] = 1;
    this.#visibleSlots[this.#visibleCount] = slot;
    this.#visibleCount += 1;
  }

  #clearVisibleMembership(): void {
    for (let index = 0; index < this.#visibleCount; index += 1) {
      const slot = this.#visibleSlots[index];
      if (slot !== undefined) this.#visibleMember[slot] = 0;
    }
  }

  #stampVisibleMembership(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const slot = this.#visibleSlots[index];
      if (slot !== undefined) this.#visibleMember[slot] = 1;
    }
  }

  #shouldDropLod(slot: number): boolean {
    if (!this.#lod) return false;
    if (!this.#store.copyBoundsLabelAt(slot, this.#labelScratch)) return false;
    return shouldDropSubpixelLod({
      fontSize: resolvePositiveStyleNumber(this.#labelScratch.style.fontSize, 26),
      scaleY: this.#labelScratch.scaleY,
      worldScaleY: this.#lodWorldScaleY,
    });
  }

  #worldScaleY(): number {
    const matrix = this.getGlobalTransform(this.#matrixScratch);
    const scale = Math.hypot(matrix.c, matrix.d);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  #projectedWorldScaleY(): number {
    const resolution = this.#renderer?.resolution ?? 1;
    return this.#worldScaleY() * (Number.isFinite(resolution) && resolution > 0 ? resolution : 1);
  }

  #assertTrustedRunSource(
    snapshot: Pick<TextLabelSnapshot, "text">,
    input: Pick<TrustedGlyphRunInput, "text" | "fontFamily" | "fontRevision">,
  ): void {
    if (input.text !== snapshot.text) {
      throw new RangeError("Trusted glyph run text differs from the current label text");
    }
    const registered = this.fonts.get(input.fontFamily);
    const currentRevision = registered?.revision ?? 0;
    if (input.fontRevision !== currentRevision) {
      throw new RangeError(
        `Trusted glyph run font revision ${String(input.fontRevision)} is stale; current revision is ${String(currentRevision)}`,
      );
    }
  }

  #assertActive(): void {
    if (this.#destroyStarted || this.destroyed) {
      throw new Error("TextLayer has been destroyed");
    }
  }
}

function normalizeLabel(
  spec: TextLabelSpec,
  output: MutableTextStoreLabel,
): Parameters<TextStore["create"]>[0] {
  let scaleX = 1;
  let scaleY = 1;
  if (typeof spec.scale === "number") {
    scaleX = spec.scale;
    scaleY = spec.scale;
  } else if (spec.scale !== undefined) {
    scaleX = spec.scale.x;
    scaleY = spec.scale.y;
  }

  let anchorX = 0;
  let anchorY = 0;
  if (typeof spec.anchor === "number") {
    anchorX = spec.anchor;
    anchorY = spec.anchor;
  } else if (spec.anchor !== undefined) {
    anchorX = spec.anchor.x;
    anchorY = spec.anchor.y;
  }

  output.text = spec.text;
  output.x = spec.x ?? 0;
  output.y = spec.y ?? 0;
  output.scaleX = spec.scaleX ?? scaleX;
  output.scaleY = spec.scaleY ?? scaleY;
  output.rotation = spec.rotation ?? 0;
  output.zIndex = spec.zIndex ?? 0;
  output.blendMode = spec.blendMode ?? "normal";
  output.alpha = spec.alpha ?? 1;
  output.visible = spec.visible ?? true;
  output.anchorX = anchorX;
  output.anchorY = anchorY;
  output.style = spec.style ?? EMPTY_STYLE;

  return output;
}

interface AdmitDraft {
  text: string;
  style: Readonly<TextStyleOptions>;
  slots: number[];
  tightSlots: number[];
  offscreenSlots: number[];
}

interface AdmitCollector {
  drafts: AdmitDraft[];
  byStyle: WeakMap<Readonly<TextStyleOptions>, Map<string, AdmitDraft>>;
  collected: Set<number>;
}

function createAdmitCollector(): AdmitCollector {
  return { drafts: [], byStyle: new WeakMap(), collected: new Set() };
}

function mergeRenderResults(
  ...parts: Array<RenderCommitResult | undefined>
): RenderCommitResult | undefined {
  let merged: RenderCommitResult | undefined;
  for (const part of parts) {
    if (part === undefined) continue;
    if (merged === undefined) {
      merged = part;
      continue;
    }
    merged = {
      revision: part.revision || merged.revision,
      stale: merged.stale || part.stale,
      appliedLabels: merged.appliedLabels + part.appliedLabels,
      glyphs: part.glyphs,
      atlasUploads: merged.atlasUploads + part.atlasUploads,
      atlasCommit: {
        entries: [...merged.atlasCommit.entries, ...part.atlasCommit.entries],
        uploads: [...merged.atlasCommit.uploads, ...part.atlasCommit.uploads],
        externalUploads: [
          ...merged.atlasCommit.externalUploads,
          ...part.atlasCommit.externalUploads,
        ],
        evictedKeys: [...merged.atlasCommit.evictedKeys, ...part.atlasCommit.evictedKeys],
      },
      drawOrderChanged: merged.drawOrderChanged || part.drawOrderChanged,
    };
  }
  return merged;
}

function releaseRenderExternalUploads(...parts: Array<RenderCommitResult | undefined>): void {
  const releaseSteps: Array<() => void> = [];
  for (const part of parts) {
    if (part === undefined) continue;
    for (const upload of part.atlasCommit.externalUploads) {
      releaseSteps.push(() => upload.release());
    }
  }
  const failure = cleanupBestEffort(releaseSteps);
  if (failure !== undefined) throw failure.error;
}

function toRenderSnapshot(
  snapshot: Readonly<TextStoreSnapshot>,
  order: number,
  layout: Readonly<TextLayoutOptions> | undefined,
  shaping: Readonly<TextShapingOptions> | undefined,
  worldScaleY: number,
): Readonly<RenderLabelSnapshot> {
  return {
    sourceRevision: snapshot.sourceRevision,
    text: snapshot.text,
    x: snapshot.x,
    y: snapshot.y,
    scaleX: snapshot.scaleX,
    scaleY: snapshot.scaleY,
    rotation: snapshot.rotation,
    zIndex: snapshot.zIndex,
    order,
    blendMode: snapshot.blendMode,
    alpha: snapshot.alpha,
    visible: snapshot.visible,
    anchorX: snapshot.anchorX,
    anchorY: snapshot.anchorY,
    style: snapshot.style,
    projectedHeightPx:
      resolvePositiveStyleNumber(snapshot.style.fontSize, 26) *
      Math.abs(snapshot.scaleY) *
      worldScaleY,
    ...(layout === undefined ? {} : { layout }),
    ...(shaping === undefined ? {} : { shaping }),
  };
}

type NormalizedLayoutPatch = Readonly<TextLayoutOptions> | null | undefined;
type NormalizedShapingPatch = Readonly<TextShapingOptions> | null | undefined;
type NormalizedGroupPatch = TextGroupId | null | undefined;

function normalizeGroupPatch(patch: TextLabelPatch): NormalizedGroupPatch {
  return patch.group;
}

function normalizeLayoutPatch(patch: TextLabelPatch): NormalizedLayoutPatch {
  if (patch.layout === undefined) return undefined;
  if (patch.layout === null) return null;
  return normalizeLayoutOptions(patch.layout) ?? null;
}

function normalizeLayoutOptions(
  layout: Readonly<TextLayoutOptions> | undefined,
): Readonly<TextLayoutOptions> | undefined {
  if (layout === undefined || layout.writingMode === undefined) return undefined;
  return Object.freeze({ writingMode: layout.writingMode });
}

function equalLayout(
  left: Readonly<TextLayoutOptions> | undefined,
  right: Readonly<TextLayoutOptions> | undefined,
): boolean {
  return left === right || left?.writingMode === right?.writingMode;
}

function normalizeShapingPatch(patch: TextLabelPatch): NormalizedShapingPatch {
  if (patch.shaping === undefined) return undefined;
  if (patch.shaping === null) return null;
  return normalizeShapingOptions(patch.shaping) ?? null;
}

function normalizeShapingOptions(
  shaping: Readonly<TextShapingOptions> | undefined,
): Readonly<TextShapingOptions> | undefined {
  if (shaping === undefined) return undefined;
  const normalized: {
    direction?: NonNullable<TextShapingOptions["direction"]>;
    language?: string;
    script?: string;
    features?: readonly string[];
    variations?: Readonly<Record<string, number>>;
  } = {};
  if (shaping.direction !== undefined) normalized.direction = shaping.direction;
  if (shaping.language !== undefined) normalized.language = shaping.language.trim();
  if (shaping.script !== undefined) normalized.script = shaping.script;
  if (shaping.features !== undefined) normalized.features = Object.freeze([...shaping.features]);
  if (shaping.variations !== undefined) {
    normalized.variations = Object.freeze({ ...shaping.variations });
  }
  return Object.keys(normalized).length === 0 ? undefined : Object.freeze(normalized);
}

function equalShaping(
  left: Readonly<TextShapingOptions> | undefined,
  right: Readonly<TextShapingOptions> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (
    left.direction !== right.direction ||
    left.language !== right.language ||
    left.script !== right.script
  ) {
    return false;
  }
  const leftFeatures = left.features ?? [];
  const rightFeatures = right.features ?? [];
  if (
    leftFeatures.length !== rightFeatures.length ||
    leftFeatures.some((value, index) => value !== rightFeatures[index])
  ) {
    return false;
  }
  const leftVariations = Object.entries(left.variations ?? {});
  const rightVariations = right.variations ?? {};
  return (
    leftVariations.length === Object.keys(rightVariations).length &&
    leftVariations.every(([axis, value]) => rightVariations[axis] === value)
  );
}

function normalizePatch(patch: TextLabelPatch): TextStoreLabelPatch {
  if (patch.scale === undefined && patch.anchor === undefined) {
    return patch;
  }
  const normalized: {
    -readonly [Key in keyof TextStoreLabelPatch]?: TextStoreLabelPatch[Key];
  } = {};

  if (patch.text !== undefined) normalized.text = patch.text;
  if (patch.x !== undefined) normalized.x = patch.x;
  if (patch.y !== undefined) normalized.y = patch.y;
  if (patch.scale !== undefined) {
    const scale = readPoint(patch.scale, 1);
    normalized.scaleX = scale.x;
    normalized.scaleY = scale.y;
  }
  if (patch.scaleX !== undefined) normalized.scaleX = patch.scaleX;
  if (patch.scaleY !== undefined) normalized.scaleY = patch.scaleY;
  if (patch.rotation !== undefined) normalized.rotation = patch.rotation;
  if (patch.zIndex !== undefined) normalized.zIndex = patch.zIndex;
  if (patch.blendMode !== undefined) normalized.blendMode = patch.blendMode;
  if (patch.alpha !== undefined) normalized.alpha = patch.alpha;
  if (patch.visible !== undefined) normalized.visible = patch.visible;
  if (patch.anchor !== undefined) {
    const anchor = readPoint(patch.anchor, 0);
    normalized.anchorX = anchor.x;
    normalized.anchorY = anchor.y;
  }
  if (patch.style !== undefined) normalized.style = patch.style;

  return normalized;
}

function nextPowerOfTwo(value: number): number {
  if (value <= 1) return 1;

  return 2 ** Math.ceil(Math.log2(value));
}

function assertLabelSpec(spec: TextLabelSpec): void {
  if (typeof spec !== "object" || spec === null) {
    throw new TypeError("Label specification must be an object");
  }
  if (typeof spec.text !== "string") {
    throw new TypeError("Label text must be a string");
  }
  if (spec.shaping === null) {
    throw new TypeError("Label shaping must be an object");
  }
  if (spec.layout === null) {
    throw new TypeError("Label layout must be an object");
  }
  assertLabelPatch(spec);
}

function assertLabelPatch(patch: TextLabelPatch): void {
  if (typeof patch !== "object" || patch === null) {
    throw new TypeError("Label patch must be an object");
  }
  if (patch.text !== undefined && typeof patch.text !== "string") {
    throw new TypeError("Label text must be a string");
  }
  assertFiniteField("x", patch.x);
  assertFiniteField("y", patch.y);
  assertFiniteField("scaleX", patch.scaleX);
  assertFiniteField("scaleY", patch.scaleY);
  assertFiniteField("rotation", patch.rotation);
  assertFiniteField("zIndex", patch.zIndex);
  assertFiniteField("priority", patch.priority);
  if (patch.priority !== undefined && !Number.isFinite(Math.fround(patch.priority))) {
    throw new TypeError("priority must fit a finite 32-bit float");
  }
  if (patch.blendMode !== undefined) assertBlendMode(patch.blendMode);
  assertFiniteField("alpha", patch.alpha);
  if (patch.visible !== undefined && typeof patch.visible !== "boolean") {
    throw new TypeError("visible must be a boolean");
  }
  if (patch.group !== undefined && patch.group !== null && typeof patch.group !== "symbol") {
    throw new TypeError("group must be a TextGroupId or null");
  }
  if (patch.scale !== undefined) readPoint(patch.scale, 1);
  if (patch.anchor !== undefined) readPoint(patch.anchor, 0);
  if (patch.style !== undefined && (typeof patch.style !== "object" || patch.style === null)) {
    throw new TypeError("style must be an object");
  }
  if (patch.layout !== undefined && patch.layout !== null) {
    assertLayoutOptions(patch.layout);
  }
  if (patch.shaping !== undefined && patch.shaping !== null) {
    assertShapingOptions(patch.shaping);
  }
}

function assertLayoutOptions(layout: Readonly<TextLayoutOptions>): void {
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
    throw new TypeError("layout must be an object");
  }
  if (
    layout.writingMode !== undefined &&
    layout.writingMode !== "horizontal-tb" &&
    layout.writingMode !== "vertical-rl"
  ) {
    throw new TypeError("layout.writingMode must be horizontal-tb or vertical-rl");
  }
}

function assertShapingOptions(shaping: Readonly<TextShapingOptions>): void {
  if (typeof shaping !== "object" || shaping === null || Array.isArray(shaping)) {
    throw new TypeError("shaping must be an object");
  }
  if (
    shaping.direction !== undefined &&
    shaping.direction !== "ltr" &&
    shaping.direction !== "rtl"
  ) {
    throw new TypeError("shaping.direction must be ltr or rtl");
  }
  if (
    shaping.language !== undefined &&
    (typeof shaping.language !== "string" || shaping.language.trim().length === 0)
  ) {
    throw new TypeError("shaping.language must be a non-empty language tag");
  }
  if (
    shaping.script !== undefined &&
    (typeof shaping.script !== "string" || !/^[A-Za-z]{4}$/.test(shaping.script))
  ) {
    throw new TypeError("shaping.script must be a four-letter ISO 15924 tag");
  }
  if (
    shaping.features !== undefined &&
    (!Array.isArray(shaping.features) ||
      shaping.features.some(
        (feature) => typeof feature !== "string" || feature.trim().length === 0,
      ))
  ) {
    throw new TypeError("shaping.features must contain non-empty OpenType feature strings");
  }
  if (
    shaping.variations !== undefined &&
    (typeof shaping.variations !== "object" ||
      shaping.variations === null ||
      Array.isArray(shaping.variations))
  ) {
    throw new TypeError("shaping.variations must be an axis record");
  }
  for (const [axis, value] of Object.entries(shaping.variations ?? {})) {
    if (!/^[\x20-\x7e]{4}$/.test(axis) || !Number.isFinite(value)) {
      throw new TypeError("shaping.variations must map valid axis tags to finite values");
    }
  }
}

function assertFiniteField(name: string, value: number | undefined): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function readPoint(
  value: { readonly x: number; readonly y: number } | number | undefined,
  fallback: number,
): Readonly<{ x: number; y: number }> {
  if (value === undefined) {
    return { x: fallback, y: fallback };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Point value must be finite");
    }
    return { x: value, y: value };
  }
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new TypeError("Point x/y values must be finite");
  }

  return { x: value.x, y: value.y };
}

function resolveCullingOptions(options: false | TextLayerCullingOptions | undefined): Readonly<{
  enabled: boolean;
  padding: number;
  bounds: Readonly<BoundsData> | undefined;
  computeCull: boolean | "auto";
  residency: TextLayerResidency;
  lod: boolean;
  offscreenAdmitBudgetBytes: number;
  collision: Readonly<TextLayerCollisionOptions> | undefined;
}> {
  if (options === false) {
    return {
      enabled: false,
      padding: 0,
      bounds: undefined,
      computeCull: false,
      residency: "viewport",
      lod: false,
      offscreenAdmitBudgetBytes: DEFAULT_OFFSCREEN_ADMIT_BUDGET_BYTES,
      collision: undefined,
    };
  }
  const padding = options?.padding ?? 0;
  if (!Number.isFinite(padding) || padding < 0) {
    throw new TypeError("Culling padding must be a finite non-negative number");
  }
  const computeCull = options?.computeCull ?? "auto";
  if (computeCull !== true && computeCull !== false && computeCull !== "auto") {
    throw new TypeError('Culling computeCull must be true, false, or "auto"');
  }
  const residency = options?.residency ?? "viewport";
  if (residency !== "viewport" && residency !== "gpu-scene") {
    throw new TypeError('Culling residency must be "viewport" or "gpu-scene"');
  }
  if (options?.lod !== undefined && typeof options.lod !== "boolean") {
    throw new TypeError("Culling lod must be a boolean");
  }
  if (options?.bounds !== undefined) assertBoundsData(options.bounds);
  const collisionOption = options?.collision;
  if (
    collisionOption !== undefined &&
    collisionOption !== false &&
    (collisionOption === null ||
      typeof collisionOption !== "object" ||
      Array.isArray(collisionOption))
  ) {
    throw new TypeError("Culling collision must be false or an options object");
  }
  if (
    collisionOption !== undefined &&
    collisionOption !== false &&
    collisionOption.enabled !== undefined &&
    typeof collisionOption.enabled !== "boolean"
  ) {
    throw new TypeError("Culling collision.enabled must be a boolean");
  }
  let offscreenAdmitBudgetBytes = DEFAULT_OFFSCREEN_ADMIT_BUDGET_BYTES;
  if (options?.offscreenAdmitBudgetBytes !== undefined) {
    const value = options.offscreenAdmitBudgetBytes;
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("Culling offscreenAdmitBudgetBytes must be a finite non-negative number");
    }
    offscreenAdmitBudgetBytes = value;
  }

  return {
    enabled: options?.enabled ?? true,
    padding,
    computeCull,
    residency,
    lod: options?.lod === true,
    offscreenAdmitBudgetBytes,
    collision:
      collisionOption === undefined ||
      collisionOption === false ||
      collisionOption.enabled === false
        ? undefined
        : Object.freeze({ ...collisionOption }),
    bounds: options?.bounds === undefined ? undefined : Object.freeze({ ...options.bounds }),
  };
}

function transformedLabelBounds(
  label: Pick<
    TextStoreSnapshot,
    "text" | "x" | "y" | "scaleX" | "scaleY" | "rotation" | "anchorX" | "anchorY" | "style"
  >,
  acceptedBounds?: BoundsData,
  output: MutableBoundsData = { x: 0, y: 0, width: 0, height: 0 },
): Readonly<BoundsData> {
  const bounds = acceptedBounds ?? estimateTextBounds(label.text, label.style, output);
  const left = bounds.x - label.anchorX * bounds.width;
  const top = bounds.y - label.anchorY * bounds.height;
  const right = left + bounds.width;
  const bottom = top + bounds.height;
  if (label.rotation === 0) {
    const x0 = label.x + left * label.scaleX;
    const x1 = label.x + right * label.scaleX;
    const y0 = label.y + top * label.scaleY;
    const y1 = label.y + bottom * label.scaleY;
    output.x = Math.min(x0, x1);
    output.y = Math.min(y0, y1);
    output.width = Math.max(x0, x1) - output.x;
    output.height = Math.max(y0, y1) - output.y;

    return output;
  }
  const sine = Math.sin(label.rotation);
  const cosine = Math.cos(label.rotation);
  const scaledLeft = left * label.scaleX;
  const scaledRight = right * label.scaleX;
  const scaledTop = top * label.scaleY;
  const scaledBottom = bottom * label.scaleY;
  const x0 = label.x + scaledLeft * cosine - scaledTop * sine;
  const y0 = label.y + scaledLeft * sine + scaledTop * cosine;
  const x1 = label.x + scaledRight * cosine - scaledTop * sine;
  const y1 = label.y + scaledRight * sine + scaledTop * cosine;
  const x2 = label.x + scaledRight * cosine - scaledBottom * sine;
  const y2 = label.y + scaledRight * sine + scaledBottom * cosine;
  const x3 = label.x + scaledLeft * cosine - scaledBottom * sine;
  const y3 = label.y + scaledLeft * sine + scaledBottom * cosine;
  output.x = Math.min(x0, x1, x2, x3);
  output.y = Math.min(y0, y1, y2, y3);
  output.width = Math.max(x0, x1, x2, x3) - output.x;
  output.height = Math.max(y0, y1, y2, y3) - output.y;

  return output;
}

function estimateTextBounds(
  text: string,
  style: Readonly<TextStyleOptions>,
  output: MutableBoundsData,
): BoundsData {
  const fontSize = resolvePositiveStyleNumber(style.fontSize, 26);
  const lineHeight = resolvePositiveStyleNumber(style.lineHeight, fontSize * 1.2);
  const letterSpacing = resolveFiniteStyleNumber(style.letterSpacing, 0);
  let maximumCharacters = 0;
  let currentCharacters = 0;
  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      maximumCharacters = Math.max(maximumCharacters, currentCharacters);
      currentCharacters = 0;
      lineCount += 1;
      continue;
    }
    currentCharacters += 1;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
  }
  maximumCharacters = Math.max(maximumCharacters, currentCharacters);
  let width = Math.max(
    0,
    maximumCharacters * fontSize * 0.6 + letterSpacing * (maximumCharacters - 1),
  );
  const wrapWidth = resolvePositiveStyleNumber(style.wordWrapWidth, Number.POSITIVE_INFINITY);
  if (Number.isFinite(wrapWidth) && wrapWidth > 0 && width > wrapWidth) {
    lineCount *= Math.ceil(width / wrapWidth);
    width = wrapWidth;
  }

  output.x = 0;
  output.y = 0;
  output.width = width;
  output.height = lineCount * lineHeight;

  return output;
}

function resolvePositiveStyleNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveFiniteStyleNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function transformBounds(
  bounds: BoundsData,
  matrix: Matrix,
  output: MutableBoundsData,
): Readonly<BoundsData> {
  const minimumX = bounds.x;
  const minimumY = bounds.y;
  const maximumX = bounds.x + bounds.width;
  const maximumY = bounds.y + bounds.height;
  const x0 = matrix.a * minimumX + matrix.c * minimumY + matrix.tx;
  const y0 = matrix.b * minimumX + matrix.d * minimumY + matrix.ty;
  const x1 = matrix.a * maximumX + matrix.c * minimumY + matrix.tx;
  const y1 = matrix.b * maximumX + matrix.d * minimumY + matrix.ty;
  const x2 = matrix.a * maximumX + matrix.c * maximumY + matrix.tx;
  const y2 = matrix.b * maximumX + matrix.d * maximumY + matrix.ty;
  const x3 = matrix.a * minimumX + matrix.c * maximumY + matrix.tx;
  const y3 = matrix.b * minimumX + matrix.d * maximumY + matrix.ty;
  output.x = Math.min(x0, x1, x2, x3);
  output.y = Math.min(y0, y1, y2, y3);
  output.width = Math.max(x0, x1, x2, x3) - output.x;
  output.height = Math.max(y0, y1, y2, y3) - output.y;

  return output;
}

function inverseTransformPoint(point: PointLike, matrix: Matrix): Readonly<PointLike> {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (determinant === 0) {
    return { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  }
  const x = point.x - matrix.tx;
  const y = point.y - matrix.ty;

  return {
    x: (matrix.d * x - matrix.c * y) / determinant,
    y: (-matrix.b * x + matrix.a * y) / determinant,
  };
}

function equalBounds(left: BoundsData | undefined, right: BoundsData | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
}

function assertBoundsData(bounds: BoundsData): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    throw new TypeError("Bounds must contain finite x/y and non-negative width/height values");
  }
}

function assertPointLike(point: PointLike): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError("Point must contain finite x/y values");
  }
}

function addF32(left: number, right: number): number {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function growTypedArray<T extends Uint8Array | Uint32Array>(source: T, capacity: number): T {
  // #bulkSlots also grows to duplicate-heavy updateMany batch sizes, so it can already
  // exceed a later scratch requirement; growing must never shrink.
  if (source.length >= capacity) return source;
  const target = (
    source instanceof Uint8Array ? new Uint8Array(capacity) : new Uint32Array(capacity)
  ) as T;
  target.set(source);

  return target;
}

function growFloat32Array(source: Float32Array, capacity: number): Float32Array {
  if (source.length >= capacity) return source;
  const target = new Float32Array(capacity);
  target.set(source);
  return target;
}

function settleControlledTeardown(
  teardown: Readonly<ControlledTeardown>,
  failure: Readonly<CleanupFailure> | undefined,
  pending: Promise<void> | undefined,
): void {
  if (pending === undefined) {
    if (failure === undefined) teardown.resolve();
    else teardown.reject(failure.error);
    return;
  }
  void pending.then(
    () => {
      if (failure === undefined) teardown.resolve();
      else teardown.reject(failure.error);
    },
    (error: unknown) => teardown.reject(failure?.error ?? error),
  );
}

function combineTeardowns(
  first: Promise<void> | undefined,
  second: Promise<void> | undefined,
): Promise<void> | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Promise.allSettled([first, second]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  });
}
