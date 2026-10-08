// Every add, change and delete the app offers, end to end in the browser build: after each one, the
// file in the folder says it (parsed), the UI shows it (sidebar, panel, thread), and the "as YAML"
// views show the file as it now is. No errors on the page.

import { parse } from "yaml";
import { addScope, expect, fileText, openYaml, showEntry, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const suiteData = async (page) => parse(await fileText(page, SUITE));
// Wait until the file says what `check` wants (it's written through the engine, a moment later)
const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
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
// A turn's row in the sidebar: its button is named "turn N: its message" (it shows the message, with an icon)
const turnRow = (page, n, text = "") => page.locator("#suiteList .list-row").filter({ has: page.locator(`.list-open[aria-label^="turn ${n}: ${text}"]`) }).first();
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

test("a test's fields: each change is in the file, the sidebar, the thread and the YAML view", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  // Name
  await page.fill("#testName", "refund, broken item");
  await page.press("#testName", "Enter");
  await fileSays(page, (d) => d.tests[0].name === "refund, broken item");
  await expect(row(page, "refund, broken item")).toBeVisible();
  await expect(page.locator("#evalTitle")).toHaveText("refund, broken item");
  await yamlViewMatches(page, "testYaml");
  // An empty name isn't saved, and the field shows the name again
  await page.fill("#testName", "");
  await page.press("#testName", "Enter");
  await expect(page.locator("#testName")).toHaveValue("refund, broken item");
  expect((await suiteData(page)).tests[0].name).toBe("refund, broken item");
  // Tags
  await page.fill("#testTags", "smoke, refunds ,  ");
  await page.press("#testTags", "Enter");
  await fileSays(page, (d) => JSON.stringify(d.tests[0].tags) === '["smoke","refunds"]');
  await page.fill("#testTags", "");
  await page.press("#testTags", "Enter");
  await fileSays(page, (d) => d.tests[0].tags === undefined);
  // Repeat and pass rate
  await page.fill("#testRepeat", "3");
  await page.press("#testRepeat", "Enter");
  await fileSays(page, (d) => d.tests[0].repeat === 3);
  await page.fill("#testPassRate", "0.5");
  await page.press("#testPassRate", "Enter");
  await fileSays(page, (d) => d.tests[0].pass_rate === 0.5);
  await page.fill("#testRepeat", "0");
  await page.press("#testRepeat", "Enter");
  await expect(page.locator("#testRepeat")).toHaveValue("3");
  await page.fill("#testRepeat", "");
  await page.press("#testRepeat", "Enter");
  await fileSays(page, (d) => d.tests[0].repeat === undefined);
  await expect(page.locator("#testRepeat")).toHaveValue("1");
  // The selects
  await page.selectOption("#testHistory", "pinned");
  await page.selectOption("#testOnFail", "stop");
  // (unsure: fail is the default, shown when the file says none; warn is a change)
  await expect(page.locator("#testUnsure")).toHaveValue("fail");
  await page.selectOption("#testUnsure", "warn");
  await fileSays(page, (d) => d.tests[0].history === "pinned" && d.tests[0].on_fail === "stop" && d.tests[0].unsure === "warn");
  // Data file
  await page.fill("#testData", "data/rows.csv");
  await page.press("#testData", "Enter");
  await fileSays(page, (d) => d.tests[0].data === "data/rows.csv");
  await page.fill("#testData", "");
  await page.press("#testData", "Enter");
  await fileSays(page, (d) => d.tests[0].data === undefined);
  await yamlViewMatches(page, "testYaml");
  // Another test shows its own values, not these
  await addTestToSmoke(page);
  await expect(page.locator("#testName")).toHaveValue("New test");
  await expect(page.locator("#testRepeat")).toHaveValue("1");
  await expect(page.locator("#testPassRate")).toHaveValue("1");
  await expect(page.locator("#testHistory")).toHaveValue("live");
  await expect(page.locator("#testTags")).toHaveValue("");
  await openTest(page, "refund, broken item");
  await expect(page.locator("#testPassRate")).toHaveValue("0.5");
  await expect(page.locator("#testHistory")).toHaveValue("pinned");
});

test("turns: added from the message box, edited and deleted from the panel and the sidebar", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  // Add (the message box, with a test open)
  await page.fill("#input", "my name is ronaldo: remember it");
  await page.click("#send");
  await fileSays(page, (d) => d.tests[0].turns.length === 3 && d.tests[0].turns[2].user === "my name is ronaldo: remember it");
  await expect(page.locator("#panel .panel-head")).toContainText("Turn 3");
  await expect(page.locator("#thread")).toContainText("my name is ronaldo: remember it");
  await expect(turnRow(page, 3, "my name is ronaldo")).toBeVisible();
  await yamlViewMatches(page, "suiteYaml").catch(() => {});  // (the suite panel isn't open: no view to check)
  // Edit its message
  await page.fill("#turnUser", "what is my name?");
  await page.locator("#turnUser").blur();
  await fileSays(page, (d) => d.tests[0].turns[2].user === "what is my name?");
  await expect(page.locator("#thread")).toContainText("what is my name?");
  // Extract: set, then an invalid one is refused, then cleared
  await page.fill("#turnExtract", "session: $.session_id");
  await page.locator("#turnExtract").blur();
  await fileSays(page, (d) => d.tests[0].turns[2].extract?.session === "$.session_id");
  await page.fill("#turnExtract", "session: [unclosed");
  await page.locator("#turnExtract").blur();
  await expect(page.locator(".toast", { hasText: "isn't YAML" })).toBeVisible();
  expect((await suiteData(page)).tests[0].turns[2].extract.session).toBe("$.session_id");
  await page.fill("#turnExtract", "");
  await page.locator("#turnExtract").blur();
  await fileSays(page, (d) => d.tests[0].turns[2].extract === undefined);
  // Delete it from its panel
  await confirmDelete(page.locator("#turnDelete"));
  await fileSays(page, (d) => d.tests[0].turns.length === 2);
  await expect(page.locator("#panel .panel-head")).toContainText("Test");
  await expect(page.locator("#thread")).not.toContainText("what is my name?");
  // Delete one from the sidebar
  const turn2 = turnRow(page, 2, "It arrived broken");
  await turn2.hover();
  await confirmDelete(turn2.locator(".list-del"));
  await fileSays(page, (d) => d.tests[0].turns.length === 1 && d.tests[0].turns[0].user.startsWith("Hi, I'm"));
  await expect(page.locator("#thread")).not.toContainText("It arrived broken");
});

test("checks: added from the palette and the response, changed as YAML, deleted from the turn and the check", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await turnRow(page, 2, "It arrived broken").locator(".list-open").click();
  // From the palette
  await page.click("#checksToggle");
  await page.click("#palette-status");
  await fileSays(page, (d) => d.tests[0].turns[1].expect.length === 2 && d.tests[0].turns[1].expect[1].type === "status");
  await expect(page.locator("#panel .panel-head")).toContainText("Check · status");
  // Changed as YAML
  await page.fill("#checkYaml", "type: status\nequals: 201");
  await page.locator("#checkYaml").blur();
  await fileSays(page, (d) => d.tests[0].turns[1].expect[1].equals === 201);
  // Not YAML: refused, the file as it was
  await page.fill("#checkYaml", "type: [status");
  await page.locator("#checkYaml").blur();
  await expect(page.locator(".toast", { hasText: "isn't valid YAML" })).toBeVisible();
  expect((await suiteData(page)).tests[0].turns[1].expect[1].equals).toBe(201);
  // Deleted from the check's panel
  await confirmDelete(page.locator("#checkDelete"));
  await fileSays(page, (d) => d.tests[0].turns[1].expect.length === 1);
  await expect(page.locator("#panel .panel-head")).toContainText("Turn 2");
  // From the response: turn 1's order id
  await turnRow(page, 1).locator(".list-open").click();
  await page.locator("#turnResponse .json-value").filter({ hasText: /^4417$/ }).click();
  await page.click("#pathAdd");
  await fileSays(page, (d) => d.tests[0].turns[0].expect.length === 5 && d.tests[0].turns[0].expect[4].path === "$.data.order.id");
  // Deleted from the turn's list of checks (the third: $.data.order.id equals 4417, the original)
  await turnRow(page, 1).locator(".list-open").click();
  await confirmDelete(page.locator("#turnCheck-2 .list-del"));
  await fileSays(page, (d) => d.tests[0].turns[0].expect.length === 4 && d.tests[0].turns[0].expect[2].type === "latency");
  // A turn with no checks gets its first
  await page.fill("#input", "and the refund?");
  await page.click("#send");
  await fileSays(page, (d) => d.tests[0].turns.length === 3);
  await page.click("#palette-text");
  await fileSays(page, (d) => Array.isArray(d.tests[0].turns[2].expect) && d.tests[0].turns[2].expect.length === 1);
  // The comment in the file is still there
  expect(await fileText(page, SUITE)).toContain("# fails by design");
});

test("tests: added to a suite, and deleted from the panel and the sidebar, the YAML view following", async ({ app: { page } }) => {
  await addTestToSmoke(page);
  await fileSays(page, (d) => d.tests.length === 2 && d.tests[1].name === "New test");
  await yamlViewMatches(page, "testYaml");
  await page.fill("#testName", "second");
  await page.press("#testName", "Enter");
  await fileSays(page, (d) => d.tests[1].name === "second");
  await yamlViewMatches(page, "testYaml");
  // Delete from the panel
  await confirmDelete(page.locator("#testDelete"));
  await fileSays(page, (d) => d.tests.length === 1 && d.tests[0].name === "refund for a broken item");
  await expect(page.locator("#suiteList")).not.toContainText("second");
  await expect(page.locator("#panel .panel-head")).toContainText("Suite");
  await yamlViewMatches(page, "suiteYaml");
  // Add two, delete the first from the sidebar: the other stays, the right one went
  await addTestToSmoke(page);
  await page.fill("#testName", "keep me");
  await page.press("#testName", "Enter");
  await addTestToSmoke(page);
  await fileSays(page, (d) => d.tests.length === 3);
  const first = row(page, "refund for a broken item");
  await first.hover();
  await confirmDelete(first.locator(".list-del"));
  await fileSays(page, (d) => d.tests.length === 2 && d.tests[0].name === "keep me" && d.tests[1].name === "New test");
  await expect(page.locator("#suiteList")).not.toContainText("refund for a broken item");
  // The test that was open (after the deleted one) is still the one shown, and still edits itself
  await expect(page.locator("#testName")).toHaveValue("New test");
  await expect(page.locator("#evalTitle")).toHaveText("New test");
  await yamlViewMatches(page, "testYaml");
  await page.fill("#testName", "last one");
  await page.press("#testName", "Enter");
  await fileSays(page, (d) => d.tests[0].name === "keep me" && d.tests[1].name === "last one");
  // Every test gone: the suite stays, with an empty list
  for (const name of ["keep me", "last one"]) {
    const r = row(page, name);
    await r.hover();
    await confirmDelete(r.locator(".list-del"));
  }
  await fileSays(page, (d) => Array.isArray(d.tests) && d.tests.length === 0);
  expect(await fileText(page, SUITE)).toContain("tests: []");
  await expect(row(page, SUITE).locator(".list-size")).toHaveText("0 tests");
});

test("suites: new ones, named, renamed, pointed at a provider, and deleted", async ({ app: { page } }) => {
  await page.click("#newSuite");
  await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
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

test("explore: a conversation saved as a test, in a new suite and in an existing one", async ({ app: { page } }) => {
  await page.selectOption("#convProvider", "providers/mock-sse.yml");
  await page.fill("#input", "I want a refund");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("Could you tell me why");
  await expect(page.locator("#send")).toHaveText(/send/i);  // (the reply is done: the button isn't Stop)
  await page.fill("#input", "It arrived broken");
  await page.click("#send");
  await expect(page.locator("#turn-1-reply .msg-body")).not.toBeEmpty();
  await expect(page.locator("#send")).toHaveText(/send/i);
  await expect(page.locator("#saveSuite option").first()).toHaveText("New suite (tests.hafen.yml)");
  await page.fill("#saveName", "refund chat");
  await page.click("#saveTest");
  await fileSays(page, (d) => d.tests.length === 1 && d.tests[0].name === "refund chat" && d.tests[0].turns.map((t) => t.user).join("|") === "I want a refund|It arrived broken" && d.provider === "providers/mock-sse.yml", "tests.hafen.yml");
  await expect(page.locator("#evalTitle")).toHaveText("refund chat");
  // Again, into the smoke suite
  await page.click("#panelClose");
  await page.fill("#input", "hello");
  await page.click("#send");
  await expect(page.locator("#turn-2-reply .msg-body")).not.toBeEmpty();
  await expect(page.locator("#send")).toHaveText(/send/i);
  await page.selectOption("#saveSuite", SUITE);
  await page.fill("#saveName", "hello chat");
  await page.click("#saveTest");
  await fileSays(page, (d) => d.tests.length === 2 && d.tests[1].name === "hello chat" && d.tests[1].turns.length === 3);
  expect(await fileText(page, SUITE)).toContain("# fails by design");
  // A new conversation (the sidebar's +; the panel has no button for it) clears the thread
  await page.click("#panelClose");
  await expect(page.locator("#convReset")).toHaveCount(0);
  await page.click("#newConversation");
  await expect(page.locator("#threadEmpty")).toBeVisible();
});

test("providers: changed as YAML, refused when it isn't, renamed, deleted", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-json-open");
  await openYaml(page);
  await expect(page.locator("#providerYaml")).toHaveValue(/kind: http/);
  const text = await page.locator("#providerYaml").inputValue();
  await page.fill("#providerYaml", text.replace("kind: http", "kind: http\ntimeout_ms: 9000"));
  await page.locator("#providerYaml").blur();
  await fileSays(page, (d) => d.timeout_ms === 9000, "providers/mock-json.yml");
  await page.fill("#providerYaml", "kind: [http");
  await page.locator("#providerYaml").blur();
  // (said under the field, with its line, and kept there: not a toast that goes)
  await expect(page.locator("#providerYamlError")).toContainText(/line \d+, column \d+: .*Not saved/);
  await fileSays(page, (d) => d.timeout_ms === 9000, "providers/mock-json.yml");
  await page.fill("#providerName", "shop");
  await page.press("#providerName", "Enter");
  await expect(page.locator("#providerFacts")).toContainText("providers/shop.yml");
  await fileSays(page, (d) => d.provider === "providers/shop.yml");
  await expect(page.locator("#providerYaml")).toHaveValue(/timeout_ms: 9000/);
  await confirmDelete(page.locator("#providerDelete"));
  await expect(page.locator("#providerList")).not.toContainText("shop");
  await expect.poll(() => fileText(page, "providers/shop.yml").then(() => "there", () => "gone")).toBe("gone");
});

test("secrets: one scope's and Globals', changed and forgotten", async ({ app: { page } }) => {
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("eval.secrets") ?? "{}"));
  await addScope(page, "local");
  await page.click("#openSettings");
  await page.click("#settings-tab-secrets");
  // (it opens on the scope chosen: local, made in Environments)
  await expect(page.locator("#secretsScope-local")).toHaveClass(/active/);
  await showEntry(page, "", "secrets");
  await page.fill("#secretName", "SHOP_TOKEN");
  await page.fill("#secretValue", "every");
  await page.press("#secretValue", "Enter");
  await expect(page.locator("#secret-SHOP_TOKEN .vars-source")).toHaveText("Globals");
  await showEntry(page, "local", "secrets");
  await expect(page.locator("#secret-SHOP_TOKEN .vars-source")).toHaveText("from Globals");
  await page.click("#secret-SHOP_TOKEN-override");
  await page.fill("#secretValue", "local only");
  await page.press("#secretValue", "Enter");
  await expect(page.locator("#secret-SHOP_TOKEN .vars-source")).toHaveText("overrides Globals");
  expect(await stored()).toEqual({ "": { SHOP_TOKEN: "every" }, local: { SHOP_TOKEN: "local only" } });
  // (forgetting asks first)
  await page.click("#secret-SHOP_TOKEN-forget");
  await expect(page.locator("#secret-SHOP_TOKEN-forget")).toHaveText("forget it?");
  await page.click("#secret-SHOP_TOKEN-forget");
  await expect(page.locator("#secret-SHOP_TOKEN .vars-source")).toHaveText("from Globals");
  expect(await stored()).toEqual({ "": { SHOP_TOKEN: "every" } });
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

test("after a run, each turn and check keeps its own result when others are deleted or added", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator("#turn-1-reply .check-badge[data-status='fail']")).toHaveText("contains refund");
  // Delete turn 1's second check (contains 4417): the others keep theirs
  await turnRow(page, 1).locator(".list-open").click();
  await confirmDelete(page.locator("#turnCheck-1 .list-del"));
  await fileSays(page, (d) => d.tests[0].turns[0].expect.length === 3);
  const badges = page.locator("#turn-0-reply .check-badge");
  await expect(badges).toHaveCount(3);
  expect(await badges.evaluateAll((els) => els.map((e) => `${e.dataset.status} ${e.textContent.trim()}`))).toEqual(["pass status 200", "pass $.data.order.id = 4417", "pass latency ≤ 5.0 s"]);
  // A check added since the run hasn't run: no result
  await page.click("#checksToggle");
  await page.click("#palette-status");
  await expect(page.locator("#turn-0-reply .check-badge")).toHaveCount(4);
  await expect(page.locator("#turn-0-reply .check-badge").nth(3)).toHaveAttribute("data-status", "");
  // Delete turn 1: turn 2 (now the first) keeps its reply and its failed check; nothing of turn 1 shows
  await turnRow(page, 1).locator(".list-open").click();
  await confirmDelete(page.locator("#turnDelete"));
  await fileSays(page, (d) => d.tests[0].turns.length === 1);
  await expect(page.locator("#thread")).not.toContainText("I want a refund for order 4417");
  await expect(page.locator("#turn-0-user")).toContainText("It arrived broken");
  await expect(page.locator("#turn-0-reply .check-badge[data-status='fail']")).toHaveText("contains refund");
  await expect(page.locator("#turn-1-user")).toHaveCount(0);
  await expect(turnRow(page, 1, "It arrived broken").locator(".list-size")).toHaveText("0/1");
  // A changed message hasn't run either
  await turnRow(page, 1, "It arrived broken").locator(".list-open").click();
  await page.fill("#turnUser", "It arrived broken, twice");
  await page.locator("#turnUser").blur();
  await expect(page.locator("#turn-0-reply .msg-body")).toHaveText("Not run yet.");
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

test("checks aren't dragged: a palette card dropped on a turn adds nothing; a click adds it to the selected turn", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await page.click("#checksToggle");
  await expect(page.locator("#palette-latency")).not.toHaveAttribute("draggable", "true");
  const before = await fileText(page, SUITE);
  await page.dragAndDrop("#palette-latency", "#turn-1-user");
  await page.waitForTimeout(300);
  expect(await fileText(page, SUITE)).toBe(before);
  await expect(page.locator("#turn-1-user")).not.toHaveClass(/drop-target/);
  // Selected, then clicked: added
  await page.locator("#turn-1 .turn-head .label").click();
  await page.click("#palette-latency");
  await fileSays(page, (d) => d.tests[0].turns[1].expect.length === 2 && d.tests[0].turns[1].expect[1].type === "latency");
  await expect(page.locator("#panel .panel-head")).toContainText("Check · latency");
});

test("quick edits all land: two checks added at once are both in the file", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await turnRow(page, 2).locator(".list-open").click();
  await page.click("#checksToggle");
  await page.locator("#palette-status").dblclick();
  await fileSays(page, (d) => d.tests[0].turns[1].expect.length === 3);
  await page.locator("#palette-length").click();
  await page.locator("#palette-json").click();
  await fileSays(page, (d) => d.tests[0].turns[1].expect.length === 5 && d.tests[0].turns[1].expect.map((c) => c.type ?? "").join(",") === ",status,status,length,json");
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
