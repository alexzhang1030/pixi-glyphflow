import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    headless: true,
    viewport: { width: 320, height: 180 },
  },
  webServer: {
    command: "bunx vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/tests/browser/glyph-rendering.html",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
