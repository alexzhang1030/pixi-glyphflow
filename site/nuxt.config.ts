import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  ssr: true,
  alias: {
    "pixi-glyphflow/viewport": fileURLToPath(new URL("../dist/viewport/index.js", import.meta.url)),
    "pixi-glyphflow/prebuilt": fileURLToPath(new URL("../dist/prebuilt/index.js", import.meta.url)),
    "pixi-glyphflow": fileURLToPath(new URL("../dist/index.js", import.meta.url)),
  },
  future: {
    compatibilityVersion: 5,
  },
  devtools: { enabled: false },
  compatibilityDate: "2026-08-15",
  modules: ["@nuxtjs/color-mode"],
  css: ["~/assets/css/main.css"],
  colorMode: {
    classSuffix: "",
    preference: "system",
    fallback: "dark",
  },
  vite: {
    plugins: [tailwindcss()],
    build: {
      target: "es2022",
    },
    worker: {
      format: "es",
    },
  },
  app: {
    head: {
      title: "pixi-glyphflow — Render text at scene scale",
      htmlAttrs: { lang: "en" },
      link: [{ rel: "icon", type: "image/svg+xml", href: "/glyphflow-mark.svg" }],
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          name: "description",
          content:
            "A million-label text layer for PixiJS 8 with instanced rendering, dense culling, worker shaping, and pixi-viewport integration.",
        },
        { name: "theme-color", content: "#080b0f" },
        { property: "og:type", content: "website" },
        { property: "og:title", content: "pixi-glyphflow — Render text at scene scale" },
        {
          property: "og:description",
          content: "A million-label text layer for PixiJS 8 with instanced WebGL/WebGPU rendering.",
        },
      ],
    },
  },
});
