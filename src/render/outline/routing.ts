import type { OutlineRoute, OutlineRouteInput } from "./types";

export function resolveOutlineRoute(input: Readonly<OutlineRouteInput>): Readonly<OutlineRoute> {
  if (input.mode === "auto") {
    return Object.freeze({ path: "atlas", reason: "outline-disabled" });
  }
  if (!Number.isFinite(input.projectedHeightPx) || input.projectedHeightPx < 0) {
    throw new TypeError("projectedHeightPx must be finite and non-negative");
  }
  if (!Number.isFinite(input.projectedSizeThresholdPx) || input.projectedSizeThresholdPx <= 0) {
    throw new TypeError("projectedSizeThresholdPx must be finite and positive");
  }
  if (input.projectedHeightPx < input.projectedSizeThresholdPx) {
    return Object.freeze({ path: "atlas", reason: "below-projected-threshold" });
  }
  if (input.capability.status === "unsupported") {
    return Object.freeze({ path: "atlas", reason: "capability-unavailable" });
  }
  return Object.freeze({ path: "outline" });
}
