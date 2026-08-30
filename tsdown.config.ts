import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/advanced/index.ts",
    "src/prebuilt/index.ts",
    "src/shaping/index.ts",
    "src/render/outline/index.ts",
    "src/hb-gpu/index.ts",
    "src/hb-gpu/worker.ts",
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
  copy: [{ from: "src/hb-gpu/wasm/*", to: "dist/hb-gpu/wasm" }],
  deps: {
    neverBundle: ["pixi.js", "pixi-viewport", "harfbuzzjs", "@zappar/msdf-generator"],
  },
});
