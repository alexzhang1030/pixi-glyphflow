import { Container, type DestroyOptions, type Renderer, type TextStyleOptions } from "pixi.js";

import { TextStore } from "./store/TextStore";
import { TextDirty, type TextDirtyMask, type TextStoreLabelPatch } from "./store/types";
import type {
  TextId,
  TextCompactionResult,
  TextLabelPatch,
  TextLabelSnapshot,
  TextLabelSpec,
  TextLayerOptions,
  TextLayerStats,
  TextRevision,
  TextUpdate,
} from "./types";

const EMPTY_STYLE: Readonly<TextStyleOptions> = Object.freeze({});
const ALL_DIRTY = TextDirty.Content | TextDirty.Transform | TextDirty.Style;

/**
 * Dense, revisioned text state and the PixiJS scene-object seam for glyph rendering.
 *
 * Label mutations remain synchronous. {@link commit} publishes accepted work through one monotonic
 * revision and provides the async boundary used by shaping, atlas, and upload stages.
 */
export class TextLayer extends Container {
  readonly #store: TextStore;
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

  constructor(options: TextLayerOptions = {}) {
    super();
    this.#store =
      options.initialCapacity === undefined
        ? new TextStore()
        : new TextStore({ initialCapacity: options.initialCapacity });
    this.#renderer = options.renderer;
  }

  /** Create one label and return its layer-local identity. */
  create(spec: TextLabelSpec): TextId {
    this.#assertActive();
    assertLabelSpec(spec);
    const id = this.#store.create(normalizeLabel(spec));
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

    const ids: TextId[] = [];
    for (const spec of specs) {
      ids.push(this.#store.create(normalizeLabel(spec)));
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
    const changed = this.#store.updatePositions(ids, positions);
    this.#recordMutation(TextDirty.Transform, changed);

    return changed;
  }

  /** Remove one label and report whether it existed. */
  remove(id: TextId): boolean {
    this.#assertActive();
    const removed = this.#store.remove(id);
    this.#recordMutation(ALL_DIRTY, Number(removed));

    return removed;
  }

  /** Remove current identities and return the removal count. */
  removeMany(ids: readonly TextId[] | Float64Array): number {
    this.#assertActive();
    let removed = 0;
    for (const id of ids) {
      removed += Number(this.#store.remove(id as TextId));
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
      this.#recordMutation(ALL_DIRTY, removed);
    }

    return removed;
  }

  /** Shrink unused reserved CPU capacity while preserving every current identity. */
  compact(): Readonly<TextCompactionResult> {
    this.#assertActive();
    return this.#store.compact();
  }

  /** Publish accepted mutations as one monotonic revision. */
  commit(): Promise<TextRevision> {
    this.#assertActive();
    if (this.#pendingMutations === 0) {
      this.#lastCommitDurationMs = 0;
      this.#lastCommitDirtyLabels = 0;
      this.#lastCommitContentLabels = 0;
      this.#lastCommitTransformLabels = 0;
      this.#lastCommitStyleLabels = 0;
      return Promise.resolve(this.#revision as TextRevision);
    }
    if (this.#revision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("TextLayer revision capacity exhausted");
    }

    const start = performance.now();
    const dirty = this.#store.publishDirty();
    this.#revision += 1;
    this.#pendingMutations = 0;
    this.#commits += 1;
    this.#lastCommitDirtyLabels = dirty.labels;
    this.#lastCommitContentLabels = dirty.content;
    this.#lastCommitTransformLabels = dirty.transform;
    this.#lastCommitStyleLabels = dirty.style;
    this.#lastCommitDurationMs = performance.now() - start;

    return Promise.resolve(this.#revision as TextRevision);
  }

  /** Associate the layer with the renderer that owns future glyph resources. */
  attach(renderer: Renderer): void {
    this.#assertActive();
    this.#renderer = renderer;
  }

  /** Release the current renderer association. */
  detach(): void {
    this.#assertActive();
    this.#renderer = undefined;
  }

  /** Read an immutable diagnostics snapshot. */
  get stats(): Readonly<TextLayerStats> {
    const store = this.#store.stats;
    const pendingDirty = this.#store.pendingDirty;

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
    });
  }

  /** Release state, renderer associations, and PixiJS resources. */
  override destroy(options: DestroyOptions = { children: true }): void {
    if (this.destroyed) {
      return;
    }

    this.#renderer = undefined;
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

  #assertActive(): void {
    if (this.destroyed) {
      throw new Error("TextLayer has been destroyed");
    }
  }
}

function normalizeLabel(spec: TextLabelSpec): Parameters<TextStore["create"]>[0] {
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

  return {
    text: spec.text,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    scaleX: spec.scaleX ?? scaleX,
    scaleY: spec.scaleY ?? scaleY,
    rotation: spec.rotation ?? 0,
    alpha: spec.alpha ?? 1,
    visible: spec.visible ?? true,
    anchorX,
    anchorY,
    style: spec.style ?? EMPTY_STYLE,
  };
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
