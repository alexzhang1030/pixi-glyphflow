import type { ShapeResultResponse } from "../../src/worker/SabShapeTransport";

export function browserShapeResult(): Readonly<ShapeResultResponse> {
  return {
    type: "shape-result",
    requestId: 91,
    labelId: 404,
    sourceRevision: 12,
    fontRevision: 5,
    run: {
      source: "harfbuzz",
      text: "سلام glyph",
      fontFamily: "BrowserFixture",
      fontRevision: 5,
      glyphCount: 4,
      direction: "rtl",
      glyphIds: Uint32Array.from([17, 23, 42, 71]),
      clusters: Uint32Array.from([7, 5, 2, 0]),
      clusterEnds: Uint32Array.from([9, 7, 5, 2]),
      x: Float32Array.from([0.25, 9.5, 19.75, 31]),
      y: Float32Array.from([0, 0.5, -0.5, 0]),
      xAdvance: Float32Array.from([9.25, 10.25, 11.25, 8.5]),
      yAdvance: new Float32Array(4),
      lineIndices: new Uint32Array(4),
      glyphKeys: ["17", "23", "42", "71"],
      variationKey: "wdth=92,wght=625",
      bounds: { x: 0.25, y: -1.5, width: 39.25, height: 18.5 },
    },
  };
}
