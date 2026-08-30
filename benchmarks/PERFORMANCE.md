# Performance

Generated from raw browser artifacts for pixi-glyphflow 1.2.0.

## Reference environment

- CPU: Apple M1 Pro
- OS: darwin 27.0.0 (arm64)
- Bun: 1.4.0
- Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36
- Latest renderer: webgpu

## Current artifact availability

- `static-hud`: unavailable (stale). Current browser artifact is stale for static-hud/webgl: expected package 1.2.0, found 1.1.0
- `million-viewport`: unavailable (stale). Current browser artifact is stale for million-viewport/webgl: expected package 1.2.0, found 1.1.0
- `dynamic-counters`: unavailable (stale). Current browser artifact is stale for dynamic-counters/webgl: expected package 1.2.0, found 1.1.0
- `viewport-drag`: unavailable (stale). Current browser artifact is stale for viewport-drag/webgl: expected package 1.2.0, found 1.1.0
- `viewport-zoom`: unavailable (stale). Current browser artifact is stale for viewport-zoom/webgl: expected package 1.2.0, found 1.1.0
- `position-storm`: unavailable (stale). Current browser artifact is stale for position-storm/webgl: expected package 1.2.0, found 1.1.0
- `multilingual-stream`: unavailable (stale). Current browser artifact is stale for multilingual-stream/webgl: expected package 1.2.0, found 1.1.0
- `scale-scan`: unavailable (stale). Current browser artifact is stale for scale-scan/webgl: expected package 1.2.0, found 1.1.0
- `atlas-pressure`: unavailable (stale). Current browser artifact is stale for atlas-pressure/webgl: expected package 1.2.0, found 1.1.0
- `million-full`: unavailable (stale). Current browser artifact is stale for million-full/webgl: expected package 1.2.0, found 1.1.0
- `first-seen`: unavailable (missing). Current browser artifact is missing for first-seen/webgl at package 1.2.0
- `camera-live`: unavailable (missing). Current browser artifact is missing for camera-live/webgl at package 1.2.0

## Method

Each workload starts in an isolated Chrome process. Renderer and artifact role are part of the artifact identity, so baseline, candidate, and exploratory results resolve independently. Current candidates require schema 7 evidence seals plus exact frozen-browser-build and harness fingerprints. GPU Scene v2 remains visible as a sealed fixed RED control. Setup, warmup, mutation, commit, culling, upload, CPU, whole-frame, GPU timestamp, and completion-wall samples are recorded separately. GPU Scene resident keeps one million label records on the GPU and measures camera-only plus 100,000-mover phases. Its six-query WebGPU timer resolves product, palette, cull, and scene-render boundaries in the product command encoder. R1a crosses 64 prototypes with 8 paints into 512 bins; each repetition carries independent CPU count/hash and double pixel readback truth. Collision repeatability aggregates three sealed WebGL and three sealed WebGPU runs. WebGL reports EXT_disjoint_timer_query_webgl2 timestamps. Invalid timestamp deltas select completion-wall fallback and mark timing quality accordingly.

## Workload results

| Workload                   | Renderer |    Labels | Mutations |      Setup | Frame p50 | Frame p95 | Camera p95 | Position p95 | Mutation p95 | Commit p95 | Visible glyphs | Logical meshes | Artifact                     | Budget      |
| -------------------------- | -------- | --------: | --------: | ---------: | --------: | --------: | ---------: | -----------: | -----------: | ---------: | -------------: | -------------: | ---------------------------- | ----------- |
| static-hud                 | legacy   |     1,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| million-viewport           | legacy   | 1,000,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| dynamic-counters           | legacy   | 1,000,000 |   100,000 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| viewport-drag              | legacy   | 1,000,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| viewport-zoom              | legacy   | 1,000,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| position-storm             | legacy   | 1,000,000 |   100,000 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| multilingual-stream        | legacy   |    10,000 |     1,000 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| scale-scan                 | legacy   |    50,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| atlas-pressure             | legacy   |    20,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| million-full               | legacy   | 1,000,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (stale)          | —           |
| million-live               | webgl    | 1,000,000 |         1 | 1661.20 ms |   0.00 ms |   0.10 ms |          — |            — |            — |          — |      8,000,000 |              1 | complete                     | passed      |
| first-seen                 | legacy   |    20,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (missing)        | —           |
| camera-live                | legacy   |   200,000 |         1 |          — |         — |         — |          — |            — |            — |          — |              — |              — | unavailable (missing)        | —           |
| gpu-scene-v2               | webgl    | 1,000,000 |   100,000 |  732.30 ms |  92.80 ms | 166.50 ms |  159.80 ms |    213.70 ms |      6.30 ms |  138.60 ms |        259,605 |              1 | complete (fixed RED control) | RED control |
| gpu-scene-v2               | webgpu   | 1,000,000 |   100,000 |  874.00 ms | 125.70 ms | 187.70 ms |  193.40 ms |    186.00 ms |      7.50 ms |  151.40 ms |        259,605 |              1 | complete (fixed RED control) | RED control |
| gpu-scene-heterogeneous-64 | webgpu   | 1,000,000 |   100,000 | 1032.30 ms |  12.30 ms |  16.70 ms |   14.40 ms |     16.90 ms |      2.60 ms |    0.40 ms |        259,609 |              1 | complete                     | passed      |
| gpu-scene-resident         | webgpu   | 1,000,000 |   100,000 |  843.70 ms |   8.70 ms |  13.00 ms |   11.10 ms |     13.40 ms |      2.60 ms |    0.30 ms |         50,000 |              1 | complete                     | passed      |
| label-collision            | webgl    | 1,000,000 |         1 |  483.20 ms |  15.20 ms |  21.50 ms |          — |            — |            — |    9.30 ms |          4,096 |              1 | complete                     | passed      |
| label-collision            | webgpu   | 1,000,000 |         1 |  457.70 ms |   8.30 ms |  15.30 ms |          — |            — |            — |    8.40 ms |          4,096 |              1 | complete                     | passed      |

## Fixed RED controls

These sealed GPU Scene v2 candidates remain visible as informational controls for the resident speedup comparison.

| Renderer | Camera p95 | Position p95 |    Limit | Status      |
| -------- | ---------: | -----------: | -------: | ----------- |
| webgl    |  159.80 ms |    213.70 ms | 16.67 ms | RED control |
| webgpu   |  193.40 ms |    186.00 ms | 16.67 ms | RED control |

## Equal-content static HUD

| Fixture     | Setup | Frame p50 | Frame p95 |
| ----------- | ----: | --------: | --------: |
| unavailable |     — |         — |         — |

## Capacity and storage

| Workload                            | CPU store | Draw references | Prototype records | Instance field | Transform core | Atlas | Evictions |
| ----------------------------------- | --------: | --------------: | ----------------: | -------------: | -------------: | ----: | --------: |
| million-live                        | 53.00 MiB |       61.04 MiB |             192 B |          192 B |      32.00 MiB |     — |         0 |
| gpu-scene-v2 (webgl)                | 53.50 MiB |               — |                 — |       5.94 MiB |      32.00 MiB |     — |         0 |
| gpu-scene-v2 (webgpu)               | 53.50 MiB |               — |                 — |      14.25 MiB |      32.00 MiB |     — |         0 |
| gpu-scene-heterogeneous-64 (webgpu) | 59.00 MiB |               — |                 — |       1.50 KiB |      32.00 MiB |     — |         0 |
| gpu-scene-resident (webgpu)         | 59.00 MiB |               — |                 — |           24 B |      32.00 MiB |     — |         0 |
| label-collision (webgl)             | 53.00 MiB |               — |                 — |      96.00 KiB |      32.00 MiB |     — |         0 |
| label-collision (webgpu)            | 53.00 MiB |               — |                 — |      96.00 KiB |      32.00 MiB |     — |         0 |

## Current Wave 2 live gate

The formal fixture uses 10 warmup frames and 120 steady-state full-visibility product frames. The constructor base-store unit contract remains 48 MiB + 256 B; this browser gate measures the complete live runtime store against 64 MiB.

| Measure                     |    Actual |     Limit | Gate |
| --------------------------- | --------: | --------: | ---- |
| Product frame p95           |   0.10 ms |  16.67 ms | PASS |
| Live runtime store          | 53.00 MiB | 64.00 MiB | PASS |
| Draw reference stride       |       8 B |       8 B | PASS |
| Prototype record stride     |      24 B |      24 B | PASS |
| Fill transform core         |      32 B |      32 B | PASS |
| Effectful transform maximum |      48 B |      48 B | PASS |

Current Wave 2 gate: PASS.

## R1a heterogeneous GPU-scene delivery

| Repetition |      Setup | Camera p95 | Camera speedup | Position p95 | Position speedup | Submitted count/hash | Pixel hash | CPU identity |
| ---------: | ---------: | ---------: | -------------: | -----------: | ---------------: | -------------------- | ---------- | ------------ |
|          1 | 1032.30 ms |   14.40 ms |         13.85× |     16.90 ms |           11.83× | 259,609 / 0x9dbf0bd5 | 0x8c5162ca | exact        |
|          2 | 1029.20 ms |   14.10 ms |         14.15× |     16.20 ms |           12.34× | 259,609 / 0x9dbf0bd5 | 0x8c5162ca | exact        |

Resident identity: 1,000,000 GPU labels; 64 prototypes; 8 paints; 512 prototype/paint pairs; 0 per-label GPU-scene objects.
Delivery: GO. Promotion: PAUSE. Fixed baseline: 199.50 ms camera / 199.90 ms position, minimum 4×.
The current sealed repetitions use the dense 8-byte mover lane at 800,016 bytes per 100,000 movers. Sparse, reordered, duplicate, and holed batches use the indexed 12-byte fallback. The frozen [legacy R1a candidate](results/browser-gpu-scene-heterogeneous-64-webgpu-candidate-legacy-12b-1.2.0.json.gz) preserves its indexed 1,200,016-byte capture.

## GPU-resident scene phases

| Phase            | Frame p95 | >16.67 ms | Miss ratio | Frame p99 | Frame max | CPU p95 | Mutation p95 | Commit p95 | Surface p95 | Render-pass GPU p95 | Transform upload p95 | Cull upload max | Shaped delta | Admitted total | Cull-query delta |
| ---------------- | --------: | --------: | ---------: | --------: | --------: | ------: | -----------: | ---------: | ----------: | ------------------: | -------------------: | --------------: | -----------: | -------------: | ---------------: |
| camera           |  11.10 ms |   0 / 120 |      0.00% |  11.80 ms |  12.20 ms | 0.60 ms |      0.10 ms |    0.20 ms |     0.10 ms |             8.85 ms |                  0 B |             0 B |            0 |              0 |                0 |
| positionMutation |  13.40 ms |   0 / 120 |      0.00% |  13.70 ms |  14.00 ms | 0.50 ms |      2.60 ms |    0.30 ms |     0.20 ms |             8.72 ms |           781.27 KiB |             0 B |            0 |              0 |                0 |

GPU resident labels: 1,000,000. Shared prototypes: 1. Submitted glyphs: 50,000. Submitted hash: 0x45cfd045 (gpu-instances-out-readback). Pixel readbacks: 0xa8ad90b4 / 0xa8ad90b4 with 302,457 / 302,457 non-transparent pixels. Logical meshes: 1; WebGPU draw observer: unavailable-webgpu (0 sentinel). Setup: 843.70 ms. Heap: 242.07 MiB.
Product frame submissions: 260 total / 260 fused / 0 standalone. Timestamp telemetry: 260 readbacks / 260 fused resolves / 0 standalone submissions. Diagnostic readback submissions: 2.
This current sealed sample records 800,016 transform-upload bytes for every 100,000-mover frame through the dense 8-byte lane. Indexed fallback remains 12 bytes per mover plus the 16-byte header. The [legacy candidate](results/browser-gpu-scene-resident-webgpu-candidate-legacy-16b-1.2.0.json.gz) preserves the earlier 16-byte capture.

## Current GPU-resident promotion

Schema 7 raw artifacts feed the [schema 4 promotion aggregate](results/browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json), SHA-256 `a3a0eee1525765063d215a142230226a5b0f3bc7f07d52be4990f7b656ccc9db`. The frozen canonical output source is [browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json](results/browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json.gz), SHA-256 `e8149d863b2d75af2e2ac997114597f5ab8ae4a3ca2746cf54c92f7672d69f7c`.
Frozen provenance: build `1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4`; harness `2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`; runtime `5179504654b69449d6d2219ef12d1f6f8a12d053c89881702db871c38dd6fec7`. Five independent 120-frame runs and the sustained 600-frame run share all three fingerprints while carrying distinct run ids, capture timestamps, candidate hashes, and evidence hashes.

| Run | Budget |           Camera p95/p99/max | Camera >16.67 ms |           Position p95/p99/max | Position >16.67 ms | GPU / pixel identity                 | Raw evidence                                                                                                                              |
| --: | ------ | ---------------------------: | ---------------: | -----------------------------: | -----------------: | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | pass   |  8.20 ms / 9.50 ms / 9.80 ms |          0 / 120 | 10.80 ms / 12.20 ms / 12.40 ms |            0 / 120 | 0x45cfd045 / 0xa8ad90b4 / 302,457 px | [browser-gpu-scene-resident-webgpu-formal-1-1.2.0.json](results/browser-gpu-scene-resident-webgpu-formal-1-1.2.0.json.gz) `16fc29c90000…` |
|   2 | pass   |  8.00 ms / 9.40 ms / 9.90 ms |          0 / 120 |  9.70 ms / 11.00 ms / 12.50 ms |            0 / 120 | 0x45cfd045 / 0xa8ad90b4 / 302,457 px | [browser-gpu-scene-resident-webgpu-formal-2-1.2.0.json](results/browser-gpu-scene-resident-webgpu-formal-2-1.2.0.json.gz) `5d5fd48d2487…` |
|   3 | pass   |  7.90 ms / 8.60 ms / 8.80 ms |          0 / 120 |  9.50 ms / 10.50 ms / 10.90 ms |            0 / 120 | 0x45cfd045 / 0xa8ad90b4 / 302,457 px | [browser-gpu-scene-resident-webgpu-formal-3-1.2.0.json](results/browser-gpu-scene-resident-webgpu-formal-3-1.2.0.json.gz) `3344f553a558…` |
|   4 | pass   | 7.90 ms / 9.70 ms / 10.60 ms |          0 / 120 | 10.00 ms / 10.80 ms / 10.90 ms |            0 / 120 | 0x45cfd045 / 0xa8ad90b4 / 302,457 px | [browser-gpu-scene-resident-webgpu-formal-4-1.2.0.json](results/browser-gpu-scene-resident-webgpu-formal-4-1.2.0.json.gz) `ee7200645540…` |
|   5 | pass   |  6.90 ms / 7.20 ms / 7.50 ms |          0 / 120 |    8.30 ms / 9.40 ms / 9.60 ms |            0 / 120 | 0x45cfd045 / 0xa8ad90b4 / 302,457 px | [browser-gpu-scene-resident-webgpu-candidate-1.2.0.json](results/browser-gpu-scene-resident-webgpu-candidate-1.2.0.json) `380856aefd4b…`  |

Truth repeatability: GO. Formal performance: GO.
5 / 5 formal runs passed every performance budget. Across all five runs, camera p95/p99/max is 7.90 ms / 9.40 ms / 10.60 ms with 0 / 600 >16.67 ms; position is 9.80 ms / 11.00 ms / 12.50 ms with 0 / 600 >16.67 ms.
Canonical output identity: 50,000 references / 0x45cfd045, pixel hash 0xa8ad90b4, 302,457 non-transparent pixels. Formal timestamp telemetry: 1,300 readbacks / 1,300 fused resolves / 0 standalone submissions.
Segmented timestamp gate: GO. 1,300 / 1,300 samples resolve all six queries with 0 fallbacks. Segment p95: palette 0.13 ms, cull 0.59 ms, scene render 5.44 ms.
Sustained 600-frame evidence: [browser-gpu-scene-resident-webgpu-fastlane-fused-600-1.2.0.json](results/browser-gpu-scene-resident-webgpu-fastlane-fused-600-1.2.0.json.gz), SHA-256 `61dd5fb7932fcb10868bb9fa3be13b6e4e71201b010da2b783464c8faedaddf5`. Camera 4 / 600 >16.67 ms (0.67%), p95/p99/max 10.50 ms / 13.50 ms / 21.50 ms; position 0 / 600 >16.67 ms (0.00%), p95/p99/max 8.10 ms / 9.90 ms / 11.60 ms. Timestamp telemetry: 1,220 / 1,220 / 0 readback/fused/standalone. Sustained gate: GO.
Dense upload and timing proof: all 600 formal position frames remain within 16.67 ms, every run records exact 800,016-byte position uploads, and palette/cull/scene-render segments are complete.
Promotion: GO (all gates passed).

## Historical GPU-resident scene repeatability

| Attempt | Outcome                       |     Setup | Camera frame p95 | Camera GPU p95 | Position frame p95 | Position GPU p95 | Selection hash | Pixel hash |  Pixels | Evidence            |
| ------: | ----------------------------- | --------: | ---------------: | -------------: | -----------------: | ---------------: | -------------: | ---------: | ------: | ------------------- |
|       1 | outlier (pre-fix invalidated) | 765.30 ms |          1.50 ms |        0.20 ms |           84.40 ms |         75.30 ms |              — |          — |       — | runner log          |
|       2 | pass (pre-fix invalidated)    | 769.60 ms |          2.20 ms |        0.26 ms |            9.80 ms |          0.39 ms |              — |          — |       — | digest 25cede022021 |
|       3 | pass (pre-fix invalidated)    | 762.00 ms |          3.50 ms |        0.39 ms |           10.30 ms |          0.39 ms |              — |          — |       — | digest ae27b97e3ceb |
|       4 | outlier (pre-fix invalidated) | 770.70 ms |         89.10 ms |       87.82 ms |           10.10 ms |          0.39 ms |              — |          — |       — | digest b8f0c4c6ac08 |
|       5 | pass (pre-fix invalidated)    | 762.40 ms |          1.60 ms |        0.20 ms |           10.90 ms |          0.39 ms |              — |          — |       — | digest 554fee8adea4 |
|       6 | fail                          | 789.10 ms |          9.80 ms |        8.32 ms |           18.50 ms |          9.37 ms |     0x45cfd045 | 0xa8ad90b4 | 302,457 | digest 91cdc22db54a |
|       7 | fail                          | 777.20 ms |         11.10 ms |        8.32 ms |           18.80 ms |          9.70 ms |     0x45cfd045 | 0xa8ad90b4 | 302,457 | digest 1c0bf280041c |
|       8 | fail                          | 800.70 ms |         10.10 ms |        8.32 ms |           19.50 ms |         10.09 ms |     0x45cfd045 | 0xa8ad90b4 | 302,457 | digest bc299d9ae2a5 |
|       9 | fail                          | 791.40 ms |         11.60 ms |        8.32 ms |           20.00 ms |         10.29 ms |     0x45cfd045 | 0xa8ad90b4 | 302,457 | digest 1929e713de81 |
|      10 | fail                          | 802.10 ms |         11.90 ms |        8.32 ms |           19.90 ms |         10.22 ms |     0x45cfd045 | 0xa8ad90b4 | 302,457 | digest d4914d86952b |

Post-fix outcomes: 0 pass / 5 attempts; 5 budget failures. Pre-fix history: 5 attempts invalidated by the compact-output capacity defect. Canonical candidate: historical digest (former-committed-artifact-digest). SHA-256: `d4914d86952b310de210cb517d3a2f12073494c86dc38eb609af1095a61de2eb`.
Frozen schema 2 repeatability artifact SHA-256: `b74ff555d22fa8b7f39fe0203c81293e3e55a633283a7f5322b3c16c8d9c8aa0`.
Cross-run GPU output identity: GO. Gate: at least three post-fix formal runs with one matching instancesOut hash, pixel hash, and non-transparent pixel count. Recorded complete runs: 5.
Sustained frame tail: camera 1 / 600 >16.67 ms (0.17%), p99 12.70 ms, max 16.90 ms; position 598 / 600 (99.67%), p99 20.70 ms, max 24.00 ms. Throughput: PAUSE. Release tail: PAUSE.

## Current collision repeatability

The [schema 2 aggregate](results/browser-label-collision-repeatability-1.2.0.json), SHA-256 `b501181208e39884e3cae5a589a540e5e783ec9d621df927b30f140ff42184a1`, combines three independently sealed WebGL runs and three independently sealed WebGPU runs from build `1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4` and harness `2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`.

| Renderer | Run |       Frame p50/p95 | CPU p95 | Commit p95 | Collision p95 | Candidate gate |
| -------- | --: | ------------------: | ------: | ---------: | ------------: | -------------- |
| webgl    |   1 | 12.10 ms / 21.00 ms | 9.30 ms |    9.30 ms |       2.70 ms | pass           |
| webgl    |   2 | 11.90 ms / 20.30 ms | 9.10 ms |    9.10 ms |       2.70 ms | pass           |
| webgl    |   3 | 14.60 ms / 21.10 ms | 9.20 ms |    9.10 ms |       2.80 ms | pass           |
| webgpu   |   1 |  8.00 ms / 12.20 ms | 8.30 ms |    8.20 ms |       2.90 ms | pass           |
| webgpu   |   2 |  7.90 ms / 11.50 ms | 8.50 ms |    8.30 ms |       2.90 ms | pass           |
| webgpu   |   3 |  7.90 ms / 11.90 ms | 8.30 ms |    8.10 ms |       2.90 ms | pass           |

WebGL aggregate p95 means: frame 20.80 ms, CPU 9.20 ms, collision 2.73 ms. WebGPU aggregate p95 means: frame 11.87 ms, CPU 8.37 ms, collision 2.90 ms.
Output identity: GO; all six runs preserve 512 selected labels, 4,096 glyphs, selection hash 0x611785c5, and exact accounting.
Repeatability: GO. The WebGPU whole-frame p95 range is 11.50 ms–12.20 ms against 16.67 ms.
The collision selector consumes pre-ranked, strictly increasing candidate slots, skips the rank sort, and caches contiguous identical-bound runs. Record and structure changes retire the touched run-cache spans before the next selection. Spatial queries route sparse candidates through ordered sort, dense candidates through a reusable ordered bitset, and near-full candidates through a linear scan.

## Historical collision active-scatter checkpoint

The WebGPU active-transform scatter comparison preserves three formal before runs and three formal after runs. The control and accounting invariants cover WebGL texture behavior, selection hash stability, and submitted glyph totals.

| Metric        | Before mean p95 | After mean p95 | Reduction | After range | After CV |
| ------------- | --------------: | -------------: | --------: | ----------: | -------: |
| Frame         |        21.53 ms |       18.03 ms |    16.25% |     0.10 ms |    0.26% |
| CPU           |        19.00 ms |       16.20 ms |    14.74% |     0.30 ms |    0.87% |
| Commit        |        18.90 ms |       16.03 ms |    15.17% |     0.30 ms |    0.78% |
| Collision     |         6.87 ms |        6.77 ms |     1.46% |     0.10 ms |    0.70% |
| Surface apply |         3.80 ms |        0.57 ms |    85.09% |     0.10 ms |    8.32% |
| Upload        |         3.80 ms |        0.57 ms |    85.09% |     0.10 ms |    8.32% |
| Upload bytes  |       16.03 MiB |      64.02 KiB |    99.61% |         0 B |    0.00% |

Formal selection hash stable: true. Submitted glyph accounting: true. Three-run CPU/collision budget: true. Whole-frame budget: false. WebGL control stable: true.

## HarfBuzz worker SIMD decision

The [schema 1 artifact](results/shaping-simd-worker-1.2.0.json), SHA-256 `7f8ea0d5ffa6bde9ad91ee8bf6baaa04972d38cda60cb3eee7c5777117fddbb1`, measures five isolated scalar workers and five isolated SIMD workers across the CJKV, Arabic, Devanagari, Hebrew, and Thai corpora.

| Variant | Runs |     Mean | Exact output hash                                                  |
| ------- | ---: | -------: | ------------------------------------------------------------------ |
| Scalar  |    5 | 54.08 ms | `8773aedead11b28325a31e6aed9293cbd4b87e572951a6eb448b0be971308bdf` |
| SIMD    |    5 | 55.44 ms | `8773aedead11b28325a31e6aed9293cbd4b87e572951a6eb448b0be971308bdf` |

Decision: HOLD (variant-regression). SIMD changes the mean by 2.51% regression; the measured variance threshold is 1.96 ms.
Package boundary: PAUSE (human-approval-required). Experimental assets remain opt-in and outside default package contents. The measured opt-in payload adds 408.86 KiB raw / 135.57 KiB gzip and 138.49 KiB to the packed tarball.

## GPU Scene v2 CPU and admission phases

| Renderer | Phase            | Visibility p50 | Visibility p95 | Preparation p50 | Preparation p95 | Coordinator p50 | Coordinator p95 | Surface p50 | Surface p95 | Inspected max | Materialized max | Shaped delta | Admitted total |       Heap |
| -------- | ---------------- | -------------: | -------------: | --------------: | --------------: | --------------: | --------------: | ----------: | ----------: | ------------: | ---------------: | -----------: | -------------: | ---------: |
| webgl    | camera           |        3.00 ms |        7.30 ms |        11.00 ms |        23.80 ms |         8.20 ms |        25.80 ms |    34.20 ms |    62.00 ms |             0 |                0 |    1,035,889 |              0 | 481.87 MiB |
| webgl    | positionMutation |        2.40 ms |        2.70 ms |        11.90 ms |        26.00 ms |        12.10 ms |       106.50 ms |    41.10 ms |    48.40 ms |             0 |                0 |    1,571,084 |              0 | 481.87 MiB |
| webgpu   | camera           |        0.00 ms |        0.00 ms |         8.00 ms |        13.00 ms |         0.50 ms |         9.60 ms |    43.70 ms |    59.90 ms |         2,048 |              340 |      161,739 |         27,977 | 442.04 MiB |
| webgpu   | positionMutation |        0.00 ms |        0.00 ms |         7.20 ms |         8.00 ms |         0.50 ms |         0.70 ms |     0.20 ms |    61.60 ms |         2,048 |                0 |        1,951 |              0 | 442.04 MiB |

## Collision CPU phases

| Renderer | Visibility p50 | Visibility p95 | Preparation p50 | Preparation p95 | Coordinator p50 | Coordinator p95 | Surface p50 | Surface p95 |
| -------- | -------------: | -------------: | --------------: | --------------: | --------------: | --------------: | ----------: | ----------: |
| webgl    |        4.80 ms |        7.00 ms |         0.10 ms |         0.30 ms |         0.10 ms |         0.20 ms |     0.70 ms |     1.90 ms |
| webgpu   |        5.60 ms |        7.80 ms |         0.10 ms |         0.30 ms |         0.00 ms |         0.30 ms |     0.30 ms |     0.60 ms |

## GPU timing capability

| Workload                   | Renderer | Method                          | Source        | Quality | Query samples | Valid | Fallback | Fused resolves | Timestamp standalone submits | GPU timestamp p95 | Completion wall p95 | Readback |
| -------------------------- | -------- | ------------------------------- | ------------- | ------- | ------------: | ----: | -------: | -------------: | ---------------------------: | ----------------: | ------------------: | -------- |
| gpu-scene-v2               | webgl    | ext-disjoint-timer-query-webgl2 | gpu-timestamp | valid   |           260 |   260 |        0 |              0 |                            0 |          24.49 ms |            29.50 ms | true     |
| gpu-scene-v2               | webgpu   | timestamp-query                 | gpu-timestamp | valid   |           260 |   260 |        0 |            260 |                            0 |          24.90 ms |            34.00 ms | true     |
| gpu-scene-heterogeneous-64 | webgpu   | timestamp-query                 | gpu-timestamp | valid   |           260 |   260 |        0 |            260 |                            0 |          11.99 ms |            14.10 ms | true     |
| gpu-scene-resident         | webgpu   | timestamp-query                 | gpu-timestamp | valid   |           260 |   260 |        0 |            260 |                            0 |           8.72 ms |            10.70 ms | true     |
| label-collision            | webgl    | ext-disjoint-timer-query-webgl2 | gpu-timestamp | valid   |           125 |   125 |        0 |              0 |                            0 |           8.82 ms |            14.50 ms | true     |
| label-collision            | webgpu   | timestamp-query                 | gpu-timestamp | valid   |           125 |   125 |        0 |            125 |                            0 |           5.05 ms |             6.90 ms | true     |

## Invariants

Every recorded boolean invariant passed.

## Raw artifacts

- [million-live](results/browser-million-live-1.2.0.json)
- [gpu-scene-v2/webgl](results/browser-gpu-scene-v2-webgl-candidate-1.2.0.json)
- [gpu-scene-v2/webgpu](results/browser-gpu-scene-v2-webgpu-candidate-1.2.0.json)
- [gpu-scene-heterogeneous-64/webgpu](results/browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0.json)
- [gpu-scene-resident/webgpu](results/browser-gpu-scene-resident-webgpu-candidate-1.2.0.json)
- [label-collision/webgl](results/browser-label-collision-webgl-candidate-1.2.0.json)
- [label-collision/webgpu](results/browser-label-collision-webgpu-candidate-1.2.0.json)
- [label-collision/webgpu active-scatter repeatability](results/browser-label-collision-webgpu-active-scatter-repeatability-1.2.0.json)
- [gpu-scene-resident/webgpu repeatability](results/browser-gpu-scene-resident-webgpu-repeatability-1.2.0.json)
- [gpu-scene-resident/webgpu canonical source](results/browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json.gz)
- [gpu-scene-resident/webgpu schema 4 promotion repeatability](results/browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json)
- [gpu-scene-resident/webgpu sustained 600](results/browser-gpu-scene-resident-webgpu-fastlane-fused-600-1.2.0.json.gz)
- [label-collision schema 2 repeatability](results/browser-label-collision-repeatability-1.2.0.json)
- [HarfBuzz worker SIMD decision](results/shaping-simd-worker-1.2.0.json)
