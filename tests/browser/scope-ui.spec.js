// Scopes as the app has them now (contracts/ui.md, Head; spec/design/components.md, Additions: Scope
// button, Message box problems): the scopes are only the ones made in the app, and the engine is always
// given the one chosen (or none), so environments/<scope>.yml files, the old way, aren't read; deleting a scope deletes all of it, for good (its entry, values and secrets: in the browser's
// storage, and in the desktop app's keystore, after it's started again too); with none chosen, the
// scope button is its icon alone, greyed out, with a small "!"; a provider's problem known before
// sending is said only in the panel, by its fixtures; and the old ways to write a secret or a value,
// ${env:NAME} and {{scope.NAME}}, fill nothing, as a field says.

import { _electron as electron, test as plain } from "@playwright/test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { addScope, addSecret, expect, fileText, reopen, showEntry, test } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NO_SCOPE = "No scope chosen: choose one";

const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
};
const reload = async (page) => {
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
};
const mockLog = async (servers) => (await fetch(`${servers.mock.url}/_log`)).json();
// A colour token as the page computes it (rgb(…))
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);
const style = (locator, prop) => locator.evaluate((el, prop) => getComputedStyle(el)[prop], prop);
const box = async (locator) => {
  const b = await locator.boundingBox();
  return { left: Math.round(b.x), top: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height), width: Math.round(b.width), height: Math.round(b.height) };
};
// What the browser build keeps of the scopes: their names, each one's values, the one chosen, the secrets
const kept = (page) => page.evaluate(() => {
  const scopes = JSON.parse(localStorage.getItem("eval.scopes") ?? "[]");
  const keys = Object.keys(localStorage).filter((k) => k.startsWith("eval.scope.")).sort();
  return { scopes, keys, env: localStorage.getItem("eval.env"), secrets: JSON.parse(localStorage.getItem("eval.secrets") ?? "{}") };
});

test.describe("in the browser build", () => {
  // (from no scope: these make their own)
  test.use({ scope: null });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  /* ---------- the scope button with none chosen ---------- */

  test("with no scope chosen, the scope button is its icon alone, greyed out, with a small ! over its top right corner, and its name says so; with one chosen, its icon and name", async ({ app: { page } }) => {
    const button = page.locator("#scopeButton");
    const alert = page.locator("#scopeAlert");
    await expect(button).toHaveClass(/\bnone\b/);
    await expect(button).toHaveAttribute("data-scope", "");
    // Its name, for screen readers and tests, and its title
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await expect(button).toHaveAttribute("title", NO_SCOPE);
    // No words: the icon and the badge (which the button's name says, so it's hidden from readers)
    await expect(page.locator("#scopeName")).toHaveCount(0);
    await expect(button).toHaveText("!");
    await expect(alert).toHaveAttribute("aria-hidden", "true");
    await expect(button.locator("svg.icon-scope")).toHaveCount(1);
    // Greyed out as a disabled field is, icon and badge together
    expect(await style(page.locator("#scopeIcon"), "opacity")).toBe("0.5");
    // The badge: a 10×10 square over the icon's top right corner, 6px out each way, in the button
    const [icon, mark, whole] = [await box(button.locator("svg.icon-scope")), await box(alert), await box(button)];
    expect([icon.width, icon.height]).toEqual([18, 18]);
    expect([mark.width, mark.height]).toEqual([10, 10]);
    expect(mark.right).toBe(icon.right + 6);
    expect(mark.top).toBe(icon.top - 6);
    expect(mark.right).toBeLessThanOrEqual(whole.right);
    expect(mark.top).toBeGreaterThanOrEqual(whole.top);
    // "!" in --bg on --muted, square, mono 10px; --fg as the button is pointed at
    expect(await style(alert, "backgroundColor")).toBe(await token(page, "--muted"));
    expect(await style(alert, "color")).toBe(await token(page, "--bg"));
    expect(await style(alert, "borderRadius")).toBe("0px");
    expect(await style(alert, "fontSize")).toBe("10px");
    await button.hover();
    await expect.poll(() => style(alert, "backgroundColor")).toBe(await token(page, "--fg"));
    await page.mouse.move(600, 600);
    // In the dark theme too
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await style(alert, "backgroundColor")).toBe(await token(page, "--muted"));
    expect(await style(alert, "color")).toBe(await token(page, "--bg"));
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

    // A scope chosen: its icon and name, no badge, not greyed
    await addScope(page, "stage");
    await expect(button).not.toHaveClass(/\bnone\b/);
    await expect(button).toHaveAttribute("data-scope", "stage");
    await expect(button).toHaveAttribute("aria-label", "Scope: stage. Choose a scope");
    await expect(page.locator("#scopeName")).toHaveText("stage");
    await expect(alert).toHaveCount(0);
    expect(await style(page.locator("#scopeIcon"), "opacity")).toBe("1");
    // None chosen again (Environments' "no scope"): the badge is back, and stays after a reload
    await page.click("#scopeButton");
    await showEntry(page, "");
    await page.click("#envChoose");
    await page.click("#settingsClose");
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await expect(alert).toBeVisible();
    await reload(page);
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await expect(page.locator("#scopeName")).toHaveCount(0);
  });

  /* ---------- a provider's problem, known before sending: in the panel only ---------- */

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

  /* ---------- deleting a scope: all of it, for good ---------- */

  test("Delete scope deletes all of it: its entry, values and secrets, from the scope button, Environments, Secrets and storage; chosen, none is after it; nothing brings it back", async ({ app: { page } }) => {
    // (smoke.hafen.yml has an environment named local: it gives a scope of that name values, and isn't one)
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await addScope(page, "prod", { who: "prod-team" });
    await addScope(page, "local", { who: "local-team" });
    // Its secrets, and others'
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsScope-local")).toHaveClass(/active/);
    await addSecret(page, "LOCAL_KEY", "k-local");
    await showEntry(page, "prod", "secrets");
    await addSecret(page, "PROD_KEY", "k-prod");
    await showEntry(page, "", "secrets");
    await addSecret(page, "SHARED", "s-every");
    await page.click("#settingsClose");
    expect(await kept(page)).toEqual({
      scopes: ["prod", "local"], keys: ["eval.scope.local", "eval.scope.prod"], env: "local",
      secrets: { local: { LOCAL_KEY: "k-local" }, prod: { PROD_KEY: "k-prod" }, "": { SHARED: "s-every" } },
    });
    // Deleted, asking first: the scope chosen
    await page.click("#scopeButton");
    await expect(page.locator("#envScope-local")).toHaveClass(/active/);
    await page.click("#envDelete");
    await expect(page.locator("#envDelete")).toHaveText("delete its values and secrets?");
    await page.click("#envDelete");
    // Gone from Environments, Secrets, the scope button (none chosen now) and storage
    await expect(page.locator("#envScopes .list-open")).toHaveText(["prod"]);
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsScopes .list-open")).toHaveText(["prod"]);
    await page.click("#settingsClose");
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    expect(await kept(page)).toEqual({
      scopes: ["prod"], keys: ["eval.scope.prod"], env: "",
      secrets: { prod: { PROD_KEY: "k-prod" }, "": { SHARED: "s-every" } },
    });
    // Nothing brings it back: a reload, the suites read again (the one whose environment is named local)
    await reload(page);
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await page.click("#scopeButton");
    await expect(page.locator("#envScopes .list-open")).toHaveText(["prod"]);
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsScopes .list-open")).toHaveText(["prod"]);
    await page.click("#settingsClose");
    // Made again, it starts empty: its old values and secrets went with it
    await addScope(page, "local");
    await page.click("#scopeButton");
    await expect(page.locator("#envVar-who")).toHaveCount(0);
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsScope-local")).toHaveClass(/active/);
    await expect(page.locator("#secret-LOCAL_KEY")).toHaveCount(0);
    // Another scope deleted (not the one chosen): the one chosen stays
    await page.click("#settings-tab-environments");
    await showEntry(page, "prod");
    await page.click("#envDelete");
    await page.click("#envDelete");
    await expect(page.locator("#envScopes .list-open")).toHaveText(["local"]);
    await page.click("#settingsClose");
    await expect(page.locator("#scopeName")).toHaveText("local");
    expect((await kept(page)).secrets).toEqual({ "": { SHARED: "s-every" } });
  });

  test("secrets kept for a name the app has no scope of don't make one: the scopes are only the ones made here", async ({ app: { page } }) => {
    await page.evaluate(() => localStorage.setItem("eval.secrets", JSON.stringify({ ghost: { TOKEN: "t-123456" } })));
    await reload(page);
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await page.click("#scopeButton");
    await expect(page.locator("#environmentsEmpty")).toBeVisible();
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsScopes .list-open")).toHaveCount(0);
  });

  /* ---------- scope files, the old way: not read ---------- */

  test("environments/<scope>.yml files (the old way) aren't read: they make no scope, nothing offers to import them, and a scope of the same name made here has only its own values", async ({ app: { page, servers } }) => {
    await writeFile(page, "providers/plain.yml", "kind: http\nurl: \"{{env.base_url}}/json\"\nheaders: { X-Who: \"{{env.who}}\" }\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n");
    await writeFile(page, "plain.hafen.yml", "version: 1\nname: Plain\nprovider: providers/plain.yml\ntests:\n  - name: plain hello\n    id: t_plain001\n    turns:\n      - user: hello\n        expect: [{ type: status, equals: 200 }]\n");
    const old = `base_url: ${servers.mock.url}\nwho: file-team\n`;
    await writeFile(page, "environments/stage.yml", old);
    await openApp(page);
    await expect(page.locator('#suiteList .list-row[data-file="plain.hafen.yml"]')).toHaveCount(1);
    // No scope from it, and no offer to import it
    await expect(page.locator("#scopeImport")).toHaveCount(0);
    await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
    await page.click("#scopeButton");
    await expect(page.locator("#environmentsEmpty")).toBeVisible();
    await expect(page.locator("#envLegacy, #envImportLegacy")).toHaveCount(0);
    await page.click("#settingsClose");
    // A scope made here by the file's name, without base_url: the file doesn't give it one
    await addScope(page, "stage", { who: "app-team" });
    await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
    await page.locator("#suiteList .list-open", { hasText: "plain hello" }).first().click();
    await page.click("#testRun");
    await expect(page.locator(".toast", { hasText: "Couldn't run" })).toContainText("{{env.base_url}} isn't set");
    expect(await mockLog(servers)).toEqual([]);
    // Given one here: the run takes the scope's own values, never the file's
    await page.click("#scopeButton");
    await page.fill("#envVarName", "base_url");
    await page.fill("#envVarValue", servers.mock.url);
    await page.press("#envVarValue", "Enter");
    await expect(page.locator("#envVar-base_url input")).toHaveValue(servers.mock.url);
    await page.click("#settingsClose");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect((await mockLog(servers)).at(-1).headers["x-who"]).toBe("app-team");
    // (the file is left as it was)
    expect(await fileText(page, "environments/stage.yml")).toBe(old);
    expect(await page.evaluate(() => localStorage.getItem("eval.legacyScopes"))).toBeNull();
  });

  /* ---------- the old ways to write a secret or a value ---------- */

  test("an old way to write a secret or a value (${env:NAME}, {{scope.NAME}}) fills nothing: a field says what to write instead, and Secrets doesn't count it as a name the files use", async ({ app: { page } }) => {
    await writeFile(page, "providers/old.yml", "kind: http\nurl: \"http://127.0.0.1:1/json\"\nheaders: { Authorization: \"Bearer ${env:OLD_KEY}\" }\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n");
    await openApp(page);
    await addScope(page, "stage", { who: "stage-team" });
    await page.fill("#input", "hi ${env:API_KEY}");
    await expect(page.locator("#inputProblem")).toHaveText("${env:API_KEY} is the old way to write a secret: write {{secret.API_KEY}}");
    // (even a name the scope has: {{scope.…}} fills nothing now)
    await page.fill("#input", "hi {{scope.who}}");
    await expect(page.locator("#inputProblem")).toHaveText("{{scope.who}} is the old way: write {{env.who}} (a value of the environment) or {{secret.who}} (a secret)");
    await page.fill("#input", "hi {{env.who}}");
    await expect(page.locator("#inputProblem")).toHaveCount(0);
    // Settings → Secrets: OLD_KEY, written the old way, isn't a name the open files use
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsList")).toHaveCount(1);
    await expect(page.locator("#secret-OLD_KEY")).toHaveCount(0);
  });
});

plain.describe("in the desktop app", () => {
  plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

  plain("Delete scope leaves no trace of it in the keystore's secrets.json or the window's storage, and starting the app again doesn't bring it back", async () => {
    const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
    // (the app's workspace, in its data folder: filled before it starts)
    const folder = join(data, "workspace");
    // (smoke.hafen.yml has an environment named local, as the scope deleted is)
    await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
    const env = { ...process.env, HAFEN_LAB_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const secretsFile = () => readFile(join(data, "secrets.json"), "utf8");
    let app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
    try {
      let page = await app.firstWindow();
      await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
      await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
      await addScope(page, "prod", { who: "prod-team" });
      await addScope(page, "local", { who: "local-team" });
      await page.click("#openSettings");
      await page.click("#settings-tab-secrets");
      await expect(page.locator("#secretsScope-local")).toHaveClass(/active/);
      await addSecret(page, "LOCAL_KEY", "k-local-secret");
      await showEntry(page, "prod", "secrets");
      await addSecret(page, "PROD_KEY", "k-prod-secret");
      await page.click("#settingsClose");
      expect(Object.keys(JSON.parse(await secretsFile())).sort()).toEqual(["local", "prod"]);
      // Deleted, asking first
      await page.click("#scopeButton");
      await showEntry(page, "local");
      await page.click("#envDelete");
      await page.click("#envDelete");
      await expect(page.locator("#envScopes .list-open")).toHaveText(["prod"]);
      await page.click("#settingsClose");
      await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
      // No trace: the keystore's file (not even an empty entry), what the main process lists, the window's storage
      expect(Object.keys(JSON.parse(await secretsFile()))).toEqual(["prod"]);
      expect(await secretsFile()).not.toContain("local");
      expect(await page.evaluate(() => window.hafen.invoke("secrets_scopes"))).toEqual(["prod"]);
      expect(await page.evaluate(() => window.hafen.invoke("secrets_list", { env: "local" }))).toEqual({});
      expect(await page.evaluate(() => [localStorage.getItem("eval.scopes"), localStorage.getItem("eval.scope.local"), localStorage.getItem("eval.env")])).toEqual(['["prod"]', null, ""]);
      await app.close();

      // Started again: still gone, everywhere
      app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
      page = await app.firstWindow();
      await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
      await expect(page.getByRole("button", { name: NO_SCOPE })).toBeVisible();
      await page.click("#scopeButton");
      await expect(page.locator("#envScopes .list-open")).toHaveText(["prod"]);
      await page.click("#settings-tab-secrets");
      await expect(page.locator("#secretsScopes .list-open")).toHaveText(["prod"]);
      await page.click("#settingsClose");
      expect(await secretsFile()).not.toContain("local");
      expect(await page.evaluate(() => localStorage.getItem("eval.scopes"))).toBe('["prod"]');
    } finally {
      await app.close();
      await rm(data, { recursive: true, force: true });
    }
  });
});
