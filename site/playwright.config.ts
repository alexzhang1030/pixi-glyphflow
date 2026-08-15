import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4180",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "bun run preview",
    env: {
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: "4180",
    },
    url: "http://127.0.0.1:4180",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
