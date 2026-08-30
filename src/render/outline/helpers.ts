import type { OutlineColor } from "./types";

export function normalizeOutlineColor(color: OutlineColor, invalidMessage: string): OutlineColor {
  if (color.length !== 4 || color.some((channel) => !Number.isFinite(channel))) {
    throw new TypeError(invalidMessage);
  }
  return Object.freeze([
    clamp(color[0], 0, 1),
    clamp(color[1], 0, 1),
    clamp(color[2], 0, 1),
    clamp(color[3], 0, 1),
  ]);
}

export function powerOfTwoBucket(target: number): number {
  let bucket = 1;
  while (bucket < target && bucket <= Number.MAX_SAFE_INTEGER / 2) bucket *= 2;
  return bucket < target ? target : bucket;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
