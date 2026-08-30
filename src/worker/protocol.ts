import type { RunBounds, TextDirection } from "../layout/types";
import type { HarfBuzzShapeInput } from "../shaping/types";

export interface SerializedPositionedRun {
  readonly source: "harfbuzz";
  readonly text: string;
  readonly fontFamily: string;
  readonly fontRevision: number;
  readonly glyphCount: number;
  readonly direction: TextDirection;
  readonly glyphIds: Uint32Array;
  readonly clusters: Uint32Array;
  readonly clusterEnds?: Uint32Array;
  readonly variationKey?: string;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly xAdvance: Float32Array;
  readonly yAdvance: Float32Array;
  readonly lineIndices: Uint32Array;
  readonly glyphKeys?: readonly string[];
  readonly bounds: RunBounds;
}

export type ShapeWorkerRequest =
  | {
      readonly type: "attach-shape-transport";
      readonly requestId: number;
      readonly buffer: SharedArrayBuffer;
    }
  | {
      readonly type: "register-font";
      readonly requestId: number;
      readonly family: string;
      readonly fontRevision: number;
      readonly data: ArrayBuffer;
    }
  | {
      readonly type: "unregister-font";
      readonly requestId: number;
      readonly family: string;
    }
  | {
      readonly type: "shape";
      readonly requestId: number;
      readonly labelId: number;
      readonly sourceRevision: number;
      readonly fontRevision: number;
      readonly input: HarfBuzzShapeInput;
    }
  | {
      readonly type: "dispose";
      readonly requestId: number;
    };

export type ShapeWorkerResponse =
  | {
      readonly type: "ok";
      readonly requestId: number;
    }
  | {
      readonly type: "shape-result";
      readonly requestId: number;
      readonly labelId: number;
      readonly sourceRevision: number;
      readonly fontRevision: number;
      readonly run: SerializedPositionedRun;
    }
  | {
      readonly type: "shape-result-sab";
      readonly requestId: number;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
    };
