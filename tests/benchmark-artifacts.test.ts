import { describe, expect, test } from "bun:test";

import {
  browserArtifactFileName,
  parseBrowserArtifactName,
  resolveBrowserArtifact,
} from "../benchmarks/artifacts";

describe("browser artifact names", () => {
  test("parses formal and exploratory filenames and rejects other workloads", () => {
    expect(parseBrowserArtifactName("browser-viewport-zoom-1.1.0.json", "viewport-zoom")).toEqual({
      version: "1.1.0",
      exploratory: false,
    });
    expect(
      parseBrowserArtifactName("browser-viewport-zoom-1.2.0-exploratory.json", "viewport-zoom"),
    ).toEqual({
      version: "1.2.0",
      exploratory: true,
    });
    expect(
      parseBrowserArtifactName("browser-viewport-drag-1.1.0.json", "viewport-zoom"),
    ).toBeUndefined();
    expect(
      parseBrowserArtifactName("browser-viewport-zoom-main.json", "viewport-zoom"),
    ).toBeUndefined();
  });
});

describe("resolveBrowserArtifact", () => {
  const files = [
    browserArtifactFileName("static-hud", "0.0.1"),
    browserArtifactFileName("static-hud", "1.0.0"),
    browserArtifactFileName("static-hud", "1.1.0"),
    browserArtifactFileName("static-hud", "1.2.0", true),
    browserArtifactFileName("viewport-zoom", "1.1.0"),
    browserArtifactFileName("million-viewport", "1.1.0"),
  ];

  test("prefers the current package version over older formal files", () => {
    expect(resolveBrowserArtifact("static-hud", "1.1.0", files)).toEqual({
      fileName: "browser-static-hud-1.1.0.json",
      version: "1.1.0",
      current: true,
    });
  });

  test("falls back to the newest older formal artifact", () => {
    expect(resolveBrowserArtifact("static-hud", "1.2.0", files)).toEqual({
      fileName: "browser-static-hud-1.1.0.json",
      version: "1.1.0",
      current: false,
    });
  });

  test("ignores exploratory files and newer versions than the package", () => {
    const withFuture = [...files, browserArtifactFileName("static-hud", "1.3.0")];
    expect(resolveBrowserArtifact("static-hud", "1.2.0", withFuture)).toEqual({
      fileName: "browser-static-hud-1.1.0.json",
      version: "1.1.0",
      current: false,
    });
  });

  test("requireCurrent refuses a fallback even when older files exist", () => {
    expect(
      resolveBrowserArtifact("static-hud", "1.2.0", files, { requireCurrent: true }),
    ).toBeUndefined();
    expect(resolveBrowserArtifact("static-hud", "1.1.0", files, { requireCurrent: true })).toEqual({
      fileName: "browser-static-hud-1.1.0.json",
      version: "1.1.0",
      current: true,
    });
  });

  test("does not treat another workload id as a match", () => {
    expect(resolveBrowserArtifact("viewport-zoom", "1.2.0", files)?.fileName).toBe(
      "browser-viewport-zoom-1.1.0.json",
    );
    expect(resolveBrowserArtifact("camera-live", "1.2.0", files)).toBeUndefined();
  });
});
