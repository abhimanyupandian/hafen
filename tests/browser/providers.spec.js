// Providers, in Settings → Providers: a new one of each kind, renamed (the suites that use it
// following), changed as YAML (refused while it doesn't parse), its fixtures and YAML as sections that
// open and close, its kind, deleted.

import { parse } from "yaml";
import { expect, fileText, openYaml, reopen, test, writeFiles } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";

test.describe("new, and renamed", () => {
  // Settings → Providers, where the providers are
  async function openProviders(page) {
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await expect(page.locator("#settingsTitle")).toHaveText("Providers");
  }

  test("a new provider in Settings lists every kind; Ollama starts as a working file, chosen for the conversation", async ({ app: { page } }) => {
    await openProviders(page);
    await page.click("#newProvider");
    await expect(page.locator("#newProviderForm")).toBeVisible();
    const kinds = await page.locator("#newProviderKind option").allTextContents();
    expect(kinds).toEqual(["Ollama", "OpenAI chat completions", "OpenAI responses", "Anthropic messages", "Gemini", "HTTP endpoint · one JSON reply", "HTTP endpoint · streamed (SSE)", "HTTP endpoint · streamed (JSON lines)"]);
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
});

test.describe("changed as YAML, renamed and deleted", () => {
  // Wait until the file says what `check` wants (it's written through the engine, a moment later)
  const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  const confirmDelete = async (locator) => { await locator.click(); await locator.click(); };

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
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
});

test.describe("its YAML and fixtures as sections, and its kind", () => {
  const openApp = async (page) => {
    await reopen(page);
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  };

  const openProviders = async (page) => {
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await page.locator("#providerList").waitFor();
  };
  const openProvider = async (page, name) => {
    if (!(await page.locator("#providerList").isVisible())) await page.click("#providersBack");
    await page.click(`#provider-${name}-open`);
    await expect(page.locator("#providerName")).toHaveValue(name);
  };
  const expanded = (page, name) => page.locator(`#${name}Toggle`).getAttribute("aria-expanded");
  const lineCount = (text) => text.replace(/\n$/, "").split("\n").length;

  const LOGIN = `export default { kind: "fixture", name: "acme-login", version: "1.0.0", provides: ["ACME_TOKEN"], async run() { return { ACME_TOKEN: "t" }; } };\n`;
  const RESET = `export default { kind: "fixture", name: "reset-cart", version: "1.0.0", async run() {} };\n`;
  const acme = (url) => `kind: http
url: "${url}/json"
body: { message: "{{user}}" }
response: { text: $.data.reply }
fixtures:
  beforeAll: [acme-login]
  before: [reset-cart]
`;

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a provider's fixtures and YAML are sections: Fixtures open when it has some, YAML closed, each saying what's in it while closed; remembered for every provider, across Settings and a reload", async ({ app: { page, servers } }) => {
    await writeFiles(page, { "plugins/acme-login.js": LOGIN, "plugins/reset-cart.js": RESET, "providers/acme.yml": acme(servers.mock.url) });
    await reopen(page);
    await openProviders(page);
    // A provider with no fixtures: both closed, each head saying what's in it
    await openProvider(page, "mock-json");
    expect(await expanded(page, "providerFixtures")).toBe("false");
    expect(await expanded(page, "providerYaml")).toBe("false");
    await expect(page.locator("#providerFixturesLabel")).toHaveText("Fixtures");
    await expect(page.locator("#providerFixturesSummary")).toHaveText("none yet");
    const yaml = await fileText(page, "providers/mock-json.yml");
    await expect(page.locator("#providerYamlSummary")).toHaveText(`kind: http · ${lineCount(yaml)} lines`);
    await expect(page.locator("#providerYaml")).toBeHidden();
    await expect(page.locator("#providerFixturesHint")).toBeHidden();
    // (between the facts and Try it, in that order; the open bar only on an open one)
    const y = async (sel) => (await page.locator(sel).boundingBox()).y;
    expect(await y("#providerFacts")).toBeLessThan(await y("#providerFixturesSection"));
    expect(await y("#providerFixturesSection")).toBeLessThan(await y("#providerYamlSection"));
    expect(await y("#providerYamlSection")).toBeLessThan(await y("#providerTry"));
    await expect(page.locator("#providerFixturesSection")).not.toHaveClass(/\bopen\b/);

    // One with fixtures: Fixtures open (no summary while open), its lists shown
    await openProvider(page, "acme");
    expect(await expanded(page, "providerFixtures")).toBe("true");
    await expect(page.locator("#providerFixturesSection")).toHaveClass(/\bopen\b/);
    await expect(page.locator("#providerFixturesSummary")).toHaveCount(0);
    await expect(page.locator("#providerFixtures-beforeAll-0")).toContainText("acme-login");
    expect(await expanded(page, "providerYaml")).toBe("false");
    // Closed: what it runs, in order
    await page.click("#providerFixturesToggle");
    await expect(page.locator("#providerFixtures-beforeAll-0")).toBeHidden();
    await expect(page.locator("#providerFixturesSummary")).toHaveText("acme-login → reset-cart");
    await expect(page.locator("#providerFixturesSummary")).not.toHaveClass(/error/);
    // YAML opened: the file, its own large editor's button, no summary
    await page.click("#providerYamlToggle");
    await expect(page.locator("#providerYaml")).toBeVisible();
    await expect(page.locator("#providerYaml")).toHaveValue(/before: \[reset-cart\]/);
    await expect(page.locator("#providerYamlMax")).toBeVisible();
    await expect(page.locator("#providerYamlSummary")).toHaveCount(0);

    // Remembered per section, not per provider: another provider shows them as left
    await openProvider(page, "mock-json");
    expect(await expanded(page, "providerFixtures")).toBe("false");
    expect(await expanded(page, "providerYaml")).toBe("true");
    await openProvider(page, "acme");
    expect(await expanded(page, "providerFixtures")).toBe("false");
    expect(await expanded(page, "providerYaml")).toBe("true");
    expect(await page.evaluate(() => [localStorage.getItem("eval.section.providerFixturesSection"), localStorage.getItem("eval.section.providerYamlSection")])).toEqual(["closed", "open"]);
    // … Settings closed and opened again, and the page loaded again
    await page.click("#settingsClose");
    await openProviders(page);
    await openProvider(page, "acme");
    expect(await expanded(page, "providerFixtures")).toBe("false");
    expect(await expanded(page, "providerYaml")).toBe("true");
    await page.click("#settingsClose");
    await reopen(page);
    await openProviders(page);
    await openProvider(page, "acme");
    expect(await expanded(page, "providerFixtures")).toBe("false");
    await expect(page.locator("#providerYaml")).toBeVisible();

    // A panel's fixtures `edit` opens Fixtures, closed as it was
    await page.click("#settingsClose");
    await page.selectOption("#convProvider", "providers/acme.yml");
    await page.click("#convFixturesEdit");
    await expect(page.locator("#providerFixtures-before-0")).toBeVisible();
    expect(await expanded(page, "providerFixtures")).toBe("true");
  });

  test("YAML that doesn't parse, its section closed: its head says so; leaving, or Try it, opens it to show why, and closing again discards", async ({ app: { page } }) => {
    await openProviders(page);
    await openProvider(page, "mock-json");
    const before = await fileText(page, "providers/mock-json.yml");
    await openYaml(page);
    const typed = "kind: http\nbody: { message: \"{{user}}\"\nresponse: x\n";
    await page.fill("#providerYaml", typed);
    await page.locator("#providerYaml").blur();
    await expect(page.locator("#providerYamlError")).toContainText(/line \d+, column \d+: .*Not saved/);
    // Closed with it: its head says why, in the danger colour
    await page.click("#providerYamlToggle");
    await expect(page.locator("#providerYaml")).toBeHidden();
    await expect(page.locator("#providerYamlSummary")).toContainText("Not saved");
    await expect(page.locator("#providerYamlSummary")).toHaveClass(/error/);
    // Try it: refused, the section opened, the edits there and why
    await page.click("#providerTry");
    await expect(page.locator("#settingsModal")).toBeVisible();
    expect(await expanded(page, "providerYaml")).toBe("true");
    await expect(page.locator("#providerYaml")).toBeVisible();
    await expect(page.locator("#providerYaml")).toBeFocused();
    await expect(page.locator("#providerYaml")).toHaveValue(typed);
    await expect(page.locator("#providerYamlError")).toContainText("fix it to try the provider");
    // Closed again, then Settings closed: refused once, the section opened to show why
    await page.click("#providerYamlToggle");
    await expect(page.locator("#providerYaml")).toBeHidden();
    await page.click("#settingsClose");
    await expect(page.locator("#settingsModal")).toBeVisible();
    await expect(page.locator("#settingsClose")).toHaveText("discard edits?");
    expect(await expanded(page, "providerYaml")).toBe("true");
    await expect(page.locator("#providerYamlError")).toBeVisible();
    await expect(page.locator("#providerYamlError")).toContainText("close again to discard your edits");
    await expect(page.locator("#providerYaml")).toHaveValue(typed);
    await page.click("#settingsClose");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    expect(await fileText(page, "providers/mock-json.yml")).toBe(before);
  });

  test("Settings → Providers: YAML that isn't valid stays, with its line; Try it keeps Settings open; closing asks first, then discards", async ({ app: { page } }) => {
    await openApp(page);
    const before = await fileText(page, "providers/mock-json.yml");
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await page.click("#provider-mock-json-open");
    await openYaml(page);
    await expect(page.locator("#providerYaml")).toHaveValue(/kind: http/);
    const typed = "kind: http\nbody: { message: \"{{user}}\"\nresponse: x\n";
    await page.fill("#providerYaml", typed);
    await page.locator("#providerYaml").blur();
    await expect(page.locator("#providerYamlError")).toContainText(/line \d+, column \d+: .*Not saved/);
    // Try it: Settings stays open, with the edits, and says why
    await page.click("#providerTry");
    await expect(page.locator("#settingsModal")).toBeVisible();
    await expect(page.locator("#providerYaml")).toHaveValue(typed);
    await expect(page.locator("#providerYamlError")).toContainText("fix it to try the provider");
    // Closing asks first (the edits kept), the second time it goes, and the file is as it was
    await page.click("#settingsClose");
    await expect(page.locator("#settingsModal")).toBeVisible();
    await expect(page.locator("#settingsClose")).toHaveText("discard edits?");
    await expect(page.locator("#providerYamlError")).toContainText("close again to discard your edits");
    await expect(page.locator("#providerYaml")).toHaveValue(typed);
    await page.click("#settingsClose");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    expect(await fileText(page, "providers/mock-json.yml")).toBe(before);
    // YAML that is valid is saved as Settings closes (Esc)
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await page.click("#provider-mock-json-open");
    await expect(page.locator("#providerYaml")).toBeVisible();
    await expect(page.locator("#providerYaml")).toHaveValue(/kind: http/);
    await page.fill("#providerYaml", `${before}timeout_ms: 9000\n`);
    await page.keyboard.press("Escape");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    await expect.poll(async () => parse(await fileText(page, "providers/mock-json.yml")).timeout_ms).toBe(9000);
  });

  test("a provider's kind is its file's (kind: http), with how it reads its reply", async ({ app: { page } }) => {
    await openApp(page);
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await expect(page.locator("#provider-mock-json")).toContainText("http (json)");
    await expect(page.locator("#provider-mock-sse")).toContainText("http (sse)");
    await page.click("#provider-mock-json-open");
    await expect(page.locator("#providerFacts")).toContainText("kindhttp (json)");
  });
});
