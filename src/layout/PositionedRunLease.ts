import type { PositionedRun } from "./types";

export const POSITIONED_RUN_LEASE: unique symbol = Symbol("pixi-glyphflow positioned-run lease");

interface PositionedRunLeaseState {
  references: number;
  readonly settle: () => void;
}

interface PositionedRunLeaseView {
  owned: Readonly<PositionedRun> | undefined;
}

interface PositionedRunLeaseToken {
  readonly state: PositionedRunLeaseState;
  readonly view: PositionedRunLeaseView;
  released: boolean;
}

export interface LeasedPositionedRun extends PositionedRun {
  readonly [POSITIONED_RUN_LEASE]: PositionedRunLeaseToken;
}

export function leasePositionedRun(
  run: Readonly<PositionedRun>,
  release: () => void,
): Readonly<LeasedPositionedRun> {
  if (typeof release !== "function")
    throw new TypeError("Positioned-run release must be a function");
  if (isLeasedPositionedRun(run)) {
    throw new TypeError("Positioned run already carries a lease");
  }
  const state: PositionedRunLeaseState = {
    references: 1,
    settle: release,
  };
  return attachLease(run, { state, view: { owned: undefined }, released: false });
}

export function isLeasedPositionedRun(
  run: Readonly<PositionedRun>,
): run is Readonly<LeasedPositionedRun> {
  return POSITIONED_RUN_LEASE in run;
}

/** Create one independent borrower over the same immutable shared views. */
export function retainPositionedRun(run: Readonly<PositionedRun>): Readonly<PositionedRun> {
  const token = leaseToken(run);
  if (token === undefined) return run;
  if (token.released || token.state.references === 0) {
    throw new Error("Positioned-run lease has already been released");
  }
  token.state.references += 1;
  return attachLease(run, { state: token.state, view: token.view, released: false });
}

/** Settle one borrower. The SAB slot becomes reusable after the final borrower settles. */
export function releasePositionedRun(run: Readonly<PositionedRun>): void {
  const token = leaseToken(run);
  if (token === undefined || token.released) return;
  token.released = true;
  token.state.references -= 1;
  if (token.state.references > 0) return;
  token.state.settle();
}

/** Lazily materialize the stable cache copy shared by every borrower of this lease. */
export function ownedPositionedRun(run: Readonly<PositionedRun>): Readonly<PositionedRun> {
  const token = leaseToken(run);
  if (token === undefined) return run;
  const cached = token.view.owned;
  if (cached !== undefined) return cached;
  if (token.released || token.state.references === 0) {
    throw new Error("Positioned-run lease has already been released");
  }
  const owned = cloneRun(run);
  token.view.owned = owned;
  return owned;
}

/** Preserve one borrow while replacing immutable layout fields such as vertical positions. */
export function inheritPositionedRunLease(
  source: Readonly<PositionedRun>,
  target: PositionedRun,
): Readonly<PositionedRun> {
  const token = leaseToken(source);
  if (token === undefined) return Object.freeze(target);
  if (token.released || token.state.references === 0) {
    throw new Error("Positioned-run lease has already been released");
  }
  token.released = true;
  return attachLease(target, {
    state: token.state,
    view: { owned: undefined },
    released: false,
  });
}

function attachLease(
  run: Readonly<PositionedRun>,
  token: PositionedRunLeaseToken,
): Readonly<LeasedPositionedRun> {
  const wrapper = { ...run } as PositionedRun & {
    [POSITIONED_RUN_LEASE]?: PositionedRunLeaseToken;
  };
  Object.defineProperty(wrapper, POSITIONED_RUN_LEASE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: token,
  });
  return Object.freeze(wrapper) as Readonly<LeasedPositionedRun>;
}

function leaseToken(run: Readonly<PositionedRun>): PositionedRunLeaseToken | undefined {
  return (run as Partial<LeasedPositionedRun>)[POSITIONED_RUN_LEASE];
}

function cloneRun(run: Readonly<PositionedRun>): Readonly<PositionedRun> {
  return Object.freeze({
    ...run,
    glyphIds: new Uint32Array(run.glyphIds),
    clusters: new Uint32Array(run.clusters),
    ...(run.clusterEnds === undefined ? {} : { clusterEnds: new Uint32Array(run.clusterEnds) }),
    x: new Float32Array(run.x),
    y: new Float32Array(run.y),
    xAdvance: new Float32Array(run.xAdvance),
    yAdvance: new Float32Array(run.yAdvance),
    lineIndices: new Uint32Array(run.lineIndices),
    ...(run.glyphKeys === undefined ? {} : { glyphKeys: Object.freeze([...run.glyphKeys]) }),
    bounds: Object.freeze({ ...run.bounds }),
  });
}
