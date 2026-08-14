import type { BitmapFont } from "pixi.js";

export type BinaryFontData = ArrayBuffer | Uint8Array;

export type FontSource =
  | URL
  | string
  | BinaryFontData
  | { readonly type: "system" }
  | { readonly type: "binary"; readonly data: URL | string | BinaryFontData }
  | { readonly type: "bitmap"; readonly font: BitmapFont; readonly owned?: boolean };

export interface FontRegistration {
  readonly family: string;
  readonly source?: FontSource;
}

export interface RegisteredFont {
  readonly family: string;
  readonly kind: "system" | "binary" | "bitmap";
  readonly revision: number;
  readonly bytes: number;
}

export interface FontRegistryOptions {
  readonly fetch?: typeof fetch;
}

export interface FontRegistryStats {
  readonly revision: number;
  readonly registeredFonts: number;
  readonly systemFonts: number;
  readonly binaryFonts: number;
  readonly bitmapFonts: number;
  readonly binaryBytes: number;
  readonly fallbackChains: number;
  readonly pendingLoads: number;
}
