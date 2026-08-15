# Performance

Generated from raw browser artifacts for pixi-glyphflow 1.1.0.

## Reference environment

- CPU: Apple M1 Pro
- OS: darwin 27.0.0 (arm64)
- Bun: 1.3.14
- Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36
- Renderer: WebGL 2 with explicit GPU completion before each measured frame

## Method

Each workload starts in an isolated Chrome process. Setup, warmup, mutation, commit, culling, and frame samples are recorded separately. The full-visibility fixture submits one instanced draw containing eight million glyphs. Viewport workloads use pixi-viewport drag, deceleration, wheel, pinch, zoom, and camera rotation events over one million resident labels.

## Workload results

| Workload            |    Labels | Mutations |      Setup | Frame p50 | Frame p95 | Mutation p95 | Commit p95 | Visible glyphs | Draws | Status   |
| ------------------- | --------: | --------: | ---------: | --------: | --------: | -----------: | ---------: | -------------: | ----: | -------- |
| static-hud          |     1,000 |         1 |   77.10 ms |   0.00 ms |   0.10 ms |            — |          — |          8,000 |     1 | complete |
| million-viewport    | 1,000,000 |         1 |  354.60 ms |   5.30 ms |   5.40 ms |            — |          — |         33,456 |     0 | complete |
| dynamic-counters    | 1,000,000 |   100,000 |  343.90 ms |  15.50 ms |  16.40 ms |     15.70 ms |    0.70 ms |      9,000,000 |     0 | complete |
| viewport-drag       | 1,000,000 |         1 |  386.30 ms |   5.60 ms |   5.80 ms |            — |          — |         64,521 |     0 | complete |
| viewport-zoom       | 1,000,000 |         1 |  402.90 ms |   5.60 ms |   7.60 ms |            — |          — |      1,000,000 |     0 | complete |
| position-storm      | 1,000,000 |   100,000 |  335.60 ms |   9.30 ms |   9.50 ms |      3.60 ms |    6.10 ms |          4,080 |     0 | complete |
| multilingual-stream |    10,000 |     1,000 |  101.10 ms |   1.10 ms |   1.50 ms |      0.30 ms |    1.30 ms |          3,240 |     1 | complete |
| scale-scan          |    50,000 |         1 |  109.80 ms |   0.50 ms |   6.10 ms |            — |          — |         50,500 |     1 | complete |
| atlas-pressure      |    20,000 |         1 | 2378.50 ms |   1.10 ms | 638.50 ms |            — |          — |         16,384 |     0 | complete |
| million-full        | 1,000,000 |         1 |  637.20 ms |   0.00 ms |   0.10 ms |            — |          — |      8,000,000 |     1 | complete |

## Equal-content static HUD

| Fixture     |      Setup | Frame p50 | Frame p95 |
| ----------- | ---------: | --------: | --------: |
| text        |  581.40 ms |   0.10 ms |   0.70 ms |
| bitmap-text |   56.20 ms |   0.00 ms |   0.10 ms |
| glyphflow   |   77.10 ms |   0.00 ms |   0.10 ms |
| html-text   | 3658.90 ms |   0.10 ms |   0.80 ms |

## Capacity and storage

| Workload            | CPU store | Glyph instances | Transform palette |    Atlas | Evictions |
| ------------------- | --------: | --------------: | ----------------: | -------: | --------: |
| static-hud          | 72.00 KiB |      250.00 KiB |         64.00 KiB |        — |         0 |
| million-viewport    | 72.00 MiB |             0 B |         64.00 MiB |        — |         0 |
| dynamic-counters    | 72.50 MiB |             0 B |         64.00 MiB |        — |         0 |
| viewport-drag       | 72.00 MiB |             0 B |         64.00 MiB |        — |         0 |
| viewport-zoom       | 72.00 MiB |             0 B |         64.00 MiB |        — |         0 |
| position-storm      | 72.50 MiB |             0 B |         64.00 MiB |        — |         0 |
| multilingual-stream |  1.13 MiB |       77.34 KiB |          1.00 MiB |        — |         0 |
| scale-scan          |  4.50 MiB |        1.54 MiB |          4.00 MiB |        — |         0 |
| atlas-pressure      |         — |               — |                 — | 4.00 MiB |     3,616 |
| million-full        | 72.00 MiB |      244.14 MiB |         61.04 MiB |        — |         0 |

## Invariants

Every recorded boolean invariant passed.

## Raw artifacts

- [static-hud](results/browser-static-hud-1.1.0.json)
- [million-viewport](results/browser-million-viewport-1.1.0.json)
- [dynamic-counters](results/browser-dynamic-counters-1.1.0.json)
- [viewport-drag](results/browser-viewport-drag-1.1.0.json)
- [viewport-zoom](results/browser-viewport-zoom-1.1.0.json)
- [position-storm](results/browser-position-storm-1.1.0.json)
- [multilingual-stream](results/browser-multilingual-stream-1.1.0.json)
- [scale-scan](results/browser-scale-scan-1.1.0.json)
- [atlas-pressure](results/browser-atlas-pressure-1.1.0.json)
- [million-full](results/browser-million-full-1.1.0.json)
