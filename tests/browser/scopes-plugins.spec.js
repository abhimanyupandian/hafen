// The panels, the sidebar and the thread as they now look (icons, back buttons, no dividers, a check's
// ×, no overflow), the timeline's fit and scrolling, Markdown replies and copying one raw, scopes
// (Settings → Environments and Secrets; {{env.NAME}} and {{secret.NAME}} anywhere, checked under the
// field), and Settings → Plugins.

import { parse } from "yaml";
import { chooseScope, expect, fileText, newScope, reopen, showEntry, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
// (a suite by its file, data-file; a test by its name)
const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const mockLog = async (servers) => (await fetch(`${servers.mock.url}/_log`)).json();

test.beforeEach(async ({ app: { page } }) => {
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("the sidebar: import and export all are words in Suites' head; a closed section shows its icon, an open one its arrow", async ({ app: { page } }) => {
  await expect(page.locator("#importSuites")).toHaveText("import");
  await expect(page.locator("#exportSuites")).toHaveText("export all");
  await expect(page.locator("#importSuites svg, #exportSuites svg")).toHaveCount(0);
  await expect(page.locator("#suitesMenu")).toHaveCount(0);
  // Checks starts closed: its icon; open: the arrow
  await expect(page.locator("#checksToggle .section-icon svg")).toHaveCount(1);
  await expect(page.locator("#checksToggle .chev")).toHaveCount(0);
  await page.click("#checksToggle");
  await expect(page.locator("#checksToggle .chev")).toHaveCount(1);
  await expect(page.locator("#checksToggle .section-icon")).toHaveCount(0);
  // The label doesn't move between the two
  const open = await page.locator("#checksLabel").boundingBox();
  await page.click("#checksToggle");
  const closed = await page.locator("#checksLabel").boundingBox();
  expect(Math.abs(open.x - closed.x)).toBeLessThan(1);
});

test("the top bar's icon says what's open; panels go back to what holds them", async ({ app: { page } }) => {
  await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "explore");
  await row(page, SUITE).locator(".list-open").click();
  await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "suite");
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "test");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  // A check → its turn → the test → the suite
  await page.locator("#turn-1-reply .check-badge").first().click();
  await expect(page.locator("#panel .panel-head")).toContainText("Check");
  await page.click("#panelBack");
  await expect(page.locator("#panel .panel-head")).toContainText("Turn 2");
  await page.click("#panelBack");
  await expect(page.locator("#panel .panel-head")).toContainText("Test");
  await page.click("#panelBack");
  await expect(page.locator("#panel .panel-head")).toContainText("Suite");
  // A step goes back to its turn
  await openTest(page, "refund for a broken item");
  await page.locator(".timeline-bar[data-kind='request']").first().click();
  await expect(page.locator("#panel .panel-head")).toContainText("Step");
  await page.click("#panelBack");
  await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
  // A run's
  await page.locator("#runList .list-open").first().click();
  await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "run");
});

test("a turn's checks each have a ×; panels don't run out sideways; turns have no dividers and no 'user' label", async ({ app: { page } }) => {
  await row(page, SUITE).locator(".list-open").click();
  const body = page.locator("#panel .panel-body");
  expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const id of ["#suiteRun", "#suiteAddTest", "#suiteCopyCi"]) {
    const b = await page.locator(id).boundingBox();
    const p = await body.boundingBox();
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
  }
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#turn-0-user > .label")).toHaveCount(0);
  expect(await page.locator("#turn-1").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  await page.locator("#turn-0 .turn-head .label").click();
  const x = page.locator("#turnCheck-0 .list-del");
  expect(await x.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await x.click();
  await x.click();
  await expect.poll(async () => parse(await fileText(page, SUITE)).tests[0].turns[0].expect.length).toBe(3);
});

test("the timeline fits without sideways scrolling, and the wheel over its labels scrolls it", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await page.click("#timelineFit");
  const chart = page.locator(".timeline-chart");
  // The chart's width reaches the scale a frame after it changes (a ResizeObserver): it settles there
  await expect.poll(() => chart.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(await chart.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await chart.evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator(".timeline-labels").hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => chart.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The labels moved with it
  const top = await page.locator(".timeline-labels-inner").evaluate((el) => el.style.top);
  expect(parseFloat(top)).toBeLessThan(0);
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

test("scopes: a scope's environment values (kept by the app) and secrets fill {{env.NAME}} and {{secret.NAME}} anywhere; fields say when one isn't there", async ({ app: { page, servers } }) => {
  // A provider that takes its address and key from the scope
  await writeFile(page, "providers/mock-json.yml", `kind: http\nurl: "{{env.base_url}}/json"\nheaders: { Authorization: "Bearer {{secret.API_KEY}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  // Settings → Environments: a scope, its values
  await page.click("#openSettings");
  await page.click("#settings-tab-environments");
  await newScope(page, "stage");
  await expect(page.locator("#envScope-stage")).toHaveClass(/active/);
  for (const [name, value] of [["base_url", servers.mock.url], ["who", "stage-team"]]) {
    await page.fill("#envVarName", name);
    await page.fill("#envVarValue", value);
    await page.press("#envVarValue", "Enter");
    await expect(page.locator(`#envVar-${name}`)).toBeVisible();
  }
  // (kept by the app, not in its files)
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("eval.scope.stage")));
  expect(await stored()).toEqual({ base_url: servers.mock.url, who: "stage-team" });
  await expect.poll(() => fileText(page, "environments/stage.yml").then(() => "there", () => "none")).toBe("none");
  // A value changed in place
  await page.locator("#envVar-who input").fill("stage-crew");
  await page.locator("#envVar-who input").press("Enter");
  await expect.poll(async () => (await stored()).who).toBe("stage-crew");
  // Its secret
  await page.click("#settings-tab-secrets");
  await showEntry(page, "stage", "secrets");
  await page.fill("#secretName", "API_KEY");
  await page.fill("#secretValue", "sk-stage-777");
  await page.press("#secretValue", "Enter");
  await expect(page.locator("#secret-API_KEY")).toBeVisible();
  await page.click("#settingsClose");
  // Chosen with the scope button at the top of the sidebar (it opens Settings → Environments)
  await chooseScope(page, "stage");
  // The message box checks a message as it's typed
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await page.fill("#input", "hi from {{env.nope}}");
  await expect(page.locator("#inputProblem")).toContainText('{{env.nope}} isn\'t in the scope "stage"');
  await page.fill("#input", "hi from {{env.who}} with {{secret.API_KEY}} known");
  await expect(page.locator("#inputProblem")).toHaveCount(0);
  await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
  await page.fill("#input", "hi from {{env.who}}");
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/send/i);
  const sent = (await mockLog(servers)).at(-1);
  expect(sent.body.message).toBe("hi from stage-crew");
  expect(sent.headers.authorization).toBe("Bearer sk-stage-777");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: hi from stage-crew");
  // A panel's field is checked too (under it), and its value saved as typed
  await openTest(page, "refund for a broken item");
  await page.locator("#turn-0 .turn-head .label").click();
  await page.fill("#turnUser", "{{env.missing_one}} please");
  await expect(page.locator("#turnUserProblem")).toContainText("{{env.missing_one}} isn't in the scope");
  await page.fill("#turnUser", "I'm {{env.who}}");
  await expect(page.locator("#turnUserProblem")).toHaveCount(0);
  // With another scope, the same name may not be there
  await page.click("#openSettings");
  await page.click("#settings-tab-environments");
  await newScope(page, "prod");
  await page.click("#envChoose");
  await page.click("#settingsClose");
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("prod");
  await page.locator("#turnUser").fill("I'm {{env.who}} again");
  await expect(page.locator("#turnUserProblem")).toContainText('isn\'t in the scope "prod"');
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
