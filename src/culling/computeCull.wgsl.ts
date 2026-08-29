import { CULL_WORKGROUP } from "./computeCull";

export const COMPUTE_CULL_WGSL: string = /* wgsl */ `
struct CullRecord {
  min_x: f32,
  min_y: f32,
  max_x: f32,
  max_y: f32,
  instance_offset: u32,
  instance_count: u32,
  palette_index: u32,
  _pad1: u32,
}

struct Viewport {
  x: f32,
  y: f32,
  width: f32,
  height: f32,
  padding: f32,
  label_count: u32,
  use_gpu_origin: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> records: array<CullRecord>;
@group(0) @binding(2) var<storage, read_write> counts: array<u32>;
@group(0) @binding(3) var<storage, read_write> prefix: array<u32>;
@group(0) @binding(4) var<storage, read_write> group_sums: array<u32>;
@group(0) @binding(5) var<storage, read_write> instances_out: array<u32>;
@group(0) @binding(6) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(7) var<storage, read> transforms: array<vec4<f32>>;

const WORKGROUP: u32 = ${String(CULL_WORKGROUP)}u;
const UINTS_PER_DRAW: u32 = 2u;

fn world_box(record: CullRecord) -> vec4<f32> {
  var min_x = record.min_x;
  var min_y = record.min_y;
  var max_x = record.max_x;
  var max_y = record.max_y;
  if (viewport.use_gpu_origin != 0u) {
    let origin = transforms[record.palette_index * 2u].xy;
    min_x += origin.x;
    min_y += origin.y;
    max_x += origin.x;
    max_y += origin.y;
  }
  return vec4<f32>(min_x, min_y, max_x, max_y);
}

fn visible(record: CullRecord) -> bool {
  let box = world_box(record);
  let left = viewport.x - viewport.padding;
  let top = viewport.y - viewport.padding;
  let right = viewport.x + viewport.width + viewport.padding;
  let bottom = viewport.y + viewport.height + viewport.padding;
  return box.z >= left && box.x <= right && box.w >= top && box.y <= bottom;
}

@compute @workgroup_size(${String(CULL_WORKGROUP)})
fn mark_visible(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= viewport.label_count) {
    return;
  }
  let record = records[index];
  counts[index] = select(0u, record.instance_count, visible(record));
}

var<workgroup> scratch: array<u32, ${String(CULL_WORKGROUP)}>;

@compute @workgroup_size(${String(CULL_WORKGROUP)})
fn scan_counts(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
  let index = group.x * WORKGROUP + local.x;
  var value = 0u;
  if (index < viewport.label_count) {
    value = counts[index];
  }
  scratch[local.x] = value;
  workgroupBarrier();
  var offset = 1u;
  while (offset < WORKGROUP) {
    var sum = scratch[local.x];
    if (local.x >= offset) {
      sum += scratch[local.x - offset];
    }
    workgroupBarrier();
    scratch[local.x] = sum;
    workgroupBarrier();
    offset *= 2u;
  }
  if (index < viewport.label_count) {
    var exclusive = 0u;
    if (local.x > 0u) {
      exclusive = scratch[local.x - 1u];
    }
    prefix[index] = exclusive;
  }
  if (local.x == WORKGROUP - 1u) {
    group_sums[group.x] = scratch[local.x];
  }
}

@compute @workgroup_size(1)
fn scan_group_sums() {
  let groups = (viewport.label_count + WORKGROUP - 1u) / WORKGROUP;
  var running = 0u;
  for (var group = 0u; group < groups; group++) {
    let sum = group_sums[group];
    group_sums[group] = running;
    running += sum;
  }
  indirect[0] = 6u;
  indirect[1] = running;
  indirect[2] = 0u;
  indirect[3] = 0u;
  indirect[4] = 0u;
}

@compute @workgroup_size(${String(CULL_WORKGROUP)})
fn scatter(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= viewport.label_count) {
    return;
  }
  let count = counts[index];
  if (count == 0u) {
    return;
  }
  let group = index / WORKGROUP;
  let dest = prefix[index] + group_sums[group];
  let record = records[index];
  let srcBase = record.instance_offset;
  let palette = record.palette_index;
  for (var glyph = 0u; glyph < count; glyph++) {
    let dst = (dest + glyph) * UINTS_PER_DRAW;
    instances_out[dst] = srcBase + glyph;
    instances_out[dst + 1u] = palette;
  }
}
`;
