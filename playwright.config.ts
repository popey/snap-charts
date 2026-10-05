import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  use: { baseURL: "http://127.0.0.1:4184", browserName: "chromium" },
  webServer: {
    command:
      "npm run demo -- --output .demo/data && SNAP_CHARTS_DEMO=1 npm run dev -- --port 4184",
    url: "http://127.0.0.1:4184",
    reuseExistingServer: false,
  },
});
