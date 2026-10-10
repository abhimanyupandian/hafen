// Conversations: kept, listed, opened again and carried on with their history, renamed and deleted; the
// message box; replies (Markdown, no label over them, their stats, errors, cut short) and the thread's
// scrolling; a conversation's provider while it sends; saved as a test.

import { parse } from "yaml";
import { expect, fileText, reopen, test, token, writeFile } from "./fixtures.js";

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

test("explores a streaming endpoint: thinking, tool calls and the answer, in order, with a timeline", async ({ app: { page, errors } }) => {
  await openProviders(page);
  await page.click("#provider-mock-sse-open");
  await page.click("#providerTry");
  await expect(page.locator("#settingsModal")).toHaveCount(0);
  await page.fill("#input", "I want a refund");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("Could you tell me why");
  await expect(page.locator("#turn-0-reply .msg-thinking summary")).toContainText("thinking · full");
  await expect(page.locator("#turn-0-tool-0")).toContainText("lookup_order");
  await expect(page.locator("#turn-0-reply .msg-stats")).toContainText("to first token");
  const bars = page.locator(".timeline-bar");
  await expect(bars).toHaveCount(6);
  await page.locator(".timeline-bar[data-kind='tool_call']").click();
  await expect(page.locator("#panel .panel-head")).toContainText("Step · tool call");
  await expect(page.locator("#stepArgs")).toContainText("4417");
  expect(errors).toEqual([]);
});

test.describe("kept, opened again, renamed and deleted", () => {
  // mock-json, sending the earlier turns as {{history}} (the mock logs what it gets)
  const ECHO = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}", history: "{{history}}" }
response:
  text: $.data.reply
`;

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
});

test.describe("listed, replied to, saved as a test, and deleted while it sends", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
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

  test("a conversation's turns have no checks to have: not yellow", async ({ app: { page } }) => {
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    await send(page, "hello");
    await expect(page.locator("#turn-0 .turn-summary")).not.toHaveAttribute("data-status", "unchecked");
    await expect(page.locator("#turn-0 .turn-summary")).not.toContainText("0 checks");
  });

  test("replies are Markdown (safe: no raw HTML, no script links); only a long code block or table scrolls; a reply is copied raw", async ({ app: { page } }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    const long = "x".repeat(400);
    const message = `**bold** and \`code\`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| ${long} | 2 |\n\n\`\`\`\n${long}\n\`\`\`\n\n<img src=x onerror="window.hacked=1"> [bad](javascript:alert(1)) [good](https://example.com)`;
    await page.fill("#input", message);
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
    const reply = page.locator("#turn-0-reply .msg-body.md");
    await expect(reply.locator("strong")).toHaveText("bold");
    await expect(reply.locator("code").first()).toHaveText("code");
    await expect(reply.locator("li")).toHaveCount(2);
    await expect(reply.locator("table")).toHaveCount(1);
    await expect(reply.locator("pre")).toHaveCount(1);
    await expect(reply.locator("img")).toHaveCount(0);
    await expect(reply).toContainText('<img src=x onerror="window.hacked=1">');
    expect(await page.evaluate(() => window.hacked)).toBeUndefined();
    await expect(reply.locator("a")).toHaveCount(1);
    await expect(reply.locator("a")).toHaveAttribute("href", "https://example.com");
    await expect(reply.locator("a")).toHaveAttribute("rel", "noreferrer noopener");
    // The message doesn't scroll sideways; its code block and table do, on their own
    expect(await reply.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator("#thread").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await reply.locator("pre").evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === "auto")).toBe(true);
    expect(await reply.locator("table").evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === "auto")).toBe(true);
    // Copy: the reply as it came
    await page.locator("#turn-0").hover();
    await page.click("#turn-0-copy");
    await expect(page.locator("#turn-0-copy")).toHaveText("copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`You said: ${message}`);
    // On the selected turn (--soft), code and table heads still stand out from it
    await page.locator("#turn-0 .turn-head .label").click();
    await expect(page.locator("#turn-0")).toHaveClass(/selected/);
    const [group, code, pre, th] = await page.locator("#turn-0").evaluate((g) => [g, g.querySelector(".md p code"), g.querySelector(".md pre"), g.querySelector(".md th")].map((el) => getComputedStyle(el).backgroundColor));
    for (const bg of [code, pre, th]) {
      expect(bg).not.toBe(group);
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    }
  });

  test("the message box: Shift+Enter adds a line, Enter sends it as typed (its lines kept)", async ({ app: { page, servers } }) => {
    await page.evaluate(async (url) => {
      const dir = await (await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }))).getDirectoryHandle("providers", { create: true });
      const w = await (await dir.getFileHandle("plain.yml", { create: true })).createWritable();
      await w.write(`kind: http\nurl: "${url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
      await w.close();
    }, servers.mock.url);
    await reopen(page);
    await page.selectOption("#convProvider", "providers/plain.yml");
    await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
    await page.locator("#input").pressSequentially("first line");
    await page.locator("#input").press("Shift+Enter");
    await page.locator("#input").pressSequentially("second line");
    await expect(page.locator("#input")).toHaveValue("first line\nsecond line");
    expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
    await page.locator("#input").press("Enter");
    await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: first line");
    await expect(page.locator("#input")).toHaveValue("");
    expect((await (await fetch(`${servers.mock.url}/_log`)).json()).map((x) => x.body.message)).toEqual(["first line\nsecond line"]);
  });

  test("the open conversation deleted while it sends: it's gone, and its reply doesn't bring it back", async ({ app: { page, servers } }) => {
    await writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
    await reopen(page);
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
});

test.describe("its provider, the message box, and the replies", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  const slowProvider = (page, ms) => writeFile(page, "providers/mock-slow.yml", `kind: http\nurl: "{{base_url}}/slow?ms=${ms}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  async function runSmoke(page) {
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
  }
  const provider = (url, more = "") => `kind: http\nurl: "${url}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n${more}`;

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("while a message is on its way the conversation's provider can't be changed; after, it can, and nothing's stuck", async ({ app: { page } }) => {
    await slowProvider(page, 1500);
    await openApp(page);
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
    await openApp(page);
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

  test("a conversation's step (a tool call) picked: its turn stays marked", async ({ app: { page } }) => {
    await openApp(page);
    await page.selectOption("#convProvider", "providers/mock-sse.yml");
    await page.fill("#input", "hi");
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
    await page.click("#turn-0-tool-0");
    await expect(page.locator("#panel .panel-head")).toContainText("Step");
    await expect(page.locator("#turn-0")).toHaveClass(/selected/);
  });

  test("the message box, hidden (a suite's view) and shown again, is empty: Send off, no old field problem", async ({ app: { page } }) => {
    await openApp(page);
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

  test("sending a message (or adding a turn) goes to the bottom of the thread, wherever it was", async ({ app: { page } }) => {
    await openApp(page);
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    for (const n of [1, 2]) {
      await page.fill("#input", `${long}\nmessage ${n}`);
      await page.click("#send");
      await expect(page.locator(`#turn-${n - 1}-reply .msg-body`)).toContainText("You said");
    }
    const scroller = page.locator("#scroller");
    const atBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2);
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight * 1.5)).toBe(true);
    // Scrolled up, it stays there (until a message is sent)
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(200);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await page.fill("#input", "and one more");
    await page.click("#send");
    await expect(page.locator("#turn-2-reply .msg-body")).toContainText("You said: and one more");
    await expect.poll(atBottom).toBe(true);
    // With a test open, adding a turn goes there too
    await openTest(page, "refund for a broken item");
    await page.fill("#input", `${long}\nanother turn`);
    await page.click("#send");
    await fileSays(page, (d) => d.tests[0].turns.length === 3);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(200);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await page.fill("#input", `${long}\na new turn`);
    await page.click("#send");
    await fileSays(page, (d) => d.tests[0].turns.length === 4);
    await expect.poll(atBottom).toBe(true);
  });

  test("a reply has no provider label: its stats and its copy button go under it", async ({ app: { page } }) => {
    await openApp(page);
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    await page.fill("#input", "hello");
    await page.click("#send");
    await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: hello");
    await expect(page.locator("#turn-0-reply > .label")).toHaveCount(0);
    await expect(page.locator("#turn-0-reply")).not.toContainText("mock-json");
    await expect(page.locator("#turn-0-reply .msg-foot .msg-stats")).toBeVisible();
    await expect(page.locator("#turn-0-reply .msg-foot #turn-0-copy")).toHaveCount(1);
    // (A test's reply too)
    await runSmoke(page);
    await expect(page.locator("#turn-0-reply > .label")).toHaveCount(0);
    await expect(page.locator("#turn-0-reply")).not.toContainText("mock-json");
  });

  test("an error turn says the error, with what came back under it (show the response)", async ({ app: { page } }) => {
    await writeFile(page, "providers/mock-err.yml", 'kind: http\nurl: "{{base_url}}/error/500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n');
    await openApp(page);
    await page.selectOption("#convProvider", "providers/mock-err.yml");
    await page.fill("#input", "hi");
    await page.click("#send");
    await expect(page.locator("#turn-0-reply .msg-body.error")).toBeVisible();
    const shown = page.locator("#turn-0-reply details.msg-response");
    await expect(shown.locator("summary")).toHaveText("show the response");
    await shown.locator("summary").click();
    await expect(shown.locator("pre")).toContainText("the mock is having a bad day");
  });

  test("a stream cut short shows what came, marked so; a turn that failed before any text has no time to first token", async ({ app: { page, servers } }) => {
    await writeFile(page, "providers/cut.yml", `kind: http\nurl: "${servers.mock.url}/cut"\nbody: { message: "{{user}}" }\nstream: sse\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n`);
    await writeFile(page, "providers/err500.yml", provider(`${servers.mock.url}/error/500`));
    await openApp(page);
    await page.selectOption("#convProvider", "providers/cut.yml");
    await page.fill("#input", "tell me a story");
    await page.click("#send");
    await expect(page.locator("#turn-0-cut")).toContainText("cut short:");
    await expect(page.locator("#turn-0-partial")).toContainText("This reply is");
    await expect(page.locator("#turn-0-partial")).toBeVisible();
    await page.selectOption("#convProvider", "providers/err500.yml");
    await page.fill("#input", "hello");
    await page.click("#send");
    await expect(page.locator("#turn-1-reply .msg-body.error")).toBeVisible();
    await expect(page.locator("#turn-1-reply")).not.toContainText("to first token");
  });
});

test.describe("the message box, with a test open too", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: name }).first().click();

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("the message box has no large-editor button", async ({ app: { page } }) => {
    await openApp(page);
    await expect(page.locator("#input")).toBeVisible();
    await expect(page.locator("#inputMax")).toHaveCount(0);
    await expect(page.locator(".composer .btn-max")).toHaveCount(0);
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#input")).toBeVisible();
    await expect(page.locator(".composer .btn-max")).toHaveCount(0);
  });
});
