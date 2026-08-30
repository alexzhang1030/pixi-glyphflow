import type { HbGpuGlyphExtents } from "./types";

export type HbGpuDrawWorkerRequest =
  | {
      readonly type: "initialize";
      readonly requestId: number;
      readonly wasmUrl: string;
      readonly expectedAbiVersion: number;
      readonly expectedHarfBuzzVersion: string;
    }
  | {
      readonly type: "register-font";
      readonly requestId: number;
      readonly fontKey: string;
      readonly data: ArrayBuffer;
    }
  | {
      readonly type: "encode";
      readonly requestId: number;
      readonly fontKey: string;
      readonly glyphId: number;
    }
  | {
      readonly type: "release-font";
      readonly requestId: number;
      readonly fontKey: string;
    }
  | {
      readonly type: "dispose";
      readonly requestId: number;
    };

export type HbGpuDrawWorkerResponse =
  | {
      readonly type: "ready";
      readonly requestId: number;
      readonly abiVersion: number;
      readonly harfbuzzVersion: string;
    }
  | {
      readonly type: "ok";
      readonly requestId: number;
    }
  | {
      readonly type: "font-released";
      readonly requestId: number;
      readonly released: boolean;
    }
  | {
      readonly type: "encode-result";
      readonly requestId: number;
      readonly packedCurveBlob: ArrayBuffer;
      readonly extents: Readonly<HbGpuGlyphExtents>;
      readonly upem: number;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
    };
