import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/accessibility/index.ts",
    "src/viewport/index.ts",
    "src/worker/text-worker.ts",
  ],
  format: ["esm"],
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  deps: {
    neverBundle: ["pixi.js", "pixi-viewport", "harfbuzzjs", "@zappar/msdf-generator"],
  },
});
