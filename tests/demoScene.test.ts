import { describe, expect, test } from "bun:test";

import {
  cameraHome,
  COLUMNS,
  CULLING_PADDING,
  gridIndicesInWorldBounds,
  HERO_BAND_START_ROW,
  INITIAL_ZOOM,
  isMoverIndex,
  LABEL_COUNT,
  labelPosition,
  LANGUAGE_SAMPLES,
  MOVING_COUNT,
  MOVER_STRIDE,
  resolveLanguageSample,
  ROW_SPACING,
  ROWS,
  workingSetExpand,
  worldHeight,
  worldWidth,
} from "../site/utils/demoScene";

describe("homepage demo scene", () => {
  test("keeps a million-label grid and a 100k storm stride", () => {
    expect(LABEL_COUNT).toBe(1_000_000);
    expect(MOVING_COUNT).toBe(100_000);
    expect(COLUMNS * ROWS).toBe(LABEL_COUNT);
    expect(MOVER_STRIDE).toBe(10);
    expect(isMoverIndex(0)).toBe(true);
    expect(isMoverIndex(1)).toBe(false);
    expect(isMoverIndex(10)).toBe(true);
  });

  test("homes the camera on the multilingual specimen band", () => {
    const home = cameraHome();
    expect(HERO_BAND_START_ROW).toBe(494);
    expect(home.x).toBe(worldWidth() / 2);
    expect(home.y).toBe((HERO_BAND_START_ROW + LANGUAGE_SAMPLES.length / 2) * ROW_SPACING);

    const centerIndex = HERO_BAND_START_ROW * COLUMNS + Math.floor(COLUMNS / 2);
    const resolved = resolveLanguageSample(centerIndex);
    expect(resolved.hero).toBe(true);
    expect(resolved.showcase).toBe(true);
    expect(resolved.sample.text).toBe("简体中文 · 上海字流");

    const lastHero = resolveLanguageSample(
      (HERO_BAND_START_ROW + LANGUAGE_SAMPLES.length - 1) * COLUMNS,
    );
    expect(lastHero.hero).toBe(true);
    expect(lastHero.sample.text).toBe("Emoji · 🌏 ✦");

    const field = resolveLanguageSample((HERO_BAND_START_ROW - 1) * COLUMNS);
    expect(field.hero).toBe(false);
  });

  test("first-view indices cover every tight-view cell before the rest of the million", () => {
    const home = cameraHome();
    const screen = { width: 1120, height: 500 };
    const tight = {
      x: home.x - screen.width / 2 / INITIAL_ZOOM,
      y: home.y - screen.height / 2 / INITIAL_ZOOM,
      width: screen.width / INITIAL_ZOOM,
      height: screen.height / INITIAL_ZOOM,
    };
    const firstView = gridIndicesInWorldBounds(tight, workingSetExpand(tight, CULLING_PADDING));
    const firstViewSet = new Set(firstView);

    expect(firstView.length).toBeGreaterThan(400);
    expect(firstView.length).toBeLessThan(20_000);
    expect(firstView.every((index) => index >= 0 && index < LABEL_COUNT)).toBe(true);
    expect(new Set(firstView).size).toBe(firstView.length);

    const visible = gridIndicesInWorldBounds(tight);
    expect(visible.length).toBeGreaterThan(60);
    expect(visible.every((index) => firstViewSet.has(index))).toBe(true);

    const heroVisible = visible.filter((index) => resolveLanguageSample(index).hero);
    const heroLanguages = new Set(
      heroVisible.map((index) => resolveLanguageSample(index).sample.text),
    );
    expect(heroLanguages.size).toBe(LANGUAGE_SAMPLES.length);

    const firstHero = labelPosition(HERO_BAND_START_ROW * COLUMNS + Math.floor(COLUMNS / 2));
    expect(firstHero.y).toBeGreaterThanOrEqual(tight.y);
    expect(firstHero.y).toBeLessThan(tight.y + tight.height);
  });

  test("world bounds stay on the million-label grid", () => {
    expect(worldWidth()).toBeGreaterThan(0);
    expect(worldHeight()).toBeGreaterThan(0);
    expect(gridIndicesInWorldBounds({ x: 0, y: 0, width: 0, height: 0 })).toEqual([0]);
    expect(
      gridIndicesInWorldBounds({
        x: worldWidth(),
        y: worldHeight(),
        width: 10,
        height: 10,
      }).at(-1),
    ).toBe(LABEL_COUNT - 1);
  });
});
