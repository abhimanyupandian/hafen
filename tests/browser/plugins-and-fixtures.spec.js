// Plugins and a provider's fixtures: Settings → Plugins (check, provider and fixture plugins, made from
// their starting files, and the plugin editor); a provider's fixtures listed and edited, run around its
// messages, shown on the timeline and in the console, and their problems said before sending.

import { parse } from "yaml";
import { pluginTemplate } from "hafen/engine/plugin-templates.js";
import { expect, fileText, mockLog, openYaml, reopen, style, test, writeFile, writeFiles } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};

test.describe("Settings → Plugins", () => {
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("Settings → Plugins: a new check plugin from its starting file, used by a suite by its name (no plugins: needed), run, then deleted", async ({ app: { page } }) => {
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#pluginsEmpty")).toBeVisible();
    await page.selectOption("#newPluginKind", "check");
    await page.fill("#newPluginName", "says-sorry");
    await page.click("#newPluginForm button[type=submit]");
    await expect(page.locator("#plugin-says-sorry")).toContainText("says-sorry · check · 1.0.0");
    await expect(page.locator("#plugin-says-sorry")).toContainText("Any suite can use it: { type: says-sorry }");
    await expect(page.locator("#plugin-says-sorry-used")).toHaveText("Used by no suite yet");
    // No "use it in a suite" any more: a suite uses the plugins by name
    await expect(page.locator("#plugin-says-sorry select, #plugin-says-sorry-use, #plugin-says-sorry .plugin-suite")).toHaveCount(0);
    expect(await fileText(page, "plugins/says-sorry.js")).toContain('kind: "check"');
    // (a check plugin isn't a provider: no provider file)
    await expect.poll(() => page.evaluate(async () => {
      try {
        await (await (await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }))).getDirectoryHandle("providers")).getFileHandle("says-sorry.yml");
        return true;
      } catch {
        return false;
      }
    })).toBe(false);
    await page.click("#settingsClose");
    // Its check, on turn 1 (the mock's refund reply says "sorry"): run, the suite not naming the plugin
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click();
    await page.click("#checksToggle");
    await page.click("#palette-path");
    await page.fill("#checkYaml", "type: says-sorry\nword: sorry");
    await page.locator("#checkYaml").blur();
    await expect.poll(async () => parse(await fileText(page, SUITE)).tests[0].turns[0].expect.at(-1)).toEqual({ type: "says-sorry", word: "sorry" });
    expect(parse(await fileText(page, SUITE)).plugins).toBeUndefined();
    await page.click("#testHeaderRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await expect(page.locator("#turn-0-reply .check-badge").last()).toHaveAttribute("data-status", "pass");
    await expect(page.locator("#turn-0-reply .check-badge").last()).toContainText("says-sorry");
    // Used by smoke (by the check's type), then deleted
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#plugin-says-sorry-used")).toHaveText(`Used by ${SUITE}`);
    await page.click("#plugin-says-sorry-delete");
    await page.click("#plugin-says-sorry-delete");
    await expect(page.locator("#pluginsEmpty")).toBeVisible();
  });

  test("Settings → Plugins: a fixture (a login) from its starting file; a provider naming one has it run before the conversation's first message, its value a secret", async ({ app: { page, servers } }) => {
    // A new fixture from its starting file: what it gives, and how a provider uses it
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await page.selectOption("#newPluginKind", "fixture");
    await page.fill("#newPluginName", "my-login");
    await page.click("#newPluginForm button[type=submit]");
    await expect(page.locator("#plugin-my-login")).toContainText("my-login · fixture · 1.0.0");
    await expect(page.locator("#plugin-my-login-provides")).toHaveText("Gives EXAMPLE_COOKIE, EXAMPLE_CSRF, for the run");
    await expect(page.locator("#plugin-my-login")).toContainText("Any provider can use it: fixtures: { beforeAll: [my-login] }");
    expect(await fileText(page, "plugins/my-login.js")).toContain('kind: "fixture"');
    await page.click("#settingsClose");
    // One that logs in to the mock (a token: a browser can't send or read cookies), and a provider naming it
    await writeFile(page, "plugins/token-login.js", `export default {
  kind: "fixture",
  name: "token-login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["ACME_TOKEN"],
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa-bot" }, signal });
    return { ACME_TOKEN: (await res.json()).access_token };
  },
};
`);
    await writeFile(page, "providers/behind-login.yml", `kind: http
fixtures: { beforeAll: [token-login] }
url: "${servers.mock.url}/json"
login_url: "${servers.mock.url}/login"
headers: { x-token: "{{secret.ACME_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`);
    await reopen(page);
    await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
    await page.selectOption("#convProvider", "providers/behind-login.yml");
    for (const [i, message] of ["hello", "again"].entries()) {
      await page.fill("#input", message);
      await page.press("#input", "Enter");
      await expect(page.locator(`#turn-${i}-reply .msg-body`)).toContainText(`You said: ${message}`);
    }
    const log = await mockLog(servers);
    expect(log.filter((x) => x.path === "/login")).toHaveLength(1);
    expect(log.filter((x) => x.path === "/json").map((x) => x.headers["x-token"])).toEqual(["tok_mock_123", "tok_mock_123"]);
    await expect(page.locator(".timeline-bar[data-kind='fixture']")).toHaveCount(1);
    expect(await page.content()).not.toContain("tok_mock_123");
    // Settings → Secrets doesn't ask for what a fixture gives
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsFromFixtures")).toHaveText("Given by a provider's fixture when a run starts, so not set here: ACME_TOKEN");
    await expect(page.locator("#secret-ACME_TOKEN")).toHaveCount(0);
  });

  test("Settings → Plugins: in the browser build a plugin that imports another file says it can't, and why", async ({ app: { page } }) => {
    await writeFile(page, "lib/helper.js", "export const word = 'please';\n");
    await writeFile(page, "plugins/imports.js", `import { word } from "../lib/helper.js";
export default { kind: "check", name: "imports", version: "1.0.0", async check({ value }) { return { status: String(value).includes(word) ? "pass" : "fail", reason: word }; } };
`);
    await reopen(page);
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#plugin-plugins-imports-js")).toContainText("it imports ../lib/helper.js, and the browser build loads a plugin as one module: use the desktop app or the CLI, or bundle it");
    await expect(page.getByText("A plugin is an ES module, and can import any other file or package")).toBeVisible();
  });
});

test.describe("provider plugins, and the plugin editor", () => {
  const exists = (page, path) => page.evaluate(async (path) => {
    const parts = path.split("/");
    try {
      let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      await dir.getFileHandle(parts.at(-1));
      return true;
    } catch {
      return false;
    }
  }, path);
  const openTest = (page, name) => page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: name }).first().click();

  // A provider plugin that calls the address its settings give, and says what it was given
  const ECHO = `export default {
  kind: "provider",
  name: "echo",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  async *send({ message, settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.url, method: "POST", body: { message }, signal });
    const data = await res.json();
    yield { type: "text", text: data.data.reply + " (via echo)" };
    yield { type: "done" };
  },
};
`;

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a provider plugin made in Settings → Plugins comes with its provider file, and is in Providers at once", async ({ app: { page } }) => {
    // (a provider file of that name already there: kept, and the new one is acme-2)
    const theirs = "kind: http\nurl: https://acme.example/chat\nbody: { message: \"{{user}}\" }\nresponse: { text: $.reply }\n";
    await writeFile(page, "providers/acme.yml", theirs);
    await openApp(page);
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await page.selectOption("#newPluginKind", "provider");
    await page.fill("#newPluginName", "acme");
    await page.click("#newPluginForm button[type=submit]");
    await expect(page.locator("#plugin-acme")).toContainText("acme · provider · 1.0.0");
    await expect(page.locator("#plugin-acme")).toContainText("Any suite can use it: kind: plugin:acme");
    await expect.poll(() => exists(page, "providers/acme-2.yml")).toBe(true);
    expect(parse(await fileText(page, "providers/acme-2.yml"))).toEqual({ kind: "plugin:acme" });
    expect(await fileText(page, "providers/acme-2.yml")).toContain("# url: https://api.example.com/chat");
    expect(await fileText(page, "providers/acme.yml")).toBe(theirs);
    // Listed among the providers, as plugin:acme; nothing left waiting for a provider file
    await page.click("#settings-tab-providers");
    await expect(page.locator("#provider-acme-2")).toContainText("plugin:acme · providers/acme-2.yml");
    await expect(page.locator("#provider-acme")).toContainText("http (json) · providers/acme.yml");
    await expect(page.locator("[id^='provider-plugin-']")).toHaveCount(0);
    // A check plugin isn't a provider: none made for it
    await page.click("#settings-tab-plugins");
    await page.selectOption("#newPluginKind", "check");
    await page.fill("#newPluginName", "polite");
    await page.click("#newPluginForm button[type=submit]");
    await expect(page.locator("#plugin-polite")).toContainText("polite · check");
    expect(await exists(page, "providers/polite.yml")).toBe(false);
  });

  test("a provider plugin with no provider file is offered one in Providers; then it's used in a conversation and a run, no plugins: in the suite", async ({ app: { page, servers } }) => {
    await writeFile(page, "plugins/echo.js", ECHO);
    await writeFile(page, "plug.hafen.yml", `version: 1\nname: Plug\nprovider: providers/echo.yml\ntests:\n  - name: through the plugin\n    turns:\n      - user: hello there\n        expect: [ { contains: "You said: hello there (via echo)" } ]\n`);
    await openApp(page);
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await expect(page.locator("#provider-plugin-echo")).toContainText("plugin:echo · plugins/echo.js · no provider file yet");
    await page.click("#provider-plugin-echo-add");
    // Its file made, and opened to edit
    await expect(page.locator("#providerName")).toHaveValue("echo");
    expect(parse(await fileText(page, "providers/echo.yml"))).toEqual({ kind: "plugin:echo" });
    const yaml = (await fileText(page, "providers/echo.yml")).replace("# url: https://api.example.com/chat", `url: "${servers.mock.url}/json"`);
    await openYaml(page);
    await page.fill("#providerYaml", yaml);
    await page.locator("#providerYaml").blur();
    await expect.poll(async () => parse(await fileText(page, "providers/echo.yml")).url).toBe(`${servers.mock.url}/json`);
    // Try it: a conversation through the plugin
    await page.click("#providerTry");
    await page.fill("#input", "hi plugin");
    await page.click("#send");
    await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: hi plugin (via echo)");
    // The list has it as a provider file now, not as a plugin waiting for one
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await expect(page.locator("#provider-echo")).toContainText("plugin:echo · providers/echo.yml");
    await expect(page.locator("#provider-plugin-echo")).toHaveCount(0);
    await page.click("#settingsClose");
    // A run: the suite names no plugins, the folder's is used
    expect(parse(await fileText(page, "plug.hafen.yml")).plugins).toBeUndefined();
    await openTest(page, "through the plugin");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    // Settings → Plugins says the suite uses it (its provider is the plugin's)
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#plugin-echo-used")).toHaveText("Used by plug.hafen.yml");
  });

  test("a plugin's JavaScript: in colour as it's typed; Tab, Enter and a closing bracket keep it indented; Format; Save", async ({ app: { page } }) => {
    await writeFile(page, "plugins/polite.js", pluginTemplate("check", "polite"));
    await openApp(page);
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await page.click("#plugin-polite-edit");
    const text = page.locator("#editorText");
    const colors = page.locator("#editorColors");
    await expect(text).toHaveValue(pluginTemplate("check", "polite"));
    // In colour: keywords, strings, comments, numbers; the colours are the text's, character for character
    await expect(colors.locator(".tok-keyword", { hasText: "export" }).first()).toBeVisible();
    await expect(colors.locator(".tok-string", { hasText: '"polite"' })).toHaveCount(1);
    await expect(colors.locator(".tok-comment").first()).toContainText("// A check plugin");
    expect(await style(colors.locator(".tok-keyword").first(), "color")).not.toBe(await style(colors, "color"));
    expect(await colors.textContent()).toBe(`${await text.inputValue()}\n`);
    // The text itself is see-through, its caret not
    expect(await style(text, "color")).toBe("rgba(0, 0, 0, 0)");
    // Typing: the colours follow
    await text.fill("const a = 42;");
    await expect(colors.locator(".tok-number")).toHaveText("42");
    // Enter after an opening bracket: a level in; a closing bracket first on a line: back out
    await text.fill("function f() {");
    await text.press("End");
    await text.press("Enter");
    await page.keyboard.type("return 1;");
    await text.press("Enter");
    await page.keyboard.type("}");
    await expect(text).toHaveValue("function f() {\n  return 1;\n}");
    // Enter between brackets: the closer on a line of its own
    await text.fill("const x = [];");
    await text.evaluate((el) => el.setSelectionRange(11, 11));
    await text.press("Enter");
    await expect(text).toHaveValue("const x = [\n  \n];");
    // Tab indents (and keeps focus in the text); Shift+Tab outdents; on several lines, each of them
    await text.fill("a\nb");
    await text.evaluate((el) => el.setSelectionRange(0, 0));
    await text.press("Tab");
    await expect(text).toHaveValue("  a\nb");
    await expect(text).toBeFocused();
    await text.press("Shift+Tab");
    await expect(text).toHaveValue("a\nb");
    await text.evaluate((el) => el.setSelectionRange(0, 3));
    await text.press("Tab");
    await expect(text).toHaveValue("  a\n  b");
    await text.press("Shift+Tab");
    await expect(text).toHaveValue("a\nb");
    // Format: a file with its indenting lost comes back as it was
    const template = pluginTemplate("check", "polite");
    await text.fill(template.split("\n").map((l) => l.trimStart()).join("\n"));
    await page.click("#editorFormat");
    await expect(text).toHaveValue(template);
    // (and ⇧⌥F does the same)
    await text.fill("if (a) {\nb();\n}");
    await text.press("Shift+Alt+KeyF");
    await expect(text).toHaveValue("if (a) {\n  b();\n}");
    // Saved as it is
    await text.fill(template.replace('"please"', '"thanks"'));
    await page.click("#editorSave");
    await expect.poll(() => fileText(page, "plugins/polite.js")).toContain('"thanks"');
    await expect(page.locator("#editor")).toHaveCount(0);
  });
});

test.describe("a provider's fixtures", () => {
  const openProvider = async (page, name) => {
    if (!(await page.locator("#providerList").isVisible())) await page.click("#providersBack");
    await page.click(`#provider-${name}-open`);
    await expect(page.locator("#providerName")).toHaveValue(name);
  };
  const NOTE_FIXTURE = "export default { kind: \"fixture\", name: \"note\", version: \"1.0.0\", async run() {} };\n";
  const provider = (url, more = "") => `kind: http\nurl: "${url}"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n${more}`;
  const box = async (locator) => {
    const b = await locator.boundingBox();
    return { left: Math.round(b.x), top: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height), width: Math.round(b.width), height: Math.round(b.height) };
  };

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("only providers to pick; a provider's fixtures, a list for each of the four, in its file; run before the first message, shown on the timeline and in the console, hidden and shown again", async ({ app: { page, servers } }) => {
    await writeFile(page, "plugins/token-login.js", `export default {
  kind: "fixture", name: "token-login", version: "1.0.0", hosts: ["127.0.0.1"], provides: ["ACME_TOKEN"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa-bot" }, signal });
    return { ACME_TOKEN: (await res.json()).access_token };
  },
};
`);
    await writeFile(page, "plugins/note.js", "export default { kind: \"fixture\", name: \"note\", version: \"1.0.0\", async run() {} };\n");
    await writeFile(page, "providers/behind-login.yml", `kind: http
url: "${servers.mock.url}/json"
login_url: "${servers.mock.url}/login"
headers: { x-token: "{{secret.ACME_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`);
    // (a provider file whose kind is a fixture: not a provider to pick)
    await writeFile(page, "providers/not-a-provider.yml", "kind: plugin:token-login\n");
    await reopen(page);
    await expect(page.locator("#convProvider option", { hasText: "behind-login" })).toHaveCount(1);
    expect(await page.locator("#convProvider option").allTextContents()).not.toContain("not-a-provider");

    await page.selectOption("#convProvider", "providers/behind-login.yml");
    await expect(page.locator("#convFixturesNone")).toHaveText("None yet: edit adds some (a login before the run, say).");
    // The editor (Settings → Providers): a list for each of the four, fixtures picked from the folder's
    await page.click("#convFixturesEdit");
    await expect(page.locator("#providerFixtures-beforeAll .label")).toHaveText("Once, before the run");
    expect(await page.locator("#providerFixtures-beforeAll-add option").allTextContents()).toEqual([
      "+ add a fixture", "note (gives nothing)", "token-login (gives ACME_TOKEN)",
    ]);
    const fixturesIn = async () => parse(await fileText(page, "providers/behind-login.yml")).fixtures;
    await page.selectOption("#providerFixtures-beforeAll-add", "token-login");
    await expect.poll(fixturesIn).toEqual({ beforeAll: ["token-login"] });
    // Several in one list, in their order; moved earlier and later
    await page.selectOption("#providerFixtures-beforeAll-add", "note");
    await expect.poll(fixturesIn).toEqual({ beforeAll: ["token-login", "note"] });
    await expect(page.locator("#providerFixtures-beforeAll-1")).toContainText("note");
    await expect(page.locator("#providerFixtures-beforeAll-0")).toContainText("gives ACME_TOKEN");
    await expect(page.locator("#providerFixtures-beforeAll-0-up")).toBeDisabled();
    await page.click("#providerFixtures-beforeAll-1-up");
    await expect.poll(fixturesIn).toEqual({ beforeAll: ["note", "token-login"] });
    // Another list; taken out again (an empty list leaves the file)
    await page.selectOption("#providerFixtures-after-add", "note");
    await expect.poll(fixturesIn).toEqual({ beforeAll: ["note", "token-login"], after: ["note"] });
    // A list names each fixture once: one it has can't be added to it again (another list can name it)
    const optionIn = (phase, name) => page.locator(`#providerFixtures-${phase}-add option[value='${name}']`);
    await expect(optionIn("beforeAll", "note")).toHaveJSProperty("disabled", true);
    await expect(optionIn("beforeAll", "note")).toHaveText("note (in this list already)");
    await expect(optionIn("after", "note")).toHaveJSProperty("disabled", true);
    await expect(optionIn("after", "token-login")).toHaveJSProperty("disabled", false);
    await page.click("#providerFixtures-after-0-remove");
    await expect.poll(fixturesIn).toEqual({ beforeAll: ["note", "token-login"] });
    // Each fixture's code, a click away: Settings → Plugins, its file in the editor
    await page.click("#providerFixtures-beforeAll-1-code");
    await expect(page.locator("#pluginList")).toBeVisible();
    await expect(page.locator("#editorText")).toHaveValue(/name: "token-login"/);
    // (closing it goes back to the provider's fixtures, where the link was)
    await page.click("#editorCancel");
    await expect(page.locator("#providerFixtures-beforeAll-1")).toBeVisible();
    await page.click("#settingsClose");
    // Beside the picker: what it runs, in order
    await expect(page.locator("#convFixtures")).toContainText("once, before the run");
    await expect(page.locator("#convFixtures")).toContainText("note → token-login");
    // (each name there, a link to its code)
    await page.click("#convFixtures-beforeAll-0");
    await expect(page.locator("#editorText")).toHaveValue(/name: "note"/);
    // (opened from the panel: closing it closes Settings too, back where the link was)
    await page.click("#editorCancel");
    await expect(page.locator("#settingsModal")).toHaveCount(0);

    // A message: logged in first, its token sent
    await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
    await page.fill("#input", "hello");
    await page.press("#input", "Enter");
    await expect(page.locator("#turn-0-reply .msg-body")).toHaveText("You said: hello");
    const log = await mockLog(servers);
    expect(log.filter((x) => x.path === "/login")).toHaveLength(1);
    expect(log.find((x) => x.path === "/json").headers["x-token"]).toBe("tok_mock_123");

    // On the timeline: the fixture and its call; the call's step says what it sent and got (the token redacted)
    // (note, then token-login: the two before the run)
    await expect(page.locator(".timeline-bar[data-kind='fixture']")).toHaveCount(2);
    await page.locator(".timeline-bar[data-kind='call']").first().click();
    await expect(page.locator("#stepCallUrl")).toHaveText(`POST ${servers.mock.url}/login`);
    await expect(page.locator("#stepCallStatus")).toHaveText("200");
    await expect(page.locator("#stepCallPlugin")).toHaveText("fixture token-login");
    await expect(page.locator("#stepCallBody")).toContainText('"user": "qa-bot"');
    await expect(page.locator("#stepCallResponseBody")).toContainText('"access_token": "[redacted]"');
    expect(await page.content()).not.toContain("tok_mock_123");
    // The plugin that made the call: a link to its code
    await page.click("#stepCallPlugin");
    await expect(page.locator("#editorText")).toHaveValue(/name: "token-login"/);
    // (closing it goes back where the link was: out of Settings)
    await page.click("#editorCancel");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    // And a fixture's own step: its name, a link to its code
    await page.locator(".timeline-bar[data-kind='fixture']").first().click();
    await page.click("#stepFixtureCode");
    await expect(page.locator("#editorText")).toHaveValue(/name: "note"/);
    await page.click("#editorCancel");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    // In the console: the fixture's line, and its call's
    await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=token-login phase=beforeAll provider=providers/behind-login.yml calls=1  ok · gave ACME_TOKEN");
    await expect(page.locator("#consoleBody")).toContainText("via=fixture:token-login");

    // Hidden, from the timeline: gone from both; shown again, from the console
    await page.click("#timelineFixtures");
    await expect(page.locator(".timeline-bar[data-kind='fixture'], .timeline-bar[data-kind='call']")).toHaveCount(0);
    await expect(page.locator("#consoleBody [data-tag='fixture']")).toHaveCount(0);
    await expect(page.locator("#timelineFixtures")).toHaveText("show fixtures");
    await expect(page.locator("#consoleFixtures")).toHaveText("show fixtures");
    expect(await page.evaluate(() => localStorage.getItem("eval.fixtures"))).toBe("hidden");
    // (the console starts closed: opened, its own toggle)
    await page.click("#consoleToggle");
    await page.click("#consoleFixtures");
    await expect(page.locator(".timeline-bar[data-kind='fixture']")).toHaveCount(2);
    await expect(page.locator("#consoleBody [data-tag='fixture']").first()).toBeVisible();

    // The suite's and a test's provider have the field too
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).first().click();
    await expect(page.locator("#testProviderFixturesNone")).toHaveText("None yet: edit adds some (a login before the run, say).");
    await expect(page.locator("#testProviderFixturesEdit")).toBeVisible();
  });

  test("a fixture a list names twice (written by hand) is a problem: the list still shows, the extra is taken out there, and nothing is sent until it is", async ({ app: { page, servers } }) => {
    await writeFile(page, "plugins/note.js", "export default { kind: \"fixture\", name: \"note\", version: \"1.0.0\", async run() {} };\n");
    await writeFile(page, "providers/twice.yml", `kind: http
url: "${servers.mock.url}/json"
fixtures: { beforeAll: [note, note@^1], after: [note] }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`);
    await reopen(page);
    await page.selectOption("#convProvider", "providers/twice.yml");
    // (the conversation's provider: said once, as what stops a message to it, in the duplicate line's place)
    await expect(page.locator("#convFixturesProblem")).toHaveText("twice: fixtures.beforeAll names note twice: a list runs each fixture once (another list can name it too) · edit the provider");
    await expect(page.locator("#convFixturesDuplicate")).toHaveCount(0);
    // Sending is refused before it's tried, said in the panel only (what's typed stays)
    await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
    await page.fill("#input", "hello");
    await page.press("#input", "Enter");
    await expect(page.locator("#sendProblem")).toHaveCount(0);
    await expect(page.locator("#send")).toBeDisabled();
    await expect(page.locator("#send")).toHaveAttribute("title", /^Can't send: fixtures\.beforeAll names note twice/);
    await expect(page.locator("#input")).toHaveValue("hello");
    expect((await mockLog(servers)).filter((x) => x.path === "/json")).toHaveLength(0);
    // In the editor: both shown, the second marked; taken out, the problem goes
    await page.click("#convFixturesEdit");
    await expect(page.locator("#providerFixturesDuplicate")).toContainText("names note twice");
    await expect(page.locator("#providerFixtures-beforeAll-1")).toContainText("in this list already: take it out");
    await expect(page.locator("#providerFixtures-after-0")).not.toContainText("in this list already");
    await page.click("#providerFixtures-beforeAll-1-remove");
    await expect.poll(async () => parse(await fileText(page, "providers/twice.yml")).fixtures).toEqual({ beforeAll: ["note"], after: ["note"] });
    await expect(page.locator("#providerFixturesDuplicate")).toHaveCount(0);
  });

  test("a fixture is offered only in the lists its phases name; one in a list it doesn't run in is marked, and stops a message; Settings → Plugins says where each runs", async ({ app: { page, servers } }) => {
    await writeFiles(page, {
      "plugins/first-only.js": `export default { kind: "fixture", name: "first-only", version: "1.0.0", phases: ["beforeAll"], async run() {} };\n`,
      "plugins/login-logout.js": `export default { kind: "fixture", name: "login-logout", version: "1.0.0", phases: ["beforeAll", "afterAll"], async run() {} };\n`,
      "plugins/anywhere.js": `export default { kind: "fixture", name: "anywhere", version: "1.0.0", async run() {} };\n`,
      "providers/gated.yml": `kind: http\nurl: "${servers.mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\nfixtures:\n  before: [first-only]\n`,
    });
    await reopen(page);
    // Settings → Plugins: where each runs (all four when it doesn't say)
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#plugin-first-only-phases")).toHaveText("Runs in beforeAll");
    await expect(page.locator("#plugin-login-logout-phases")).toHaveText("Runs in beforeAll, afterAll");
    await expect(page.locator("#plugin-anywhere-phases")).toHaveText("Runs in beforeAll, before, after, afterAll");
    // The provider's fixtures: the one in a list it doesn't run in, marked with why
    await page.click("#settings-tab-providers");
    await openProvider(page, "gated");
    const row = page.locator("#providerFixtures-before-0");
    await expect(row).toContainText("first-only");
    await expect(row.locator(".hint.error")).toHaveText("runs only in beforeAll: it can't be in this list");
    await page.click("#providerFixturesToggle");
    await expect(page.locator("#providerFixturesSummary")).toHaveText("first-only · has problems");
    await expect(page.locator("#providerFixturesSummary")).toHaveClass(/error/);
    await page.click("#providerFixturesToggle");
    // + add a fixture: each fixture, those that don't run in the list not to pick, with why
    const option = (phase, name) => page.locator(`#providerFixtures-${phase}-add option[value='${name}']`);
    await expect(option("beforeAll", "first-only")).toHaveText("first-only (gives nothing)");
    await expect(option("beforeAll", "first-only")).toHaveJSProperty("disabled", false);
    for (const phase of ["before", "after", "afterAll"]) {
      await expect(option(phase, "first-only")).toHaveText("first-only (runs only in beforeAll)");
      await expect(option(phase, "first-only")).toHaveJSProperty("disabled", true);
    }
    await expect(option("after", "login-logout")).toHaveText("login-logout (runs only in beforeAll, afterAll)");
    await expect(option("after", "login-logout")).toHaveJSProperty("disabled", true);
    await expect(option("afterAll", "login-logout")).toHaveJSProperty("disabled", false);
    for (const phase of ["beforeAll", "before", "after", "afterAll"]) await expect(option(phase, "anywhere")).toHaveJSProperty("disabled", false);
    // Added where it runs; taken out where it can't
    await page.selectOption("#providerFixtures-beforeAll-add", "first-only");
    await expect.poll(async () => parse(await fileText(page, "providers/gated.yml")).fixtures).toEqual({ beforeAll: ["first-only"], before: ["first-only"] });
    // A message to it is stopped before it's sent, by the provider, with why
    await page.click("#settingsClose");
    await page.selectOption("#convProvider", "providers/gated.yml");
    await page.fill("#input", "hello");
    await expect(page.locator("#convFixturesProblem")).toContainText('gated: the fixture "first-only" (fixtures.before) runs only in beforeAll');
    await expect(page.locator("#send")).toBeDisabled();
    await expect(page.locator("#send")).toHaveAttribute("title", /runs only in beforeAll/);
    // Taken out of the list it can't be in: it goes
    await page.click("#convFixturesFix");
    await page.click("#providerFixtures-before-0-remove");
    await expect.poll(async () => parse(await fileText(page, "providers/gated.yml")).fixtures).toEqual({ beforeAll: ["first-only"] });
    await page.click("#settingsClose");
    await expect(page.locator("#convFixturesProblem")).toHaveCount(0);
    await expect(page.locator("#send")).toBeEnabled();
  });

  test("a fixture that sets a name and says to stop: the name isn't \"not set\"; the test stops, saying why; its step says what it set and that it said to stop", async ({ app: { page, servers } }) => {
    await writeFiles(page, {
      "plugins/gate.js": `export default { kind: "fixture", name: "gate", version: "1.0.0", phases: ["before"], async run({ env }) { env.set("REGION", "eu-west-1"); return false; } };\n`,
      "providers/gated.yml": `kind: http\nurl: "${servers.mock.url}/json"\nbody: { message: "{{user}} {{env.REGION}}" }\nresponse: { text: $.data.reply }\nfixtures:\n  before: [gate]\n`,
      "gated.hafen.yml": "version: 1\nname: Gated\nprovider: providers/gated.yml\ntests:\n  - name: behind the gate\n    turns:\n      - user: hello\n",
    });
    await reopen(page);
    // (the name it sets: not "not set" in Environments)
    await page.click("#openSettings");
    await page.click("#settings-tab-environments");
    await page.locator("#envGlobals").waitFor();
    await expect(page.locator("[id='envVar-REGION']")).toHaveCount(0);
    await page.click("#settingsClose");
    // The test: stopped by its fixture, saying why
    await page.locator("#suiteList .list-open", { hasText: "behind the gate" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("stopped", { timeout: 15000 });
    await expect(page.locator("#status")).toHaveAttribute("title", /said to stop/);
    await expect(page.locator("#panel")).toContainText('the fixture "gate" (before) said to stop');
    // Its step: what it set, and that it said to stop
    await page.locator(".timeline-bar[data-kind='fixture']").first().click();
    await expect(page.locator("#stepFixture")).toContainText("setREGION");
    await expect(page.locator("#stepFixture")).toContainText("stopsaid to stop");
  });

  test("a provider whose fixture isn't there: said in the panel before sending, Send off; a message refused when sent comes back, with why under the box", async ({ app: { page, servers } }) => {
    await writeFile(page, "providers/fxmissing.yml", provider(`${servers.mock.url}/json`, "fixtures: { before: [nope] }\n"));
    await openApp(page);
    // Known before sending: said in the panel, by the provider (not at the box), Send off (its title says why)
    await page.selectOption("#convProvider", "providers/fxmissing.yml");
    await page.fill("#input", "hello there");
    await expect(page.locator("#panel #convFixturesProblem")).toContainText('fxmissing: the fixture "nope" (fixtures.before) isn\'t one of your plugins (Settings → Plugins)');
    await expect(page.locator("#sendProblem")).toHaveCount(0);
    await expect(page.locator("#send")).toBeDisabled();
    await expect(page.locator("#send")).toHaveAttribute("title", /Can't send: the fixture "nope"/);
    await expect(page.locator("#convFixturesFix")).toHaveText("edit the provider");
    // Not known (the file changed since the folder was read): refused when sent, the message back in the
    // box, why under it, and no turn of it in the thread
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    await expect(page.locator("#convFixturesProblem")).toHaveCount(0);
    await writeFile(page, "providers/mock-json.yml", `${await fileText(page, "providers/mock-json.yml")}fixtures: { before: [gone] }\n`);
    await page.fill("#input", "I want a refund for order 4417");
    await page.click("#send");
    await expect(page.locator("#sendProblem")).toContainText('the fixture "gone"');
    await expect(page.locator("#input")).toHaveValue("I want a refund for order 4417");
    await expect(page.locator("#turn-0")).toHaveCount(0);
  });

  test.describe("with no scope chosen", () => {
    test.use({ scope: null });

    test("a provider's problem known before sending is said only in the panel, under its fixtures, with edit the provider (not under the box, nor in the top bar); Send is off, its title saying why", async ({ app: { page, servers } }) => {
      await writeFile(page, "providers/ollama.yml", `kind: http\nurl: "${servers.mock.url}/json"\nfixtures: { beforeAll: [test] }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
      await openApp(page);
      await page.selectOption("#convProvider", "providers/ollama.yml");
      await page.fill("#input", "hello");
      const said = "ollama: the fixture \"test\" (fixtures.beforeAll) isn't one of your plugins (Settings → Plugins)";
      const problem = page.locator("#convFixturesProblem");
      await expect(problem).toHaveText(`${said} · edit the provider`);
      await expect(problem).toHaveAttribute("role", "alert");
      // In the panel, under the provider's fixtures, and only there
      await expect(page.locator("#panel #convFixturesProblem")).toBeVisible();
      expect((await box(problem)).top).toBeGreaterThan((await box(page.locator("#convFixturesEdit"))).bottom);
      await expect(page.getByText("isn't one of your plugins (Settings → Plugins)")).toHaveCount(1);
      await expect(page.locator("#sendProblem")).toHaveCount(0);
      await expect(page.locator("#composer")).not.toContainText("plugins");
      await expect(page.locator("#topbar")).not.toContainText("plugins");
      // Send is off, its title says why; Enter sends nothing, and what's typed stays
      await expect(page.locator("#send")).toBeDisabled();
      await expect(page.locator("#send")).toHaveAttribute("title", "Can't send: the fixture \"test\" (fixtures.beforeAll) isn't one of your plugins (Settings → Plugins)");
      await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
      await page.press("#input", "Enter");
      await expect(page.locator("#input")).toHaveValue("hello");
      expect((await mockLog(servers)).filter((x) => x.path === "/json")).toHaveLength(0);
      // edit the provider: Settings → Providers, on it; the fixture taken out there, the problem goes
      await page.click("#convFixturesFix");
      await expect(page.locator("#settings-tab-providers")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#providerName")).toHaveValue("ollama");
      await page.click("#providerFixtures-beforeAll-0-remove");
      await expect.poll(async () => parse(await fileText(page, "providers/ollama.yml")).fixtures).toBeUndefined();
      await page.click("#settingsClose");
      await expect(problem).toHaveCount(0);
      await expect(page.locator("#convFixturesNone")).toBeVisible();
      await expect(page.locator("#send")).toBeEnabled();
      await page.click("#send");
      await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: hello");
    });
  });

  test("a fixture's code opened from a link: closing the editor goes back where the link was, out of Settings", async ({ app: { page, servers } }) => {
    await writeFile(page, "plugins/note.js", NOTE_FIXTURE);
    await writeFile(page, "providers/noted.yml", provider(`${servers.mock.url}/json`, "fixtures: { before: [note] }\n"));
    await openApp(page);
    await page.selectOption("#convProvider", "providers/noted.yml");
    await page.click("#convFixtures-before-0");
    await expect(page.locator("#editor")).toBeVisible();
    await page.click("#editorCancel");
    await expect(page.locator("#settingsModal")).toHaveCount(0);
    // From Settings → Providers' own fixtures list: back there
    await page.click("#convFixturesEdit");
    await page.click("#providerFixtures-before-0-code");
    await expect(page.locator("#editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#settingsModal")).toBeVisible();
    await expect(page.locator("#settingsTitle")).toHaveText("Providers");
    // (on the provider's fixtures, their section open)
    await expect(page.locator("#providerFixtures-before-0")).toBeVisible();
  });

  test("a conversation's after and afterAll fixtures have their lines in the console when it's let go", async ({ app: { page, servers } }) => {
    await writeFile(page, "plugins/note.js", NOTE_FIXTURE);
    await writeFile(page, "providers/noted.yml", provider(`${servers.mock.url}/json`, "fixtures: { before: [note], after: [note], afterAll: [note] }\n"));
    await openApp(page);
    await page.selectOption("#convProvider", "providers/noted.yml");
    await page.fill("#input", "hello");
    await page.click("#send");
    await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said");
    await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=note phase=before");
    await page.click("#newConversation");
    await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=note phase=after ");
    await expect(page.locator("#consoleBody")).toContainText("conversation.fixture  name=note phase=afterAll");
  });
});
