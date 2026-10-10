// Browser tests (npm run test:browser): the app end to end in Chromium, through the relay, and the
// desktop app through Electron. They use the built app (app/dist), which the npm script builds first.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: ["browser/**/*.spec.js"],
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { viewport: { width: 1440, height: 900 } },
});
