# Paid traps

## Formal browser evidence runs from one frozen production build

Each formal invocation creates one scoped temporary directory, performs one Vite production build,
and serves the preview from those exact bytes. The runner hashes a normalized build manifest sorted
by relative output path, covering bundle, Worker, Wasm, and asset bytes, then verifies the same
fingerprint after the browser run. Schema 7 seals a UUIDv4 `runId`, the build fingerprint, the
harness fingerprint, the runtime fingerprint, and the canonical artifact evidence digest; final
cleanup removes the temporary directory. The preview binds an available local port with
`strictPort: false`, so the formal runner requires local service permission.

Before Vite runs, lexical and realpath guards accept one dedicated empty directory below the system
temporary root. They exclude the project root, every ancestor, the system temporary root itself,
symlinks, and non-empty directories. Vite uses `emptyOutDir: false`; sentinel fixtures keep the
destructive boundary covered by tests.

The schema 4 promotion aggregate joins five independent 120-frame candidates and one 600-frame
sustained run. All six use build fingerprint
`1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4`, harness fingerprint
`2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`, and runtime fingerprint
`5179504654b69449d6d2219ef12d1f6f8a12d053c89881702db871c38dd6fec7`. Every invocation carries a
distinct `runId`, `capturedAt`, sample capture time, and evidence digest. The aggregate verifies
these identities before it can report truth repeatability or promotion readiness. Schema 6
artifacts carry the historical classification `schema-6-without-build-provenance`.

Evidence: `benchmarks/harness-launcher.ts`, `benchmarks/run.ts`, `benchmarks/artifacts.ts`,
`benchmarks/gpu-scene-resident-repeatability.ts`, `tests/benchmark-artifacts.test.ts`, and
`tests/gpu-scene-resident-repeatability.test.ts`.

## TextLayer teardown has a tracked asynchronous completion boundary

`TextLayer.destroy()` keeps PixiJS's synchronous `void` signature and starts every best-effort
cleanup step once. It throws the first synchronous cleanup failure after the remaining owned
resources receive their release call. `whenDestroyed()` returns one stable promise that includes
internally owned asynchronous provider teardown and rejects with the first cleanup failure. This
tracked boundary gives callers an awaitable release point while preserving the container lifecycle
contract.

Renderer replacement and `detach()` use a separate release observer. Each actual renderer graph
release publishes one handled promise through `whenRendererReleased()`, covering surface,
coordinator, resident scene, and internally owned provider teardown. Repeated empty `detach()` calls
reuse that stable promise and preserve its first-error result.

Renderer activation is a transaction too. Constructor and `attach()` build the coordinator and
surface locally, complete capability preparation, and atomically publish the graph. A surface or
capability fault triggers best-effort rollback, retains the activation error as the primary result,
leaves the layer detached, and permits a same-renderer retry. Asynchronous rollback joins
`whenRendererReleased()`.

Evidence: `src/TextLayer.ts` and `tests/TextLayer.render-lifecycle.test.ts` cover cleanup order,
first-error identity, internally owned provider rejection, constructor/attach activation rollback,
same-renderer retry, renderer replacement, repeated empty detach, repeated destroy, and stable
promise identity. `tests/TextLayer.gpu-resident.test.ts` covers resident-scene release failure.

## CI Chrome does not draw `float16x4` instance attributes

Keep the 24-byte CPU store layout (four `f16` local-rect components). Shaders fetch those bits from
the prototype texture and unpack with `unpackHalf2x16` / `unpack2x16float`. Draw instances are two
`uint32`s (`aProtoIndex`, `aPaletteIndex`).

`bun run test:browser` on CI Chrome drew 0 pixels when `GlyphMesh` used `float16x4` while the shaders
declared `vec4`. ANGLE either skipped `HALF_FLOAT` instance attributes or rejected that type pairing.
Integer attributes and RGBA32F + `floatBitsToUint` are the proven path. Do not bind the prototype
as `RGBA32UI` / `usampler2D` to "skip" the bit cast. Do not upload raw unorm16 UV words or the
metadata uint through RGBA32F: `0xFFFFFFFF` and `ACTIVE | high raster` are NaN bit patterns, and
the GPU canonicalizes them. Pack UV as f16 pairs and split metadata into two 16-bit integer floats.
Do not size proto fetches with a `uPrototypeWidth` uniform: the first stroke grows the palette and
Pixi rebuilds `glyphUniforms` as the two floats it already knows (`uPaletteWidth`, `uEffectBase`).
A third float is dropped, width becomes 0, and every fetch hits texel 0. Read
`textureSize` / `textureDimensions` instead. Re-bind `uPrototype` after palette init and again on
each mesh render. `setPaletteTexture` alone is too early; Pixi overwrites that slot when it
initializes the new palette texture.

WebGL `texSubImage2D` of an `rgba32float` range must pass a `Float32Array` whose `byteOffset` is
0. ANGLE / SwiftShader ignore the view offset and read from the start of the underlying buffer.
A dirty proto upload for store glyph 1 then writes glyph 0 (often cleared, `isActive` false) onto
the live texel. `packedFloatTexelView` copies the range first. Do not pass `data.subarray(...)`
straight to `texSubImage2D`.

A position storm's first dirty palette write is the first GPU rewrite after
`initializeTexture` (full `texImage2D`). Rewriting a bound `rgba32float` vertex palette with
`texSubImage2D` or a second `texImage2D` of the same GL object blanks the compositor on
ANGLE/SwiftShader while CPU slots stay live, including a packed 1024-wide row at `x = 0`
with `UNPACK_*` reset and `glError` 0. First Pixi `initializeTexture` / `getGlSource` still
paints. Unbind the mesh sampler first (`unbindPaletteTexture` → `Texture.EMPTY`) and every
GL `TEXTURE_2D` unit (`renderer.texture.unbind` plus a combined-unit walk), dirty-upload
the same object, then rebind through `#bindMeshSources`. Do not skip the WebGL rewrite.
Do not call `source.update()` here: Pixi's buffer uploader takes `texSubImage2D` when the
GL size already matches. Do not create a new `BufferImageSource` / `Texture`. WebGPU keeps
dirty rectangles. Proto dirty rects still go through `uploadFloatTextureRanges`.

The first proto `initializeTexture` uploads whatever `highWater` is at that moment (often glyph 0
only). Three appearance glyphs still fit in one 1024-wide row, so the texture size does not grow
and later glyphs live on the GPU only through dirty rects. Growing the palette recreates a vertex
texture and Pixi re-inits sibling sources from that first upload, so protoIndex ≥ 1 becomes
inactive. After a palette buffer replace, rewrite the live store into the existing proto pixels
and upload that same texture (`source.update()` plus a full float range write). Do not create a
new `BufferImageSource` / `Texture` and `destroy` the old one: readPixels of the replacement
looks fine, but vertex `texelFetch` returns zeros, the instance rect collapses, and
W→AB→W plus stroke draws 0 pixels. A first-stroke-only label stays on protoIndex 0 and hides
this. Rebuild the mesh if you want, it does not fix the empty fetch.

Do not revert to 32-byte `float32x4` rects to make CI green. Do not bind the 24-byte store as the
instance buffer: after `share`, `highWater` is unique glyphs and their baked palette is the
prototype's.

## PixiJS WebGPU devices keep the 128 MiB storage binding default

PixiJS `requestDevice()` does not raise `maxStorageBufferBindingSize`. The core default is
134,217,728 bytes. A million-label homepage working set rounds the instance storage buffer to
268,435,456 bytes. Binding it fails even when the adapter allows ~4 GiB.

Call `requestComputeCullGpu()` and pass `{ gpu }` into `Application.init`. The helper copies the
adapter's `maxStorageBufferBindingSize` and `maxBufferSize`. It also copies
`maxStorageBuffersInVertexStage` when that adapter limit is greater than 0. The WebGPU core
default for vertex storage bindings is 0. Without the raise, the vertex stage cannot bind the
palette storage buffer and the layer stays on the texture path. If a compute-cull buffer still
exceeds the live device limit, that pass falls back to `cpu-grid` instead of submitting an
invalid bind group.

## WGSL rejects `from` as an identifier

`CreateShaderModule` failed on `let from = …` in the compute-cull scatter pass. Tint treats `from`
as reserved. Use `src` / `dst`. Do not name locals `from` or `to`.

## A compact mesh is not a permanent compute-cull veto

Late glyph allocation leaves instance ranges out of draw order, so the CPU path builds compact
meshes. Do not read that shape as `cpu-grid` forever. One blend/z group keeps one `GlyphMesh`
(two array textures). GPU scatter writes 8-byte draw-state-order refs. Multi-segment scenes and a
store with `highWater` more than twice the live instances stay on the CPU compact path.

## Pixi BufferImageSource cannot upload 2d-array layers

`viewDimension: "2d-array"` plus `arrayLayerCount` allocates a WebGL `TEXTURE_2D_ARRAY` / WebGPU
array texture. Pixi's `buffer` uploaders still call `texImage2D` / `writeTexture` at `z = 0` for
one 2D slice. Set `uploadMethodId` to something else so `getGlSource` uses `texImage3D` (empty
array) and `getGpuSource` skips the 2D buffer write. Do not call `source.update()` on atlas
arrays. Write layers with `texSubImage3D` / `writeTexture` at `origin.z = layer`. WebGPU
`writeTexture` rejects a `bytesPerRow` that is not a multiple of 256 — pad narrow glyph rects
(`packGpuTextureRows`). WebGL rejects `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
on 3D / array uploads (`INVALID_OPERATION`); clear both around the write. GLSL ES 3.00 needs
`precision highp sampler2DArray` or the fragment program fails to compile and draws 0 pixels.
R8 (sdf/alpha) and RGBA8 (msdf/color) cannot share one array. Growing an array mid-commit
leaves the replaced `AtlasArray` in that frame's dirty set. `getGlSource` on the destroyed
source reads `source.style === null` and throws `addressModeU`. Skip destroyed arrays;
rebind live meshes to the next source before `texture.destroy(true)`. Bind `uSampler` to an
owned `TextureStyle`, not `source.style`. WebGL 2 has no storage buffers; keep the transform
table as a texture there. Do not build a second feature-complete stack.

## WebGPU palette storage cannot bind unless vertex storage is requested

PixiJS `requestDevice()` leaves `maxStorageBuffersInVertexStage` at the core default of 0.
`requestComputeCullGpu()` raises it when the adapter allows at least one vertex storage binding.
`resolvePalettePath` stays on `"texture"` when the live device still reports 0, when the adapter
is WebGL, or when the palette byte length exceeds `maxStorageBufferBindingSize`.

The storage table uses the same 32-byte fill records as the texture (`array<vec4<f32>>`, two
`vec4`s per slot). After the first full upload, that table is the live draw source for x/y.
Position storms skip `writePositions`. JS packs one move-command buffer (`slot`, `x`, `y`) and
a compute `patch_xy` writes `transforms[slot * 2].xy`. Do not upload origin-column spans. Do
not `writeBuffer` per mover. Camera-only frames submit neither commands nor a palette gather.

A storage-buffer rebuild or geometric grow must `refreshOrigins` from the live store columns
before a full upload. Mover-only storms leave CPU texels stale. Uploading that table without
the refresh clobbers GPU-patched x/y. Hit-test keeps using the aliased store columns.

Compute-cull box ownership follows the active residency path. Storage-backed viewport residency
stores the local box in each record, and the cull shader adds `transforms[palette_index * 2].xy`.
Position storms update that palette table and trigger culling with zero CPU AABB walk or cull-record
upload. GPU-scene residency stores absolute AABBs and patches movers from its indexed local-bounds
table in the fused palette pass. Texture-backed viewport residency stores world AABBs and patches
changed records on the CPU.

Storage-path `GlyphMesh` resources must name `uTransforms` only. After #34 the storage WGSL
replaced `uTransformTexture`, but the mesh still put that texture in `resources` and only
added `uTransforms` when a buffer was passed in. Pixi maps unknown resource names to bind
group 99. `createBindGroup` then reads `program.gpuLayout[99]`, which is undefined, and the
first compute-cull WebGPU draw throws. Do not keep the leftover texture resource on the
storage shader. Do not mark `palettePath` `"storage"` until `PaletteStoragePass.ensureTransforms`
has registered a GPU buffer. If that table is not ready, stay on the texture shader for the
frame so position storms still write CPU texels.

The homepage must not hide that throw. Keep `requestComputeCullGpu()` on WebGPU. Do not catch
the TypeError and rebuild as WebGL, force `palettePath: "texture"`, or drop storage resources
so the canvas still paints. Show the error. WebGL's texture palette stays valid.
`unbindPaletteTexture` is a WebGL sampler drop only; it must not write `uTransformTexture`
onto a storage-path mesh.

## GPU-scene setup hydrates the full palette before culling

The resident coordinator stores one draw state for a shared prototype, while the transform palette
still has one row per label slot. An early setup path uploaded only the prototype slot. Remote rows
kept alpha zero, so compute submitted the correct 50,000 instances and the render target remained
transparent. Resident setup now uploads every typed fill row before the first compute dispatch.
The browser gate asserts both submitted count/hash and non-transparent texture readback.

Resident compact output reserves eight bytes per maximum submitted glyph. Prototype count sizes
prototype storage; viewport output cardinality sizes `instancesOut`. A former shared-prototype
allocation reserved one reference while scatter and indirect draw selected 50,000. The formal gate
now reads the ordered references back from `gpu-instances-out` and pairs that hash with two pixel
readbacks, so logical counters and actual GPU output share one correctness boundary.

The resident fill fragment also preserves the general shader's byte-exact
`over(fill, vec4(0))` arithmetic. A direct algebraic return shifted all RGB channels by one code at
one antialiased pixel. The hot path now evaluates
`fill + referenceParity * (1.0 - fill.a)`, where two-bit mode metadata makes
`referenceParity` runtime-zero for every valid glyph while retaining the general composition's
rounding. `tests/browser/gpu-scene-reference.pw.ts` runs the formal 1M-label / 100K-mover /
1280×800 / 120-frame fixture through the product single-prototype shader, forced resident
multi-prototype shader, and forced general shader. All three must match the canonical 50,000-entry
GPU identity, pixel hash `0xa8ad90b4`, and 302,457 non-transparent pixels. `tests/GlyphMesh.test.ts`
pins the WGSL expression.

Resident position dispatch has one fixed dependency order: ensure/upload structural cull records,
ensure the shared local-bounds table, bind the current cull buffer plus epoch, dispatch fused
palette/AABB moves, then dispatch culling. Record-buffer growth changes the epoch and rebuilds the
fused bind group. Local-bounds growth follows the same rule. A 100,000-mover wave sends
800,016 bytes through the dense 8-byte exact-f32 lane and increments `cullRecordUploadBytes` by zero
because the GPU writes the resident AABBs in place. Dense eligibility requires sorted, unique,
strictly contiguous active slots within that batch; its 16-byte header carries `baseSlot` and
`count`. Sparse, reordered, duplicate, and holed inputs use the indexed 12-byte fallback with
last-write-wins identity. Two overlapping dense leases retain independent command storage and
encode in commit order, so later commits own the final transform and AABB values.

A commit that moves and removes the same label validates and queues its mover while the slot is
active, then publishes the structural tombstone. The fused mover patches only origin and AABB
fields, so the tombstone's zero instance count remains authoritative. Setup, CPU reconciliation,
the host reference, spatial queries, and WGSL all compute absolute max edges as two explicit f32
adds: round `origin + localMin`, then round `min + extent`. This ordering preserves bit-exact cull,
hit-test, fallback, and GPU results at large coordinates.

`PaletteStoragePass` owns one device epoch. Repeated initialization on the same live device reuses
that epoch; replacement or current-device loss retires its transactions and buffers exactly once,
marks the CPU mirrors for a full sync, and lets the next prepare rebuild. A stale loss promise is
scoped to its captured device and epoch. Dispatch accounting advances after each accepted queue
write, so partial failures publish the exact bytes and write-call count. Preflight workgroup-limit
failures publish zero accepted upload, and a zero-count batch completes as a GPU-free success. The
dispatch-slice pool keeps the three largest idle capacities; active overlapping slices stay
independent and excess idle buffers retire on completion, cancellation, or failure.

Device loss marks that exact `GPUDevice` identity failed in both `PaletteStoragePass` and
`ComputeCullPass`; prepare resumes when the renderer exposes a new identity. Queued work captures
the device plus pass epoch, so every callback releases its owned slice while current-epoch callbacks
alone update sync and failure state. Compute recovery recreates the Pixi indirect `Buffer` and moves
the draw hook with `renderer.encoder`. Palette recovery first rebinds live mesh resources to a
short-lived placeholder, then retires the old bound Pixi `Buffer`; this keeps Pixi's bind group live
for the replacement buffer. A resident full sync uploads local bounds even when the scene snapshot
already consumed its structural dirty flag, then binds the replacement cull-record epoch before
acknowledging recovery.

`WebGPUFrameTransaction` also captures the Pixi encoder epoch. Pixi may replace the encoder while
work is pending or after an old epoch has encoded. Pending stages move to the fresh epoch; encoded
old-epoch stages fail once, and late `renderStart`/`postrender` callbacks only settle the hook they
captured. Publishing old-epoch completion into current palette/cull sync state can acknowledge work
that the replacement encoder never submitted.

Compute initialization classifies capability and device-loss failures as device-fatal, while draw
hook lifecycle failures are hook-transient. The WebGPU backend coalesces repeated transient prepares
within one microtask and retries the same healthy device on the next lifecycle turn; device-fatal
fallback remains keyed to the failed device identity.

Steady WebGPU frames stage that work through one renderer-scoped `WebGPUFrameTransaction`. Palette
slices retain commit order across every layer; each owner retains its latest cull; `renderStart`
encodes all palette stages, then all cull stages, before Pixi's render pass. `postrender` owns the
accepted product submission. Transaction telemetry therefore advances total/fused/standalone by
1/1/0 for each steady camera or position frame.

Product transaction counters and timestamp diagnostic counters describe separate queues of work.
The historical first 600-frame fusion artifact reports product total/fused/standalone as
1,220/1,220/0 and records 1,220 timer-owned timestamp resolve/readback command buffers. It remains
provenance for the pre-ring immediate-readback path. Current acceptance requires full fusion through
`fusedTimestampResolves` and `standaloneTimestampSubmissions`, alongside product submission deltas.

The current schema 7/schema 4 proof records 1,300/1,300/0 formal and 1,220/1,220/0 sustained
readback/fused/standalone timestamp submissions. All 1,300 formal samples resolve palette, cull,
and scene-render segments with zero fallback. Both formal phases record zero frames above
16.67 ms, so repeatability, formal performance, sustained evidence, and promotion are GO.

WebGPU benchmark timestamp readback uses three reusable query/resolve/map slots. Each frame writes
timestamps and encodes one resolve plus copy in the same product encoder, then waits for queue-wide
product completion. Mapping starts when that slot wraps three frames later or when the phase drains;
the slot completes map/unmap before reuse. Monotonic frame tokens restore source order when mapping
promises settle out of order. The formal resident `frameMs` sample is exactly mutation wall plus
timer CPU wall plus queue-wide completion wall. `instrumentationWallMs` and
`timestampReadbackWallMs` retain the excluded slot-retirement and map/read/unmap walls for audit.
The resident budget requires the three-slot mode, an empty ring after phase drain, 260/260 valid
timestamps, one product/fused submission delta per frame, zero product/timestamp standalone
submissions, and the exact additive frame formula.

A failed encode or submit marks the palette and cull mirrors for full synchronization. Recovery
first reconciles the resident mover journal, then republishes current transforms and absolute-AABB
records in a fresh epoch. Destruction keeps staged GPU resources alive through completion or failure
and retires them after the frame hook releases its final owner. Renderer hooks restore when that
owner set reaches zero. Capacity growth may use the separately counted standalone flush before
rebinding a new buffer epoch.

CPU spatial truth uses the same store origin columns and a typed deferred-rehash journal. Camera
commits leave the journal untouched. Position commits append mover slots once. `getBoundsFor`,
`hitTest`, CPU-grid culling, resident fallback, append reconciliation, and destruction flush pending
slots before the grid result is observed. This boundary keeps the steady GPU wave free of CPU grid
work while preserving immediate CPU query semantics.

Stable evidence lives in `tests/TextLayer.gpu-resident.test.ts`,
`tests/GpuResidentScene.test.ts`, `tests/PixiRendererBackend.test.ts`,
`tests/paletteStorage.test.ts`, and the `gpu-scene-resident` browser artifact.

## Resident rigid transforms and layout changes share immutable prototype geometry

A label slot and a resident prototype arena slot have independent lifetimes. Rebinding the first
label of a shared run previously overwrote the geometry still referenced by its neighbors. The
coordinator now allocates a bounded independent arena slot for each new prototype. Text, wrap
width, explicit newlines, and writing mode participate in candidate identity; cached layouts
rebind existing records while retaining geometry and stable label order.

The palette stores packed binary16 `sin(angle), cos(angle)`; identity rotation is `0x3c000000`.
Zero-filled packed rotation collapses the glyph and its AABB. GPU compute probes initialize the
identity word explicitly. CPU AABBs use the same packed trigonometric values and four-corner f32
arithmetic as the shader; identity rotation keeps the historical left-associated additions.
Device/encoder recovery refreshes both origins and rotations from authoritative store columns.

Structural dirty bands can cover an unchanged neighbor whose latest transform still lives in the
GPU. Reconcile pending CPU records before publishing any structural upload. Track reconciliation
separately from the spatial journal so repeated wrap commits pay once per transform wave; CPU
queries still flush their pending grid work. The 100k-mover / 1k-wrap diagnostic exposed 10.9 ms
p95 of repeated commit work and measured 1.7–1.8 ms after this separation.

Evidence: `tests/GpuResidentScene.test.ts` covers banded removal uploads;
`tests/TextLayer.gpu-resident.test.ts` covers shared geometry, wrap, overlapping rotations, and
recovery; `tests/browser/gpu-transform-layout.pw.ts` compares real GPU pixels and sustained counts.

## Collision fast paths require explicit invalidation and density routing

The million-label collision fixture presents monotonic slots in admission order. Passing that proof
through `selectRankedCandidates` removes the reusable rank copy and sort. Long runs of identical
padded bounds cache their leader and length so the selector settles the run once. Any packed record
write must retire every cached run it touches; structural changes retire the full cache. Reusing a
stale run can skip a changed label while preserving plausible counts, so the six-run schema 2 gate
pins selection hash `0x611785c5` alongside 512 labels and 4,096 glyphs. Direct CPU/collision gates
pass.

The high-overlap fixture produces about 630,784 raw grid candidates and 559,104 exact viewport
candidates. Its earlier one-quarter density threshold selected a one-million-entry linear scan.
The current query router uses ordered grid sort through one-quarter density, a reusable ordered
bitset above one quarter and below seven eighths, and a linear scan from seven eighths onward. The
bitset enumerates ascending slots and clears its full touched word range in `finally`, preserving
the next query after an output writer throws. `hitTest` follows the selected route and keeps
mid-density work on the grid. Boundary tests at 1/4 and 7/8 plus randomized brute-force parity
protect these rules. The current WebGPU whole-frame p95 values are 12.2/11.5/11.9 ms and collision
repeatability is GO. Fragmented scenes with a high occupied slot retain an O(high-water/32) bitset
enumeration cost; measure that shape before revising the route.

## Compute culling needs a larger CPU working set than its draw set

When culling has viewport bounds, never instance `SpatialIndex.queryAll()` for compute culling. A
million-label world can exceed the 16,777,216-glyph instance ceiling before the GPU removes
offscreen labels.

Do not instance only the tight draw viewport either. Every camera frame would cross the residency
edge and run the CPU grid again. Query the expanded working viewport with zero query padding, then
let compute culling compact those resident instances against the tight padded draw viewport.

Do not treat a position storm as a residency refresh. A Chrome trace of the homepage demo spent
most of the storm frame in `RenderSurface.#buildDrawSegments` and `GlyphInstanceStore.getRange`
(`Object.freeze({ ...range })` per label) because `hasLabelChanges` re-queried the working set and
repacked every draw state. Position-only commits inside the working set patch resident AABBs and
the palette. Re-query only on show/hide/add/remove or when the camera leaves the working set.

`getRange` must return the live range. Copying and freezing it on every pack or segment walk is the
hot leaf.

Compute scatter no longer reads the store. Upload dirty store bytes into the prototype texture.
Content edits can relocate a range, so record patches must rewrite offset and count, not only the
AABB. Size `instances_out` from logical `activeInstances * 8`, not `highWater * 24`. Shared
duplicates make `highWater` much smaller than the visible glyph count.

`ComputeCullPass.ensureCapacity` pushes the CPU-side indirect args (instance count 0) to the GPU.
An idle compute frame must return before touching it, or the previous dispatch's draw count is
clobbered without a new dispatch to restore it.

Compute-cull keeps run, instance, and palette resources when a label leaves the working set. A
later homepage trace spent the pan windows in `RenderCoordinator.#prepare` / `#ensureGlyph` /
`#buildInstances` because re-entry used `ALL_DIRTY` after a full remove. Its draw state and cull
records follow the tight set, while `remove()` tears the slot down.

WebGL CPU-grid camera exits keep the release path. An unbounded retained-resource candidate grew
heap to 662.3-747.7 MiB as viewport history accumulated. A 65,536-entry O(1) LRU candidate capped
heap at 608.7 MiB and generated 821,675 evictions in the short exact path; position frame p95
reached 561.9 ms, surface p95 reached 485.1 ms, and shaped-label delta reached 69,207. CPU-grid
retention remains paused until a working-set-aware design clears both memory and churn gates.

## Do not drip-feed on-screen labels

Budgeted first-seen waves (`prepareBudgetMs` / `prepareWave` / leftover rAF) hid most of a new
working set and filled it in over later frames. That is rejected: on-screen text must appear in
the commit that first sees it.

The homepage demo follows that rule with a two-phase allocate. It creates every label that
intersects the first camera working set, commits once so that text appears, then allocates the
rest of the million off that view. Do not split the first on-screen set across later commits.
Pass `rendering.transformOptions.initialCapacity` at the million-label size before the first
commit. A first commit on a small palette then a 1M grow replaces the palette `BufferImageSource`;
the next draw fetches empty proto/palette texels and the canvas goes black while `visibleLabelCount`
stays honest.

The hitch those waves were papering over is still real. A homepage pan after a working-set miss
spent 1.89s then 2.65s in layout and raster because compute-cull prepared the padded working set,
not the tight draw view. `retainResources` only helps revisits. New glyphs still need layout and
raster. Do that for labels that intersect the tight draw view. Cache hits in the 0.25-viewport
ring are eligible on the same turn, then gated by `offscreenAdmitBudgetBytes` (32 bytes per
off-screen intern-hit label). Off-screen working-set unique misses stay unshaped until the camera
reaches them.

Do not bring back leftover rAF, `pendingAdmissionCount`, or animation-frame continue. That path
also remirrored the instance buffer every wave and made compute-cull slower than `cpu-grid`.
Resume deferred ring hits by querying the prepare ring on a later commit, or when a leftover
enters the tight view. Do not gate atlas texel uploads for already-instanced glyphs.

Compute-cull must not raster a unique miss that only intersects the prepare ring. The tight
draw view still finishes in that commit, including unique text. Ring copies of a string that
already has an intern, or that has a tight member in the same group, are eligible that turn
and then spend `offscreenAdmitBudgetBytes`. Skip the
rendered-epoch stamp on a dropped ring unique, or a later camera move will think it is done.
Camera motion that stays inside the last prepared ring must still query the tight view for
those leftovers. If the last commit deferred off-screen intern hits, query the prepare ring
again so the budget can resume. Skipping the whole first-seen scan there was only safe when
the ring was fully prepared.

Apply the off-screen CPU work cap before constructing per-label admission material. The stable
prepare-ring query uses a generation plus a numeric result cursor and inspects at most
`offscreenAdmitBudgetBytes / 32` entries per commit. A completed pass wraps to index zero. Ring,
resident revision, visibility, occupancy, and LOD-policy changes start a new generation. Every
inspected query entry advances the cursor, including an already-shaped or tight entry. The tight
query runs first and finishes first-seen labels in the same commit. `TextLayer.stats` reports the
latest inspected/materialized counts plus generation, cursor, resets, cycles, and deferred state.

## TinySDF binary fonts need FontFace

`tinySdf: true` draws the glyph with canvas and runs a local EDT. Binary families are installed
through `FontFace` from the registered bytes. Without `FontFace` (or a document font set) the
canvas would paint a fallback family. Keep `@zappar/msdf-generator` for `mode: "msdf"` and for
hosts that cannot install a face.

Intern `#ensureDocumentFont` / `#installDocumentFont` on family. A tight-view miss burst must
not start N `FontFace.load()` calls for one family. Same-size misses share a microtask batch
so they wait on that load once, then serialize canvas plus EDT. Do not run EDT on a
multi-glyph sheet. Neighbors corrupt distances. Do not reuse one canvas across awaits unless
the work is serialized after fonts are ready.

Intern the physical field at `max(fontSize, distanceFieldMinFontSize)`. A 16px and 32px
request of the same glyph must not run EDT or MSDF twice. TinySDF keys omit `glyphId`
because canvas paints `glyphText`; ligatures stay distinct texts. Sizes above the minimum
are separate physical rasters. Atlas entries stay per size bucket so instance
`rasterScale` stays honest. Do not put logical `fontSize` in the physical key.

HarfBuzz runs carry exact UTF-16 spans as transferable `clusters` plus `clusterEnds` arrays.
`RenderCoordinator` slices `glyphText` only for a cold raster miss, keeping per-glyph strings and
worker clones out of shaping. The canonical `variationKey` flows through worker serialization,
atlas identity, exact raster identity, physical field identity, and MSDF/TinySDF batch identity;
`fontWeight` participates in those raster identities too. A request with variation axes uses the
dynamic path because prebuilt keys describe a static font instance. The generator still consumes
the registered static font bytes, so precise variable outlines use a registered static instance at
that axis location as documented in [`docs/fonts.md`](../../docs/fonts.md#glyph-id-rasterization).
The exact cluster span stays on the request and cache key. The MSDF generator boundary receives one
Unicode scalar from the cmap-prepared mapping, which keeps base glyphs inside shared mark clusters
addressable by character-only atlas generators.

## Variation cache identities validate before lookup

`HarfBuzzShaper.shape` and `LayoutEngine.layout` validate the variations record, four-code-unit
axis tags, and finite numeric values at their public boundaries. The sorted `tag=value,...` form
remains the stable public `PositionedRun.variationKey` diagnostic. Internal shaped-run and font
resource identities encode every tag/value pair with `encodeCacheKey`, then encode the ordered pair
list again. This nested length-prefix form separates `{ abcd: 1, efgh: 2 }` from the malformed
`{ "abcd=1,efgh": 2 }`, whose diagnostic serialization would otherwise match. Cache lookup must
follow boundary validation so a prior legal entry cannot admit malformed input.

## Worker shaping and HarfBuzz GPU use independent version lines

The packaged Worker SIMD experiment compiles HarfBuzz 11.2.1 commit
`33a3f8de60dcad7535f14f07d6710144548853ac` with Emscripten 3.1.12, `HB_TINY`,
variable-font support, `-O3`, and a `-msimd128` variant. HarfBuzz GPU Draw remains pinned to
14.4.0 under its own source, license, and artifact chain. The Worker assets carry the HarfBuzz
permissive license and full flags, SHA-256, raw/gzip sizes, and instruction counts in
`benchmarks/shaping-simd/wasm/provenance.json`.

The standard SIMD runtime payload is 418,675 raw bytes and 138,827 gzip bytes. It is smaller than
the pinned `harfbuzzjs@1.6.0` Wasm by 3,289 raw bytes and 32,189 gzip bytes. Staging the payload plus
license and provenance into the current npm tarball adds 422,909 unpacked bytes and four entries;
the captured tarball delta is 141,817 bytes. Publication stays behind the human package-approval
boundary.

Five fresh scalar Workers and five fresh SIMD Workers produce exact output across CJKV, Arabic,
Devanagari, Hebrew, and Thai. The formal production-path run records scalar 54.08 ms and SIMD
55.44 ms means, a 2.51% regression, and a 1.96 ms combined-variance threshold. The decision is
`HOLD (variant-regression)`. LTO grows the SIMD
Wasm to 519,900 bytes and records a 0.98% regression. Relaxed-SIMD produces the same bytes as the
standard SIMD build under this toolchain. Evidence lives in
`benchmarks/results/shaping-simd-worker-1.2.0.json`, `tests/shaping-simd-runtime.test.ts`, and
`tests/browser/shaping-simd-worker.pw.ts`.

Do not raster or instance a single White_Space or default-ignorable scalar. Those fields
sit below the 0.5 contour, so skipping the quad is pixel-identical. Keep Ogham U+1680 —
it is White_Space and often paints. Do not skip `source === "trusted"`, ligatures, or a
glyph that shares its cluster with a mark. Identify the scalar from `glyphKeys` or
`codePointAt(cluster)`; do not `Array.from` the remaining text on this path. An empty
TinySDF mask skips both EDTs and encodes zeros. CJK and other ink still generate.

## Prebuilt glyph keys omit font revision

`prebuiltGlyphKey` v2 is family, glyph id, glyph text, rounded size, weight, and mode encoded under
the `pixi-glyphflow/prebuilt/v2:` prefix with UTF-16 length-prefixed fields. Embedded NUL code units
therefore preserve tuple boundaries. `PrebuiltGlyphProvider` canonicalizes valid legacy six-field
NUL keys at ingestion and lookup, so existing prebakes keep serving exact and physical-size
requests. A key whose legacy family begins with the v2 prefix first attempts v2 decode, then uses
the legacy six-field parser when that decode yields no valid tuple. A malformed v2-looking record
remains an opaque raw key and serves exact raw lookup only. The physical-rematch identity uses the
same v2 length-prefix encoding. Regression proof lives in `tests/glyph-providers.test.ts` under the
exact lookup, legacy lookup, prefix-family migration, malformed raw lookup, and physical-size
rematch collision fixtures. A re-registered family keeps the same page. `fontRevision` stays
outside the bake key. A page baked for different bytes under the same family name is a product
configuration error.

`charsetSdfPrebuilt` memoizes its `(family, fontWeight, physicalSize, sortedCharset)` tuple with
`encodeCacheKey` too. The regression in `tests/prebuilt-charset-sdf.test.ts` separates
`("a\u0000b", "48", 49, "x")` from `("a", "b\u000048", 49, "x")` and requires both rasterizers
to paint once.

Its public page ids use the `pixi-glyphflow/charset-sdf/v2:` prefix followed by
`encodeCacheKey([family, physicalSize, pageIndex])`. The earlier hyphen format collapsed family
`"a"` at physical size `1e-7` with family `"a-1e"` at physical size `7` onto
`charset-sdf-a-1e-7-0`, which made `mergePrebuilt` reject the pair. Applications that persist
generated charset pages should rebake them once during migration. A self-contained legacy payload
remains readable because each glyph record still references its stored page id verbatim. The exact
fixture constructs one `PrebuiltGlyphProvider` from both v2 outputs.

HarfBuzz `glyphId` values are font-specific. A family page keyed with `glyphId: 0` still hits
when the request is a single Unicode scalar. Ligatures and multi-scalar `glyphText` stay
exact-key only. A distance-field page also hits when `fontSize * (rasterScale ?? 1)` equals
`max(request.fontSize, distanceFieldMinFontSize)`. A 14px charset bake therefore crops a 13px
or 32px first sight. Do not rematch a native-size page (no `rasterScale`, or a different
physical size) onto a larger request — `uiSdfPrebuilt` at 16 px must not serve 32 px. Do not
put default pages on `src/index.ts` or `src/advanced/index.ts`.
`pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) is a side export: first call encodes a public-domain
VGA 8×8 set at 16 px only (`rasterScale` cannot be below 1). Later calls remap keys. This is
not production typography and is not wired into the homepage CJK demo.

`charsetSdfPrebuilt` bakes host text with the same TinySDF path. It does not ship CJK bitmaps.
Paint after `FontFace.load` or inject `rasterize`. Empty-ink scalars are omitted. Logical sizes
that clamp to `distanceFieldMinFontSize` store `rasterScale`. `mergePrebuilt` concatenates
family pages. The homepage demo bakes its language samples this way so first-seen CJK is a
crop. A host that bakes once at 14 px does not need a second bake for 13 px. Do not put those
pages on `src/index.ts`. Adopted prebuilt crops intern into the physical field table so a
later clamp size is a lookup, not a second crop.

## LOD remirrors only when labels cross one pixel

`culling.lod` uses `fontSize * scaleY * worldScaleY`. Zoom inside a working set does not remirror
the instance store unless a label crosses the one-pixel line. Position storms stay on palette
patches. A camera move that does refresh residency still keeps rendered position-only movers on
`writePositions`. Do not rebuild per-label snapshots for those slots. Do not treat every camera
frame as a residency refresh when LOD is on.

## Stamp the rendered epoch on unchanged visible labels

`#buildRenderChanges` stamps `#renderedEpochs[slot] = nextEpoch` for every resident it intends to
keep. `getDrawStates()` treats a stale epoch as an exit. Skipping `wasRendered && dirty === None`
before that stamp drops the unchanged sibling. The compositing fixture then keeps one normal mesh
after a z-raise instead of two.

Do not move the dirty-none continue above the epoch stamp. Off-screen unshaped working-set labels
still skip before the stamp so they never enter the draw set.

## Live atlas keys keep exact shaping identity

Default-axis packed identities are family intern + glyph id + size bucket + weight class + mode + font revision. Rasterize uses the same size bucket as the key. Canonical variation-axis identities use the diagnostic string form and include `variationKey`. String keys also cover `atlas-pressure` (`glyph-${index}`), prebuilt pages, non-BMP text with glyph id 0, and unusual weights. HarfBuzz glyph ids supply exact font-local identity while the cold raster request receives text sliced from its cluster span. Instance attributes retain the packed uint path supported by CI Chrome/ANGLE.

## Budget checks fall back to the newest older formal artifacts

`benchmark:check` loads `results/browser-<workload>-<packageVersion>.json` when that file exists,
otherwise the newest older formal file for the same workload. Exploratory files and newer versions
than `package.json` are ignored. CI and `release:check` share that rule, so a version bump can
publish without renaming 1.1.0 measurements into 1.2.0 names.

`--require-current` still exists for a local gate that refuses a version with no matching files.
Do not turn it on in the publish workflow until the reference M1 Pro Chrome suite has been rerun.

## The browser benchmark page must stay free of node builtins

`benchmarks/browser/*` runs in Chrome through Vite. Any VALUE import from a module whose top level
touches `node:os` (or other node builtins) breaks the page before `__glyphflowBenchmark.done` is
set, and every browser workload then "times out" instead of failing loudly. Wave 0 did this by
importing `BENCHMARK_SCHEMA_VERSION` from `schema.ts` while `benchmarkRuntime()` lived there; the
suite was unrunnable until `benchmarks/runtime.ts` took the node-only half. Keep `schema.ts`
isomorphic; put node-only helpers in `runtime.ts`. Type-only imports are safe.

## Dirty uploads do not collapse leftover ranges into one first-to-last span

`DirtyRanges.publish` still merges a 256-byte gap and promotes when dirty bytes reach 75% of the
live span. After that, more than eight ranges land in equal-width bands of the first-to-last
interval. Two tight clusters stay two uploads. A uniform scatter that fills every band still
covers the live span and then hits the 75% whole-buffer rule. Do not restore the old single
first-to-last collapse to "keep the 8-range cap simple."

## Wiping the rendered set must dirty visibility

`#resetRenderedSet` (attach, detach, a failed render tail) clears rendered epochs. The next
commit has to walk residents again and rebuild draw states. That flag is `visibilityDirty`.
Do not treat a post-attach camera-only commit as a no-op just because no viewport exists.

## A commit with no viewport does not re-query every resident

`shouldRefreshResidency` used to treat a missing draw viewport as "refresh." `dynamic-counters`
and other `culling: false` workloads then called `queryAll` on every commit. Hide, show, remove,
and group visibility still set `visibilityDirty`. Creates do not: after the first residency
query they join through `#buildResidentDirtyChanges`, which admits unrendered dirty slots that
belong in the current set. Camera motion only matters once a draw viewport exists. Clearing a
previous viewport still refreshes, because the last instanced working set would otherwise stay
as the visible set.

Do not restore `visibilityDirty` on `create` / `createMany` when a coordinator exists. That
forces a full resident scan on every admission. Layers without a coordinator still flip the
flag so `visibleLabelCount` stays honest on the `rendering: false` path.

## Duplicate-string layout intern keys on face plus text

`RenderCoordinator` reuses a layout result for later labels that share family, size, weight, and
text (or the same interned style object). A font register or unregister bumps
`FontRegistry.stats.revision` and drops that intern so a new face cannot keep a stale run.

Shaping overrides, vertical writing, and italic faces skip the face map and use a slower extra
key. Do not intern trusted runs; those stay per-label.

## Bitmap layout cache keys preserve caller tuple boundaries

`BitmapLayoutAdapter` builds its cache key before constructing PixiJS `TextStyle`: text, stable
style identity, font revision, cache revision, direction, trim policy, maximum lines, and
ellipsis. Pass the complete eight-field tuple to `encodeCacheKey`; its UTF-16 length prefixes keep
embedded NUL code units inside the caller's text or ellipsis field. A delimiter join allowed one
request to append the six-field middle to text and another to prepend that middle to ellipsis, so
the second layout reused the first request's `PositionedRun`. The two collision fixtures in
`tests/layout.test.ts` assert distinct run identity, text, and glyphs for default and explicit
layout policies.

Content-plus-position commits with default zero anchors patch palette x/y only. Non-zero anchors
still rewrite the fill record because packed anchors are `anchor * run bounds`.

Rendered labels that share one interned (text, style) pair take `applyContentLane` instead of
per-label snapshots. A mixed-text dirty wave, a shaping/layout/trusted side table, a non-zero
anchor, or a non-unit scale/rotation forces the object path for the whole content group. Do not
put first-seen unrendered slots on that lane: they still need a full palette write, which is
`applyAdmitLane` / `writeFills`, not `writePositions`.

`cloneMany` writes dest ranges from one source and bumps `segmentEpoch` once. Atlas key retain
adds the column's extra refs in one pass; dests that already share the prototype key array are
skipped. `placeMany` writes the shared local box and rehashes. World AABB is origin plus that
box. `TextLayer` aliases `TextStore` x/y as the origin, so a position storm writes x/y once.
`rehashCurrent` only rebuckets. Do not call `spatial.set` per content-lane slot. Do not call
`spatial.translate` per mover. Bind origins before insert, or only to grown copies of the same
values. Spill (oversize or unhashed) still goes through `#cellFor`. Standalone `translateMany`
still slides owned origins. Aliased origins already moved with the store, so `translateMany`
must not add the delta again.

Duplicate strings share one instance block. Do not bake dest palette indices into those bytes —
scatter and the CPU compact mesh write `paletteIndex` from the cull record or draw span (`slot`).
Draw records are `(storeGlyphIndex, paletteIndex)`. Shaders fetch rect/UV/metadata. One mesh per
unique string, instanced by label count, is not the default: it drops insertion order and explodes
when texts are unique.
`set` on a shared dest must copy-on-write. `clone` still copies exclusively; the live path uses
`share` / `shareMany`. `clone` / `cloneMany` of a dest that already shares must copy-on-write.
In-place write would patch the prototype palette. A second `share` onto dests that already point
at the source does not bump `segmentEpoch`. Compact unique offsets once; do not size the packed
buffer from the logical instance sum.

Rendered unit-transform labels skip the intake estimate rehash on `updateTextPositions` when a
coordinator will rewrite the box from the run at commit. Unrendered slots, non-zero anchors, and
scaled or rotated labels still reindex at intake so hit bounds do not wait on a path that may
not run.

`updateTextPositions` keeps the position-only transform kind even when text changes. After
layout, rewrite that box from the run: `placeMany` for the shared-string group; the object path
must still do it when `mask` includes Content. Skipping every `positionOnly` change leaves hit
bounds stale.

First-seen fill-only labels (visible, z 0, normal blend, alpha 1, unit transform, zero anchors,
no stroke or trusted run) group by interned (text, style) and take `applyAdmitLane`. Tight
first-seen must skip a slot already stamped for this commit, or a create-plus-camera frame
would admit the same slot twice. Scale, rotation, anchors, z-index, and effects stay on the
object path so `writeFills` does not lie about the fill record. Unique groups prepare together.
Do not `await` `#prepareSharedColumn` per group; that made a tight-view wave the sum of each
string. `atlas.commitFrame` and the instance/palette writes stay after that wave.
Unique groups that share a `style.fill` identity concatenate into one `writeFills`. Do not
merge instance columns or draw-state inserts across strings. Different fill objects that
happen to resolve to the same color stay two writes.

## Palette row uploads must stay 256-byte aligned when taller than one row

`uploadFloatTextureRanges` stacks contiguous full palette rows into one `texSubImage2D` /
`writeTexture`. WebGPU requires `bytesPerRow % 256 === 0` when `height > 1`. The default 1024
texel width is 16 KiB per row and is aligned. Narrow palettes (unit tests use width 8) stay
row-by-row so WebGL and WebGPU share the same rectangles. Do not pad `bytesPerRow` — the CPU
buffer has no row padding. WebGL `rgba32float` palette dirties blank on any GPU rewrite of
the bound texture after the first `initializeTexture` (`texSubImage2D` and a second
`texImage2D` of the same object). Unbind the mesh sampler and GL units, dirty-upload
the same object, then rebind.

## Spatial queries with dense results must not pay the grid sort

Hash-grid output restores insertion order with an `O(K log K)` sort. A mid-zoom viewport at one
million labels returns hundreds of thousands of hits, and the sort alone cost ~37 ms per frame
(viewport-zoom 38.2 ms vs 9.0 ms on the 1.1.0 linear scan, same machine). `#shouldScanLinear` must
stay result-aware: it sums candidate bucket sizes with an early exit and falls back to the
ascending dense scan once candidates exceed a quarter of all entries. Do not judge the grid by
small-viewport queries alone; zoom sweeps cross the density spectrum.

## Do not fail CI on the 1.1.0 atlas-pressure frame

`atlas-pressure` frame p95 is 638.50 ms in the published 1.1.0 artifact. Wave 1 changed the packer in source, but the committed artifact is still the old run. Measure the frame p95; do not add a 16.67 ms fail gate against that file. Same rule as the deferred 40 KiB gzip check.

## Async glyph rasters publish inside their captured render lifetime

A glyph raster promise can settle after a newer commit, font re-registration, renderer attach,
detach, or layer destruction. Before the lifetime guard, a late `O` raster staged after the `N`
commit and appeared as one atlas upload in the following transform-only frame. Reattaching also
left the destroyed coordinator installed, so the next commit reached
`RenderCoordinator has been destroyed`.

Each cold atlas request now carries one internal render token: layer lifecycle epoch, coordinator
ticket and destination identity, label source revision, font revision, and atlas request
generation. `RenderCoordinator` validates the token before staging; its package-internal atlas
bridge publishes the exact destination and ticket; public `GlyphAtlas.commitFrame()` publishes
caller-owned requests. An injected atlas retains caller lifecycle ownership, and coordinator
destruction discards only that coordinator's staged frame. `TextLayer` rechecks coordinator,
surface, and epoch after every awaited render phase.

The default lazy provider also owns a `RasterGlyphProvider`. Destruction marks the provider while
an alpha, color, TinySDF, or MSDF operation may still be running. Provider disposal emits one
internal typed signal at lazy initialization, batch start, and post-raster cache publication. The
coordinator consumes that signal only after its captured scope retires and routes the token through
the stale path. Rasterizer and provider errors from the active lifetime keep their original
rejection. Attach, detach, and destroy fixtures exercise the internally owned provider, atlas, and
instance store.

Render tickets and atlas generations invalidate superseded cold requests. Source revision remains
part of each token. The coordinator stores lifetime metadata only for pending glyphs; million-label
residency therefore adds zero per-slot Map entries. `RenderCoordinator.stats.staleGlyphResults`
counts rejected raster completions.

Stable evidence lives in `tests/RenderCoordinator.test.ts`,
`tests/GlyphAtlas.test.ts`, and `tests/TextLayer.render-lifecycle.test.ts`.

## SAB consumers claim ahead while writers reclaim a contiguous prefix

The shape-result ring advances two independent monotonic sequences. The consumer moves
`ClaimSequence` as each ready slot becomes `Leased`, which lets a `slotCount: 2` same-family
`Promise.all` batch hold both zero-copy results at once. The writer moves `ReclaimSequence` only
across the contiguous prefix of `Released` slots. An out-of-order lease release changes that slot
to `Released`; its capacity returns after every earlier lease is released and reclamation reaches
the slot.

A shared claim/reclaim cursor stalled the second result behind the first live lease. Preserve the
separate sequences and keep slot reuse on the writer's contiguous-prefix rule so every leased typed
view stays stable until its explicit release.

`ownedPositionedRun` may first materialize a copy while its lease is active. A first materialization
after that borrower is released or the shared lease state is settled throws
`Positioned-run lease has already been released`. An owned copy cached before release remains safe
to return after release; later slot reuse changes the SAB view while the cached `ArrayBuffer` bytes
stay stable.

Stable evidence lives in `tests/sab-layout-lease.test.ts`, `tests/sab-shape-transport.test.ts`,
`tests/sab-worker-shaping.test.ts`, and `tests/browser/sab-shape-transport.pw.ts`.

## Shape worker commands need bounded keyed lanes

`HarfBuzzWorkerShaper` admits at most 1,024 commands by default, with a configurable
`maxQueueDepth`. One lane serializes register, shape, and unregister work for each font family.
Independent families occupy independent lanes and can progress concurrently. The worker repeats
the same family ordering guard, so direct protocol clients receive the same command semantics.

Font revisions keep a per-family high-water mark across unregister and equal-revision reload.
Label revision tracking exists only while an admitted shape remains pending. One million
`invalidate()` calls for labels without pending shapes create zero label revision entries.

Queued older revisions settle with `StaleShapeResultError`; active older revisions settle through
the stale-result path. `queueOverflows`, `cancelledRequests`, and `staleResults` expose the three
outcomes separately. `destroy()` settles active and queued promises, clears tracked labels, and
terminates the worker. Queue accounting reaches its final value before each command promise
settles.

A Worker module load, execution, or response-deserialization failure arrives through `error` or
`messageerror`, with no protocol response for the pending request. Treat either event as a fatal
shaper state: persist one `HarfBuzzWorkerError`, close all keyed lanes with that same error, reject
every pending request, clear font and label state, detach every Worker listener, terminate the
Worker, and release the optional SAB transport. Later public operations fail with the persisted
error. `destroy()` remains an immediate idempotent cleanup after this path.

Stable evidence lives in `tests/worker-scheduling.test.ts`,
`tests/worker-font-revisions.test.ts`, `tests/worker-serialization.test.ts`, and
`tests/worker-shaping.test.ts`.

## HarfBuzz GPU draw failures and no-ink blobs are separate states

`hb_gpu_draw_glyph_or_fail()` returning false is a draw failure and gates the spike. A successful
draw may still produce HarfBuzz's zero-length singleton blob with zero extents; the five fixture
spaces exercise that successful no-ink state. Count draw failures, encode failures, and empty blobs
separately so every missing outline fails the Go/No-Go decision.

Worker `register-font` replacement is transactional: create the candidate, destroy the currently
published font, then atomically publish the candidate mapping. A failure while destroying the old
font retains the old mapping and moves any surviving candidate into pending cleanup. `dispose`
retries that cleanup and releases each successful handle exactly once. The two fault regressions in
`tests/hb-gpu-worker.test.ts` cover old-font failure plus candidate cleanup failure while preserving
the old-font error as the response.

The throughput sample and determinism repeat run sequentially. The primary 128-iteration run owns
the encode distribution; the one-iteration repeat owns the blob/extents hash. Parallel native
processes contend for the same CPU and inflate the measured latency. Extents participate in the
hash and artifact so the packed browser spike consumes the same quad bounds that were encoded.

Stable evidence lives in `tests/hb-gpu-benchmark.test.ts`, `benchmarks/hb-gpu/native.c`, and
`benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json`.

## Benchmark artifact pruning follows the evidence graph

Current formal artifacts and legacy captures consumed by tests or hash-locked evidence remain
versioned. Thirteen byte-exact raw sources use deterministic `.json.gz` storage with a manifest that
pins logical filename, uncompressed bytes, archive bytes, and SHA-256. `bun
scripts/benchmark-artifact-archive.ts materialize` restores the original `.json` files for formal
reruns; verification hashes the restored bytes. This archive layer stays outside the frozen browser
harness closure, so storage compaction preserves the recorded build, harness, runtime, and candidate
fingerprints.

Nine superseded legacy captures with zero repository references stay on disk and have exact-path
ignore entries. The ad-hoc `benchmarks/gpu-resident-compute.results.json` runner output has its own
exact ignore entry. `benchmarks/results/budgets-1.2.0.json` is a derived local gate dump; raw sealed
artifacts plus `benchmarks/PERFORMANCE.md` carry the reviewable evidence. Classify by report, test,
aggregate, and provenance references before adding an artifact rule.

## Symbol continuity needs source deltas before product integration

Map symbol continuity tracks logical identity separately from tile/anchor candidates. A frame may
submit overlapping old/new tile candidates for one logical symbol; selection order is f32 priority,
retained candidate, insertion order, then typed candidate and anchor identity. Source presence and
collision placement use separate epochs. A continuously sourced collision loser keeps its id and
retained history while visual opacity fades. Source-retention TTL advances only after a full frame
without a candidate.

The index exposes staged `beginFrame` / `endFrame` transactions and explicit `abortFrame()`.
Provisional ids stay outside committed reads, reclaimed tombstones retain undo snapshots, and the
commit pass validates touched invariants before changing retained state. The state hash includes
typed keys, candidate and anchor identity, f32 priority, per-symbol revisions, fade transition
state, and retire deadlines using bit-level numeric encoding. `reserve()` moves growth outside a
hot admission frame; the project ceiling is 1,048,576 tracked records and u32 identity exhaustion
is terminal.

`stateHashMode: "manual"` is the high-performance default. `computeStateHash()` scans the latest
committed state at an inactive WAL checkpoint; `"every-frame"` folds the same bytes into the single
commit/absence scan. The current 100k checkpoint costs about 14 ms as an explicit diagnostic, while
both sampled frame modes clear 16.67 ms p95 locally. TextLayer integration follows the Revisioned
Scene WAL/delta path so explicit removals and patches replace the remaining absence scan.

Stable evidence lives in `tests/symbol-continuity.test.ts` and
`benchmarks/symbol-continuity.ts`.

## Sparse strips bind identity, cache ownership, and peak memory

Every sparse coverage cache key carries the schema, family, font revision, glyph id, variation key,
power-of-two physical pixel bucket, padding, and AA mode. Padding changes bitmap geometry, and AA
mode changes every boundary payload. The cache owns cloned typed arrays at insertion and returns
cloned views at lookup, so caller mutation stays outside retained state. A candidate larger than the
cache ceiling is rejected before LRU mutation; existing entries and recency remain intact.

The encoder uses a two-pass typed build: one compact tile-kind scratch array counts records and
boundary coverage, then exact `Uint32Array` and `Uint8Array` payloads are allocated and filled.
Performance reports carry final allocated bytes, encoding scratch bytes, and peak payload bytes.
The WebGPU adapter preserves byte offsets for concatenated unaligned coverage and word offsets for
strip records. Every atlas dimension, placement coordinate, cumulative offset, typed allocation,
and dispatch-uniform allocation passes explicit u32 and safe-arithmetic preflight before data enters
a typed array. Packing and copied quad metadata complete before the first pipeline await, closing
the caller-mutation window. Placement validation uses sweep-line range-max accounting, and exact
workgroup-size dispatch groups bound thread padding per glyph. The browser gate compares a real
HarfBuzz glyph at 256 and 512 pixels against the CPU reference with a maximum channel delta of two,
a repeated stable hash, two dispatch groups, and a dispatch/effective ratio at most 1.15. Sustained
atlas-pressure and stable-atlas-hit evidence own the product-promotion decision.

Stable evidence lives in `tests/outline-sparse-strips.test.ts`,
`tests/outline-sparse-strip-compute.test.ts`,
`tests/browser/outline-sparse-strip.pw.ts`, and `benchmarks/sparse-glyph-strips.ts`.
