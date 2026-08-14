import {
  Container,
  Text,
  type DestroyOptions,
  type Renderer,
  type TextStyleOptions,
} from "pixi.js";

import type { TextId, TextLabelPatch, TextLabelSpec, TextLayerStats, TextRevision } from "./types";

interface LabelRecord {
  readonly view: Text;
}

/**
 * PixiJS-compatible text layer POC.
 *
 * This release renders each label through PixiJS Canvas Text while proving the public mutation,
 * revision, lifecycle, and diagnostics contract. The batched glyph pipe replaces this backend in
 * later milestones.
 *
 * @example
 *   ```ts
 *   const layer = new TextLayer();
 *   app.stage.addChild(layer);
 *
 *   const id = layer.create({ text: "120 FPS", x: 24, y: 24 });
 *   layer.updateLabel(id, { text: "121 FPS" });
 *   await layer.commit();
 *   ```;
 *
 * @see https://pixijs.com/8.x/guides/components/scene-objects/text/canvas
 */
export class TextLayer extends Container<Text> {
  readonly #labels = new Map<TextId, LabelRecord>();
  #nextId = 1;
  #revision = 0;
  #pendingMutations = 0;
  #renderer: Renderer | undefined;

  /** Create a label and return its stable layer-local identity. */
  create(spec: TextLabelSpec): TextId {
    this.#assertActive();
    assertText(spec.text);
    assertFiniteFields(spec);

    const view = new Text({
      text: spec.text,
      style: spec.style ?? {},
    });

    applyPatch(view, spec);

    const id = this.#nextId as TextId;
    this.#nextId += 1;
    this.#labels.set(id, { view });
    this.addChild(view);
    this.#pendingMutations += 1;

    return id;
  }

  /** Apply a partial label update. */
  updateLabel(id: TextId, patch: TextLabelPatch): void {
    this.#assertActive();
    const record = this.#requireLabel(id);

    if (patch.text !== undefined) {
      assertText(patch.text);
    }
    assertFiniteFields(patch);
    applyPatch(record.view, patch);
    this.#pendingMutations += 1;
  }

  /** Remove and release one label. */
  remove(id: TextId): void {
    this.#assertActive();
    const { view } = this.#requireLabel(id);

    this.#labels.delete(id);
    this.removeChild(view);
    view.destroy({ style: true, texture: true, textureSource: true });
    this.#pendingMutations += 1;
  }

  /**
   * Publish all mutations as one monotonic revision.
   *
   * The POC applies Canvas Text changes eagerly; the revision boundary reserves the async commit
   * seam used by shaping, atlas, and GPU upload work in later releases.
   */
  commit(): Promise<TextRevision> {
    this.#assertActive();

    if (this.#pendingMutations > 0) {
      this.#revision += 1;
      this.#pendingMutations = 0;
    }

    return Promise.resolve(this.#revision as TextRevision);
  }

  /** Associate the layer with the renderer that will own future glyphflow resources. */
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
    return Object.freeze({
      backend: "pixi-text-poc",
      labelCount: this.#labels.size,
      pendingMutations: this.#pendingMutations,
      revision: this.#revision as TextRevision,
      attached: this.#renderer !== undefined,
    });
  }

  /** Release labels and renderer state. */
  override destroy(options: DestroyOptions = { children: true }): void {
    if (this.destroyed) {
      return;
    }

    this.#labels.clear();
    this.#renderer = undefined;
    super.destroy(options);
  }

  #assertActive(): void {
    if (this.destroyed) {
      throw new Error("TextLayer has been destroyed");
    }
  }

  #requireLabel(id: TextId): LabelRecord {
    const record = this.#labels.get(id);
    if (record === undefined) {
      throw new RangeError(`Unknown TextId: ${String(id)}`);
    }
    return record;
  }
}

function applyPatch(view: Text, patch: TextLabelPatch): void {
  if (patch.text !== undefined) view.text = patch.text;
  if (patch.x !== undefined) view.x = patch.x;
  if (patch.y !== undefined) view.y = patch.y;
  if (patch.rotation !== undefined) view.rotation = patch.rotation;
  if (patch.alpha !== undefined) view.alpha = patch.alpha;
  if (patch.visible !== undefined) view.visible = patch.visible;
  if (patch.anchor !== undefined) view.anchor = patch.anchor;
  if (patch.style !== undefined) view.style = patch.style as TextStyleOptions;
}

function assertText(text: unknown): asserts text is string {
  if (typeof text !== "string") {
    throw new TypeError("Label text must be a string");
  }
}

function assertFiniteFields(spec: TextLabelPatch): void {
  for (const [name, value] of [
    ["x", spec.x],
    ["y", spec.y],
    ["rotation", spec.rotation],
    ["alpha", spec.alpha],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number`);
    }
  }
}
