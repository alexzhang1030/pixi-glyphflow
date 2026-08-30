import { PALETTE_PATCH_WORKGROUP } from "./paletteStorage";

const MOVE_PARAMS_WGSL = `struct MoveParams {
  base_slot: u32,
  count: u32,
  record_count: u32,
  local_bounds_count: u32,
}`;

const CULL_RECORD_WGSL = `struct CullRecord {
  min_x: f32,
  min_y: f32,
  max_x: f32,
  max_y: f32,
  instance_offset: u32,
  instance_count: u32,
  palette_index: u32,
  local_bounds_index: u32,
}`;

const PATCH_TARGET_BINDINGS_WGSL = `@group(0) @binding(2) var<storage, read_write> transforms: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> records: array<CullRecord>;
@group(0) @binding(4) var<storage, read> local_bounds: array<vec4<f32>>;`;

export const PALETTE_PATCH_WGSL: string = /* wgsl */ `
${MOVE_PARAMS_WGSL}

struct MoveCommand {
  slot: u32,
  x: f32,
  y: f32,
}

${CULL_RECORD_WGSL}

@group(0) @binding(0) var<uniform> params: MoveParams;
@group(0) @binding(1) var<storage, read> commands: array<MoveCommand>;
${PATCH_TARGET_BINDINGS_WGSL}

const WORKGROUP: u32 = ${String(PALETTE_PATCH_WORKGROUP)}u;

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_xy(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let command = commands[id.x];
  let base = command.slot * 2u;
  var texel = transforms[base];
  texel.x = command.x;
  texel.y = command.y;
  transforms[base] = texel;
}

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_xy_and_cull(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let command = commands[id.x];
  let base = command.slot * 2u;
  var texel = transforms[base];
  texel.x = command.x;
  texel.y = command.y;
  transforms[base] = texel;
  if (command.slot >= params.record_count) {
    return;
  }
  var record = records[command.slot];
  if (record.local_bounds_index >= params.local_bounds_count) {
    return;
  }
  let bounds = local_bounds[record.local_bounds_index];
  let min_x = command.x + bounds.x;
  let min_y = command.y + bounds.y;
  record.min_x = min_x;
  record.min_y = min_y;
  record.max_x = min_x + bounds.z;
  record.max_y = min_y + bounds.w;
  records[command.slot] = record;
}
`;

export const PALETTE_DENSE_PATCH_WGSL: string = /* wgsl */ `
${MOVE_PARAMS_WGSL}

struct DenseMoveCommand {
  x: f32,
  y: f32,
}

${CULL_RECORD_WGSL}

@group(0) @binding(0) var<uniform> params: MoveParams;
@group(0) @binding(1) var<storage, read> commands: array<DenseMoveCommand>;
${PATCH_TARGET_BINDINGS_WGSL}

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_xy_dense(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let slot = params.base_slot + id.x;
  let command = commands[id.x];
  let base = slot * 2u;
  var texel = transforms[base];
  texel.x = command.x;
  texel.y = command.y;
  transforms[base] = texel;
}

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_xy_and_cull_dense(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let slot = params.base_slot + id.x;
  let command = commands[id.x];
  let base = slot * 2u;
  var texel = transforms[base];
  texel.x = command.x;
  texel.y = command.y;
  transforms[base] = texel;
  if (slot >= params.record_count) {
    return;
  }
  var record = records[slot];
  if (record.local_bounds_index >= params.local_bounds_count) {
    return;
  }
  let bounds = local_bounds[record.local_bounds_index];
  let min_x = command.x + bounds.x;
  let min_y = command.y + bounds.y;
  record.min_x = min_x;
  record.min_y = min_y;
  record.max_x = min_x + bounds.z;
  record.max_y = min_y + bounds.w;
  records[slot] = record;
}
`;

export const PALETTE_TRANSFORM_SCATTER_WGSL: string = /* wgsl */ `
struct ScatterParams {
  count: u32,
  effectBase: u32,
  _pad0: u32,
  _pad1: u32,
}

struct TransformCommand {
  slot: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  core0: vec4<f32>,
  core1: vec4<f32>,
  effect: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: ScatterParams;
@group(0) @binding(1) var<storage, read> commands: array<TransformCommand>;
@group(0) @binding(2) var<storage, read_write> transforms: array<vec4<f32>>;

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn scatter_transform(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let command = commands[id.x];
  let base = command.slot * 2u;
  transforms[base] = command.core0;
  transforms[base + 1u] = command.core1;
  if (params.effectBase > 0u) {
    transforms[params.effectBase + command.slot] = command.effect;
  }
}
`;
