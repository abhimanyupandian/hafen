// The sidebar's head and the chat's details (contracts/ui.md, Sidebar; spec/design/components.md,
// Additions): the scope is a button (its icon and the scope chosen) that opens Settings → Environments,
// where it's chosen; Settings' button is a gear; a turn's checks are small cards in the colour of how
// each went, their dot kept. (Scrollbars: scrollbars.spec.js.)

import { chooseScope, expect, test } from "./fixtures.js";

const openFolder = async (page) => {
  await page.click("#openFolder");
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
};
// A colour token as the page computes it (rgb(…))
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);
const style = (locator, prop) => locator.evaluate((el, prop) => getComputedStyle(el)[prop], prop);

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("the scope button names the scope chosen and opens Settings on Environments, where another is chosen", async ({ app: { page } }) => {
  // No scope yet: the button is there all the same (to add one), and says so
  await expect(page.locator("#scopeButton")).toBeVisible();
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("no scope");
  await expect(page.locator("#scopeButton svg.icon-scope")).toHaveCount(1);
  await expect(page.locator("#envSelect")).toHaveCount(0);
  await page.click("#scopeButton");
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#environmentsClosed")).toContainText("Open a folder first");
  await page.click("#settingsClose");
  // The folder's suite has an environment (local): chosen, the button names it
  await openFolder(page);
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("local");
  await expect(page.locator("#scopeButton")).toHaveAttribute("title", /Scope: local/);
  // Opened on Environments even when Settings was last left on another pane
  await page.click("#openSettings");
  await page.click("#settings-tab-appearance");
  await page.click("#settingsClose");
  await page.click("#scopeButton");
  await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#envScope")).toHaveValue("local");
  await expect(page.locator("#envChosen")).toHaveText("chosen now");
  // A new scope, chosen there: the button follows, and keeps it after a reload
  await page.fill("#newScopeName", "stage");
  await page.click("#newScopeForm button[type=submit]");
  await expect(page.locator("#envScope")).toHaveValue("stage");
  await page.click("#envChoose");
  await expect(page.locator("#envChosen")).toBeVisible();
  await page.click("#settingsClose");
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await openFolder(page);
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
  // Back to the first, with the helper the other tests use
  await chooseScope(page, "local");
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("local");
  // Keyboard: it's a button like any other
  await page.locator("#scopeButton").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsModal")).toBeHidden();
});

test("with no folder open, a scope that has only secrets can still be chosen from the button", async ({ app: { page } }) => {
  await page.evaluate(() => localStorage.setItem("eval.secrets", JSON.stringify({ prod: { TOKEN: "t-123456" }, stage: { TOKEN: "t-654321" } })));
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  // None chosen yet (a folder's own environments would come first)
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("no scope");
  await page.click("#scopeButton");
  await expect(page.locator("#envScope")).toBeVisible();
  await expect(page.locator("#environmentsClosed")).toContainText("Open a folder to add scopes");
  await expect(page.locator("#newScopeForm")).toHaveCount(0);
  await page.selectOption("#envScope", "stage");
  await page.click("#envChoose");
  await expect(page.locator("#envChosen")).toBeVisible();
  await page.click("#settingsClose");
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
  // Chosen again after a reload, still with no folder open; and kept when one is opened
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
  await openFolder(page);
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
});

test("a folder's own environment comes first when no scope was chosen before, whatever scopes have secrets", async ({ app: { page } }) => {
  await page.evaluate(() => localStorage.setItem("eval.secrets", JSON.stringify({ prod: { TOKEN: "t-123456" } })));
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await openFolder(page);
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("local");
});

test("Settings' button is a gear (the same icon as the rail's), and opens Settings", async ({ app: { page } }) => {
  const gear = page.locator("#openSettings svg.icon-settings");
  await expect(gear).toHaveCount(1);
  // A gear: one outline with eight teeth (32 corners) around a hub, not the old sliders
  const d = await gear.locator("path").getAttribute("d");
  expect(d.match(/[LHV]/g).length).toBe(31);
  await expect(gear.locator("circle")).toHaveCount(1);
  await page.click("#openSettings");
  await expect(page.locator("#settingsModal")).toBeVisible();
});

test("a turn's checks are small cards, tinted by how each went, their dot kept", async ({ app: { page } }) => {
  await openFolder(page);
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).first().click();
  // Not run yet: plain cards, a hollow dot
  const unrun = page.locator("#turn-0-reply .check-badge").first();
  await expect(unrun).toHaveAttribute("data-status", "");
  expect(await style(unrun, "borderTopColor")).toBe(await token(page, "--line"));
  expect(await style(unrun, "borderTopStyle")).toBe("solid");
  expect(await style(unrun.locator(".badge-dot"), "backgroundColor")).toBe("rgba(0, 0, 0, 0)");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText(/failed/);
  // Passed: green edge, fill and text, a filled dot
  const pass = page.locator("#turn-0-reply .check-badge[data-status='pass']").first();
  expect(await style(pass, "borderTopColor")).toBe(await token(page, "--ok-line"));
  expect(await style(pass, "backgroundColor")).toBe(await token(page, "--ok-soft"));
  expect(await style(pass, "color")).toBe(await token(page, "--ok"));
  expect(await style(pass.locator(".badge-dot"), "backgroundColor")).toBe(await token(page, "--ok"));
  expect(await style(pass, "height")).toBe("22px");
  // Failed: red
  const fail = page.locator("#turn-1-reply .check-badge[data-status='fail']").first();
  await expect(fail).toHaveText("contains refund");
  expect(await style(fail, "borderTopColor")).toBe(await token(page, "--bad-line"));
  expect(await style(fail, "backgroundColor")).toBe(await token(page, "--bad-soft"));
  expect(await style(fail.locator(".badge-dot"), "backgroundColor")).toBe(await token(page, "--danger"));
  // Several sit side by side, wrapping, a little apart
  const boxes = await page.locator("#turn-0-reply .check-badge").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  expect(boxes.length).toBeGreaterThan(1);
  expect(boxes[1].left).toBeGreaterThan(boxes[0].right);
  // Selected: its edge in its colour, doubled
  await fail.click();
  await expect(fail).toHaveAttribute("aria-pressed", "true");
  expect(await style(fail, "borderTopColor")).toBe(await token(page, "--danger"));
  expect(await style(fail, "boxShadow")).toContain("inset");
  // In the dark theme too
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  expect(await style(pass, "backgroundColor")).toBe(await token(page, "--ok-soft"));
});
