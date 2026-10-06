// Browser tests (npm run test:browser): the app end to end in Chromium, through the relay, and the
// desktop app through Electron. Visual tests (npm run test:visual): the design-system gallery against
// its baseline screenshots. Both use the built app (app/dist), which the npm scripts build first.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: ["browser/**/*.spec.js", "visual/**/*.spec.js"],
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { viewport: { width: 1440, height: 900 } },
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" } },
  snapshotPathTemplate: "{testDir}/{testFileDir}/snapshots/{arg}{ext}",
});
