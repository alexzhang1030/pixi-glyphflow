import { BufferImageSource, Texture } from "pixi.js";

import { GLYPH_ATLAS_ARRAY_LAYERS, type GlyphMode } from "../atlas/types";
import { cleanupBestEffort } from "./cleanup";
import type { GlyphMesh } from "./GlyphMesh";
import type {
  BackendAtlasArray,
  BackendAtlasPage,
  BackendMeshBindings,
} from "./PixiRendererPlatform";
import type { RenderCoordinator } from "./RenderCoordinator";

export interface RenderColorAtlasSource {
  readonly texture: GPUTexture;
  readonly format: "rgba8unorm";
  readonly width: number;
  readonly height: number;
}

export interface RenderColorAtlasCopy {
  readonly page: number;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly destinationX: number;
  readonly destinationY: number;
  readonly width: number;
  readonly height: number;
}

export function createPrototypeSource(
  pixels: Float32Array,
  width: number,
  height: number,
): BufferImageSource {
  return new BufferImageSource({
    resource: pixels,
    width,
    height,
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
    label: "pixi-glyphflow-prototypes",
  });
}

export function createPaletteSource(
  coordinator: RenderCoordinator,
  width: number = coordinator.transforms.stats.textureWidth,
): BufferImageSource {
  const data = coordinator.transforms.data;
  return new BufferImageSource({
    resource: data,
    width,
    height: Math.ceil(data.length / 4 / width),
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
    label: "pixi-glyphflow-transforms",
  });
}

export function bindMeshResources(mesh: GlyphMesh, bindings: Readonly<BackendMeshBindings>): void {
  mesh.setPaletteTexture(bindings.paletteTexture, bindings.paletteWidth, bindings.effectBase);
  if (bindings.paletteStorage !== undefined) mesh.setPaletteStorage(bindings.paletteStorage);
  mesh.setPrototypeTexture(bindings.prototypeTexture, bindings.prototypeWidth);
  if (bindings.bindAtlas) mesh.setTextures(bindings.atlasTextures);
}

export function copyAtlasUpload(
  page: BackendAtlasPage,
  x: number,
  y: number,
  width: number,
  height: number,
  pixels: Uint8Array,
): void {
  const bytesPerPixel = glyphBytesPerPixel(page.info.mode);
  const sourceRowBytes = width * bytesPerPixel;
  const targetRowBytes = page.info.width * bytesPerPixel;
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * sourceRowBytes;
    const targetOffset = (y + row) * targetRowBytes + x * bytesPerPixel;
    page.pixels.set(pixels.subarray(sourceOffset, sourceOffset + sourceRowBytes), targetOffset);
  }
}

export function createAtlasArray(
  kind: "r" | "rgba",
  width: number,
  height: number,
  minLayers: number,
  dummy: boolean,
): BackendAtlasArray {
  const layerCapacity = nextLayerCapacity(minLayers);
  const format = kind === "r" ? "r8unorm" : "rgba8unorm";
  const bytesPerPixel = kind === "r" ? 1 : 4;
  const source = new BufferImageSource({
    // Pixi's buffer uploader is 2D-only; the platform adapter allocates this array explicitly.
    resource: new Uint8Array(bytesPerPixel),
    width,
    height,
    format,
    dimensions: "2d",
    viewDimension: "2d-array",
    arrayLayerCount: layerCapacity,
    scaleMode: "linear",
    autoGenerateMipmaps: false,
    alphaMode: "no-premultiply-alpha",
    label: `pixi-glyphflow-atlas-${kind}`,
  });
  // Keep Pixi's 2D uploaders away from the stub resource. Both real adapters allocate first,
  // then write individual array layers through their native API.
  source.uploadMethodId = "glyphflow-atlas-array";
  let texture: Texture;
  try {
    texture = new Texture({ source });
  } catch (error: unknown) {
    cleanupBestEffort([() => source.destroy()]);
    throw error;
  }
  return {
    kind,
    width,
    height,
    layerCapacity,
    layerCount: 0,
    source,
    texture,
    initialized: false,
    dummy,
  };
}

export function fourChannelMode(mode: GlyphMode): boolean {
  switch (mode) {
    case "alpha":
    case "sdf":
      return false;
    case "msdf":
    case "color":
      return true;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function validateColorAtlasSource(source: Readonly<RenderColorAtlasSource>): void {
  if (source.format !== "rgba8unorm") {
    throw new TypeError("GPU color atlas sources require rgba8unorm format");
  }
  assertPositiveInteger("color atlas source width", source.width);
  assertPositiveInteger("color atlas source height", source.height);
}

export function validateColorAtlasCopy(
  source: Readonly<RenderColorAtlasSource>,
  page: BackendAtlasPage,
  copy: Readonly<RenderColorAtlasCopy>,
): void {
  if (page.info.mode !== "color") {
    throw new TypeError("GPU color atlas copies require a color-mode destination page");
  }
  assertNonNegativeInteger("color atlas sourceX", copy.sourceX);
  assertNonNegativeInteger("color atlas sourceY", copy.sourceY);
  assertNonNegativeInteger("color atlas destinationX", copy.destinationX);
  assertNonNegativeInteger("color atlas destinationY", copy.destinationY);
  assertPositiveInteger("color atlas copy width", copy.width);
  assertPositiveInteger("color atlas copy height", copy.height);
  if (copy.sourceX + copy.width > source.width || copy.sourceY + copy.height > source.height) {
    throw new RangeError("GPU color atlas copy exceeds its source bounds");
  }
  if (
    copy.destinationX + copy.width > page.info.width ||
    copy.destinationY + copy.height > page.info.height
  ) {
    throw new RangeError("GPU color atlas copy exceeds its destination page bounds");
  }
}

function nextLayerCapacity(needed: number): number {
  let capacity = 1;
  while (capacity < needed) capacity *= 2;
  return Math.min(capacity, GLYPH_ATLAS_ARRAY_LAYERS);
}

function glyphBytesPerPixel(mode: GlyphMode): number {
  return mode === "alpha" || mode === "sdf" ? 1 : 4;
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}
