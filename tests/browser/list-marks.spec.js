// The suite list and what marks a suite or a test (contracts/ui.md, Sidebar: Suites; Top bar; Thread):
// a suite by its name; its group and a test's (G2, the same colour for the same number); ×3 for a test
// that repeats; ▷ on a test's row; a circle going round for what's running; when it last ran ("just
// now"); the latest of a test's runs shown first; right-click to expand or collapse it all (the list
// and the timeline).

import { expect, test } from "./fixtures.js";

const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const MARKS = "marks.hafen.yml";
// A suite with a name, a group, and tests in groups (one that repeats); its replies slow, so runs can
// be seen going on
const files = async (page, url, ms = 700) => {
  await writeFile(page, "providers/slow.yml", `kind: http\nurl: "${url}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(page, MARKS, `version: 1
name: Checkout flows
group: 2
provider: providers/slow.yml
tests:
  - name: pays by card
    group: 1
    repeat: 3
    turns:
      - { user: pay by card, expect: [ { contains: card } ] }
  - name: pays by voucher
    group: 2
    turns:
      - { user: pay by voucher }
  - name: no group here
    turns:
      - { user: hi }
      - { user: again }
`);
};
const openFolder = async (page) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${MARKS}"]`)).toHaveCount(1);
};
const suiteRow = (page, file = MARKS) => page.locator(`#suiteList .list-row[data-file="${file}"]`);
const testRow = (page, name) => page.locator("#suiteList .list-row[id^='test-']", { hasText: name }).first();
const turnRows = (page) => page.locator("#suiteList .list-row[id^='turn-']");
const color = (locator) => locator.evaluate((el) => getComputedStyle(el).color);

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("a suite is listed by its name (its file in its tooltip); one with no name by its file", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url);
  await openFolder(page);
  await expect(suiteRow(page).locator(".list-open .list-label")).toHaveText("Checkout flows");
  await expect(suiteRow(page).locator(".list-open")).toHaveAttribute("title", /^Checkout flows · marks\.hafen\.yml · not run yet$/);
  await expect(suiteRow(page, "smoke.hafen.yml").locator(".list-open")).toContainText("Smoke");
  await expect(suiteRow(page, "smoke.hafen.yml").locator(".list-open")).not.toContainText("smoke.hafen.yml");
  // No name: its file
  await writeFile(page, "plain.hafen.yml", "version: 1\nprovider: providers/slow.yml\ntests:\n  - name: one\n    turns: [ { user: hi } ]\n");
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await openFolder(page);
  await expect(suiteRow(page, "plain.hafen.yml").locator(".list-open")).toHaveText("plain.hafen.yml");
});

test("groups: a badge on the suite and its tests (G1, G2), the same colour for the same number, in the list, the suite's view and the top bar", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url);
  await openFolder(page);
  const suiteBadge = suiteRow(page).locator(".group-badge");
  const card = testRow(page, "pays by card").locator(".group-badge");
  const voucher = testRow(page, "pays by voucher").locator(".group-badge");
  await expect(suiteBadge).toHaveText("G2");
  await expect(card).toHaveText("G1");
  await expect(voucher).toHaveText("G2");
  await expect(testRow(page, "no group here").locator(".group-badge")).toHaveCount(0);
  // The same number, the same colour (a suite's G2 and a test's G2); another number, another
  expect(await color(voucher)).toBe(await color(suiteBadge));
  expect(await color(card)).not.toBe(await color(voucher));
  await expect(card).toHaveAttribute("title", /Test group 1: tests in the same group run one after another/);
  await expect(suiteBadge).toHaveAttribute("title", /Suite group 2/);
  // The suite's view, each test's head; the top bar, the suite's
  await suiteRow(page).locator(".list-open").click();
  await expect(page.locator("#suiteTest-0-group")).toHaveText("G1");
  await expect(page.locator("#suiteTest-1-group")).toHaveText("G2");
  await expect(page.locator("#suiteTest-2-group")).toHaveCount(0);
  await expect(page.locator("#evalGroup")).toHaveText("G2");
  // A test's, in the top bar; in the dark theme, still the same colour for the same number
  await testRow(page, "pays by voucher").locator(".list-open").click();
  await expect(page.locator("#evalGroup")).toHaveText("G2");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  expect(await color(voucher)).toBe(await color(suiteBadge));
});

test("×3 for a test that repeats: in the list, the suite's view, the top bar, the Runs list; its latest run shown first (run 3 of 3)", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 150);
  await openFolder(page);
  await expect(testRow(page, "pays by card").locator(".repeat-badge")).toHaveText("×3");
  await expect(testRow(page, "pays by voucher").locator(".repeat-badge")).toHaveCount(0);
  await suiteRow(page).locator(".list-open").click();
  await expect(page.locator("#suiteTest-0-repeat")).toHaveText("×3");
  await testRow(page, "pays by card").locator(".list-open").click();
  await expect(page.locator("#evalRepeat")).toHaveText("×3");
  await expect(page.locator("#evalRepeat")).toHaveAttribute("title", "Runs 3 times");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("passed 3/3", { timeout: 10000 });
  // The latest run is the one shown, and the one the picker has
  await expect(page.locator("#turn-0 .turn-head .label")).toHaveText(/turn 1 · run 3 of 3/i);
  await expect(page.locator("#testInstance")).toHaveValue("3|");
  await expect(page.locator("#testInstance option:checked")).toContainText("run 3 of 3");
  // Another picked: shown; then back to the latest
  await page.selectOption("#testInstance", "1|");
  await expect(page.locator("#turn-0 .turn-head .label")).toHaveText(/run 1 of 3/i);
  // The Runs list says ×3
  await expect(page.locator("#runList .list-row").first()).toContainText("pays by card ×3");
});

test("▷ on a test's row runs that test (and shows it); off while it runs; a circle goes round for what's running", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 1200);
  await openFolder(page);
  const row = testRow(page, "no group here");
  const play = row.locator("[id$='-run']");
  await expect(play).toHaveAttribute("aria-label", "Run no group here");
  await row.hover();
  await play.click();
  // Shown, and going on: off; the turns' icons and the top bar's go round
  await expect(page.locator("#evalTitle")).toHaveText("no group here");
  await expect(page.locator("#status")).toHaveText("running…");
  await row.hover();
  await expect(play).toBeDisabled();
  await expect(page.locator("#evalIcon svg.spinner")).toBeVisible();
  await expect(page.locator("#evalIcon")).toHaveAttribute("data-running", "");
  await expect(turnRows(page).locator(".turn-icon[data-status='running'] svg.spinner").first()).toBeVisible();
  await expect(page.locator(".suite-turn .spinner, #suiteList .spinner").first()).toBeVisible();
  // (it really turns)
  expect(await page.locator("#evalIcon svg.spinner").evaluate((el) => getComputedStyle(el).animationName)).toBe("spin");
  // Done: the box with its tick again, coloured by how it went
  await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 10000 });
  await expect(page.locator("#evalIcon svg.spinner")).toHaveCount(0);
  await expect(page.locator("#suiteList .spinner")).toHaveCount(0);
  await expect(page.locator("#evalIcon svg.icon-test")).toHaveCount(1);
  await expect(play).toBeEnabled();
});

test("when it last ran: the top bar, the suite's view, the panels, the Runs list and the list's tooltips say how long ago", async ({ app: { page, servers } }) => {
  // (the page's clock, ours to move on later; it runs as ever meanwhile)
  await page.clock.install();
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await files(page, servers.mock.url, 100);
  await openFolder(page);
  await testRow(page, "pays by voucher").locator(".list-open").click();
  await expect(page.locator("#status")).toHaveText("not run yet");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText(/passed 1\/1 · [\d.]+ s · just now$/, { timeout: 10000 });
  await expect(page.locator("#testFacts")).toContainText(/when\s*\d{1,2}:\d{2}:\d{2} · just now/);
  await expect(testRow(page, "pays by voucher").locator(".list-open")).toHaveAttribute("title", /last run just now$/);
  await expect(testRow(page, "no group here").locator(".list-open")).toHaveAttribute("title", /not run yet$/);
  await expect(suiteRow(page).locator(".list-open")).toHaveAttribute("title", /last run just now$/);
  await expect(page.locator("#runList .list-row").first().locator(".list-detail")).toHaveText(/^just now · [\d.]+ s$/);
  await suiteRow(page).locator(".list-open").click();
  await expect(page.locator("#suiteTest-1 .turn-summary").first()).toHaveText(/passed 1\/1 · just now/);
  await expect(page.locator("#suiteFacts")).toContainText(/last run\s*\d{1,2}:\d{2}:\d{2} · just now/);
  // Two minutes on: it says so, without a reload (everywhere it's shown)
  await page.clock.fastForward("02:05");
  await expect(page.locator("#runList .list-row").first().locator(".list-detail")).toHaveText(/^2 mins ago · [\d.]+ s$/);
  await expect(page.locator("#suiteTest-1 .turn-summary").first()).toHaveText(/passed 1\/1 · 2 mins ago/);
  // (the suite's own status is its whole runs': none yet)
  await expect(page.locator("#status")).toHaveText("not run yet");
  await testRow(page, "pays by voucher").locator(".list-open").click();
  await expect(page.locator("#status")).toContainText(/passed 1\/1 · [\d.]+ s · 2 mins ago$/);
  await expect(testRow(page, "pays by voucher").locator(".list-open")).toHaveAttribute("title", /last run 2 mins ago$/);
});

test("right-click on a suite or a test in the list: expand all, collapse all", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url);
  await openFolder(page);
  const tests = page.locator(`#suiteList .list-row[id^='test-']`);
  await expect(turnRows(page)).not.toHaveCount(0);
  const visibleTurns = async () => (await turnRows(page).allTextContents()).length;
  const all = await visibleTurns();
  // A suite: it and its tests
  await suiteRow(page).click({ button: "right" });
  await expect(page.locator("#contextMenu #menu-expand-all")).toContainText("Expand all");
  await expect(page.locator("#contextMenu #menu-collapse-all")).toContainText("Collapse all");
  await page.click("#menu-collapse-all");
  await expect(suiteRow(page).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(tests.filter({ hasText: "pays by card" })).toHaveCount(0);
  await suiteRow(page).click({ button: "right" });
  await page.click("#menu-expand-all");
  await expect(suiteRow(page).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(visibleTurns).toBe(all);
  // A test: its suite's tests (folded, their turns hidden; the suite stays open)
  await testRow(page, "pays by voucher").click({ button: "right" });
  await page.click("#menu-collapse-all");
  for (const name of ["pays by card", "pays by voucher", "no group here"]) await expect(testRow(page, name).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(testRow(page, "pays by card")).toBeVisible();
  // (smoke's turns are still there: only this suite's tests were folded)
  await expect(page.locator(`#suiteList .list-row[id^='turn-']`, { hasText: "pay by card" })).toHaveCount(0);
  await testRow(page, "no group here").click({ button: "right" });
  await page.click("#menu-expand-all");
  await expect.poll(visibleTurns).toBe(all);
  // Remembered after a reload
  await suiteRow(page).click({ button: "right" });
  await page.click("#menu-collapse-all");
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await openFolder(page);
  await expect(suiteRow(page).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("right-click on a row of the timeline that has steps under it: expand all, collapse all", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 50);
  await openFolder(page);
  await suiteRow(page).locator(".list-open").click();
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(/passed/, { timeout: 10000 });
  const labels = page.locator(".timeline-label");
  const suite = page.locator(".timeline-label[data-kind='suite']");
  // Expand all on the suite: every step under it
  await suite.click({ button: "right" });
  await page.click("#menu-expand-all");
  await expect(page.locator(".timeline-label[data-kind='turn']").first()).toBeVisible();
  await expect(page.locator(".timeline-label[data-kind='request']").first()).toBeVisible();
  const open = await labels.count();
  // Collapse all: the suite alone; expanding the suite again shows its tests folded
  await suite.click({ button: "right" });
  await page.click("#menu-collapse-all");
  await expect(labels).toHaveCount(1);
  await suite.locator(".tree-toggle").click();
  await expect(page.locator(".timeline-label[data-kind='test']")).toHaveCount(3);
  await expect(page.locator(".timeline-label[data-kind='turn']")).toHaveCount(0);
  // Expand all on one test: its runs, turns and steps
  await page.locator(".timeline-label[data-kind='test']", { hasText: "no group here" }).click({ button: "right" });
  await page.click("#menu-expand-all");
  await expect(page.locator(".timeline-label[data-kind='turn']")).toHaveCount(2);
  await suite.click({ button: "right" });
  await page.click("#menu-expand-all");
  await expect(labels).toHaveCount(open);
  // A row with nothing under it has no menu
  const leaf = page.locator(".timeline-label[data-kind='check']").first();
  if (await leaf.count()) {
    await leaf.click({ button: "right" });
    await expect(page.locator("#contextMenu #menu-expand-all")).toHaveCount(0);
  }
});

test("while a test runs, its panel's Last run says only that it's running, and when it started (no undefined counts)", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 1500);
  await openFolder(page);
  await testRow(page, "pays by voucher").locator(".list-open").click();
  await page.click("#testRun");
  await expect(page.locator("#testFacts")).toContainText("running");
  const facts = await page.locator("#testFacts").innerText();
  expect(facts).not.toMatch(/undefined|passed|checks|tokens/);
  expect(facts).toMatch(/when/);
  await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 10000 });
  await expect(page.locator("#testFacts")).toContainText(/passed\s*1\/1/);
  await expect(page.locator("#testFacts")).toContainText(/checks\s*0\/0/);
});
