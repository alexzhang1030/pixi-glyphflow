# Heuristic optimization

`optimization: "auto"` is an opt-in coordinator for the existing precision, normalization, tone mapping, aggregation, Worker, and resolution mechanisms. Its objective is visual stability first, followed by the highest quality that fits the measured frame budget.

## Public contract

```ts
const heatmap = new HeatmapLayer({
  width,
  height,
  minZoom,
  maxZoom,
  optimization: "auto",
})

console.log(heatmap.optimizationProfile)
```

The default mode is `"manual"` and retains the existing option defaults. In auto mode, every explicit `maxIntensity`, `toneMapping`, `accumulationPrecision`, `aggregation`, `resolution`, or `worker` value remains authoritative.

## First heuristic profile

Auto mode supplies `maxIntensity: "auto"`, `toneMapping: "adaptive"`, and `accumulationPrecision: "high"` when those options are omitted. Renderer capability detection still chooses the supported accumulation format.

A bounded camera range of at least 8×, at most 160,000 active points, and a desktop-sized instance chunk selects the `wide-range-quality` profile:

- direct splats;
- fixed full accumulation resolution;
- one representation for the complete replacement dataset.

Other datasets select `adaptive-throughput`:

- radius-following aggregation;
- Worker auto-selection;
- frame-time adaptive resolution.

Replacement datasets re-evaluate the profile. Append streams retain their selected profile for the source lifetime. Explicit options override their individual decision while the remaining decisions stay automatic.

## Dynamic-range visibility

Adaptive tone mapping compares the current rendered peak with the geometric mean of positive source weights. The geometric mean makes one dominant hotspot visible in the ratio while one tiny noise value has limited influence.

The transfer curve keeps zero at zero, the peak at one, and preserves density ordering:

```text
mappedDensity = normalizedDensity ^ exponent
```

Dynamic-range compression begins smoothly at 16× and reaches full strength at 256×. The selected exponent targets `0.06` for the reference weight and stays within `[0.25, 1]`. `toneMapping: "linear"` fixes the exponent at `1`.

## Interaction stability

Auto mode observes the layer's global transform. Pan, zoom, and rotation extend a 200 ms interaction hold. Adaptive resolution collects new evidence after that hold, so a gesture renders through one accumulation scale and later quality changes occur in a stable window.

Configured `minZoom` and `maxZoom` also define the complete auto-normalization radius interval. Up to nine logarithmically spaced peak samples include both bounds and the current radius. Every radius inside that interval uses the stable interpolated trajectory during the gesture and settlement.

## Testing and evidence

- Unit tests cover validation, auto defaults, explicit overrides, profile thresholds, and replacement re-evaluation.
- Layer tests cover the interaction hold around adaptive resolution changes.
- The live Interaction example's pixi-viewport driver reports `{ mode: "auto", strategy: "wide-range-quality", accumulationPrecision: "high", maxIntensity: "auto", toneMapping: "adaptive", aggregation: false, resolution: 1, worker: "auto" }` on WebGL and WebGPU.
- A six-cycle rapid zoom run retains one resolution scale, `0` repeated-scale residual, `0` settling residual, and `0` settled-luma residual.
- A 56-frame one-way wheel gesture reaches the shared camera and heatmap maximum, then retains `0` settling residual and a complete normalization state for 60 frames.
- A synthetic `16,384:1` hotspot-to-weak-point fixture moves from `0/63` visible weak points to `63/63` on WebGL and WebGPU. Weak-point center alpha moves from `0` to `14`, while the hotspot remains at alpha `255`.
- With the public default gradient, minimum-zoom red share measures `0.90%` on WebGL and `0.78%` on WebGPU, inside the existing `3%` budget. The sampled field retains 59 WebGL color buckets and 92 WebGPU color buckets.
- The library build grows from 118.93 kB to 125.44 kB raw and from 27.84 kB to 29.21 kB gzip. The complete coordinator and tone mapping add 6.51 kB raw and 1.37 kB gzip.
- The rapid-zoom readback regression reports p95 frame time at `32.9 ms`, inside its prior `19.7–34.4 ms` run-to-run spread; this script includes pixel readback and serves as a relative guard.

## Direct interaction capacity

`scripts/profile-interactive-capacity.mjs` measures actual value-1 source records through the direct rendering path. Source point count, render point count, and GPU splat count must match. The uniform-world fixture uses an 8 px kernel and continuously pans while traversing `0.6×` through `6×`; every zoom frame rebuilds the screen-stable kernel field. Arguments eight and nine select a numeric or `adaptive` accumulation resolution and the kernel radius, so fill-rate experiments retain the same source and camera trace.

An early 4 px fixture reached a 0.67 accumulation-texel local radius at maximum zoom. Fragment coverage disappeared at that radius, producing an empty high-zoom field and understating GPU work. The 8 px fixture keeps a 1.33 texel minimum local radius and visibly populated frames across the complete trace. All capacity claims use this corrected fixture.

### WebGPU tiled direct density

`webgpuDensity: "auto"` evaluates a cost model from source points, accumulation pixels, and kernel samples. The 720×380, 8 px direct fixture crosses at 329,460 points. Compatible fields then use `src/intensity/webgpu/DensityAccelerator.ts`; WebGL and the WebGPU raster policy continue through `IntensityPass`.

The accelerator deposits every point across four adjacent accumulation-pixel centers with Cloud-in-Cell weights, then convolves 32×16 output tiles from a workgroup-shared halo. Bin workgroups reduce one shared base cell directly and use a bounded local hash for nearby cells, keeping global atomics stable for uniform and hotspot distributions. This converts the million-point zoom rebuild from one million blended quads into a bounded bin phase plus a screen-sized contiguous convolution. The plan validates storage sizes and dispatch dimensions against the active device before allocating resources.

Fresh 240-frame measurements on the Apple M1 Pro and native 120 Hz display use the same million-point, 720×380, 8 px, `0.6×`–`6×` mixed trace:

| Data | Backend / engine | Frame p95 | Dropped frames | Layer update p95 |
| --- | --- | ---: | ---: | ---: |
| static | WebGPU auto / tiled gather | 9.2 ms | 0.42% | 0.3 ms |
| static | WebGPU raster | 16.7 ms | 16.32% | 0.5 ms |
| static | WebGL raster | 17.0 ms | 18.83% | 0.3 ms |
| trusted dynamic | WebGPU auto / tiled gather | 9.2 ms | 0.84% | 0.6 ms |
| trusted dynamic | WebGPU raster | 16.7 ms | 20.50% | 0.7 ms |

The static auto run dispatched 238 compute rebuilds with zero fallbacks. The trusted dynamic run dispatched all 240 rebuilds, retained all 240 mapped-ring uploads, and kept ingestion plus layer update at 0.7 ms p95. A 120-frame `r32float` trace also measured 8.9 ms p95 with zero dropped frames.

A 60-frame million-point co-located hotspot trace measures 9.2 ms p95 with zero dropped frames through tiled gather. The matching WebGPU raster trace measures 92.1 ms p95. Workgroup-level base-cell reduction is the decisive hotspot path.

`scripts/check-webgpu-gather.mjs` compares the tiled and raster fields through an actual `r32float` WebGPU target. Its 300,000-point non-saturated fixture covers 204,800 active pixels and measures `0.2308/255` mean channel difference with a maximum channel difference of `6/255`. The balanced `r16float` path intentionally accumulates the grid in Float32 and packs once, avoiding the repeated binary16 blend loss modeled by the raster engine.

On an Apple M1 Pro with a 120 Hz display, 240-frame static traces measured:

| Points | Backend | Frame p95 | Dropped frames |
| ---: | --- | ---: | ---: |
| 500k | WebGL | 8.9 ms | 0% |
| 550k | WebGL | 9.3 ms | 2.93% |
| 1M | WebGL | 24.3 ms | 43.10% |
| 2M | WebGL | 34.0 ms | 91.60% |
| 4M | WebGL | 66.4 ms | 96.64% |
| 300k | WebGPU | 9.3 ms | 0% |
| 350k | WebGPU | 9.3 ms | 1.67% |
| 1M | WebGPU | 24.0 ms | 55.23% |
| 2M | WebGPU | 33.4 ms | 87.39% |
| 4M | WebGPU | 63.9 ms | 97.48% |

The pass criterion is p95 within 1.5 native display intervals and at most 1% dropped frames. Static native-120 Hz capacity is 500k on WebGL and 300k on WebGPU for this fixture. Main-thread work stays below 0.6 ms p95 at 2M, locating the static cliff in GPU accumulation work. Camera translation reuses the accumulated texture; zoom changes the local kernel radius and re-splats every source point.

Dynamic mode mutates every source coordinate, calls `setRaw()`, and performs the same mixed camera trace on every frame. The all-positive typed replacement fast path validates once, uses native `Float32Array.set()` for the complete copy, fills birth frames in bulk, and skips unit-weight logarithms.

| Dynamic points | Backend | Ingest median | Frame p95 | Dropped frames |
| ---: | --- | ---: | ---: | ---: |
| 300k | WebGL | 2.7 ms | 9.1 ms | 0.84% |
| 400k | WebGL | 3.6 ms | 9.3 ms | 3.77% |
| 500k | WebGL | 4.4 ms | 16.0 ms | 6.69% |
| 300k | WebGPU | 2.6 ms | 9.1 ms | 0% |
| 400k | WebGPU | 3.6 ms | 9.1 ms | 2.51% |
| 500k | WebGPU | 4.4 ms | 16.8 ms | 20.08% |

The measured native-120 Hz dynamic envelope is 300k on both backends. Pixi submits WebGPU vertex uploads through `queue.writeBuffer` inside `HeatmapLayer.update()`; WebGL defers its upload into the draw.

## Actual-record aggregate interaction capacity

`scripts/profile-aggregate-interaction.mjs` feeds every generated value-1 record through the public `addPoints()` API in reusable one-million-record batches. The source combines 75% uniform coverage with 25% clustered hotspots, occupying all 69,504 nodes while retaining a readable density range. The fixture uses `pointStorage: "aggregate"` with a 2 px Cloud-in-Cell grid, then performs the same 8 px, `0.6×`–`6×` mixed camera trace. `pointCount`, `totalWeight`, and processed loop iterations must equal the requested record count.

| Actual records | Backend | Preparation | End-to-end rate | GPU nodes | Frame p95 | Dropped frames |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 100M | WebGL | 2.07 s | 48.21M/s | 69,504 | 9.3 ms | 0% |
| 100M | WebGPU | 2.40 s | 41.71M/s | 69,504 | 8.9 ms | 0% |
| 1B | WebGL | 20.54 s | 48.70M/s | 69,504 | 8.9 ms | 0% |
| 1B | WebGPU | 23.32 s | 42.89M/s | 69,504 | 9.1 ms | 0% |

The reusable input batch occupies 11.44 MiB and the aggregate store occupies 3.84 MiB. Post-build camera cost follows the retained 69,504-node field, so the completed 100M and 1B datasets share the same interaction envelope. The live docs runner yields between 500,000-record batches and exposes 1M, 100M, and 1B targets with measured progress and ETA.

## Boundaries

- Always: keep decisions deterministic from public options, active point count, instance chunk size, transform activity, and frame-time samples.
- Review gate: any new heuristic signal or threshold requires measured browser evidence and an updated regression.
- Protected: explicit option values, gradient semantics, point values, and source ordering remain application-owned.

## Success criteria

1. The Interaction example reaches the same high-precision direct profile through `optimization: "auto"`.
2. Six rapid zoom round trips keep one accumulation resolution and zero repeated-scale residual.
3. WebGL and WebGPU minimum-zoom red share stays within the existing 3% budget.
4. Existing manual-mode tests preserve their behavior.
5. A dominant hotspot keeps at least 90% of the synthetic weak points visible on both GPU backends.

## Persistent aggregate storage profile

`pointStorage: "aggregate"` serves bounded append fields that value density preservation over source-coordinate retention. Every supplied input record enters a fixed Cloud-in-Cell grid. Retained work depends on layer bounds and cell size. Weighted records remain part of the public heatmap semantics, while capacity claims use the actual number of records processed.

### CPU ingestion optimization

Measurements run on an Apple M1 Pro with 10 CPU cores, 16 GPU cores, 32 GB memory, and local headless Chrome. `scripts/profile-persistent-grid.ts 1000000 2 12` uses one million deterministic records.

| Implementation | Add median | Flush median | Throughput | Retained CPU |
| --- | ---: | ---: | ---: | ---: |
| Direct writes into the master grid with repeated encoding checks | 63.20 ms | 0.46 ms | 15.82M records/s | 2.98 MiB |
| Removed the redundant per-node `Math.fround` range check | 60.10 ms | 0.46 ms | 16.64M records/s | 2.98 MiB |
| Transactional batch grid plus occupied-node merge | 26.10 ms | 0.26 ms | 38.32M records/s | 3.84 MiB |
| Typed-input validation reuses prior Float32 encoding | 16.95 ms | 0.25 ms | 58.94M records/s | 3.84 MiB |

The transactional path is retained. It validates and accumulates in one source pass, then merges about 18k occupied nodes into the Float64 master. `Float32Array` inputs reuse their completed encoding and check finiteness directly, saving three `Math.fround` calls per record. Two consecutive twelve-sample runs measured 16.92 ms and 16.97 ms medians. The current path cuts the original median by 73.2% and keeps rejected batches atomic. The extra 0.86 MiB is fixed by grid capacity.

Cell size 8 measured 23.97 ms at the same input size. Its modest CPU gain accompanies a 4× coarser spatial grid, so cell size remains a quality control chosen by the application.

### Backend upload and queue profile

`scripts/profile-flow-backends.mjs <backend> 5 1000000 <scenario>` separates CPU input, layer submission, accumulation completion, display submission, and display completion. The aggregate scenario appends one million deterministic records per sample.

| Scenario | Backend | Input median | Update submit | Explicit queue waits | Total |
| --- | --- | ---: | ---: | ---: | ---: |
| retained replacement | WebGL | 14.50 ms | 1.00 ms | 0.00 ms | 15.70 ms |
| retained replacement | WebGPU | 9.70 ms | 4.80 ms | 18.80 ms | 37.90 ms |
| persistent aggregate append | WebGL | 17.20 ms | 1.10 ms | 0.00 ms | 18.40 ms |
| persistent aggregate append | WebGPU | 18.50 ms | 1.20 ms | 13.30 ms | 33.30 ms |

Pixi's WebGPU buffer system calls `queue.writeBuffer` during `Buffer.update`, so the retained million-record replacement submits a 12 MB upload inside `HeatmapLayer.update()`. WebGL uploads during the later draw. Persistent storage submits retained nodes and reduces the measured WebGPU update phase from 4.80 ms to 1.20 ms. The explicit `onSubmittedWorkDone()` waits also include WebGPU queue scheduling and display pacing; ticker performance is measured separately. The seven-sample aggregate WebGPU total spans 29.50–40.70 ms while its input and update medians stay at 18.50 ms and 1.20 ms.

The retained WebGPU path now bypasses Pixi's large `writeBuffer` call. A four-slot mapped staging ring receives each dirty range directly from `PointStore`, and one copy-only submission transfers it into the stable vertex buffer before accumulation. The same one-million-point replacement profiler moves update submission from 4.80 ms to 0.60 ms median. Sustained 180-frame dynamic probes keep all uploads on the ring:

| Points | Layer update median | Layer update p95 | Ring uploads | Fallbacks | Full-frame p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500k | 0.40 ms | 0.50–0.60 ms | 180 | 0 | 9.00–16.10 ms |
| 1M | 0.50–0.60 ms | 0.70–1.00 ms | 179–180 | 0–1 | 17.20–25.00 ms |

`setRawTrusted()` borrows a reusable complete-triple source and accepts exact precomputed positive-weight statistics. The method updates source identity, tone mapping, optimization selection, and dirty coverage in O(1). The same 180-frame one-million-point WebGPU probe separates its input contracts:

| Replacement input | Ingestion median | Ingestion p95 | Ingestion + update median | Ingestion + update p95 | Main-thread work median |
| --- | ---: | ---: | ---: | ---: | ---: |
| validated `setRaw()` | 8.90 ms | 9.40 ms | 9.60 ms | 10.30 ms | 11.60 ms |
| trusted `setRawTrusted()` | 0.00 ms | 0.10 ms | 0.60 ms | 1.00 ms | 2.60 ms |

The trusted result clears the 1.5 ms p95 library-ingestion-plus-update budget. Source mutation remains application work at 1.90 ms median / 2.10 ms p95 for two wrapped coordinate writes across every record. The full interaction frame still rasterizes one million accumulation splats and measures 25.00 ms p95. Three adjacent trusted runs completed all 180 uploads on the mapped ring; the final verification run completed 179 there and used one 12 MB queue fallback while retaining a 0.70 ms p95.

### Accumulation raster profile

The one-million-point trusted replacement trace isolates fragment coverage as the remaining direct-path limit. At full resolution, a 2 px kernel measured 8.60 ms median / 16.80 ms p95, an 8 px kernel measured 16.00 ms median / 25.20 ms p95, and a 16 px kernel measured 24.10 ms median / 32.30 ms p95. Keeping the 8 px kernel and lowering accumulation resolution to 0.5× measured 16.60 ms median / 17.40 ms p95; 0.25× measured 15.90 ms median / 17.30 ms p95.

The accumulation field now stores density in a single red channel. `r16float` cuts a 1920×1080 balanced target from 15.82 MiB to 3.96 MiB, while `r32float` cuts the high-precision target from 31.64 MiB to 7.91 MiB. The official [WebGPU format table](https://gpuweb.github.io/gpuweb/#plain-color-formats), [WebGL2 float color-buffer extension](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/), and [PixiJS format list](https://pixijs.download/dev/docs/rendering.TEXTURE_FORMATS.html) cover the selected formats. Both backends pass the dynamic-range and minimum-zoom color regressions with the single-channel targets. Three 180-frame WebGPU traces measured 24.30–25.00 ms direct frame p95. Three adjacent final 240-frame traces measured 16.70–16.80 ms p95, 0.70–0.80 ms ingestion-plus-update p95, and 240 mapped-ring uploads with zero fallbacks. The capacity claim retains the wider measured frame range.

A circumscribed octagon reduced candidate raster area by 17.2% and doubled vertices per instance. The 8 px trace stayed at 25.00 ms p95, while the 2 px trace moved from 16.80 ms to 25.00 ms p95; the four-vertex quad remains. Reassociating each vertex transform from matrix products to sequential matrix-vector products measured 24.30–25.00 ms p95, matching the original shader; the original expression remains.

The persistent-grid profiles remain ingestion and storage evidence. Direct capacity uses `scripts/profile-interactive-capacity.mjs`, actual value-1 records, exact source/splat equality, and native-refresh frame measurements. Aggregate-scale capacity uses `scripts/profile-aggregate-interaction.mjs`, actual unit-record loops, exact processed/source/weight equality, bounded retained nodes, and the same camera trace.

### Review gates

- Keep capacity target labels tied to actual records processed by the public API.
- Require direct benchmark source count and render splat count to equal the target.
- Keep persistent storage memory bounded by dimensions and cell size.
- Run the direct CLI profiler and aggregate browser contract on WebGL and WebGPU after changes to input, buffers, accumulation, camera tracking, or benchmark code.
- Re-run the interactive-capacity and persistent-grid profilers and record measured deltas before retaining another performance optimization.
