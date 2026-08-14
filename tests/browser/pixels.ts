import { Rectangle, type Application, type Container } from "pixi.js";

export interface PixelMeasure {
  readonly count: number;
  readonly centroidX: number;
}

export async function measureVisiblePixels(
  app: Application,
  target: Container,
  width = 320,
  height = 180,
): Promise<PixelMeasure> {
  if ("gpu" in app.renderer) {
    const texture = app.renderer.extract.texture({
      target,
      frame: new Rectangle(0, 0, width, height),
    });
    const gpuTexture = app.renderer.texture.getGpuSource(texture.source);
    const rowBytes = width * 4;
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const buffer = app.renderer.gpu.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = app.renderer.gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: gpuTexture },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    app.renderer.gpu.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    const result = measureRows(pixels, width, height, bytesPerRow);
    buffer.unmap();
    buffer.destroy();
    texture.destroy(true);
    return result;
  }

  const {
    pixels,
    width: pixelWidth,
    height: pixelHeight,
  } = app.renderer.extract.pixels({
    target,
    frame: new Rectangle(0, 0, width, height),
  });
  return measureRows(pixels, pixelWidth, pixelHeight, pixelWidth * 4);
}

function measureRows(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  bytesPerRow: number,
): PixelMeasure {
  let count = 0;
  let xSum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((pixels[y * bytesPerRow + x * 4 + 3] ?? 0) > 0) {
        count += 1;
        xSum += x;
      }
    }
  }
  return { count, centroidX: count === 0 ? 0 : xSum / count };
}
