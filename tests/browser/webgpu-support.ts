import type { Page } from "@playwright/test";

export async function hasWebGpuAdapter(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const gpu = navigator.gpu;
    if (gpu === undefined) return false;

    try {
      return (await gpu.requestAdapter()) !== null;
    } catch {
      return false;
    }
  });
}
