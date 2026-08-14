import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  deps: {
    neverBundle: ["pixi.js"],
  },
});
