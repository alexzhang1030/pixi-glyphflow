# Changelog

## 1.0.0 - 2026-08-15

### Added

- Dense, generation-checked storage for 1,000,000 labels with immutable snapshots and compact
  diagnostics.
- Ergonomic CRUD, object-batch, packed-position, and columnar text-plus-position mutation APIs.
- PixiJS bitmap layout plus direct and worker-backed HarfBuzz shaping for multilingual text.
- Bounded MSDF, SDF, alpha, and color glyph atlases with generation-safe eviction.
- Compact glyph instances, transform palettes, dirty-range uploads, and paired WebGL/WebGPU shaders.
- Spatial culling, hit testing, bounds, z order, blend modes, effects, lifecycle isolation, and
  accessibility mirroring.
- pixi-viewport 6 binding for drag, deceleration, wheel, pinch, zoom, and rotated cameras.
- Interactive million-label playground with a 100,000-label position storm.
- Isolated browser benchmark laboratory, committed raw artifacts, generated reports, and CI budgets.
- Focused root, viewport, accessibility, shaping, advanced, and worker package entry points.

### Performance

- One million resident labels stay within 72 MiB of fixed-width CPU storage on the reference run.
- Eight million visible glyphs use a 256,000,000-byte instance buffer and one observed instanced draw.
- Million-label viewport, dynamic counter, drag, zoom, and position-storm frame p95 values stay within
  the 16.67 millisecond budget on the reference Apple M1 Pro browser fixture.

## 0.0.1 - 2026-08-15

### Added

- Publishable ESM package metadata for `pixi-glyphflow`.
- PixiJS-compatible `TextLayer` POC with label creation, mutation, removal, commits, lifecycle, and
  diagnostics.
- Bun tests for the public lifecycle and error paths.
- Bun, TypeScript 7, tsdown, Oxlint, Oxfmt, publint, and Are the Types Wrong verification gates.
- GitHub CI and npm Trusted Publishing workflows.
