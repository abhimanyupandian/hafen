// More of the app's flows, end to end: no label over a reply anywhere; conversations listed with a line
// between them; a turn with no checks in the unsure colour (yellow) wherever it's listed; the
// response's JSON as JSON has it (a key with no value isn't there).

import { parse } from "yaml";
import { expect, fileText, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openFolder = async (page) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
const turnButton = (page, n, text = "") => page.locator(`#suiteList .list-open[aria-label^="turn ${n}: ${text}"]`).first();
const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);
const colour = (locator) => locator.evaluate((el) => getComputedStyle(el).color);
async function send(page, text) {
  const before = await page.locator("#thread .turn-group").count();
  await page.fill("#input", text);
  await page.click("#send");
  await expect(page.locator("#thread .turn-group")).toHaveCount(before + 1);
  await expect(page.locator("#send")).toHaveText(/send/i);
}

test.beforeEach(async ({ app: { page } }) => {
  await openFolder(page);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("a reply has no label over it: in a conversation, a test, and an open run", async ({ app: { page } }) => {
  const noLabel = async () => {
    for (const reply of await page.locator("#thread article.msg.bot").all()) {
      await expect(reply.locator(":scope > .label")).toHaveCount(0);
      expect((await reply.innerText()).split("\n")[0]).not.toMatch(/^(reply|mock-json|mock-sse)$/i);
    }
  };
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await send(page, "hello");
  await noLabel();
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  expect(await page.locator("#thread article.msg.bot").count()).toBe(2);
  await noLabel();
  await page.locator("#runList .list-open").first().click();
  await expect(page.locator("#evalTitle")).toHaveText(/· run$/);
  await noLabel();
});

test("conversations are listed with a line between them (none above the first)", async ({ app: { page } }) => {
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await send(page, "first");
  await page.click("#newConversation");
  await send(page, "second");
  await page.click("#newConversation");
  await send(page, "third");
  const rows = page.locator("#conversationList > .list-row");
  await expect(rows).toHaveCount(3);
  const line = await token(page, "--line");
  const tops = await rows.evaluateAll((els) => els.map((el) => { const cs = getComputedStyle(el); return [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor]; }));
  expect(tops[0][0]).toBe("0px");
  for (const top of tops.slice(1)) expect(top).toEqual(["1px", "solid", line]);
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

test("a conversation's turns have no checks to have: not yellow", async ({ app: { page } }) => {
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await send(page, "hello");
  await expect(page.locator("#turn-0 .turn-summary")).not.toHaveAttribute("data-status", "unchecked");
  await expect(page.locator("#turn-0 .turn-summary")).not.toContainText("0 checks");
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

const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
// A provider that takes `ms` to answer, and a suite of one test on it (read when the folder's opened again)
async function slowSuite(page, servers, ms = 2500) {
  await writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(page, "slow.hafen.yml", `version: 1\nname: Slow\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns:\n      - user: wait for it\n        expect:\n          - { type: status, equals: 200 }\n`);
  await page.click("#openFolder");
  await expect(page.locator('#suiteList .list-row[data-file="slow.hafen.yml"]')).toHaveCount(1);
}
const confirmDelete = async (row) => { await row.hover(); await row.locator(".list-del").first().click(); await row.locator(".list-del").first().click(); };

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

test("the open conversation deleted while it sends: it's gone, and its reply doesn't bring it back", async ({ app: { page, servers } }) => {
  await writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await page.click("#openFolder");
  await page.click("#newConversation");
  await page.selectOption("#convProvider", "providers/mock-slow.yml");
  await send(page, "slow hello");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(1);
  await page.fill("#input", "second slow");
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/stop/i);
  await confirmDelete(page.locator("#conversationList .list-row").first());
  await expect(page.locator("#conversationList .list-row")).toHaveCount(0);
  await page.waitForTimeout(2000);
  await expect(page.locator("#conversationList .list-row")).toHaveCount(0);
  await expect(page.locator("#thread .turn-group")).toHaveCount(0);
  await expect(page.locator("#evalTitle")).toHaveText("New conversation");
});
