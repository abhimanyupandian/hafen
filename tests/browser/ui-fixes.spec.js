// What a usability audit found, fixed (spec/design: Additions and patterns): nothing typed is lost (a
// message refused before it's sent, said under the box; a problem known before, in the panel; YAML
// that doesn't parse in Settings → Providers); the thread is the priority (the console starts
// closed, the timeline's default height); toasts never cover the panel's controls; the theme follows
// the system until one's chosen; on a phone the panel can be put away without closing what's open,
// and the timeline's ticks don't overlap; the first step is a button; and the smaller ones (a failed
// check's icon, a cut-short reply, a suite's problems before it's run and logged once, the new suite
// form, searching by status, a plugin's editor going back where its link was, a conversation's after
// fixtures in the console).

import { parse } from "yaml";
import { expect, fileText, test } from "./fixtures.js";

// A file put in the folder the app opens (the Origin Private File System)
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);

const openFolder = async (page) => {
  await page.click("#threadOpenFolder");
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
};
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).click();
const box = (page, sel) => page.locator(sel).evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const NOTE_FIXTURE = "export default { kind: \"fixture\", name: \"note\", version: \"1.0.0\", async run() {} };\n";
const provider = (url, more = "") => `kind: http\nurl: "${url}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n${more}`;

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

/* ---------- 1. a message isn't lost ---------- */

test("a provider whose fixture isn't there: said in the panel before sending, Send off; a message refused when sent comes back, with why under the box", async ({ app: { page, servers } }) => {
  await writeFile(page, "providers/fxmissing.yml", provider(`${servers.mock.url}/json`, "fixtures: { before: [nope] }\n"));
  await openFolder(page);
  // Known before sending: said in the panel, by the provider (not at the box), Send off (its title says why)
  await page.selectOption("#convProvider", "providers/fxmissing.yml");
  await page.fill("#input", "hello there");
  await expect(page.locator("#panel #convFixturesProblem")).toContainText('fxmissing: the fixture "nope" (fixtures.before) isn\'t in the folder\'s plugins/');
  await expect(page.locator("#sendProblem")).toHaveCount(0);
  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator("#send")).toHaveAttribute("title", /Can't send: the fixture "nope"/);
  await expect(page.locator("#convFixturesFix")).toHaveText("edit the provider");
  // Not known (the file changed since the folder was read): refused when sent, the message back in the
  // box, why under it, and no turn of it in the thread
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await expect(page.locator("#convFixturesProblem")).toHaveCount(0);
  await writeFile(page, "providers/mock-json.yml", `${await fileText(page, "providers/mock-json.yml")}fixtures: { before: [gone] }\n`);
  await page.fill("#input", "I want a refund for order 4417");
  await page.click("#send");
  await expect(page.locator("#sendProblem")).toContainText('the fixture "gone"');
  await expect(page.locator("#input")).toHaveValue("I want a refund for order 4417");
  await expect(page.locator("#turn-0")).toHaveCount(0);
});

/* ---------- 2. YAML that doesn't parse isn't lost ---------- */

test("Settings → Providers: YAML that isn't valid stays, with its line; Try it keeps Settings open; closing asks first, then discards", async ({ app: { page } }) => {
  await openFolder(page);
  const before = await fileText(page, "providers/mock-json.yml");
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-json-open");
  await expect(page.locator("#providerYaml")).toHaveValue(/kind: http/);
  const typed = "kind: http\nbody: { message: \"{{user}}\"\nresponse: x\n";
  await page.fill("#providerYaml", typed);
  await page.locator("#providerYaml").blur();
  await expect(page.locator("#providerYamlError")).toContainText(/line \d+, column \d+: .*Not saved/);
  // Try it: Settings stays open, with the edits, and says why
  await page.click("#providerTry");
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#providerYaml")).toHaveValue(typed);
  await expect(page.locator("#providerYamlError")).toContainText("fix it to try the provider");
  // Closing asks first (the edits kept), the second time it goes, and the file is as it was
  await page.click("#settingsClose");
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#settingsClose")).toHaveText("discard edits?");
  await expect(page.locator("#providerYamlError")).toContainText("close again to discard your edits");
  await expect(page.locator("#providerYaml")).toHaveValue(typed);
  await page.click("#settingsClose");
  await expect(page.locator("#settingsModal")).toHaveCount(0);
  expect(await fileText(page, "providers/mock-json.yml")).toBe(before);
  // YAML that is valid is saved as Settings closes (Esc)
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-json-open");
  await expect(page.locator("#providerYaml")).toHaveValue(/kind: http/);
  await page.fill("#providerYaml", `${before}timeout_ms: 9000\n`);
  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsModal")).toHaveCount(0);
  await expect.poll(async () => parse(await fileText(page, "providers/mock-json.yml")).timeout_ms).toBe(9000);
});

test("Settings: its head stays at the top as the content scrolls, so the close button never floats over a field", async ({ app: { page } }) => {
  await openFolder(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-json-open");
  await expect(page.locator("#providerYaml")).toBeVisible();
  await page.locator("#settingsContent").evaluate((el) => { el.scrollTop = 400; });
  const content = await box(page, "#settingsContent");
  const head = await box(page, ".settings-content-head");
  expect(Math.abs(head.top - content.top)).toBeLessThan(2);
  const close = await box(page, "#settingsClose");
  expect(close.bottom).toBeLessThanOrEqual(head.bottom + 1);
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("#settingsClose")?.id, [close.left + close.width / 2, close.top + close.height / 2]);
  expect(hit).toBe("settingsClose");
});

/* ---------- 3. the thread first ---------- */

for (const [width, height, least] of [[1440, 900, 0.5], [1024, 768, 0.45]]) {
  test.describe(`at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } });
    test("the thread is the priority: the console starts closed, the timeline a fifth of the window", async ({ app: { page } }) => {
      await expect(page.locator("#consoleToggle")).toHaveAttribute("aria-expanded", "false");
      await openFolder(page);
      await openTest(page, "refund for a broken item");
      await page.click("#testRun");
      await expect(page.locator("#status")).toContainText("failed 0/1");
      await expect(page.locator(".timeline-bar").first()).toBeVisible();
      const thread = await box(page, "#scroller");
      expect(thread.height).toBeGreaterThanOrEqual(height * least);
      const timeline = await box(page, "#timelineBody");
      expect(Math.abs(timeline.height - Math.round(Math.min(240, Math.max(120, height / 5))))).toBeLessThanOrEqual(1);
      // Opened, the console is remembered; dragged taller, so is its height (the design system's resizer)
      await page.click("#consoleToggle");
      await expect(page.locator("#consoleBody")).toBeVisible();
      await page.reload();
      await page.locator("html:not(.loading)").waitFor();
      await expect(page.locator("#consoleToggle")).toHaveAttribute("aria-expanded", "true");
    });
  });
}

test("an open console with nothing in it is only as tall as its note", async ({ app: { page } }) => {
  await page.click("#consoleToggle");
  await page.click("#consoleClear");
  await expect(page.locator("#consoleEmpty")).toBeVisible();
  expect((await box(page, "#consoleBody")).height).toBeLessThan(80);
  await expect(page.locator("#consoleResizer")).toBeHidden();
});

/* ---------- 4. toasts ---------- */

test("a run's toast doesn't cover the panel's head or the top bar: a click on the panel's × lands on it", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  const toast = page.locator(".toast", { hasText: "Failed: refund for a broken item" });
  await expect(toast).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(400);  // (slid in)
  const t = await box(page, ".toast");
  for (const sel of ["#panel .panel-head", "#topbar", "#composer", "#timeline"]) expect(overlaps(t, await box(page, sel)), sel).toBe(false);
  const close = await box(page, "#panelClose");
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.id, [close.left + close.width / 2, close.top + close.height / 2]);
  expect(hit).toBe("panelClose");
  const back = await box(page, "#panelBack");
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.id, [back.left + back.width / 2, back.top + back.height / 2])).toBe("panelBack");
});

/* ---------- 5. the theme ---------- */

test.describe("with the system dark", () => {
  test.use({ colorScheme: "dark" });
  test("a first visit follows the system; a choice of Light or Dark is kept", async ({ app: { page } }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.click("#openSettings");
    await page.click("#settings-tab-appearance");
    await expect(page.locator("#themeSelect")).toHaveValue("system");
    await page.selectOption("#themeSelect", "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await page.locator("html:not(.loading)").waitFor();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

/* ---------- 6. a phone ---------- */

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("the panel can be put away, the test kept open; the timeline's ticks don't overlap", async ({ app: { page } }) => {
    await page.click("#menu");
    await page.click("#suitesOpenFolder");
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#panel")).toHaveClass(/shown/);
    await expect(page.locator("#panelHide")).toBeVisible();
    await page.click("#panelHide");
    await expect(page.locator("#panel")).toBeHidden();
    await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "test");
    await expect(page.locator("#turn-0")).toBeVisible();
    await page.click("#testHeaderRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    const ticks = await page.locator(".timeline-axis span").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right]; }));
    expect(ticks.length).toBeGreaterThan(1);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i][0]).toBeGreaterThan(ticks[i - 1][1]);
    // Shown again from the top bar, on the same test
    await page.click("#panelToggle");
    await expect(page.locator("#panel .panel-head")).toContainText("Test");
    // (on a wide screen there's no hide: the panel is beside the thread)
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#panelHide")).toBeHidden();
  });
});

/* ---------- 7. the first step ---------- */

test("first run: the thread's note has an Open a folder button, Suites' note a link; the panel offers to open one before a provider", async ({ app: { page } }) => {
  await expect(page.locator("#threadOpenFolder")).toHaveText("Open a folder");
  await expect(page.locator("#suitesOpenFolder")).toHaveText("Open a folder");
  await expect(page.locator("#convProviders")).toHaveText("open a folder");
  await page.click("#convProviders");
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator("#threadOpenFolder")).toHaveCount(0);
  await expect(page.locator("#convProviders")).toHaveText("manage");
});

test("Settings → Providers before a folder is open offers to open one, not a form that can't be saved", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await expect(page.locator("#newProviderForm")).toHaveCount(0);
  await page.click("#providersOpenFolder");
  await expect(page.locator("#provider-mock-json")).toBeVisible();
});

/* ---------- 8. the smaller ones ---------- */

test("a failed check's card has a cross, not a tick; a test's tags field shows no example values", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#testTags")).toHaveAttribute("placeholder", "No tags yet");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await page.locator("#turn-1 .turn-head .label").click();
  await expect(page.locator("#turnCheck-0")).toHaveAttribute("data-status", "fail");
  await expect(page.locator("#turnCheck-0 .icon-fail")).toHaveCount(1);
  await expect(page.locator("#turnCheck-0 .icon-check")).toHaveCount(0);
  await page.locator("#turn-0 .turn-head .label").click();
  await expect(page.locator("#turnCheck-0 .icon-check")).toHaveCount(1);
});

test("a stream cut short shows what came, marked so; a turn that failed before any text has no time to first token", async ({ app: { page, servers } }) => {
  await writeFile(page, "providers/cut.yml", `kind: http\nurl: "${servers.mock.url}/cut"\nbody: { message: "{{user}}" }\nstream: sse\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n`);
  await writeFile(page, "providers/err500.yml", provider(`${servers.mock.url}/error/500`));
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/cut.yml");
  await page.fill("#input", "tell me a story");
  await page.click("#send");
  await expect(page.locator("#turn-0-cut")).toContainText("cut short:");
  await expect(page.locator("#turn-0-partial")).toContainText("This reply is");
  await expect(page.locator("#turn-0-partial")).toBeVisible();
  await page.selectOption("#convProvider", "providers/err500.yml");
  await page.fill("#input", "hello");
  await page.click("#send");
  await expect(page.locator("#turn-1-reply .msg-body.error")).toBeVisible();
  await expect(page.locator("#turn-1-reply")).not.toContainText("to first token");
});

test("a provider's kind is its file's (kind: http), with how it reads its reply", async ({ app: { page } }) => {
  await openFolder(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await expect(page.locator("#provider-mock-json")).toContainText("http (json)");
  await expect(page.locator("#provider-mock-sse")).toContainText("http (sse)");
  await page.click("#provider-mock-json-open");
  await expect(page.locator("#providerFacts")).toContainText("kindhttp (json)");
});

test("a check type that isn't one is a problem before the suite's run, as validate says; logged once, not again when the folder's read again", async ({ app: { page } }) => {
  await writeFile(page, "typos.hafen.yml", "version: 1\nprovider: providers/mock-json.yml\nenvironments:\n  local: { base_url: \"http://127.0.0.1:1\" }\ntests:\n  - name: typo\n    turns:\n      - user: hi\n        expect:\n          - { type: contians, value: refund }\n");
  await openFolder(page);
  const row = page.locator('#suiteList .list-row[data-file="typos.hafen.yml"]');
  await expect(row.locator(".list-size")).toHaveText("1 problem");
  await row.locator(".list-open").click();
  await expect(page.locator("#panel .problems")).toContainText('line 10: "contians" isn\'t a check type (did you mean "contains"?)');
  const logged = () => page.locator("#consoleBody .err", { hasText: "isn't a check type" }).count();
  await expect.poll(logged).toBe(1);
  // The folder read again (a provider saved): the same problem isn't logged again
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-json-open");
  await page.fill("#providerYaml", `${await fileText(page, "providers/mock-json.yml")}timeout_ms: 9000\n`);
  await page.locator("#providerYaml").blur();
  await expect.poll(async () => parse(await fileText(page, "providers/mock-json.yml")).timeout_ms).toBe(9000);
  await page.click("#settingsClose");
  await page.waitForTimeout(500);
  expect(await logged()).toBe(1);
  // Fixed in its panel: gone
  await page.locator('#suiteList .list-open[aria-label="turn 1: hi"]').click();
  await page.locator("#turnCheck-0-open").click();
  await page.fill("#checkYaml", "type: contains\nvalue: refund");
  await page.locator("#checkYaml").blur();
  await expect(row.locator(".list-size")).toHaveText("1 test");
});

test("Suites' + asks for a name and uses the provider in use; searching by status finds failed tests", async ({ app: { page } }) => {
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/mock-sse.yml");
  await page.click("#newSuite");
  await expect(page.locator("#newSuiteName")).toBeFocused();
  await expect(page.locator("#newSuiteName")).toHaveAttribute("placeholder", "tests");
  await expect(page.locator("#newSuiteNote")).toHaveText("tests.hafen.yml · provider mock-sse");
  await page.fill("#newSuiteName", "bad name!");
  await expect(page.locator("#newSuiteProblem")).toBeVisible();
  await expect(page.locator("#newSuiteAdd")).toBeDisabled();
  await page.fill("#newSuiteName", "checkout");
  await page.press("#newSuiteName", "Enter");
  await expect(page.locator('#suiteList .list-row[data-file="checkout.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator("#newSuiteForm")).toHaveCount(0);
  expect(parse(await fileText(page, "checkout.hafen.yml")).provider).toBe("providers/mock-sse.yml");
  // A name that's taken is said, not written over
  await page.click("#newSuite");
  await page.fill("#newSuiteName", "checkout");
  await page.press("#newSuiteName", "Enter");
  await expect(page.locator("#newSuiteProblem")).toContainText("is there already");
  await page.press("#newSuiteName", "Escape");
  await expect(page.locator("#newSuiteForm")).toHaveCount(0);
  // By status
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await page.fill("#suitesSearch", "failed");
  await expect(page.locator("#suiteList .list-open", { hasText: "refund for a broken item" })).toBeVisible();
  await expect(page.locator("#suiteList .list-open", { hasText: "New test" })).toHaveCount(0);
  await page.fill("#suitesSearch", "passed");
  await expect(page.locator("#suitesNoMatch")).toBeVisible();
});

test("a suite's name keeps its room: its count is cut first", async ({ app: { page } }) => {
  await openFolder(page);
  await page.locator("#navResizer").focus();
  await page.keyboard.press("Home");  // (the narrowest sidebar)
  const row = page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]');
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(row.locator(".list-size")).toHaveText("1 test · 1 failed");
  const label = await row.locator(".list-open").evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(label).toBe(true);
});

test("the timeline's zoom buttons are never over a bar", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  const zoom = await box(page, "#timelineZoom");
  const bars = await page.locator(".timeline-bar").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; }));
  expect(bars.length).toBeGreaterThan(3);
  for (const b of bars) expect(overlaps(zoom, b)).toBe(false);
  await page.click("#timelineZoomIn");
  await page.click("#timelineZoomIn");
  const zoomed = await page.locator(".timeline-bar").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; }));
  const chart = await box(page, ".timeline-chart");
  for (const b of zoomed.filter((x) => overlaps(x, chart))) expect(overlaps(zoom, b)).toBe(false);
});

test("a fixture's code opened from a link: closing the editor goes back where the link was, out of Settings", async ({ app: { page, servers } }) => {
  await writeFile(page, "plugins/note.js", NOTE_FIXTURE);
  await writeFile(page, "providers/noted.yml", provider(`${servers.mock.url}/json`, "fixtures: { before: [note] }\n"));
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/noted.yml");
  await page.click("#convFixtures-before-0");
  await expect(page.locator("#editor")).toBeVisible();
  await page.click("#editorCancel");
  await expect(page.locator("#settingsModal")).toHaveCount(0);
  // From Settings → Providers' own fixtures list: back there
  await page.click("#convFixturesEdit");
  await page.click("#providerFixtures-before-0-code");
  await expect(page.locator("#editor")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#settingsTitle")).toHaveText("Providers");
  await expect(page.locator("#providerYaml")).toBeVisible();
});

test("a conversation's after and afterAll fixtures have their lines in the console when it's let go", async ({ app: { page, servers } }) => {
  await writeFile(page, "plugins/note.js", NOTE_FIXTURE);
  await writeFile(page, "providers/noted.yml", provider(`${servers.mock.url}/json`, "fixtures: { before: [note], after: [note], afterAll: [note] }\n"));
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/noted.yml");
  await page.fill("#input", "hello");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said");
  await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=note phase=before");
  await page.click("#newConversation");
  await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=note phase=after ");
  await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=note phase=afterAll");
});
