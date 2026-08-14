import type { Container } from "pixi.js";

import type { MutableBoundsData } from "../culling/types";
import { TEXT_LAYER_COMMIT_EVENT, type TextLayer } from "../TextLayer";
import type { TextId } from "../types";
import type {
  AccessibilityAdapterOptions,
  AccessibilityAdapterStats,
  AccessibleLabelOptions,
} from "./types";

interface MirrorState {
  readonly text: string;
  readonly role: string | undefined;
  readonly label: string | undefined;
  readonly description: string | undefined;
  readonly tabIndex: number | undefined;
  readonly lang: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hidden: boolean;
}

interface Mirror {
  readonly element: HTMLElement;
  state: Readonly<MirrorState> | undefined;
}

const EMPTY_OPTIONS: Readonly<AccessibleLabelOptions> = Object.freeze({});

/** Sparse DOM mirror for labels that need screen-reader or keyboard exposure. */
export class AccessibilityAdapter {
  readonly element: HTMLElement;
  readonly #layer: TextLayer;
  readonly #coordinateSpace: "local" | "world";
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #selected = new Map<TextId, Readonly<AccessibleLabelOptions>>();
  readonly #mirrors = new Map<TextId, Mirror>();
  readonly #bounds: MutableBoundsData = { x: 0, y: 0, width: 0, height: 0 };
  readonly #onCommit = (): void => {
    try {
      this.sync();
    } catch (error: unknown) {
      this.#onError?.(error);
    }
  };
  readonly #onLayerDestroyed = (): void => this.destroy();
  #syncs = 0;
  #createdElements = 0;
  #updatedElements = 0;
  #removedElements = 0;
  #lastUpdatedElements = 0;
  #lastBounds: Readonly<MutableBoundsData> | undefined;
  #destroyed = false;

  constructor(layer: TextLayer, options: AccessibilityAdapterOptions) {
    assertOptions(options);
    if (layer.destroyed) throw new Error("TextLayer has been destroyed");
    this.#layer = layer;
    this.#coordinateSpace = options.coordinateSpace ?? "world";
    this.#onError = options.onError;
    this.element = options.container.ownerDocument.createElement("div");
    this.element.dataset.pixiGlyphflowAccessibility = "true";
    if (options.className !== undefined) this.element.className = options.className;
    Object.assign(this.element.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "visible",
    });
    options.container.append(this.element);
    layer.on(TEXT_LAYER_COMMIT_EVENT, this.#onCommit);
    layer.once("destroyed", this.#onLayerDestroyed);
  }

  /** Select one current label and return its stable mirror element. */
  select(id: TextId, options: AccessibleLabelOptions = EMPTY_OPTIONS): HTMLElement {
    this.#assertActive();
    if (!this.#layer.has(id)) throw new RangeError(`Unknown or stale TextId: ${String(id)}`);
    const normalized = normalizeLabelOptions(options);
    this.#selected.set(id, normalized);
    const mirror = this.#ensureMirror(id);
    if (this.#syncMirror(id, normalized, mirror)) {
      this.#lastUpdatedElements = 1;
      this.#updatedElements += 1;
    }

    return mirror.element;
  }

  /** Remove one label from the DOM mirror. */
  deselect(id: TextId): boolean {
    this.#assertActive();
    const selected = this.#selected.delete(id);
    const mirror = this.#mirrors.get(id);
    if (mirror !== undefined) this.#removeMirror(id, mirror);

    return selected;
  }

  /** Read the stable mirror element for a selected label. */
  getElement(id: TextId): HTMLElement | undefined {
    this.#assertActive();
    return this.#mirrors.get(id)?.element;
  }

  /** Incrementally synchronize selected labels and return the number of changed DOM elements. */
  sync(): number {
    this.#assertActive();
    let updated = 0;
    for (const [id, options] of this.#selected) {
      const mirror = this.#ensureMirror(id);
      if (this.#syncMirror(id, options, mirror)) updated += 1;
    }
    this.#syncs += 1;
    this.#lastUpdatedElements = updated;
    this.#updatedElements += updated;

    return updated;
  }

  /** Remove every selected label and owned mirror element. */
  clear(): number {
    this.#assertActive();
    const removed = this.#selected.size;
    this.#selected.clear();
    for (const [id, mirror] of this.#mirrors) this.#removeMirror(id, mirror);

    return removed;
  }

  get stats(): Readonly<AccessibilityAdapterStats> {
    return Object.freeze({
      selectedLabels: this.#selected.size,
      mirroredLabels: this.#mirrors.size,
      syncs: this.#syncs,
      createdElements: this.#createdElements,
      updatedElements: this.#updatedElements,
      removedElements: this.#removedElements,
      lastUpdatedElements: this.#lastUpdatedElements,
      lastBounds: this.#lastBounds,
      destroyed: this.#destroyed,
    });
  }

  /** Release listeners and the owned overlay. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#layer.off(TEXT_LAYER_COMMIT_EVENT, this.#onCommit);
    this.#layer.off("destroyed", this.#onLayerDestroyed);
    this.#selected.clear();
    for (const [id, mirror] of this.#mirrors) this.#removeMirror(id, mirror);
    this.element.remove();
    this.#destroyed = true;
  }

  #ensureMirror(id: TextId): Mirror {
    const current = this.#mirrors.get(id);
    if (current !== undefined) return current;
    const element = this.element.ownerDocument.createElement("div");
    element.dataset.pixiGlyphflowTextId = String(id);
    Object.assign(element.style, {
      position: "absolute",
      boxSizing: "border-box",
      margin: "0",
      padding: "0",
      border: "0",
      color: "transparent",
      background: "transparent",
      opacity: "0",
      overflow: "hidden",
      whiteSpace: "pre",
      pointerEvents: "none",
    });
    this.element.append(element);
    const mirror: Mirror = { element, state: undefined };
    this.#mirrors.set(id, mirror);
    this.#createdElements += 1;

    return mirror;
  }

  #syncMirror(id: TextId, options: Readonly<AccessibleLabelOptions>, mirror: Mirror): boolean {
    const snapshot = this.#layer.get(id);
    const bounds = this.#layer.getBoundsFor(id, this.#bounds, this.#coordinateSpace);
    if (snapshot === undefined || bounds === undefined) {
      this.#selected.delete(id);
      this.#removeMirror(id, mirror);
      return true;
    }
    const state: Readonly<MirrorState> = {
      text: snapshot.text,
      role: options.role,
      label: options.label,
      description: options.description,
      tabIndex: options.tabIndex,
      lang: options.lang,
      x: bounds.x,
      y: bounds.y,
      width: Math.max(0, bounds.width),
      height: Math.max(0, bounds.height),
      hidden:
        !snapshot.visible ||
        snapshot.alpha <= 0 ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        !ancestorsVisible(this.#layer),
    };
    if (equalState(mirror.state, state)) return false;
    applyState(mirror.element, state);
    mirror.state = state;
    this.#lastBounds = Object.freeze({
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
    });

    return true;
  }

  #removeMirror(id: TextId, mirror: Mirror): void {
    mirror.element.remove();
    this.#mirrors.delete(id);
    this.#removedElements += 1;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("AccessibilityAdapter has been destroyed");
  }
}

function normalizeLabelOptions(options: AccessibleLabelOptions): Readonly<AccessibleLabelOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Accessible label options must be an object");
  }
  assertOptionalString("role", options.role, false);
  assertOptionalString("label", options.label, true);
  assertOptionalString("description", options.description, true);
  assertOptionalString("lang", options.lang, false);
  if (options.tabIndex !== undefined && !Number.isSafeInteger(options.tabIndex)) {
    throw new TypeError("tabIndex must be a safe integer");
  }

  return Object.freeze({ ...options });
}

function assertOptions(options: AccessibilityAdapterOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Accessibility adapter options must be an object");
  }
  if (options.container?.ownerDocument === undefined) {
    throw new TypeError("container must be an HTMLElement");
  }
  if (options.className !== undefined && typeof options.className !== "string") {
    throw new TypeError("className must be a string");
  }
  if (
    options.coordinateSpace !== undefined &&
    options.coordinateSpace !== "local" &&
    options.coordinateSpace !== "world"
  ) {
    throw new TypeError('coordinateSpace must be "local" or "world"');
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("onError must be a function");
  }
}

function assertOptionalString(name: string, value: string | undefined, allowEmpty: boolean): void {
  if (value === undefined) return;
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function applyState(element: HTMLElement, state: Readonly<MirrorState>): void {
  element.textContent = state.text;
  setOptionalAttribute(element, "role", state.role);
  setOptionalAttribute(element, "aria-label", state.label);
  setOptionalAttribute(element, "aria-description", state.description);
  setOptionalAttribute(element, "lang", state.lang);
  if (state.tabIndex === undefined) element.removeAttribute("tabindex");
  else element.tabIndex = state.tabIndex;
  element.hidden = state.hidden;
  element.setAttribute("aria-hidden", String(state.hidden));
  element.style.left = `${String(state.x)}px`;
  element.style.top = `${String(state.y)}px`;
  element.style.width = `${String(state.width)}px`;
  element.style.height = `${String(state.height)}px`;
}

function setOptionalAttribute(element: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function equalState(
  left: Readonly<MirrorState> | undefined,
  right: Readonly<MirrorState>,
): boolean {
  return (
    left !== undefined &&
    left.text === right.text &&
    left.role === right.role &&
    left.label === right.label &&
    left.description === right.description &&
    left.tabIndex === right.tabIndex &&
    left.lang === right.lang &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.hidden === right.hidden
  );
}

function ancestorsVisible(layer: Container): boolean {
  let current: Container | null = layer;
  while (current !== null) {
    if (!current.visible) return false;
    current = current.parent;
  }

  return true;
}
