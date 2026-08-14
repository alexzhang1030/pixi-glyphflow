import {
  Container,
  type DestroyOptions,
  type Matrix,
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
import { TextStore } from "./store/TextStore";
import {
  TextDirty,
  type TextDirtyMask,
  type TextStoreLabel,
  type TextStoreLabelPatch,
  type TextStoreSnapshot,
} from "./store/types";
import type {
  TextId,
  TextCompactionResult,
  TextLabelPatch,
  TextLabelSnapshot,
  TextLabelSpec,
  TextLayerOptions,
  TextLayerCullingOptions,
  TextLayerRenderingOptions,
  TextLayerStats,
  TextRevision,
  TextUpdate,
} from "./types";

const EMPTY_STYLE: Readonly<TextStyleOptions> = Object.freeze({});
const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;
type MutableTextStoreLabel = { -readonly [Key in keyof TextStoreLabel]: TextStoreLabel[Key] };

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
  #revision = 0;
  #pendingMutations = 0;
  #acceptedMutations = 0;
  #commits = 0;
  #lastCommitDurationMs = 0;
  #lastCommitDirtyLabels = 0;
  #lastCommitContentLabels = 0;
  #lastCommitTransformLabels = 0;
  #lastCommitStyleLabels = 0;
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
  #dirtyMasks: Uint8Array;
  #dirtySlots: Uint32Array;
  #dirtyLength = 0;
  #visibleSlots: Uint32Array;
  #visibleCount = 0;
  #renderedEpochs: Uint32Array;
  #renderedSlots: Uint32Array;
  #renderedCount = 0;
  #renderEpoch = 0;
  #renderSequence = 0;
  readonly #boundsScratch: MutableBoundsData = { x: 0, y: 0, width: 0, height: 0 };
  readonly #labelScratch: MutableTextStoreLabel = {
    text: "",
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    zIndex: 0,
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
    this.#dirtySlots = new Uint32Array(this.#store.capacity);
    this.#visibleSlots = new Uint32Array(this.#store.capacity);
    this.#renderedEpochs = new Uint32Array(this.#store.capacity);
    this.#renderedSlots = new Uint32Array(this.#store.capacity);
    this.#renderer = options.renderer;
    this.#renderingOptions = options.rendering ?? {};
    if (this.#renderer !== undefined) {
      this.#activateRendering();
    }
  }

  /** Create one label and return its layer-local identity. */
  create(spec: TextLabelSpec): TextId {
    this.#assertActive();
    assertLabelSpec(spec);
    const label = normalizeLabel(spec, this.#labelScratch);
    const id = this.#store.create(label);
    this.#indexLabel(id, label);
    this.#recordMutation(ALL_DIRTY, 1);

    return id;
  }

  /** Create a validated batch and return identities in input order. */
  createMany(specs: readonly TextLabelSpec[]): TextId[] {
    this.#assertActive();
    for (const spec of specs) {
      assertLabelSpec(spec);
    }
    this.#store.reserve(specs.length);
    this.#spatial.reserve(this.#store.capacity);

    const ids: TextId[] = [];
    for (const spec of specs) {
      const label = normalizeLabel(spec, this.#labelScratch);
      const id = this.#store.create(label);
      ids.push(id);
      this.#indexLabel(id, label);
    }
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
      alpha: snapshot.alpha,
      visible: snapshot.visible,
      anchor: Object.freeze({ x: snapshot.anchorX, y: snapshot.anchorY }),
      style: snapshot.style,
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
    const dirty = this.#store.update(id, normalizePatch(patch));
    if (dirty !== TextDirty.None) {
      const snapshot = this.#store.get(id);
      if (snapshot === undefined) throw new Error("Updated label disappeared from its store");
      this.#indexLabel(id, snapshot);
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
    for (const entry of entries) {
      if (!this.#store.has(entry.id)) {
        throw new RangeError(`Unknown or stale TextId: ${String(entry.id)}`);
      }
      assertLabelPatch(entry.patch);
    }

    let changed = 0;
    let dirty = TextDirty.None as TextDirtyMask;
    for (const entry of entries) {
      const entryDirty = this.#store.update(entry.id, normalizePatch(entry.patch));
      if (entryDirty !== TextDirty.None) {
        changed += 1;
        dirty |= entryDirty;
        if ((entryDirty & (TextDirty.Content | TextDirty.Style)) !== 0) {
          this.#trustedRuns.delete(entry.id);
        }
        const snapshot = this.#store.get(entry.id);
        if (snapshot === undefined) throw new Error("Updated label disappeared from its store");
        this.#indexLabel(entry.id, snapshot);
      }
    }
    this.#recordMutation(dirty, changed);

    return changed;
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

  /** Remove one label and report whether it existed. */
  remove(id: TextId): boolean {
    this.#assertActive();
    const slot = this.#store.slotOf(id);
    const removed = this.#store.remove(id);
    if (removed) {
      if (slot === undefined) throw new Error("Removed label slot is unavailable");
      this.#spatial.remove(slot);
      this.#trustedRuns.delete(id);
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
        removed += 1;
      }
    }
    this.#recordMutation(ALL_DIRTY, removed);

    return removed;
  }

  /** Remove every label and return the previous label count. */
  clear(): number {
    this.#assertActive();
    const removed = this.#store.size;
    if (removed > 0) {
      this.#store.clear();
      this.#spatial.clear();
      this.#trustedRuns.clear();
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

    return transformBounds(bounds, this.worldTransform, target);
  }

  /** Return the topmost visible label at a local or world point. */
  hitTest(point: PointLike, space: "local" | "world" = "local"): TextId | undefined {
    this.#assertActive();
    assertPointLike(point);
    if (space !== "local" && space !== "world") {
      throw new TypeError('Hit-test space must be "local" or "world"');
    }
    const localPoint =
      space === "world" ? inverseTransformPoint(point, this.worldTransform) : point;
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
    this.#visibleCount = this.#queryVisible();
    const changes = coordinator === undefined ? [] : this.#buildRenderChanges();
    this.#clearDirtyMasks();

    if (coordinator === undefined || changes.length === 0) {
      this.#lastCommitDurationMs = performance.now() - start;
      this.#lastCommitPromise = this.#renderTail.then(() => revision);
      return this.#lastCommitPromise;
    }

    if (this.#renderSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("TextLayer render sequence capacity exhausted");
    }
    this.#renderSequence += 1;
    const renderSequence = this.#renderSequence;
    const renderWork = this.#renderTail.then(async () => {
      const result = await coordinator.commit(renderSequence, changes);
      surface?.apply(result);
      for (const change of changes) {
        if (change.snapshot === undefined) continue;
        const run = coordinator.getRun(change.slot);
        if (run !== undefined) {
          this.#spatial.set(
            change.slot,
            transformedLabelBounds(change.snapshot, run.bounds, this.#boundsScratch),
            change.snapshot.zIndex,
            change.snapshot.visible,
          );
        }
      }
    });
    this.#renderTail = renderWork.then(
      () => undefined,
      () => undefined,
    );
    this.#lastCommitPromise = renderWork.then(
      () => {
        this.#lastCommitDurationMs = performance.now() - start;
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
      glyphCount: render?.glyphs ?? 0,
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
    this.#spatial.set(
      slot,
      transformedLabelBounds(label, runBounds, this.#boundsScratch),
      label.zIndex,
      label.visible,
    );
  }

  #ensureScratchCapacity(): void {
    const required = Math.max(this.#store.capacity, this.#spatial.capacity);
    if (this.#visibleSlots.length >= required) return;
    this.#dirtyMasks = growTypedArray(this.#dirtyMasks, required);
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

  #buildRenderChanges(): RenderChange[] {
    let previousEpoch = this.#renderEpoch;
    if (previousEpoch === 0xffff_ffff) {
      this.#renderedEpochs.fill(0);
      previousEpoch = 0;
    }
    const nextEpoch = previousEpoch + 1;
    const changes: RenderChange[] = [];
    for (let index = 0; index < this.#visibleCount; index += 1) {
      const slot = this.#visibleSlots[index];
      if (slot === undefined) throw new Error("Visible slot list is incomplete");
      const wasRendered = previousEpoch !== 0 && this.#renderedEpochs[slot] === previousEpoch;
      this.#renderedEpochs[slot] = nextEpoch;
      const dirtyMask = this.#dirtyMasks[slot] ?? TextDirty.None;
      if (wasRendered && dirtyMask === TextDirty.None) continue;
      const snapshot = this.#store.snapshotAt(slot);
      if (snapshot === undefined) throw new Error("Visible label snapshot is unavailable");
      const trustedRun = this.#trustedRuns.get(snapshot.id);
      changes.push({
        slot,
        mask: wasRendered ? dirtyMask : ALL_DIRTY,
        snapshot: toRenderSnapshot(snapshot),
        ...(trustedRun === undefined ? {} : { trustedRun }),
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
      if (slot !== undefined) this.#dirtyMasks[slot] = TextDirty.None;
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
  output.alpha = spec.alpha ?? 1;
  output.visible = spec.visible ?? true;
  output.anchorX = anchorX;
  output.anchorY = anchorY;
  output.style = spec.style ?? EMPTY_STYLE;

  return output;
}

function toRenderSnapshot(snapshot: Readonly<TextStoreSnapshot>): Readonly<RenderLabelSnapshot> {
  return Object.freeze({
    sourceRevision: snapshot.sourceRevision,
    text: snapshot.text,
    x: snapshot.x,
    y: snapshot.y,
    scaleX: snapshot.scaleX,
    scaleY: snapshot.scaleY,
    rotation: snapshot.rotation,
    zIndex: snapshot.zIndex,
    alpha: snapshot.alpha,
    visible: snapshot.visible,
    anchorX: snapshot.anchorX,
    anchorY: snapshot.anchorY,
    style: snapshot.style,
  });
}

function normalizePatch(patch: TextLabelPatch): TextStoreLabelPatch {
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

function assertLabelSpec(spec: TextLabelSpec): void {
  if (typeof spec !== "object" || spec === null) {
    throw new TypeError("Label specification must be an object");
  }
  if (typeof spec.text !== "string") {
    throw new TypeError("Label text must be a string");
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
  assertFiniteField("alpha", patch.alpha);
  if (patch.visible !== undefined && typeof patch.visible !== "boolean") {
    throw new TypeError("visible must be a boolean");
  }
  if (patch.scale !== undefined) readPoint(patch.scale, 1);
  if (patch.anchor !== undefined) readPoint(patch.anchor, 0);
  if (patch.style !== undefined && (typeof patch.style !== "object" || patch.style === null)) {
    throw new TypeError("style must be an object");
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
