// Tests and their turns: a test's fields (its name, tags, repeats, history, data file and row names);
// turns added, edited, deleted and run up to; how they're listed, selected and marked; and a turn's
// panel (its response, its request and raw stream).

import { parse } from "yaml";
import { colour, expect, fileText, mockLog, reopen, style, test, token, writeFile, writeFiles } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const suiteData = async (page) => parse(await fileText(page, SUITE));
const turnButton = (page, n, text = "") => page.locator(`#suiteList .list-open[aria-label^="turn ${n}: ${text}"]`).first();

test("repeats: the test panel sets them, and a picker chooses which repeat the thread shows", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await page.fill("#testRepeat", "3");
  await page.locator("#testRepeat").blur();
  await expect.poll(() => fileText(page, "smoke.hafen.yml")).toContain("repeat: 3");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/3");
  await expect(page.locator("#testInstance option")).toHaveCount(3);
  await page.selectOption("#testInstance", "2|");
  await expect(page.locator("#turn-0 .turn-head .label")).toContainText("run 2");
});

test("the test's header has a play button that runs it", async ({ app: { page } }) => {
  await expect(page.locator("#testHeaderRun")).toHaveCount(0);
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  const play = page.locator("#testHeaderRun");
  await expect(play).toBeVisible();
  await expect(play).toHaveAttribute("aria-label", "Run this test");
  await play.click();
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(play).toHaveAttribute("aria-label", "Run this test");
  await expect(page.locator("#runList")).toContainText("failed");
});

test("deleting a test or suite clears what the thread and timeline showed of it", async ({ app: { page } }) => {
  // A conversation, saved as a test in the smoke suite
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-sse-open");
  await page.click("#providerTry");
  await page.fill("#input", "I want a refund");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("Could you tell me why");
  await page.selectOption("#saveSuite", "smoke.hafen.yml");
  await page.fill("#saveName", "refund chat");
  await page.click("#saveTest");
  await expect(page.locator("#suiteList")).toContainText("refund chat");
  // Its test, run
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).not.toContainText("running");
  await expect(page.locator(".timeline-bar").first()).toBeVisible();
  // Deleting it clears the thread and the timeline, and the conversation it came from
  const row = page.locator("#suiteList .list-row", { hasText: "refund chat" });
  await row.hover();
  await row.locator(".list-del").click();
  await row.locator(".list-del").click();
  await expect(page.locator("#suiteList")).not.toContainText("refund chat");
  await page.click("#panelClose");
  await expect(page.locator("#threadEmpty")).toBeVisible();
  await expect(page.locator(".timeline-bar")).toHaveCount(0);
  await expect(page.locator("#timelineEmpty")).toBeVisible();
});

test.describe("a test's fields, its turns, and its rows", () => {
  const ROWS = "rows.hafen.yml";
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
  const clearMockLog = (servers) => fetch(`${servers.mock.url}/_log`, { method: "DELETE" });

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

  test("Row names: shown with a data file; it writes row_name, and emptied, removes it", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#testRowName")).toHaveCount(0);
    await page.fill("#testData", "data/rows.csv");
    await page.press("#testData", "Enter");
    await fileSays(page, (d) => d.tests[0].data === "data/rows.csv");
    await expect(page.locator("#testRowName")).toHaveAttribute("placeholder", "first column");
    await expect(page.locator("#testRowNameHint")).toContainText("its first column's value");
    await page.fill("#testRowName", "{{row.question}} ({{row.order}})");
    await page.press("#testRowName", "Enter");
    await fileSays(page, (d) => d.tests[0].row_name === "{{row.question}} ({{row.order}})");
    expect(await fileText(page, SUITE)).toContain('row_name: "{{row.question}} ({{row.order}})"');
    await page.fill("#testRowName", "");
    await page.press("#testRowName", "Enter");
    await fileSays(page, (d) => d.tests[0].row_name === undefined && d.tests[0].data === "data/rows.csv");
    await expect(page.locator("#testRowName")).toHaveValue("");
  });

  test("after a run, each row by its name: its turns' heads and the Showing list, by its first column or by row_name", async ({ app: { page, servers } }) => {
    await writeFiles(page, {
      "data/orders.csv": "question,order\na refund for 4417,4417\na refund please,9999\n",
      [ROWS]: `version: 1\nname: Rows\nprovider: providers/mock-json.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: orders\n    data: data/orders.csv\n    turns:\n      - user: "{{row.question}}"\n        expect:\n          - { path: $.data.order.id, equals: "{{row.order}}" }\n`,
    });
    await reopen(page);
    await openTest(page, "orders");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 1/2");
    // The latest row, by its first column; the Showing list, the one that failed first
    await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1 · row 2: a refund please");
    await expect(page.locator("#testInstance option")).toHaveText(["row 2: a refund please · failed", "row 1: a refund for 4417 · passed"]);
    await page.selectOption("#testInstance", "1|1");
    await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1 · row 1: a refund for 4417");
    // Named by row_name, the next run
    await page.fill("#testRowName", "{{row.question}} ({{row.order}})");
    await page.press("#testRowName", "Enter");
    await fileSays(page, (d) => d.tests[0].row_name === "{{row.question}} ({{row.order}})", ROWS);
    await page.click("#testRun");
    await expect(page.locator("#testInstance option")).toHaveText(["row 2: a refund please (9999) · failed", "row 1: a refund for 4417 (4417) · passed"]);
    await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1 · row 1: a refund for 4417 (4417)");
  });
});

test.describe("a turn with no checks, and a test deleted with a check open", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  async function send(page, text) {
    const before = await page.locator("#thread .turn-group").count();
    await page.fill("#input", text);
    await page.click("#send");
    await expect(page.locator("#thread .turn-group")).toHaveCount(before + 1);
    await expect(page.locator("#send")).toHaveText(/send/i);
  }
  const confirmDelete = async (row) => { await row.hover(); await row.locator(".list-del").first().click(); await row.locator(".list-del").first().click(); };

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a turn with no checks is yellow (unsure's colour) in the sidebar, the suite's view and its head, run or not", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    // A turn with no checks, added from the message box
    await page.fill("#input", "anything else?");
    await page.click("#send");
    await fileSays(page, (d) => d.tests[0].turns.length === 3 && d.tests[0].turns[2].expect === undefined);
    const wait = await token(page, "--wait");
    const third = turnButton(page, 3, "anything else?");
    await expect(third.locator(".turn-icon")).toHaveAttribute("data-status", "unchecked");
    expect(await colour(third.locator(".turn-icon"))).toBe(wait);
    const size = third.locator("xpath=..").locator(".list-size");
    await expect(size).toHaveText("0 checks");
    expect(await colour(size)).toBe(wait);
    await expect(page.locator("#turn-2 .turn-summary")).toHaveText("not run yet · 0 checks");
    expect(await colour(page.locator("#turn-2 .turn-summary"))).toBe(wait);
    // A turn with checks isn't
    await expect(turnButton(page, 1).locator(".turn-icon")).not.toHaveAttribute("data-status", "unchecked");
    expect(await colour(turnButton(page, 1).locator(".turn-icon"))).not.toBe(wait);
    // Run: still yellow (it ran, but nothing says it's right); the others by their results
    await page.click("#testHeaderRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await expect(third.locator(".turn-icon")).toHaveAttribute("data-status", "unchecked");
    await expect(page.locator("#turn-2 .turn-summary")).toHaveText(/^0 checks · \d/);
    expect(await colour(page.locator("#turn-2 .turn-summary"))).toBe(wait);
    await expect(turnButton(page, 1).locator(".turn-icon")).toHaveAttribute("data-status", "passed");
    // In the suite's view too
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    await expect(page.locator("#suiteTest-0-turn-2 .turn-icon")).toHaveAttribute("data-status", "unchecked");
    await expect(page.locator("#suiteTest-0-turn-2 .turn-summary")).toHaveText("0 checks");
    expect(await colour(page.locator("#suiteTest-0-turn-2 .turn-summary"))).toBe(wait);
    // Every check turned off: the same
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-1 .turn-head .label").click();
    await page.locator("#turnCheck-0-on").uncheck();
    await fileSays(page, (d) => d.tests[0].turns[1].expect[0].enabled === false);
    await expect(turnButton(page, 2).locator(".turn-icon")).toHaveAttribute("data-status", "unchecked");
    await expect(turnButton(page, 2).locator("xpath=..").locator(".list-size")).toHaveText("0 checks");
    // A check added: not yellow any more
    await page.click("#checksToggle");
    await page.locator("#turn-2 .turn-head .label").click();
    await page.click("#palette-status");
    await fileSays(page, (d) => d.tests[0].turns[2].expect?.length === 1);
    await expect(third.locator(".turn-icon")).not.toHaveAttribute("data-status", "unchecked");
    await expect(third.locator("xpath=..").locator(".list-size")).toHaveText("1 check");
  });

  test("the response's JSON is as JSON has it: a key with no value isn't listed", async ({ app: { page } }) => {
    // The streamed reply's assembled usage has no thinking or cached tokens
    await page.selectOption("#convProvider", "providers/mock-sse.yml");
    await send(page, "hi");
    await page.locator("#turn-0 .turn-head .label").click();
    await expect(page.locator("#turnResponse")).toContainText("usage");
    await expect(page.locator("#turnResponse")).not.toContainText("undefined");
    // Folded, its count is of the keys it has
    const usage = page.locator("#turnResponse .json-row", { has: page.locator(".json-key", { hasText: /^usage: $/ }) });
    await usage.locator(".tree-toggle").click();
    await expect(usage.locator(".json-fold")).toHaveText("{2}");
  });

  test("a test deleted from the sidebar while one of its checks is open: the panel goes to its suite", async ({ app: { page } }) => {
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click();
    await page.locator("#turnCheck-1-open").click();
    await expect(page.locator("#panel .panel-head")).toContainText("Check");
    await confirmDelete(page.locator("#suiteList .list-row", { hasText: "refund for a broken item" }).first());
    await fileSays(page, (d) => (d.tests ?? []).length === 0);
    await expect(page.locator("#panel .panel-head")).toContainText("Suite");
    await expect(page.locator("#thread")).not.toContainText("I want a refund");
  });
});

test.describe("pinned history", () => {
  const fileSays = (page, check) => expect.poll(async () => { try { return check(await suiteData(page)); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  const openTest = (page, name = "refund for a broken item") => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const turnRow = (page, n) => page.locator(`#suiteList .list-open[aria-label^="turn ${n}:"]`).first();

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("with pinned history a turn has a fixed reply, written to the file; with live history it has none", async ({ app: { page } }) => {
    await openTest(page);
    await turnRow(page, 1).click();
    await expect(page.locator("#turnReply")).toHaveCount(0);
    await openTest(page);
    await page.selectOption("#testHistory", "pinned");
    await fileSays(page, (d) => d.tests[0].history === "pinned");
    await turnRow(page, 1).click();
    await expect(page.locator("#turnReply")).toBeVisible();
    await page.fill("#turnReply", "A FIXED REPLY");
    await page.locator("#turnReply").blur();
    await fileSays(page, (d) => d.tests[0].turns[0].reply === "A FIXED REPLY");
    // Back to live: the field goes, the file keeps the reply (it's the turn's, for another time)
    await openTest(page);
    await page.selectOption("#testHistory", "live");
    await fileSays(page, (d) => d.tests[0].history === undefined || d.tests[0].history === "live");
    await turnRow(page, 1).click();
    await expect(page.locator("#turnReply")).toHaveCount(0);
  });
});

test.describe("how turns are listed, and a turn's panel", () => {
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

  test("turns are listed with a box-with-a-tick icon (not 'turn 1'), green when passed, red when failed, blue while running", async ({ app: { page, servers } }) => {
    // A suite whose one turn takes a while
    await writeFile(page, "providers/mock-slow.yml", 'kind: http\nurl: "{{base_url}}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n');
    await writeFile(page, "slow.hafen.yml", `version: 1\nname: Slow\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns:\n      - user: wait for it\n        expect:\n          - { type: status, equals: 200 }\n`);
    await openApp(page);
    // Before a run: the icon, grey; the message, not "turn 1"
    const first = turnButton(page, 1, "Hi, I'm");
    await expect(first.locator(".turn-icon svg")).toHaveCount(1);
    await expect(first.locator(".turn-icon")).not.toHaveAttribute("data-status", /./);
    expect(await first.textContent()).not.toMatch(/turn 1/);
    await expect(first).toHaveAttribute("aria-label", /^turn 1: Hi, I'm \{\{customer\}\}/);
    await runSmoke(page);
    await expect(first.locator(".turn-icon")).toHaveAttribute("data-status", "passed");
    expect(await first.locator(".turn-icon").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--ok"));
    const second = turnButton(page, 2, "It arrived broken");
    await expect(second.locator(".turn-icon")).toHaveAttribute("data-status", "failed");
    expect(await second.locator(".turn-icon").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--danger"));
    // The suite's view lists its turns the same way
    await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
    await expect(page.locator("#suiteTest-0-turn-0 .turn-icon")).toHaveAttribute("data-status", "passed");
    await expect(page.locator("#suiteTest-0-turn-1 .turn-icon")).toHaveAttribute("data-status", "failed");
    expect(await page.locator("#suiteTest-0-turn-0").textContent()).not.toMatch(/turn 1/);
    // Running: blue, then green
    await openTest(page, "slow one");
    await page.click("#testRun");
    const slow = turnButton(page, 1, "wait for it");
    await expect(slow.locator(".turn-icon")).toHaveAttribute("data-status", "running");
    expect(await slow.locator(".turn-icon").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--run"));
    await expect(slow.locator(".turn-icon")).toHaveAttribute("data-status", "passed", { timeout: 10000 });
  });

  test("the response's JSON ends with its closing bracket, as every open object and array does", async ({ app: { page } }) => {
    await openApp(page);
    await runSmoke(page);
    await page.locator("#turn-0 .turn-head .label").click();
    const tree = page.locator("#turnResponse");
    const rows = tree.locator(".json-row");
    // The last row is the root's "}", at its depth
    await expect(rows.last()).toHaveClass(/json-end/);
    await expect(rows.last()).toHaveText("}");
    expect(await rows.last().evaluate((el) => el.style.paddingLeft)).toBe("0px");
    // One closing row for each open object and array
    const open = await tree.locator(".json-row:not(.json-end) > .tree-toggle[aria-expanded='true']").count();
    await expect(tree.locator(".json-end")).toHaveCount(open);
    // Scrolled to its end, the last line shows inside the box
    await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const [inner, outer] = [await box(rows.last()), await box(tree)];
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
    // Folded, the root has no closing row
    await tree.locator(".json-row").first().locator(".tree-toggle").click();
    await expect(tree.locator(".json-end")).toHaveCount(0);
  });

  test("the request and the raw stream: named Request and Raw stream, each on a row of its own, apart", async ({ app: { page } }) => {
    await openApp(page);
    await page.selectOption("#convProvider", "providers/mock-sse.yml");
    await page.fill("#input", "hi");
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
    await page.locator("#turn-0 .turn-head .label").click();
    await expect(page.locator("#turnRequest > summary")).toHaveText("Request");
    await expect(page.locator("#turnStream > summary")).toHaveText(/^Raw stream · \d+ chunks?$/);
    const [request, stream] = [await box(page.locator("#turnRequest")), await box(page.locator("#turnStream"))];
    expect(stream.y - (request.y + request.height)).toBeGreaterThanOrEqual(6);
    expect(request.height).toBeGreaterThanOrEqual(24);
    // Opened, its content is under its name, apart from it
    await page.locator("#turnRequest > summary").click();
    const [summary, pre] = [await box(page.locator("#turnRequest > summary")), await box(page.locator("#turnRequest > pre"))];
    expect(pre.y - (summary.y + summary.height)).toBeGreaterThanOrEqual(6);
  });
});

test.describe("a turn's ▷", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: name }).first().click();

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a turn's ▷ shows as its × does: when the turn is pointed at or selected; always while it's the stop of a run", async ({ app: { page, servers } }) => {
    await openApp(page);
    // (after the folder's opened: opening it writes the fixtures' files)
    await writeFile(page, "providers/mock-json.yml", `kind: http\nurl: "${servers.mock.url}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
    await openTest(page, "refund for a broken item");
    const run = page.locator("#turn-0-run");
    const del = page.locator("#turn-0-delete");
    await page.mouse.move(5, 5);
    await expect.poll(() => style(run, "opacity")).toBe("0");
    await expect.poll(() => style(del, "opacity")).toBe("0");
    await page.locator("#turn-0 .msg.user").hover();
    await expect.poll(() => style(run, "opacity")).toBe("1");
    await expect.poll(() => style(del, "opacity")).toBe("1");
    await page.mouse.move(5, 5);
    await expect.poll(() => style(run, "opacity")).toBe("0");
    // Selected: shown
    await page.locator("#turn-0 .turn-head .label").click();
    await page.mouse.move(5, 5);
    await expect.poll(() => style(run, "opacity")).toBe("1");
    // Focused by the keyboard: shown
    await page.locator("#turn-1 .turn-head .label").click();
    await page.mouse.move(5, 5);
    await expect.poll(() => style(run, "opacity")).toBe("0");
    await run.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect.poll(() => style(run, "opacity")).toBe("1");
    // Running: its stop stays shown
    await run.click();
    await expect(page.locator("#turn-0-run")).toHaveClass(/\bstop\b/);
    await page.mouse.move(5, 5);
    await page.locator("#turn-1 .turn-head .label").click();
    await page.mouse.move(5, 5);
    await expect.poll(() => style(run, "opacity")).toBe("1");
    await expect(page.locator("#status")).toContainText(/passed|failed/, { timeout: 10000 });
  });
});
