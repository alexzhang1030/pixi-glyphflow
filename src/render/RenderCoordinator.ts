import type { BLEND_MODES, TextStyleOptions } from "pixi.js";

import { GlyphAtlas } from "../atlas/GlyphAtlas";
import { resolveGlyphIdentity } from "../atlas/glyphIdentity";
import type {
  GlyphAtlasOptions,
  GlyphCacheKey,
  GlyphMode,
  GlyphRaster,
  RasterGlyphProviderOptions,
  RasterGlyphRequest,
} from "../atlas/types";
import type { AtlasCommit } from "../atlas/types";
import type { FontRegistry } from "../FontRegistry";
import { LayoutEngine } from "../layout/LayoutEngine";
import type { LayoutResult, PositionedRun, TextLayoutInput } from "../layout/types";
import type { TrustedGlyphRun } from "../shaping/TrustedGlyphRun";
import { TextDirty } from "../store/types";
import type { TextLayoutOptions, TextShapingOptions } from "../types";
import { GlyphInstanceStore } from "./GlyphInstanceStore";
import { TransformPalette } from "./TransformPalette";
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
  readonly lastLayoutMs: number;
  readonly lastInstanceWriteMs: number;
  readonly lastPaletteWriteMs: number;
}

interface PreparedChange {
  readonly change: RenderChange;
  readonly run?: Readonly<PositionedRun>;
}

const EMPTY_ATLAS_COMMIT: Readonly<AtlasCommit> = Object.freeze({
  entries: Object.freeze([]),
  uploads: Object.freeze([]),
  evictedKeys: Object.freeze([]),
});

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
  readonly #prototypeSlots = new Map<string, number>();
  readonly #slotPrototypeKeys = new Map<number, string>();
  readonly #slotAtlasKeys = new Map<number, readonly GlyphCacheKey[]>();
  readonly #atlasKeyRefs = new Map<GlyphCacheKey, number>();
  #batchPositions = new Float32Array(0);
  #batchUvs = new Float32Array(0);
  #batchPalette = new Uint32Array(0);
  #batchPages = new Uint16Array(0);
  #batchModes = new Uint8Array(0);
  #batchScales = new Float32Array(0);
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
  #ensuredTicket = 0;
  readonly #registry: FontRegistry;
  #runsByStyle = new WeakMap<object, Map<string, LayoutResult>>();
  readonly #runsByFace = new Map<string, Map<number, Map<string, LayoutResult>>>();
  readonly #runsByExtra = new Map<string, LayoutResult>();
  readonly #prototypeByRun = new WeakMap<object, number>();
  #internRevision = -1;
  #lastLayoutMs = 0;
  #lastInstanceWriteMs = 0;
  #lastPaletteWriteMs = 0;
  readonly #tinySdf: boolean;
  #destroyed = false;

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
    this.#tinySdf = options.rasterizerOptions?.tinySdf === true;
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
    const ticket = ++this.#ticket;
    const prepareStart = performance.now();
    const preparedOrPending = this.#prepareChanges(changes, ticket);
    const prepared = isPromise(preparedOrPending) ? await preparedOrPending : preparedOrPending;
    this.#lastLayoutMs = performance.now() - prepareStart;
    if (ticket !== this.#ticket) {
      this.#staleRevisions += 1;
      return this.#result(revision, true, 0, EMPTY_ATLAS_COMMIT, false);
    }

    const atlasCommit = this.atlas.commitFrame();
    let appliedLabels = 0;
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
        this.#removedLabels += 1;
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
        this.#drawStatesDirty = true;
      }
      const sourceChanged = this.#sourceChanged(change);
      if (sourceChanged) {
        this.#runs.set(change.slot, run);
        this.#writeInstances(change.slot, run, change.snapshot);
        wroteInstances = true;
        this.#shapedLabels += 1;
      } else {
        this.#transformOnlyLabels += 1;
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
    this.#revisions += 1;
    this.#appliedLabels += appliedLabels;

    return this.#result(revision, false, appliedLabels, atlasCommit, drawOrderChanged);
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
    const paletteStart = performance.now();
    const written = this.transforms.writePositions(slots, count, xy);
    this.#lastPaletteWriteMs += performance.now() - paletteStart;
    this.#transformOnlyLabels += count;
    this.#appliedLabels += count;

    return this.#result(0, false, written, EMPTY_ATLAS_COMMIT, false);
  }

  getRun(slot: number): Readonly<PositionedRun> | undefined {
    this.#assertActive();
    return this.#runs.get(slot);
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
      lastLayoutMs: this.#lastLayoutMs,
      lastInstanceWriteMs: this.#lastInstanceWriteMs,
      lastPaletteWriteMs: this.#lastPaletteWriteMs,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#ticket += 1;
    this.#runs.clear();
    this.#drawStates.clear();
    this.#nonZeroZStates = 0;
    this.#pendingGlyphs.clear();
    this.#prototypeSlots.clear();
    this.#slotPrototypeKeys.clear();
    this.#clearIntern();
    this.#slotAtlasKeys.clear();
    this.#atlasKeyRefs.clear();
    this.#ensuredRuns.clear();
    if (this.#ownsLayout) this.#layout.destroy();
    if (this.#ownsProvider) void this.#provider.destroy();
    if (this.#ownsAtlas) this.atlas.destroy();
    if (this.#ownsInstances) this.instances.destroy();
    if (this.#ownsTransforms) this.transforms.destroy();
    this.#destroyed = true;
  }

  #prepareChanges(
    changes: readonly RenderChange[],
    ticket: number,
  ): PreparedChange[] | Promise<PreparedChange[]> {
    const prepared: PreparedChange[] = [];
    const pending: Promise<void>[] = [];
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (change === undefined) throw new Error("Render change list is incomplete");
      const item = this.#prepare(change, ticket);
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

  #prepare(change: RenderChange, ticket: number): PreparedChange | Promise<PreparedChange> {
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
      return this.#finishPrepare(change, snapshot, ticket, change.trustedRun);
    }
    const interned = this.#lookupIntern(snapshot);
    if (interned !== undefined) {
      if (isPromise(interned)) {
        return interned.then((run) => this.#finishPrepare(change, snapshot, ticket, run));
      }
      return this.#finishPrepare(change, snapshot, ticket, interned);
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
        return this.#finishPrepare(change, snapshot, ticket, run);
      });
    }
    return this.#finishPrepare(change, snapshot, ticket, laidOut);
  }

  #finishPrepare(
    change: RenderChange,
    snapshot: Readonly<RenderLabelSnapshot>,
    ticket: number,
    run: Readonly<PositionedRun>,
  ): PreparedChange | Promise<PreparedChange> {
    if (ticket !== this.#ticket) return { change, run };
    const missing = this.#ensureMissingGlyphs(run, snapshot);
    if (missing === undefined) return { change, run };
    return missing.then(() => ({ change, run }));
  }

  /** Duplicate strings share one run object; ensure each (run, size, weight) once per commit. */
  #ensureMissingGlyphs(
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): Promise<void> | undefined {
    if (this.#ensuredTicket !== this.#ticket) {
      this.#ensuredRuns.clear();
      this.#ensuredTicket = this.#ticket;
    }
    const variantKey = `${String(resolveFontSize(snapshot.style.fontSize))}\u0000${String(
      snapshot.style.fontWeight ?? "normal",
    )}`;
    let variants = this.#ensuredRuns.get(run);
    const cached = variants?.get(variantKey);
    if (cached === "done") return undefined;
    if (cached !== undefined) return cached;
    const missing: Promise<void>[] = [];
    for (let index = 0; index < run.glyphCount; index += 1) {
      const pending = this.#ensureGlyph(run, index, snapshot);
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

  #ensureGlyph(
    run: Readonly<PositionedRun>,
    index: number,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): Promise<void> | undefined {
    const mode = this.#glyphMode(run, index);
    const glyphId = run.glyphIds[index] ?? 0;
    const glyphText = lazyGlyphText(run, index, glyphId);
    const identity = resolveGlyphIdentity({
      fontFamily: run.fontFamily,
      ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
      fontRevision: run.fontRevision,
      glyphId,
      glyphText,
      fontSize: resolveFontSize(snapshot.style.fontSize),
      fontWeight: snapshot.style.fontWeight ?? "normal",
      mode,
    });
    const key = identity.key;
    if (this.atlas.get(key) !== undefined) {
      return;
    }
    const pending = this.#pendingGlyphs.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const request = this.atlas.request(key);
    const promise = this.#provider
      .rasterize({
        family: run.fontFamily,
        ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
        fontRevision: run.fontRevision,
        glyphId,
        glyphText: glyphText === "" ? resolveGlyphText(run, index) : glyphText,
        fontSize: identity.fontSize,
        fontWeight: identity.fontWeight,
        mode,
      })
      .then((raster) => {
        if (!this.atlas.stage(request, raster) && this.atlas.get(key) === undefined) {
          throw new Error(`Glyph atlas capacity rejected: ${String(key)}`);
        }
      })
      .finally(() => {
        this.#pendingGlyphs.delete(key);
      });
    this.#pendingGlyphs.set(key, promise);
    return promise;
  }

  #writeInstances(
    slot: number,
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): void {
    const key = prototypeKey(run, snapshot);
    const runPrototype = this.#prototypeByRun.get(run);
    const prototype =
      runPrototype !== undefined && runPrototype !== slot
        ? runPrototype
        : this.#prototypeSlots.get(key);
    if (prototype !== undefined && prototype !== slot && this.instances.clone(prototype, slot)) {
      const prototypeKeys = this.#slotAtlasKeys.get(prototype);
      if (prototypeKeys !== undefined) this.#retainSlotKeys(slot, prototypeKeys);
      else this.#releaseSlotKeys(slot);
    } else {
      this.instances.set(slot, this.#buildInstances(slot, run, snapshot), { skipEquality: true });
    }
    this.#rememberPrototype(slot, key, run);
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

  #rememberPrototype(slot: number, key: string, run: Readonly<PositionedRun>): void {
    const previous = this.#slotPrototypeKeys.get(slot);
    if (previous !== undefined && previous !== key && this.#prototypeSlots.get(previous) === slot) {
      this.#prototypeSlots.delete(previous);
    }
    this.#slotPrototypeKeys.set(slot, key);
    if (this.#prototypeSlots.get(key) === undefined) this.#prototypeSlots.set(key, slot);
    if (this.#prototypeByRun.get(run) === undefined) this.#prototypeByRun.set(run, slot);
  }

  #forgetPrototype(slot: number): void {
    const run = this.#runs.get(slot);
    if (run !== undefined && this.#prototypeByRun.get(run) === slot) {
      this.#prototypeByRun.delete(run);
    }
    const key = this.#slotPrototypeKeys.get(slot);
    this.#slotPrototypeKeys.delete(slot);
    if (key !== undefined && this.#prototypeSlots.get(key) === slot) {
      this.#prototypeSlots.delete(key);
    }
  }

  #lookupIntern(snapshot: Readonly<RenderLabelSnapshot>): LayoutResult | undefined {
    this.#syncInternRevision();
    if (!internUsesFaceMap(snapshot)) return this.#runsByExtra.get(extraInternKey(snapshot));
    const byStyle = this.#runsByStyle.get(snapshot.style)?.get(snapshot.text);
    if (byStyle !== undefined) return byStyle;
    const family = internFamily(snapshot.style.fontFamily);
    const quant = internFaceQuant(snapshot.style);
    return this.#runsByFace.get(family)?.get(quant)?.get(snapshot.text);
  }

  #storeIntern(snapshot: Readonly<RenderLabelSnapshot>, result: LayoutResult): void {
    this.#syncInternRevision();
    if (!internUsesFaceMap(snapshot)) {
      this.#runsByExtra.set(extraInternKey(snapshot), result);
      return;
    }
    let byText = this.#runsByStyle.get(snapshot.style);
    if (byText === undefined) {
      byText = new Map();
      this.#runsByStyle.set(snapshot.style, byText);
    }
    byText.set(snapshot.text, result);
    const family = internFamily(snapshot.style.fontFamily);
    let byQuant = this.#runsByFace.get(family);
    if (byQuant === undefined) {
      byQuant = new Map();
      this.#runsByFace.set(family, byQuant);
    }
    const quant = internFaceQuant(snapshot.style);
    let byFaceText = byQuant.get(quant);
    if (byFaceText === undefined) {
      byFaceText = new Map();
      byQuant.set(quant, byFaceText);
    }
    byFaceText.set(snapshot.text, result);
  }

  #syncInternRevision(): void {
    const revision = this.#registry.stats.revision;
    if (revision === this.#internRevision) return;
    this.#clearIntern();
    this.#internRevision = revision;
  }

  #clearIntern(): void {
    this.#runsByStyle = new WeakMap();
    this.#runsByFace.clear();
    this.#runsByExtra.clear();
    this.#internRevision = -1;
  }

  #buildInstances(
    slot: number,
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): GlyphInstanceBatch {
    const count = run.glyphCount;
    this.#ensureBatchCapacity(count);
    const positions = this.#batchPositions.subarray(0, count * 4);
    const uvs = this.#batchUvs.subarray(0, count * 4);
    const paletteIndices = this.#batchPalette.subarray(0, count);
    const pages = this.#batchPages.subarray(0, count);
    const modes = this.#batchModes.subarray(0, count);
    const rasterScales = this.#batchScales.subarray(0, count);
    const uniqueKeys: GlyphCacheKey[] = [];
    const seenKeys = this.#seenAtlasKeys;
    seenKeys.clear();
    for (let index = 0; index < count; index += 1) {
      const mode = this.#glyphMode(run, index);
      const glyphId = run.glyphIds[index] ?? 0;
      const glyphText = lazyGlyphText(run, index, glyphId);
      const identity = resolveGlyphIdentity({
        fontFamily: run.fontFamily,
        ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
        fontRevision: run.fontRevision,
        glyphId,
        glyphText,
        fontSize: resolveFontSize(snapshot.style.fontSize),
        fontWeight: snapshot.style.fontWeight ?? "normal",
        mode,
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
      const outputOffset = index * 4;
      const rasterScale = entry.metrics?.rasterScale ?? 1;
      positions[outputOffset] = (run.x[index] ?? 0) + (entry.metrics?.bearingX ?? 0) - run.bounds.x;
      positions[outputOffset + 1] =
        (run.y[index] ?? 0) - (entry.metrics?.bearingY ?? 0) - run.bounds.y;
      positions[outputOffset + 2] = entry.width / rasterScale;
      positions[outputOffset + 3] = entry.height / rasterScale;
      uvs[outputOffset] = entry.u0;
      uvs[outputOffset + 1] = entry.v0;
      uvs[outputOffset + 2] = entry.u1;
      uvs[outputOffset + 3] = entry.v1;
      paletteIndices[index] = slot;
      pages[index] = entry.page;
      modes[index] = modeCode(entry.mode);
      rasterScales[index] = rasterScale;
    }
    this.#retainSlotKeys(slot, uniqueKeys);

    return { positions, uvs, paletteIndices, pages, modes, rasterScales };
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
      atlasUploads: atlasCommit.uploads.length,
      atlasCommit,
      drawOrderChanged,
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
}

class LazyRasterGlyphProvider implements GlyphProviderLike {
  readonly #registry: FontRegistry;
  readonly #options: RasterGlyphProviderOptions | undefined;
  #pending: Promise<GlyphProviderLike> | undefined;

  constructor(registry: FontRegistry, options: RasterGlyphProviderOptions | undefined) {
    this.#registry = registry;
    this.#options = options;
  }

  async rasterize(request: RasterGlyphRequest): Promise<Readonly<GlyphRaster>> {
    const provider = await this.#get();
    return provider.rasterize(request);
  }

  async destroy(): Promise<void> {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) return;
    await pending.then(
      async (provider) => provider.destroy(),
      () => undefined,
    );
  }

  #get(): Promise<GlyphProviderLike> {
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

function internUsesFaceMap(snapshot: Readonly<RenderLabelSnapshot>): boolean {
  const writingMode = snapshot.layout?.writingMode;
  if (writingMode !== undefined && writingMode !== "horizontal-tb") return false;
  if (snapshot.shaping !== undefined) return false;
  const italic = snapshot.style.fontStyle;
  if (italic !== undefined && italic !== "normal") return false;
  const family = snapshot.style.fontFamily;
  return typeof family === "string" || family === undefined;
}

function internFamily(family: unknown): string {
  return typeof family === "string" && family.length > 0 ? family : "Arial";
}

function internFaceQuant(style: Readonly<TextStyleOptions>): number {
  return resolveFontSize(style.fontSize) * 1024 + internWeightClass(style.fontWeight);
}

function internWeightClass(weight: unknown): number {
  if (typeof weight === "number" && Number.isFinite(weight)) {
    return Math.max(1, Math.min(1000, Math.round(weight)));
  }
  if (weight === "bold") return 700;
  if (weight === "lighter") return 300;
  if (weight === "bolder") return 800;
  return 400;
}

function extraInternKey(snapshot: Readonly<RenderLabelSnapshot>): string {
  const shaping = snapshot.shaping;
  const variations =
    shaping?.variations === undefined
      ? ""
      : Object.entries(shaping.variations)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([axis, value]) => `${axis}=${String(value)}`)
          .join(",");
  return [
    snapshot.text,
    String(snapshot.style.fontFamily ?? ""),
    String(resolveFontSize(snapshot.style.fontSize)),
    String(snapshot.style.fontWeight ?? ""),
    String(snapshot.style.fontStyle ?? ""),
    snapshot.layout?.writingMode ?? "",
    shaping?.direction ?? "",
    shaping?.language ?? "",
    shaping?.script ?? "",
    shaping?.features?.join(",") ?? "",
    variations,
  ].join("\0");
}

function prototypeKey(
  run: Readonly<PositionedRun>,
  snapshot: Readonly<RenderLabelSnapshot>,
): string {
  return [
    run.source,
    run.fontFamily,
    String(run.fontRevision),
    run.text,
    String(resolveFontSize(snapshot.style.fontSize)),
    String(snapshot.style.fontWeight ?? "normal"),
    snapshot.layout?.writingMode ?? "horizontal-tb",
    String(run.glyphCount),
  ].join("\0");
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
 * Packed atlas identities ignore `glyphText` when a glyph id is present, and HarfBuzz runs carry no
 * glyph keys, so deriving the text there would slice the remaining code points per glyph.
 */
function lazyGlyphText(run: Readonly<PositionedRun>, index: number, glyphId: number): string {
  return glyphId > 0 && run.source === "harfbuzz" ? "" : resolveGlyphText(run, index);
}

function resolveGlyphText(run: Readonly<PositionedRun>, index: number): string {
  const key = run.glyphKeys?.[index];
  if (key !== undefined && key.length > 0) return key;
  const cluster = run.clusters[index] ?? 0;
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
