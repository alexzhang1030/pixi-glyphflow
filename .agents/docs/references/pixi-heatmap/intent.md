# Intent

pixi-heatmap is a **blended (KDE-style) heatmap layer for PixiJS v8** — smooth overlapping density fields, not heat blocks.

- **For whom**: web developers building data-viz / analytics / interactive apps on PixiJS v8 who need 100k+ point heatmaps at full frame rate, on both the WebGL and WebGPU renderers.
- **What it is trying to be**: the fastest, most resource-frugal heatmap for the Pixi ecosystem — high frame rate **and** minimal CPU / GPU / memory footprint are equally weighted goals. Publishable npm library with a polished single-page docs site (which doubles as the live benchmark).
- **Non-goals**:
  - Pixi v7 or older — no compatibility shims, v8+ only.
  - Matrix / grid heatmaps (bioinformatics-style cell grids) — different problem, already served by hotmap/HiGlass.
  - Server-side / hierarchical pre-aggregation for data >> GPU memory (imMens/HDE territory).
  - Backend forks that duplicate public field semantics or layer ownership — shared contracts feed an isolated WebGPU accelerator and the cross-backend Pixi raster engine.
