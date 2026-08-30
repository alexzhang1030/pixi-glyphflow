export type SymbolContinuityKey = string | number;
export type SymbolContinuityAnchor = string | number;
export type SymbolContinuityPhase = "entering" | "visible" | "exiting" | "retired";

export interface SymbolContinuityIndexOptions {
  /** Hard ceiling for live records and retained tombstones. */
  readonly maxTrackedSymbols?: number;
  readonly initialCapacity?: number;
  readonly fadeInMs?: number;
  readonly fadeOutMs?: number;
  /** Minimum source-absence lifetime after the first missing frame. */
  readonly retentionMs?: number;
  /** First u32 identity issued by this index. Primarily useful for exhaustion fixtures. */
  readonly initialContinuityId?: number;
  /** Complete-state hashing policy. Manual checkpoints keep the frame hot path lean. */
  readonly stateHashMode?: "manual" | "every-frame";
}

export interface SymbolContinuityFrame {
  readonly sceneRevision: number;
  readonly cameraRevision: number;
  readonly zoomRevision: number;
  /** Caller-owned monotonic clock. */
  readonly timeMs: number;
}

export interface MutableSymbolContinuityMatch {
  continuityId: number;
  phase: SymbolContinuityPhase;
  opacity: number;
  targetCandidateKey: SymbolContinuityKey;
  targetAnchor: SymbolContinuityAnchor;
  priority: number;
  insertionOrder: number;
  candidateSelected: boolean;
  sceneRevision: number;
  cameraRevision: number;
  zoomRevision: number;
}

export interface MutableSymbolContinuityState {
  continuityId: number;
  phase: SymbolContinuityPhase;
  opacity: number;
  anchor: SymbolContinuityAnchor | undefined;
  retainedCandidateKey: SymbolContinuityKey | undefined;
  priority: number;
  insertionOrder: number;
  sceneRevision: number;
  cameraRevision: number;
  zoomRevision: number;
  sourceRetireAfterMs: number;
}

export interface SymbolContinuityFrameResult extends SymbolContinuityFrame {
  readonly resolvedCandidates: number;
  readonly seenSymbols: number;
  readonly placedSymbols: number;
  readonly collisionLoserSymbols: number;
  readonly enteringSymbols: number;
  readonly visibleSymbols: number;
  readonly exitingSymbols: number;
  readonly retiredThisFrame: number;
  readonly liveSymbols: number;
  /** FNV-1a over typed identities and bit-level retained state when enabled for every frame. */
  readonly stateHash: number | undefined;
}

export interface SymbolContinuityIndexStats {
  readonly trackedSymbols: number;
  readonly liveSymbols: number;
  readonly retiredSymbols: number;
  readonly capacity: number;
  readonly maxTrackedSymbols: number;
  /** Typed backing storage plus an eight-byte estimate for each reference slot. */
  readonly allocatedBytes: number;
  readonly completedFrames: number;
  readonly abortedFrames: number;
  readonly resolvedCandidatesTotal: number;
  readonly seenSymbolsTotal: number;
  readonly placedSymbolsTotal: number;
  readonly collisionLoserSymbolsTotal: number;
  readonly retiredTotal: number;
  readonly capacityReclaims: number;
  readonly capacityErrors: number;
}

interface ReclaimedRecordSnapshot {
  slot: number;
  id: number;
  phase: number;
  opacity: number;
  phaseStartOpacity: number;
  phaseStartTime: number;
  sourceRetireAfterTime: number;
  priority: number;
  insertionOrder: number;
  sceneRevision: number;
  cameraRevision: number;
  zoomRevision: number;
  key: SymbolContinuityKey | undefined;
  anchor: SymbolContinuityAnchor | undefined;
  retainedCandidateKey: SymbolContinuityKey | undefined;
}

const DEFAULT_MAX_TRACKED_SYMBOLS = 262_144;
const DEFAULT_INITIAL_CAPACITY = 256;
const DEFAULT_FADE_IN_MS = 150;
const DEFAULT_FADE_OUT_MS = 300;
const DEFAULT_RETENTION_MS = 300;
const MAX_U32 = 0xffff_ffff;
const MAX_TRACKED_SYMBOLS_LIMIT = 1_048_576;
const REFERENCE_BYTES = 8;
const SNAPSHOT_ESTIMATED_BYTES = 128;

const RETIRED = 0;
const ENTERING = 1;
const VISIBLE = 2;
const EXITING = 3;

/**
 * Retains logical map-symbol identity across scene, camera, zoom, tile, and collision revisions.
 *
 * Each candidate carries a logical key, candidate key, and authored anchor. A frame may submit
 * several candidates for one logical symbol. Selection uses f32 priority descending, retained
 * candidate preference, insertion order ascending, then typed candidate and anchor order.
 */
export class SymbolContinuityIndex {
  readonly #maxTrackedSymbols: number;
  readonly #fadeInMs: number;
  readonly #fadeOutMs: number;
  readonly #retentionMs: number;
  readonly #stateHashMode: "manual" | "every-frame";

  #capacity = 0;
  #highWater = 0;
  #retiredSymbols = 0;
  #ids = new Uint32Array(0);
  #phases = new Uint8Array(0);
  #opacities = new Float64Array(0);
  #phaseStartOpacities = new Float64Array(0);
  #phaseStartTimes = new Float64Array(0);
  #sourceRetireAfterTimes = new Float64Array(0);
  #priorities = new Float32Array(0);
  #insertionOrders = new Float64Array(0);
  #seenFrames = new Uint32Array(0);
  #placedFrames = new Uint32Array(0);
  #provisionalFrames = new Uint32Array(0);
  #sceneRevisions = new Float64Array(0);
  #cameraRevisions = new Float64Array(0);
  #zoomRevisions = new Float64Array(0);
  #keys: (SymbolContinuityKey | undefined)[] = [];
  #anchors: (SymbolContinuityAnchor | undefined)[] = [];
  #retainedCandidateKeys: (SymbolContinuityKey | undefined)[] = [];

  #targetCandidateKeys: (SymbolContinuityKey | undefined)[] = [];
  #targetAnchors: (SymbolContinuityAnchor | undefined)[] = [];
  #targetCandidateAdmissions = new Uint8Array(0);
  #targetPriorities = new Float32Array(0);
  #targetInsertionOrders = new Float64Array(0);
  #frameBasePhases = new Uint8Array(0);
  #frameBaseOpacities = new Float64Array(0);
  #touchedSlots = new Uint32Array(0);
  #frameAllocatedSlots = new Uint32Array(0);
  #touchedCount = 0;
  #frameAllocatedCount = 0;

  readonly #slotsByKey = new Map<SymbolContinuityKey, number>();
  readonly #slotsById = new Map<number, number>();
  readonly #retiredSlots: number[] = [];
  #retiredHead = 0;
  readonly #reclaimedSnapshots: ReclaimedRecordSnapshot[] = [];
  readonly #snapshotPool: ReclaimedRecordSnapshot[] = [];

  #nextContinuityId: number;
  #frameEpoch = 0;
  #inFrame = false;
  #frameFailed = false;
  #destroyed = false;

  #sceneRevision = 0;
  #cameraRevision = 0;
  #zoomRevision = 0;
  #timeMs = 0;
  #lastSceneRevision = -1;
  #lastCameraRevision = -1;
  #lastZoomRevision = -1;
  #lastTimeMs = -1;

  #frameResolvedCandidates = 0;
  #frameSeenSymbols = 0;
  #framePlacedSymbols = 0;
  #frameRetired = 0;
  #completedFrames = 0;
  #abortedFrames = 0;
  #resolvedCandidatesTotal = 0;
  #seenSymbolsTotal = 0;
  #placedSymbolsTotal = 0;
  #collisionLoserSymbolsTotal = 0;
  #retiredTotal = 0;
  #capacityReclaims = 0;
  #capacityErrors = 0;

  #frameStartHighWater = 0;
  #frameStartRetiredSymbols = 0;
  #frameStartRetiredHead = 0;
  #frameStartRetiredLength = 0;
  #frameStartNextContinuityId = 1;
  #frameStartRetiredTotal = 0;
  #frameStartCapacityReclaims = 0;

  #evaluatedPhase = RETIRED;
  #evaluatedOpacity = 0;

  constructor(options: SymbolContinuityIndexOptions = {}) {
    this.#maxTrackedSymbols = options.maxTrackedSymbols ?? DEFAULT_MAX_TRACKED_SYMBOLS;
    const initialCapacity = options.initialCapacity ?? DEFAULT_INITIAL_CAPACITY;
    this.#fadeInMs = options.fadeInMs ?? DEFAULT_FADE_IN_MS;
    this.#fadeOutMs = options.fadeOutMs ?? DEFAULT_FADE_OUT_MS;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#stateHashMode = options.stateHashMode ?? "manual";
    this.#nextContinuityId = options.initialContinuityId ?? 1;

    assertPositiveU32("maxTrackedSymbols", this.#maxTrackedSymbols);
    if (this.#maxTrackedSymbols > MAX_TRACKED_SYMBOLS_LIMIT) {
      throw new RangeError(
        `Symbol continuity maxTrackedSymbols exceeds the implementation limit of ${String(MAX_TRACKED_SYMBOLS_LIMIT)}`,
      );
    }
    assertPositiveU32("initialCapacity", initialCapacity);
    if (initialCapacity > this.#maxTrackedSymbols) {
      throw new RangeError("Symbol continuity initialCapacity must fit maxTrackedSymbols");
    }
    assertFiniteNonNegative("fadeInMs", this.#fadeInMs);
    assertFiniteNonNegative("fadeOutMs", this.#fadeOutMs);
    assertFiniteNonNegative("retentionMs", this.#retentionMs);
    if (this.#stateHashMode !== "manual" && this.#stateHashMode !== "every-frame") {
      throw new TypeError("Symbol continuity stateHashMode must be manual or every-frame");
    }
    assertPositiveU32("initialContinuityId", this.#nextContinuityId);
    this.#resize(initialCapacity);
  }

  get stats(): Readonly<SymbolContinuityIndexStats> {
    this.#assertActive();
    const numericBytes =
      this.#ids.byteLength +
      this.#phases.byteLength +
      this.#opacities.byteLength +
      this.#phaseStartOpacities.byteLength +
      this.#phaseStartTimes.byteLength +
      this.#sourceRetireAfterTimes.byteLength +
      this.#priorities.byteLength +
      this.#insertionOrders.byteLength +
      this.#seenFrames.byteLength +
      this.#placedFrames.byteLength +
      this.#provisionalFrames.byteLength +
      this.#sceneRevisions.byteLength +
      this.#cameraRevisions.byteLength +
      this.#zoomRevisions.byteLength +
      this.#targetCandidateAdmissions.byteLength +
      this.#targetPriorities.byteLength +
      this.#targetInsertionOrders.byteLength +
      this.#frameBasePhases.byteLength +
      this.#frameBaseOpacities.byteLength +
      this.#touchedSlots.byteLength +
      this.#frameAllocatedSlots.byteLength;
    const referenceBytes =
      (this.#keys.length +
        this.#anchors.length +
        this.#retainedCandidateKeys.length +
        this.#targetCandidateKeys.length +
        this.#targetAnchors.length +
        this.#retiredSlots.length) *
        REFERENCE_BYTES +
      (this.#reclaimedSnapshots.length + this.#snapshotPool.length) * SNAPSHOT_ESTIMATED_BYTES;

    return Object.freeze({
      trackedSymbols: this.#highWater,
      liveSymbols: this.#highWater - this.#retiredSymbols,
      retiredSymbols: this.#retiredSymbols,
      capacity: this.#capacity,
      maxTrackedSymbols: this.#maxTrackedSymbols,
      allocatedBytes: numericBytes + referenceBytes,
      completedFrames: this.#completedFrames,
      abortedFrames: this.#abortedFrames,
      resolvedCandidatesTotal: this.#resolvedCandidatesTotal,
      seenSymbolsTotal: this.#seenSymbolsTotal,
      placedSymbolsTotal: this.#placedSymbolsTotal,
      collisionLoserSymbolsTotal: this.#collisionLoserSymbolsTotal,
      retiredTotal: this.#retiredTotal,
      capacityReclaims: this.#capacityReclaims,
      capacityErrors: this.#capacityErrors,
    });
  }

  /** Grow transaction storage ahead of a large admission frame. */
  reserve(additionalSymbols: number): void {
    this.#assertActive();
    if (this.#inFrame) {
      throw new Error("Symbol continuity reserve requires an inactive frame transaction");
    }
    assertNonNegativeSafeInteger("additionalSymbols", additionalSymbols);
    const reusableRetired = this.#retiredSlots.length - this.#retiredHead;
    const requiredFresh = Math.max(0, additionalSymbols - reusableRetired);
    const requiredCapacity = this.#highWater + requiredFresh;
    if (requiredCapacity > this.#maxTrackedSymbols) {
      throw new RangeError(
        `Symbol continuity reserve exceeds ${String(this.#maxTrackedSymbols)} tracked symbols`,
      );
    }
    if (requiredCapacity > this.#capacity) this.#resize(requiredCapacity);
  }

  beginFrame(frame: Readonly<SymbolContinuityFrame>): void {
    this.#assertActive();
    if (this.#inFrame) {
      throw new Error("Symbol continuity frame transaction is already active");
    }
    assertFrame(frame);
    if (
      frame.sceneRevision < this.#lastSceneRevision ||
      frame.cameraRevision < this.#lastCameraRevision ||
      frame.zoomRevision < this.#lastZoomRevision ||
      frame.timeMs < this.#lastTimeMs
    ) {
      throw new RangeError("Symbol continuity revisions and time must be monotonic");
    }
    if (
      frame.sceneRevision === this.#lastSceneRevision &&
      frame.cameraRevision === this.#lastCameraRevision &&
      frame.zoomRevision === this.#lastZoomRevision &&
      frame.timeMs === this.#lastTimeMs
    ) {
      throw new RangeError("Symbol continuity frame identity must advance");
    }

    this.#sceneRevision = frame.sceneRevision;
    this.#cameraRevision = frame.cameraRevision;
    this.#zoomRevision = frame.zoomRevision;
    this.#timeMs = frame.timeMs;
    this.#frameEpoch = nextEpoch(this.#frameEpoch, this.#seenFrames, this.#placedFrames);
    this.#frameResolvedCandidates = 0;
    this.#frameSeenSymbols = 0;
    this.#framePlacedSymbols = 0;
    this.#frameRetired = 0;
    this.#touchedCount = 0;
    this.#frameAllocatedCount = 0;
    this.#reclaimedSnapshots.length = 0;
    this.#frameFailed = false;

    this.#frameStartHighWater = this.#highWater;
    this.#frameStartRetiredSymbols = this.#retiredSymbols;
    this.#frameStartRetiredHead = this.#retiredHead;
    this.#frameStartRetiredLength = this.#retiredSlots.length;
    this.#frameStartNextContinuityId = this.#nextContinuityId;
    this.#frameStartRetiredTotal = this.#retiredTotal;
    this.#frameStartCapacityReclaims = this.#capacityReclaims;
    this.#inFrame = true;
  }

  /** Stage one explicit tile/anchor candidate. Reuse `output` in candidate loops. */
  resolve(
    key: SymbolContinuityKey,
    candidateKey: SymbolContinuityKey,
    anchor: SymbolContinuityAnchor,
    priority: number,
    insertionOrder: number,
    output?: MutableSymbolContinuityMatch,
  ): Readonly<MutableSymbolContinuityMatch> {
    this.#assertFrameWritable();
    try {
      return this.#resolveCandidate(
        key,
        candidateKey,
        anchor,
        priority,
        insertionOrder,
        false,
        output,
      );
    } catch (error) {
      this.#frameFailed = true;
      throw error;
    }
  }

  /** Stage one candidate and idempotently admit that candidate identity. */
  resolveAndPlace(
    key: SymbolContinuityKey,
    candidateKey: SymbolContinuityKey,
    anchor: SymbolContinuityAnchor,
    priority: number,
    insertionOrder: number,
    output?: MutableSymbolContinuityMatch,
  ): Readonly<MutableSymbolContinuityMatch> {
    this.#assertFrameWritable();
    try {
      return this.#resolveCandidate(
        key,
        candidateKey,
        anchor,
        priority,
        insertionOrder,
        true,
        output,
      );
    } catch (error) {
      this.#frameFailed = true;
      throw error;
    }
  }

  /** Idempotently admit the logical symbol, including its final selected candidate. */
  place(continuityId: number): void {
    this.#assertFrameWritable();
    try {
      assertContinuityId(continuityId);
      const slot = this.#slotsById.get(continuityId);
      if (slot === undefined || this.#phases[slot] === RETIRED) {
        throw new RangeError("Symbol continuity id is unavailable");
      }
      if (this.#seenFrames[slot] !== this.#frameEpoch) {
        throw new Error("Symbol continuity id requires a candidate in the active frame");
      }
      this.#placeSlot(slot);
    } catch (error) {
      this.#frameFailed = true;
      throw error;
    }
  }

  /** Read committed state. Active-frame staging stays isolated until `endFrame`. */
  read(
    continuityId: number,
    output?: MutableSymbolContinuityState,
  ): Readonly<MutableSymbolContinuityState> | undefined {
    this.#assertActive();
    assertContinuityId(continuityId);
    const slot = this.#slotsById.get(continuityId);
    if (slot === undefined) {
      if (this.#inFrame) {
        for (let index = this.#reclaimedSnapshots.length - 1; index >= 0; index -= 1) {
          const snapshot = this.#reclaimedSnapshots[index];
          if (snapshot?.id === continuityId) return writeSnapshotState(snapshot, output);
        }
      }
      return undefined;
    }
    if (this.#inFrame && this.#provisionalFrames[slot] === this.#frameEpoch) return undefined;
    const result = output ?? createStateOutput();
    result.continuityId = continuityId;
    result.phase = phaseName(this.#phases[slot] ?? RETIRED);
    result.opacity = this.#opacities[slot] ?? 0;
    result.anchor = this.#anchors[slot];
    result.retainedCandidateKey = this.#retainedCandidateKeys[slot];
    result.priority = this.#priorities[slot] ?? 0;
    result.insertionOrder = this.#insertionOrders[slot] ?? 0;
    result.sceneRevision = this.#sceneRevisions[slot] ?? 0;
    result.cameraRevision = this.#cameraRevisions[slot] ?? 0;
    result.zoomRevision = this.#zoomRevisions[slot] ?? 0;
    result.sourceRetireAfterMs = this.#sourceRetireAfterTimes[slot] ?? Number.POSITIVE_INFINITY;
    return result;
  }

  /** Compute the complete hash for the latest committed state outside a frame transaction. */
  computeStateHash(): number {
    this.#assertActive();
    if (this.#inFrame) {
      throw new Error("Symbol continuity state hash requires an inactive committed state");
    }
    const hasCommittedFrame = this.#completedFrames > 0;
    let hash = this.#hashFrameHeader(
      hasCommittedFrame ? this.#lastSceneRevision : 0,
      hasCommittedFrame ? this.#lastCameraRevision : 0,
      hasCommittedFrame ? this.#lastZoomRevision : 0,
      hasCommittedFrame ? this.#lastTimeMs : 0,
    );
    for (let slot = 0; slot < this.#highWater; slot += 1) {
      hash = this.#hashSlot(hash, slot);
    }
    return hash;
  }

  endFrame(): Readonly<SymbolContinuityFrameResult> {
    this.#assertFrameWritable();
    try {
      this.#validateEndFrame();
      return this.#endFrameValidated();
    } catch (error) {
      this.#frameFailed = true;
      throw error;
    }
  }

  #endFrameValidated(): Readonly<SymbolContinuityFrameResult> {
    let enteringSymbols = 0;
    let visibleSymbols = 0;
    let exitingSymbols = 0;
    let stateHash =
      this.#stateHashMode === "every-frame"
        ? this.#hashFrameHeader(
            this.#sceneRevision,
            this.#cameraRevision,
            this.#zoomRevision,
            this.#timeMs,
          )
        : undefined;

    for (let slot = 0; slot < this.#highWater; slot += 1) {
      if (this.#phases[slot] !== RETIRED) {
        if (this.#seenFrames[slot] === this.#frameEpoch) {
          this.#commitSeenMetadata(slot);
          const targetAdmitted =
            this.#placedFrames[slot] === this.#frameEpoch ||
            this.#targetCandidateAdmissions[slot] === 1;
          if (targetAdmitted) {
            this.#framePlacedSymbols += 1;
            this.#commitPlacedPhase(slot);
          } else {
            this.#commitCollisionLoserPhase(slot);
          }
          this.#targetCandidateKeys[slot] = undefined;
          this.#targetAnchors[slot] = undefined;
          this.#targetCandidateAdmissions[slot] = 0;
        } else {
          this.#commitAbsentPhase(slot);
          if (this.#readyToRetire(slot, this.#timeMs)) this.#retire(slot);
        }

        const phase = this.#phases[slot] ?? RETIRED;
        if (phase === ENTERING) enteringSymbols += 1;
        else if (phase === VISIBLE) visibleSymbols += 1;
        else if (phase === EXITING) exitingSymbols += 1;
      }
      if (stateHash !== undefined) stateHash = this.#hashSlot(stateHash, slot);
    }

    const liveSymbols = this.#highWater - this.#retiredSymbols;
    const collisionLoserSymbols = this.#frameSeenSymbols - this.#framePlacedSymbols;
    const result: Readonly<SymbolContinuityFrameResult> = Object.freeze({
      sceneRevision: this.#sceneRevision,
      cameraRevision: this.#cameraRevision,
      zoomRevision: this.#zoomRevision,
      timeMs: this.#timeMs,
      resolvedCandidates: this.#frameResolvedCandidates,
      seenSymbols: this.#frameSeenSymbols,
      placedSymbols: this.#framePlacedSymbols,
      collisionLoserSymbols,
      enteringSymbols,
      visibleSymbols,
      exitingSymbols,
      retiredThisFrame: this.#frameRetired,
      liveSymbols,
      stateHash,
    });

    this.#lastSceneRevision = this.#sceneRevision;
    this.#lastCameraRevision = this.#cameraRevision;
    this.#lastZoomRevision = this.#zoomRevision;
    this.#lastTimeMs = this.#timeMs;
    this.#completedFrames += 1;
    this.#resolvedCandidatesTotal += this.#frameResolvedCandidates;
    this.#seenSymbolsTotal += this.#frameSeenSymbols;
    this.#placedSymbolsTotal += this.#framePlacedSymbols;
    this.#collisionLoserSymbolsTotal += collisionLoserSymbols;
    this.#inFrame = false;
    this.#frameFailed = false;
    this.#touchedCount = 0;
    this.#clearTransientReferences();
    this.#releaseSnapshots();
    this.#compactRetiredQueue();
    return result;
  }

  /** Roll back every provisional id, reclaimed tombstone, map edit, and frame counter. */
  abortFrame(): void {
    this.#assertActive();
    if (!this.#inFrame) return;

    for (let index = 0; index < this.#frameAllocatedCount; index += 1) {
      const slot = this.#frameAllocatedSlots[index] ?? 0;
      this.#deleteCurrentMappings(slot);
      if (slot >= this.#frameStartHighWater) this.#clearSlot(slot);
    }
    for (let index = this.#reclaimedSnapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.#reclaimedSnapshots[index];
      if (snapshot !== undefined) this.#restoreSnapshot(snapshot);
    }

    this.#highWater = this.#frameStartHighWater;
    this.#retiredSymbols = this.#frameStartRetiredSymbols;
    this.#retiredHead = this.#frameStartRetiredHead;
    this.#retiredSlots.length = this.#frameStartRetiredLength;
    this.#nextContinuityId = this.#frameStartNextContinuityId;
    this.#retiredTotal = this.#frameStartRetiredTotal;
    this.#capacityReclaims = this.#frameStartCapacityReclaims;
    this.#inFrame = false;
    this.#frameFailed = false;
    this.#abortedFrames += 1;
    this.#clearTransientReferences();
    this.#releaseSnapshots();
    this.#compactRetiredQueue();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#ids = new Uint32Array(0);
    this.#phases = new Uint8Array(0);
    this.#opacities = new Float64Array(0);
    this.#phaseStartOpacities = new Float64Array(0);
    this.#phaseStartTimes = new Float64Array(0);
    this.#sourceRetireAfterTimes = new Float64Array(0);
    this.#priorities = new Float32Array(0);
    this.#insertionOrders = new Float64Array(0);
    this.#seenFrames = new Uint32Array(0);
    this.#placedFrames = new Uint32Array(0);
    this.#provisionalFrames = new Uint32Array(0);
    this.#sceneRevisions = new Float64Array(0);
    this.#cameraRevisions = new Float64Array(0);
    this.#zoomRevisions = new Float64Array(0);
    this.#targetPriorities = new Float32Array(0);
    this.#targetCandidateAdmissions = new Uint8Array(0);
    this.#targetInsertionOrders = new Float64Array(0);
    this.#frameBasePhases = new Uint8Array(0);
    this.#frameBaseOpacities = new Float64Array(0);
    this.#touchedSlots = new Uint32Array(0);
    this.#frameAllocatedSlots = new Uint32Array(0);
    this.#keys.length = 0;
    this.#anchors.length = 0;
    this.#retainedCandidateKeys.length = 0;
    this.#targetCandidateKeys.length = 0;
    this.#targetAnchors.length = 0;
    this.#slotsByKey.clear();
    this.#slotsById.clear();
    this.#retiredSlots.length = 0;
    this.#reclaimedSnapshots.length = 0;
    this.#snapshotPool.length = 0;
    this.#highWater = 0;
    this.#capacity = 0;
    this.#inFrame = false;
    this.#destroyed = true;
  }

  #resolveCandidate(
    key: SymbolContinuityKey,
    candidateKey: SymbolContinuityKey,
    anchor: SymbolContinuityAnchor,
    priority: number,
    insertionOrder: number,
    candidateAdmitted: boolean,
    output: MutableSymbolContinuityMatch | undefined,
  ): Readonly<MutableSymbolContinuityMatch> {
    assertTypedValue("key", key);
    assertTypedValue("candidateKey", candidateKey);
    assertTypedValue("anchor", anchor);
    const f32Priority = Math.fround(priority);
    if (!Number.isFinite(priority) || !Number.isFinite(f32Priority)) {
      throw new TypeError("Symbol continuity priority must fit a finite f32");
    }
    assertNonNegativeSafeInteger("insertionOrder", insertionOrder);

    let slot = this.#slotsByKey.get(key);
    if (slot === undefined) {
      slot = this.#createRecord(key, f32Priority, insertionOrder);
      this.#evaluate(slot, this.#timeMs);
    } else if (this.#seenFrames[slot] !== this.#frameEpoch) {
      this.#evaluate(slot, this.#timeMs);
      if (this.#readyToRetireEvaluated(slot, this.#timeMs)) {
        this.#replaceExpiredRecord(slot, key, f32Priority, insertionOrder);
        this.#evaluate(slot, this.#timeMs);
      }
    }

    const firstCandidate = this.#seenFrames[slot] !== this.#frameEpoch;
    let candidateSelected: boolean;
    if (firstCandidate) {
      this.#frameBasePhases[slot] = this.#evaluatedPhase;
      this.#frameBaseOpacities[slot] = this.#evaluatedOpacity;
      this.#seenFrames[slot] = this.#frameEpoch;
      this.#targetCandidateKeys[slot] = candidateKey;
      this.#targetAnchors[slot] = anchor;
      this.#targetCandidateAdmissions[slot] = Number(candidateAdmitted);
      this.#targetPriorities[slot] = f32Priority;
      this.#targetInsertionOrders[slot] = insertionOrder;
      this.#touchedSlots[this.#touchedCount] = slot;
      this.#touchedCount += 1;
      this.#frameSeenSymbols += 1;
      candidateSelected = true;
    } else {
      const currentTargetCandidateKey = this.#targetCandidateKeys[slot];
      const currentTargetAnchor = this.#targetAnchors[slot];
      const matchesCurrentTarget =
        currentTargetCandidateKey === candidateKey && currentTargetAnchor === anchor;
      candidateSelected = this.#candidateWins(
        slot,
        candidateKey,
        anchor,
        f32Priority,
        insertionOrder,
      );
      if (candidateSelected) {
        const retainedAdmission =
          matchesCurrentTarget && this.#targetCandidateAdmissions[slot] === 1;
        this.#targetCandidateKeys[slot] = candidateKey;
        this.#targetAnchors[slot] = anchor;
        this.#targetCandidateAdmissions[slot] = Number(candidateAdmitted || retainedAdmission);
        this.#targetPriorities[slot] = f32Priority;
        this.#targetInsertionOrders[slot] = insertionOrder;
      } else if (candidateAdmitted && matchesCurrentTarget) {
        this.#targetCandidateAdmissions[slot] = 1;
      }
    }
    this.#frameResolvedCandidates += 1;
    const targetCandidateKey = this.#targetCandidateKeys[slot];
    const targetAnchor = this.#targetAnchors[slot];
    if (targetCandidateKey === undefined || targetAnchor === undefined) {
      throw new Error("Symbol continuity target candidate is unavailable");
    }
    const result = output ?? createMatchOutput();
    result.continuityId = this.#ids[slot] ?? 0;
    result.phase = phaseName(this.#frameBasePhases[slot] ?? RETIRED);
    result.opacity = this.#frameBaseOpacities[slot] ?? 0;
    result.targetCandidateKey = targetCandidateKey;
    result.targetAnchor = targetAnchor;
    result.priority = this.#targetPriorities[slot] ?? 0;
    result.insertionOrder = this.#targetInsertionOrders[slot] ?? 0;
    result.candidateSelected = candidateSelected;
    result.sceneRevision = this.#sceneRevision;
    result.cameraRevision = this.#cameraRevision;
    result.zoomRevision = this.#zoomRevision;
    return result;
  }

  #candidateWins(
    slot: number,
    candidateKey: SymbolContinuityKey,
    anchor: SymbolContinuityAnchor,
    priority: number,
    insertionOrder: number,
  ): boolean {
    const targetPriority = this.#targetPriorities[slot] ?? 0;
    if (priority > targetPriority) return true;
    if (priority < targetPriority) return false;

    const retainedCandidate = this.#retainedCandidateKeys[slot];
    const retainedAnchor = this.#anchors[slot];
    const candidateRetained =
      retainedCandidate !== undefined &&
      retainedAnchor !== undefined &&
      candidateKey === retainedCandidate &&
      anchor === retainedAnchor;
    const targetCandidate = this.#targetCandidateKeys[slot];
    const targetAnchor = this.#targetAnchors[slot];
    const targetRetained =
      retainedCandidate !== undefined &&
      retainedAnchor !== undefined &&
      targetCandidate === retainedCandidate &&
      targetAnchor === retainedAnchor;
    if (candidateRetained !== targetRetained) return candidateRetained;

    const targetOrder = this.#targetInsertionOrders[slot] ?? 0;
    if (insertionOrder < targetOrder) return true;
    if (insertionOrder > targetOrder) return false;
    if (targetCandidate === undefined) return true;
    const candidateOrder = compareTypedValues(candidateKey, targetCandidate);
    if (candidateOrder !== 0) return candidateOrder < 0;
    return targetAnchor === undefined || compareTypedValues(anchor, targetAnchor) < 0;
  }

  #placeSlot(slot: number): void {
    if (this.#placedFrames[slot] === this.#frameEpoch) return;
    this.#placedFrames[slot] = this.#frameEpoch;
  }

  #validateEndFrame(): void {
    if (this.#frameSeenSymbols !== this.#touchedCount) {
      throw new Error("Symbol continuity seen-symbol journal is inconsistent");
    }
    for (let index = 0; index < this.#touchedCount; index += 1) {
      const slot = this.#touchedSlots[index] ?? 0;
      if (
        this.#seenFrames[slot] !== this.#frameEpoch ||
        this.#targetCandidateKeys[slot] === undefined ||
        this.#targetAnchors[slot] === undefined
      ) {
        throw new Error("Symbol continuity candidate journal is inconsistent");
      }
    }
  }

  #commitSeenMetadata(slot: number): void {
    this.#retainedCandidateKeys[slot] = this.#targetCandidateKeys[slot];
    this.#anchors[slot] = this.#targetAnchors[slot];
    this.#priorities[slot] = this.#targetPriorities[slot] ?? 0;
    this.#insertionOrders[slot] = this.#targetInsertionOrders[slot] ?? 0;
    this.#sceneRevisions[slot] = this.#sceneRevision;
    this.#cameraRevisions[slot] = this.#cameraRevision;
    this.#zoomRevisions[slot] = this.#zoomRevision;
    this.#sourceRetireAfterTimes[slot] = Number.POSITIVE_INFINITY;
  }

  #commitPlacedPhase(slot: number): void {
    const basePhase = this.#frameBasePhases[slot] ?? RETIRED;
    const baseOpacity = this.#frameBaseOpacities[slot] ?? 0;
    if (basePhase === EXITING) {
      this.#phases[slot] = ENTERING;
      this.#opacities[slot] = baseOpacity;
      this.#phaseStartOpacities[slot] = baseOpacity;
      this.#phaseStartTimes[slot] = this.#timeMs;
      if (this.#fadeInMs === 0 || baseOpacity >= 1) this.#setVisible(slot);
      return;
    }
    if (basePhase === VISIBLE) {
      if (this.#phases[slot] === ENTERING) this.#phaseStartTimes[slot] = this.#timeMs;
      this.#setVisible(slot);
      return;
    }
    this.#phases[slot] = ENTERING;
    this.#opacities[slot] = baseOpacity;
  }

  #commitCollisionLoserPhase(slot: number): void {
    const basePhase = this.#frameBasePhases[slot] ?? RETIRED;
    const baseOpacity = this.#frameBaseOpacities[slot] ?? 0;
    if (basePhase === EXITING) {
      this.#phases[slot] = EXITING;
      this.#opacities[slot] = baseOpacity;
      return;
    }
    this.#startExit(slot, baseOpacity);
  }

  #commitAbsentPhase(slot: number): void {
    this.#evaluate(slot, this.#timeMs);
    if (this.#evaluatedPhase === EXITING) {
      this.#phases[slot] = EXITING;
      this.#opacities[slot] = this.#evaluatedOpacity;
    } else {
      this.#startExit(slot, this.#evaluatedOpacity);
    }
    if (!Number.isFinite(this.#sourceRetireAfterTimes[slot])) {
      this.#sourceRetireAfterTimes[slot] = this.#timeMs + this.#retentionMs;
    }
  }

  #startExit(slot: number, opacity: number): void {
    this.#phases[slot] = EXITING;
    this.#phaseStartOpacities[slot] = opacity;
    this.#phaseStartTimes[slot] = this.#timeMs;
    this.#opacities[slot] = this.#fadeOutMs === 0 ? 0 : opacity;
  }

  #setVisible(slot: number): void {
    this.#phases[slot] = VISIBLE;
    this.#opacities[slot] = 1;
    this.#phaseStartOpacities[slot] = 1;
  }

  #evaluate(slot: number, timeMs: number): void {
    const phase = this.#phases[slot] ?? RETIRED;
    if (phase === ENTERING) {
      const startOpacity = this.#phaseStartOpacities[slot] ?? 0;
      const elapsed = timeMs - (this.#phaseStartTimes[slot] ?? timeMs);
      if (this.#fadeInMs === 0 || elapsed >= this.#fadeInMs) {
        this.#evaluatedPhase = VISIBLE;
        this.#evaluatedOpacity = 1;
      } else {
        this.#evaluatedPhase = ENTERING;
        this.#evaluatedOpacity =
          startOpacity + (1 - startOpacity) * Math.max(0, elapsed / this.#fadeInMs);
      }
      return;
    }
    if (phase === VISIBLE) {
      this.#evaluatedPhase = VISIBLE;
      this.#evaluatedOpacity = 1;
      return;
    }
    if (phase === EXITING) {
      const startOpacity = this.#phaseStartOpacities[slot] ?? 0;
      const elapsed = timeMs - (this.#phaseStartTimes[slot] ?? timeMs);
      this.#evaluatedPhase = EXITING;
      this.#evaluatedOpacity =
        this.#fadeOutMs === 0 ? 0 : startOpacity * Math.max(0, 1 - elapsed / this.#fadeOutMs);
      return;
    }
    this.#evaluatedPhase = RETIRED;
    this.#evaluatedOpacity = 0;
  }

  #readyToRetire(slot: number, timeMs: number): boolean {
    return (
      this.#phases[slot] === EXITING &&
      (this.#opacities[slot] ?? 0) <= 0 &&
      timeMs >= (this.#sourceRetireAfterTimes[slot] ?? Number.POSITIVE_INFINITY)
    );
  }

  #readyToRetireEvaluated(slot: number, timeMs: number): boolean {
    return (
      this.#evaluatedPhase === EXITING &&
      this.#evaluatedOpacity <= 0 &&
      timeMs >= (this.#sourceRetireAfterTimes[slot] ?? Number.POSITIVE_INFINITY)
    );
  }

  #createRecord(key: SymbolContinuityKey, priority: number, insertionOrder: number): number {
    const slot = this.#allocateSlot();
    this.#initializeRecord(slot, key, priority, insertionOrder);
    return slot;
  }

  #replaceExpiredRecord(
    slot: number,
    key: SymbolContinuityKey,
    priority: number,
    insertionOrder: number,
  ): void {
    this.#captureSnapshot(slot);
    this.#journalAllocatedSlot(slot);
    this.#deleteCurrentMappings(slot);
    this.#retiredTotal += 1;
    this.#frameRetired += 1;
    this.#initializeRecord(slot, key, priority, insertionOrder);
  }

  #initializeRecord(
    slot: number,
    key: SymbolContinuityKey,
    priority: number,
    insertionOrder: number,
  ): void {
    const continuityId = this.#allocateContinuityId();
    this.#ids[slot] = continuityId;
    this.#phases[slot] = ENTERING;
    this.#opacities[slot] = 0;
    this.#phaseStartOpacities[slot] = 0;
    this.#phaseStartTimes[slot] = this.#timeMs;
    this.#sourceRetireAfterTimes[slot] = Number.POSITIVE_INFINITY;
    this.#priorities[slot] = priority;
    this.#insertionOrders[slot] = insertionOrder;
    this.#seenFrames[slot] = 0;
    this.#placedFrames[slot] = 0;
    this.#sceneRevisions[slot] = this.#sceneRevision;
    this.#cameraRevisions[slot] = this.#cameraRevision;
    this.#zoomRevisions[slot] = this.#zoomRevision;
    this.#keys[slot] = key;
    this.#anchors[slot] = undefined;
    this.#retainedCandidateKeys[slot] = undefined;
    this.#targetCandidateKeys[slot] = undefined;
    this.#targetAnchors[slot] = undefined;
    this.#targetCandidateAdmissions[slot] = 0;
    this.#slotsByKey.set(key, slot);
    this.#slotsById.set(continuityId, slot);
  }

  #allocateSlot(): number {
    const retiredSlot = this.#takeRetiredSlot();
    if (retiredSlot !== undefined) return retiredSlot;
    if (this.#highWater === this.#capacity && this.#capacity < this.#maxTrackedSymbols) {
      this.#resize(Math.min(this.#maxTrackedSymbols, Math.max(1, this.#capacity * 2)));
    }
    if (this.#highWater >= this.#capacity) {
      this.#capacityErrors += 1;
      throw new RangeError(
        `Symbol continuity capacity reached ${String(this.#maxTrackedSymbols)} tracked symbols`,
      );
    }
    const slot = this.#highWater;
    this.#highWater += 1;
    this.#journalAllocatedSlot(slot);
    return slot;
  }

  #takeRetiredSlot(): number | undefined {
    if (this.#retiredHead >= this.#retiredSlots.length) return undefined;
    const slot = this.#retiredSlots[this.#retiredHead];
    if (slot === undefined || this.#phases[slot] !== RETIRED) {
      throw new Error("Symbol continuity retired-slot queue is inconsistent");
    }
    this.#captureSnapshot(slot);
    this.#journalAllocatedSlot(slot);
    this.#retiredHead += 1;
    this.#slotsById.delete(this.#ids[slot] ?? 0);
    this.#retiredSymbols -= 1;
    this.#capacityReclaims += 1;
    return slot;
  }

  #allocateContinuityId(): number {
    if (this.#nextContinuityId > MAX_U32) {
      throw new RangeError("Symbol continuity u32 id space is exhausted");
    }
    const continuityId = this.#nextContinuityId;
    this.#nextContinuityId += 1;
    return continuityId;
  }

  #retire(slot: number): void {
    const key = this.#keys[slot];
    if (key !== undefined && this.#slotsByKey.get(key) === slot) this.#slotsByKey.delete(key);
    this.#phases[slot] = RETIRED;
    this.#opacities[slot] = 0;
    this.#retiredSlots.push(slot);
    this.#retiredSymbols += 1;
    this.#retiredTotal += 1;
    this.#frameRetired += 1;
  }

  #journalAllocatedSlot(slot: number): void {
    this.#frameAllocatedSlots[this.#frameAllocatedCount] = slot;
    this.#provisionalFrames[slot] = this.#frameEpoch;
    this.#frameAllocatedCount += 1;
  }

  #captureSnapshot(slot: number): void {
    const snapshot = this.#snapshotPool.pop() ?? createSnapshot();
    snapshot.slot = slot;
    snapshot.id = this.#ids[slot] ?? 0;
    snapshot.phase = this.#phases[slot] ?? RETIRED;
    snapshot.opacity = this.#opacities[slot] ?? 0;
    snapshot.phaseStartOpacity = this.#phaseStartOpacities[slot] ?? 0;
    snapshot.phaseStartTime = this.#phaseStartTimes[slot] ?? 0;
    snapshot.sourceRetireAfterTime = this.#sourceRetireAfterTimes[slot] ?? Number.POSITIVE_INFINITY;
    snapshot.priority = this.#priorities[slot] ?? 0;
    snapshot.insertionOrder = this.#insertionOrders[slot] ?? 0;
    snapshot.sceneRevision = this.#sceneRevisions[slot] ?? 0;
    snapshot.cameraRevision = this.#cameraRevisions[slot] ?? 0;
    snapshot.zoomRevision = this.#zoomRevisions[slot] ?? 0;
    snapshot.key = this.#keys[slot];
    snapshot.anchor = this.#anchors[slot];
    snapshot.retainedCandidateKey = this.#retainedCandidateKeys[slot];
    this.#reclaimedSnapshots.push(snapshot);
  }

  #restoreSnapshot(snapshot: ReclaimedRecordSnapshot): void {
    const slot = snapshot.slot;
    this.#ids[slot] = snapshot.id;
    this.#phases[slot] = snapshot.phase;
    this.#opacities[slot] = snapshot.opacity;
    this.#phaseStartOpacities[slot] = snapshot.phaseStartOpacity;
    this.#phaseStartTimes[slot] = snapshot.phaseStartTime;
    this.#sourceRetireAfterTimes[slot] = snapshot.sourceRetireAfterTime;
    this.#priorities[slot] = snapshot.priority;
    this.#insertionOrders[slot] = snapshot.insertionOrder;
    this.#sceneRevisions[slot] = snapshot.sceneRevision;
    this.#cameraRevisions[slot] = snapshot.cameraRevision;
    this.#zoomRevisions[slot] = snapshot.zoomRevision;
    this.#keys[slot] = snapshot.key;
    this.#anchors[slot] = snapshot.anchor;
    this.#retainedCandidateKeys[slot] = snapshot.retainedCandidateKey;
    if (snapshot.key !== undefined && snapshot.phase !== RETIRED) {
      this.#slotsByKey.set(snapshot.key, slot);
    }
    if (snapshot.id > 0) this.#slotsById.set(snapshot.id, slot);
  }

  #deleteCurrentMappings(slot: number): void {
    const key = this.#keys[slot];
    const id = this.#ids[slot] ?? 0;
    if (key !== undefined && this.#slotsByKey.get(key) === slot) this.#slotsByKey.delete(key);
    if (id > 0 && this.#slotsById.get(id) === slot) this.#slotsById.delete(id);
  }

  #clearSlot(slot: number): void {
    this.#ids[slot] = 0;
    this.#phases[slot] = RETIRED;
    this.#opacities[slot] = 0;
    this.#phaseStartOpacities[slot] = 0;
    this.#phaseStartTimes[slot] = 0;
    this.#sourceRetireAfterTimes[slot] = Number.POSITIVE_INFINITY;
    this.#priorities[slot] = 0;
    this.#insertionOrders[slot] = 0;
    this.#seenFrames[slot] = 0;
    this.#placedFrames[slot] = 0;
    this.#sceneRevisions[slot] = 0;
    this.#cameraRevisions[slot] = 0;
    this.#zoomRevisions[slot] = 0;
    this.#keys[slot] = undefined;
    this.#anchors[slot] = undefined;
    this.#retainedCandidateKeys[slot] = undefined;
    this.#targetCandidateKeys[slot] = undefined;
    this.#targetAnchors[slot] = undefined;
  }

  #clearTransientReferences(): void {
    for (let index = 0; index < this.#touchedCount; index += 1) {
      const slot = this.#touchedSlots[index] ?? 0;
      this.#clearTouchedSlot(slot);
    }
    for (let index = 0; index < this.#frameAllocatedCount; index += 1) {
      const slot = this.#frameAllocatedSlots[index] ?? 0;
      this.#provisionalFrames[slot] = 0;
    }
    this.#touchedCount = 0;
    this.#frameAllocatedCount = 0;
  }

  #clearTouchedSlot(slot: number): void {
    this.#targetCandidateKeys[slot] = undefined;
    this.#targetAnchors[slot] = undefined;
    this.#targetCandidateAdmissions[slot] = 0;
  }

  #releaseSnapshots(): void {
    while (this.#reclaimedSnapshots.length > 0) {
      const snapshot = this.#reclaimedSnapshots.pop();
      if (snapshot !== undefined) this.#snapshotPool.push(snapshot);
    }
  }

  #hashFrameHeader(
    sceneRevision: number,
    cameraRevision: number,
    zoomRevision: number,
    timeMs: number,
  ): number {
    let hash = 0x811c_9dc5;
    hash = hashFloat64(hash, sceneRevision);
    hash = hashFloat64(hash, cameraRevision);
    hash = hashFloat64(hash, zoomRevision);
    hash = hashFloat64(hash, timeMs);
    return hashU32(hash, this.#highWater);
  }

  #hashSlot(hash: number, slot: number): number {
    let result = hashU32(hash, this.#ids[slot] ?? 0);
    result = hashU32(result, this.#phases[slot] ?? RETIRED);
    result = hashTypedValue(result, this.#keys[slot]);
    result = hashFloat32(result, this.#priorities[slot] ?? 0);
    result = hashFloat64(result, this.#insertionOrders[slot] ?? 0);
    result = hashFloat64(result, this.#sceneRevisions[slot] ?? 0);
    result = hashFloat64(result, this.#cameraRevisions[slot] ?? 0);
    result = hashFloat64(result, this.#zoomRevisions[slot] ?? 0);
    result = hashTypedValue(result, this.#anchors[slot]);
    result = hashTypedValue(result, this.#retainedCandidateKeys[slot]);
    result = hashFloat64(result, this.#opacities[slot] ?? 0);
    result = hashFloat64(result, this.#phaseStartOpacities[slot] ?? 0);
    result = hashFloat64(result, this.#phaseStartTimes[slot] ?? 0);
    return hashFloat64(result, this.#sourceRetireAfterTimes[slot] ?? Number.POSITIVE_INFINITY);
  }

  #resize(capacity: number): void {
    this.#ids = growTypedArray(this.#ids, Uint32Array, capacity);
    this.#phases = growTypedArray(this.#phases, Uint8Array, capacity);
    this.#opacities = growTypedArray(this.#opacities, Float64Array, capacity);
    this.#phaseStartOpacities = growTypedArray(this.#phaseStartOpacities, Float64Array, capacity);
    this.#phaseStartTimes = growTypedArray(this.#phaseStartTimes, Float64Array, capacity);
    this.#sourceRetireAfterTimes = growTypedArray(
      this.#sourceRetireAfterTimes,
      Float64Array,
      capacity,
    );
    this.#priorities = growTypedArray(this.#priorities, Float32Array, capacity);
    this.#insertionOrders = growTypedArray(this.#insertionOrders, Float64Array, capacity);
    this.#seenFrames = growTypedArray(this.#seenFrames, Uint32Array, capacity);
    this.#placedFrames = growTypedArray(this.#placedFrames, Uint32Array, capacity);
    this.#provisionalFrames = growTypedArray(this.#provisionalFrames, Uint32Array, capacity);
    this.#sceneRevisions = growTypedArray(this.#sceneRevisions, Float64Array, capacity);
    this.#cameraRevisions = growTypedArray(this.#cameraRevisions, Float64Array, capacity);
    this.#zoomRevisions = growTypedArray(this.#zoomRevisions, Float64Array, capacity);
    this.#targetPriorities = growTypedArray(this.#targetPriorities, Float32Array, capacity);
    this.#targetCandidateAdmissions = growTypedArray(
      this.#targetCandidateAdmissions,
      Uint8Array,
      capacity,
    );
    this.#targetInsertionOrders = growTypedArray(
      this.#targetInsertionOrders,
      Float64Array,
      capacity,
    );
    this.#frameBasePhases = growTypedArray(this.#frameBasePhases, Uint8Array, capacity);
    this.#frameBaseOpacities = growTypedArray(this.#frameBaseOpacities, Float64Array, capacity);
    this.#touchedSlots = growTypedArray(this.#touchedSlots, Uint32Array, capacity);
    this.#frameAllocatedSlots = growTypedArray(this.#frameAllocatedSlots, Uint32Array, capacity);
    this.#keys.length = capacity;
    this.#anchors.length = capacity;
    this.#retainedCandidateKeys.length = capacity;
    this.#targetCandidateKeys.length = capacity;
    this.#targetAnchors.length = capacity;
    this.#capacity = capacity;
  }

  #compactRetiredQueue(): void {
    if (this.#retiredHead < 4_096 || this.#retiredHead * 2 < this.#retiredSlots.length) return;
    this.#retiredSlots.copyWithin(0, this.#retiredHead);
    this.#retiredSlots.length -= this.#retiredHead;
    this.#retiredHead = 0;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("SymbolContinuityIndex has been destroyed");
  }

  #assertFrameWritable(): void {
    this.#assertActive();
    if (!this.#inFrame) throw new Error("Symbol continuity frame transaction is inactive");
    if (this.#frameFailed) {
      throw new Error("Symbol continuity frame transaction requires abortFrame recovery");
    }
  }
}

function createMatchOutput(): MutableSymbolContinuityMatch {
  return {
    continuityId: 0,
    phase: "retired",
    opacity: 0,
    targetCandidateKey: 0,
    targetAnchor: 0,
    priority: 0,
    insertionOrder: 0,
    candidateSelected: false,
    sceneRevision: 0,
    cameraRevision: 0,
    zoomRevision: 0,
  };
}

function createStateOutput(): MutableSymbolContinuityState {
  return {
    continuityId: 0,
    phase: "retired",
    opacity: 0,
    anchor: undefined,
    retainedCandidateKey: undefined,
    priority: 0,
    insertionOrder: 0,
    sceneRevision: 0,
    cameraRevision: 0,
    zoomRevision: 0,
    sourceRetireAfterMs: Number.POSITIVE_INFINITY,
  };
}

function writeSnapshotState(
  snapshot: Readonly<ReclaimedRecordSnapshot>,
  output: MutableSymbolContinuityState | undefined,
): Readonly<MutableSymbolContinuityState> {
  const result = output ?? createStateOutput();
  result.continuityId = snapshot.id;
  result.phase = phaseName(snapshot.phase);
  result.opacity = snapshot.opacity;
  result.anchor = snapshot.anchor;
  result.retainedCandidateKey = snapshot.retainedCandidateKey;
  result.priority = snapshot.priority;
  result.insertionOrder = snapshot.insertionOrder;
  result.sceneRevision = snapshot.sceneRevision;
  result.cameraRevision = snapshot.cameraRevision;
  result.zoomRevision = snapshot.zoomRevision;
  result.sourceRetireAfterMs = snapshot.sourceRetireAfterTime;
  return result;
}

function createSnapshot(): ReclaimedRecordSnapshot {
  return {
    slot: 0,
    id: 0,
    phase: RETIRED,
    opacity: 0,
    phaseStartOpacity: 0,
    phaseStartTime: 0,
    sourceRetireAfterTime: Number.POSITIVE_INFINITY,
    priority: 0,
    insertionOrder: 0,
    sceneRevision: 0,
    cameraRevision: 0,
    zoomRevision: 0,
    key: undefined,
    anchor: undefined,
    retainedCandidateKey: undefined,
  };
}

function phaseName(phase: number): SymbolContinuityPhase {
  if (phase === ENTERING) return "entering";
  if (phase === VISIBLE) return "visible";
  if (phase === EXITING) return "exiting";
  return "retired";
}

function compareTypedValues(left: SymbolContinuityKey, right: SymbolContinuityKey): number {
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== rightType) return leftType === "number" ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertFrame(frame: Readonly<SymbolContinuityFrame>): void {
  assertNonNegativeSafeInteger("sceneRevision", frame.sceneRevision);
  assertNonNegativeSafeInteger("cameraRevision", frame.cameraRevision);
  assertNonNegativeSafeInteger("zoomRevision", frame.zoomRevision);
  assertFiniteNonNegative("timeMs", frame.timeMs);
}

function assertTypedValue(name: string, value: SymbolContinuityKey): void {
  if (typeof value === "string") {
    if (value.length > 0) return;
    throw new TypeError(`Symbol continuity ${name} string must contain a character`);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return;
  throw new TypeError(`Symbol continuity ${name} must be a string or safe integer`);
}

function assertContinuityId(id: number): void {
  if (!Number.isInteger(id) || id <= 0 || id > MAX_U32) {
    throw new TypeError("Symbol continuity id must be a positive u32 integer");
  }
}

function assertPositiveU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_U32) {
    throw new TypeError(`Symbol continuity ${name} must be a positive u32 integer`);
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Symbol continuity ${name} must be a non-negative safe integer`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Symbol continuity ${name} must be a finite non-negative number`);
  }
}

function nextEpoch(current: number, seenFrames: Uint32Array, placedFrames: Uint32Array): number {
  if (current < MAX_U32) return current + 1;
  seenFrames.fill(0);
  placedFrames.fill(0);
  return 1;
}

type NumericTypedArray = Uint8Array | Uint32Array | Float32Array | Float64Array;
type NumericTypedArrayConstructor<T extends NumericTypedArray> = {
  new (length: number): T;
};

function growTypedArray<T extends NumericTypedArray>(
  source: T,
  Constructor: NumericTypedArrayConstructor<T>,
  capacity: number,
): T {
  const target = new Constructor(capacity);
  target.set(source);
  return target;
}

const HASH_BYTES = new ArrayBuffer(8);
const HASH_VIEW = new DataView(HASH_BYTES);

function hashU32(hash: number, value: number): number {
  return Math.imul(hash ^ (value >>> 0), 0x0100_0193) >>> 0;
}

function hashFloat32(hash: number, value: number): number {
  HASH_VIEW.setFloat32(0, value, true);
  return hashU32(hash, HASH_VIEW.getUint32(0, true));
}

function hashFloat64(hash: number, value: number): number {
  HASH_VIEW.setFloat64(0, value, true);
  return hashU32(hashU32(hash, HASH_VIEW.getUint32(0, true)), HASH_VIEW.getUint32(4, true));
}

function hashTypedValue(hash: number, value: SymbolContinuityKey | undefined): number {
  if (value === undefined) return hashU32(hash, 0);
  if (typeof value === "number") return hashFloat64(hashU32(hash, 1), value);
  let result = hashU32(hash, 2);
  result = hashU32(result, value.length);
  for (let index = 0; index < value.length; index += 1) {
    result = hashU32(result, value.charCodeAt(index));
  }
  return result;
}
