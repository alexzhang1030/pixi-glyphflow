import { Rectangle, type Application, type Container } from "pixi.js";

export interface PixelMeasure {
  readonly count: number;
  readonly centroidX: number;
}

export interface PixelProfile extends PixelMeasure {
  readonly alphaSum: number;
  readonly maxAlpha: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly redDominant: number;
  readonly greenDominant: number;
  readonly blueDominant: number;
}

export async function measureVisiblePixels(
  app: Application,
  target: Container,
  width = 320,
  height = 180,
): Promise<PixelMeasure> {
  const image = await readTargetPixels(app, target, width, height);
  return measureRows(image.pixels, image.width, image.height, image.bytesPerRow);
}

export async function measurePixelProfile(
  app: Application,
  target: Container,
  width = 320,
  height = 180,
): Promise<PixelProfile> {
  const image = await readTargetPixels(app, target, width, height);
  return profileRows(image.pixels, image.width, image.height, image.bytesPerRow);
}

async function readTargetPixels(
  app: Application,
  target: Container,
  width: number,
  height: number,
): Promise<
  Readonly<{
    pixels: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
    bytesPerRow: number;
  }>
> {
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
    const result = new Uint8Array(pixels);
    buffer.unmap();
    buffer.destroy();
    texture.destroy(true);
    return { pixels: result, width, height, bytesPerRow };
  }

  const {
    pixels,
    width: pixelWidth,
    height: pixelHeight,
  } = app.renderer.extract.pixels({
    target,
    frame: new Rectangle(0, 0, width, height),
  });
  return { pixels, width: pixelWidth, height: pixelHeight, bytesPerRow: pixelWidth * 4 };
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

function profileRows(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  bytesPerRow: number,
): PixelProfile {
  let count = 0;
  let xSum = 0;
  let alphaSum = 0;
  let maxAlpha = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let redDominant = 0;
  let greenDominant = 0;
  let blueDominant = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      const alpha = pixels[offset + 3] ?? 0;
      if (alpha === 0) continue;
      count += 1;
      xSum += x;
      alphaSum += alpha;
      maxAlpha = Math.max(maxAlpha, alpha);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (red > green * 1.25 && red > blue * 1.25) redDominant += 1;
      if (green > red * 1.25 && green > blue * 1.25) greenDominant += 1;
      if (blue > red * 1.25 && blue > green * 1.25) blueDominant += 1;
    }
  }
  return {
    count,
    centroidX: count === 0 ? 0 : xSum / count,
    alphaSum,
    maxAlpha,
    minX: count === 0 ? 0 : minX,
    minY: count === 0 ? 0 : minY,
    maxX,
    maxY,
    redDominant,
    greenDominant,
    blueDominant,
  };
}
