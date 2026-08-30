import type { PositionedRun } from "../layout/types";
import type { SerializedPositionedRun } from "./protocol";

type WorkerRunMode = "copy" | "borrow";

/** Copy owned fields so every returned typed-array buffer can be transferred. @internal */
export function serializeWorkerRun(
  run: Readonly<PositionedRun>,
  fontRevision: number,
): SerializedPositionedRun {
  return createWorkerRun(run, fontRevision, "copy");
}

/** Borrow immutable run fields while the shared transport copies them into its ring. @internal */
export function borrowWorkerRun(
  run: Readonly<PositionedRun>,
  fontRevision: number,
): SerializedPositionedRun {
  return createWorkerRun(run, fontRevision, "borrow");
}

function createWorkerRun(
  run: Readonly<PositionedRun>,
  fontRevision: number,
  mode: WorkerRunMode,
): SerializedPositionedRun {
  return {
    source: "harfbuzz",
    text: run.text,
    fontFamily: run.fontFamily,
    fontRevision,
    glyphCount: run.glyphCount,
    direction: run.direction,
    glyphIds: uint32Column(run.glyphIds, mode),
    clusters: uint32Column(run.clusters, mode),
    ...(run.clusterEnds === undefined ? {} : { clusterEnds: uint32Column(run.clusterEnds, mode) }),
    ...(run.variationKey === undefined ? {} : { variationKey: run.variationKey }),
    x: float32Column(run.x, mode),
    y: float32Column(run.y, mode),
    xAdvance: float32Column(run.xAdvance, mode),
    yAdvance: float32Column(run.yAdvance, mode),
    lineIndices: uint32Column(run.lineIndices, mode),
    ...(run.glyphKeys === undefined
      ? {}
      : { glyphKeys: mode === "copy" ? [...run.glyphKeys] : run.glyphKeys }),
    bounds: mode === "copy" ? { ...run.bounds } : run.bounds,
  };
}

function uint32Column(values: Readonly<Uint32Array>, mode: WorkerRunMode): Uint32Array {
  return mode === "copy" ? new Uint32Array(values) : (values as Uint32Array);
}

function float32Column(values: Readonly<Float32Array>, mode: WorkerRunMode): Float32Array {
  return mode === "copy" ? new Float32Array(values) : (values as Float32Array);
}

/** @internal */
export function workerRunTransferables(run: SerializedPositionedRun): Transferable[] {
  const transfer: Transferable[] = [
    run.glyphIds.buffer,
    run.clusters.buffer,
    run.x.buffer,
    run.y.buffer,
    run.xAdvance.buffer,
    run.yAdvance.buffer,
    run.lineIndices.buffer,
  ];
  if (run.clusterEnds !== undefined) {
    transfer.push(run.clusterEnds.buffer);
  }

  return transfer;
}
