export function packedRectangle(): Uint8Array {
  const texels = [
    [0, 0, 16, 16],
    [1, 1, 4, 4],
    [2, -32_764, -32_762, 8],
    [2, -32_760, -32_758, 8],
    [-32_755, 0, 0, 0],
    [-32_753, 0, 0, 0],
    [-32_753, 0, 0, 0],
    [-32_755, 0, 0, 0],
    [-32_754, 0, 0, 0],
    [-32_756, 0, 0, 0],
    [-32_756, 0, 0, 0],
    [-32_754, 0, 0, 0],
    [0, 0, 0, 0],
    [16, 0, 16, 0],
    [16, 16, 16, 16],
    [0, 16, 0, 16],
    [0, 0, 0, 0],
  ] as const;
  const blob = new Uint8Array(texels.length * 8);
  const view = new DataView(blob.buffer);
  texels.forEach((texel, texelIndex) => {
    texel.forEach((word, wordIndex) => {
      view.setInt16(texelIndex * 8 + wordIndex * 2, word, true);
    });
  });
  return blob;
}

export async function readRgba8Texture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Readonly<{ pixels: Uint8Array; bytesPerRow: number }>> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.unmap();
  buffer.destroy();
  return Object.freeze({ pixels, bytesPerRow });
}
