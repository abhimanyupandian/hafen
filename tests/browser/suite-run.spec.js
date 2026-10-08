// Turns grouped in the thread, running up to a turn, ⌘↵ / Ctrl+Enter running what's selected (a turn,
// a test, a suite), and a suite's own view: its tests, its whole runs, and its timeline.

import { parse } from "yaml";
import { expect, fileText, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
// (a suite by its file, data-file; a test by its name)
const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
const runKeys = ["Control+Enter", "Meta+Enter"];

test.beforeEach(async ({ app: { page } }) => {
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("each turn is a group: its number, how it went, and ▷ to run the test up to it", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  const groups = page.locator("#thread .turn-group");
  await expect(groups).toHaveCount(2);
  await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1");
  await expect(page.locator("#turn-0 .turn-summary")).toHaveText("not run yet · 4 checks");
  // ▷ on turn 1: the test runs up to it
  await page.click("#turn-0-run");
  await expect(page.locator("#status")).toContainText("passed 1/1 · to turn 1");
  await expect(page.locator("#turn-0 .turn-summary")).toHaveAttribute("data-status", "passed");
  await expect(page.locator("#turn-0 .turn-summary")).toContainText("4/4 checks");
  await expect(page.locator("#turn-1 .turn-summary")).toHaveText("not run yet · 1 check");
  await expect(page.locator("#turn-1-reply .msg-body")).toHaveText("Not run yet.");
  // The whole test
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator("#turn-1 .turn-summary")).toHaveAttribute("data-status", "failed");
  await expect(page.locator("#turn-1 .turn-summary")).toContainText("0/1 checks");
  // A selected turn marks its group
  await page.locator("#turn-1-reply .msg-body").click();
  await expect(page.locator("#turn-1")).toHaveClass(/selected/);
});

for (const key of runKeys) {
  test(`${key}: a turn runs its test up to it, a test runs, a suite runs`, async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    // A turn selected
    await page.locator("#turn-0-reply .msg-body").click();
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
    await page.keyboard.press(key);
    await expect(page.locator("#status")).toContainText("to turn 1");
    // The test selected
    await openTest(page, "refund for a broken item");
    await page.keyboard.press(key);
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await expect(page.locator("#status")).not.toContainText("to turn");
    // The suite selected
    await row(page, SUITE).locator(".list-open").click();
    await expect(page.locator("#evalTitle")).toHaveText("Smoke");
    const runs = await page.locator("#runList .list-row").count();
    await page.keyboard.press(key);
    await expect(page.locator("#runList .list-row")).toHaveCount(runs + 1);
    await expect(page.locator("#status")).toContainText("failed 0/1");
  });
}

test("⌘↵ / Ctrl+Enter in a field saves it first, then runs; in the message box it runs, not adds; in the large editor it saves", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  // In the test's name field: the new name is saved, and the run is of it
  await page.fill("#testName", "renamed then run");
  await page.locator("#testName").press("Control+Enter");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  expect(parse(await fileText(page, SUITE)).tests[0].name).toBe("renamed then run");
  await expect(page.locator("#runList .list-row").first()).toContainText("renamed then run");
  // In the message box, with a test open: it runs; no turn is added
  await page.fill("#input", "not a new turn");
  const runs = await page.locator("#runList .list-row").count();
  await page.locator("#input").press("Control+Enter");
  await expect(page.locator("#runList .list-row")).toHaveCount(runs + 1);
  expect(parse(await fileText(page, SUITE)).tests[0].turns.length).toBe(2);
  // In the large editor: it saves (and doesn't run)
  await page.click("#testYamlEdit");
  const editor = page.locator("dialog[open] textarea").first();
  await expect(editor).toHaveValue(/renamed then run/);
  await editor.fill((await editor.inputValue()).replace("renamed then run", "saved from the editor"));
  const before = await page.locator("#runList .list-row").count();
  await editor.press("Control+Enter");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect.poll(async () => parse(await fileText(page, SUITE)).tests[0].name).toBe("saved from the editor");
  await page.waitForTimeout(300);
  expect(await page.locator("#runList .list-row").count()).toBe(before);
});

test("a suite's view: its tests as groups, ▷ runs it whole, and its timeline is the suite and its tests", async ({ app: { page } }) => {
  // A second test, so the suite has two
  const smoke = row(page, SUITE);
  await smoke.hover();
  await smoke.locator("[id$='-add']").click();
  await expect(page.locator("#evalTitle")).toHaveText("New test");
  await smoke.locator(".list-open").click();
  await expect(page.locator("#evalTitle")).toHaveText("Smoke");
  await expect(page.locator("#composer")).toHaveCount(0);
  await expect(page.locator("#thread .suite-test")).toHaveCount(2);
  await expect(page.locator("#suiteTest-0 .suite-test-name")).toHaveText("refund for a broken item");
  await expect(page.locator("#suiteTest-0 > .turn-head .turn-summary")).toHaveText("not run yet");
  await expect(page.locator("#suiteTest-0 .suite-turn")).toHaveCount(2);
  await expect(page.locator("#timelineEmpty")).toHaveText("Run the suite to see its tests here.");
  // ▷ in the top bar: the whole suite
  await expect(page.locator("#testHeaderRun")).toHaveAttribute("aria-label", "Run this suite");
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText(/failed 0\/2|failed 1\/2/);
  await expect(page.locator("#suiteTest-0 > .turn-head .turn-summary")).toHaveText("failed 0/1 · just now");
  await expect(page.locator("#suiteTest-0-turn-1 .turn-summary")).toHaveText("0/1");
  // The timeline: the suite, and its two tests folded (no turns)
  const bars = page.locator(".timeline-bar");
  await expect(page.locator(".timeline-bar[data-kind='suite']")).toHaveCount(1);
  await expect(page.locator(".timeline-bar[data-kind='test']")).toHaveCount(2);
  await expect(page.locator(".timeline-bar[data-kind='turn']")).toHaveCount(0);
  expect(await bars.count()).toBe(3);
  // A test's bar opens the test; the suite's opens the suite
  await page.locator(".timeline-bar[data-kind='test']").first().click();
  await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
  await expect(page.locator("#panel .panel-head")).toContainText("Test");
  await smoke.locator(".list-open").click();
  await page.locator(".timeline-bar[data-kind='suite']").click();
  await expect(page.locator("#panel .panel-head")).toContainText("Suite");
  await expect(page.locator("#evalTitle")).toHaveText("Smoke");
  // A test's turn in the suite's view opens it
  await page.click("#suiteTest-0-turn-1");
  await expect(page.locator("#panel .panel-head")).toContainText("Turn 2");
  await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
});

test("a suite row's ▷ runs the whole suite and shows it", async ({ app: { page } }) => {
  const smoke = row(page, SUITE);
  await smoke.hover();
  await smoke.locator("[id$='-run']").click();
  await expect(page.locator("#evalTitle")).toHaveText("Smoke");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator(".timeline-bar[data-kind='suite']")).toHaveCount(1);
});
