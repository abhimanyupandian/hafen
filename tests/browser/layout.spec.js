// The app's look and layout: what marks a suite or a test in the list, the panels' spacing and
// placeholders, the thread's room, the console, toasts, small screens and phones, and the timeline's
// (its note, height, fit, scrolling and zoom).

import { parse } from "yaml";
import { expect, fileText, fixtureFiles, reopen, test, writeFile, writeFiles } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";

test("with no steps, the timeline's note sits in the middle of the dock, which is as tall as it", async ({ app: { page } }) => {
  const note = page.locator("#timelineEmpty");
  await expect(note).toBeVisible();
  const [body, box] = [await page.locator("#timelineBody").boundingBox(), await note.boundingBox()];
  expect(Math.abs(box.x - body.x)).toBeLessThan(1);
  expect(Math.abs(box.width - body.width)).toBeLessThan(1);
  expect(Math.abs(box.height - body.height)).toBeLessThan(1);
  expect(await note.evaluate((el) => { const cs = getComputedStyle(el); return [cs.textAlign, cs.paddingTop === cs.paddingBottom]; })).toEqual(["center", true]);
});

test("the timeline scrolls without scrollbars", async ({ app: { page } }) => {
  const chart = page.locator(".timeline-chart");
  expect(await chart.evaluate((el) => [getComputedStyle(el).scrollbarWidth, el.offsetWidth - el.clientWidth])).toEqual(["none", 0]);
});

// The suite list and what marks a suite or a test (contracts/ui.md, Sidebar: Suites; Top bar; Thread):
// a suite by its name; its group and a test's (G2, the same colour for the same number); ×3 for a test
// that repeats; ▷ on a test's row; a circle going round for what's running; when it last ran; the
// latest of a test's runs shown first; right-click to expand or collapse it all (the list, the timeline).
test.describe("what marks a suite or a test", () => {
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

  const openApp = async (page) => {
    await reopen(page);
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
    await openApp(page);
    await expect(suiteRow(page).locator(".list-open .list-label")).toHaveText("Checkout flows");
    await expect(suiteRow(page).locator(".list-open")).toHaveAttribute("title", /^Checkout flows · marks\.hafen\.yml · not run yet$/);
    await expect(suiteRow(page, "smoke.hafen.yml").locator(".list-open")).toContainText("Smoke");
    await expect(suiteRow(page, "smoke.hafen.yml").locator(".list-open")).not.toContainText("smoke.hafen.yml");
    // No name: its file
    await writeFile(page, "plain.hafen.yml", "version: 1\nprovider: providers/slow.yml\ntests:\n  - name: one\n    turns: [ { user: hi } ]\n");
    await openApp(page);
    await expect(suiteRow(page, "plain.hafen.yml").locator(".list-open")).toHaveText("plain.hafen.yml");
  });

  test("groups: a badge on the suite and its tests (G1, G2), the same colour for the same number, in the list, the suite's view and the top bar", async ({ app: { page, servers } }) => {
    await files(page, servers.mock.url);
    await openApp(page);
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
    await openApp(page);
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
    await openApp(page);
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
    await files(page, servers.mock.url, 100);
    await openApp(page);
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
    await openApp(page);
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
    await openApp(page);
    await expect(suiteRow(page).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  test("right-click on a row of the timeline that has steps under it: expand all, collapse all", async ({ app: { page, servers } }) => {
    await files(page, servers.mock.url, 50);
    await openApp(page);
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
    await openApp(page);
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
});

test.describe("the panels, and the timeline fitting", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  // (a suite by its file, data-file; a test by its name)
  const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a turn's checks each have a ×; panels don't run out sideways; turns have no dividers and no 'user' label", async ({ app: { page } }) => {
    await row(page, SUITE).locator(".list-open").click();
    const body = page.locator("#panel .panel-body");
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const id of ["#suiteRun", "#suiteAddTest", "#suiteCopyCi"]) {
      const b = await page.locator(id).boundingBox();
      const p = await body.boundingBox();
      expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
    }
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#turn-0-user > .label")).toHaveCount(0);
    expect(await page.locator("#turn-1").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
    await page.locator("#turn-0 .turn-head .label").click();
    const x = page.locator("#turnCheck-0 .list-del");
    expect(await x.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await x.click();
    await x.click();
    await expect.poll(async () => parse(await fileText(page, SUITE)).tests[0].turns[0].expect.length).toBe(3);
  });

  test("the timeline fits without sideways scrolling, and the wheel over its labels scrolls it", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await page.click("#timelineFit");
    const chart = page.locator(".timeline-chart");
    // The chart's width reaches the scale a frame after it changes (a ResizeObserver): it settles there
    await expect.poll(() => chart.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await chart.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await chart.evaluate((el) => el.scrollTop)).toBe(0);
    await page.locator(".timeline-labels").hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(() => chart.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The labels moved with it
    const top = await page.locator(".timeline-labels-inner").evaluate((el) => el.style.top);
    expect(parseFloat(top)).toBeLessThan(0);
  });
});

test.describe("spacing, placeholders, and small screens", () => {
  const openApp = async (page) => {
    await reopen(page);
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  };
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const box = (locator) => locator.boundingBox();
  async function runSmoke(page) {
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
  }

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("the panels' spacing: a label 6px over its field; 14px to facts and buttons; the head's label beside its back button", async ({ app: { page } }) => {
    await openApp(page);
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    const gap = async (upper, lower) => { const [a, b] = [await box(upper), await box(lower)]; return Math.round(b.y - (a.y + a.height)); };
    expect(await gap(page.locator("#panel .field-head", { hasText: "Name (in reports)" }), page.locator("#suiteName"))).toBe(6);
    // (the provider's Fixtures field between: a field as any other, 18px under the one before)
    expect(await gap(page.locator("#suiteProvider").locator(".."), page.locator("#suiteProviderFixturesEdit").locator(".."))).toBe(18);
    expect(await gap(page.locator("#suiteProviderFixturesEdit").locator(".."), page.locator("#suiteProviderFixturesNone"))).toBe(6);
    expect(await gap(page.locator("#suiteProviderFixturesNone"), page.locator("#suiteGroup").locator("../.."))).toBe(14);
    expect(await gap(page.locator("label[for=suiteGroup]"), page.locator("#suiteGroup"))).toBe(6);
    expect(await gap(page.locator("#suiteGroupHint"), page.locator("#suiteFacts"))).toBe(14);
    expect(await gap(page.locator("#suiteFacts"), page.locator("#suiteRun").locator(".."))).toBe(14);
    expect(await gap(page.locator("#suiteName"), page.locator("#panel .field-head", { hasText: "File name" }))).toBe(18);
    // A test's Runs: the label, then its fields' own labels, 6px apart
    await openTest(page, "refund for a broken item");
    expect(await gap(page.locator("#panel .field-head", { hasText: /^Runs$/ }), page.locator("label[for=testRepeat]"))).toBe(6);
    expect(await gap(page.locator("label[for=testRepeat]"), page.locator("#testRepeat"))).toBe(6);
    expect(await gap(page.locator("#testGroupHint"), page.locator("#panel .field-head", { hasText: /^History$/ }))).toBe(18);
    const [back, label] = [await box(page.locator("#panelBack")), await box(page.locator("#panel .panel-head > .block-label"))];
    expect(label.x - (back.x + back.width)).toBeLessThan(12);
    // A panel that starts with facts: from the top of its body as any other
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await page.locator("#runList .list-open").first().click();
    const [body, facts] = [await box(page.locator("#panel .panel-body")), await box(page.locator("#runFacts"))];
    expect(Math.round(facts.y - body.y)).toBe(12);
  });

  test.describe("with nothing in the app yet", () => {
    test.use({ workspace: {} });

    test("placeholders sit in the middle of what holds them: the sidebar's sections, the thread, a panel, Settings", async ({ app: { page, servers } }) => {
      const centred = async (sel, holder) => page.evaluate(([sel, holder]) => {
        const el = document.querySelector(sel);
        const h = el.closest(holder);
        const [a, b] = [el.getBoundingClientRect(), h.getBoundingClientRect()];
        const cs = getComputedStyle(h);
        const top = a.top - b.top - parseFloat(cs.paddingTop);
        const bottom = b.bottom - parseFloat(cs.paddingBottom) - a.bottom;
        return { align: getComputedStyle(el).textAlign, off: Math.abs(top - bottom) };
      }, [sel, holder]);
      for (const [sel, holder] of [["#conversationsEmpty", "#conversationsBody"], ["#runsEmpty", "#runsBody"], ["#suitesEmpty", "#suitesBody"], ["#threadEmpty", "#scroller"]]) {
        const { align, off } = await centred(sel, holder);
        expect(align, sel).toBe("center");
        expect(off, sel).toBeLessThan(4);
      }
      await writeFiles(page, await fixtureFiles(servers.mock.url));
      await openApp(page);
      await openTest(page, "refund for a broken item");
      await page.locator("#turn-0 .turn-head .label").click();
      expect(await page.locator("#turnNotRun").evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
      await page.click("#openSettings");
      await page.click("#settings-tab-runs");
      expect(await page.locator("#settingsEmpty").evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
    });
  });

  test("an empty timeline is as tall as its note (and isn't resized); with steps, as tall as it's set (a fifth of the window by default)", async ({ app: { page } }) => {
    await openApp(page);
    const body = page.locator("#timelineBody");
    await expect(page.locator("#timelineEmpty")).toBeVisible();
    expect((await box(body)).height).toBeLessThan(60);
    await expect(page.locator("#timelineResizer")).toBeHidden();
    await expect(page.locator("#timelineFit")).toHaveCount(0);
    await runSmoke(page);
    await expect(page.locator("#timelineFit")).toBeVisible();
    expect(Math.round((await box(body)).height)).toBe(180);
    expect(await page.locator("#timelineResizer").evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
  });

  test("small screens: the panel shows when something's selected or asked for, under the sidebar's drawer; × hides it", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.locator("#panel")).toBeHidden();
    await expect(page.locator("#panelToggle")).toBeVisible();
    await page.click("#panelToggle");
    await expect(page.locator("#panel")).toBeVisible();
    await expect(page.locator("#panel .panel-head")).toContainText("Conversation");
    // (it covers the top bar's end: its own × closes it)
    await page.click("#panelClose");
    await expect(page.locator("#panel")).toBeHidden();
    // A test picked in the drawer: the drawer closes, and the panel shows it
    await page.click("#menu");
    await openTest(page, "refund for a broken item");
    await expect(page.locator("body")).not.toHaveClass(/nav-open/);
    await expect(page.locator("#panel")).toBeVisible();
    await expect(page.locator("#panel .panel-head")).toContainText("Test");
    // The drawer, opened again (once it's slid in), and its scrim are over it: a point on the panel is
    // the scrim's
    await page.click("#menu");
    await expect.poll(() => page.locator("#nav").evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    const panelBox = await page.locator("#panel").boundingBox();
    const over = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("#scrim, #panel, #nav")?.id, [panelBox.x + panelBox.width / 2, panelBox.y + 200]);
    expect(over).toBe("scrim");
    await page.keyboard.press("Escape");
    await page.click("#panelClose");
    await expect(page.locator("#panel")).toBeHidden();
  });
});

test.describe("the thread's room, the console, toasts and phones", () => {
  // The app loaded again, with the files written so far
  const openApp = async (page) => {
    await reopen(page);
    await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  };
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).click();
  const box = (page, sel) => page.locator(sel).evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  for (const [width, height, least] of [[1440, 900, 0.5], [1024, 768, 0.45]]) {
    test.describe(`at ${width}×${height}`, () => {
      test.use({ viewport: { width, height } });
      test("the thread is the priority: the console starts closed, the timeline a fifth of the window", async ({ app: { page } }) => {
        await expect(page.locator("#consoleToggle")).toHaveAttribute("aria-expanded", "false");
        await openApp(page);
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

  test("a run's toast doesn't cover the panel's head or the top bar: a click on the panel's × lands on it", async ({ app: { page } }) => {
    await openApp(page);
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

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("the panel can be put away, the test kept open; the timeline's ticks don't overlap", async ({ app: { page } }) => {
      await page.click("#menu");
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

  test("a suite's name keeps its room: its count is cut first", async ({ app: { page } }) => {
    await openApp(page);
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
    await openApp(page);
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
});
