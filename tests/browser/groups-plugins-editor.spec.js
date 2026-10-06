// Groups, provider plugins as providers, the plugin editor, and the turn's ▷ (contracts/ui.md; test-file.md,
// Groups): a test's and a suite's group in their panels; a provider plugin listed in Settings →
// Providers (made with a provider file, or offered one), used in a conversation and a run with no
// plugins: in the suite; a plugin's JavaScript in colour, indented as it's typed, formatted; a turn's ▷
// shown as its × is; no large-editor button on the message box.

import { parse } from "yaml";
import { pluginTemplate } from "../../engine/plugin-templates.js";
import { expect, fileText, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const exists = (page, path) => page.evaluate(async (path) => {
  const parts = path.split("/");
  try {
    let dir = await navigator.storage.getDirectory();
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    await dir.getFileHandle(parts.at(-1));
    return true;
  } catch {
    return false;
  }
}, path);
const openFolder = async (page) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const openTest = (page, name) => page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: name }).first().click();
const style = (locator, prop) => locator.evaluate((el, prop) => getComputedStyle(el)[prop], prop);

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

test("a test's group and a suite's group: set in their panels, written to the file, cleared; a bad one isn't saved", async ({ app: { page } }) => {
  await openFolder(page);
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#testGroup")).toHaveValue("");
  await expect(page.locator("#testGroupHint")).toContainText("Tests in the same group run one after another; different groups run at the same time");
  await page.fill("#testGroup", "2");
  await page.press("#testGroup", "Enter");
  await expect.poll(async () => parse(await fileText(page, SUITE)).tests[0].group).toBe(2);
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
  await expect.poll(async () => parse(await fileText(page, SUITE)).group).toBe(3);
  await page.fill("#suiteGroup", "");
  await page.press("#suiteGroup", "Enter");
  await expect.poll(async () => "group" in parse(await fileText(page, SUITE))).toBe(false);
});

test("a provider plugin made in Settings → Plugins comes with its provider file, and is in Providers at once", async ({ app: { page } }) => {
  // (a provider file of that name already there: kept, and the new one is acme-2)
  const theirs = "kind: http\nurl: https://acme.example/chat\nbody: { message: \"{{user}}\" }\nresponse: { text: $.reply }\n";
  await writeFile(page, "providers/acme.yml", theirs);
  await openFolder(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-plugins");
  await page.selectOption("#newPluginKind", "provider");
  await page.fill("#newPluginName", "acme");
  await page.click("#newPluginForm button[type=submit]");
  await expect(page.locator("#plugin-acme")).toContainText("acme · provider · 1.0.0");
  await expect(page.locator("#plugin-acme")).toContainText("Any suite in the folder can use it: kind: plugin:acme");
  await expect.poll(() => exists(page, "providers/acme-2.yml")).toBe(true);
  expect(parse(await fileText(page, "providers/acme-2.yml"))).toEqual({ kind: "plugin:acme" });
  expect(await fileText(page, "providers/acme-2.yml")).toContain("# url: https://api.example.com/chat");
  expect(await fileText(page, "providers/acme.yml")).toBe(theirs);
  // Listed among the providers, as plugin:acme; nothing left waiting for a provider file
  await page.click("#settings-tab-providers");
  await expect(page.locator("#provider-acme-2")).toContainText("plugin:acme · providers/acme-2.yml");
  await expect(page.locator("#provider-acme")).toContainText("json · providers/acme.yml");
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
  await openFolder(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await expect(page.locator("#provider-plugin-echo")).toContainText("plugin:echo · plugins/echo.js · no provider file yet");
  await page.click("#provider-plugin-echo-add");
  // Its file made, and opened to edit
  await expect(page.locator("#providerName")).toHaveValue("echo");
  expect(parse(await fileText(page, "providers/echo.yml"))).toEqual({ kind: "plugin:echo" });
  const yaml = (await fileText(page, "providers/echo.yml")).replace("# url: https://api.example.com/chat", `url: "${servers.mock.url}/json"`);
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
  await openFolder(page);
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

test("a turn's ▷ shows as its × does: when the turn is pointed at or selected; always while it's the stop of a run", async ({ app: { page, servers } }) => {
  await openFolder(page);
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

test("the message box has no large-editor button", async ({ app: { page } }) => {
  await openFolder(page);
  await expect(page.locator("#input")).toBeVisible();
  await expect(page.locator("#inputMax")).toHaveCount(0);
  await expect(page.locator(".composer .btn-max")).toHaveCount(0);
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#input")).toBeVisible();
  await expect(page.locator(".composer .btn-max")).toHaveCount(0);
});
