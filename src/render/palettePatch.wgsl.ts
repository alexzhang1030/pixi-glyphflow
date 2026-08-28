import { PALETTE_PATCH_WORKGROUP } from "./paletteStorage";

export const PALETTE_PATCH_WGSL: string = /* wgsl */ `
struct MoveParams {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: MoveParams;
@group(0) @binding(1) var<storage, read> slots: array<u32>;
@group(0) @binding(2) var<storage, read> origin_x: array<f32>;
@group(0) @binding(3) var<storage, read> origin_y: array<f32>;
@group(0) @binding(4) var<storage, read_write> transforms: array<vec4<f32>>;

const WORKGROUP: u32 = ${String(PALETTE_PATCH_WORKGROUP)}u;

@compute @workgroup_size(${String(PALETTE_PATCH_WORKGROUP)})
fn patch_xy(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let slot = slots[id.x];
  let base = slot * 2u;
  var texel = transforms[base];
  texel.x = origin_x[slot];
  texel.y = origin_y[slot];
  transforms[base] = texel;
}
`;
