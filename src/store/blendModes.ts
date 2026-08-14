import type { BLEND_MODES } from "pixi.js";

const BLEND_MODES_LIST = [
  "inherit",
  "normal",
  "add",
  "multiply",
  "screen",
  "darken",
  "lighten",
  "erase",
  "color-dodge",
  "color-burn",
  "linear-burn",
  "linear-dodge",
  "linear-light",
  "hard-light",
  "soft-light",
  "pin-light",
  "difference",
  "exclusion",
  "overlay",
  "saturation",
  "color",
  "luminosity",
  "normal-npm",
  "add-npm",
  "screen-npm",
  "none",
  "subtract",
  "divide",
  "vivid-light",
  "hard-mix",
  "negation",
  "min",
  "max",
] as const satisfies readonly BLEND_MODES[];

const BLEND_MODE_CODES = new Map<BLEND_MODES, number>(
  BLEND_MODES_LIST.map((mode, index) => [mode, index]),
);

export function encodeBlendMode(mode: BLEND_MODES): number {
  const code = BLEND_MODE_CODES.get(mode);
  if (code === undefined) throw new TypeError(`Unsupported blendMode: ${String(mode)}`);
  return code;
}

export function decodeBlendMode(code: number): BLEND_MODES {
  const mode = BLEND_MODES_LIST[code];
  if (mode === undefined) throw new RangeError(`Unknown blend mode code: ${String(code)}`);
  return mode;
}

export function assertBlendMode(mode: unknown): asserts mode is BLEND_MODES {
  if (typeof mode !== "string" || !BLEND_MODE_CODES.has(mode as BLEND_MODES)) {
    throw new TypeError(`Unsupported blendMode: ${String(mode)}`);
  }
}
