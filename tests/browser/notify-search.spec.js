// When a run ends (contracts/ui.md, Notifications): a sound when what ran isn't what's open (or always,
// or never, as Settings → Notifications says; for the outcomes chosen), the toast and the system's
// notification opening what ran; Settings → Notifications; searching Suites and Conversations by name
// and date; a conversation's date with its year; the import button only while Suites is open; the
// expand/collapse menu without hints; the timeline's folding kept across reruns (not across reloads);
// no "new conversation" in the panel.

import { expect, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
// A suite that passes, its replies slow enough to look away while it runs
const GREEN = (url, ms = 900) => `version: 1
name: Green
provider: providers/slow.yml
environments:
  local: { base_url: "${url}" }
tests:
  - name: says hello
    turns:
      - { user: hello, expect: [ { contains: hello } ] }
  - name: says bye
    turns:
      - { user: bye, expect: [ { contains: bye } ] }
`;
const files = async (page, url, ms = 900) => {
  await writeFile(page, "providers/slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(page, "green.hafen.yml", GREEN(url, ms));
};
const openFolder = async (page) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
// The smoke suite's provider slowed (after the folder's opened: opening it writes the fixtures' files)
const slowSmoke = (page, url, ms = 900) => writeFile(page, "providers/mock-json.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse:\n  text: $.data.reply\n`);
// No run going on any more
const runsEnded = (page) => expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(0, { timeout: 15000 });
const testRow = (page, name) => page.locator("#suiteList .list-row[id^='test-']", { hasText: name }).first();
const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`);
const tones = (page) => page.evaluate(() => window.__tones.length);
// The tones' frequencies, to the nearest hertz (an oscillator keeps them as 32-bit floats)
const notes = (page) => page.evaluate(() => window.__tones.map(Math.round));
const settle = (page) => page.waitForTimeout(400);

// Every tone played is counted (window.__tones), and every system notification kept (window.__notes),
// each one's click callable
test.beforeEach(async ({ app: { page } }) => {
  await page.addInitScript(() => {
    window.__tones = [];
    window.__notes = [];
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      createOscillator() {
        const o = super.createOscillator();
        const start = o.start.bind(o);
        o.start = (...a) => { window.__tones.push(o.frequency.value); return start(...a); };
        return o;
      }
    };
    window.Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title, options) { this.title = title; this.options = options; window.__notes.push(this); }
      close() { this.closed = true; }
    };
  });
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("a run that ends while you look at something else: a sound, and its toast opens what ran (a test; a suite)", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url);
  await openFolder(page);
  await slowSmoke(page, servers.mock.url);
  // A test's run; meanwhile a new conversation is open
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await page.click("#newConversation");
  await expect(page.locator("#evalTitle")).toHaveText("New conversation");
  const toast = page.locator(".toast", { hasText: "Passed: says hello" });
  await expect(toast).toBeVisible({ timeout: 10000 });
  await expect.poll(() => tones(page)).toBe(2);               // (the passed chime: two notes, rising)
  expect(await notes(page)).toEqual([659, 988]);
  await expect(toast).toHaveClass(/clickable/);
  await expect(toast).toHaveAttribute("title", "Open it");
  await toast.click();
  await expect(page.locator("#evalTitle")).toHaveText("says hello");
  await expect(page.locator("#testRun")).toBeVisible();
  // A suite's run; meanwhile another suite is open
  await suiteRow(page, "green.hafen.yml").locator(".list-open").click();
  await page.click("#suiteRun");
  await suiteRow(page, SUITE).locator(".list-open").click();
  await expect(page.locator("#evalTitle")).toHaveText("Smoke");
  const suiteToast = page.locator(".toast", { hasText: "Passed: Green" });
  await expect(suiteToast).toBeVisible({ timeout: 15000 });
  await expect.poll(() => tones(page)).toBe(4);
  await suiteToast.click();
  await expect(page.locator("#evalTitle")).toHaveText("Green");
  await expect(page.locator("#suiteRun")).toBeVisible();
  // A failed run: the falling chime
  await suiteRow(page, SUITE).locator(".list-open").click();
  await page.click("#suiteRun");
  await testRow(page, "says hello").locator(".list-open").click();
  await expect(page.locator(".toast", { hasText: "Failed: Smoke" })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await notes(page)).slice(-2)).toEqual([392, 262]);
});

test("looking at what ran (the test, or its suite's view): no sound; Always: a sound anyway; a stopped run: none", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 300);
  await openFolder(page);
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await expect(page.locator(".toast", { hasText: "Passed: says hello" })).toBeVisible({ timeout: 10000 });
  await settle(page);
  expect(await tones(page)).toBe(0);
  // Its suite's view open while it runs: looking at it too
  await page.click("#testRun");
  await suiteRow(page, "green.hafen.yml").locator(".list-open").click();
  await expect(page.locator("#evalTitle")).toHaveText("Green");
  await runsEnded(page);
  await settle(page);
  expect(await tones(page)).toBe(0);
  // Always
  await page.click("#openSettings");
  await page.click("#settings-tab-notifications");
  await page.selectOption("#notifyWhen", "always");
  await page.click("#settingsClose");
  await page.click("#suiteRun");
  await expect.poll(() => tones(page), { timeout: 10000 }).toBe(2);
  // Stopped: no sound
  await page.evaluate(() => { window.__tones = []; });
  await page.click("#suiteRun");
  await page.click("#suiteRun");                                  // (Stop)
  await expect(page.locator(".toast", { hasText: "Stopped" })).toBeVisible({ timeout: 10000 });
  await settle(page);
  expect(await tones(page)).toBe(0);
});

test("Settings → Notifications: sound off; only failed runs; saved; Try it", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 300);
  await openFolder(page);
  await slowSmoke(page, servers.mock.url, 300);
  await page.click("#openSettings");
  await page.click("#settings-tab-notifications");
  await expect(page.locator("#notifySound")).toBeChecked();
  await expect(page.locator("#notifyWhen")).toHaveValue("away");
  await expect(page.locator("#notifyPassed")).toBeChecked();
  await expect(page.locator("#notifyFailed")).toBeChecked();
  // Try it: the sound, and a sample toast (no system notification: that's off)
  await page.click("#notifyTry");
  await expect.poll(() => tones(page)).toBe(2);
  await expect(page.locator(".toast", { hasText: "Passed: a sample run" })).toBeVisible();
  expect(await page.evaluate(() => window.__notes.length)).toBe(0);
  // Sound off: When can't be chosen; nothing plays
  await page.uncheck("#notifySound");
  await expect(page.locator("#notifyWhen")).toBeDisabled();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("eval.notifications")))).toMatchObject({ sound: false });
  await page.click("#settingsClose");
  await page.evaluate(() => { window.__tones = []; });
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await page.click("#newConversation");
  await expect(page.locator(".toast", { hasText: "Passed: says hello" })).toBeVisible({ timeout: 10000 });
  await settle(page);
  expect(await tones(page)).toBe(0);
  // On again, failed runs only: a pass is quiet, a failure isn't
  await page.click("#openSettings");
  await page.click("#settings-tab-notifications");
  await page.check("#notifySound");
  await page.uncheck("#notifyPassed");
  await page.click("#settingsClose");
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await page.click("#newConversation");
  await expect(page.locator(".toast", { hasText: "Passed: says hello" })).toBeVisible({ timeout: 10000 });
  await settle(page);
  expect(await tones(page)).toBe(0);
  await testRow(page, "refund for a broken item").locator(".list-open").click();
  await page.click("#testRun");
  await page.click("#newConversation");
  await expect(page.locator(".toast", { hasText: "Failed: refund for a broken item" })).toBeVisible({ timeout: 10000 });
  await expect.poll(() => tones(page)).toBe(2);
  // Kept after a reload
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await page.click("#openSettings");
  await page.click("#settings-tab-notifications");
  await expect(page.locator("#notifyPassed")).not.toBeChecked();
  await expect(page.locator("#notifyFailed")).toBeChecked();
});

test("system notifications: turned on (the browser asked), shown while the window is in the background; clicked, it opens what ran", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 300);
  await openFolder(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-notifications");
  await expect(page.locator("#notifySystem")).not.toBeChecked();   // (a browser's: off until turned on)
  await page.check("#notifySystem");
  await expect(page.locator("#notifySystem")).toBeChecked();
  await expect(page.locator("#notifySystemState")).toHaveText("allowed");
  await page.click("#settingsClose");
  // In front: none
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await expect(page.locator(".toast", { hasText: "Passed: says hello" })).toBeVisible({ timeout: 10000 });
  await settle(page);
  expect(await page.evaluate(() => window.__notes.length)).toBe(0);
  // In the background: the system's, silent; clicked, the window comes forward on the test
  await page.click("#newConversation");
  await testRow(page, "says bye").locator(".list-open").click();
  await page.click("#testRun");
  await page.click("#newConversation");
  await page.evaluate(() => { document.hasFocus = () => false; });
  await expect.poll(() => page.evaluate(() => window.__notes.length), { timeout: 10000 }).toBe(1);
  expect(await page.evaluate(() => [window.__notes[0].title, window.__notes[0].options.body, window.__notes[0].options.silent])).toEqual(["Passed: says bye", expect.stringMatching(/^1\/1 checks · [\d.]+ s$/), true]);
  await page.evaluate(() => { document.hasFocus = () => true; window.__notes[0].onclick(); });
  await expect(page.locator("#evalTitle")).toHaveText("says bye");
  expect(await page.evaluate(() => window.__notes[0].closed)).toBe(true);
});

test("searching Suites by name, tag and when it last ran; searching Conversations by name and date; a conversation's date has its year", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 50);
  await openFolder(page);
  const search = page.locator("#suitesSearch");
  await expect(search).toHaveAttribute("placeholder", "Search by name or last run");
  // By a suite's name: it, whole
  await search.fill("green");
  await expect(suiteRow(page, "green.hafen.yml")).toBeVisible();
  await expect(suiteRow(page, SUITE)).toHaveCount(0);
  await expect(testRow(page, "says bye")).toBeVisible();
  // By a test's name (any case, words in any order): only it, its suite opened to show it
  await search.fill("");
  await suiteRow(page, "green.hafen.yml").locator(".tree-toggle").click();     // (folded: a search still shows its match)
  await expect(testRow(page, "says bye")).toHaveCount(0);
  await search.fill("BYE says");
  await expect(testRow(page, "says bye")).toBeVisible();
  await expect(testRow(page, "says hello")).toHaveCount(0);
  await expect(suiteRow(page, SUITE)).toHaveCount(0);
  // By a tag
  await search.fill("smoke");
  await expect(testRow(page, "refund for a broken item")).toBeVisible();
  // Nothing: said so
  await search.fill("nothing like this");
  await expect(page.locator("#suitesNoMatch")).toHaveText("No suite or test matches “nothing like this”.");
  // × clears it; Esc too
  await page.click("#suitesSearchClear");
  await expect(search).toHaveValue("");
  await expect(suiteRow(page, SUITE)).toBeVisible();
  // (without a search, the suite folded earlier is folded still)
  await expect(testRow(page, "says hello")).toHaveCount(0);
  await suiteRow(page, "green.hafen.yml").locator(".tree-toggle").click();
  // By when it last ran: today, its date as written several ways, its year
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 10000 });
  const [iso, year, month] = await page.evaluate(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return [`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, String(d.getFullYear()), d.toLocaleString("en", { month: "short" })];
  });
  for (const q of ["today", iso, month, year, "just now"]) {
    await search.fill(q);
    await expect(testRow(page, "says hello")).toBeVisible();
    await expect(testRow(page, "says bye")).toHaveCount(0);
  }
  await search.fill(`hello ${iso}`);
  await expect(testRow(page, "says hello")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  // Conversations: two, by name, by provider, by date; the date has its year
  await page.click("#newConversation");
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await page.fill("#input", "where is my order");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body")).not.toBeEmpty();
  await page.click("#newConversation");
  await page.fill("#input", "a refund please");
  await page.click("#send");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(2);
  await expect(page.locator("#conversationList .list-row").first().locator(".list-detail")).toContainText(`, ${year}, `);
  const conv = page.locator("#conversationsSearch");
  await conv.fill("order");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(1);
  await expect(page.locator("#conversationList .list-row")).toContainText("where is my order");
  await conv.fill("today");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(2);
  await conv.fill("mock-json");
  await expect(page.locator("#conversationList .list-row").first()).toBeVisible();
  await conv.fill(iso);
  await expect(page.locator("#conversationList .list-row")).toHaveCount(2);
  await conv.fill(String(Number(year) - 3));
  await expect(page.locator("#conversationList .list-row")).toHaveCount(0);
  await expect(page.locator("#conversationsNoMatch")).toBeVisible();
});

test("the import button shows only while Suites is open; the expand/collapse menu has no hints; no new conversation in the panel", async ({ app: { page } }) => {
  await expect(page.locator("#openFolder")).toBeVisible();
  await page.click("#suitesToggle");
  await expect(page.locator("#openFolder")).toHaveCount(0);
  await expect(page.locator("#newSuite")).toBeVisible();
  await page.click("#suitesToggle");
  await openFolder(page);
  await suiteRow(page, SUITE).click({ button: "right" });
  await expect(page.locator("#menu-expand-all")).toHaveText("Expand all");
  await expect(page.locator("#menu-collapse-all")).toHaveText("Collapse all");
  await expect(page.locator("#contextMenu .hint")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The conversation's panel: no "new conversation" (the sidebar's + starts one)
  await page.click("#newConversation");
  await expect(page.locator("#panel")).toContainText("Conversation");
  await expect(page.locator("#convReset")).toHaveCount(0);
  await expect(page.locator("#panel button", { hasText: /new conversation/i })).toHaveCount(0);
});

test("the timeline keeps what was folded and opened when a test is run again, and a suite; not after a reload", async ({ app: { page, servers } }) => {
  await files(page, servers.mock.url, 50);
  await openFolder(page);
  await testRow(page, "says hello").locator(".list-open").click();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 10000 });
  const turn = page.locator(".timeline-label[data-kind='turn']").first();
  const requests = page.locator(".timeline-label[data-kind='request']");
  await expect(requests).toHaveCount(1);
  await turn.locator(".tree-toggle").click();                       // folded
  await expect(requests).toHaveCount(0);
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("running", { timeout: 5000 }).catch(() => {});
  await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 10000 });
  await expect(turn.locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(requests).toHaveCount(0);
  // A suite's view: its tests start folded; one opened stays open when the suite runs again
  await suiteRow(page, "green.hafen.yml").locator(".list-open").click();
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(/passed/, { timeout: 10000 });
  const hello = page.locator(".timeline-label[data-kind='test']", { hasText: "says hello" });
  await expect(hello.locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  await hello.locator(".tree-toggle").click();
  await expect(hello.locator(".tree-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(/passed 2\/2/, { timeout: 10000 });
  await expect(hello.locator(".tree-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".timeline-label[data-kind='test']", { hasText: "says bye" }).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  // (its turn, folded in the test's own view, is folded here too: the same step)
  await expect(page.locator(".timeline-label[data-kind='turn']").first().locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  // Not kept after a reload
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await openFolder(page);
  await suiteRow(page, "green.hafen.yml").locator(".list-open").click();
  await expect(page.locator(".timeline-label[data-kind='test']", { hasText: "says hello" }).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
});
