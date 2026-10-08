// Settings, in its parts (spec/design/components.md, Additions: Settings sections, Segmented choice,
// Settings groups): a provider's fixtures and YAML, each a section that opens and closes (closed, its
// head says what's in it), remembered for every provider, YAML that doesn't parse opening its own;
// the theme as Light, System and Dark side by side; Notifications in groups, a line between them; a
// fixture offered only in the lists its phases name (Settings → Plugins says them), one in a list it
// doesn't run in marked so, and stopping a message to its provider; what a fixture set and that it said
// to stop, on its step; a name it sets isn't "not set".

import { parse } from "yaml";
import { expect, fileText, openYaml, reopen, test, writeFiles } from "./fixtures.js";

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

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

test("Appearance: Light, System and Dark side by side, the one chosen pressed; each applies its theme, System follows the system's", async ({ app: { page } }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.click("#openSettings");
  await page.click("#settings-tab-appearance");
  const group = page.locator("#themeChoice");
  await expect(group).toHaveAttribute("role", "radiogroup");
  await expect(group).toHaveAttribute("aria-labelledby", "themeLabel");
  await expect(page.locator("#themeLabel")).toHaveText("Theme");
  await expect(group.locator("button")).toHaveText(["Light", "System", "Dark"]);
  await expect(group.getByRole("radio")).toHaveCount(3);
  // (the one chosen pressed, the others not)
  const checked = async (id) => {
    for (const other of ["themeLight", "themeSystem", "themeDark"]) await expect(page.locator(`#${other}`)).toHaveAttribute("aria-checked", String(other === id));
  };
  // Nothing chosen yet: the system's
  await checked("themeSystem");
  await expect(page.locator("#themeSystem")).toHaveCSS("background-color", await page.evaluate(() => getComputedStyle(document.body).color));
  await expect(page.locator("#themeSystem")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#themeDark")).toHaveAttribute("tabindex", "-1");
  // Each applies its theme, and is kept
  await page.click("#themeDark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await checked("themeDark");
  expect(await page.evaluate(() => localStorage.getItem("eval.theme"))).toBe("dark");
  await page.click("#themeLight");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await checked("themeLight");
  expect(await page.evaluate(() => localStorage.getItem("eval.theme"))).toBe("light");
  // (Light stays light when the system goes dark)
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // System: the system's, following it as it changes
  await page.click("#themeSystem");
  await checked("themeSystem");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("eval.theme"))).toBe("system");
  // Keys, as a radio group's: the arrows choose the next (round), Home and End the ends
  await page.locator("#themeSystem").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#themeDark")).toBeFocused();
  await expect(page.locator("#themeDark")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#themeLight")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("End");
  await expect(page.locator("#themeDark")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Home");
  await expect(page.locator("#themeLight")).toHaveAttribute("aria-checked", "true");
  // Kept after a reload
  await reopen(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.click("#openSettings");
  await page.click("#settings-tab-appearance");
  await expect(page.locator("#themeLight")).toHaveAttribute("aria-checked", "true");
});

test("Notifications: its settings in groups, each under its name, a line between them; Try it after them, under a line of its own", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-notifications");
  const groups = page.locator("#settingsContent > .settings-block");
  await expect(groups).toHaveCount(4);
  await expect(page.locator("#settingsContent > .settings-block .settings-block-head .label")).toHaveText(["Sound", "For runs that", "System notifications"]);
  // Each its own settings
  for (const [group, ids] of [["notifySoundGroup", ["notifySound", "notifyWhen"]], ["notifyRunsGroup", ["notifyPassed", "notifyFailed"]], ["notifySystemGroup", ["notifySystem", "notifySystemState"]]]) {
    await expect(page.locator(`#${group}`)).toHaveAttribute("aria-labelledby", `${group}Label`);
    for (const id of ids) await expect(page.locator(`#${group} #${id}`)).toHaveCount(1);
  }
  await expect(page.locator("#notifySystemGroup .settings-block-head #notifySystemState")).toBeVisible();
  await expect(groups.last().locator("#notifyTry")).toBeVisible();
  // The line on top of each: the design system's 1px --line, the width of the content
  const lines = await groups.evaluateAll((els) => {
    const probe = document.createElement("div");
    probe.style.color = "var(--line)";
    document.body.append(probe);
    const line = getComputedStyle(probe).color;
    probe.remove();
    return els.map((el) => {
      const s = getComputedStyle(el);
      return { line: s.borderTopWidth === "1px" && s.borderTopStyle === "solid" && s.borderTopColor === line, y: el.getBoundingClientRect().y, width: el.getBoundingClientRect().width };
    });
  });
  expect(lines.every((l) => l.line)).toBe(true);
  // (in order down the pane, each as wide as the others)
  expect(lines.map((l) => l.y)).toEqual([...lines.map((l) => l.y)].sort((a, b) => a - b));
  expect(new Set(lines.map((l) => Math.round(l.width))).size).toBe(1);
  // Still works as before: the settings are saved
  await page.uncheck("#notifySound");
  await expect(page.locator("#notifyWhen")).toBeDisabled();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("eval.notifications")))).toMatchObject({ sound: false });
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
