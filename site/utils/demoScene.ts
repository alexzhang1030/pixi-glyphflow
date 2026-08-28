export const LABEL_COUNT = 1_000_000;
export const MOVING_COUNT = 100_000;
export const COLUMNS = 1_000;
export const ROWS = LABEL_COUNT / COLUMNS;
export const COLUMN_SPACING = 158;
export const ROW_SPACING = 32;
export const CHUNK_SIZE = 25_000;
export const STORM_INTERVAL_MS = 100;
export const INITIAL_ZOOM = 0.84;
export const CULLING_PADDING = 48;
export const SHOWCASE_ROW_INTERVAL = 64;
export const HERO_FONT_SIZE = 17;
export const FIELD_FONT_SIZE = 13;
export const FIELD_FILL = 0x7f93a3;
export const FALLBACK_FILL = 0x6f8290;
export const MULTILINGUAL_STACK = "Glyphflow multilingual";
export const MOVER_STRIDE = LABEL_COUNT / MOVING_COUNT;

export const CUSTOM_FONTS = Object.freeze([
  { family: "Glyphflow CJKV Demo", url: "/fonts/noto-sans-cjkv-demo.ttf" },
  { family: "Glyphflow Arabic Demo", url: "/fonts/noto-sans-arabic-demo.ttf" },
  { family: "Glyphflow Devanagari Demo", url: "/fonts/noto-sans-devanagari-demo.ttf" },
  { family: "Glyphflow Hebrew Demo", url: "/fonts/noto-sans-hebrew-demo.ttf" },
  { family: "Glyphflow Thai Demo", url: "/fonts/noto-sans-thai-demo.ttf" },
]);

export const SYSTEM_FONT_FAMILIES = Object.freeze([
  "system-ui",
  "PingFang SC",
  "Hiragino Sans",
  "Apple SD Gothic Neo",
  "Geeza Pro",
  "Kohinoor Devanagari",
  "Arial Hebrew",
  "Thonburi",
  "Arial Unicode MS",
  "sans-serif",
]);

export interface DemoShaping {
  readonly direction: "ltr" | "rtl";
  readonly language: string;
  readonly script: string;
  readonly features: readonly string[];
  readonly variations?: Readonly<{ readonly wght: number }>;
}

export interface LanguageSample {
  readonly text: string;
  readonly custom: boolean;
  readonly fill: number;
  readonly shaping?: Readonly<DemoShaping>;
}

export interface ResolvedLanguageSample {
  readonly sample: Readonly<LanguageSample>;
  readonly showcase: boolean;
  readonly hero: boolean;
}

export interface WorldBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const LANGUAGE_SAMPLES: readonly Readonly<LanguageSample>[] = Object.freeze([
  sample("简体中文 · 上海字流", true, 0xe8f6ff, "zh-CN", "Hans"),
  sample("繁體中文 · 臺北字型", true, 0xd9ecfa, "zh-TW", "Hant"),
  sample("日本語 · 東京テキスト", true, 0xe4eef8, "ja", "Jpan"),
  sample("한국어 · 서울글리프", true, 0xdcefe6, "ko", "Kore"),
  sample("Tiếng Việt · Hà Nội", true, 0xe8ead8, "vi", "Latn"),
  sample("العربية · مرحبا", true, 0xf0e6d4, "ar", "Arab", "rtl"),
  sample("हिन्दी · नमस्ते", true, 0xf2e4c8, "hi", "Deva"),
  sample("עברית · שלום", true, 0xe8e0f0, "he", "Hebr", "rtl"),
  sample("ไทย · สวัสดี", true, 0xd8eee6, "th", "Thai"),
  sample("Русский · Привет", true, 0xe2e8f4, "ru", "Cyrl"),
  sample("Ελληνικά · Γεια", true, 0xe6eef8, "el", "Grek"),
  Object.freeze({ text: "Emoji · 🌏 ✦", custom: false, fill: 0xeee3c4 }),
]);

export const DEMO_CHARSETS: readonly Readonly<{ family: string; charset: string }>[] =
  Object.freeze([
    {
      family: "Glyphflow CJKV Demo",
      charset: [
        "简体中文 · 上海字流",
        "繁體中文 · 臺北字型",
        "日本語 · 東京テキスト",
        "한국어 · 서울글리프",
        "Tiếng Việt · Hà Nội",
        "Русский · Привет",
        "Ελληνικά · Γεια",
      ].join(""),
    },
    { family: "Glyphflow Arabic Demo", charset: "العربية · مرحبا" },
    { family: "Glyphflow Devanagari Demo", charset: "हिन्दी · नमस्ते" },
    { family: "Glyphflow Hebrew Demo", charset: "עברית · שלום" },
    { family: "Glyphflow Thai Demo", charset: "ไทย · สวัสดี" },
  ]);

export const HERO_BAND_START_ROW = Math.floor((ROWS - LANGUAGE_SAMPLES.length) / 2);

export function worldWidth(): number {
  return COLUMNS * COLUMN_SPACING;
}

export function worldHeight(): number {
  return ROWS * ROW_SPACING;
}

export function cameraHome(): Readonly<{ x: number; y: number }> {
  return Object.freeze({
    x: worldWidth() / 2,
    y: (HERO_BAND_START_ROW + LANGUAGE_SAMPLES.length / 2) * ROW_SPACING,
  });
}

export function isMoverIndex(index: number): boolean {
  return index % MOVER_STRIDE === 0;
}

export function labelPosition(index: number): Readonly<{ x: number; y: number }> {
  return Object.freeze({
    x: (index % COLUMNS) * COLUMN_SPACING,
    y: Math.floor(index / COLUMNS) * ROW_SPACING,
  });
}

export function workingSetExpand(bounds: Readonly<WorldBounds>, padding: number): number {
  return padding + Math.max(bounds.width, bounds.height);
}

export function gridIndicesInWorldBounds(
  bounds: Readonly<WorldBounds>,
  expand = 0,
): readonly number[] {
  const left = bounds.x - expand;
  const top = bounds.y - expand;
  const right = bounds.x + bounds.width + expand;
  const bottom = bounds.y + bounds.height + expand;
  const columnStart = clampIndex(Math.floor(left / COLUMN_SPACING), COLUMNS);
  const columnEnd = clampIndex(Math.ceil(right / COLUMN_SPACING), COLUMNS);
  const rowStart = clampIndex(Math.floor(top / ROW_SPACING), ROWS);
  const rowEnd = clampIndex(Math.ceil(bottom / ROW_SPACING), ROWS);
  const indices: number[] = [];
  for (let row = rowStart; row <= rowEnd; row += 1) {
    const rowOffset = row * COLUMNS;
    for (let column = columnStart; column <= columnEnd; column += 1) {
      indices.push(rowOffset + column);
    }
  }
  return indices;
}

export function resolveLanguageSample(index: number): Readonly<ResolvedLanguageSample> {
  const row = Math.floor(index / COLUMNS);
  const column = index % COLUMNS;
  const heroIndex = row - HERO_BAND_START_ROW;
  if (heroIndex >= 0 && heroIndex < LANGUAGE_SAMPLES.length) {
    const sample = LANGUAGE_SAMPLES[heroIndex];
    if (sample === undefined) throw new Error("Language sample list is empty");
    return Object.freeze({ sample, showcase: true, hero: true });
  }
  const showcaseStart = Math.floor((COLUMNS - LANGUAGE_SAMPLES.length) / 2);
  const showcaseIndex = column - showcaseStart;
  const showcase =
    row % SHOWCASE_ROW_INTERVAL === 0 &&
    showcaseIndex >= 0 &&
    showcaseIndex < LANGUAGE_SAMPLES.length;
  const sample = showcase
    ? LANGUAGE_SAMPLES[showcaseIndex]
    : LANGUAGE_SAMPLES[index % LANGUAGE_SAMPLES.length];
  if (sample === undefined) throw new Error("Language sample list is empty");
  return Object.freeze({ sample, showcase, hero: false });
}

function clampIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  if (value < 0) return 0;
  if (value > count - 1) return count - 1;
  return value;
}

function sample(
  text: string,
  custom: boolean,
  fill: number,
  language: string,
  script: string,
  direction: "ltr" | "rtl" = "ltr",
): Readonly<LanguageSample> {
  return Object.freeze({
    text,
    custom,
    fill,
    shaping: Object.freeze({
      direction,
      language,
      script,
      features: Object.freeze(["kern", "liga"]),
      ...(custom ? { variations: Object.freeze({ wght: 560 }) } : {}),
    }),
  });
}
