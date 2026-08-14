# Gotchas

Traps already paid for, each with its why. Most are Pixi v8 / browser-GPU edge cases this library hits.

## Multiple Pixi apps on one page: `app.destroy(true)` poisons the others

Pixi 8's `renderer.destroy(true)` calls `GlobalResourceRegistry.release()`, which destroys the **globally shared** batch pool. Any other live `Application` on the page keeps `_batch` pointers into those destroyed batches and crashes on its next render (`Cannot read properties of null`). Always destroy with `app.destroy({ removeView: true }, { children: true })` — kills the renderer and preserves the global pool for the other live docs demos.

## `Shader.from()` programs are shared across every layer

Pixi caches `GlProgram` and `GpuProgram` by shader source. `Shader.destroy(true)` destroys those shared program objects, so removing one `HeatmapLayer` breaks every surviving layer with `Cannot read properties of null (reading 'aPosition')`. `IntensityPass` and `DecayPass` own their shader instances and bind groups while the cached programs stay process-wide; their cleanup uses `shader.destroy()`. `tests/lifecycle.test.ts` verifies that destroying one layer keeps both programs live for another.

## Render-target resize must rebind display resources before destroying old sources

Pixi bind groups subscribe to every bound texture source and sampler. Destroying a source synchronously destroys its subscribed bind group, so `_resizeTargets()` creates and binds the new front target before destroying the old one. The decay pass may still sample either ping-pong target; resize recreates that pass. `tests/lifecycle.test.ts` covers both the plain and decay paths, including the direct colorize mesh's resized geometry.

## Pixi 8.19 WebGPU hardcodes pipeline color format to `bgra8unorm`

`GpuStateSystem.getColorTargets` ignores the active render target's format and the pipeline cache key excludes it. Rendering into an `r16float` RT produces invalid command buffers that Dawn **silently drops** — no console error, just nothing rendered. Fixed per-renderer-instance in `src/webgpu-pipeline-format.ts` (`ensureWebgpuPipelineFormats`): the adaptor records the active target format, `getColorTargets` uses it, cache nests per format. Startup validates the private renderer shape tested with PixiJS 8.19 and raises a targeted compatibility error when that shape changes. An upstream format-aware cache makes the shim removable.

## Instance chunks balance driver safety, draw calls, and memory

`maxVertexBufferArrayStride` limits attribute `offset`, so byte offsets into one master buffer fail pipeline creation on WebGPU once they exceed 2048. Each chunk owns a vertex buffer with attribute offsets 0/8. Desktop capacity grows geometrically to 1,048,576 instances per chunk, keeping one million direct splats in one accumulation draw. On the M1 Pro browser probe, this change reduced the 1.25M mixed zoom/pan dropped-frame ratio from 10.06–11.73% to 6.15–6.70% on WebGL and from 8.94–18.99% to 7.26–9.50% on WebGPU across three runs. iOS stays at 512 because affected WebKit drivers drop larger instanced draws. A fourfold count reduction shrinks the active buffer, and excess chunks retire with one spare at most (`src/intensity/IntensityPass.ts`).

## Nitro's archiver chain needs the patched brace expansion

Nuxt 4.5 currently reaches `brace-expansion@2.1.2` through `nitropack → archiver@7 → minimatch`, which triggers `GHSA-mh99-v99m-4gvg`. pnpm's audit repair pins every vulnerable range to `brace-expansion@^5.0.8`; `minimumReleaseAgeExclude` admits that urgent patch immediately. Keep the override until Nitro adopts an Archiver release whose own dependency tree resolves to the patched line. The docs toolchain already requires Node 20.19+ or 22.12+, satisfying brace-expansion 5's engine.

`pnpm/action-setup` reads the exact `pnpm@11.17.0` version from package.json. Its workflow step leaves `version` unset; declaring a second major-only value makes the action stop before dependency installation with “Multiple versions of pnpm specified.”

## Browser probes use demo-specific hooks

The docs page runs independent Pixi applications. `window.__hm` owns the Interaction map and exposes its current Manual or pixi-viewport camera; `window.__aggregateCapacity` owns the aggregate-scale probe and hosts CLI capacity layers. Browser checks scope controls and stats to the matching section, then wait for the hook's renderer and driver to confirm initialization. Dynamic-range verification creates its probe layer inside the Interaction renderer, and pixel readback waits for a populated RT.

## Pixi's WebGPU declarations overlap TypeScript 6 and 7

PixiJS 8.19 depends on `@webgpu/types`, while TypeScript 6 and 7 also ship WebGPU globals in `lib.dom`; a consumer with full dependency declaration checking sees duplicate `GPU*` identifiers before reaching pixi-heatmap's declarations. TypeScript 5.9 validates the published tarball with full library checks. TypeScript 6/7 projects use `skipLibCheck: true`, matching this repository's `tsconfig.json`, until Pixi's declaration dependency converges with the built-in DOM types.

## Headless-Chrome GPU readback lies

- `extract.pixels` on an `r16float` RT or a WebGPU canvas returns all zeros (compositor/readback paths), even when the render is correct. Verify output via `extract.base64` → decode through an `Image` + 2d canvas instead.
- Screenshots of GPU canvases in headless Chrome can be blank with `preserveDrawingBuffer: false` — same reason. Never conclude "renders nothing" from a blank screenshot alone.

## A direct colorize mesh removes the filter capture draw

Pixi's filter system captures its input before running a custom filter, which adds a display draw. `HeatmapLayer` uses `ColorizeMesh`: a layer-sized quad samples the accumulation RT directly in local UVs, so transforms, clipping, tint, and alpha stay in the normal scene graph while the display costs one draw. The mesh starts non-renderable until the first accumulation target is bound, preventing its bootstrap `Texture.WHITE` from painting a false field before the first `update()`. `clear()` and exhausted decay history hide it again. The exported `ColorizeFilter` remains useful for external filter composition; its screen-clipped frame requires `calculateSpriteMatrix()` to map filter UVs back into the bound intensity texture.

`renderer.extract.canvas(stage)` renders the stage's bounds, so transform verification uses a same-task `app.render()` plus screen readback or screenshots. Headless half-float readback follows the caveat below.

## `decay` option is the fraction LOST per frame, not the retention factor
`options.decay = 0.02` means "remove 2% per frame" — the decay shader must multiply by `1 - decay`. Passing `decay` straight through as the multiplier wipes the field to ~2% every frame and looks exactly like random flickering. The semantic lives in `src/types.ts`; `HeatmapLayer._runDecay` does the inversion.

## A Mesh passed as the root of `renderer.render()` loses its blend mode

Pixi v8 consumes `blendMode` from a render group's **children**, not from the root node you hand to `renderer.render({ container })`. Our incremental splats rendered the staging mesh directly as root → every render ran with blending **off** (replace semantics) instead of `"add"`, so each batch overwrote the previous one inside its own footprint: G (flat weight) stayed ≥ 1 and looked fine, R (`k²·w`) collapsed to the latest batch — the "flickering mouse trail". Fixed by wrapping the staging mesh in a container (`IntensityPass.stagingRoot`). Tell-tale signature: instancing accumulates within one draw call but separate `renderer.render` calls into the same RT don't. Diagnose by reading raw RT floats (bind the GL framebuffer from `renderer.renderTarget.getGpuRenderTarget(...)` and `readPixels` with `RGBA/FLOAT`; `extract.pixels` can't read half-float). (Cost: a full day of false leads — decay, workers, half-float blending — before the A/B isolation.)

## A parented Mesh rendered directly (or via its parent) can no-op on WebGPU

The decay pass once became a child of a shared "frame" container (to fuse the frame into one `renderer.render()`). On WebGPU its draw then silently did nothing — while `clear: true` still wiped the ping-pong target every frame, so the trail collapsed to the latest splat. The same structure renders fine on WebGL, and the same mesh unparented works on both. Lesson: keep render roots stable and unparented; per-frame `renderer.render()` targets must own their containers. (Found by bisect: fused decay+staging, decay-as-child, decay-as-root-but-parented all failed on WebGPU only; unparenting restored the comet trail. Root cause inside pixi's render-group/transform path was not further isolated — the structural rule is what we rely on.)

## Worker requests need immutable identity and owner-held coverage

The previous latest-wins bridge paired an in-flight result with a newer callback, advancing the aggregation cursor past untouched points. A later lazy pending factory mixed an older cell-size closure with the current store and epoch. The current contract lives across `HeatmapLayer` and `WorkerAggregator`:

- `WorkerAggregator` owns one in-flight request and copies its source range into one transferable buffer during `submit()`. Radius-following raw snapshots use the direct path, centroid jobs compact within input-sized capacity, and continuous jobs reserve twice the source capacity and move their raw blend backward before writing grid nodes.
- Every immutable request captures `kind`, `start`, `end`, generation, source identity, configuration key, strategy, cell size, and bounds.
- `HeatmapLayer` owns desired and covered ends. A busy bridge returns `false`, leaving the desired end ready for submission after the current result lands.
- Completion and frame-boundary application require generation, source identity, and configuration key to match current state for synchronized results. A complete continuous result from the current source may serve as a render-only zoom intermediate while a radius-following replacement is pending; append, fixed-cell, resized, and partial results retain strict configuration matching.
- `coveredEnd < desiredEnd` schedules the remaining tail. `tests/worker-integration.test.ts` pins an append arriving during an initial full job and a cell-size change arriving during a zoom job.
- Pending results between frames use a queue so multiple synchronous completions retain their own buffers and metadata.
- The sync fallback copies shared scratch output into a bounded result pool before queueing.

Transfer buffers use best-fit reuse under a 64 MiB total retention cap. Inline results use a four-buffer best-fit pool.

## Incremental centroid batches use bounded full rebases

Two points in one cell form one centroid in a full aggregation and two splats when they arrive in separate append batches. Immediate append splats preserve streaming responsiveness. A full aggregation atomically replaces the field after 500 ms of input idle, 32 append batches, a 5% tail of at least 1,024 points, or a five-second maximum interval. This policy gives the same settled output for the same source sequence across batch boundaries and bounds full rebuild frequency for 10 Hz streams. `tests/worker-integration.test.ts` pins the idle and batch-pressure paths.

## Direct append uploads stay in staging until a rebuild

Pixi `Buffer.update(size)` uploads from byte zero because this path has no destination offset. Updating a 500k-point master chunk for one tail point therefore uploads the complete prefix. Stable direct append frames now stage the dirty tail only and mark master instance buffers stale. Radius, resize, normalization, and replacement rebuilds synchronize the complete master buffer once from `PointStore`; `tests/lifecycle.test.ts` pins this transition.

## Replacing `Buffer.data` costs more than copying into stable storage

Binding each master chunk directly to the current `PointStore` view removes one JavaScript `Float32Array.set()`, while assigning `Buffer.data` also invalidates Pixi's buffer resource state. A 1M dynamic mixed-interaction probe raised WebGPU layer-update median from 4.7 ms to 8.7 ms and frame p95 from 17.3 ms to 25.1 ms. Restoring the long-lived vertex arrays returned two repeated runs to 4.7–4.8 ms update and 17.2–17.4 ms frame p95. Keep master `Buffer.data` identity stable across replacement frames.

## WebGPU staging slots need a copy-only submission

PixiJS 8.19 sends a complete dirty buffer through one `queue.writeBuffer()` call. A one-million-point retained replacement uploads 12 MB and measured 4.80–5.30 ms inside `HeatmapLayer.update()` on the Apple M1 Pro.

The [WebGPU buffer-mapping explainer](https://gpuweb.github.io/gpuweb/explainer/#buffer-mapping) recommends a rolling list of mapped staging buffers for per-frame uploads. Dawn Wire routes uploads at or above 4 MiB through its large-transfer path (`kWriteXLThreshold`) in [`Queue.cpp`](https://dawn.googlesource.com/dawn/+/f3061c6b07e60059c7f970545e54691d97a1a43c/src/dawn/wire/client/Queue.cpp), which places this 12 MB instance buffer squarely in that path.

`IntensityPass` now writes directly from the retained point source into a four-slot `MAP_WRITE | COPY_SRC` ring, then copies into its stable `VERTEX | COPY_DST` buffers. A same-command-buffer trial placed the copy before the splat render pass and produced a 1M sustained-update p95 of 4.5 ms: slot remapping waited on the long accumulation command buffer and repeatedly reached the fallback path. A separate copy-only submission lets mapping complete after the staging copy. The 180-frame dynamic probes recorded:

| Points | Update median | Update p95 | Ring uploads | Fallbacks |
| ---: | ---: | ---: | ---: | ---: |
| 500k | 0.40 ms | 0.50–0.60 ms | 180 | 0 |
| 1M | 0.50–0.60 ms | 0.80–0.90 ms | 180 | 0 |

The Pixi CPU arrays remain stable for resource identity and WebGL uploads. WebGPU treats the final GPU buffers as authoritative, disables their automatic resource GC, and destroys them through `IntensityPass`. `tests/webgpu-staging-uploader.test.ts` pins copy ranges, four-slot capacity, remapping, and bounded fallback. `scripts/profile-interactive-capacity.mjs` reports ring and fallback counts beside frame metrics.

## WebGPU density compute needs a tiled screen grid

The first compute prototype binned point indices into linked cells, then let every output pixel walk overlapping linked lists. A one-million-point mixed trace measured 33.4 ms median, 106 ms p95, and 71.5% dropped frames because neighboring invocations repeatedly followed random storage-buffer links.

The retained path first checks whether one 256-point bin workgroup shares a base cell and reduces its four Cloud-in-Cell components through a shared-memory tree. Other workgroups use a 256-slot, eight-probe local hash before sending residual contributions to the padded Float32 atomic grid. This changes a million co-located points from a GPU stall into a 9.2 ms p95 mixed trace; the matching raster trace measures 92.1 ms.

Each 16×16 gather workgroup computes a 32×16 output tile from a 64×48 shared-memory region, turning the convolution reads into contiguous workgroup loads. The fixed 16-pixel halo consumes 12 KiB and stays within the WebGPU minimum workgroup-storage limit. Radius and device-limit planning route unsupported frames through the Pixi raster engine.

WGSL reserves identifiers including `target` and `active` in current browser compilers. Using them for a uniform member and a local flag made pipeline creation fail and left the copied field blank. The implementation uses `outputSize` and `hasContribution`, and scoped WebGPU validation errors disable the accelerator for the following frame.

The compute grid sums in Float32 and writes `r16float` through one final `pack2x16float`. This preserves more density than repeated additive blending into an `r16float` render target. Snapshot identity includes the selected density engine, and auto normalization uses the mathematical Float32 estimator for tiled gather. `scripts/check-webgpu-gather.mjs` pins `r32float` spatial equivalence; the balanced-path smoke run pins a populated `r16float` result.

## Colorization exposes summed density

The earlier mean mode divided `R = k² × value` by `G = value`, producing `1` at the center of every isolated point and adding denominator weight across the square quad. The public mode exposes summed density exclusively. The single-channel accumulation target carries `R = Σ(k² × value)`, and colorization reads R.

## Generation stamps must wrap inside the `Int32Array` domain

Aggregation scratch stamps live in `Int32Array`, while JavaScript counters continue past signed 32-bit range. Comparing `2147483648` to the stored `-2147483648` makes every repeated cell look vacant within that call and duplicates output cells. `nextScratchGeneration()` clears stamps and returns to generation 1 before the signed wrap; `tests/aggregate.test.ts` pins the boundary.

## Measuring "flicker": separate the driver from the library

Three measurement artifacts cost real time during the trail-flicker hunt: the playground demo itself cleared the field every 600 frames (a built-in blink that poisoned every metric); whole-canvas brightness of a decaying trail oscillates with the driver period (125 Hz interval vs 120 fps rAF beat, plus decay geometry) — it is not library flicker; and 8-bit canvas alpha quantizes small per-frame changes into apparent pulsing. Verify accumulation numerically at the RT, not by eyeballing canvas brightness.

## Auto max-intensity must use the splat kernel, not raw weights

`estimateMaxIntensity` summing raw weights over radius-sized neighborhoods overestimates the true peak ~3–4× (the kernel `K(t)=max(0,1-t²)²` weights neighbors down). Normalized against that, everything but the hottest cell cores falls under the LUT alpha threshold → the heatmap renders as a mosaic of grid cells. Fixed-grid taps also make the estimate depend on translation across cell boundaries. The estimator kernel-weights neighbors like the GPU splat, evaluates actual splat coordinates, and refines the strongest candidate modes (`src/data/aggregate.ts`).

The rendered `r16float` peak can sit below the mathematical kernel sum once repeated fractional additions reach a binary16 precision step. The estimator samples the strongest modes at accumulation-pixel centers and applies the per-add float16 conversion in source order after accumulation scaling. The `r8unorm` estimator applies per-add 8-bit quantization and clamping with the same weight scale used by the splat shader.

## Peak normalization can hide valid weak density

A field with one weight-`16,384` hotspot and 63 separated weight-`1` points maps every weak center below the first visible LUT sample under linear peak normalization. The WebGL baseline showed `0/63` visible weak points while the hotspot remained fully visible.

`optimization: "auto"` supplies adaptive tone mapping. It uses the geometric mean of positive source weights as the reference, starts compression smoothly at a 16× peak ratio, and applies a bounded power exponent in the colorize pass. The same fixture shows `63/63` weak points on WebGL and WebGPU with center alpha `14`; the hotspot keeps alpha `255`. One tiny noise weight among otherwise uniform data leaves the exponent at `1`. `scripts/check-dynamic-range.mjs` pins the visibility and hotspot budgets on both backends.

## Zoom-stream auto max needs a stable refined-estimate anchor

The true kernel peak changes with radius according to the point distribution. Chaining predictions from the current max lets an intermediate zoom redefine later predictions; revisiting the original radius then produces a different domain and visible color pulsing. Each final cache entry carries the full render-snapshot key: source version, generation, aggregation config/effective strategy, covered end, dimensions, resolution scale, and accumulation format. Confirmed final samples also enter a source-scoped zoom trajectory spanning same-source aggregation LOD keys. A same-source zoom intermediate consumes the trajectory and receives transient normalization. Aggregated layers estimate from the retained aggregation result because raw source points describe a different splat field.

Small calibrated sources evaluate the current radius directly during bounded zoom. The exact path requires `_autoMaxAnchorSnapshotKey` to match the current snapshot key. Replacement and append mutations clear that anchor, preserving the previous domain through the mutation frame and recalibrating at the 150 ms zoom-settlement boundary. `tests/auto-zoom.test.ts` pins both replacement directions and the append path.

A single r² anchor overestimates growing-radius peaks on finite and path-like map structure. In the historical 9,367-point fixture, radius `923.46` produced a predicted max of `3517.51` and an exact max of `294.70`; the inflated domain faded the layer to gray during the gesture. Unbounded layers seed the radius cache with exact peaks at `0.25×`, `0.5×`, `1×`, `2×`, and `4×` radius, then use the closest cached pair for bounded log-log prediction. Bounded layers cover `radius / maxZoom` through `radius / minZoom` with up to nine logarithmically spaced samples including both endpoints and the current radius. Clamp interpolation exponent to `[0, 2]`, its lower edge to the strongest splat, and its upper edge to total positive splat weight. Full Worker jobs return the selected sample set with the aggregation result; frame-boundary application performs sample installation.

Local five-radius calibration covers a 16× radius span. The Interaction camera covers about `133.3×`, so an extreme zoom reached its bound through extrapolation and installed a refined correction after the gesture. The 2026-07-29 screen recording held `zoom 14.96×` while red-pixel share stayed at `0` through `5.2 s`, then jumped to `1.51%` at `5.3 s` and settled at `1.88%`; the update metric simultaneously carried a `9.47 ms → 1.97 ms → 0.41 ms` calibration tail. The headless extreme wheel trace measured a `0.302` auto-normalization pulse and zero settling residual with fixed max. Full-range bounded calibration makes in-range interpolation authoritative, aligns the Interaction heatmap bounds with both camera drivers, and produces zero settling residual with normalization complete at the maximum bound. `scripts/check-viewport-zoom-flicker.mjs` retains the round-trip path and adds configurable one-way gesture length, settlement length, and wheel delta; `docs:check-viewport-zoom-extremes` reaches the configured maximum.

Snapshot-only prediction initially reset the zoom curve whenever continuous aggregation produced a new LOD key. The pixi-viewport regression then measured adjacent-frame pulses of `0.591` and `0.411`. Reusing confirmed final samples through the source trajectory, computing only the current-radius peak for zoom replacement jobs, and easing the matching final correction reduces repeated runs to `0.0765–0.0811` under the `0.085` budget. Stable full jobs seed the local or bounded calibration set selected by the layer options. Intermediate results remain transient and never enter either confirmed cache.

Refined corrections can move the whole LUT domain in one frame. Float accumulation targets ease corrections above 0.1% over a 120 ms log-space smoothstep; each frame stays multiplicatively close. `r8unorm` keeps immediate correction because changing its normalization also requires a complete re-splat. On the historical 12,247-point fixture, fit and minimum zoom normalize at `1024` against WebGL accumulation peaks `1029` and `1036`; both WebGL and WebGPU retain the red LUT endpoint. `tests/auto-zoom.test.ts` pins calibrated unseen radii, physical bounds, overlap recovery, cached round trips, and the refined-domain transition.

## Zoom tracking reads the current global transform

Pixi refreshes `worldTransform` during render traversal, so a prerender listener can observe the previous frame after its parent scale changes. `HeatmapLayer` reads parented transforms through `getGlobalTransform()` before deriving zoom, which synchronizes the effective radius and re-splat on the first rendered frame. The default aggregation cell follows `effectiveRadius / 4`; its zoom rebuild runs at 16 ms frame cadence. Worker backpressure leaves the current request immutable while the layer retains the desired cell size. A complete continuous result with matching generation and source identity can replace the render master as an intermediate LOD during that wait. Append results retain strict configuration matching. The matching configuration result completes synchronization and installs the final snapshot calibration. Worker integration tests pin configuration identity and final-frame convergence.

Holding the previous accumulation texture through a continuous zoom scales its old kernel with the viewport. The replacement frame then restores the screen-stable kernel and can create a large luminance pulse. The historical 16,385-point fixture measured `0.3612` for this transition. Re-splatting the complete master at the live radius reduces the measured pulse to `0.0334` while preserving immutable worker identity.

Auto zoom derives one scalar from the transformed local x-axis. Uniform scale plus rotation preserves circular kernels and matches pixi-viewport. Non-uniform scale and skew require anisotropic radius support for screen-space circularity; current compensation follows that x-axis scalar.

## Radius-following centroid bins jump at cell boundaries

Hard centroid bins map each point through `floor(position / cellSize)`. A continuously changing cell size can split or merge many bins in one frame, moving their weighted centroids discretely. The visual regression fixture crosses one shared boundary by changing zoom from `0.99999` to `1.0`; the hard source changed from 190 to 380 splats and produced a `0.7086` frame residual.

Radius-following datasets up to 12,000 active points retain raw splats throughout zoom and use the direct staging path. A count smoothstep from 12,000 to 20,000 supplies a minimum raw component while larger datasets use bilinear weights over four surrounding grid nodes. Occupied-node compression supplies the second transition signal. Raw and grid components below 1% are omitted, so the transition avoids a full-source instance jump at the first nonzero raw contribution. Generation-stamped dense grids cover bounded pixel worlds; a full-coordinate sparse hash keeps aggregation active when outliers exceed those bounds. Results report their effective strategy, and an effective raw snapshot is reused through later zoom changes.

A full-bounds theoretical ratio made the clustered 149,994-point viewport source enter the raw blend while its occupied grid still compressed strongly; reverse zoom then crossed between fields with very different half-float peaks. Occupied-node blending and same-source intermediate LODs keep aggregate luminance continuous, yet repeated rapid reversals expose timing-dependent spatial fields: the same viewport scale reached a `0.1242` sampled pixel residual across cycles. A 10% post-gesture cell-size step produced `0.1418` spatial residual for the continuous grid and `0.1392` for weighted centroids. Worker completion timing therefore remains visible when a wide-range interactive camera repeatedly changes radius-following aggregation grids.

The Interaction example enables `optimization: "auto"` for both camera drivers. Its shared `0.6×` through `80×` fit-scale camera and heatmap range and 149,994-point desktop source select `wide-range-quality`, preserving one exact representation with direct splats and resolution `1` across the full camera gesture. A pre-commit six-cycle run allowed adaptive resolution to step from `1` to `0.85` and raised same-scale residual to `0.0434`; the selected profile keeps one scale through the gesture. `scripts/check-viewport-zoom-flicker.mjs` drives six consecutive 14-frame zoom-in/zoom-out cycles through the pixi-viewport wheel plugin, compares every repeated scale in pixel space, enforces a `0.02` residual budget, and requires one resolution scale. The auto-selected direct path measures `0` repeated-scale and settling residual, keeps at least 6,464 sampled pixels active, and returns exactly to its baseline field. The one-way extreme path drives 56 zoom frames to the shared maximum, observes 60 settlement frames, and requires zero post-gesture field movement and complete normalization. `scripts/check-interaction-drivers.mjs` pins both driver contracts. Unit and integration suites retain aggregation and Worker coverage. The reverted `f42f8d4` dual-texture experiment displayed adjacent aggregation grids together for 80 ms and amplified the movement as ghosted contours.

An earlier half-float trial placed about one quarter of the NYC viewport source's visible heat pixels in the default gradient's yellow-to-red tail at fit and minimum zoom (`25.48%` and `25.46%`). The half-float target stored a true red-channel maximum of `129` while its calibrated domain encoded to `128`; a broad Manhattan region also landed on `128`, creating the flat red plateau. Power-of-two accumulation scales from `0.125` through `4` preserved the normalized field, and palette-only trials moved the plateau between colors.

The Interaction example requests `r32float` through the `wide-range-quality` profile's high-precision default. WebGL requires `EXT_float_blend` and `OES_texture_float_linear`; WebGPU requires `float32-blendable` plus `float32-filterable`. The float32 estimator measures this source near `18,879`. The example starts with the public default gradient and lets each non-zero stop update through `setGradient()`. Random palettes use OKLCH lightness steps, clamp chroma to the sRGB gamut, and feed native color inputs as hex. `scripts/check-interaction-palette.mjs` pins the default, edit, randomize, reset, accessibility-label, instance-reuse, and 320 px layout contracts. `scripts/check-viewport-min-zoom-colors.mjs` covers both backends, requires `r32float`, keeps at least eight red pixels, caps red share at `3%`, and requires at least 20 quantized color buckets. Current minimum-zoom red share measures `0.90%` on WebGL and `0.78%` on WebGPU, with 59 and 92 color buckets. The six-cycle rapid-zoom regression retains zero repeated-scale and settling residual.

The palette preview fixes its gradient background to `no-repeat` with a `border-box` origin. Chromium's default background tiling samples the 100% red endpoint into the rounded 0% cap, producing a one-pixel red seam. The default `padding-box` origin leaves the right border cap outside the gradient at high pixel density. `scripts/check-interaction-palette.mjs` requires both computed properties.

Extreme zoom-out can expand the effective local radius and its derived aggregation cell until separate regions merge. Configure `minZoom` to cap that growth; `maxZoom` provides the matching upper bound for zoom-in. The clamp applies to the heatmap's effective zoom, while the viewport keeps its own visual scale range.

## Target resize switches on a populated replacement frame

`_resizeTargets()` binds a freshly created accumulation texture to the colorize mesh. An aggregation replacement may still be preparing its master splat buffers at that moment. Adaptive scaling and public `resize()` keep the populated target bound through the wait, then create and fill the resized target during the completed replacement frame. `tests/worker-integration.test.ts` pins the target identity across the wait and its switch on the full-splat render.

## r16float fractional additions plateau at binary16 precision steps

Binary16 spacing grows with magnitude. On the historical 12,247-point raw source, every instance reaches the GPU while the accumulation texture plateaus at `R ≈ 1030`; the mathematical R peak grows from `4947` at fit zoom to `8269` at minimum zoom. Normalizing against the mathematical value removes the red endpoint even though the stored field remains populated. Format-aware auto-intensity models the candidate pixel neighborhoods in source order and maps the LUT to the stored peak. This keeps the stable raw splat source and its zero transition residual through the zoom gesture.

## r16float accumulation uses a finite safety scale

The half-float RT represents finite values through `65,504`. `HeatmapLayer` derives a power-of-two scale from the current snapshot's total positive weight and keeps its upper bound at `32,752`. The splat shader multiplies every contribution by that scale, and colorization multiplies the normalization domain by the same value. Legal Float32 point weights and aggregated cells therefore remain finite. `tests/auto-zoom.test.ts` pins a `70,000`-weight point.

## r8unorm fallback models per-add quantization

Eight-bit accumulation quantizes after each blend. A mathematical auto max of `1,000` previously produced a per-point scale of `0.001`, below one `1/255` step, so repeated weight-1 splats could remain zero. The fallback now gives the smallest positive snapshot contribution more than one quantization step, simulates every quantized/clamped addition, and normalizes against that represented peak. High dynamic ranges saturate into a visible degraded field. `tests/aggregate.test.ts` and `tests/auto-zoom.test.ts` pin 1,000 coincident contributions.

## Point storage must match the update shape

Retained `setPoints` and `setRaw` replacements bump source identity and aggregation generation. Synchronous per-frame aggregation uses `worker: false`, because a Worker result lands after the next replacement owns a new identity. Append streams use `addPoint` or `addPoints` and retain source identity.

`setRawTrusted` serves high-frequency complete replacements from a reusable `Float32Array`. The caller guarantees finite Float32 coordinates, strictly positive finite Float32 weights, and exact positive-weight statistics. The layer borrows the array through rebuilds and adopts each mutation through a new trusted call. Retained storage with decay 0 keeps ingestion O(1); later validated writes detach into layer-owned storage.

`pointStorage: "aggregate"` folds each typed batch into a fixed Cloud-in-Cell grid on the calling thread. Bounded append fields use `addPoints`; moving fields replace the grid through `setRaw`. The storage fixes width, height, and cell size for its lifetime, ignores out-of-bounds contributions, and requires a new layer for different dimensions.

## Capacity counters must describe executed records

The direct CLI capacity profiler gives every record value 1 and disables aggregation, so source count, total weight, and render splat count equal the selected target. Static mode retains the source; Dynamic mode mutates and replaces the complete source every frame.

The aggregate-scale probe also gives every record value 1 and invokes `addPoints()` for every generated record. Its processed record count, `pointCount`, and `totalWeight` equal the selected 1M, 100M, or 1B target; `renderPointCount` reports the fixed-grid nodes that preserve those contributions. Reusing one input batch bounds preparation memory and still performs every public-API record iteration. Browser and CLI verification pin these count identities, populated camera motion, finite metrics, and the requested WebGL or WebGPU backend.

## WebGPU benchmark startup owns an explicit device and a populated first frame

Pixi's scalar renderer preference can silently fall through to another backend, and a visibility observer stops a demo ticker before its first intersection callback. The docs request a high-performance WebGPU adapter/device with every supported float32 feature, pass an exact one-entry renderer preference, and expose the renderer that actually initialized. The capacity benchmark prepares its first complete field before measurement and then binds visibility throttling. Initialization failures surface their reason and recover through a visible WebGL renderer; a later `device.lost` event selects WebGL and rebuilds the benchmark. `scripts/check-aggregate-capacity.mjs` screenshots the user-visible canvas and directly detects an empty presentation surface.

## Update-time metrics keep two decimal places

Interaction and aggregate capacity render update time with `toFixed(2)`, including the zero state as `0.00 ms update`. The fixed precision keeps the metric width stable when an idle frame moves between zero and a measured fractional value. `scripts/check-update-metric-format.mjs` verifies both browser-visible labels.

## Manual view anchors live in parent coordinates

`zoomTo` / `zoomBy` and `rotateTo` / `rotateBy` preserve the local point beneath an anchor expressed in the layer parent's coordinates. A layer attached directly to `app.stage` therefore accepts canvas coordinates. Nested scenes convert pointer coordinates through the parent before calling the helper. `setZoom` controls kernel compensation; the view helpers control Pixi position, scale, and rotation.

## Toolchain traps

- pnpm 11: `onlyBuiltDependencies` was replaced by `allowBuilds` (map form) in `pnpm-workspace.yaml`; the old key is silently ignored and every `pnpm run` dies in the pre-run deps check with `ERR_PNPM_IGNORED_BUILDS`.
- tsdown + TypeScript 7: default dts generation calls the tsc programmatic API, which TS 7 doesn't have → `dts: { oxc: true }` required.
- oxfmt rewrites type syntax (`(() => void) | null` → `() => void | null`, collapses `;` in inline object types) — use named type aliases in positions it mangles.
- Node 26 can surface its `--localstorage-file` `ExperimentalWarning` as an SSR console error. Browser probes use `collectBrowserErrors()` to ignore that specific runtime warning while retaining application console errors and page errors. `tests/browser-script.test.ts` pins both warning generations and actionable-error retention.

## Twoslash in Nuxt docs

- `twoslashOptions.compilerOptions.lib` does **not** accept tsconfig-style short names (`'dom'`, `'esnext'`) — @typescript/vfs cannot map them to `lib.*.d.ts` files and every DOM global errors with TS 2584. Either omit `lib` (TS implies esnext+dom from `target`) or use full filenames (`'lib.dom.d.ts'`).
- twoslash needs the classic TypeScript compiler API — pin `typescript@^5` in the docs workspace; the repo root uses TS 7, which has no programmatic API (same reason tsdown needs `dts: { oxc: true }`).
- Highlighting must stay server-only: `CodeBlock.vue` dynamically imports `docs/utils/highlighter.ts` behind `import.meta.server` inside `useAsyncData`, so the TS compiler and node_modules resolution never ship to the client; results ride the Nuxt payload.
- `CodeBlock` keeps Twoslash opt-in through its `twoslash` prop. Every source block that promises type hovers passes the prop explicitly; `scripts/check-interaction-drivers.mjs` requires hover nodes in the active pixi-viewport block.
- Code samples that are fragments need a hidden prelude terminated by `// ---cut---` (type-checked, not displayed), or twoslash strict mode throws on undefined identifiers and Nuxt serializes the failure as a `NuxtError` payload entry — the block then renders empty after hydration.
- Switching the docs app from `ssr: false` to `ssr: true` surfaced a hydration mismatch in `ThemeToggle` (server cannot know the client color preference) — the icon is wrapped in `<ClientOnly>`.
- The twoslash hover popup is pure-CSS (`style-rich.css`, `transform: translateY(1.1em)` = always downward) and the project additionally `display:none`s it until hover (opacity-hidden popups still expand the pre's scroll area). Collision detection therefore can't be CSS: `CodeBlock.vue` measures on `mouseover` (the read forces layout with hover styles already applied, so the flip lands before paint), flips via `.twoslash-popup-above` when the popup doesn't fit below and the space above is larger, and caps `maxHeight` + `overflow-y: auto` when it doesn't fully fit above either. Verify with `node scripts/check-twoslash-flip.mjs` (dev server must run; hover simulation needs `scrollIntoView({ behavior: 'instant' })` because the docs set `scroll-behavior: smooth`).

## Docs production builds require the workspace library artifact

`docs` consumes the root package through `pixi-heatmap: workspace:*`, while the package exports resolve to the gitignored `dist/` directory. A clean CI or Vercel checkout therefore needs the root `tsdown` build before Nuxt resolves the client-side dynamic import. Keep the docs build script ordered as `pnpm --dir .. build && nuxt build` so every production docs build bootstraps the library artifact itself.

## Pointer coordinates follow the canvas drawing space

Container border coordinates differ from the canvas content origin, and CSS scaling changes the ratio between client pixels and Pixi screen units. Map pointer coordinates through `app.canvas.getBoundingClientRect()` and multiply each normalized axis by `app.screen.width` or `app.screen.height`. Resize the renderer and heatmap together from one `ResizeObserver` callback. `scripts/check-hero-cursor.mjs` verifies bordered and CSS-scaled homepage states at DPR 2.

## pixi-viewport integration traps (v6.0.3)

- A slippy-map tile-level switch must keep its last populated generation visible while the next visible key set loads. Creating the next generation from `Texture.EMPTY` and immediately destroying the previous sprites produced 20–75 ms black frames during fast zoom. The Interaction demo loads its first tiles directly into the active layer, stages later generations offscreen, swaps a complete generation synchronously, and discards stale async results. `scripts/check-interaction-tile-continuity.mjs` delays the next tile generation and requires a populated transition frame.
- `passiveWheel` **defaults to `true` in v6** (was `false` in v5): the wheel listener is passive, so nothing can `preventDefault()` and the page scrolls/zooms together with the map. Pass `passiveWheel: false` whenever the viewport should own wheel gestures.
- The wheel plugin's `keyToPress` gate tracks **physical** keydown/keyup only. A trackpad pinch arrives as a `ctrlKey` wheel event with no key event at all — it fails the gate, isn't prevented, and the browser performs a **page zoom**. The demo patches the plugin's `wheel()` to let `ctrlKey` events through (`InteractionDemo.client.vue`); combined with `trackpadPinch: true` that also gives ctrl+scroll the smooth pinch path.
- `drag({ mouseButtons: 'middle' })` does **not** block touch panning — `checkButtons` applies the button filter to `pointerType === 'mouse'` only. Safe to combine with mobile `pinch()`.
- `el.innerHTML = ''` on a Vue-rendered container wipes nodes Vue still owns (hint/attribution overlays silently vanish on the next rebuild). Give the pixi canvas its own child mount node and clear only that.
- A rotated viewport's visible tile bounds come from all four screen corners. A top-left/bottom-right pair clips diagonal corners once rotation changes their world-coordinate ordering.
