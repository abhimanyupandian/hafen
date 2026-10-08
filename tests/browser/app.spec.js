// The app end to end in a browser (spec US1–US3, US5; quickstart §1–§3, §5): its suites (kept in its
// workspace), run a test through the relay, add a check by clicking the response, explore a streaming
// endpoint, and follow the timeline. The engine runs in the page's Web Worker, as in the browser build.

import { expect, fileText, test } from "./fixtures.js";

// Settings → Providers, where the providers are
async function openProviders(page) {
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await expect(page.locator("#settingsTitle")).toHaveText("Providers");
}

test("runs a test and shows each check's result under each reply", async ({ app: { page, errors } }) => {
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
  await expect(page.locator(".check-badge[data-status='']").first()).toBeVisible();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator("#turn-0-reply .check-badge[data-status='pass']")).toHaveCount(4);
  await expect(page.locator("#turn-1-reply .check-badge[data-status='fail']")).toHaveText("contains refund");
  await expect(page.locator("#runList")).toContainText("failed");
  await expect(page.locator("#testFacts")).toContainText("4/5");
  expect(errors).toEqual([]);
});

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

test("the theme switches to dark from Settings", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-appearance");
  await page.click("#themeDark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.click("#themeLight");
});

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

test("deletes a provider in Settings and a suite from its panel, in the workspace", async ({ app: { page } }) => {
  const exists = (path) => page.evaluate(async (path) => {
    const parts = path.split("/");
    let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      await dir.getFileHandle(parts.at(-1));
      return true;
    } catch {
      return false;
    }
  }, path);
  await expect(page.locator("#providersSection")).toHaveCount(0);
  await openProviders(page);
  const row = page.locator("#provider-mock-sse");
  await page.click("#provider-mock-sse-delete");
  await expect(page.locator("#provider-mock-sse-delete")).toHaveText("delete file?");
  await page.click("#provider-mock-sse-delete");
  await expect(row).toHaveCount(0);
  expect(await exists("providers/mock-sse.yml")).toBe(false);
  expect(await exists("providers/mock-json.yml")).toBe(true);
  await page.click("#settingsClose");

  await page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"] .list-open').click();
  await page.click("#suiteDelete");
  await expect(page.locator("#suiteDelete")).toHaveText("delete this file?");
  await page.click("#suiteDelete");
  await expect(page.locator("#suitesEmpty")).toBeVisible();
  expect(await exists("smoke.hafen.yml")).toBe(false);
  await expect(page.locator("#panel .panel-head")).toContainText("Conversation");
});

test("renames a provider in Settings: the file is renamed, and the suite that uses it follows", async ({ app: { page } }) => {
  await openProviders(page);
  await page.click("#provider-mock-json-open");
  await expect(page.locator("#providerReload")).toHaveCount(0);
  await expect(page.locator("#providerName")).toHaveValue("mock-json");
  await page.fill("#providerName", "shop");
  await page.press("#providerName", "Enter");
  await expect(page.locator("#providerFacts")).toContainText("providers/shop.yml");
  expect(await fileText(page, "smoke.hafen.yml")).toContain("provider: providers/shop.yml");
  await expect(page.locator("#suiteList")).not.toContainText("problem");
  // A name that's taken is refused, and put back
  await page.fill("#providerName", "mock-sse");
  await page.press("#providerName", "Enter");
  await expect(page.locator(".toast")).toContainText("already exists");
  await expect(page.locator("#providerName")).toHaveValue("shop");
  await page.click("#providersBack");
  await expect(page.locator("#provider-shop")).toBeVisible();
  await expect(page.locator("#provider-mock-json")).toHaveCount(0);
});

test("Secrets keeps any number of values under names of your own", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-secrets");
  for (const name of ["SHOP_TOKEN", "search_key"]) {
    await page.fill("#secretName", name);
    await page.fill("#secretValue", "s3cret");
    await page.press("#secretValue", "Enter");
    await expect(page.locator(`#secret-${name} .vars-use`)).toHaveText(`{{secret.${name}}} · not used by the open files`);
    await expect(page.locator("#secretName")).toHaveValue("");
  }
  await expect(page.locator("#secretsList .vars-row:not(.vars-add)")).toHaveCount(2);
  await page.fill("#secretName", "2FA");
  await page.fill("#secretValue", "x");
  await page.press("#secretValue", "Enter");
  await expect(page.locator("#secretsError")).toContainText("not starting with a digit");
  // (forgetting asks first)
  await page.click("#secret-SHOP_TOKEN-forget");
  await expect(page.locator("#secret-SHOP_TOKEN")).toHaveCount(1);
  await page.click("#secret-SHOP_TOKEN-forget");
  await expect(page.locator("#secret-SHOP_TOKEN")).toHaveCount(0);
});

test("with no steps, the timeline's note sits in the middle of the dock, which is as tall as it", async ({ app: { page } }) => {
  const note = page.locator("#timelineEmpty");
  await expect(note).toBeVisible();
  const [body, box] = [await page.locator("#timelineBody").boundingBox(), await note.boundingBox()];
  expect(Math.abs(box.x - body.x)).toBeLessThan(1);
  expect(Math.abs(box.width - body.width)).toBeLessThan(1);
  expect(Math.abs(box.height - body.height)).toBeLessThan(1);
  expect(await note.evaluate((el) => { const cs = getComputedStyle(el); return [cs.textAlign, cs.paddingTop === cs.paddingBottom]; })).toEqual(["center", true]);
});

test("a new provider in Settings lists every kind; Ollama starts as a working file, chosen for the conversation", async ({ app: { page } }) => {
  await openProviders(page);
  await page.click("#newProvider");
  await expect(page.locator("#newProviderForm")).toBeVisible();
  const kinds = await page.locator("#newProviderKind option").allTextContents();
  expect(kinds).toEqual(["Ollama", "OpenAI chat completions", "OpenAI responses", "Anthropic messages", "Gemini", "HTTP endpoint · one JSON reply", "HTTP endpoint · streamed (SSE)", "HTTP endpoint · streamed (JSON lines)", "WebSocket", "A2A agent"]);
  await expect(page.locator("#newProviderName")).toHaveValue("ollama");
  await expect(page.locator("#newProviderModel")).toHaveAttribute("placeholder", "gemma4");
  await page.selectOption("#newProviderKind", "anthropic-messages");
  await expect(page.locator("#newProviderName")).toHaveValue("anthropic");
  await expect(page.locator("#newProviderAbout")).toContainText("Messages API");
  await page.selectOption("#newProviderKind", "ollama");
  await page.fill("#newProviderModel", "qwen3:0.6b");
  await page.click("#newProviderCreate");
  await expect(page.locator("#providerName")).toHaveValue("ollama");
  await expect(page.locator("#providerFacts")).toContainText("ollama");
  await expect(page.locator("#convProvider")).toHaveValue("providers/ollama.yml");
  const text = await fileText(page, "providers/ollama.yml");
  expect(text).toContain("kind: ollama\nmodel: qwen3:0.6b\n");
  await page.click("#providersBack");
  await expect(page.locator("#provider-ollama")).toContainText("in use");
  // The same name again is refused; the next one is offered as ollama-2
  await page.click("#newProvider");
  await expect(page.locator("#newProviderName")).toHaveValue("ollama-2");
  await page.fill("#newProviderName", "ollama");
  await page.click("#newProviderCreate");
  await expect(page.locator("#newProviderError")).toContainText("already exists");
});

test("the timeline scrolls without scrollbars", async ({ app: { page } }) => {
  const chart = page.locator(".timeline-chart");
  expect(await chart.evaluate((el) => [getComputedStyle(el).scrollbarWidth, el.offsetWidth - el.clientWidth])).toEqual(["none", 0]);
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

test("the top bar has no provider in it; the test panel's Provider opens it in Settings", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await expect(page.locator("#topbar .badge")).toHaveCount(0);
  await expect(page.locator("#currentProvider")).toHaveCount(0);
  await page.click("#testProviderManage");
  await expect(page.locator("#settingsTitle")).toHaveText("Providers");
});

test("Connection → System One keeps JEV_API_KEY, for every environment", async ({ app: { page } }) => {
  await page.click("#openSettings");
  const tabs = await page.locator("[aria-label=Connection] .settings-tab").allTextContents();
  expect(tabs).toEqual(["Providers", "System One", "Relay"]);
  expect(await page.locator("[aria-label=Configurations] .settings-tab").allTextContents()).toEqual(["Environments", "Secrets", "Plugins"]);
  await page.click("#settings-tab-systemone");
  await expect(page.locator("#systemoneKeyState")).toHaveText("not set");
  await page.fill("#systemoneKey", "jev-test-key");
  await page.click("#systemoneSave");
  await expect(page.locator("#systemoneKeyState")).toHaveText("set");
  await expect(page.locator("#systemoneKey")).toHaveValue("");
  // It's kept for every environment, and Secrets leaves it to this pane
  await page.click("#settings-tab-secrets");
  await expect(page.locator("#secretName")).toBeVisible();
  await expect(page.locator("#secret-JEV_API_KEY")).toHaveCount(0);
  await page.fill("#secretName", "JEV_API_KEY");
  await page.fill("#secretValue", "x");
  await page.press("#secretValue", "Enter");
  await expect(page.locator("#secretsError")).toContainText("System One");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("eval.secrets"))[""].JEV_API_KEY)).toBe("jev-test-key");
  await page.click("#settings-tab-systemone");
  // (forgetting asks first)
  await page.click("#systemoneForget");
  await expect(page.locator("#systemoneKeyState")).toHaveText("set");
  await page.click("#systemoneForget");
  await expect(page.locator("#systemoneKeyState")).toHaveText("not set");
});

test("the Suites section shows no folder path", async ({ app: { page } }) => {
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  await expect(page.locator("#suitesFolder")).toHaveCount(0);
});

test("collapsed, the sidebar shows its sections as icons; one opens it on that section", async ({ app: { page } }) => {
  await expect(page.locator("#navRail")).toBeHidden();
  await page.click("#collapseNav");
  await expect(page.locator("#navBody")).toBeHidden();
  await expect(page.locator("#navRail button")).toHaveCount(4);
  expect(await page.locator("#navRail button").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label")))).toEqual(["Conversations", "Suites", "Checks", "Runs"]);
  await expect(page.locator("#rail-checks")).toBeVisible();
  await page.click("#rail-checks");
  await expect(page.locator("#navBody")).toBeVisible();
  await expect(page.locator("#navRail")).toBeHidden();
  await expect(page.locator("#checksToggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#checksToggle")).toBeFocused();
});

test("+ adds a new suite each time; a suite's own + adds a test to it", async ({ app: { page } }) => {
  await page.click("#newSuite");
  await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
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
