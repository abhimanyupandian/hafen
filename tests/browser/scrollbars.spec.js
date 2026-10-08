// Scrollbars (spec/design/components.md, Additions: Scrollbars): thin and quiet in every part of the app
// that scrolls (no wide grey bars with arrows, as Windows draws by default), the chat's thinner still,
// the timeline's chart none at all. Playwright hides scrollbars in a headless browser: shown here, to
// be measured (styled ones take room, as Windows' do).

import { expect, reopen, test } from "./fixtures.js";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
};
// The width of the vertical scrollbar of what scrolls there: the element, or the nearest part that holds
// it and scrolls (a sidebar section grows, and the sidebar's body scrolls)
const scrollbarWidth = (page, selector) => page.evaluate((selector) => {
  let el = document.querySelector(selector);
  while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (!el) return null;
  const s = getComputedStyle(el);
  return el.offsetWidth - el.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
}, selector);
// Something tall in it, so it scrolls
const fill = (page, selector) => page.evaluate((selector) => {
  const filler = document.createElement("div");
  Object.assign(filler.style, { height: "4000px", flex: "none" });
  document.querySelector(selector).append(filler);
}, selector);

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("scrollbars are thin everywhere, and the chat's thinner still", async ({ app: { page } }) => {
  await openApp(page);
  // The chat
  await fill(page, "#scroller");
  expect(await scrollbarWidth(page, "#scroller")).toBe(5);
  // A sidebar section's list
  await fill(page, "#suitesBody");
  expect(await scrollbarWidth(page, "#suitesBody")).toBe(8);
  // The panel
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).first().click();
  await page.locator("#turn-0 .turn-head .label").click();
  await fill(page, ".panel-body");
  expect(await scrollbarWidth(page, ".panel-body")).toBe(8);
  // Settings' pane
  await page.click("#openSettings");
  await fill(page, ".settings-content");
  expect(await scrollbarWidth(page, ".settings-content")).toBe(8);
  await page.click("#settingsClose");
});

test("the timeline's chart has no scrollbar at all: it's moved by the wheel, or Space and drag", async ({ app: { page } }) => {
  await openApp(page);
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).first().click();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText(/failed|passed/);
  const chart = page.locator(".timeline-chart").first();
  await chart.waitFor();
  await page.evaluate(() => {
    const filler = document.createElement("div");
    Object.assign(filler.style, { width: "6000px", height: "4000px" });
    document.querySelector(".timeline-chart").append(filler);
  });
  expect(await chart.evaluate((el) => [el.offsetWidth - el.clientWidth, el.offsetHeight - el.clientHeight])).toEqual([0, 0]);
});
