import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/worker/text-worker.ts"],
  format: ["esm"],
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  deps: {
    neverBundle: ["pixi.js", "harfbuzzjs", "@zappar/msdf-generator"],
  },
});
