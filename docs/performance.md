# Performance

## Reference contract

The reference suite runs on an Apple M1 Pro with Bun 1.3.14 and headless Chrome. Browser workloads
use WebGL 2, explicit `gl.finish()`, warmup frames, p50/p95/p99 distributions, and one isolated Chrome
process per workload.

Raw artifacts live in [`benchmarks/results`](../benchmarks/results). The generated table lives in
[`benchmarks/PERFORMANCE.md`](../benchmarks/PERFORMANCE.md).

Current GPU-resident promotion evidence uses schema 7 raw artifacts and one schema 4 aggregate on
the same Apple M1 Pro in isolated Headless Chrome 151 processes with Bun 1.4.0. Renderer, artifact
role, production-build bytes, harness inputs, runtime, run identity, and evidence digest are part of
the proof. WebGPU timestamps come from resolves fused into Pixi's scene submission and include GPU
readback validation.

The current Wave 2 promotion gate uses the `million-live` product path on the same M1 Pro class. Its
formal artifact carries schema 7 evidence sealing plus the current frozen browser-build and harness
fingerprints. The current artifact SHA-256 is
`95ac8125df23c4379e965f91607eca7b8a7eccba72f7c05694c2aa3384bbeec6`; its evaluator passes with
0.10 ms frame p95, a 55,574,528-byte live store, and exact 8/24/32/48-byte draw, prototype, fill,
and effectful strides. The historical 1.1.0 thresholds retain their own artifact path and limits.

## Scale fixtures

- 1,000,000 resident labels
- 8,000,000 visible glyph instances for full visibility
- 100,000 text and transform updates per dynamic commit
- 100,000 packed x/y updates during viewport motion
- Real pixi-viewport drag, deceleration, wheel, pinch, zoom, and rotation events
- Latin, CJK, Arabic, Devanagari, and emoji streams
- 20,000 unique glyphs under a 4 MiB atlas ceiling
- 10 warmup plus 120 sampled frames for the formal `million-live` product path

## Enforced budgets

### Current Wave 2 product gate

| Budget                                      |              Limit |
| ------------------------------------------- | -----------------: |
| `million-live` steady-state product frame   |       16.67 ms p95 |
| Complete live runtime store at one million  |             64 MiB |
| Draw reference                              |            8 bytes |
| Unique prototype glyph record               |           24 bytes |
| Fill-only transform core                    |           32 bytes |
| Effectful transform maximum                 |           48 bytes |
| Full-visibility draw submission             | One instanced draw |
| `TextStore` constructor base-store unit cap |  48 MiB plus 256 B |

The 48 MiB plus 256 B constructor contract stays in the `TextStore` unit suite. The 64 MiB browser
ceiling covers the complete live runtime store reported by the formal `million-live` sample.

### Historical 1.1.0 gates

| Budget                                  |              Limit |
| --------------------------------------- | -----------------: |
| Million-label core browser frames       |       16.67 ms p95 |
| 100,000 bulk mutation intake            |       16.67 ms p95 |
| CPU label store at one million capacity |            128 MiB |
| Synthetic glyph instance record         |           32 bytes |
| Eight-million-glyph instance buffer     |            256 MiB |
| Transform palette record                | 64 bytes per label |
| Atlas pressure allocation               |              4 MiB |
| Atlas textures per ordered draw bank    |                  8 |
| Full-visibility draw submission         | One instanced draw |

`bun run benchmark:check` validates the current `million-live` artifact against the exact package
version, schema 7 evidence seal, current browser-build fingerprint, and current harness fingerprint.
It evaluates the historical workload matrix through the 1.1.0-compatible artifact path. The check
also covers formal scale, browser completion, invariants, frame and mutation budgets, storage,
atlas eviction, draw submission, and the measured core ESM gzip graph. `--require-current` expands
exact-version artifact presence across the historical matrix.

## Running the suite

```bash
# Full isolated matrix and generated report
bun run benchmark

# One workload
bun run benchmark -- --workload viewport-zoom

# Committed budget gate
bun run build
bun run benchmark:check

# Formal Wave 2 artifact and generated report
bun run benchmark -- --workload million-live --renderer webgl
```

The formal command writes
`benchmarks/results/browser-million-live-<package-version>.json`. Run `bun run build && bun run
benchmark:check` against the unchanged source tree after capture.

Useful workload flags include `--renderer`, `--labels`, `--mutations`, `--warmup`, `--frames`, and
`--timeout`. A scale override produces an exploratory artifact. Formal artifacts use the defaults in
`benchmarks/workloads.ts`.

## Reading results

Setup time covers layer construction, label insertion, the initial commit, and fixture-specific GPU
allocation. Frame time covers the workload operation and its completion boundary. Mutation and
commit distributions separate synchronous intake from publication work.

The synthetic full-visibility fixture (`million-full`) owns the historical 1.1.0 throughput and
32/64-byte storage checks. `million-live` owns the current product-path frame and Wave 2 storage
proof. It commits the label set through `TextLayer`, draws the coordinator mesh, and splits each
steady-state frame into CPU JS, upload bytes, and GPU completion. Its counters separate 8-byte draw
references from 24-byte unique prototype records and the 32-byte fill transform core.

Atlas pages live in two texture arrays (R8 and RGBA8). Page-alternating multilingual runs retain
instance order in one mesh per blend/z, keeping WebGPU submission below its uniform-batch capacity.

## Current GPU-scene resident promotion

`gpu-scene-resident` explicitly sets `culling.residency: "gpu-scene"`. Its exact formal fixture
creates 1,000,000 equal-content labels, submits the 50,000-label viewport set, runs 120 camera
frames, then moves 100,000 labels for 120 more frames. The
[`schema 4 promotion aggregate`](../benchmarks/results/browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json)
has SHA-256 `a3a0eee1525765063d215a142230226a5b0f3bc7f07d52be4990f7b656ccc9db`.
Its frozen canonical output source is
[`browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json`](../benchmarks/results/browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json.gz),
SHA-256 `e8149d863b2d75af2e2ac997114597f5ab8ae4a3ca2746cf54c92f7672d69f7c`.

Thirteen raw evidence files are stored as deterministic `.json.gz` archives. Their manifest pins
the uncompressed byte count and SHA-256, and `bun scripts/benchmark-artifact-archive.ts materialize`
restores the original logical `.json` filenames for formal reruns.

The five independent schema 7 runs share production-build fingerprint
`1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4`, harness fingerprint
`2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`, and runtime fingerprint
`5179504654b69449d6d2219ef12d1f6f8a12d053c89881702db871c38dd6fec7`. Each invocation carries a
distinct UUIDv4 run id, capture time, and self-verifying evidence digest.

| Run | Formal budget |  Camera p95/p99/max | Camera over |  Position p95/p99/max | Position over |
| --: | ------------- | ------------------: | ----------: | --------------------: | ------------: |
|   1 | PASS          |  8.2 / 9.5 / 9.8 ms |     0 / 120 | 10.8 / 12.2 / 12.4 ms |       0 / 120 |
|   2 | PASS          |  8.0 / 9.4 / 9.9 ms |     0 / 120 |  9.7 / 11.0 / 12.5 ms |       0 / 120 |
|   3 | PASS          |  7.9 / 8.6 / 8.8 ms |     0 / 120 |  9.5 / 10.5 / 10.9 ms |       0 / 120 |
|   4 | PASS          | 7.9 / 9.7 / 10.6 ms |     0 / 120 | 10.0 / 10.8 / 10.9 ms |       0 / 120 |
|   5 | PASS          |  6.9 / 7.2 / 7.5 ms |     0 / 120 |    8.3 / 9.4 / 9.6 ms |       0 / 120 |

Across 600 formal frames per phase, camera p95/p99/max is 7.9/9.4/10.6 ms and position is
9.8/11.0/12.5 ms. Both phases record zero frames above 16.67 ms. All five runs read exactly
50,000 compact references with hash `0x45cfd045` from `gpu-instances-out`, pixel hash
`0xa8ad90b4`, and 302,457 non-transparent pixels. Timestamp telemetry is
1,300 readbacks / 1,300 fused resolves / 0 standalone submissions. All 1,300 segmented samples
resolve the six-query palette/cull/scene-render boundaries with zero fallback. Segment p95 is
0.13/0.59/5.44 ms. Truth repeatability, formal performance, and promotion are GO.

The independent
[`600-frame sustained artifact`](../benchmarks/results/browser-gpu-scene-resident-webgpu-fastlane-fused-600-1.2.0.json.gz)
has SHA-256 `61dd5fb7932fcb10868bb9fa3be13b6e4e71201b010da2b783464c8faedaddf5` and uses the same three
fingerprints. Camera p95/p99/max is 10.5/13.5/21.5 ms with 4/600 above budget. Position is
8.1/9.9/11.6 ms with 0/600 above budget. Its timestamp telemetry is
1,220/1,220/0 readback/fused/standalone, and the sustained gate is GO.

The current mover ABI has two exact-f32 lanes. Sorted, unique, strictly contiguous active slots
pack `x` and `y` into 8 bytes per mover; the 16-byte header carries `baseSlot` and `count`. Dense
10,000- and 100,000-mover frames upload exactly 80,016 and 800,016 bytes. Sparse, reordered,
duplicate, and holed inputs retain the indexed `slot`/`x`/`y` 12-byte ABI with last-write-wins
identity. The current Task 12.39 resident artifacts use the dense 8-byte lane. Historical schema 2
resident evidence preserves 16-byte mover captures; historical R1a evidence preserves its indexed
12-byte / 1,200,016-byte capture.

Move-plus-remove commits queue the validated mover while its resident slot is active, then publish
the zero-instance tombstone. The fused pass preserves that tombstone while updating origin and
AABB fields. CPU setup/reconciliation, spatial queries, the host reference, and WGSL share the same
two-step f32 edge arithmetic. Palette dispatch resources follow the live WebGPU device epoch, retain
three idle command slices, and report bytes plus write calls after each accepted queue upload.
Compute and palette recovery also key failure state by `GPUDevice` identity. Replacement devices
rebuild the indirect draw buffer, encoder hook, transform storage, cull records, and resident local
bounds before fused movers resume. Encoder replacement advances the frame-transaction epoch,
requeues pending work, and limits retired-epoch callbacks to releasing captured resources.

The resident fill path also passes byte-exact output parity. The formal browser reference gate runs
the product single-prototype shader, forced resident multi-prototype shader, and forced general
shader through the same 1M-label / 100K-mover / 1280×800 / 120-frame fixture. All three match the
canonical GPU and pixel identity.

## R1a heterogeneous GPU-scene delivery

`gpu-scene-heterogeneous-64` keeps the GPU Scene v2 grid, camera path, and roughly 259,605-label
full-screen selection while moving the scene onto the resident bridge. The formal fixture creates
1,000,000 labels and 100,000 movers from 64 single-glyph Arial prototypes crossed with 8 canonical
fill paints. Prototype and paint indices follow independent interleaved sequences, covering all 512
pairs. Labels retain z 0, unit transforms, zero anchors, alpha 1, normal blend, and collision
disabled. Live stats must report `residencyActive: "gpu-scene"`, 64 prototypes, 8 paints, and zero
GPU-scene per-label objects.

Each fresh-process repetition runs 10 warmup frames plus 120 camera and 120 position frames at
1280×800. Camera frames upload zero transform and cull-record bytes. The current formal and
candidate artifacts exercise the dense 8-byte lane at exactly 800,016 bytes per 100,000-mover frame
and keep cull-record upload at zero. Sampled frames retain one product submission, one fused
submission, zero standalone submissions, and complete palette/cull/scene-render timestamps. The
frozen legacy R1a captures preserve the indexed 12-byte / 1,200,016-byte evidence.

After both timed phases, an independent CPU pass lays out the 64 prototype bounds and selects the
final camera and position viewports in slot order. Its submitted count/hash must equal the GPU
indirect and `instances-out` readbacks. Each repetition performs two pixel readbacks; count, hash,
pixel hash, and non-transparent-pixel count must match across both repetitions. The 10K browser gate
also compares the resident product shader with the general reference shader over identical content
and the same CPU reference identity.

Delivery requires camera/position frame p95 at or below 33.34 ms and at least 4× speedup versus the
fixed WebGPU GPU Scene v2 camera/position baseline of 199.5/199.9 ms. Camera CPU/commit limits are
4/2 ms; position CPU/commit limits are 8/4 ms; surface apply is 2 ms; GPU timestamp is 30 ms; setup
is 2,000 ms; heap is 512 MiB. Post-setup shaped, admitted, and culling-query deltas remain zero. The
16.67 ms target carries an independent promotion status, and the strict resident gate retains its
current limits.

The two sealed 2026-08-30 captures make the delivery and promotion status **GO**:

| Artifact              | Repetition |      Setup | Camera p95 / speedup | Position p95 / speedup | Camera / position frames above 16.67 ms |
| --------------------- | ---------: | ---------: | -------------------: | ---------------------: | --------------------------------------: |
| Independent fresh run |          1 | 1,014.9 ms |     10.3 ms / 19.37× |       11.0 ms / 18.17× |                                   0 / 0 |
| Independent fresh run |          2 | 1,012.2 ms |     10.1 ms / 19.75× |       11.0 ms / 18.17× |                                   0 / 0 |
| Canonical candidate   |          1 | 1,015.8 ms |      9.6 ms / 20.78× |       11.3 ms / 17.69× |                                   0 / 0 |
| Canonical candidate   |          2 | 1,008.2 ms |      9.8 ms / 20.36× |       11.4 ms / 17.54× |                                   0 / 0 |

All four repetitions report camera count/hash `343,635 / 0x33d2c553`, position count/hash
`259,609 / 0x9dbf0bd5`, pixel hash `0x8c5162ca`, and 1,011,427 non-transparent pixels. Maximum
setup is 1,015.8 ms. Every sampled camera and position frame stays within 16.67 ms, closing the
independent promotion gate.

Run the two artifacts serially after GPU activity is quiet:

```sh
bun run benchmark:workload -- --workload gpu-scene-heterogeneous-64 --renderer webgpu --output benchmarks/results/browser-gpu-scene-heterogeneous-64-webgpu-formal-1-1.2.0.json
bun run benchmark -- --workload gpu-scene-heterogeneous-64 --renderer webgpu
```

The canonical report input is
`benchmarks/results/browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0.json`; the independent
fresh-run evidence is
`benchmarks/results/browser-gpu-scene-heterogeneous-64-webgpu-formal-1-1.2.0.json`.

The canonical file SHA-256 is
`372c87ad4530c0d941eaa01bce18d7da62d4845ec56f58e88f3bc311bc6ec0b8`; its evidence seal is
`9e2ef3d378b72b0436d0c1a78fd836de1a7c983690749d3683807f49e1b345da`. The independent file SHA-256
is `46175af513d4d8ca0ec49f70f6b76dc16891063c86ac803c3118a3446d2ad49f`; its evidence seal is
`99bf160f1c9c422423290ed3b9279df8561a900ee228e5b774e5e74e21ffb883`. Both share build fingerprint
`1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4` and harness fingerprint
`2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`.

## GPU-scene historical schema 2 checkpoint

`gpu-scene-resident` explicitly sets `culling.residency: "gpu-scene"`. Its formal fixture creates
1,000,000 equal-content labels, submits the exact 50,000-label viewport set, runs 120 camera frames,
then moves 100,000 labels for 120 more frames. Resident compact-output capacity is eight bytes per
maximum submitted glyph. The
[`frozen schema 2 repeatability snapshot`](../benchmarks/results/browser-gpu-scene-resident-webgpu-repeatability-1.2.0.json)
records five isolated post-capacity, pre-fast-lane attempts that exercised the complete
50,000-reference GPU output and recorded one shared prototype, 260 valid timestamps, zero
shaped/admitted/query deltas, and stable readback identity:

| Attempt |    Setup | Camera frame/GPU p95 | Position frame/GPU p95 | Status |
| ------: | -------: | -------------------: | ---------------------: | ------ |
|       6 | 789.1 ms |    9.8 / 8.323072 ms |     18.5 / 9.371648 ms | FAIL   |
|       7 | 777.2 ms |   11.1 / 8.323072 ms |     18.8 / 9.699328 ms | FAIL   |
|       8 | 800.7 ms |   10.1 / 8.323072 ms |    19.5 / 10.092544 ms | FAIL   |
|       9 | 791.4 ms |   11.6 / 8.323072 ms |    20.0 / 10.289152 ms | FAIL   |
|      10 | 802.1 ms |   11.9 / 8.323072 ms |    19.9 / 10.223616 ms | FAIL   |

Every post-fix run read exactly 50,000 compact references with hash `0x45cfd045` from
`gpu-instances-out`, then produced pixel hash `0xa8ad90b4` and 302,457 non-transparent pixels on
both readbacks. Output identity is GO for this historical snapshot. Its frozen SHA-256 is
`b74ff555d22fa8b7f39fe0203c81293e3e55a633283a7f5322b3c16c8d9c8aa0`; its embedded attempt 10
source digest is `d4914d86952b310de210cb517d3a2f12073494c86dc38eb609af1095a61de2eb`.

Camera commits uploaded zero transform and cull-record bytes. Position commits uploaded exactly
1,600,016 transform bytes at p95 and zero cull-record bytes. Across the five post-capacity,
pre-fusion attempts, camera frame p95 ranged from 9.8 to 11.9 ms and position frame p95 ranged from
18.5 to 20.0 ms.
Sustained aggregation recorded camera 1 / 600 frames above 16.67 ms (0.17%), p99 12.70 ms, and max
16.90 ms. Position recorded 598 / 600 (99.67%), p99 20.70 ms, and max 24.00 ms. Throughput and
release-tail promotion are PAUSE.

The first five attempts allocated one eight-byte compact reference from the shared prototype count.
The same historical schema 2 snapshot retains them as pre-fix invalidated history. Three of those
attempts passed the timing budgets: camera frame p95 2.20 / 3.50 / 1.60 ms and position frame p95
9.80 / 10.30 / 10.90 ms. Their compact output omitted the formal 50,000-reference set, and schema 2
excludes their timing from release evaluation.

The historical `browser-gpu-scene-resident-webgpu-submit-fusion-600-1.2.0.json` checkpoint encodes
palette patch, cull, and Pixi render work into one product submission per sampled frame. It
records 1,220 total / 1,220 fused / 0 standalone product transactions and two phase-end identity
readbacks. Its timer issues 1,220 separate timestamp diagnostic submissions, which makes this the
standalone timestamp baseline. Camera frame p95/p99/max is 11.8/13.0/14.3 ms with 0 / 600 frames
above budget.
Position is 17.7/19.2/21.7 ms with 598 / 600 above budget. The readback stays exact at 50,000 /
`0x45cfd045`, paired pixel hash `0xa8ad90b4`, and 302,457 non-transparent pixels. This checkpoint
keeps output identity at GO and throughput/release-tail promotion at PAUSE. Its SHA-256 is
`24239c2fdf6431dbb91f6f8b8f2fdc1ca99e585d9bfdd93c78bbe72a212da245`.

The resident fill hot path preserves the general shader's byte-exact `over(fill, zero)` rounding.
Its formal browser reference gate runs the product single-prototype shader, the forced resident
multi-prototype shader, and the forced general shader through the same 1M-label / 100K-mover /
1280×800 / 120-frame fixture. All three match the canonical 50,000-entry GPU identity, pixel hash
`0xa8ad90b4`, and 302,457 non-transparent pixels.

The current sealed `gpu-scene-v2` candidates remain fixed RED controls for the general
viewport-residency path. WebGL camera/position frame p95 is 127.0/214.1 ms and WebGPU is
141.9/148.2 ms against 16.67 ms. The heterogeneous minimum-speedup comparison stays pinned to the
historical fixed WebGPU baseline of 199.5/199.9 ms. The resident result belongs to the explicit
bounded-scene contract and keeps its own workload identity.

## Current collision repeatability

The current
[`schema 2 collision aggregate`](../benchmarks/results/browser-label-collision-repeatability-1.2.0.json),
SHA-256 `b501181208e39884e3cae5a589a540e5e783ec9d621df927b30f140ff42184a1`, joins three sealed
WebGL candidates and three sealed WebGPU candidates from build
`1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4` and harness
`2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`. All six preserve 512
selected labels, 4,096 glyphs, selection hash `0x611785c5`, and exact accounting.

WebGL frame p95 is 21.0/20.3/21.1 ms across the three runs; CPU p95 is 9.3/9.1/9.2 ms and
collision p95 is 2.7/2.7/2.8 ms. WebGPU frame p95 is 12.2/11.5/11.9 ms; CPU p95 is
8.3/8.5/8.3 ms and collision p95 is 2.9 ms in each run. Direct CPU/collision and WebGPU whole-frame
budgets pass. Repeatability is GO.

The current selector consumes the monotonic candidate list as pre-ranked input, skips the rank
sort, and caches contiguous identical-bound runs. Record writes retire touched cached runs;
structural changes retire the full run cache. Spatial queries route sparse candidate sets through
ordered sort, dense sets through a reusable ordered bitset, and near-full sets through a linear
scan. These paths preserve the six-run selection identity.

## Wave 5 checkpoint

| Track             | Decision                 | Measured scope                                                                                                                                                    |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HarfBuzz GPU      | GO packed / PAUSE direct | The packaged Worker/Wasm runtime and packed browser storage pass; direct `vec4<i32>` waits for its independent quality/performance gate at a 114.8 MiB projection |
| Outline           | GO                       | Explicit `glyphMode: "outline"` WebGPU compute/fragment integration and lifecycle gates pass; automatic atlas rendering remains the default                       |
| SharedArrayBuffer | GO                       | Advanced opt-in transport with `SharedArrayBuffer`, `Atomics`, cross-origin isolation, matching glyph/cluster-end hashes, and leased zero-copy views              |
| SIMD shaping      | HOLD                     | Packaged HarfBuzz workers preserve exact output; SIMD mean is 55.44 ms versus scalar 54.08 ms, a 2.51% variant regression                                         |
| Collision         | GO                       | Six sealed runs preserve selection truth; WebGPU whole-frame p95 is 12.2/11.5/11.9 ms with an 11.87 ms mean                                                       |

The HarfBuzz worker SIMD artifact has SHA-256
`7f8ea0d5ffa6bde9ad91ee8bf6baaa04972d38cda60cb3eee7c5777117fddbb1` and decision
`HOLD (variant-regression)`. Its package boundary remains PAUSE for human approval; experimental
assets stay opt-in and add 418,675 raw bytes / 138,827 gzip bytes in the measured payload. The Wave
5 modes retain explicit opt-in boundaries. Default promotion requires each track's named
end-to-end workload and production asset/runtime gate.

The [2026-08-29 market refresh and next-evolution map](../.agents/docs/performance-plan.md#2026-08-29-market-refresh-and-next-evolution)
tracks R1 Heterogeneous GPU Scene, R2 Revisioned Scene WAL, R3 Skia-tier Router, R4 Map Symbol
Continuity, and R5 Sparse Glyph Strip Cache against representative mainstream and frontier
projects.

### R4 map-symbol continuity checkpoint

`bun run benchmark:symbol-continuity` reserves 100,000 records, warms five frames, and samples 20
tile-overlap/collision frames in both hash modes. Repeated local verification places manual-mode
frame p95 at 9.85–11.57 ms, every-frame mode p95 at 14.46–16.17 ms, and the manual checkpoint hash
at 13.72–15.27 ms outside the sampled frame. Both modes retain an estimated 15,500,000 bytes. The
final committed hash is `1269277151`, the every-frame sampled hash is `485162081`, and all expected
counters match.

R4 correctness and the 100k dual-mode index microbenchmark are GO. TextLayer product integration is
HOLD through the R2 Scene WAL/delta source, browser workload, and sustained-frame gate.

### R5 sparse-strip correctness checkpoint

`bun run benchmark:sparse-strips` encodes the pinned HarfBuzz Arabic glyph 4 at physical
power-of-two buckets. Final sparse bytes occupy 29.47% of dense alpha at 512 pixels and 15.04% at
1024 pixels; peak encoder payload ratios are 35.83% and 21.35%. Warm CPU rehydration p95 measures
1.78 ms and 6.54 ms for those buckets in the recorded local run. Coverage and RGBA hashes stay
stable.

The independent Chrome WebGPU fixture passes CPU/GPU pixel comparison at 256 and 512 pixels with a
maximum channel delta of one, zero mismatched channels, visible output, and identical repeat hashes.
CPU IR/cache correctness and the single-batch GPU path are GO. Product routing is HOLD
through sustained atlas-pressure, stable-atlas-hit, whole-frame p95/p99/max, and 64 MiB
live-plus-retired evidence.

## Known cliffs

The 1.1.0 suite meets the formal million-label frame and mutation budgets. Three facts still cap
how far the current code can go:

- `atlas-pressure` is legal today because the gate only checks the 4 MiB ceiling and eviction
  activation. The same artifact records 638.50 ms frame p95 while packing 20,000 unique glyphs.
- `dynamic-counters` sits at 16.40 ms frame p95, 0.27 ms under the 16.67 ms wall.
- `million-full` draws a synthetic 8,000,000-instance mesh. It proves one instanced GPU
  submission. `million-live` is the product-path workload; it has no 1.1.0 artifact yet.

Wave 1 of that program is in source: Skyline atlas packing, a next-fit equal-height shelf, per-mode
O(1) LRU, typed instance writes, numeric fill packing, a hierarchical hash grid, packed live atlas
keys, power-of-two instance free-list buckets, and policy-costed dirty uploads. Wave 2 has started
with current benchmark semantics: shared styles intern, position-only commits patch 16 palette
bytes, z-index and source revisions are `Float32` and `u32` respectively, fill-only GPU transforms
use a 32-byte core plus a 16-byte sparse effect tail, the constructor base store keeps its
48 MiB plus 256 B unit ceiling, the live runtime store uses a 64 MiB browser ceiling, unique
prototype records use 24 bytes, and visible draw references use 8 bytes. Wave 3 adds stable WebGPU compute
compaction on the direct single-bank mesh. Camera frames inside an expanded CPU working set upload
only the tight draw viewport. Position-only storms inside that set patch resident AABBs and
palette texels without another grid query. WebGL keeps the tight CPU grid. Wave 0 adds `million-live`, split
CPU/upload/GPU frame samples, and commit phase timers. The
40 KiB core gzip and `atlas-pressure` frame CI gates are deferred; the check still prints those
sizes. Published headline budgets retain the 1.1.0 reference files. Current schema 7/schema 4
artifacts cover resident GPU Scene promotion; schema 6 artifacts retain the legacy GPU Scene v2
and collision controls. The next program is recorded in
[`.agents/docs/performance-plan.md`](../.agents/docs/performance-plan.md). Published frame and
storage budgets stay until a human accepts new numbers.

## Application tuning

- Reserve the expected label capacity.
- Reuse `Float64Array` IDs and `Float32Array` position buffers.
- Use `updatePositions` for movement, `updateTransforms` for positions plus rotation, and
  `updateTextPositions` for counter-style streams.
- Keep viewport culling enabled for large worlds.
- Leave `computeCull` at `"auto"` for WebGPU camera workloads. Set it to `false` to force the
  WebGL-compatible CPU grid.
- Keep `culling.residency` at its `"viewport"` default for general scenes. Select `"gpu-scene"`
  for the documented bounded fill-only scene and verify `stats.residencyActive` after setup and
  layout edits. Resident rotation uses 12-byte dense or 16-byte indexed fused commands; wrap,
  newline, and writing-flow edits rebind shared prototypes within the retained 64/8 capacity.
- Pass `requestComputeCullGpu()` into `Application.init({ gpu })` so compute cull can bind
  instance storage larger than the 128 MiB WebGPU default, and so the vertex stage can bind
  the palette storage buffer. WebGL and devices without vertex storage keep the texture
  palette. A WebGPU storage path does not gather 1,000,000 x/y values on a position-only or
  camera-only commit. After the first full upload the GPU table owns live x/y, and a
  position-only storm uploads one packed move-command buffer. On storage plus compute-cull
  that storm does not upload mover cull AABBs. The GPU adds palette origin to the local box
  stored in the cull record.
- Reuse styles and fonts to maximize shaping and layout cache hits. Duplicate strings intern one
  layout result per (family, size, weight, text). Broadcast `updateTextPositions` with default
  anchors uses a columnar content lane: one layout, a shared prototype range, packed x/y, and
  `placeMany` for the shared local box. Position-only storms write store x/y once; the
  spatial index aliases those columns and only rebuckets on a cell crossing. Non-zero anchors,
  non-unit scale, shaping overrides, and trusted runs stay on the object path. Duplicate
  strings do not copy instance bytes. Draw instances are 8 bytes per visible glyph; shaders
  fetch the unique store from a
  prototype texture. Compact and scatter stamp the palette index.
- Set an atlas ceiling that matches the product glyph working set.
- Compute-cull layouts first-seen labels in the tight draw view. The 0.25-viewport ring may
  admit intern hits and same-commit copies of a tight unique string, up to
  `culling.offscreenAdmitBudgetBytes` (default 65536). Ring-only unique misses stay unshaped.
  Deferred ring hits resume on a later ring query or when they enter the tight view. Atlas
  texel uploads for already-instanced glyphs stay ungated. The expanded working set is residency
  slack, not a prepare batch. Known strings hit the shape cache on the same turn and share
  instance ranges. First-seen fill-only copies of those strings skip per-label snapshots and
  write the palette in a column. Distinct first-seen strings prepare those columns in parallel.
  Unique groups that share a fill write one `writeFills` column.
- Put stable UI alphabets on `rasterizerOptions.prebuilt` pages. Do not ship those pages in the
  core bundle. `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`, `charsetSdfPrebuilt`) is the optional
  side export; import it from that entry, not from `pixi-glyphflow`. Empty-ink scalars skip
  generation. Known CJK can be a crop when the host bakes that charset. A bake at one logical
  size that clamps to `distanceFieldMinFontSize` also serves the other clamp-equivalent sizes
  on first sight. Unseen ink and sizes above the minimum still generate in that commit.
- `culling.lod` drops labels whose projected font height is below one pixel. Leave it off unless
  the product accepts missing subpixel text.
- Read diagnostics at telemetry cadence.
