// Conversations (contracts/ui.md, Conversations): every conversation kept, listed, opened again and
// carried on with its history, renamed, deleted; turns deleted from the chat itself (a
// conversation's and a test's); and no provider in the top bar.

import { parse } from "yaml";
import { expect, fileText, test } from "./fixtures.js";

// mock-json, sending the earlier turns as {{history}} (the mock logs what it gets)
const ECHO = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}", history: "{{history}}" }
response:
  text: $.data.reply
`;
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const w = await (await dir.getFileHandle(parts.at(-1))).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
// What's kept: the conversations in the app's database
const kept = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open("hafen");
  req.onsuccess = () => {
    const get = req.result.transaction("conversations").objectStore("conversations").getAll();
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => reject(get.error);
  };
  req.onerror = () => reject(req.error);
}));
const lastBody = async (servers) => (await (await fetch(`${servers.mock.url}/_log`)).json()).at(-1).body;
async function send(page, text) {
  await page.fill("#input", text);
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/send/i);
}

test.beforeEach(async ({ app: { page } }) => {
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  await writeFile(page, "providers/mock-json.yml", ECHO);
  await page.selectOption("#convProvider", "providers/mock-json.yml");
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("every conversation is kept under Conversations, and carries on, with its history, when opened again", async ({ app: { page, servers } }) => {
  await expect(page.locator("#conversationsEmpty")).toBeVisible();
  await send(page, "my name is ronaldo");
  await send(page, "hello");
  const rows = page.locator("#conversationList .list-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("my name is ronaldo");
  await expect(rows.first()).toContainText("mock-json");
  await expect(rows.first()).toContainText("2 turns");
  await expect(page.locator("#evalTitle")).toHaveText("my name is ronaldo");
  // A new one
  await page.click("#newConversation");
  await expect(page.locator("#threadEmpty")).toBeVisible();
  await send(page, "a second conversation");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("a second conversation");
  // The first again: as it was, then carried on with its turns as history
  await page.locator("#conversationList .list-open", { hasText: "my name is ronaldo" }).click();
  await expect(page.locator("#thread .turn-group")).toHaveCount(2);
  await expect(page.locator("#turn-0-user")).toContainText("my name is ronaldo");
  await send(page, "what is my name?");
  expect(await lastBody(servers)).toEqual({
    message: "what is my name?",
    history: [{ query: "my name is ronaldo", response: "You said: my name is ronaldo" }, { query: "hello", response: "You said: hello" }],
  });
  await expect(page.locator("#thread .turn-group")).toHaveCount(3);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("3 turns");
  // Its steps: the earlier turns' and the new one's
  await expect(page.locator(".timeline-bar[data-kind='turn']")).toHaveCount(3);
  // Kept across a reload
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await expect(page.locator("#conversationList .list-row")).toHaveCount(2);
  const all = await kept(page);
  expect(all.map((c) => c.run.turns.length).sort()).toEqual([1, 3]);
});

test("a conversation is renamed, and deleted from its panel and from the list", async ({ app: { page } }) => {
  await send(page, "first one");
  await page.fill("#convTitle", "Ronaldo's name");
  await page.press("#convTitle", "Enter");
  await expect(page.locator("#conversationList .list-row").first()).toContainText("Ronaldo's name");
  await expect(page.locator("#evalTitle")).toHaveText("Ronaldo's name");
  expect((await kept(page))[0].title).toBe("Ronaldo's name");
  await page.click("#convDelete");
  await page.click("#convDelete");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(0);
  await expect(page.locator("#threadEmpty")).toBeVisible();
  expect(await kept(page)).toEqual([]);
  // From the list
  await send(page, "second one");
  const row = page.locator("#conversationList .list-row").first();
  await row.hover();
  await row.locator(".list-del").click();
  await row.locator(".list-del").click();
  await expect(page.locator("#conversationList .list-row")).toHaveCount(0);
  expect(await kept(page)).toEqual([]);
});

test("a conversation's turn deleted from the chat: the others move up, and the next message goes without it", async ({ app: { page, servers } }) => {
  await send(page, "one");
  await send(page, "two");
  await send(page, "three");
  await page.locator("#turn-1").hover();
  await page.click("#turn-1-delete");
  await expect(page.locator("#turn-1-delete")).toHaveText("delete");
  await page.click("#turn-1-delete");
  await expect(page.locator("#thread .turn-group")).toHaveCount(2);
  await expect(page.locator("#turn-1-user")).toContainText("three");
  await expect(page.locator("#turn-1 .turn-head .label")).toHaveText("turn 2");
  await expect(page.locator(".timeline-bar[data-kind='turn']")).toHaveCount(2);
  await expect(page.locator("#convFacts")).toContainText("2");
  await expect.poll(async () => (await kept(page))[0].run.turns.map((t) => t.user).join("|")).toBe("one|three");
  await send(page, "four");
  expect((await lastBody(servers)).history.map((h) => h.query)).toEqual(["one", "three"]);
  // Saved as a test, from what it has now
  await page.fill("#saveName", "without two");
  await page.click("#saveTest");
  await expect.poll(async () => parse(await fileText(page, "tests.hafen.yml")).tests[0].turns.map((t) => t.user).join("|")).toBe("one|three|four");
});

test("a conversation opened again saves as a test before anything's sent", async ({ app: { page } }) => {
  await send(page, "kept one");
  await page.click("#newConversation");
  await page.locator("#conversationList .list-open", { hasText: "kept one" }).click();
  await page.fill("#saveName", "from a kept conversation");
  await page.click("#saveTest");
  await expect.poll(async () => parse(await fileText(page, "tests.hafen.yml")).tests[0].turns[0].user).toBe("kept one");
});

test("a test's turn deleted from the chat", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await page.locator("#turn-0").hover();
  await page.click("#turn-0-delete");
  await page.click("#turn-0-delete");
  await expect.poll(async () => parse(await fileText(page, "smoke.hafen.yml")).tests[0].turns.map((t) => t.user).join("|")).toBe("It arrived broken");
  await expect(page.locator("#thread .turn-group")).toHaveCount(1);
  await expect(page.locator("#turn-0-user")).toContainText("It arrived broken");
  expect(await fileText(page, "smoke.hafen.yml")).toContain("# fails by design");
});

test("Settings → Storage → Conversations lists them, and clears them", async ({ app: { page } }) => {
  await send(page, "one kept");
  await page.click("#openSettings");
  await page.click("#settings-tab-conversations");
  await expect(page.locator("#settings-conversations-list .settings-row")).toHaveCount(1);
  await expect(page.locator("#settings-conversations-list")).toContainText("one kept");
  await page.click("#settings-conversations-clear");
  await page.click("#settings-conversations-clear");
  await expect(page.locator("#settingsEmpty")).toBeVisible();
  await page.click("#settingsClose");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(0);
});
