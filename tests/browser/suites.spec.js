// Suites: added (Suites' + and its form), named, renamed, pointed at a provider, grouped and deleted,
// from the sidebar and their panel; their view and ▷; their YAML, and the problems in it; their results
// following their file, and what happens to one while it runs or a check of it is open.

import { parse } from "yaml";
import { expect, fileText, openYaml, reopen, test, toast, writeFile } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
// Settings → Providers, where the providers are
async function openProviders(page) {
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await expect(page.locator("#settingsTitle")).toHaveText("Providers");
}

test("the Suites section shows no folder path", async ({ app: { page } }) => {
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator("#suitesFolder")).toHaveCount(0);
});

test("+ adds a new suite each time; a suite's own + adds a test to it", async ({ app: { page } }) => {
  await page.click("#newSuite");
  await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
  await expect(page.locator("#newSuiteForm")).toHaveCount(0);  // (closed once the suite's loaded: + again opens it)
  await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(1);
  await page.click("#newSuite");
  await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
  await expect(page.locator('#suiteList .list-row[data-file="tests-2.hafen.yml"]')).toHaveCount(1);
  expect(await fileText(page, "tests-2.hafen.yml")).toContain("name: New test");
  await expect(page.locator("#evalTitle")).toHaveText("New test");
  // The smoke suite's +, shown on hover
  const smoke = page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]');
  await smoke.hover();
  await smoke.locator(".list-add[id$='-add']").click();
  await expect(smoke.locator(".list-size")).toContainText("2 tests");
  expect((await fileText(page, "smoke.hafen.yml")).match(/- name: |name: New test/g).length).toBeGreaterThan(1);
  await expect(page.locator("#evalTitle")).toHaveText("New test");
  // And from the suite's panel
  await smoke.locator(".list-open").click();
  await page.click("#suiteAddTest");
  await expect(smoke.locator(".list-size")).toContainText("3 tests");
});

test("a suite's name (for reports) and its file are edited in its panel; its last results follow the file", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"] .list-open').click();
  await expect(page.locator("#suiteName")).toHaveValue("Smoke");
  await page.fill("#suiteName", "Checkout flows");
  await page.press("#suiteName", "Enter");
  await expect.poll(() => fileText(page, "smoke.hafen.yml")).toContain("name: Checkout flows\n");
  await expect(page.locator("#suiteFile")).toHaveValue("smoke");
  await page.fill("#suiteFile", "checkout");
  await page.press("#suiteFile", "Enter");
  await expect(page.locator('#suiteList .list-row[data-file="checkout.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(0);
  await expect(page.locator("#suiteFile")).toHaveValue("checkout");
  const text = await fileText(page, "checkout.hafen.yml");
  expect(text).toContain("name: Checkout flows\n");
  expect(text).toContain("# fails by design");
  await expect(page.locator("#suiteList .list-row", { hasText: "refund for a broken item" }).locator(".list-size")).toHaveText("failed 0/1");
});

test("a suite's provider, and a test's own, are chosen in their panels; a missing one shows as missing", async ({ app: { page } }) => {
  // The suite's provider file is deleted: the suite still names it
  await openProviders(page);
  await page.click("#provider-mock-json-delete");
  await page.click("#provider-mock-json-delete");
  await expect(page.locator("#provider-mock-json")).toHaveCount(0);
  await page.click("#settingsClose");
  await page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"] .list-open').click();
  await expect(page.locator("#suiteProvider option:checked")).toHaveText("mock-json (missing)");
  await expect(page.locator("#panel .problems")).toContainText("providers/mock-json.yml doesn't exist");
  // Choose one that is
  await page.selectOption("#suiteProvider", "providers/mock-sse.yml");
  await expect.poll(() => fileText(page, "smoke.hafen.yml")).toContain("provider: providers/mock-sse.yml");
  await expect(page.locator("#panel .problems")).toHaveCount(0);
  // A test runs on the suite's, unless it says
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await expect(page.locator("#testProvider option:checked")).toHaveText("the suite's (mock-sse)");
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText(/passed|failed/);
  // Its own: a new provider, from Settings, then chosen here
  await openProviders(page);
  await page.click("#newProvider");
  await page.selectOption("#newProviderKind", "http");
  await page.fill("#newProviderName", "shop");
  await page.click("#newProviderCreate");
  await page.click("#settingsClose");
  await page.selectOption("#testProvider", "providers/shop.yml");
  await expect.poll(() => fileText(page, "smoke.hafen.yml")).toMatch(/turns:[\s\S]*provider: providers\/shop\.yml/);
  await expect(page.locator("#testProvider option:checked")).toHaveText("shop");
  await page.selectOption("#testProvider", "");
  await expect.poll(() => fileText(page, "smoke.hafen.yml")).not.toContain("providers/shop.yml");
  await expect(page.locator("#testProvider option:checked")).toHaveText("the suite's (mock-sse)");
});

test.describe("added, changed and deleted, each change in the file", () => {
  // A panel's "Edit … as YAML" opens the large editor on the file as it is now (then it's closed again)
  async function yamlViewMatches(page, id, file = SUITE) {
    await expect(page.locator(`#${id}Edit`)).toBeEnabled();
    await page.click(`#${id}Edit`);
    const text = page.locator("#editorText");
    await expect(text).toBeVisible();
    expect(await text.inputValue()).toBe(await fileText(page, file));
    await page.click("#editorCancel");
    await expect(page.locator("#editorText")).toHaveCount(0);
  }
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  // (a suite by its file, data-file; a test by its name)
  const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();
  const confirmDelete = async (locator) => { await locator.click(); await locator.click(); };
  async function addTestToSmoke(page) {
    const r = row(page, SUITE);
    await r.hover();
    await r.locator(".list-add[id$='-add']").click();
    await expect(page.locator("#evalTitle")).toHaveText("New test");
  }

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("suites: new ones, named, renamed, pointed at a provider, and deleted", async ({ app: { page } }) => {
    await page.click("#newSuite");
    await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
    await expect(page.locator("#newSuiteForm")).toHaveCount(0);  // (closed once the suite's loaded: + again opens it)
    await fileSays(page, (d) => d.tests.length === 1 && d.name === "tests", "tests.hafen.yml");
    await page.click("#newSuite");
    await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
    await fileSays(page, (d) => d.tests.length === 1, "tests-2.hafen.yml");
    await row(page, "tests-2.hafen.yml").locator(".list-open").click();
    // Name (in reports)
    await page.fill("#suiteName", "Checkout flows");
    await page.press("#suiteName", "Enter");
    await fileSays(page, (d) => d.name === "Checkout flows", "tests-2.hafen.yml");
    await yamlViewMatches(page, "suiteYaml", "tests-2.hafen.yml");
    // Provider
    await page.selectOption("#suiteProvider", "providers/mock-sse.yml");
    await fileSays(page, (d) => d.provider === "providers/mock-sse.yml", "tests-2.hafen.yml");
    // Add test from the panel
    await page.click("#suiteAddTest");
    await fileSays(page, (d) => d.tests.length === 2, "tests-2.hafen.yml");
    // Rename the file
    await row(page, "tests-2.hafen.yml").locator(".list-open").click();
    await page.fill("#suiteFile", "checkout");
    await page.press("#suiteFile", "Enter");
    await expect(page.locator('#suiteList .list-row[data-file="checkout.hafen.yml"]')).toHaveCount(1);
    await fileSays(page, (d) => d.name === "Checkout flows" && d.tests.length === 2, "checkout.hafen.yml");
    await expect.poll(() => fileText(page, "tests-2.hafen.yml").then(() => "there", () => "gone")).toBe("gone");
    await yamlViewMatches(page, "suiteYaml", "checkout.hafen.yml");
    // A taken name is refused, and put back
    await page.fill("#suiteFile", "tests");
    await page.press("#suiteFile", "Enter");
    await expect(page.locator(".toast", { hasText: "already exists" })).toBeVisible();
    await expect(page.locator("#suiteFile")).toHaveValue("checkout");
    // Delete from the panel and from the sidebar
    await confirmDelete(page.locator("#suiteDelete"));
    await expect(page.locator('#suiteList .list-row[data-file="checkout.hafen.yml"]')).toHaveCount(0);
    await expect.poll(() => fileText(page, "checkout.hafen.yml").then(() => "there", () => "gone")).toBe("gone");
    const r = row(page, "tests.hafen.yml");
    await r.hover();
    await confirmDelete(r.locator(".list-del"));
    await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(0);
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });

  test("the suite's YAML in the large editor: it opens on the file as it is, and saving it changes the suite", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await page.fill("#testName", "edited first");
    await page.press("#testName", "Enter");
    await fileSays(page, (d) => d.tests[0].name === "edited first");
    await page.click("#testYamlEdit");
    const editor = page.locator("#editorModal textarea, dialog textarea").first();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(/name: edited first/);
    const text = await editor.inputValue();
    await editor.fill(text.replace("name: edited first", "name: edited in YAML"));
    await page.click("#editorSave");
    await fileSays(page, (d) => d.tests[0].name === "edited in YAML");
    await expect(page.locator("#testName")).toHaveValue("edited in YAML");
    await expect(row(page, "edited in YAML")).toBeVisible();
    expect(await fileText(page, SUITE)).toContain("# fails by design");
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

  test("a file changed underneath: an edit meant for one test isn't made to another, and the app shows the file as it is", async ({ app: { page } }) => {
    await addTestToSmoke(page);
    await page.fill("#testName", "second");
    await page.press("#testName", "Enter");
    await fileSays(page, (d) => d.tests[1].name === "second");
    // Another program swaps the tests round
    const text = await fileText(page, SUITE);
    const data = parse(text);
    await page.evaluate(async (next) => {
      const f = await (await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }))).getFileHandle("smoke.hafen.yml");
      const w = await f.createWritable(); await w.write(next); await w.close();
    }, text.replace(/\ntests:\n[\s\S]*$/, "\ntests: []\n"));
    // Deleting "second" (index 1, as the app still shows it) is refused: the file has no test 1
    const r = row(page, "second");
    await r.hover();
    await confirmDelete(r.locator(".list-del"));
    await expect(page.locator(".toast", { hasText: "Couldn't save" })).toBeVisible();
    // The app now shows the file as it is
    await expect(page.locator("#suiteList")).not.toContainText("second");
    await expect(page.locator("#suiteList")).not.toContainText("refund for a broken item");
    expect(parse(await fileText(page, SUITE)).tests).toEqual([]);
    expect(data.tests.length).toBe(2);
  });
});

test.describe("while one of its tests runs, or one of its checks is open", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  // A provider that takes `ms` to answer, and a suite of one test on it (read when the app's loaded again)
  async function slowSuite(page, servers, ms = 2500) {
    await writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
    await writeFile(page, "slow.hafen.yml", `version: 1\nname: Slow\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns:\n      - user: wait for it\n        expect:\n          - { type: status, equals: 200 }\n`);
    await reopen(page);
    await expect(page.locator('#suiteList .list-row[data-file="slow.hafen.yml"]')).toHaveCount(1);
  }
  const confirmDelete = async (row) => { await row.hover(); await row.locator(".list-del").first().click(); await row.locator(".list-del").first().click(); };

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a suite deleted while its test runs: the run stops, and nothing of it is left showing", async ({ app: { page, servers } }) => {
    await slowSuite(page, servers);
    await openTest(page, "slow one");
    await page.click("#testRun");
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(1);
    await confirmDelete(page.locator('#suiteList .list-row[data-file="slow.hafen.yml"]').first());
    await expect(page.locator('#suiteList .list-row[data-file="slow.hafen.yml"]')).toHaveCount(0);
    await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(0);
    await expect(page.locator("#evalTitle")).not.toHaveText("slow one");
    await expect(page.locator("#thread")).not.toContainText("wait for it");
    // The reply that would have come doesn't bring it back
    await page.waitForTimeout(2800);
    await expect(page.locator("#suiteList")).not.toContainText("slow one");
    await expect(page.locator("#thread")).not.toContainText("wait for it");
  });

  test("a suite's file renamed with one of its checks open: the check is still there to open, and the file has it", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click();
    await page.locator("#turnCheck-1-open").click();
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    await page.fill("#suiteFile", "renamed");
    await page.press("#suiteFile", "Enter");
    await expect(page.locator('#suiteList .list-row[data-file="renamed.hafen.yml"]')).toHaveCount(1);
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click();
    await page.locator("#turnCheck-1-on").uncheck();
    await fileSays(page, (d) => d.tests[0].turns[0].expect[1].enabled === false, "renamed.hafen.yml");
  });
});

test.describe("its YAML, saved when it doesn't parse", () => {
  const openTest = (page, name = "refund for a broken item") => page.locator("#suiteList .list-open", { hasText: name }).first().click();

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("the suite's YAML editor saved with YAML that doesn't parse: what was typed isn't lost, the problem is said, and fixed it's the suite again", async ({ app: { page } }) => {
    await openTest(page);
    await page.click("#testYamlEdit");
    const editor = page.locator("#editorText");
    await expect(editor).toBeVisible();
    const good = await editor.inputValue();
    const broken = good.replace("tests:\n", "tests: [\n");
    await editor.fill(broken);
    await page.click("#editorSave");
    await expect(page.locator(".toast", { hasText: `${SUITE} has problems` })).toBeVisible();
    // Kept as typed (nothing thrown away), and the suite says what's wrong
    expect(await fileText(page, SUITE)).toBe(broken);
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    await expect(page.locator("#panel .problems")).toBeVisible();
    // Opened again, the editor has it as it was typed; fixed, the suite and its test are back
    await page.click("#suiteYamlEdit");
    await expect(page.locator("#editorText")).toHaveValue(broken);
    await page.fill("#editorText", good);
    await page.click("#editorSave");
    await expect.poll(() => fileText(page, SUITE)).toBe(good);
    await expect(page.locator("#panel .problems")).toHaveCount(0);
    await openTest(page);
    await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
  });
});

test.describe("its results, renamed while it runs, and its problems", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`).first();
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

  test("a suite's results follow it: a new suite by its old name doesn't take them, and one renamed to a deleted one's name keeps its own", async ({ app: { page } }) => {
    await openApp(page);
    // tests.hafen.yml, run, then renamed to refunds
    await page.click("#newSuite");
    await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
    await expect(page.locator("#newSuiteForm")).toHaveCount(0);  // (closed once the suite's loaded: + again opens it)
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
    await openApp(page);
    await page.locator('#suiteList .list-row[data-file="slow.hafen.yml"] .list-open').first().click();
    await page.click("#suiteRun");
    await page.fill("#suiteFile", "renamed");
    await page.press("#suiteFile", "Enter");
    await expect(toast(page, "is running")).toBeVisible();
    await expect(page.locator('#suiteList .list-row[data-file="slow.hafen.yml"]')).toHaveCount(1);
    await expect(page.locator('#suiteList .list-row[data-file="renamed.hafen.yml"]')).toHaveCount(0);
  });

  test("a suite's folding stays with it when another is added above it", async ({ app: { page } }) => {
    await openApp(page);
    await page.click(`#${await suiteRow(page, SUITE).getAttribute("id")}-toggle`);
    await expect(suiteRow(page, SUITE).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
    await writeFile(page, "a.hafen.yml", "version: 1\nprovider: providers/mock-json.yml\ntests:\n  - name: first\n    turns: [ { user: hi } ]\n");
    await openApp(page);
    await expect(page.locator('#suiteList .list-row[data-file="a.hafen.yml"]')).toHaveCount(1);
    await expect(suiteRow(page, SUITE).locator(".tree-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(suiteRow(page, "a.hafen.yml").locator(".tree-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  test("a suite written wrong: the app still draws, says what's wrong, and won't edit it until it's fixed as YAML", async ({ app: { page } }) => {
    await writeFile(page, "bad.hafen.yml", "version: 1\nprovider: providers/mock-json.yml\ntests:\n  - name: a\n    tags: smoke\n    turns:\n      - user: hi\n        expect:\n          path: $.x\n");
    await openApp(page);
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

  test("a check type that isn't one is a problem before the suite's run, as validate says; logged once, not again when the folder's read again", async ({ app: { page } }) => {
    await writeFile(page, "typos.hafen.yml", "version: 1\nprovider: providers/mock-json.yml\nenvironments:\n  local: { base_url: \"http://127.0.0.1:1\" }\ntests:\n  - name: typo\n    turns:\n      - user: hi\n        expect:\n          - { type: contians, value: refund }\n");
    await openApp(page);
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
    await openYaml(page);
    await page.fill("#providerYaml", `${await fileText(page, "providers/mock-json.yml")}timeout_ms: 9000\n`);
    await page.locator("#providerYaml").blur();
    await expect.poll(async () => parse(await fileText(page, "providers/mock-json.yml"))?.timeout_ms).toBe(9000);
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
});

test.describe("Suites' + and its form", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).click();

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("Suites' + asks for a name and uses the provider in use; searching by status finds failed tests", async ({ app: { page } }) => {
    await openApp(page);
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
});

test.describe("its group", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: name }).first().click();

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a test's group and a suite's group: set in their panels, written to the file, cleared; a bad one isn't saved", async ({ app: { page } }) => {
    await openApp(page);
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#testGroup")).toHaveValue("");
    await expect(page.locator("#testGroupHint")).toContainText("Tests in the same group run one after another; different groups run at the same time");
    await page.fill("#testGroup", "2");
    await page.press("#testGroup", "Enter");
    await expect.poll(async () => parse(await fileText(page, SUITE))?.tests[0].group).toBe(2);
    // Not a whole number of 1 or more: not saved, the field shows the file's
    for (const bad of ["0", "1.5", "-3"]) {
      await page.fill("#testGroup", bad);
      await page.press("#testGroup", "Enter");
      await expect(page.locator("#testGroup")).toHaveValue("2");
    }
    expect(parse(await fileText(page, SUITE)).tests[0].group).toBe(2);
    // Emptied: no group
    await page.fill("#testGroup", "");
    await page.press("#testGroup", "Enter");
    await expect.poll(async () => "group" in parse(await fileText(page, SUITE)).tests[0]).toBe(false);
    // The suite's
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"]`).first().locator(".list-open").click();
    await expect(page.locator("#suiteGroupHint")).toContainText("Suites in the same group run one after another");
    await page.fill("#suiteGroup", "3");
    await page.press("#suiteGroup", "Enter");
    await expect.poll(async () => parse(await fileText(page, SUITE))?.group).toBe(3);
    await page.fill("#suiteGroup", "");
    await page.press("#suiteGroup", "Enter");
    await expect.poll(async () => "group" in parse(await fileText(page, SUITE))).toBe(false);
  });
});
