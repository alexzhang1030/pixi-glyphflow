import type { BLEND_MODES } from "pixi.js";

import {
  aabbVisible,
  CULL_RECORD_STRIDE,
  cullRecordWorldAabb,
  type CullAabbSpace,
  type CullViewport,
} from "../culling/computeCull";
import type { RenderCoordinator, RenderDrawState } from "./RenderCoordinator";
import { GLYPH_INSTANCE_STRIDE } from "./types";

const ACTIVE_BIT = 0x8000_0000;

export interface DrawSpan {
  readonly offset: number;
  count: number;
  readonly paletteIndex: number;
}

export interface DrawSegment {
  readonly zIndex: number;
  readonly blendMode: BLEND_MODES;
  readonly spans: DrawSpan[];
  count: number;
}

export interface DrawPlan {
  readonly segments: DrawSegment[];
  readonly naturalOrder: boolean;
  readonly count: number;
}

interface SegmentWalk {
  segments: DrawSegment[];
  naturalOrder: boolean;
  count: number;
  lastSourceIndex: number;
}

interface DrawSegmentCache extends SegmentWalk {
  drawEpoch: number;
  segmentEpoch: number;
  stateCount: number;
}

export class GlyphDrawPlanner {
  readonly #coordinator: RenderCoordinator;
  #cache: DrawSegmentCache | undefined;

  constructor(coordinator: RenderCoordinator) {
    this.#coordinator = coordinator;
  }

  /** Full walks are cached; while both epochs hold, states only append and pages are stable. */
  build(view: DataView, included: Uint8Array | undefined = undefined): Readonly<DrawPlan> {
    const states = this.#coordinator.getDrawStates();
    if (included !== undefined) {
      const walk = emptySegmentWalk();
      this.#append(walk, view, states, 0, included);
      return walk;
    }
    const drawEpoch = this.#coordinator.drawListEpoch;
    const segmentEpoch = this.#coordinator.instances.segmentEpoch;
    const cached = this.#cache;
    if (
      cached !== undefined &&
      cached.drawEpoch === drawEpoch &&
      cached.segmentEpoch === segmentEpoch &&
      cached.stateCount <= states.length
    ) {
      if (cached.stateCount < states.length) {
        this.#append(cached, view, states, cached.stateCount, undefined);
        cached.stateCount = states.length;
      }
      return cached;
    }
    const walk: DrawSegmentCache = {
      ...emptySegmentWalk(),
      drawEpoch,
      segmentEpoch,
      stateCount: states.length,
    };
    this.#append(walk, view, states, 0, undefined);
    if (walk.segments.reduce((sum, segment) => sum + segment.count, 0) !== walk.count) {
      throw new Error("Draw segment glyph count differs from active instance count");
    }
    this.#cache = walk;
    return walk;
  }

  /** Expand label-indexed resident records whose prototype draw states are intentionally shared. */
  buildResidentCullRecords(
    records: ArrayBuffer,
    viewport: CullViewport,
    recordCount: number,
  ): Readonly<DrawPlan> {
    return planResidentCullDraw(records, viewport, recordCount);
  }

  visibleCullRecords(
    records: ArrayBuffer,
    viewport: CullViewport,
    recordCount: number,
    aabbSpace: CullAabbSpace = "world",
    originX?: Float32Array,
    originY?: Float32Array,
  ): Uint8Array {
    const states = this.#coordinator.getDrawStates();
    if (recordCount !== states.length) {
      throw new Error("Cull record count differs from draw state count");
    }
    const floats = new Float32Array(records);
    const uints = new Uint32Array(records);
    const included = new Uint8Array(recordCount);
    for (let index = 0; index < recordCount; index += 1) {
      const box = cullRecordWorldAabb(floats, uints, index, aabbSpace, originX, originY);
      included[index] = Number(aabbVisible(box.minX, box.minY, box.maxX, box.maxY, viewport));
    }
    return included;
  }

  #append(
    walk: SegmentWalk,
    view: DataView,
    states: readonly Readonly<RenderDrawState>[],
    startIndex: number,
    included: Uint8Array | undefined,
  ): void {
    const segments = walk.segments;
    for (let stateIndex = startIndex; stateIndex < states.length; stateIndex += 1) {
      if (included !== undefined && included[stateIndex] !== 1) continue;
      const state = states[stateIndex];
      if (state === undefined) throw new Error("Draw state list is incomplete");
      const range = this.#coordinator.instances.getRange(state.slot);
      if (range === undefined) continue;
      walk.count += range.count;
      for (let index = 0; index < range.count; index += 1) {
        const sourceIndex = range.offset + index;
        const metadata = view.getUint32(sourceIndex * GLYPH_INSTANCE_STRIDE + 20, true);
        if ((metadata & ACTIVE_BIT) === 0) {
          throw new Error(`Inactive glyph found in label range ${String(state.slot)}`);
        }
        if (sourceIndex <= walk.lastSourceIndex) walk.naturalOrder = false;
        walk.lastSourceIndex = sourceIndex;
        let segment = segments[segments.length - 1];
        if (
          segment === undefined ||
          segment.zIndex !== state.zIndex ||
          segment.blendMode !== state.blendMode
        ) {
          segment = { zIndex: state.zIndex, blendMode: state.blendMode, spans: [], count: 0 };
          segments.push(segment);
        }
        const span = segment.spans[segment.spans.length - 1];
        if (
          span !== undefined &&
          span.offset + span.count === sourceIndex &&
          span.paletteIndex === state.slot
        ) {
          span.count += 1;
        } else {
          segment.spans.push({ offset: sourceIndex, count: 1, paletteIndex: state.slot });
        }
        segment.count += 1;
      }
    }
  }
}

/** @internal Build CPU compact spans directly from the resident record ABI. */
export function planResidentCullDraw(
  records: ArrayBuffer,
  viewport: CullViewport,
  recordCount: number,
): Readonly<DrawPlan> {
  if (!(records instanceof ArrayBuffer)) {
    throw new TypeError("Resident cull records must be an ArrayBuffer");
  }
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new TypeError("Resident cull record count must be a non-negative safe integer");
  }
  const liveBytes = recordCount * CULL_RECORD_STRIDE;
  if (!Number.isSafeInteger(liveBytes) || records.byteLength < liveBytes) {
    throw new RangeError("Resident cull records are shorter than recordCount");
  }
  const floats = new Float32Array(records);
  const uints = new Uint32Array(records);
  const wordsPerRecord = CULL_RECORD_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
  const segment: DrawSegment = { zIndex: 0, blendMode: "normal", spans: [], count: 0 };
  let naturalOrder = true;
  let lastSourceIndex = -1;
  for (let index = 0; index < recordCount; index += 1) {
    const base = index * wordsPerRecord;
    const instanceCount = uints[base + 5] ?? 0;
    if (instanceCount === 0) continue;
    if (
      !aabbVisible(
        floats[base] ?? 0,
        floats[base + 1] ?? 0,
        floats[base + 2] ?? 0,
        floats[base + 3] ?? 0,
        viewport,
      )
    ) {
      continue;
    }
    const instanceOffset = uints[base + 4] ?? 0;
    const paletteIndex = uints[base + 6] ?? 0;
    if (instanceOffset + instanceCount > 0x1_0000_0000) {
      throw new RangeError("Resident cull instance range exceeds uint32 capacity");
    }
    if (instanceOffset <= lastSourceIndex) naturalOrder = false;
    lastSourceIndex = instanceOffset + instanceCount - 1;
    const previous = segment.spans[segment.spans.length - 1];
    if (
      previous !== undefined &&
      previous.paletteIndex === paletteIndex &&
      previous.offset + previous.count === instanceOffset
    ) {
      previous.count += instanceCount;
    } else {
      segment.spans.push({ offset: instanceOffset, count: instanceCount, paletteIndex });
    }
    segment.count += instanceCount;
  }
  return {
    segments: segment.count === 0 ? [] : [segment],
    naturalOrder,
    count: segment.count,
  };
}

function emptySegmentWalk(): SegmentWalk {
  return { segments: [], naturalOrder: true, count: 0, lastSourceIndex: -1 };
}
