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

const ROTATED_AABB_WGSL = `fn patch_record_aabb(
    record: CullRecord,
    origin: vec2<f32>,
    bounds: vec4<f32>,
    rotation: vec2<f32>,
) -> CullRecord {
    if (rotation.x == 0.0 && rotation.y == 1.0) {
        var translated = record;
        translated.min_x = origin.x + bounds.x;
        translated.min_y = origin.y + bounds.y;
        translated.max_x = translated.min_x + bounds.z;
        translated.max_y = translated.min_y + bounds.w;
        return translated;
    }
    let left = bounds.x;
    let top = bounds.y;
    let right = left + bounds.z;
    let bottom = top + bounds.w;
    let p0 = origin + vec2<f32>(left * rotation.y - top * rotation.x, left * rotation.x + top * rotation.y);
    let p1 = origin + vec2<f32>(right * rotation.y - top * rotation.x, right * rotation.x + top * rotation.y);
    let p2 = origin + vec2<f32>(right * rotation.y - bottom * rotation.x, right * rotation.x + bottom * rotation.y);
    let p3 = origin + vec2<f32>(left * rotation.y - bottom * rotation.x, left * rotation.x + bottom * rotation.y);
    var patched = record;
    patched.min_x = min(min(p0.x, p1.x), min(p2.x, p3.x));
    patched.min_y = min(min(p0.y, p1.y), min(p2.y, p3.y));
    patched.max_x = max(max(p0.x, p1.x), max(p2.x, p3.x));
    patched.max_y = max(max(p0.y, p1.y), max(p2.y, p3.y));
    return patched;
}`;

export const PALETTE_PATCH_WGSL: string = /* wgsl */ `
${MOVE_PARAMS_WGSL}

struct MoveCommand {
  slot: u32,
  x: f32,
  y: f32,
}

${CULL_RECORD_WGSL}

${ROTATED_AABB_WGSL}

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
  let rotation = unpack2x16float(bitcast<u32>(transforms[base + 1u].x));
  records[command.slot] = patch_record_aabb(record, vec2<f32>(command.x, command.y), bounds, rotation);
}
`;

export const PALETTE_DENSE_PATCH_WGSL: string = /* wgsl */ `
${MOVE_PARAMS_WGSL}

struct DenseMoveCommand {
  x: f32,
  y: f32,
}

${CULL_RECORD_WGSL}

${ROTATED_AABB_WGSL}

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
  let rotation = unpack2x16float(bitcast<u32>(transforms[base + 1u].x));
  records[slot] = patch_record_aabb(record, vec2<f32>(command.x, command.y), bounds, rotation);
}
`;

function transformPatchWgsl(dense: boolean): string {
  const commandType = dense ? "DenseTransformMoveCommand" : "TransformMoveCommand";
  const suffix = dense ? "_dense" : "";
  const slot = dense ? "slot" : "command.slot";
  const declareSlot = dense ? "  let slot = params.base_slot + id.x;\n" : "";
  return /* wgsl */ `
${MOVE_PARAMS_WGSL}

struct ${commandType} {
${dense ? "" : "  slot: u32,\n"}  x: f32,
  y: f32,
  rotation: u32,
}

${CULL_RECORD_WGSL}

${ROTATED_AABB_WGSL}

@group(0) @binding(0) var<uniform> params: MoveParams;
@group(0) @binding(1) var<storage, read> commands: array<${commandType}>;
${PATCH_TARGET_BINDINGS_WGSL}

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_transform${suffix}(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
${declareSlot}  let command = commands[id.x];
  let base = ${slot} * 2u;
  var transform0 = transforms[base];
  var transform1 = transforms[base + 1u];
  transform0.x = command.x;
  transform0.y = command.y;
  transform1.x = bitcast<f32>(command.rotation);
  transforms[base] = transform0;
  transforms[base + 1u] = transform1;
}

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_transform_and_cull${suffix}(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
${declareSlot}  let command = commands[id.x];
  let base = ${slot} * 2u;
  var transform0 = transforms[base];
  var transform1 = transforms[base + 1u];
  transform0.x = command.x;
  transform0.y = command.y;
  let rotation = unpack2x16float(command.rotation);
  transform1.x = bitcast<f32>(command.rotation);
  transforms[base] = transform0;
  transforms[base + 1u] = transform1;
  if (${slot} >= params.record_count) {
    return;
  }
  let record = records[${slot}];
  if (record.local_bounds_index >= params.local_bounds_count) {
    return;
  }
  let bounds = local_bounds[record.local_bounds_index];
  records[${slot}] = patch_record_aabb(
    record,
    vec2<f32>(command.x, command.y),
    bounds,
    rotation,
  );
}
`;
}

export const PALETTE_TRANSFORM_PATCH_WGSL: string = transformPatchWgsl(false);
export const PALETTE_DENSE_TRANSFORM_PATCH_WGSL: string = transformPatchWgsl(true);

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
