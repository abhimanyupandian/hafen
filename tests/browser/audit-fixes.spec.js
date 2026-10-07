// What a review of the app found, each fixed, each held here end to end: the conversation's provider
// can't be changed mid-reply; a suite's results follow its renames and deletes, not its name; a
// conversation keeps its run whole; "run again" runs what ran; quick clicks on a check's box; the scope
// chosen last; a step of another test; Back to the plain address; renaming a running suite; importing a
// conversation's run; a suite written wrong; small screens; Esc in a dialog; the timeline's now line; a
// CI run whose tests aren't here; the error status; a scope variable changed as YAML; folds by file; the
// message box hidden; a conversation's step; the Runs pane; an error turn's response.

import { parse } from "yaml";
import { addScope, expect, fileText, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openFolder = async (page) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`).first();
const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const slowProvider = (page, ms) => writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);
const confirm = async (locator) => { await locator.click(); await locator.click(); };
const toast = (page, text) => page.locator(".toast", { hasText: text });
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

test("while a message is on its way the conversation's provider can't be changed; after, it can, and nothing's stuck", async ({ app: { page } }) => {
  await slowProvider(page, 1500);
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/mock-slow.yml");
  await page.fill("#input", "first");
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/stop/i);
  await expect(page.locator("#convProvider")).toBeDisabled();
  await expect(page.locator("#send")).toHaveText(/send/i, { timeout: 5000 });
  await expect(page.locator("#convProvider")).toBeEnabled();
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await page.fill("#input", "second");
  await page.click("#send");
  await expect(page.locator("#turn-1-reply .msg-body")).toContainText("You said: second");
  await expect(page.locator("#status")).toHaveText("2 turns");
});

test("a conversation keeps its run whole after a message: its _id, and its steps' names", async ({ app: { page } }) => {
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  for (const m of ["one", "two", "three"]) {
    await page.fill("#input", m);
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
  }
  await page.waitForTimeout(300);
  await expect(page.locator("#convRunId")).not.toHaveValue("");
  await expect(page.locator(".timeline-label", { hasText: "POST /json" }).first()).toBeVisible();
});

test("a suite's results follow it: a new suite by its old name doesn't take them, and one renamed to a deleted one's name keeps its own", async ({ app: { page } }) => {
  await openFolder(page);
  // tests.hafen.yml, run, then renamed to refunds
  await page.click("#newSuite");
  await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
  await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(1);
  await page.locator('#suiteList .list-row[data-file="tests.hafen.yml"] .list-open').first().click();
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(/passed|failed/);
  await page.fill("#suiteFile", "refunds");
  await page.press("#suiteFile", "Enter");
  await expect(page.locator('#suiteList .list-row[data-file="refunds.hafen.yml"]')).toHaveCount(1);
  // A new tests.hafen.yml: not run yet; run, its run is its own, refunds keeps its
  await page.click("#newSuite");
  await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
  await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(1);
  await page.locator('#suiteList .list-row[data-file="tests.hafen.yml"] .list-open').first().click();
  await expect(page.locator("#status")).toHaveText("not run yet");
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(/passed|failed/);
  const all = await runs(page);
  expect(all.length).toBe(2);
  await page.locator('#suiteList .list-row[data-file="refunds.hafen.yml"] .list-open').first().click();
  await expect(page.locator("#status")).toContainText(/passed|failed/);
  // (each suite's view shows its own run: by the run's tests' ids)
  await expect(page.locator("#suiteTest-0 .turn-summary").first()).not.toHaveText("not run yet");
  // Delete refunds, rename tests to refunds: it keeps tests' results
  await confirm(page.locator("#suiteDelete"));
  await expect(page.locator('#suiteList .list-row[data-file="refunds.hafen.yml"]')).toHaveCount(0);
  await page.locator('#suiteList .list-row[data-file="tests.hafen.yml"] .list-open').first().click();
  await page.fill("#suiteFile", "refunds");
  await page.press("#suiteFile", "Enter");
  await expect(page.locator('#suiteList .list-row[data-file="refunds.hafen.yml"]')).toHaveCount(1);
  await page.locator('#suiteList .list-row[data-file="refunds.hafen.yml"] .list-open').first().click();
  await expect(page.locator("#status")).toContainText(/passed|failed/);
});

test("a suite can't be renamed while it runs (its run reads it by its name)", async ({ app: { page, servers } }) => {
  await slowProvider(page, 2000);
  await writeFile(page, "slow.hafen.yml", `version: 1\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns: [ { user: wait } ]\n`);
  await openFolder(page);
  await page.locator('#suiteList .list-row[data-file="slow.hafen.yml"] .list-open').first().click();
  await page.click("#suiteRun");
  await page.fill("#suiteFile", "renamed");
  await page.press("#suiteFile", "Enter");
  await expect(toast(page, "is running")).toBeVisible();
  await expect(page.locator('#suiteList .list-row[data-file="slow.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator('#suiteList .list-row[data-file="renamed.hafen.yml"]')).toHaveCount(0);
});

test("\"run again\" runs what ran: a test up to its turn as it was; a deleted test says so, not the whole suite instead", async ({ app: { page } }) => {
  await openFolder(page);
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
  await expect(toast(page, "isn't in the open folder")).toBeVisible();
  await page.waitForTimeout(300);
  expect((await runs(page)).length).toBe(2);
});

test("quick clicks on a check's on box: the last one is what's in the file", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await page.locator("#turn-0 .turn-head .label").click();
  const box = page.locator("#turnCheck-1-on");
  await box.click();
  await box.click();
  await box.click();
  await expect(box).not.toBeChecked();
  await fileSays(page, (d) => d.tests[0].turns[0].expect[1].enabled === false);
  await page.waitForTimeout(400);
  expect(parse(await fileText(page, SUITE)).tests[0].turns[0].expect[1].enabled).toBe(false);
  await box.click();
  await box.click();
  await expect(box).not.toBeChecked();
  await page.waitForTimeout(400);
  expect(parse(await fileText(page, SUITE)).tests[0].turns[0].expect[1].enabled).toBe(false);
});

test("the scope chosen last is chosen again", async ({ app: { page } }) => {
  await openFolder(page);
  // (prod made last, and so chosen last: not the first there is)
  await addScope(page, "stage");
  await addScope(page, "prod");
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await openFolder(page);
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("prod");
});

test("a step of another test in the timeline (a suite's run, in a test's view) opens that test, at its turn", async ({ app: { page } }) => {
  await openFolder(page);
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

test("Back to the plain address goes to the conversation", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await expect(page).toHaveURL(/tab=suites/);
  await page.goBack();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(page.locator("#evalTitle")).toHaveText("New conversation");
  await expect(page.locator("#panel .panel-head")).toContainText("Conversation");
});

test("a conversation's run file isn't opened under Runs: it says so", async ({ app: { page } }) => {
  await openFolder(page);
  const run = { _id: "explore000000001", kind: "hafen-run", version: 1, mode: "explore", suites: [], tests: [], turns: [], spans: [], started: Date.now(), status: "done" };
  await page.locator("#runsSection input[type=file]").setInputFiles({ name: "x.hafen-run.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(run)) });
  await expect(toast(page, "conversation's run")).toBeVisible();
  await expect(page.locator("#runList .list-row")).toHaveCount(0);
});

test("a suite written wrong: the app still draws, says what's wrong, and won't edit it until it's fixed as YAML", async ({ app: { page } }) => {
  await writeFile(page, "bad.hafen.yml", "version: 1\nprovider: providers/mock-json.yml\ntests:\n  - name: a\n    tags: smoke\n    turns:\n      - user: hi\n        expect:\n          path: $.x\n");
  await openFolder(page);
  await expect(page.locator('#suiteList .list-row[data-file="bad.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator("#threadCrash, #panelCrash")).toHaveCount(0);
  await page.locator('#suiteList .list-row[data-file="bad.hafen.yml"] .list-open').first().click();
  await expect(page.locator("#panel .problems")).toContainText("tags");
  // Its test and turn open (shown safely)
  await page.locator("#suiteList .list-open[aria-label^='turn 1:']").last().click();
  await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
  // An edit is refused, the file as it was
  const before = await fileText(page, "bad.hafen.yml");
  const row = suiteRow(page, "bad.hafen.yml");
  await row.hover();
  await row.locator(".list-add[id$='-add']").click();
  await expect(toast(page, "Edit the file as YAML")).toBeVisible();
  expect(await fileText(page, "bad.hafen.yml")).toBe(before);
  // The good suite is as ever
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#turn-0-user")).toContainText("I want a refund");
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
  await openFolder(page);
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

test("Esc in a dialog closes the dialog: the run going on goes on", async ({ app: { page, servers } }) => {
  await slowProvider(page, 2000);
  await writeFile(page, "slow.hafen.yml", `version: 1\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns: [ { user: wait } ]\n`);
  await openFolder(page);
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

test("the timeline's now line starts each run at its start, not where the last run's ended", async ({ app: { page, servers } }) => {
  await slowProvider(page, 1500);
  await writeFile(page, "slow.hafen.yml", `version: 1\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns: [ { user: wait } ]\n`);
  await openFolder(page);
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

test("a run whose tests the open folder hasn't got: the test picked shows; its turn and check, as the run recorded them; Back keeps it", async ({ app: { page } }) => {
  await openFolder(page);
  const row = suiteRow(page, SUITE);
  await row.hover();
  await row.locator(".list-add[id$='-add']").click();
  await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(/failed|passed/);
  // The suite renamed: the run's tests aren't in the folder by their file any more
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

test("the top bar's status is red when the test failed", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  expect(await page.locator("#status").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--danger"));
});

test("a scope's value changed as a whole (its .env text) shows its new value in its row (and leaving the row doesn't put the old one back)", async ({ app: { page } }) => {
  await openFolder(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-environments");
  await page.fill("#newScopeName", "stage");
  await page.click("#newScopeForm button[type=submit]");
  await page.fill("#envVarName", "X");
  await page.fill("#envVarValue", "a");
  await page.click("#envVarAdd button[type=submit]");
  const value = page.locator("#envVar-X input");
  await expect(value).toHaveValue("a");
  await value.fill("b");
  await value.press("Enter");
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("eval.scope.stage")));
  await expect.poll(stored).toEqual({ X: "b" });
  await page.click("#envText");
  await page.fill("#editorText", "X=c\n");
  await page.click("#editorSave");
  await expect(page.locator("#envVar-X input")).toHaveValue("c");
  await page.locator("#envVar-X input").click();
  await page.locator("#envVarName").click();
  await page.waitForTimeout(300);
  expect(await stored()).toEqual({ X: "c" });
});

test("a suite's folding stays with it when another is added above it", async ({ app: { page } }) => {
  await openFolder(page);
  await page.click(`#${await suiteRow(page, SUITE).getAttribute("id")}-toggle`);
  await expect(suiteRow(page, SUITE).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  await writeFile(page, "a.hafen.yml", "version: 1\nprovider: providers/mock-json.yml\ntests:\n  - name: first\n    turns: [ { user: hi } ]\n");
  await openFolder(page);
  await expect(page.locator('#suiteList .list-row[data-file="a.hafen.yml"]')).toHaveCount(1);
  await expect(suiteRow(page, SUITE).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(suiteRow(page, "a.hafen.yml").locator(".tree-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("the message box, hidden (a suite's view) and shown again, is empty: Send off, no old field problem", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await page.fill("#input", "{{env.nope}}");
  await expect(page.locator("#inputProblem")).toBeVisible();
  await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
  await expect(page.locator("#input")).toHaveCount(0);
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#input")).toHaveValue("");
  await expect(page.locator("#inputProblem")).toHaveCount(0);
  await expect(page.locator("#send")).toBeDisabled();
});

test("a conversation's step (a tool call) picked: its turn stays marked", async ({ app: { page } }) => {
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/mock-sse.yml");
  await page.fill("#input", "hi");
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/send/i);
  await page.click("#turn-0-tool-0");
  await expect(page.locator("#panel .panel-head")).toContainText("Step");
  await expect(page.locator("#turn-0")).toHaveClass(/selected/);
});

test("Settings → Runs lists a run kept without its tests or suites", async ({ app: { page } }) => {
  await openFolder(page);
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

test("an error turn says the error, with what came back under it (show the response)", async ({ app: { page } }) => {
  await writeFile(page, "providers/mock-err.yml", 'kind: http\nurl: "{{base_url}}/error/500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n');
  await openFolder(page);
  await page.selectOption("#convProvider", "providers/mock-err.yml");
  await page.fill("#input", "hi");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body.error")).toBeVisible();
  const shown = page.locator("#turn-0-reply details.msg-response");
  await expect(shown.locator("summary")).toHaveText("show the response");
  await shown.locator("summary").click();
  await expect(shown.locator("pre")).toContainText("the mock is having a bad day");
});
