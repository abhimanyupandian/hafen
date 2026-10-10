// Checks: added from the palette (its groups) and from a value of the response (every operator),
// changed as YAML, turned off and on, deleted; their cards and badges, coloured by how each went; and
// System One's request, shown on its check and its step.

import { parse } from "yaml";
import { expect, fileText, reopen, style, test, token, writeFile } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const suiteData = async (page) => parse(await fileText(page, SUITE));

test("adds a check by clicking a value of the response, as one new line of YAML", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed");
  const before = await fileText(page, "smoke.hafen.yml");
  await page.locator('#suiteList .list-open[aria-label^="turn 1:"]').click();
  await page.locator("#turnResponse .json-value").filter({ hasText: /^4417$/ }).click();
  await page.click("#pathAdd");
  await expect(page.locator("#panel .panel-head")).toContainText("Check");
  const after = await fileText(page, "smoke.hafen.yml");
  // One more line, and every other line as it was
  const line = "          - { path: $.data.order.id, equals: 4417 }";
  const count = (text) => text.split("\n").filter((l) => l === line).length;
  expect(after.split("\n").length).toBe(before.split("\n").length + 1);
  expect(count(after)).toBe(count(before) + 1);
  const at = after.lastIndexOf(`${line}\n`);
  expect(after.slice(0, at) + after.slice(at + line.length + 1)).toBe(before);
  expect(after).toContain("# fails by design");
});

test.describe("added, changed and deleted", () => {
  // Wait until the file says what `check` wants (it's written through the engine, a moment later)
  const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  // A turn's row in the sidebar: its button is named "turn N: its message" (it shows the message, with an icon)
  const turnRow = (page, n, text = "") => page.locator("#suiteList .list-row").filter({ has: page.locator(`.list-open[aria-label^="turn ${n}: ${text}"]`) }).first();
  const confirmDelete = async (locator) => { await locator.click(); await locator.click(); };

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
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
});

test.describe("every operator of the response's form", () => {
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

  test("a value of the response, checked with each operator the form offers: the check it says, in the file", async ({ app: { page } }) => {
    await openTest(page);
    await run(page, "failed 0/1");
    const add = async (value, op, typed) => {
      await turnRow(page, 1).click();
      await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
      await page.locator("#turnResponse .json-value").filter({ hasText: value }).first().click();
      await page.selectOption("#pathOp", op);
      if (typed !== undefined) await page.fill("#pathValue", typed);
      else await expect(page.locator("#pathValue")).toHaveCount(0);
      await page.click("#pathAdd");
      await expect(page.locator("#panel .panel-head")).toContainText("Check");
    };
    // (a number's operator starts on equals, its value filled in; a text's on contains)
    await turnRow(page, 1).click();
    await page.locator("#turnResponse .json-value").filter({ hasText: /^4417$/ }).click();
    await expect(page.locator("#pathOp")).toHaveValue("equals");
    await expect(page.locator("#pathValue")).toHaveValue("4417");
    await page.locator("#turnResponse .json-value").filter({ hasText: /^"sess_1"$|^sess_1$/ }).first().click();
    await expect(page.locator("#pathOp")).toHaveValue("contains");
    await expect(page.locator("#pathValue")).toHaveValue("sess_1");
    await add(/^4417$/, "not_equals", "4418");
    await add(/^4417$/, "gt", "4000");
    await add(/^4417$/, "lt", "5000");
    await add(/^4417$/, "type_is", "integer");
    await add(/^4417$/, "exists");
    await add(/^"sess_1"$|^sess_1$/, "matches", "^sess_\\d+$");
    await fileSays(page, (d) => d.tests[0].turns[0].expect.length === 10);
    expect((await suiteData(page)).tests[0].turns[0].expect.slice(4)).toEqual([
      { path: "$.data.order.id", not_equals: 4418 },
      { path: "$.data.order.id", gt: 4000 },
      { path: "$.data.order.id", lt: 5000 },
      { path: "$.data.order.id", type_is: "integer" },
      { path: "$.data.order.id", exists: true },
      { path: "$.session_id", matches: "^sess_\\d+$" },
    ]);
    // Each passes when the test runs again
    await openTest(page);
    await run(page, "failed 0/1");
    await expect(page.locator("#turn-0-reply .check-badge[data-status='pass']")).toHaveCount(10);
  });
});

test.describe("their cards, turned off and on, and the palette's groups", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const turnButton = (page, n, text = "") => page.locator(`#suiteList .list-open[aria-label^="turn ${n}: ${text}"]`).first();
  const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  async function runSmoke(page) {
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
  }

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a turn's checks are small cards, tinted by how each went, their dot kept", async ({ app: { page } }) => {
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).first().click();
    // Not run yet: plain cards, a hollow dot
    const unrun = page.locator("#turn-0-reply .check-badge").first();
    await expect(unrun).toHaveAttribute("data-status", "");
    expect(await style(unrun, "borderTopColor")).toBe(await token(page, "--line"));
    expect(await style(unrun, "borderTopStyle")).toBe("solid");
    expect(await style(unrun.locator(".badge-dot"), "backgroundColor")).toBe("rgba(0, 0, 0, 0)");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText(/failed/);
    // Passed: green edge, fill and text, a filled dot
    const pass = page.locator("#turn-0-reply .check-badge[data-status='pass']").first();
    expect(await style(pass, "borderTopColor")).toBe(await token(page, "--ok-line"));
    expect(await style(pass, "backgroundColor")).toBe(await token(page, "--ok-soft"));
    expect(await style(pass, "color")).toBe(await token(page, "--ok"));
    expect(await style(pass.locator(".badge-dot"), "backgroundColor")).toBe(await token(page, "--ok"));
    expect(await style(pass, "height")).toBe("22px");
    // Failed: red
    const fail = page.locator("#turn-1-reply .check-badge[data-status='fail']").first();
    await expect(fail).toHaveText("contains refund");
    expect(await style(fail, "borderTopColor")).toBe(await token(page, "--bad-line"));
    expect(await style(fail, "backgroundColor")).toBe(await token(page, "--bad-soft"));
    expect(await style(fail.locator(".badge-dot"), "backgroundColor")).toBe(await token(page, "--danger"));
    // Several sit side by side, wrapping, a little apart
    const boxes = await page.locator("#turn-0-reply .check-badge").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    expect(boxes.length).toBeGreaterThan(1);
    expect(boxes[1].left).toBeGreaterThan(boxes[0].right);
    // Selected: its edge in its colour, doubled
    await fail.click();
    await expect(fail).toHaveAttribute("aria-pressed", "true");
    expect(await style(fail, "borderTopColor")).toBe(await token(page, "--danger"));
    expect(await style(fail, "boxShadow")).toContain("inset");
    // In the dark theme too
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await style(pass, "backgroundColor")).toBe(await token(page, "--ok-soft"));
  });

  test("a turn's checks are cards, coloured by how they went; a check's last result is one too", async ({ app: { page } }) => {
    await openApp(page);
    await runSmoke(page);
    await page.locator("#turn-0 .turn-head .label").click();
    const cards = page.locator("#turnChecks > .check-card");
    await expect(cards).toHaveCount(4);
    // Like the sidebar's palette cards: a bordered card, its kind as an icon and a label, then the check
    await page.click("#checksToggle");
    const [card, palette] = await Promise.all([
      cards.first().evaluate((el) => { const cs = getComputedStyle(el); return [cs.paddingTop, cs.paddingLeft, cs.borderTopWidth, cs.borderTopStyle]; }),
      page.locator("#palette-path").evaluate((el) => { const cs = getComputedStyle(el); return [cs.paddingTop, cs.paddingLeft, cs.borderTopWidth, cs.borderTopStyle]; }),
    ]);
    expect(card).toEqual(palette);
    await expect(cards.first().locator(".block-label svg")).toHaveCount(1);
    await expect(cards.first().locator(".block-label .label")).toHaveText("Status");
    await expect(cards.nth(1).locator(".block-label .label")).toHaveText("Path");
    await expect(cards.first().locator(".check-card-text")).toHaveText("status 200");
    // By status: passed, green (its edge, its label, its status)
    await expect(cards.first()).toHaveAttribute("data-status", "pass");
    await expect(page.locator("#turnCheck-0-status")).toHaveText("pass");
    const ok = await token(page, "--ok");
    expect(await cards.first().evaluate((el) => getComputedStyle(el).boxShadow)).toContain(ok);
    expect(await cards.first().locator(".block-label").evaluate((el) => getComputedStyle(el).color)).toBe(ok);
    // Failed, red
    await page.locator("#turn-1 .turn-head .label").click();
    await expect(page.locator("#turnCheck-0")).toHaveAttribute("data-status", "fail");
    expect(await page.locator("#turnCheck-0").evaluate((el) => getComputedStyle(el).boxShadow)).toContain(await token(page, "--danger"));
    await expect(page.locator("#turnCheck-0 .check-card-reason")).not.toBeEmpty();
    // A click on the card opens the check; its last result is the same card
    await page.locator("#turnCheck-0 .check-card-reason").click();
    await expect(page.locator("#panel .panel-head")).toContainText("Check");
    await expect(page.locator("#checkResult > .check-card")).toHaveAttribute("data-status", "fail");
    await expect(page.locator("#checkResultCard .list-del")).toHaveCount(0);
    await expect(page.locator("#checkResultCard-on")).toHaveCount(0);
  });

  test("a check is turned off and on from its card and from its panel: skipped when off, and the file as it was when on again", async ({ app: { page } }) => {
    await openApp(page);
    const original = await fileText(page, SUITE);
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click();
    await expect(turnButton(page, 1).locator("xpath=..").locator(".list-size")).toHaveText("4 checks");
    // Off, from its card (it shows at once, before the file's saved)
    await page.locator("#turnCheck-1-on").uncheck();
    await expect(page.locator("#turnCheck-1-on")).not.toBeChecked();
    await fileSays(page, (d) => d.tests[0].turns[0].expect[1].enabled === false);
    await expect(page.locator("#turnCheck-1")).toHaveAttribute("data-status", "off");
    await expect(page.locator("#turnCheck-1-status")).toHaveText("off");
    await expect(page.locator("#panel .field-head", { hasText: "Checks" })).toContainText("1 off");
    await expect(page.locator("#check-0-1")).toHaveAttribute("data-status", "off");
    await expect(turnButton(page, 1).locator("xpath=..").locator(".list-size")).toHaveText("3 checks");
    // Run: it's skipped, the others count
    await page.click("#testHeaderRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await expect(page.locator("#turnCheck-1")).toHaveAttribute("data-status", "off");
    await expect(page.locator("#turnCheck-0")).toHaveAttribute("data-status", "pass");
    await expect(turnButton(page, 1).locator("xpath=..").locator(".list-size")).toHaveText("3/3");
    await expect(page.locator("#turn-0 .turn-summary")).toContainText("3/3 checks");
    const recorded = await page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const runs = await done(db.transaction("runs").objectStore("runs").getAll());
      db.close();
      return runs.sort((a, b) => b.started - a.started)[0].turns[0].results[1];
    });
    expect([recorded.status, recorded.reason]).toEqual(["skipped", "turned off (enabled: false)"]);
    // On again, from the check's panel: the key goes, and the file is as it was
    await page.locator("#turnCheck-1-open").click();
    await expect(page.locator("#checkOn")).not.toBeChecked();
    await expect(page.locator("#checkResultCard")).toHaveAttribute("data-status", "off");
    await page.locator("#checkOn").check();
    await fileSays(page, (d) => d.tests[0].turns[0].expect[1].enabled === undefined);
    expect(await fileText(page, SUITE)).toBe(original);
    // The last run ran it turned off: on, it hasn't run as it is now
    await expect(page.locator("#checkNotRun")).toBeVisible();
    await expect(page.locator("#checkResultCard")).toHaveCount(0);
    await page.locator("#panelBack").click();
    await expect(page.locator("#turnCheck-1-on")).toBeChecked();
  });

  test("quick clicks on a check's on box: the last one is what's in the file", async ({ app: { page } }) => {
    await openApp(page);
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

  test("the sidebar's checks are grouped: response, metrics, thinking and tools, System One, LLM judges", async ({ app: { page } }) => {
    await openApp(page);
    await page.click("#checksToggle");
    expect(await page.locator(".palette-heading").allTextContents()).toEqual(["Response", "Metrics", "Thinking and tools", "System One", "LLM judges"]);
    const ids = async (group) => page.locator(`#palette-group-${group} .palette-item`).evaluateAll((els) => els.map((e) => e.id.replace("palette-", "")));
    expect(await ids("response")).toEqual(["path", "text", "status", "json"]);
    expect(await ids("metrics")).toEqual(["latency", "length", "tokens", "cost"]);
    expect(await ids("behaviour")).toEqual(["thinking", "tool-called", "tool-not-called", "tool-order", "sequence"]);
    expect(await ids("systemone")).toEqual(["system-one-noul", "system-one-choice", "system-one-score"]);
    expect(await ids("llm")).toEqual(["judge", "reference"]);
    await expect(page.locator("#palette-system-one-noul .label")).toHaveText("Noul");
    // A card adds its check to the selected turn; on the turn's card it's named in full
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-1 .turn-head .label").click();
    await page.click("#palette-system-one-noul");
    await fileSays(page, (d) => d.tests[0].turns[1].expect[1]?.type === "systemone.noul");
    await page.locator("#panelBack").click();
    await expect(page.locator("#turnCheck-1 .block-label .label")).toHaveText("System One · noul");
    await page.click("#palette-tool-not-called");
    await fileSays(page, (d) => d.tests[0].turns[1].expect[2]?.type === "tool.not_called");
  });
});

test.describe("a failed check's card", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).click();

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a failed check's card has a cross, not a tick; a test's tags field shows no example values", async ({ app: { page } }) => {
    await openApp(page);
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
});

// System One's request during a run (contracts/ui.md, Panel: Step, Check): the judge call's step and a
// System One check's panel show the request it sends, all of it, its key hidden; while it's being
// asked, and after.
test.describe("System One's request", () => {
  const KEY = "jev-test-key-123456";
  // A suite whose one turn has two System One checks, judged at `endpoint`
  const suite = (base, endpoint) => `version: 1
provider: providers/mock-json.yml
environments:
  local: { base_url: "${base}" }
judges:
  default: { kind: systemone, endpoint: "${endpoint}" }
tests:
  - name: judged
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
`;

  test.beforeEach(async ({ app: { page } }) => {
    await page.evaluate((key) => localStorage.setItem("eval.secrets", JSON.stringify({ "": { JEV_API_KEY: key } })), KEY);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("after a run: the judge call's step and each System One check show the request, all of it, the key hidden", async ({ app: { page, servers } }) => {
    await writeFile(page, "judged.hafen.yml", suite(servers.mock.url, "{{base_url}}/systemone"));
    await reopen(page);
    await page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: "judged" }).first().click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    // The check's panel
    await page.locator("#turn-0 .turn-head .label").click();
    await page.locator("#turnCheck-0-open").click();
    await expect(page.locator("#checkJudgeRequestLabel")).toHaveText("Request to System One");
    await expect(page.locator("#checkJudgeRequestUrl")).toHaveText(`POST ${servers.mock.url}/systemone/v1/systemone`);
    const body = JSON.parse(await page.locator("#checkJudgeRequest").textContent());
    expect(body.state).toBe("I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?");
    expect(body.model).toBe("jev-latest");
    expect(body.questions).toEqual({ c0: { type: "noul", instructions: "Does the reply ask why?" }, c1: { type: "choice", instructions: "What does it offer?", criteria: { refund: "refund", replacement: "replacement" } } });
    await expect(page.locator("#checkJudgeRequestHeaders")).toContainText("authorization");
    await expect(page.locator("#checkJudgeRequestHeaders")).toContainText("[redacted]");
    await expect(page.locator("#checkJudgeRequestAsking")).toHaveCount(0);
    // The other check, judged in the same request, shows the same
    await page.click("#panelBack");
    await page.locator("#turnCheck-1-open").click();
    expect(JSON.parse(await page.locator("#checkJudgeRequest").textContent())).toEqual(body);
    // Copied, all of it
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click("#checkJudgeRequestCopy");
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(body);
    // The judge call's step
    await page.locator(".timeline-bar[data-kind='judge_call']").first().click();
    await expect(page.locator("#panel .panel-head")).toContainText("Step");
    expect(JSON.parse(await page.locator("#stepJudgeRequest").textContent())).toEqual(body);
    // The key is nowhere on the page, nor in the run kept
    expect(await page.content()).not.toContain(KEY);
    const runs = await page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const all = await done(db.transaction("runs").objectStore("runs").getAll());
      db.close();
      return JSON.stringify(all);
    });
    expect(runs).not.toContain(KEY);
    expect(runs).toContain('"questions"');
  });

  test("during a run: the request shows as it's asked (asking…), on the check's panel and the call's step", async ({ app: { page, servers } }) => {
    // A judge that takes 2 s to answer (the mock's slow reply: not System One's, so it errors after)
    await writeFile(page, "judged.hafen.yml", suite(servers.mock.url, "{{base_url}}/slow?ms=2000&to="));
    await reopen(page);
    await page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: "judged" }).first().click();
    await page.click("#testRun");
    await page.locator("#turn-0 .turn-head .label").click();
    await page.locator("#turnCheck-0-open").click();
    await expect(page.locator("#checkJudgeRequestAsking")).toBeVisible();
    await expect(page.locator("#checkNotRun")).toHaveText("Judging…");
    const body = JSON.parse(await page.locator("#checkJudgeRequest").textContent());
    expect(body.questions.c0).toEqual({ type: "noul", instructions: "Does the reply ask why?" });
    expect(body.state).toContain("4417");
    // The call's step, still going
    await page.locator(".timeline-bar[data-kind='judge_call']").first().click();
    await expect(page.locator("#stepJudgeRequestAsking")).toBeVisible();
    // Then it's done (System One's answer wasn't one here): the request stays, no longer being asked
    await expect(page.locator("#status")).toContainText(/failed|error/, { timeout: 8000 });
    await expect(page.locator("#stepJudgeRequestAsking")).toHaveCount(0);
    await expect(page.locator("#stepJudgeRequest")).toBeVisible();
  });
});
