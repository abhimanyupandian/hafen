// The chat's look and clicks (user messages at the right, "user", a generic message box, a click
// anywhere in a turn selecting it, hover), the sidebar's order, "Edit … as YAML" buttons, the console
// as an audit log, a turn's right-click menu (run only it, run up to it, run the test, delete), and
// runs at once (tests at once in a run; several runs going on).

import { parse } from "yaml";
import { chooseScope, expect, fileText, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
// (a suite by its file, data-file; a test by its name)
const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const w = await (await dir.getFileHandle(parts.at(-1))).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const consoleText = (page) => page.locator("#log, .console-body").first().textContent();
const mockLog = async (servers) => (await fetch(`${servers.mock.url}/_log`)).json();
const clearMockLog = (servers) => fetch(`${servers.mock.url}/_log`, { method: "DELETE" });

test.beforeEach(async ({ app: { page } }) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("the sidebar's order, the panels' YAML buttons, the chat's labels and the message box", async ({ app: { page } }) => {
  const order = await page.locator("#navBody > section").evaluateAll((els) => els.map((e) => e.id));
  expect(order).toEqual(["conversationsSection", "suitesSection", "checksSection", "runsSection"]);
  await page.click("#collapseNav");
  expect(await page.locator("#navRail button").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label")))).toEqual(["Conversations", "Suites", "Checks", "Runs"]);
  await expect(page.locator("#rail-runs svg path").first()).toHaveAttribute("d", /^M3\.6 10\.5/);
  await page.click("#rail-suites");
  // Explore: a generic message box
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await expect(page.locator("#input")).toHaveAttribute("placeholder", "Type a message");
  // A test: "user", at the right
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#turn-0-user > .label")).toHaveCount(0);  // (no "user" label: the message speaks for itself)
  const box = await page.locator("#turn-1-user .msg-body").boundingBox();
  const article = await page.locator("#turn-1-user").boundingBox();
  expect(Math.abs(box.x + box.width - (article.x + article.width))).toBeLessThan(2);
  expect(box.x).toBeGreaterThan(article.x + 20);
  // The YAML buttons
  await expect(page.locator("#testYamlEdit")).toHaveText("Edit the suite as YAML");
  await row(page, SUITE).locator(".list-open").click();
  await expect(page.locator("#suiteYamlEdit")).toHaveText("Edit the file as YAML");
  await page.click("#suiteYamlEdit");
  await expect(page.locator("#editorText")).toHaveValue(await fileText(page, SUITE));
  await page.click("#editorCancel");
});

test("a click anywhere in a turn selects it (not on its own controls); hover and selection show like a list's", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  // The reply's stats line, its text, the turn's head, the blank space below a short message
  for (const target of ["#turn-1-reply .msg-stats", "#turn-1-reply .msg-body", "#turn-1 .turn-head .label", "#turn-1-user .msg-body"]) {
    await page.locator("#turn-0 .turn-head .label").click();
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
    await page.locator(target).click();
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 2");
    await expect(page.locator("#turn-1")).toHaveClass(/selected/);
  }
  // A check's badge selects the check, not the turn
  await page.locator("#turn-1-reply .check-badge").first().click();
  await expect(page.locator("#panel .panel-head")).toContainText("Check");
  // Hover: a faint background; selected: the list's selected one
  const bg = (sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.locator("#turn-1-reply .msg-stats").click();
  await page.mouse.move(2, 2);
  const plain = await bg("#turn-0");
  await page.locator("#turn-0 .turn-head").hover();
  const hovered = await bg("#turn-0");
  expect(hovered).not.toBe(plain);
  const selected = await bg("#turn-1");
  const listActive = await bg("#suiteList .list-row.active");
  expect(selected).toBe(listActive);
  // A list row's hover too
  await page.mouse.move(2, 2);
  const rowPlain = await bg("#suiteList .list-row:not(.active) >> nth=0");
  await page.locator("#suiteList .list-row:not(.active)").first().hover();
  expect(await bg("#suiteList .list-row:not(.active) >> nth=0")).not.toBe(rowPlain);
});

test("the console is an audit log: engine calls, HTTP calls, settings and events — never a secret's value", async ({ app: { page } }) => {
  // An HTTP call with a key in its address
  const provider = `kind: http\nurl: "{{base_url}}/json?api_key=SECRET123&lang=en"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`;
  await writeFile(page, "providers/mock-json.yml", provider);
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await page.fill("#input", "hello");
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/send/i);
  // An edit, a run, a setting, a secret
  await openTest(page, "refund for a broken item");
  await page.fill("#testName", "renamed for the log");
  await page.press("#testName", "Enter");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText(/failed|passed/);
  await chooseScope(page, "local");
  await page.click("#openSettings");
  await page.click("#settings-tab-secrets");
  await page.fill("#secretName", "SHOP_TOKEN");
  await page.fill("#secretValue", "VALUE-NOT-LOGGED");
  await page.click("#secretAdd button[type=submit]");
  await expect(page.locator("#secret-SHOP_TOKEN")).toBeVisible();
  await page.click("#settingsClose");
  const text = await consoleText(page);
  for (const line of [
    /engine\.open .*found="1 suites, 2 providers".* ok/,
    /config\.provider .*provider=providers\/mock-json\.yml/,
    /engine\.send .*provider=providers\/mock-json\.yml.* ok/,
    /http\.request .*method=POST url=http:\/\/127\.0\.0\.1:\d+\/json\?api_key=\*\*\*&lang=en .*200/,
    /conversation\.turn .*turn=1/,
    /engine\.edit .*file=smoke\.hafen\.yml op=set:tests\.0\.name.* ok/,
    /run\.start .*file=smoke\.hafen\.yml/,
    /run\.turn .*turn=2/,
    /run\.test .*test="renamed for the log"/,
    /engine\.run .*result="failed 0\/1"/,
    /config\.secret .*name=SHOP_TOKEN env=every action=set/,
  ]) expect(text).toMatch(line);
  expect(text).not.toContain("SECRET123");
  expect(text).not.toContain("VALUE-NOT-LOGGED");
});

test("a turn's right-click menu: run only it (the turns before it from the last run), up to it, the test; delete it", async ({ app: { page, servers } }) => {
  await openTest(page, "refund for a broken item");
  // Nothing run yet: "only turn 2" sends turn 1 too (there's no reply to carry)
  await clearMockLog(servers);
  await page.locator("#turn-1").click({ button: "right" });
  await expect(page.locator("#contextMenu")).toBeVisible();
  expect(await page.locator("#contextMenu [role=menuitem]").evaluateAll((els) => els.map((e) => e.id))).toEqual(["menu-turn-only", "menu-turn-upto", "menu-turn-test", "menu-turn-delete"]);
  await expect(page.locator("#menu-turn-only")).toContainText("Run this turn only");
  await expect(page.locator("#menu-turn-upto")).toContainText("Run up to this turn");
  await page.click("#menu-turn-only");
  await expect(page.locator("#contextMenu")).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("turn 2 only");
  expect((await mockLog(servers)).length).toBe(2);
  // Now turn 1 has a reply: only turn 2 is sent, turn 1 carried
  await clearMockLog(servers);
  await page.locator("#turn-1").click({ button: "right" });
  await page.click("#menu-turn-only");
  await expect(page.locator("#status")).toContainText("turn 2 only");
  await expect.poll(async () => (await mockLog(servers)).length).toBe(1);
  expect((await mockLog(servers))[0].body.message).toBe("It arrived broken");
  await expect(page.locator("#turn-0 .turn-summary")).toHaveText("carried · from the last run");
  await expect(page.locator("#turn-1 .turn-summary")).toContainText("0/1 checks");
  // Up to turn 1, by keyboard: Shift+F10 on its ▷, then ↓ and Enter
  await page.locator("#turn-0-run").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#contextMenu")).toBeVisible();
  await expect(page.locator("#menu-turn-only")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#menu-turn-upto")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toContainText("passed 1/1 · to turn 1");
  // Esc closes it, and nothing runs
  const runs = await page.locator("#runList .list-row").count();
  await page.locator("#turn-1").click({ button: "right" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#contextMenu")).toHaveCount(0);
  expect(await page.locator("#runList .list-row").count()).toBe(runs);
  // Delete asks first
  await page.locator("#turn-1").click({ button: "right" });
  await page.click("#menu-turn-delete");
  await expect(page.locator("#menu-turn-delete")).toHaveText(/Click again to delete it/);
  await page.click("#menu-turn-delete");
  await expect.poll(async () => parse(await fileText(page, SUITE)).tests[0].turns.length).toBe(1);
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
