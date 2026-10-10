// Runs: started (a row's ▷, ⌘↵ / Ctrl+Enter, groups and several runs at once), shown (read-only from
// Runs, Compare with, a test's charts, the top bar's status), run again, stopped, deleted and cleared;
// how a run's last try shows (error, couldn't run, stopped); and a run's steps picked on the timeline.

import { _electron as electron } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addScope, chooseScope, colour, expect, fileText, reopen, showEntry, test, toast, token, writeFile } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`).first();

test("a run opened from Runs is shown read-only, and exports as a run file", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed");
  await page.locator("#runList .list-open").first().click();
  await expect(page.locator("#evalTitle")).toContainText("· run");
  await expect(page.locator("#composer")).toHaveCount(0);
  await expect(page.locator("#runFacts")).toContainText("browser");
  const download = page.waitForEvent("download");
  await page.click("#exportRun");
  expect((await download).suggestedFilename()).toMatch(/\.hafen-run\.json$/);
});

test.describe("started from a row, a key or a group, and deleted", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  // (a suite by its file, data-file; a test by its name)
  const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();
  const runKeys = ["Control+Enter", "Meta+Enter"];
  const clearMockLog = (servers) => fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
  const confirmDelete = async (locator) => { await locator.click(); await locator.click(); };

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
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

  test("⌘↵ / Ctrl+Enter in Settings doesn't run the test that's open", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await page.locator("#secretName").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await page.waitForTimeout(500);
    await expect(page.locator("#runList .list-row")).toHaveCount(0);
    await expect(page.locator("#settingsModal")).toBeVisible();
  });

  test("groups: a run's tests in different groups go at once (none: one after another), and several runs go on at once", async ({ app: { page, servers } }) => {
    // Slow replies, so runs overlap for sure
    const slow = `kind: http\nurl: "${servers.mock.url}/slow?ms=400"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`;
    await writeFile(page, "providers/mock-json.yml", slow);
    // Settings has no "tests at once" any more: groups in the files say what runs at once
    await page.click("#openSettings");
    await expect(page.locator("#settings-tab-running")).toHaveCount(0);
    await page.click("#settingsClose");
    // Three tests in smoke (two more), each in a group of its own, and a second suite (it gets smoke's
    // environments: its provider's)
    for (const name of ["second", "third"]) {
      const r = row(page, SUITE);
      await r.hover();
      await r.locator("[id$='-add']").click();
      await expect(page.locator("#testName")).toHaveValue("New test");  // (the new test's panel)
      await page.fill("#testName", name);
      await page.press("#testName", "Enter");
      await expect(row(page, name)).toBeVisible();
    }
    for (const [name, group] of [["refund for a broken item", 1], ["second", 2], ["third", 3]]) {
      await openTest(page, name);
      await page.fill("#testGroup", String(group));
      await page.press("#testGroup", "Enter");
      await expect.poll(async () => parse(await fileText(page, SUITE)).tests.find((t) => t.name === name)?.group).toBe(group);
    }
    await page.click("#newSuite");
    await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
    await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(1);
    expect(parse(await fileText(page, "tests.hafen.yml")).environments).toEqual(parse(await fileText(page, SUITE)).environments);
    // Both suites at once
    await clearMockLog(servers);
    await row(page, SUITE).hover();
    await row(page, SUITE).locator("[id$='-run']").click();
    await row(page, "tests.hafen.yml").hover();
    await row(page, "tests.hafen.yml").locator("[id$='-run']").click();
    await expect(page.locator("#runList li[id^=run-live-]")).toHaveCount(2);
    // The same suite again isn't started: its ▷ is off while it runs
    await row(page, SUITE).hover();
    await expect(row(page, SUITE).locator("[id$='-run']")).toBeDisabled();
    await expect(page.locator("#runList li[id^=run-live-]")).toHaveCount(0, { timeout: 15000 });
    // Each suite's view has its own result
    await row(page, "tests.hafen.yml").locator(".list-open").click();
    await expect(page.locator("#status")).toContainText("passed 1/1");
    await row(page, SUITE).locator(".list-open").click();
    await expect(page.locator("#status")).toContainText("failed 2/3");
    // The smoke run's tests overlapped (3 groups at once), and each test's turns kept their order
    const kept = await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open("hafen");
      req.onsuccess = () => { const g = req.result.transaction("runs").objectStore("runs").getAll(); g.onsuccess = () => resolve(g.result); };
    }));
    const smokeRun = kept.find((r) => r.suites.some((s) => s.file === SUITE));
    const testSpans = smokeRun.spans.filter((s) => s.kind === "test");
    expect(testSpans).toHaveLength(3);
    expect(testSpans.some((a, i) => testSpans.some((b, j) => i !== j && a.start < b.end && b.start < a.end))).toBe(true);
    expect(smokeRun.turns.filter((t) => t.test === "t_smoke001").map((t) => t.index)).toEqual([0, 1]);
    expect(smokeRun.turns.every(Boolean)).toBe(true);
    // Two runs at once (a test in each suite); stopping one leaves the other
    await openTest(page, "second");
    await page.click("#testRun");
    await openTest(page, "New test");
    await page.click("#testRun");
    await expect(page.locator("#runList li[id^=run-live-]")).toHaveCount(2);
    await openTest(page, "second");
    await expect(page.locator("#testRun")).toHaveText("Stop");
    await page.click("#testRun");
    await expect(page.locator("#runList li[id^=run-live-]")).toHaveCount(0, { timeout: 15000 });
    await openTest(page, "New test");
    await expect(page.locator("#status")).toContainText("passed 1/1");
  });

  test("runs: deleted from the sidebar, the run's panel and Settings, and cleared", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    for (let i = 0; i < 3; i++) {
      await page.click("#testRun");
      await expect(page.locator("#runList .list-row")).toHaveCount(i + 1);
    }
    const first = page.locator("#runList .list-row").first();
    await first.hover();
    await confirmDelete(first.locator(".list-del"));
    await expect(page.locator("#runList .list-row")).toHaveCount(2);
    await page.locator("#runList .list-open").first().click();
    await confirmDelete(page.locator("#runDelete"));
    await expect(page.locator("#runList .list-row")).toHaveCount(1);
    await page.click("#openSettings");
    await page.click("#settings-tab-runs");
    await expect(page.locator("#settings-runs-list .settings-row")).toHaveCount(1);
    await page.click("#settingsClose");
    await page.click("#openTest" === "" ? "body" : "#runsToggle").catch(() => {});
    await page.locator("#runsToggle").getAttribute("aria-expanded").then(async (open) => { if (open === "false") await page.click("#runsToggle"); });
    await confirmDelete(page.locator("#clearRuns"));
    await expect(page.locator("#runsEmpty")).toBeVisible();
  });

  test("a step picked in a test keeps the test in the thread; a turn picked in a run keeps the run", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await page.locator(".timeline-bar[data-kind='request']").first().click();
    await expect(page.locator("#panel .panel-head")).toContainText("Step");
    await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
    await expect(page.locator("#turn-0-reply")).toBeVisible();
    await expect(page.locator(".timeline-bar").first()).toBeVisible();
    // The run, opened from Runs, then one of its turns
    await page.locator("#runList .list-open").first().click();
    await expect(page.locator("#evalTitle")).toHaveText(/· run$/);
    await page.locator("#turn-1-reply .msg-body").click();
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 2");
    await expect(page.locator("#evalTitle")).toHaveText(/· run$/);
    await expect(page.locator("#composer")).toHaveCount(0);
  });
});

test.describe("Compare with, and a test's charts", () => {
  const suiteData = async (page) => parse(await fileText(page, SUITE));
  const fileSays = (page, check) => expect.poll(async () => { try { return check(await suiteData(page)); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  const openTest = (page, name = "refund for a broken item") => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const turnRow = (page, n) => page.locator(`#suiteList .list-open[aria-label^="turn ${n}:"]`).first();
  const run = async (page, status) => {
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText(status);
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(0);
  };

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a run's Compare with: an earlier run of its suites, each number as run · was · change, the checks that flipped, and a regression said", async ({ app: { page } }) => {
    await openTest(page);
    await run(page, "failed 0/1");
    // Turn 2's message changed so its check (contains refund) passes: the same check, flipped
    await turnRow(page, 2).click();
    await page.fill("#turnUser", "a refund, please");
    await page.locator("#turnUser").blur();
    await fileSays(page, (d) => d.tests[0].turns[1].user === "a refund, please");
    await openTest(page);
    await run(page, "passed 1/1");
    // The later run (newest first), compared with the earlier
    await expect(page.locator("#runList .list-row")).toHaveCount(2);
    await page.locator("#runList .list-open").first().click();
    await expect(page.locator("#evalTitle")).toHaveText(/· run$/);
    await expect(page.locator("#runBaseline option")).toHaveCount(2);
    await expect(page.locator("#runComparison")).toHaveCount(0);
    await page.selectOption("#runBaseline", { index: 1 });
    const facts = page.locator("#runComparison");
    await expect(facts).toContainText("pass rate");
    await expect(facts).toContainText("100% · was 0% · +100 pts");
    for (const label of ["p50", "p95", "cost"]) await expect(facts).toContainText(label);
    await expect(facts).toContainText(/cost\s*\$[\d.]+ · was \$[\d.]+/);
    await expect(page.locator("#panel")).toContainText("refund for a broken item · turn 2 · contains refund: fail → pass");
    // (the app's thresholds are pass_rate 5, p95 20%, cost 20%: the pass rate rose, so it isn't that)
    await expect(page.locator("#panel .hint.error", { hasText: "pass rate fell" })).toHaveCount(0);
    // The earlier run, compared with the later one: it's worse, and said so
    await page.locator("#runList .list-open").nth(1).click();
    // (another run open: its own choice, none yet, and no comparison of the other's left showing)
    await expect(page.locator("#status")).toContainText("failed");
    await expect(page.locator("#runBaseline")).toHaveValue("");
    await expect(page.locator("#runComparison")).toHaveCount(0);
    await page.selectOption("#runBaseline", { index: 1 });
    await expect(page.locator("#runComparison")).toContainText("0% · was 100% · -100 pts");
    await expect(page.locator("#panel")).toContainText("refund for a broken item · turn 2 · contains refund: pass → fail");
    await expect(page.locator("#panel .hint.error")).toContainText("Regressed: pass rate fell 100 points (limit 5)");
  });

  test("a test's charts: pass rate, p95 and cost over its runs, once it has two", async ({ app: { page } }) => {
    await openTest(page);
    await expect(page.locator("#testChartPass")).toHaveCount(0);
    await run(page, "failed 0/1");
    await expect(page.locator("#testChartPass")).toHaveCount(0);
    await run(page, "failed 0/1");
    for (const [id, label] of [["testChartPass", "Pass rate"], ["testChartP95", "p95"], ["testChartCost", "Cost"]]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-label", new RegExp(`^${label}: latest `));
    }
    await expect(page.locator("#testChartPass")).toHaveAttribute("aria-label", "Pass rate: latest 0%, from 0% to 0%");
    await expect(page.locator("#testChartPass .chart-point")).toHaveCount(2);
  });
});

test.describe("run again, Runs, the status, Esc, and a run's steps on the timeline", () => {
  const openApp = async (page) => {
    await reopen(page);
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  };
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  const slowProvider = (page, ms) => writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  const confirm = async (locator) => { await locator.click(); await locator.click(); };
  const runs = (page) => page.evaluate(async () => {
    const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const db = await done(indexedDB.open("hafen"));
    const all = await done(db.transaction("runs").objectStore("runs").getAll());
    db.close();
    return all.sort((a, b) => a.started - b.started);
  });

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("\"run again\" runs what ran: a test up to its turn as it was; a deleted test says so, not the whole suite instead", async ({ app: { page } }) => {
    await openApp(page);
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click({ button: "right" });
    await page.click("#menu-turn-upto");
    await expect(page.locator("#status")).toContainText("to turn 1");
    await page.locator("#runList .list-open").first().click();
    await page.click("#runAgain");
    await expect.poll(async () => (await runs(page)).length).toBe(2);
    expect((await runs(page))[1].settings.until_turn).toBe(0);
    // Its test deleted: says so, runs nothing
    await openTest(page, "refund for a broken item");
    await confirm(page.locator("#testDelete"));
    await fileSays(page, (d) => (d.tests ?? []).length === 0);
    await page.locator("#runList .list-open").first().click();
    await page.click("#runAgain");
    await expect(toast(page, "isn't in your suites any more")).toBeVisible();
    await page.waitForTimeout(300);
    expect((await runs(page)).length).toBe(2);
  });

  test("a conversation's run file isn't opened under Runs: it says so", async ({ app: { page } }) => {
    await openApp(page);
    const run = { _id: "explore000000001", kind: "hafen-run", version: 1, mode: "explore", suites: [], tests: [], turns: [], spans: [], started: Date.now(), status: "done" };
    await page.locator("#runsSection input[type=file]").setInputFiles({ name: "x.hafen-run.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(run)) });
    await expect(toast(page, "conversation's run")).toBeVisible();
    await expect(page.locator("#runList .list-row")).toHaveCount(0);
  });

  test("a run whose tests the app hasn't got: the test picked shows; its turn and check, as the run recorded them; Back keeps it", async ({ app: { page } }) => {
    await openApp(page);
    const row = suiteRow(page, SUITE);
    await row.hover();
    await row.locator(".list-add[id$='-add']").click();
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    await page.click("#suiteRun");
    await expect(page.locator("#status")).toContainText(/failed|passed/);
    // The suite renamed: the run's tests aren't in the app by their file any more
    await page.fill("#suiteFile", "elsewhere");
    await page.press("#suiteFile", "Enter");
    await expect(page.locator('#suiteList .list-row[data-file="elsewhere.hafen.yml"]')).toHaveCount(1);
    await page.locator("#runList .list-open").first().click();
    await expect(page.locator("#runTests li")).toHaveCount(2);
    const second = await page.locator("#runTests li").nth(1).locator(".list-open").textContent();
    await page.locator("#runTests li").nth(1).locator(".list-open").click();
    await expect(page.locator("#turn-0-user")).toContainText(second === "New test" ? "Hello" : "I want a refund");
    await page.locator("#turn-0 .turn-head .label").click();
    await expect(page.locator("#turnFromRun")).toBeVisible();
    await expect(page.locator("#turnChecks .check-card").first()).toBeVisible().catch(() => {});
    await page.click("#panelBack");
    await expect(page.locator("#panel .panel-head")).toContainText("Run");
    await expect(page.locator("#turn-0-user")).toContainText(second === "New test" ? "Hello" : "I want a refund");
  });

  test("Settings → Runs lists a run kept without its tests or suites", async ({ app: { page } }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const tx = db.transaction("runs", "readwrite");
      tx.objectStore("runs").put({ _id: "partial000000001", started: Date.now(), status: "interrupted" });
      await new Promise((r) => { tx.oncomplete = r; });
      db.close();
    });
    await page.click("#openSettings");
    await page.click("#settings-tab-runs");
    await expect(page.locator("#settings-runs-partial000000001")).toBeVisible();
  });

  test("the top bar's status is red when the test failed", async ({ app: { page } }) => {
    await openApp(page);
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    expect(await page.locator("#status").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--danger"));
  });

  test("Esc in a dialog closes the dialog: the run going on goes on", async ({ app: { page, servers } }) => {
    await slowProvider(page, 2000);
    await writeFile(page, "slow.hafen.yml", `version: 1\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns: [ { user: wait } ]\n`);
    await openApp(page);
    await openTest(page, "slow one");
    await page.click("#testRun");
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(1);
    await page.click("#openSettings");
    await page.keyboard.press("Escape");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 6000 });
    // Esc outside a dialog still stops a run
    await page.click("#testRun");
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(1);
    await page.locator("#thread").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Escape");
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(0);
  });

  test("a step of another test in the timeline (a suite's run, in a test's view) opens that test, at its turn", async ({ app: { page } }) => {
    await openApp(page);
    const row = suiteRow(page, SUITE);
    await row.hover();
    await row.locator(".list-add[id$='-add']").click();
    await expect(page.locator("#evalTitle")).toHaveText("New test");
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    await page.click("#suiteRun");
    await expect(page.locator("#status")).toContainText(/failed|passed/);
    await openTest(page, "refund for a broken item");
    // The New test's turn's bar, in this test's view of the suite's run (open here: a test's view folds
    // nothing of itself, and the suite's view only folds what it shows, unless one's folded by hand)
    const toggle = page.locator(".timeline-label", { hasText: "New test" }).locator(".tree-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const index = await page.locator(".timeline-label").evaluateAll((els) => {
      const at = els.findIndex((el) => el.textContent.trim() === "New test");
      return at < 0 ? -1 : els.findIndex((el, i) => i > at && /^turn 1$/i.test(el.textContent.trim()));
    });
    expect(index).toBeGreaterThan(-1);
    await page.locator(".timeline-row").nth(index).locator(".timeline-bar").click();
    await expect(page.locator("#evalTitle")).toHaveText("New test");
    await expect(page.locator("#panel .panel-head")).toContainText("Step");
    await expect(page.locator("#turn-0")).toHaveClass(/selected/);
  });

  test("the timeline's now line starts each run at its start, not where the last run's ended", async ({ app: { page, servers } }) => {
    await slowProvider(page, 1500);
    await writeFile(page, "slow.hafen.yml", `version: 1\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns: [ { user: wait } ]\n`);
    await openApp(page);
    await openTest(page, "slow one");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1", { timeout: 6000 });
    await page.click("#testRun");
    const now = page.locator(".timeline-now");
    await expect(now).toBeVisible();
    // (shortly after it starts, the line is near the chart's start, the run hardly begun)
    const [line, chart] = [await now.boundingBox(), await page.locator(".timeline-chart").boundingBox()];
    expect(line.x - chart.x).toBeLessThan(chart.width * 0.5);
  });
});

// How a run's last try shows (contracts/ui.md, Top bar, Suites, Runs, Thread): a run that broke off
// before its test (a provider's fixture that couldn't reach its login) or was refused before sending
// anything (no scope for {{env.base_url}}) is what the top bar, the Suites tree, the test's thread and
// panel and Runs say, not the run before it; everywhere in the same words; a stopped test or message is
// grey, not red. In the browser build, and the errored run in the desktop app.
test.describe("a run's last try", () => {
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const AUTH = "auth.hafen.yml";

  // A login before the run (a provider's beforeAll fixture), at the scope's base_url: up, the mock's
  // /login; down, an address nothing answers at
  const LOGIN = `export default {
  kind: "fixture", name: "acme-login", version: "1.0.0", hosts: ["127.0.0.1"], provides: ["ACME_TOKEN"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa-bot" }, signal });
    if (res.status >= 400) throw new Error(\`the login answered \${res.status}\`);
    return { ACME_TOKEN: (await res.json()).access_token };
  },
};
`;
  const BEHIND_LOGIN = `kind: http
url: "{{env.base_url}}/json"
login_url: "{{env.base_url}}/login"
headers: { x-token: "{{secret.ACME_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
fixtures: { beforeAll: [acme-login] }
`;
  const AUTH_SUITE = `version: 1
name: Auth
provider: providers/behind-login.yml
tests:
  - name: login and chat
    id: t_auth0001
    turns:
      - user: I want a refund for order 4417
        expect: [{ type: status, equals: 200 }]
`;
  const DOWN = "http://127.0.0.1:9";

  const authFiles = async (page) => {
    await writeFile(page, "plugins/acme-login.js", LOGIN);
    await writeFile(page, "providers/behind-login.yml", BEHIND_LOGIN);
    await writeFile(page, AUTH, AUTH_SUITE);
  };
  const openApp = async (page, file = "smoke.hafen.yml") => {
    await reopen(page);
    await expect(page.locator(`#suiteList .list-row[data-file="${file}"]`)).toHaveCount(1);
  };
  const testRow = (page, name) => page.locator("#suiteList .list-row", { has: page.locator(".list-open", { hasText: name }) }).first();
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const runRows = (page) => page.locator("#runList .list-row:not([id^='run-live-'])");

  // No scope chosen: Settings → Environments, Globals, "choose no scope"
  async function chooseNoScope(page) {
    await page.click("#scopeButton");
    await page.locator("#envGlobals").waitFor();
    await showEntry(page, "");
    if (await page.locator("#envChoose").count()) await page.click("#envChoose");
    await page.locator("#envChosen").waitFor();
    await page.click("#settingsClose");
    await page.locator("#settingsModal[open]").waitFor({ state: "detached" }).catch(() => {});
    await page.locator("#scopeAlert").waitFor();
  }

  // What a test errored by its fixture shows: the top bar, its row and its suite's, the thread, the panel
  async function showsTheError(page) {
    const status = page.locator("#status");
    await expect(status).toHaveAttribute("data-status", "error");
    await expect(status).toHaveText(/^error · /);
    await expect(status).toHaveClass(/error/);
    await expect(status).toHaveAttribute("title", /^error: auth\.hafen\.yml: the fixture "acme-login" \(beforeAll\) failed/);
    await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("error");
    await expect(testRow(page, "login and chat")).toHaveAttribute("data-status", "error");
    await expect(testRow(page, "login and chat").locator(".list-open")).toHaveAttribute("title", /error: auth\.hafen\.yml: the fixture "acme-login"/);
    await expect(suiteRow(page, AUTH).locator(".list-size")).toHaveText("1 test · 1 error");
    // The thread: why, where the turns would be; the turn itself not run by it
    await expect(page.locator("#runError")).toBeVisible();
    await expect(page.locator("#runErrorStatus")).toHaveText(/^error · /);
    await expect(page.locator("#runError-0")).toContainText('the fixture "acme-login" (beforeAll) failed');
    await expect(page.locator("#turn-0 .turn-summary")).toHaveText("not run yet · 1 check");
    // The panel: its last run, and why
    await expect(page.locator("#testLastStatus")).toHaveText("error");
    await expect(page.locator("#testRunError")).toContainText('the fixture "acme-login" (beforeAll) failed');
  }

  test.describe("in the browser build", () => {
    test.afterEach(async ({ app: { errors } }) => {
      expect(errors).toEqual([]);
    });

    test("a run that errored, or couldn't run, is what the top bar, the Suites tree, the test and Runs show, not the run before it; opened from Runs, its error is in the middle under its test's name", async ({ app: { page, servers } }) => {
      await authFiles(page);
      await openApp(page, AUTH);
      await addScope(page, "up", { base_url: servers.mock.url });
      await openTest(page, "login and chat");
      await page.click("#testRun");
      await expect(page.locator("#status")).toContainText("passed 1/1");
      await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("passed 1/1");

      // Its login can't be reached: an error, everywhere, with why
      await addScope(page, "down", { base_url: DOWN });
      await page.click("#testRun");
      await expect(page.locator(".toast", { hasText: "Error: login and chat" })).toBeVisible();
      await showsTheError(page);
      await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
      await expect(runRows(page).first().locator(".list-label")).toHaveText("login and chat");

      // No scope: refused before anything's sent, and said so with its first problem (not a result)
      await chooseNoScope(page);
      await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
      await page.click("#testRun");
      await expect(page.locator(".toast", { hasText: "Couldn't run: login and chat" })).toBeVisible();
      expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
      const status = page.locator("#status");
      await expect(status).toHaveText(/^couldn't run: \{\{env\.base_url\}\} isn't set/);
      await expect(status).toHaveAttribute("data-status", "error");
      await expect(status).toHaveClass(/error/);
      await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("couldn't run");
      await expect(testRow(page, "login and chat")).toHaveAttribute("data-status", "error");
      await expect(page.locator("#runErrorStatus")).toHaveText(/^couldn't run · nothing was sent/);
      await expect(page.locator("#runError-0")).toContainText("{{env.base_url}} isn't set");
      await expect(page.locator("#testLastStatus")).toHaveText("couldn't run");
      await expect(page.locator("#testRunError")).toContainText("{{env.base_url}} isn't set");
      await expect(runRows(page).first().locator(".list-size")).toHaveText("couldn't run");
      await expect(runRows(page).locator(".list-size")).toHaveText(["couldn't run", "error", "passed"]);

      // The errored run, opened from Runs: its test's name, and its error where the conversation would be
      await runRows(page).nth(1).locator(".list-open").click();
      await expect(page.locator("#evalTitle")).toHaveText("login and chat · run");
      await expect(page.locator("#status")).toHaveText(/^error · /);
      await expect(page.locator("#runError-0")).toContainText('the fixture "acme-login" (beforeAll) failed');
      await expect(page.locator("#thread")).not.toContainText("isn't in the open folder");
      await expect(page.locator("#runTestsNone")).toHaveText("None ran: it broke off before its tests.");
      // The one that couldn't run, the same way
      await runRows(page).first().locator(".list-open").click();
      await expect(page.locator("#evalTitle")).toHaveText("login and chat · run");
      await expect(page.locator("#runErrorStatus")).toHaveText(/^couldn't run · nothing was sent/);
      await expect(page.locator("#runTestsNone")).toHaveText("None ran: it was refused before anything was sent.");

      // Up again, it passes, and that's what shows (in the panel too); reloaded, each run still says so
      await chooseScope(page, "up");
      await openTest(page, "login and chat");
      await page.click("#testRun");
      await expect(page.locator("#status")).toHaveText(/^passed 1\/1/);
      await expect(page.locator("#runError")).toHaveCount(0);
      await expect(page.locator("#testRunError")).toHaveCount(0);
      await openApp(page, AUTH);
      await expect(runRows(page).locator(".list-size")).toHaveText(["passed", "couldn't run", "error", "passed"]);
      await expect(runRows(page).locator(".list-label")).toHaveText(Array(4).fill("login and chat"));
      await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("passed 1/1");
    });

    test("a whole suite's run that broke off shows on each of its tests, and in its view", async ({ app: { page, servers } }) => {
      await authFiles(page);
      await openApp(page, AUTH);
      await addScope(page, "up", { base_url: servers.mock.url });
      await openTest(page, "login and chat");
      await page.click("#testRun");
      await expect(page.locator("#status")).toContainText("passed 1/1");
      await addScope(page, "down", { base_url: DOWN });
      await suiteRow(page, AUTH).locator(".list-open").click();
      await page.click("#suiteRun");
      await expect(page.locator("#status")).toHaveText(/^error · /);
      await expect(page.locator("#status")).toHaveAttribute("title", /the fixture "acme-login" \(beforeAll\) failed/);
      await expect(page.locator("#runError-0")).toContainText('the fixture "acme-login" (beforeAll) failed');
      await expect(page.locator("#suiteTest-0 .turn-summary").first()).toHaveText(/^error · /);
      await expect(suiteRow(page, AUTH).locator(".list-size")).toHaveText("1 test · 1 error");
      await expect(runRows(page).first().locator(".list-label")).toHaveText("Auth");
      await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
      await openTest(page, "login and chat");
      await showsTheError(page);
    });

    test("one set of words: an errored test is `error` in Runs, its row, its suite's row and the top bar (not `failed`); a failed one `failed`", async ({ app: { page, servers } }) => {
      await writeFile(page, "providers/mock-err.yml", 'kind: http\nurl: "{{base_url}}/error/500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\nretries: 0\n');
      await writeFile(page, "broken.hafen.yml", `version: 1\nname: Broken\nprovider: providers/mock-err.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: errs\n    id: t_errs0001\n    turns:\n      - user: hi\n        expect: [{ contains: hello }]\n`);
      await openApp(page, "broken.hafen.yml");
      await openTest(page, "errs");
      await page.click("#testRun");
      await expect(page.locator("#status")).toHaveText(/^error · /);
      await expect(page.locator("#status")).toHaveAttribute("data-status", "error");
      await expect(testRow(page, "errs").locator(".list-size")).toHaveText("error");
      await expect(suiteRow(page, "broken.hafen.yml").locator(".list-size")).toHaveText("1 test · 1 error");
      await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
      await expect(runRows(page).first()).toHaveAttribute("data-status", "error");
      // (a test that errs on its own has its turns: no run error above them)
      await expect(page.locator("#runError")).toHaveCount(0);
      // A failure is a failure, in each place
      await openTest(page, "refund for a broken item");
      await page.click("#testRun");
      await expect(page.locator("#status")).toHaveText(/^failed 0\/1/);
      await expect(testRow(page, "refund for a broken item").locator(".list-size")).toHaveText("failed 0/1");
      await expect(suiteRow(page, "smoke.hafen.yml").locator(".list-size")).toHaveText("1 test · 1 failed");
      await expect(runRows(page).first().locator(".list-size")).toHaveText("failed");
      // Both, in the same colour
      const danger = await token(page, "--danger");
      expect(await colour(runRows(page).first().locator(".list-size"))).toBe(danger);
      expect(await colour(runRows(page).nth(1).locator(".list-size"))).toBe(danger);
    });

    test("a stopped test and a stopped message are grey (stopped), not red: its turn's head, its tree row and the top bar", async ({ app: { page, servers } }) => {
      await writeFile(page, "providers/mock-slow.yml", 'kind: http\nurl: "{{base_url}}/slow?ms=4000"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n');
      await writeFile(page, "slow.hafen.yml", `version: 1\nname: Slow\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: takes its time\n    id: t_slow0001\n    turns:\n      - user: hi\n        expect: [{ type: status, equals: 200 }, { contains: hi }]\n`);
      await openApp(page, "slow.hafen.yml");
      const muted = await token(page, "--muted");
      const danger = await token(page, "--danger");
      // A test stopped while its turn waits for its reply
      await openTest(page, "takes its time");
      await page.click("#testRun");
      await expect(page.locator("#status")).toHaveText("running…");
      await page.click("#testHeaderRun");
      await expect(page.locator("#status")).toHaveText(/^stopped · /);
      await expect(page.locator("#status")).toHaveAttribute("data-status", "stopped");
      await expect(page.locator("#status")).not.toHaveClass(/error/);
      expect(await colour(page.locator("#status"))).toBe(muted);
      const head = page.locator("#turn-0 .turn-summary");
      await expect(head).toHaveText(/^stopped/);
      await expect(head).toHaveAttribute("data-status", "stopped");
      expect(await colour(head)).toBe(muted);
      await expect(page.locator("#turn-0-cut")).toHaveText("Stopped before any reply came.");
      expect(await colour(page.locator("#turn-0-cut"))).toBe(muted);
      // (its turn's row in the tree: turn-<test id>-<i>)
      const turnItem = page.locator("#turn-t_slow0001-0");
      await expect(turnItem.locator(".list-size")).toHaveText("stopped");
      await expect(turnItem).toHaveAttribute("data-status", "stopped");
      expect(await colour(turnItem.locator(".list-size"))).toBe(muted);
      expect(await colour(turnItem.locator(".turn-icon"))).toBe(muted);
      await expect(testRow(page, "takes its time").locator(".list-size")).toHaveText("stopped");
      expect(await colour(testRow(page, "takes its time").locator(".list-size"))).toBe(muted);
      await expect(suiteRow(page, "slow.hafen.yml").locator(".list-size")).toHaveText("1 test");
      await expect(runRows(page).first().locator(".list-size")).toHaveText("stopped");
      expect(await colour(runRows(page).first().locator(".list-size"))).toBe(muted);
      // Beside a failed one, red
      await openTest(page, "refund for a broken item");
      await page.click("#testRun");
      await expect(page.locator("#status")).toHaveText(/^failed 0\/1/);
      const failed = page.locator("#turn-1 .turn-summary");
      await expect(failed).toHaveAttribute("data-status", "failed");
      expect(await colour(failed)).toBe(danger);
      // A message stopped while it waits
      await page.click("#newConversation");
      await page.selectOption("#convProvider", "providers/mock-slow.yml");
      await page.fill("#input", "hello?");
      await page.click("#send");
      await expect(page.locator("#status")).toHaveText("sending…");
      await page.click("#send");
      const message = page.locator("#turn-0 .turn-summary");
      await expect(message).toHaveText(/^stopped/);
      await expect(message).toHaveAttribute("data-status", "stopped");
      expect(await colour(message)).toBe(muted);
      await expect(page.locator("#turn-0-reply .msg-body.error")).toHaveCount(0);
      await expect(page.locator("#turn-0-cut")).toHaveText("Stopped before any reply came.");
    });
  });

  test("in the desktop app, a run whose fixture can't reach its login is what the top bar, the Suites tree and the test show, not the pass before it", async () => {
    test.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");
    const mock = await startMock({ chunkMs: 10 });
    const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
    // (the app's workspace, in its data folder: filled before it starts)
    const folder = join(data, "workspace");
    await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
    const smoke = join(folder, "smoke.hafen.yml");
    await writeDisk(smoke, (await readFile(smoke, "utf8")).replace("http://127.0.0.1:8791", mock.url));
    await mkdir(join(folder, "plugins"));
    await writeDisk(join(folder, "plugins", "acme-login.js"), LOGIN);
    await writeDisk(join(folder, "providers", "behind-login.yml"), BEHIND_LOGIN);
    await writeDisk(join(folder, AUTH), AUTH_SUITE);
    const env = { ...process.env, HAFEN_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
    try {
      const page = await app.firstWindow();
      await expect(suiteRow(page, AUTH)).toHaveCount(1);
      await addScope(page, "up", { base_url: mock.url });
      await openTest(page, "login and chat");
      await page.click("#testRun");
      await expect(page.locator("#status")).toContainText("passed 1/1");
      await addScope(page, "down", { base_url: DOWN });
      await page.click("#testRun");
      await showsTheError(page);
      await expect(page.locator("#status")).toHaveAttribute("title", /Couldn't reach http:\/\/127\.0\.0\.1:9\/login/);
      await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
      await runRows(page).first().locator(".list-open").click();
      await expect(page.locator("#evalTitle")).toHaveText("login and chat · run");
      await expect(page.locator("#runError-0")).toContainText("Couldn't reach http://127.0.0.1:9/login");
    } finally {
      await app.close();
      await mock.close();
      await rm(data, { recursive: true, force: true });
    }
  });
});

test.describe("Follow, while a run goes on", () => {
  // A test of ten turns, each answered after a moment: taller than the window, and its timeline far
  // taller than the dock; opened
  async function tenTurns(page, servers) {
    await writeFile(page, "providers/slow.yml", `kind: http\nurl: "${servers.mock.url}/slow?ms=400"\nbody: { message: "{{user}}" }\nresponse:\n  text: $.data.reply\n`);
    const turns = Array.from({ length: 10 }, (_, i) => `      - user: message ${i + 1}\n`).join("");
    await writeFile(page, "follow.hafen.yml", `version: 1\nname: follow\nprovider: providers/slow.yml\ntests:\n  - name: ten turns\n    turns:\n${turns}`);
    await reopen(page);
    await page.locator("#suiteList .list-open", { hasText: "ten turns" }).click();
  }

  test("the top bar's Follow, shown while a test runs, keeps the running turn in view; off, the thread stays put, and that's remembered", async ({ app: { page, servers } }) => {
    await tenTurns(page, servers);
    const top = () => page.locator("#scroller").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await expect(page.locator("#followRun")).toHaveCount(0);

    // On (the default): the last turn, as it runs, is scrolled into view
    await top();
    await page.click("#testHeaderRun");
    await expect(page.locator("#followRun")).toBeChecked();
    await expect(page.locator("#turn-9")).toBeInViewport({ timeout: 15000 });
    await expect(page.locator("#status")).toContainText("passed");
    await expect(page.locator("#followRun")).toHaveCount(0);

    // Off: the thread stays where it was, and the choice is kept
    await top();
    await page.click("#testHeaderRun");
    await page.locator("#followRun").uncheck();
    await top();
    await expect(page.locator("#status")).toContainText("passed", { timeout: 15000 });
    await expect(page.locator("#turn-9")).not.toBeInViewport();
    expect(await page.evaluate(() => localStorage.getItem("eval.follow"))).toBe("off");
  });

  test("the timeline's Follow, shown while a run goes on, keeps the step running now in view; off, the chart stays put, and that's remembered", async ({ app: { page, servers } }) => {
    await tenTurns(page, servers);
    const chartTop = () => page.locator(".timeline-chart").evaluate((el) => { el.scrollTop = 0; });
    const lastTurn = page.locator('.timeline-bar[data-kind="turn"]').last();
    await expect(page.locator("#timelineFollow")).toHaveCount(0);

    // On (the default): the last turn's bar, as it runs, is scrolled into the chart's view
    await page.click("#testHeaderRun");
    await expect(page.locator("#timelineFollow")).toBeChecked();
    await expect(page.locator('.timeline-bar[data-kind="turn"]')).toHaveCount(10, { timeout: 15000 });
    await expect(lastTurn).toBeInViewport();
    await expect(page.locator("#status")).toContainText("passed");
    await expect(page.locator("#timelineFollow")).toHaveCount(0);

    // Off: the chart stays where it was left, and the choice is kept
    await page.click("#testHeaderRun");
    await page.locator("#timelineFollow").uncheck();
    await chartTop();
    await expect(page.locator("#status")).toContainText("passed", { timeout: 15000 });
    await expect(lastTurn).not.toBeInViewport();
    expect(await page.evaluate(() => localStorage.getItem("eval.timelineFollow"))).toBe("off");
  });
});
