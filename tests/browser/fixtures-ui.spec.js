// A provider's fixtures in the app (contracts/ui.md): the provider pickers list only providers; beside
// them, what the provider's fixtures are and `edit`, which opens the editor (Settings → Providers: a
// list for each of the four, each in its order), saved in the provider's file; the fixtures and
// their HTTP calls on the timeline (a call's step: what it sent and got) and in the console, hidden and
// shown again from either. (The scope button with none chosen: scope-ui.spec.js.)

import { parse } from "yaml";
import { expect, fileText, test } from "./fixtures.js";

const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const mockLog = async (servers) => (await fetch(`${servers.mock.url}/_log`)).json();

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
  await page.click("#openFolder");
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
  await page.click("#openFolder");
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
