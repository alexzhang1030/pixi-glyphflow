import type { BLEND_MODES, TextStyleOptions } from "pixi.js";

import { GlyphAtlas } from "../atlas/GlyphAtlas";
import { RasterGlyphProvider } from "../atlas/RasterGlyphProvider";
import type {
  GlyphAtlasOptions,
  GlyphMode,
  GlyphRaster,
  RasterGlyphProviderOptions,
  RasterGlyphRequest,
} from "../atlas/types";
import type { AtlasCommit } from "../atlas/types";
import type { FontRegistry } from "../FontRegistry";
import { LayoutEngine } from "../layout/LayoutEngine";
import type { PositionedRun, TextLayoutInput } from "../layout/types";
import type { TrustedGlyphRun } from "../shaping/TrustedGlyphRun";
import { TextDirty } from "../store/types";
import type { TextShapingOptions } from "../types";
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
  readonly shaping?: Readonly<TextShapingOptions>;
}

export interface RenderChange {
  readonly slot: number;
  readonly mask: number;
  readonly snapshot: Readonly<RenderLabelSnapshot> | undefined;
  readonly trustedRun?: TrustedGlyphRun;
}

export interface RenderLayoutEngineLike {
  layout(
    labelId: number,
    sourceRevision: number,
    input: TextLayoutInput,
  ): Promise<Readonly<PositionedRun>>;
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
  readonly #pendingGlyphs = new Map<string, Promise<void>>();
  #ticket = 0;
  #revisions = 0;
  #staleRevisions = 0;
  #appliedLabels = 0;
  #shapedLabels = 0;
  #transformOnlyLabels = 0;
  #removedLabels = 0;
  #lastAddedOrder = 0;
  #needsDrawSort = false;
  #destroyed = false;

  constructor(options: RenderCoordinatorOptions) {
    this.#layout = options.layoutEngine ?? new LayoutEngine(options.registry);
    this.#provider =
      options.glyphProvider ?? new RasterGlyphProvider(options.registry, options.rasterizerOptions);
    this.atlas = options.atlas ?? new GlyphAtlas(options.atlasOptions);
    this.instances = options.instances ?? new GlyphInstanceStore(options.instanceOptions);
    this.transforms = options.transforms ?? new TransformPalette(options.transformOptions);
    this.#ownsLayout = options.layoutEngine === undefined;
    this.#ownsProvider = options.glyphProvider === undefined;
    this.#ownsAtlas = options.atlas === undefined;
    this.#ownsInstances = options.instances === undefined;
    this.#ownsTransforms = options.transforms === undefined;
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
    const ticket = ++this.#ticket;
    const prepared = await Promise.all(changes.map((change) => this.#prepare(change, ticket)));
    if (ticket !== this.#ticket) {
      this.#staleRevisions += 1;
      return this.#result(revision, true, 0, EMPTY_ATLAS_COMMIT, false);
    }

    const atlasCommit = this.atlas.commitFrame();
    let appliedLabels = 0;
    let drawOrderChanged = false;
    for (const item of prepared) {
      const { change, run } = item;
      if (change.snapshot === undefined) {
        this.#runs.delete(change.slot);
        drawOrderChanged = this.#drawStates.delete(change.slot) || drawOrderChanged;
        this.instances.remove(change.slot);
        this.transforms.remove(change.slot);
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
        if (previousDrawState === undefined) {
          if (change.snapshot.order < this.#lastAddedOrder) this.#needsDrawSort = true;
          this.#lastAddedOrder = Math.max(this.#lastAddedOrder, change.snapshot.order);
        }
        if (change.snapshot.zIndex !== 0 || previousDrawState?.zIndex !== 0) {
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
      }
      const sourceChanged =
        (change.mask & (TextDirty.Content | TextDirty.Style)) !== 0 ||
        this.#runs.get(change.slot) === undefined;
      if (sourceChanged) {
        this.#runs.set(change.slot, run);
        this.instances.set(change.slot, this.#buildInstances(change.slot, run, change.snapshot));
        this.#shapedLabels += 1;
      } else {
        this.#transformOnlyLabels += 1;
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
    this.#revisions += 1;
    this.#appliedLabels += appliedLabels;

    return this.#result(revision, false, appliedLabels, atlasCommit, drawOrderChanged);
  }

  getRun(slot: number): Readonly<PositionedRun> | undefined {
    this.#assertActive();
    return this.#runs.get(slot);
  }

  getDrawStates(): readonly Readonly<RenderDrawState>[] {
    this.#assertActive();
    const states = Array.from(this.#drawStates.values());
    if (this.#needsDrawSort) {
      states.sort((left, right) => left.zIndex - right.zIndex || left.order - right.order);
    }
    return states;
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
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#ticket += 1;
    this.#runs.clear();
    this.#drawStates.clear();
    this.#pendingGlyphs.clear();
    if (this.#ownsLayout) this.#layout.destroy();
    if (this.#ownsProvider) void this.#provider.destroy();
    if (this.#ownsAtlas) this.atlas.destroy();
    if (this.#ownsInstances) this.instances.destroy();
    if (this.#ownsTransforms) this.transforms.destroy();
    this.#destroyed = true;
  }

  async #prepare(change: RenderChange, ticket: number): Promise<PreparedChange> {
    const snapshot = change.snapshot;
    if (snapshot === undefined) {
      return { change };
    }
    const sourceChanged =
      (change.mask & (TextDirty.Content | TextDirty.Style)) !== 0 ||
      this.#runs.get(change.slot) === undefined;
    if (!sourceChanged) {
      const run = this.#runs.get(change.slot);
      if (run === undefined) {
        throw new Error(`Render run missing for transform slot ${String(change.slot)}`);
      }
      return { change, run };
    }

    const run =
      change.trustedRun ??
      (await this.#layout.layout(change.slot, snapshot.sourceRevision, {
        text: snapshot.text,
        style: snapshot.style,
        ...snapshot.shaping,
      }));
    if (ticket !== this.#ticket) {
      return { change, run };
    }
    await Promise.all(
      Array.from({ length: run.glyphCount }, (_, index) => this.#ensureGlyph(run, index, snapshot)),
    );

    return { change, run };
  }

  async #ensureGlyph(
    run: Readonly<PositionedRun>,
    index: number,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): Promise<void> {
    const mode = selectMode(run, index);
    const glyphText = resolveGlyphText(run, index);
    const glyphId = run.glyphIds[index] ?? 0;
    const fontSize = resolveFontSize(snapshot.style.fontSize);
    const key = glyphKey(run, glyphId, glyphText, fontSize, mode);
    if (this.atlas.get(key) !== undefined) {
      return;
    }
    const pending = this.#pendingGlyphs.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const promise = (async () => {
      const request = this.atlas.request(key);
      const raster = await this.#provider.rasterize({
        family: run.fontFamily,
        ...(run.fontFamilies === undefined ? {} : { fontFamilies: run.fontFamilies }),
        fontRevision: run.fontRevision,
        glyphId,
        glyphText,
        fontSize,
        mode,
      });
      if (!this.atlas.stage(request, raster) && this.atlas.get(key) === undefined) {
        throw new Error(`Glyph atlas capacity rejected: ${key}`);
      }
    })();
    this.#pendingGlyphs.set(key, promise);
    try {
      await promise;
    } finally {
      this.#pendingGlyphs.delete(key);
    }
  }

  #buildInstances(
    slot: number,
    run: Readonly<PositionedRun>,
    snapshot: Readonly<RenderLabelSnapshot>,
  ): GlyphInstanceBatch {
    const count = run.glyphCount;
    const positions = new Float32Array(count * 4);
    const uvs = new Float32Array(count * 4);
    const paletteIndices = new Uint32Array(count);
    const pages = new Uint16Array(count);
    const modes = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      const mode = selectMode(run, index);
      const glyphText = resolveGlyphText(run, index);
      const glyphId = run.glyphIds[index] ?? 0;
      const fontSize = resolveFontSize(snapshot.style.fontSize);
      const key = glyphKey(run, glyphId, glyphText, fontSize, mode);
      const entry = this.atlas.get(key);
      if (entry === undefined) {
        throw new Error(`Atlas entry missing for positioned glyph: ${key}`);
      }
      const outputOffset = index * 4;
      positions[outputOffset] = (run.x[index] ?? 0) + (entry.metrics?.bearingX ?? 0) - run.bounds.x;
      positions[outputOffset + 1] =
        (run.y[index] ?? 0) - (entry.metrics?.bearingY ?? 0) - run.bounds.y;
      positions[outputOffset + 2] = entry.width;
      positions[outputOffset + 3] = entry.height;
      uvs[outputOffset] = entry.u0;
      uvs[outputOffset + 1] = entry.v0;
      uvs[outputOffset + 2] = entry.u1;
      uvs[outputOffset + 3] = entry.v1;
      paletteIndices[index] = slot;
      pages[index] = entry.page;
      modes[index] = modeCode(entry.mode);
    }

    return { positions, uvs, paletteIndices, pages, modes };
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

function selectMode(run: Readonly<PositionedRun>, index: number): GlyphMode {
  if (run.source === "harfbuzz") return "msdf";
  const text = resolveGlyphText(run, index);
  return /\p{Extended_Pictographic}/u.test(text) ? "color" : "alpha";
}

function resolveGlyphText(run: Readonly<PositionedRun>, index: number): string {
  const key = run.glyphKeys?.[index];
  if (key !== undefined && key.length > 0) return key;
  const cluster = run.clusters[index] ?? 0;
  const suffix = run.text.slice(cluster);
  return Array.from(suffix)[0] ?? "�";
}

function glyphKey(
  run: Readonly<PositionedRun>,
  glyphId: number,
  glyphText: string,
  fontSize: number,
  mode: GlyphMode,
): string {
  return [
    run.fontFamily,
    run.fontFamilies?.join("\u0001") ?? "",
    run.fontRevision,
    glyphId,
    glyphText,
    fontSize,
    mode,
  ].join("\u0000");
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
