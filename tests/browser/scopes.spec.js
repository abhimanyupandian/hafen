// Scopes: only the ones made in the app, made (their names' rules), chosen with the scope button (with
// none, its icon greyed out), renamed and deleted for good, kept in the browser's storage and the desktop
// app's keystore; and what runs, conversations and Copy CI command take from the one chosen.

import { _electron as electron, test as plain } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvText } from "hafen/engine/env-file.js";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addScope, addSecret, chooseScope, expect, fileText, newScope, pickFolder, reopen, showEntry, storedFiles, style, test, token, writeFile } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const reload = async (page) => {
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
};

test.describe("the scope button", () => {
  const SUITE = "smoke.hafen.yml";
  const openApp = async (page) => {
    await reopen(page);
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  };

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test.describe("with no scope made yet", () => {
    test.use({ scope: null });

    test("the scope button names the scope chosen and opens Settings on Environments, where another is chosen", async ({ app: { page } }) => {
      // No scope yet: the button is there all the same (to add one), its icon alone, and its name says so
      await expect(page.locator("#scopeButton")).toBeVisible();
      await expect(page.locator("#scopeButton")).toHaveAttribute("aria-label", "No scope chosen: choose one");
      await expect(page.locator("#scopeButton .scope-name")).toHaveCount(0);
      await expect(page.locator("#scopeButton svg.icon-scope")).toHaveCount(1);
      await expect(page.locator("#envSelect")).toHaveCount(0);
      await page.click("#scopeButton");
      await expect(page.locator("#settingsModal")).toBeVisible();
      await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
      // (scopes are the app's, apart from its suites: one can be added at any time)
      await expect(page.locator("#environmentsEmpty")).toContainText("No scopes yet");
      await expect(page.locator("#newScopeForm")).toBeVisible();
      await page.click("#settingsClose");
      // The suite has an environment (local): it isn't a scope, so none is chosen yet
      await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
      await expect(page.locator("#scopeButton")).toHaveAttribute("aria-label", "No scope chosen: choose one");
      // Made here (local, as the suite's environment is called) and chosen: the button names it
      await addScope(page, "local");
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("local");
      await expect(page.locator("#scopeButton")).toHaveAttribute("title", /Scope: local/);
      // Opened on Environments even when Settings was last left on another pane
      await page.click("#openSettings");
      await page.click("#settings-tab-appearance");
      await page.click("#settingsClose");
      await page.click("#scopeButton");
      await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#envScope-local")).toHaveClass(/active/);
      await expect(page.locator("#envChosen")).toHaveText("chosen now");
      // A new scope, chosen there: the button follows, and keeps it after a reload
      await newScope(page, "stage");
      await page.click("#envChoose");
      await expect(page.locator("#envChosen")).toBeVisible();
      await page.click("#settingsClose");
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
      await page.reload();
      await page.locator("html:not(.loading)").waitFor();
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
      // Back to the first, with the helper the other tests use
      await chooseScope(page, "local");
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("local");
      // Keyboard: it's a button like any other
      await page.locator("#scopeButton").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(page.locator("#settingsModal")).toBeHidden();
    });

    test("with no scope chosen before, the first scope made in the app is chosen when the app starts; secrets kept for another name don't make one", async ({ app: { page } }) => {
      await page.evaluate(() => {
        localStorage.setItem("eval.scopes", JSON.stringify(["prod", "stage"]));
        localStorage.setItem("eval.secrets", JSON.stringify({ ghost: { TOKEN: "t-123456" } }));
      });
      await page.reload();
      await page.locator("html:not(.loading)").waitFor();
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("prod");
      await page.click("#scopeButton");
      await expect(page.locator("#envScopes .list-open")).toHaveText(["prod", "stage"]);
    });
  });

  test("the scope chosen last is chosen again", async ({ app: { page } }) => {
    await openApp(page);
    // (prod made last, and so chosen last: not the first there is)
    await addScope(page, "stage");
    await addScope(page, "prod");
    await page.reload();
    await page.locator("html:not(.loading)").waitFor();
    await expect(page.locator("#scopeButton .scope-name")).toHaveText("prod");
  });
});

test.describe("a new scope's name", () => {
  const SUITE = "smoke.hafen.yml";

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test.describe("with no scope made yet", () => {
    test.use({ scope: null });
    test("a new scope's name: letters, digits, '.', '-' and '_', and not one there is (nor Globals'): else refused, said under the form, and nothing made", async ({ app: { page } }) => {
      await page.click("#scopeButton");
      await page.locator("#newScopeName").waitFor();
      for (const bad of ["my scope", "stage!", "-stage", ".hidden"]) {
        await page.fill("#newScopeName", bad);
        await page.click("#newScopeForm button[type=submit]");
        await expect(page.locator("#newScopeProblem")).toHaveText("A scope's name is letters, digits, '.', '-' and '_'.");
      }
      await expect(page.locator("#environmentsEmpty")).toBeVisible();
      await page.fill("#newScopeName", "stage-2.eu_1");
      await page.click("#newScopeForm button[type=submit]");
      await expect(page.locator('[id="envScope-stage-2.eu_1"]')).toHaveClass(/active/);
      await page.click("#newScope");
      await page.fill("#newScopeName", "stage-2.eu_1");
      await page.click("#newScopeForm button[type=submit]");
      await expect(page.locator("#newScopeProblem")).toHaveText('There\'s a scope "stage-2.eu_1" already.');
      expect(await page.evaluate(() => localStorage.getItem("eval.scopes"))).toBe('["stage-2.eu_1"]');
    });
  });
});

// The scopes are only the ones made in the app, and the engine is always given the one chosen (or
// none); deleting a scope deletes all of it, for good (its entry, values and secrets: in the browser's
// storage, and in the desktop app's keystore, after it's started again too).
test.describe("none chosen, and deleted for good", () => {
  const NO_SCOPE = "No scope chosen: choose one";

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
  });

  plain.describe("in the desktop app", () => {
    plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

    plain("Delete scope leaves no trace of it in the keystore's secrets.json or the window's storage, and starting the app again doesn't bring it back", async () => {
      const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
      // (the app's workspace, in its data folder: filled before it starts)
      const folder = join(data, "workspace");
      // (smoke.hafen.yml has an environment named local, as the scope deleted is)
      await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
      const env = { ...process.env, HAFEN_DATA: data };
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
});

// Scopes as the app keeps them (contracts/ui.md, Settings → Environments and Secrets; the scope
// button): any number, each a name, its values (localStorage, a key a scope) and its secrets (the desktop
// app's keystore, encrypted; the browser build's storage), swapped with the scope button. Runs and
// conversations take the one chosen now, and a name it hasn't got is an error, said where it happened.
test.describe("made, kept, and taken by runs", () => {
  // A provider and a suite that take everything from the scope: its values as {{env.…}}, its secrets as
  // {{secret.…}} and {{secrets.…}}
  const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}", X-Who: "{{env.who}}", X-Alias: "{{secrets.ALIAS}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const SUITE = `version: 1
name: Stored
provider: providers/stored.yml
tests:
  - name: stored hello
    id: t_stored01
    turns:
      - user: "hello {{env.who}}"
        expect: [{ type: status, equals: 200 }]
`;

  const FILES = { "providers/stored.yml": PROVIDER, "stored.hafen.yml": SUITE };

  // Each scope's values and secrets ("" holds Globals' secrets: prod's ALIAS is that one)
  const values = (mockUrl) => ({ stage: { base_url: mockUrl, who: "stage-team" }, prod: { base_url: mockUrl, who: "prod-team" }, qa: { base_url: mockUrl, who: "qa-team" } });
  const SECRETS = { "": { ALIAS: "a-every" }, stage: { API_KEY: "k-stage", ALIAS: "a-stage" }, prod: { API_KEY: "k-prod" } };
  const sentIn = (scope, message) => ({ auth: `Bearer k-${scope}`, who: `${scope}-team`, alias: scope === "stage" ? "a-stage" : "a-every", message });

  const lastSent = async (mockUrl) => {
    const last = (await (await fetch(`${mockUrl}/_log`)).json()).at(-1);
    return last && { auth: last.headers.authorization, who: last.headers["x-who"], alias: last.headers["x-alias"], message: last.body?.message };
  };

  const openApp = async (page, files = FILES) => {
    for (const [path, text] of Object.entries(files)) await writeFile(page, path, text);
    await reopen(page);
    await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  };
  const kept = (page) => page.evaluate(() => {
    const scopes = JSON.parse(localStorage.getItem("eval.scopes") ?? "[]");
    return { scopes, values: Object.fromEntries(scopes.map((s) => [s, JSON.parse(localStorage.getItem(`eval.scope.${s}`) ?? "null")])), secrets: JSON.parse(localStorage.getItem("eval.secrets") ?? "{}") };
  });
  // The scopes, their values and secrets, as the app keeps them in the browser build
  const seed = (page, mockUrl, { scopes = ["stage", "prod", "qa"], secrets = SECRETS, env } = {}) => page.evaluate(([all, scopes, secrets, env]) => {
    localStorage.setItem("eval.scopes", JSON.stringify(scopes));
    for (const s of scopes) localStorage.setItem(`eval.scope.${s}`, JSON.stringify(all[s]));
    localStorage.setItem("eval.secrets", JSON.stringify(secrets));
    if (env !== undefined) localStorage.setItem("eval.env", env);
  }, [values(mockUrl), scopes, secrets, env]);
  const openEnvironments = async (page) => {
    await page.click("#scopeButton");
    await expect(page.locator("#settings-tab-environments")).toHaveAttribute("aria-selected", "true");
  };
  const addValue = async (page, name, value) => {
    await page.fill("#envVarName", name);
    await page.fill("#envVarValue", value);
    await page.press("#envVarValue", "Enter");
    await expect(page.locator(`#envVar-${name} input`)).toHaveValue(value);
  };
  const runTest = async (page, status = "passed 1/1") => {
    await page.locator("#suiteList .list-open", { hasText: "stored hello" }).first().click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText(status);
  };
  const send = async (page, text) => {
    await page.fill("#input", text);
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
  };
  const download = async (page, click) => {
    const [file] = await Promise.all([page.waitForEvent("download"), click()]);
    return { name: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
  };
  const envFile = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  const noScope = (page) => expect(page.locator("#scopeButton")).toHaveAttribute("aria-label", "No scope chosen: choose one");

  test.describe("in the browser build", () => {
    // (from no scope: these make or seed their own)
    test.use({ scope: null });
    test.afterEach(async ({ app: { errors } }) => {
      expect(errors).toEqual([]);
    });

    test("scopes are made, given values, renamed and deleted in Settings → Environments, with no folder open; each scope's values are kept apart, and stay after a reload", async ({ app: { page } }) => {
      await noScope(page);
      await openEnvironments(page);
      await expect(page.locator("#environmentsEmpty")).toBeVisible();
      // No folder needed: a scope is the app's
      await page.fill("#newScopeName", "stage");
      await page.click("#newScopeForm button[type=submit]");
      await expect(page.locator("#envScope-stage")).toHaveClass(/active/);
      await expect(page.locator("#envVarsEmpty")).toBeVisible();
      await addValue(page, "base_url", "https://stage.example");
      await addValue(page, "who", "stage-team");
      await expect(page.locator("#envVar-who .vars-use")).toHaveText("{{env.who}} · not used by the open files");
      await newScope(page, "prod");
      await expect(page.locator("#envVars .vars-row:not(.vars-add)")).toHaveCount(0);
      await addValue(page, "who", "prod-team");
      // A name that won't do is refused, and said why
      await page.fill("#envVarName", "2nd");
      await page.fill("#envVarValue", "x");
      await page.press("#envVarValue", "Enter");
      await expect(page.locator("#environmentsError")).toContainText("not starting with a digit");
      // A value changed in place, and one deleted (asking first)
      await showEntry(page, "stage");
      await page.locator("#envVar-who input").fill("stage-crew");
      await page.locator("#envVar-who input").press("Enter");
      await page.click("#envVar-base_url-delete");
      await expect(page.locator("#envVar-base_url-delete")).toHaveText("delete");
      await page.click("#envVar-base_url-delete");
      await expect(page.locator("#envVar-base_url")).toHaveCount(0);
      expect(await kept(page)).toEqual({ scopes: ["stage", "prod"], values: { stage: { who: "stage-crew" }, prod: { who: "prod-team" } }, secrets: {} });
      // Chosen, and still there after a reload, as the scope button says
      await page.click("#envChoose");
      await expect(page.locator("#envChosen")).toHaveText("chosen now");
      await page.click("#settingsClose");
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
      await reload(page);
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
      await openEnvironments(page);
      await expect(page.locator("#envScope-stage")).toHaveClass(/active/);
      await expect(page.locator("#envVar-who input")).toHaveValue("stage-crew");
      // Renamed: its values (and secrets) go with it, and it stays chosen
      await page.fill("#envScopeName", "staging");
      await page.press("#envScopeName", "Enter");
      await expect(page.locator("#envScope-staging")).toHaveClass(/active/);
      await expect(page.locator("#envChosen")).toBeVisible();
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("staging");
      expect(await kept(page)).toEqual({ scopes: ["staging", "prod"], values: { staging: { who: "stage-crew" }, prod: { who: "prod-team" } }, secrets: {} });
      expect(await page.evaluate(() => localStorage.getItem("eval.scope.stage"))).toBeNull();
      // A name that's taken is refused, and put back
      await page.fill("#envScopeName", "prod");
      await page.press("#envScopeName", "Enter");
      await expect(page.locator("#environmentsError")).toContainText('There\'s a scope "prod" already');
      await expect(page.locator("#envScopeName")).toHaveValue("staging");
      // "no scope" can be chosen too
      await showEntry(page, "");
      await expect(page.locator("#envChoose")).toHaveText("choose no scope");
      await page.click("#envChoose");
      await noScope(page);
      await reload(page);
      await noScope(page);
      // Deleted, asking first: its values go
      await openEnvironments(page);
      await showEntry(page, "prod");
      await page.click("#envDelete");
      await expect(page.locator("#envDelete")).toHaveText("delete its values and secrets?");
      await page.click("#envDelete");
      await expect(page.locator("#envScopes .list-open")).toHaveText(["staging"]);
      expect(await kept(page)).toEqual({ scopes: ["staging"], values: { staging: { who: "stage-crew" } }, secrets: {} });
      expect(await page.evaluate(() => localStorage.getItem("eval.scope.prod"))).toBeNull();
    });

    test("a scope with only secrets (no values) can be deleted, after a confirm; so can the scope chosen", async ({ app: { page } }) => {
      await page.evaluate(() => {
        localStorage.setItem("eval.scopes", JSON.stringify(["qa", "prod"]));
        localStorage.setItem("eval.secrets", JSON.stringify({ "": { SHARED: "s" }, qa: { TOKEN: "t-qa" }, prod: { TOKEN: "t-prod" } }));
      });
      await reload(page);
      await openEnvironments(page);
      // (the first scope made is chosen as the app starts, none having been chosen before)
      await expect(page.locator("#envScope-qa")).toHaveClass(/active/);
      await expect(page.locator("#envChosen")).toBeVisible();
      // (no values of its own: it's deletable all the same)
      await expect(page.locator("#envVarsEmpty")).toBeVisible();
      await page.click("#envDelete");
      await expect(page.locator("#envDelete")).toHaveText("delete its values and secrets?");
      // Moving away cancels
      await page.locator("#envScopeName").hover();
      await expect(page.locator("#envDelete")).toHaveText("Delete scope");
      expect(Object.keys((await kept(page)).secrets).sort()).toEqual(["", "prod", "qa"]);
      await page.click("#envDelete");
      await page.click("#envDelete");
      await expect(page.locator("#envScopes .list-open")).toHaveText(["prod"]);
      expect((await kept(page)).secrets).toEqual({ "": { SHARED: "s" }, prod: { TOKEN: "t-prod" } });
      // It was chosen: now none is
      await noScope(page);
    });

    test("forgetting a secret, and System One's key, asks first", async ({ app: { page } }) => {
      await openApp(page);
      await page.click("#openSettings");
      await page.click("#settings-tab-secrets");
      await showEntry(page, "", "secrets");
      await page.fill("#secretName", "SHOP_TOKEN");
      await page.fill("#secretValue", "every");
      await page.press("#secretValue", "Enter");
      await expect(page.locator("#secret-SHOP_TOKEN .vars-use")).toHaveText("{{secret.SHOP_TOKEN}} · not used by the open files");
      await expect(page.locator("#secret-SHOP_TOKEN .vars-source")).toHaveText("Globals");
      await page.click("#secret-SHOP_TOKEN-forget");
      await expect(page.locator("#secret-SHOP_TOKEN-forget")).toHaveText("forget it?");
      await expect(page.locator("#secret-SHOP_TOKEN .vars-source")).toHaveText("Globals");
      expect((await kept(page)).secrets).toEqual({ "": { SHOP_TOKEN: "every" } });
      await page.click("#secret-SHOP_TOKEN-forget");
      await expect(page.locator("#secret-SHOP_TOKEN")).toHaveCount(0);
      expect((await kept(page)).secrets).toEqual({ "": {} });
      // System One's
      await page.click("#settings-tab-systemone");
      await page.fill("#systemoneKey", "jev-test-key");
      await page.click("#systemoneSave");
      await expect(page.locator("#systemoneKeyState")).toHaveText("set");
      await page.click("#systemoneForget");
      await expect(page.locator("#systemoneForget")).toHaveText("forget it?");
      await expect(page.locator("#systemoneKeyState")).toHaveText("set");
      await page.click("#systemoneForget");
      await expect(page.locator("#systemoneKeyState")).toHaveText("not set");
    });

    test("a scope's values and secrets are imported from .env files and exported to them (secrets only after saying they're written in plain text)", async ({ app: { page } }) => {
      await openEnvironments(page);
      await page.fill("#newScopeName", "stage");
      await page.click("#newScopeForm button[type=submit]");
      await addValue(page, "keep", "kept");
      // Import: each name the file has is set; the others stay
      await page.setInputFiles("#envImportFile", envFile("stage.env", "# staging\nbase_url=https://stage.example/#top\nexport REGION=eu\ngreeting=\"Hello, \\\"you\\\"\"\ndb.host = db.internal  # the database\n"));
      await expect(page.locator("#envVar-REGION input")).toHaveValue("eu");
      expect((await kept(page)).values.stage).toEqual({ keep: "kept", base_url: "https://stage.example/#top", REGION: "eu", greeting: "Hello, \"you\"", "db.host": "db.internal" });
      // A file that isn't one says why, and changes nothing
      await page.setInputFiles("#envImportFile", envFile("bad.env", "fine=1\nthis is not a line\n"));
      await expect(page.locator("#environmentsError")).toHaveText("bad.env: line 2 isn't NAME=value. Nothing was changed.");
      expect((await kept(page)).values.stage).not.toHaveProperty("fine");
      // Export: <scope>.env, which reads back the same
      const out = await download(page, () => page.click("#envExport"));
      expect(out.name).toBe("stage.env");
      expect(parseEnvText(out.text)).toMatchObject({ errors: [], values: (await kept(page)).values.stage });
      // Edited as a whole: what's taken out goes
      await page.click("#envText");
      await expect(page.locator("#editorText")).toHaveValue(/^keep=kept\n/);
      await page.fill("#editorText", "keep=changed\nREGION=us\n");
      await page.click("#editorSave");
      await expect(page.locator("#envVar-keep input")).toHaveValue("changed");
      expect((await kept(page)).values.stage).toEqual({ keep: "changed", REGION: "us" });
      // Secrets: imported into Globals and the scope, and the scope's own exported, after a confirm
      await page.click("#settings-tab-secrets");
      await showEntry(page, "", "secrets");
      await page.setInputFiles("#secretsImportFile", envFile("every.secret.env", "ALIAS=a-every\n"));
      await expect(page.locator("#secret-ALIAS .vars-source")).toHaveText("Globals");
      await showEntry(page, "stage", "secrets");
      await page.setInputFiles("#secretsImportFile", envFile("stage.secret.env", "API_KEY=k-stage\nPASSWORD='p a#ss'\n"));
      await expect(page.locator("#secret-API_KEY .vars-source")).toHaveText("this scope");
      await expect(page.locator("#secret-ALIAS .vars-source")).toHaveText("from Globals");
      // (values never shown)
      await expect(page.locator("#secret-API_KEY input")).toHaveValue("");
      await expect(page.locator("#secret-API_KEY input")).toHaveAttribute("type", "password");
      expect((await kept(page)).secrets).toEqual({ "": { ALIAS: "a-every" }, stage: { API_KEY: "k-stage", PASSWORD: "p a#ss" } });
      // A secret's name that won't do: nothing is imported (a dotted one does: the engine's names)
      await page.setInputFiles("#secretsImportFile", envFile("bad.secret.env", "GOOD=1\n2nd=x\n"));
      await expect(page.locator("#secretsError")).toContainText("not starting with a digit");
      expect((await kept(page)).secrets.stage).not.toHaveProperty("GOOD");
      await expect(page.locator("#secretsExport")).toHaveAttribute("title", "Write stage.secret.env, in plain text");
      await page.click("#secretsExport");
      await expect(page.locator("#secretsExport")).toHaveText("write them in plain text?");
      const secrets = await download(page, () => page.click("#secretsExport"));
      expect(secrets.name).toBe("stage.secret.env");
      expect(secrets.text).toContain("plain text");
      // (the scope's own: Globals' go in globals.secret.env, read before it)
      expect(parseEnvText(secrets.text)).toMatchObject({ errors: [], values: { API_KEY: "k-stage", PASSWORD: "p a#ss" } });
    });

    test("a run and a conversation take the scope chosen now: its {{env.…}} values and {{secret.…}} secrets (Globals' where it has none); one it hasn't got is an error, said where it happened", async ({ app: { page, servers } }) => {
      await seed(page, servers.mock.url);
      await openApp(page);
      await chooseScope(page, "stage");
      await runTest(page);
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("stage", "hello stage-team"));
      await chooseScope(page, "prod");
      await runTest(page);
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("prod", "hello prod-team"));
      // A conversation: the message box takes them too, and a switch applies from the next message
      await page.click("#newConversation");
      await page.selectOption("#convProvider", "providers/stored.yml");
      await send(page, "one {{env.who}}");
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("prod", "one prod-team"));
      await chooseScope(page, "stage");
      await send(page, "two {{env.who}}");
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("stage", "two stage-team"));
      await expect(page.locator("#turn-1-reply .msg-body")).toContainText("You said: two stage-team");
      // A value changed in Settings applies from the next message
      await openEnvironments(page);
      await page.locator("#envVar-who input").fill("stage-crew");
      await page.locator("#envVar-who input").press("Enter");
      await page.click("#settingsClose");
      await send(page, "three");
      expect(await lastSent(servers.mock.url)).toEqual({ ...sentIn("stage", "three"), who: "stage-crew" });
      // qa has no API_KEY: nothing is sent, and the turn says why
      await chooseScope(page, "qa");
      await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
      await send(page, "four");
      await expect(page.locator("#turn-3")).toContainText('{{secret.API_KEY}} isn\'t set for the scope "qa"');
      await expect(page.locator("#turn-3")).toContainText("error");
      // A run: refused before anything is sent, and said so (its toast, the console)
      await page.locator("#suiteList .list-open", { hasText: "stored hello" }).first().click();
      await page.click("#testRun");
      await expect(page.locator(".toast", { hasText: "Couldn't run" })).toContainText('{{secret.API_KEY}} isn\'t set for the scope "qa"');
      expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
      // As the fields say before anything is run
      await page.locator("#suiteList .list-open", { hasText: "stored hello" }).first().click();
      await page.fill("#input", "and {{secret.API_KEY}} {{env.nope}}");
      await expect(page.locator("#inputProblem")).toHaveText('{{env.nope}} isn\'t in the scope "qa" or in Globals: add it in Settings → Environments');
      await page.fill("#input", "and {{secret.API_KEY}}");
      await expect(page.locator("#inputProblem")).toHaveText('{{secret.API_KEY}} isn\'t a secret of the scope "qa" or of Globals: add it in Settings → Secrets');
    });

    test("Copy CI command runs the folder the suite was exported to, with exactly the .env files written beside it (none, when none was); the new provider's address takes a template", async ({ app: { page } }) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await seed(page, "http://127.0.0.1:1", { env: "stage" });
      await openApp(page);
      await page.locator('#suiteList .list-row[data-file="stored.hafen.yml"] .list-open').first().click();
      // Not exported yet: it says so, and Copy CI command offers Export instead
      await expect(page.locator("#suiteCiHint")).toHaveText("Not exported yet: CI runs the folder it's exported to. Export it first.");
      await page.click("#suiteCopyCi");
      await expect(page.locator("#exportDialog")).toBeVisible();
      await page.click("#exportCancel");
      // Exported without the scope's values: the command names no file (none was written), and the hint says
      // CI would run without them
      await pickFolder(page, "ci-out");
      await page.click("#suiteCiHintExport");
      await page.uncheck("#exportEnv");
      await page.click("#exportGo");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      await page.click("#suiteCopyCi");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx hafen run "ci-out" --report junit:results/junit.xml --report run:results/run.hafen-run.json');
      await expect(page.locator("#suiteCiHint")).toHaveText("Runs ci-out, exported just now: export again after a change. No .env file went with it: CI runs without your values, unless you export them too.");
      // Exported with them: stage.env beside the suite (Globals has none: no globals.env), which it names there
      await page.click("#suiteExport");
      await page.click("#exportGo");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      const out = await storedFiles(page, "ci-out");
      expect(parseEnvText(out["stage.env"]).values).toEqual({ base_url: "http://127.0.0.1:1", who: "stage-team" });
      expect(out["globals.env"]).toBeUndefined();
      await page.click("#suiteCopyCi");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx hafen run "ci-out" --env ci-out/stage.env --report junit:results/junit.xml --report run:results/run.hafen-run.json');
      await expect(page.locator("#suiteCiHint")).toHaveText("Runs ci-out, exported just now with stage.env: export again after a change.");
      await page.locator("#suiteList .list-open", { hasText: "stored hello" }).first().click();
      await page.click("#testCopyCi");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx hafen run "ci-out" --env ci-out/stage.env --test "stored hello" --report junit:results/junit.xml --report run:results/run.hafen-run.json');
      // A provider's address, URL and model take templates as any field does
      await page.click("#openSettings");
      await page.click("#settings-tab-providers");
      await page.click("#newProvider");
      await page.selectOption("#newProviderKind", "openai-chat");
      await expect(page.locator("#newProviderKey")).toContainText("{{secret.OPENAI_API_KEY}}");
      await page.fill("#newProviderName", "templated");
      await page.fill("#newProviderBase", "{{env.base_url}}/v1");
      await page.fill("#newProviderModel", "{{env.model}}");
      await expect(page.locator("#newProviderModelProblem")).toContainText('{{env.model}} isn\'t in the scope "stage"');
      await page.click("#newProviderCreate");
      await expect(page.locator("#providerName")).toHaveValue("templated");
      expect(await fileText(page, "providers/templated.yml")).toContain("{{env.base_url}}/v1");
      await page.click("#providersBack");
      await page.click("#newProvider");
      await page.selectOption("#newProviderKind", "http");
      await expect(page.locator("#newProviderUrl")).toHaveAttribute("placeholder", "{{env.base_url}}/chat");
      await page.fill("#newProviderName", "templated-http");
      await page.fill("#newProviderUrl", "{{env.base_url}}/chat");
      await page.click("#newProviderCreate");
      await expect(page.locator("#providerName")).toHaveValue("templated-http");
      expect(await fileText(page, "providers/templated-http.yml")).toContain("{{env.base_url}}/chat");
    });
  });

  plain.describe("in the desktop app", () => {
    plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

    plain("scopes' values (the window's storage) and secrets (the system's keystore, encrypted) per scope: made in Settings, used by runs as the scope changes, kept when the app starts again, exported only on purpose; forgetting and deleting ask first", async () => {
      const mock = await startMock({ chunkMs: 10 });
      const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
      // (the app's workspace, in its data folder: filled before it starts)
      const folder = join(data, "workspace");
      const out = await mkdtemp(join(tmpdir(), "hafen-out-"));
      await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
      await mkdir(join(folder, "providers"), { recursive: true });
      for (const [path, text] of Object.entries(FILES)) await writeDisk(join(folder, path), text);
      const env = { ...process.env, HAFEN_DATA: data };
      delete env.ELECTRON_RUN_AS_NODE;
      let app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
      try {
        let page = await app.firstWindow();
        await expect(page.locator('#suiteList .list-row[data-file="stored.hafen.yml"]')).toHaveCount(1);
        // Each scope, its values and its secrets, made in Settings
        for (const scope of ["stage", "prod"]) {
          await page.click("#scopeButton");
          await newScope(page, scope);
          await addValue(page, "base_url", mock.url);
          await addValue(page, "who", `${scope}-team`);
          await page.click("#settings-tab-secrets");
          await showEntry(page, scope, "secrets");
          for (const [name, value] of Object.entries(SECRETS[scope])) await addSecret(page, name, value);
          await page.click("#settingsClose");
        }
        await page.click("#openSettings");
        await page.click("#settings-tab-secrets");
        await showEntry(page, "", "secrets");
        await addSecret(page, "ALIAS", "a-every");
        await page.click("#settingsClose");
        await chooseScope(page, "stage");
        await runTest(page);
        expect(await lastSent(mock.url)).toEqual(sentIn("stage", "hello stage-team"));
        await chooseScope(page, "prod");
        await runTest(page);
        expect(await lastSent(mock.url)).toEqual(sentIn("prod", "hello prod-team"));
        // Kept encrypted: the file has no value as it was typed
        const stored = await readFile(join(data, "secrets.json"), "utf8");
        expect(Object.keys(JSON.parse(stored)).sort()).toEqual(["", "prod", "stage"]);
        for (const value of ["k-stage", "k-prod", "a-stage", "a-every"]) expect(stored).not.toContain(value);
        // The values, in the window's storage, one key a scope
        expect(await page.evaluate(() => [localStorage.getItem("eval.scopes"), JSON.parse(localStorage.getItem("eval.scope.prod"))])).toEqual(['["stage","prod"]', { base_url: mock.url, who: "prod-team" }]);
        // Exported only after saying it's plain text: the main process writes the file (asked where)
        const target = join(out, "prod.secret.env");
        await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, target);
        await page.click("#openSettings");
        await page.click("#settings-tab-secrets");
        await showEntry(page, "prod", "secrets");
        await page.click("#secretsExport");
        await expect(page.locator("#secretsExport")).toHaveText("write them in plain text?");
        await page.click("#secretsExport");
        await expect.poll(() => readFile(target, "utf8").catch(() => "")).toContain("API_KEY=k-prod");
        // (the scope's own: Globals' ALIAS goes in globals.secret.env)
        expect(parseEnvText(await readFile(target, "utf8")).values).toEqual({ API_KEY: "k-prod" });
        if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o600);
        // Forgetting asks first
        await page.click("#secret-API_KEY-forget");
        await expect(page.locator("#secret-API_KEY")).toHaveAttribute("data-source", "own");
        await page.click("#secret-API_KEY-forget");
        await expect(page.locator("#secret-API_KEY .vars-source")).toHaveText("not set");
        await page.locator("#secret-API_KEY input").fill("k-prod-2");
        await page.locator("#secret-API_KEY input").press("Enter");
        await expect(page.locator("#secret-API_KEY")).toHaveAttribute("data-source", "own");
        await page.click("#settingsClose");
        await app.close();

        // Started again: the scope chosen, its values and secrets
        app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
        page = await app.firstWindow();
        await expect(page.locator('#suiteList .list-row[data-file="stored.hafen.yml"]')).toHaveCount(1);
        await expect(page.locator("#scopeButton .scope-name")).toHaveText("prod");
        await runTest(page);
        expect(await lastSent(mock.url)).toEqual({ ...sentIn("prod", "hello prod-team"), auth: "Bearer k-prod-2" });
        // A scope deleted (asking first): its values and its secrets go, from the keystore too
        await page.click("#scopeButton");
        await showEntry(page, "stage");
        await page.click("#envDelete");
        await page.click("#envDelete");
        // (the fixture suite's own environment, local, isn't a scope)
        await expect(page.locator("#envScopes .list-open")).toHaveText(["prod"]);
        expect(await page.evaluate(() => window.hafen.invoke("secrets_scopes"))).toEqual(expect.not.arrayContaining(["stage"]));
        expect(Object.keys(JSON.parse(await readFile(join(data, "secrets.json"), "utf8"))).sort()).toEqual(["", "prod"]);
      } finally {
        await app.close();
        await mock.close();
        for (const d of [data, out]) await rm(d, { recursive: true, force: true });
      }
    });
  });
});

// The scope chosen with the scope button reaching the endpoint (contracts/test-file.md, Scopes): its
// values, its secrets and each suite's environment of its name, as {{env.NAME}}, {{secret.NAME}} and
// {{NAME}}: in a conversation as the scope changes, in a test's run and a suite's, after a secret is
// changed, after a reload; and in the desktop app, after it's started again.
test.describe("the scope chosen, reaching the endpoint", () => {
  // A provider that takes something from each: the scope's environment values and secrets, and the
  // suite's environment
  const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}", X-Env: "{{secret.ENV_TOKEN}}", X-Tier: "{{tier}}", X-Who: "{{env.who}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const SUITE = `version: 1
name: Scoped
provider: providers/scoped.yml
environments:
  stage: { tier: s-stage }
  prod: { tier: s-prod }
tests:
  - name: scoped hello
    id: t_scoped01
    turns:
      - user: "hello {{env.who}}"
        expect: [{ type: status, equals: 200 }]
`;

  const FILES = { "providers/scoped.yml": PROVIDER, "scoped.hafen.yml": SUITE };

  // Each scope's environment values, and its secrets
  const values = (mockUrl) => ({ stage: { base_url: mockUrl, who: "stage-team" }, prod: { base_url: mockUrl, who: "prod-team" } });
  const SECRETS = { stage: { API_KEY: "k-stage", ENV_TOKEN: "e-stage" }, prod: { API_KEY: "k-prod", ENV_TOKEN: "e-prod" } };
  // What each scope's request carries
  const sentIn = (scope, message) => ({ auth: `Bearer k-${scope}`, env: `e-${scope}`, tier: `s-${scope}`, who: `${scope}-team`, message });

  // The mock's last request, as these tests look at it
  const lastSent = async (mockUrl) => {
    const last = (await (await fetch(`${mockUrl}/_log`)).json()).at(-1);
    return last && { auth: last.headers.authorization, env: last.headers["x-env"], tier: last.headers["x-tier"], who: last.headers["x-who"], message: last.body?.message };
  };

  const send = async (page, text) => {
    await page.fill("#input", text);
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
  };

  // Each scope made in Settings → Environments, with its values (the last made is chosen)
  const makeScopes = async (page, mockUrl) => {
    for (const [scope, own] of Object.entries(values(mockUrl))) await addScope(page, scope, own);
  };

  const runTest = async (page) => {
    await page.locator("#suiteList .list-open", { hasText: "scoped hello" }).first().click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
  };

  test.describe("in the browser build", () => {
    const openApp = async (page) => {
      for (const [path, text] of Object.entries(FILES)) await writeFile(page, path, text);
      await reopen(page);
      await expect(page.locator('#suiteList .list-row[data-file="scoped.hafen.yml"]')).toHaveCount(1);
    };

    test.afterEach(async ({ app: { errors } }) => {
      expect(errors).toEqual([]);
    });

    test("a conversation carries on in the scope chosen now: its values, the secrets set in Settings for it, and the suite's environment of its name", async ({ app: { page, servers } }) => {
      await openApp(page);
      await makeScopes(page, servers.mock.url);
      // Each scope's secrets, set in Settings → Secrets with the folder open
      await page.click("#openSettings");
      await page.click("#settings-tab-secrets");
      for (const [scope, values] of Object.entries(SECRETS)) {
        await showEntry(page, scope, "secrets");
        for (const [name, value] of Object.entries(values)) await addSecret(page, name, value);
      }
      // (API_KEY, which the files use as {{secret.API_KEY}}, isn't said to be unused by them)
      await expect(page.locator("#secret-API_KEY .vars-use")).toHaveText("{{secret.API_KEY}}");
      await page.click("#settingsClose");
      await chooseScope(page, "stage");
      await page.selectOption("#convProvider", "providers/scoped.yml");
      await send(page, "one {{env.who}}");
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("stage", "one stage-team"));
      // Another scope, the same conversation: the next message is all that scope's
      await chooseScope(page, "prod");
      await send(page, "two {{env.who}}");
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("prod", "two prod-team"));
      await expect(page.locator("#turn-1-reply .msg-body")).toContainText("You said: two prod-team");
      // And back
      await chooseScope(page, "stage");
      await send(page, "three");
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("stage", "three"));
    });

    test("a test's run and a suite's use the scope chosen now, a secret changed in Settings, and the scope chosen before a reload", async ({ app: { page, servers } }) => {
      // (the scopes, their values and secrets, as the app keeps them in the browser build)
      await page.evaluate(([all, secrets]) => {
        localStorage.setItem("eval.scopes", JSON.stringify(Object.keys(all)));
        for (const [scope, own] of Object.entries(all)) localStorage.setItem(`eval.scope.${scope}`, JSON.stringify(own));
        localStorage.setItem("eval.secrets", JSON.stringify(secrets));
      }, [values(servers.mock.url), SECRETS]);
      await openApp(page);
      await chooseScope(page, "prod");
      await runTest(page);
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("prod", "hello prod-team"));
      await chooseScope(page, "stage");
      await runTest(page);
      expect(await lastSent(servers.mock.url)).toEqual(sentIn("stage", "hello stage-team"));
      await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
      await page.locator('#suiteList .list-row[data-file="scoped.hafen.yml"] .list-open').first().click();
      await page.click("#suiteRun");
      await expect.poll(() => lastSent(servers.mock.url)).toEqual(sentIn("stage", "hello stage-team"));
      await expect(page.locator("#suiteRun")).toHaveText("Run suite");
      // A secret changed in Settings → Secrets: the next run has it (the folder isn't opened again)
      await page.click("#openSettings");
      await page.click("#settings-tab-secrets");
      await showEntry(page, "stage", "secrets");
      await page.locator("#secret-API_KEY input").fill("k-stage-2");
      await page.locator("#secret-API_KEY input").press("Enter");
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("eval.secrets")).stage.API_KEY)).toBe("k-stage-2");
      await expect(page.locator("#secret-API_KEY input")).toHaveValue("");
      await page.click("#settingsClose");
      await runTest(page);
      expect(await lastSent(servers.mock.url)).toEqual({ ...sentIn("stage", "hello stage-team"), auth: "Bearer k-stage-2" });
      // After a reload: the scope chosen before, and its secrets
      await page.reload();
      await page.locator("html:not(.loading)").waitFor();
      await reopen(page);
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
      await runTest(page);
      expect(await lastSent(servers.mock.url)).toEqual({ ...sentIn("stage", "hello stage-team"), auth: "Bearer k-stage-2" });
    });
  });

  plain.describe("in the desktop app", () => {
    plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

    plain("secrets kept per scope reach runs, and a conversation as the scope changes; and again once the app is started again", async () => {
      const mock = await startMock({ chunkMs: 10 });
      const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
      // (the app's workspace, in its data folder: filled before it starts)
      const folder = join(data, "workspace");
      await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
      const smoke = join(folder, "smoke.hafen.yml");
      await writeDisk(smoke, (await readFile(smoke, "utf8")).replace("http://127.0.0.1:8791", mock.url));
      await mkdir(join(folder, "providers"), { recursive: true });
      for (const [path, text] of Object.entries(FILES)) await writeDisk(join(folder, path), text);
      const env = { ...process.env, HAFEN_DATA: data };
      delete env.ELECTRON_RUN_AS_NODE;
      let app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
      try {
        let page = await app.firstWindow();
        await expect(page.locator('#suiteList .list-row[data-file="scoped.hafen.yml"]')).toHaveCount(1);
        await makeScopes(page, mock.url);
        // (kept by the main process, encrypted, as Settings → Secrets keeps them)
        for (const [scope, values] of Object.entries(SECRETS)) {
          for (const [name, value] of Object.entries(values)) await page.evaluate((args) => window.hafen.invoke("secrets_set", args), { env: scope, name, value });
        }
        await chooseScope(page, "prod");
        await runTest(page);
        expect(await lastSent(mock.url)).toEqual(sentIn("prod", "hello prod-team"));
        await page.click("#newConversation");
        await page.selectOption("#convProvider", "providers/scoped.yml");
        await send(page, "one");
        expect(await lastSent(mock.url)).toEqual(sentIn("prod", "one"));
        await chooseScope(page, "stage");
        await send(page, "two");
        expect(await lastSent(mock.url)).toEqual(sentIn("stage", "two"));
        await app.close();
        // Started again: the workspace and the scope chosen, and the secrets the engine is given
        app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
        page = await app.firstWindow();
        await expect(page.locator('#suiteList .list-row[data-file="scoped.hafen.yml"]')).toHaveCount(1);
        await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
        await runTest(page);
        expect(await lastSent(mock.url)).toEqual(sentIn("stage", "hello stage-team"));
      } finally {
        await app.close();
        await mock.close();
        await rm(data, { recursive: true, force: true });
      }
    });
  });
});
