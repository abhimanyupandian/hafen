// The design system, as the app has it (spec/design/README.md, Checking it matches): the gallery of
// every component the app uses, in both themes, against its baseline screenshots. A difference fails
// unless the design spec was changed on purpose (then: npx playwright test tests/visual --update-snapshots).

import { expect, test } from "@playwright/test";
import { createRelay } from "../../server/relay.js";

let relay;
let url;
test.beforeAll(async () => {
  relay = createRelay({ allow: [] });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${relay.address().port}/gallery.html`;
});
test.afterAll(() => relay.close());

for (const theme of ["light", "dark"]) {
  test(`gallery, ${theme}`, async ({ page }) => {
    await page.goto(`${url}?theme=${theme}`);
    await page.locator("#g-timeline .timeline-bar").first().waitFor();
    await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" });
    await expect(page).toHaveScreenshot(`gallery-${theme}.png`, { fullPage: true });
  });
}
