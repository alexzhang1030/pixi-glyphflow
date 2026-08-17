const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** Pack two f32 values into one uint32 as IEEE-754 binary16 pair. */
export function packHalf2x16(x: number, y: number): number {
  return (f16Bits(x) | (f16Bits(y) << 16)) >>> 0;
}

export function unpackHalf2x16(packed: number): readonly [number, number] {
  return [f16FromBits(packed & 0xffff), f16FromBits((packed >>> 16) & 0xffff)];
}

export function floatFromBits(bits: number): number {
  U32[0] = bits >>> 0;
  return F32[0] ?? 0;
}

export function bitsFromFloat(value: number): number {
  F32[0] = value;
  return U32[0] ?? 0;
}

export function packF16(value: number): number {
  return f16Bits(value);
}

export function unpackF16(bits: number): number {
  return f16FromBits(bits & 0xffff);
}

function f16Bits(value: number): number {
  if (!Number.isFinite(value)) {
    return value < 0 ? 0xfc00 : 0x7c00;
  }
  F32[0] = value;
  const bits = U32[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127;
  const fraction = bits & 0x7f_ffff;
  if (exponent > 15) return sign | 0x7c00;
  if (exponent < -14) {
    const denorm = fraction | 0x80_0000;
    const shift = -exponent - 14;
    if (shift > 23) return sign;
    return sign | (denorm >>> (shift + 13));
  }
  return sign | ((exponent + 15) << 10) | (fraction >>> 13);
}

function f16FromBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) {
    return sign * (fraction / 1024) * 2 ** -14;
  }
  if (exponent === 31) {
    return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
