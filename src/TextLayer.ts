import {
  Container,
  Matrix,
  type DestroyOptions,
  type Renderer,
  type TextStyleOptions,
} from "pixi.js";

import { SpatialIndex } from "./culling/SpatialIndex";
import type { BoundsData, MutableBoundsData, PointLike } from "./culling/types";
import { FontRegistry } from "./FontRegistry";
import {
  RenderCoordinator,
  type RenderChange,
  type RenderLabelSnapshot,
} from "./render/RenderCoordinator";
import { RenderSurface } from "./render/RenderSurface";
import {
  assertTrustedGlyphRunOwner,
  createTrustedGlyphRun,
  type TrustedGlyphRun,
  type TrustedGlyphRunInput,
} from "./shaping/TrustedGlyphRun";
import { assertBlendMode } from "./store/blendModes";
import { TextStore } from "./store/TextStore";
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
  TextLayerRenderingOptions,
  TextLayerStats,
  TextRevision,
  TextShapingOptions,
  TextUpdate,
} from "./types";

const EMPTY_STYLE: Readonly<TextStyleOptions> = Object.freeze({});
const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;
export const TEXT_LAYER_COMMIT_EVENT = "glyphflow:commit";

interface TextGroupState {
  visible: boolean;
  readonly members: Set<TextId>;
}

interface LayerRenderChange extends RenderChange {
  readonly labelId?: TextId;
}

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
  #renderer: Renderer | undefined;
  readonly #renderingOptions: false | TextLayerRenderingOptions;
  #renderCoordinator: RenderCoordinator | undefined;
  #renderSurface: RenderSurface | undefined;
  #renderTail: Promise<void> = Promise.resolve();
  #lastCommitPromise: Promise<TextRevision> = Promise.resolve(0 as TextRevision);
  readonly #cullingEnabled: boolean;
  readonly #cullingPadding: number;
  #viewportBounds: Readonly<BoundsData> | undefined;
  #viewDirty = false;
  #visibilityDirty = true;
  #dirtyMasks: Uint8Array;
  #positionOnly: Uint8Array;
  #dirtySlots: Uint32Array;
  #bulkSlots: Uint32Array;
  #dirtyLength = 0;
  #visibleSlots: Uint32Array;
  #visibleCount = 0;
  #renderedEpochs: Uint32Array;
  #renderedSlots: Uint32Array;
  #renderedCount = 0;
  #renderEpoch = 0;
  #renderSequence = 0;
  readonly #boundsScratch: MutableBoundsData = { x: 0, y: 0, width: 0, height: 0 };
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
    this.#viewportBounds = culling.bounds;
    this.#dirtyMasks = new Uint8Array(this.#store.capacity);
    this.#positionOnly = new Uint8Array(this.#store.capacity);
    this.#dirtySlots = new Uint32Array(this.#store.capacity);
    this.#bulkSlots = new Uint32Array(this.#store.capacity);
    this.#visibleSlots = new Uint32Array(this.#store.capacity);
    this.#renderedEpochs = new Uint32Array(this.#store.capacity);
    this.#renderedSlots = new Uint32Array(this.#store.capacity);
    this.#renderer = options.renderer;
    this.#renderingOptions = options.rendering ?? {};
    if (this.#renderer !== undefined) {
      this.#activateRendering();
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
    if (spec.group !== undefined) this.#associateGroup(id, spec.group);
    if (layout !== undefined) this.#layouts.set(id, layout);
    if (shaping !== undefined) this.#shaping.set(id, shaping);
    this.#indexLabel(id, label);
    this.#visibilityDirty = true;
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
    this.#spatial.reserve(this.#store.capacity);

    const ids: TextId[] = [];
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      if (spec === undefined) throw new TypeError(`Missing label at index ${String(index)}`);
      const label = normalizeLabel(spec, this.#labelScratch);
      const id = this.#store.create(label);
      ids.push(id);
      if (spec.group !== undefined) this.#associateGroup(id, spec.group);
      const layout = layouts[index];
      if (layout !== undefined) this.#layouts.set(id, layout);
      const shaping = shapings[index];
      if (shaping !== undefined) this.#shaping.set(id, shaping);
      this.#indexLabel(id, label);
    }
    if (ids.length > 0) this.#visibilityDirty = true;
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
    const changed = this.#store.updatePositions(
      ids,
      positions,
      (slot, x, y, previousX, previousY) => {
        this.#spatial.translate(slot, x - previousX, y - previousY);
      },
    );
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
        if (!this.#store.copyBoundsLabelAt(slot, this.#labelScratch)) {
          throw new Error("Updated label disappeared from its store");
        }
        const id = ids[index];
        if (id === undefined) throw new Error("Updated label identity is unavailable");
        this.#reindexCurrentSlot(slot, id as TextId, this.#labelScratch);
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
      this.#visibilityDirty = true;
      this.#recordMutation(ALL_DIRTY, removed);
    }

    return removed;
  }

  /** Shrink unused reserved CPU capacity while preserving every current identity. */
  compact(): Readonly<TextCompactionResult> {
    this.#assertActive();
    return this.#store.compact();
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
    const slot = this.#store.slotOf(id);
    if (slot === undefined) return undefined;
    const target = output ?? { x: 0, y: 0, width: 0, height: 0 };
    const bounds = this.#spatial.get(slot, target);
    if (bounds === undefined || space === "local") return bounds;

    return transformBounds(bounds, this.getGlobalTransform(this.#matrixScratch), target);
  }

  /** Return the topmost visible label at a local or world point. */
  hitTest(point: PointLike, space: "local" | "world" = "local"): TextId | undefined {
    this.#assertActive();
    assertPointLike(point);
    if (space !== "local" && space !== "world") {
      throw new TypeError('Hit-test space must be "local" or "world"');
    }
    const localPoint =
      space === "world"
        ? inverseTransformPoint(point, this.getGlobalTransform(this.#matrixScratch))
        : point;
    const slot = this.#spatial.hitTest(localPoint);
    if (slot === undefined) return undefined;

    return this.#store.snapshotAt(slot)?.id;
  }

  /** Publish accepted mutations as one monotonic revision. */
  commit(): Promise<TextRevision> {
    this.#assertActive();
    const hasLabelChanges = this.#store.pendingDirty.labels > 0;
    if (!hasLabelChanges && !this.#viewDirty) {
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
      return this.#lastCommitPromise;
    }
    if (hasLabelChanges && this.#revision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("TextLayer revision capacity exhausted");
    }

    const start = performance.now();
    const coordinator = this.#renderCoordinator;
    const surface = this.#renderSurface;
    this.#ensureScratchCapacity();
    this.#dirtyLength = 0;
    const dirty = hasLabelChanges
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
    if (hasLabelChanges) this.#revision += 1;
    const revision = this.#revision as TextRevision;
    this.#pendingMutations = 0;
    this.#commits += 1;
    this.#lastCommitDirtyLabels = dirty.labels;
    this.#lastCommitContentLabels = dirty.content;
    this.#lastCommitTransformLabels = dirty.transform;
    this.#lastCommitStyleLabels = dirty.style;
    this.#viewDirty = false;
    const spatialStart = performance.now();
    if (this.#cullingEnabled || this.#visibilityDirty) {
      this.#visibleCount = this.#queryVisible();
      this.#visibilityDirty = false;
    }
    this.#lastSpatialUpdateMs = performance.now() - spatialStart;
    this.#lastLayoutMs = 0;
    this.#lastInstanceWriteMs = 0;
    this.#lastPaletteWriteMs = 0;
    this.#lastUploadMs = 0;
    const changes = coordinator === undefined ? [] : this.#buildRenderChanges();
    this.#clearDirtyMasks();

    if (coordinator === undefined || changes.length === 0) {
      this.#lastCommitDurationMs = performance.now() - start;
      this.#lastCommitPromise = this.#renderTail.then(() => {
        this.emit(TEXT_LAYER_COMMIT_EVENT, revision);
        return revision;
      });
      return this.#lastCommitPromise;
    }

    if (this.#renderSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("TextLayer render sequence capacity exhausted");
    }
    this.#renderSequence += 1;
    const renderSequence = this.#renderSequence;
    const renderWork = this.#renderTail.then(async () => {
      const result = await coordinator.commit(renderSequence, changes);
      this.#lastLayoutMs = coordinator.stats.lastLayoutMs;
      this.#lastInstanceWriteMs = coordinator.stats.lastInstanceWriteMs;
      this.#lastPaletteWriteMs = coordinator.stats.lastPaletteWriteMs;
      surface?.apply(result);
      this.#lastUploadMs = surface?.stats.lastUploadMs ?? 0;
      const spatialWriteStart = performance.now();
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
      }
      this.#lastSpatialUpdateMs += performance.now() - spatialWriteStart;
    });
    this.#renderTail = renderWork.then(
      () => undefined,
      () => undefined,
    );
    this.#lastCommitPromise = renderWork.then(
      () => {
        this.#lastCommitDurationMs = performance.now() - start;
        this.emit(TEXT_LAYER_COMMIT_EVENT, revision);
        return revision;
      },
      (error: unknown) => {
        if (!this.destroyed && this.#renderCoordinator === coordinator) {
          this.#resetRenderedSet();
          this.#viewDirty = true;
        }
        throw error;
      },
    );

    return this.#lastCommitPromise;
  }

  /** Associate the layer with the renderer that owns future glyph resources. */
  attach(renderer: Renderer): void {
    this.#assertActive();
    if (this.#renderer === renderer && this.#renderCoordinator !== undefined) {
      return;
    }
    this.#renderSurface?.destroy();
    this.#renderSurface = undefined;
    this.#renderCoordinator?.destroy();
    this.#resetRenderedSet();
    this.#renderer = renderer;
    this.#activateRendering();
    this.#viewDirty = true;
  }

  /** Release the current renderer association. */
  detach(): void {
    this.#assertActive();
    this.#renderSurface?.destroy();
    this.#renderSurface = undefined;
    this.#renderCoordinator?.destroy();
    this.#renderCoordinator = undefined;
    this.#renderer = undefined;
    this.#resetRenderedSet();
    this.#renderTail = Promise.resolve();
    this.#lastCommitPromise = Promise.resolve(this.#revision as TextRevision);
  }

  /** Read an immutable diagnostics snapshot. */
  get stats(): Readonly<TextLayerStats> {
    const store = this.#store.stats;
    const pendingDirty = this.#store.pendingDirty;
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
      rendererAdapter: this.#renderer === undefined ? "detached" : (surface?.adapter ?? "unknown"),
      drawCalls: surface?.meshes ?? 0,
      submittedGlyphs: surface?.submittedGlyphs ?? 0,
      atlasTextureCount: surface?.atlasTextures ?? 0,
      instanceUploadBytes: surface?.instanceUploadBytes ?? 0,
      transformUploadBytes: surface?.transformUploadBytes ?? 0,
      atlasUploadBytes: surface?.atlasUploadBytes ?? 0,
    });
  }

  /** Release state, renderer associations, and PixiJS resources. */
  override destroy(options: DestroyOptions = { children: true }): void {
    if (this.destroyed) {
      return;
    }

    this.#renderer = undefined;
    this.#renderSurface?.destroy();
    this.#renderSurface = undefined;
    this.#renderCoordinator?.destroy();
    this.#renderCoordinator = undefined;
    this.fonts.destroy();
    this.#layouts.clear();
    this.#shaping.clear();
    this.#labelGroups.clear();
    this.#groups.clear();
    this.#spatial.destroy();
    this.#store.dispose();
    super.destroy(options);
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

  #activateRendering(): void {
    if (this.#renderingOptions === false || this.#renderCoordinator !== undefined) {
      return;
    }
    this.#renderCoordinator = new RenderCoordinator({
      ...this.#renderingOptions,
      registry: this.fonts,
    });
    if (this.#renderer !== undefined && ("gl" in this.#renderer || "gpu" in this.#renderer)) {
      this.#renderSurface = new RenderSurface(this.#renderer, this, this.#renderCoordinator);
    }
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
      transformedLabelBounds(label, runBounds, this.#boundsScratch),
      label.zIndex,
      this.#isEffectivelyVisible(id, label.visible),
    );
  }

  #reindexCurrentSlot(
    slot: number,
    id: TextId,
    label: Readonly<TextStoreSnapshot> | Parameters<TextStore["create"]>[0],
    runBounds?: BoundsData,
  ): void {
    this.#spatial.updateCurrent(
      slot,
      transformedLabelBounds(label, runBounds, this.#boundsScratch),
      label.zIndex,
      this.#isEffectivelyVisible(id, label.visible),
    );
  }

  #ensureScratchCapacity(): void {
    const required = Math.max(this.#store.capacity, this.#spatial.capacity);
    if (this.#visibleSlots.length >= required) return;
    this.#dirtyMasks = growTypedArray(this.#dirtyMasks, required);
    this.#positionOnly = growTypedArray(this.#positionOnly, required);
    this.#dirtySlots = growTypedArray(this.#dirtySlots, required);
    this.#visibleSlots = growTypedArray(this.#visibleSlots, required);
    this.#renderedEpochs = growTypedArray(this.#renderedEpochs, required);
    this.#renderedSlots = growTypedArray(this.#renderedSlots, required);
  }

  #queryVisible(): number {
    if (this.#cullingEnabled && this.#viewportBounds !== undefined) {
      return this.#spatial.query(this.#viewportBounds, this.#visibleSlots, this.#cullingPadding);
    }

    return this.#spatial.queryAll(this.#visibleSlots);
  }

  #buildRenderChanges(): LayerRenderChange[] {
    let previousEpoch = this.#renderEpoch;
    if (previousEpoch === 0xffff_ffff) {
      this.#renderedEpochs.fill(0);
      previousEpoch = 0;
    }
    const nextEpoch = previousEpoch + 1;
    const changes: LayerRenderChange[] = [];
    for (let index = 0; index < this.#visibleCount; index += 1) {
      const slot = this.#visibleSlots[index];
      if (slot === undefined) throw new Error("Visible slot list is incomplete");
      const wasRendered = previousEpoch !== 0 && this.#renderedEpochs[slot] === previousEpoch;
      this.#renderedEpochs[slot] = nextEpoch;
      const dirtyMask = this.#dirtyMasks[slot] ?? TextDirty.None;
      if (wasRendered && dirtyMask === TextDirty.None) continue;
      const snapshot = this.#store.snapshotAt(slot);
      if (snapshot === undefined) throw new Error("Visible label snapshot is unavailable");
      const order = this.#spatial.orderOf(slot);
      if (order === undefined) throw new Error("Visible label order is unavailable");
      const trustedRun = this.#trustedRuns.get(snapshot.id);
      const mask = wasRendered ? dirtyMask : ALL_DIRTY;
      changes.push({
        slot,
        labelId: snapshot.id,
        mask,
        snapshot: toRenderSnapshot(
          snapshot,
          order,
          this.#layouts.get(snapshot.id),
          this.#shaping.get(snapshot.id),
        ),
        ...(trustedRun === undefined ? {} : { trustedRun }),
        ...(wasRendered && this.#positionOnly[slot] === 1 && mask === TextDirty.Transform
          ? { positionOnly: true }
          : {}),
      });
    }
    for (let index = 0; index < this.#renderedCount; index += 1) {
      const slot = this.#renderedSlots[index];
      if (slot === undefined) throw new Error("Rendered slot list is incomplete");
      if (this.#renderedEpochs[slot] !== nextEpoch) {
        changes.push({ slot, mask: ALL_DIRTY, snapshot: undefined });
      }
    }
    this.#renderedSlots.set(this.#visibleSlots.subarray(0, this.#visibleCount));
    this.#renderedCount = this.#visibleCount;
    this.#renderEpoch = nextEpoch;

    return changes;
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
    this.#renderedCount = 0;
    this.#renderEpoch = 0;
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
    if (this.destroyed) {
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

function toRenderSnapshot(
  snapshot: Readonly<TextStoreSnapshot>,
  order: number,
  layout: Readonly<TextLayoutOptions> | undefined,
  shaping: Readonly<TextShapingOptions> | undefined,
): Readonly<RenderLabelSnapshot> {
  return Object.freeze({
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
    ...(layout === undefined ? {} : { layout }),
    ...(shaping === undefined ? {} : { shaping }),
  });
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

function resolveCullingOptions(
  options: false | TextLayerCullingOptions | undefined,
): Readonly<{ enabled: boolean; padding: number; bounds: Readonly<BoundsData> | undefined }> {
  if (options === false) {
    return { enabled: false, padding: 0, bounds: undefined };
  }
  const padding = options?.padding ?? 0;
  if (!Number.isFinite(padding) || padding < 0) {
    throw new TypeError("Culling padding must be a finite non-negative number");
  }
  if (options?.bounds !== undefined) assertBoundsData(options.bounds);

  return {
    enabled: options?.enabled ?? true,
    padding,
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

function growTypedArray<T extends Uint8Array | Uint32Array>(source: T, capacity: number): T {
  const target = (
    source instanceof Uint8Array ? new Uint8Array(capacity) : new Uint32Array(capacity)
  ) as T;
  target.set(source);

  return target;
}
