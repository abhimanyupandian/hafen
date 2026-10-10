// Settings → Environments and Secrets as scope panes (contracts/ui.md, Settings; spec/design/components.md,
// Additions: Scope panes): Globals pinned over the scopes, the entry picked on the right with its head,
// search, import, export and edit as .env, and a table of its names (where each comes from: this scope,
// overrides Globals, from Globals, not set). Globals apply in every scope: a name only Globals has is
// Globals', one both have the scope's, one only the scope has the scope's; with no scope chosen, Globals
// alone. The same in a run, a conversation and the fields' checks; Export writes Globals' files and the
// scope's, and the CI command it copies runs them, in the command line. And the desktop app keeps
// Globals across a restart, each secret marked with whether it's encrypted.

import { _electron as electron, test as plain } from "@playwright/test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEnvText } from "hafen/engine/env-file.js";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addSecret, addValue, chooseScope, expect, newScope, pickFolder, reopen, showEntry, storedFiles, test, writeFiles } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);

// A provider that takes a name only Globals has, one both have, one only the scope has, and a secret
// of each kind; a suite that uses it, and one that takes only what Globals has
const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers:
  Authorization: "Bearer {{secret.API_KEY}}"
  X-Only-Global: "{{env.only_global}}"
  X-Both: "{{env.both}}"
  X-Only-Local: "{{env.only_local}}"
  X-Secret-Global: "{{secret.ONLY_GLOBAL_SECRET}}"
  X-Secret-Local: "{{secret.ONLY_LOCAL_SECRET}}"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
const GLOBAL_PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}", X-Both: "{{env.both}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
const suite = (name, provider) => `version: 1
name: ${name}
provider: ${provider}
tests:
  - name: ${name} hello
    turns:
      - user: "hello"
        expect: [{ type: status, equals: 200 }]
`;
const FILES = {
  "providers/prec.yml": PROVIDER,
  "providers/globals-only.yml": GLOBAL_PROVIDER,
  "prec.hafen.yml": suite("Precedence", "providers/prec.yml"),
  "globals-only.hafen.yml": suite("Globals only", "providers/globals-only.yml"),
};
const GLOBALS = (mockUrl) => ({ base_url: mockUrl, only_global: "g", both: "from-globals" });
const STAGE = { both: "from-stage", only_local: "l" };
const SECRETS = { "": { API_KEY: "k-global", ONLY_GLOBAL_SECRET: "sg" }, stage: { API_KEY: "k-stage", ONLY_LOCAL_SECRET: "sl" } };

// The scopes, Globals and the secrets, as the browser build keeps them; then the app opened again
async function seed(page, mockUrl, { env = "stage", secrets = SECRETS, scopes = { stage: STAGE }, globals = GLOBALS(mockUrl), files = FILES } = {}) {
  await writeFiles(page, files);
  await page.evaluate(([globals, scopes, secrets, env]) => {
    localStorage.setItem("eval.globals", JSON.stringify(globals));
    localStorage.setItem("eval.scopes", JSON.stringify(Object.keys(scopes)));
    for (const [name, values] of Object.entries(scopes)) localStorage.setItem(`eval.scope.${name}`, JSON.stringify(values));
    localStorage.setItem("eval.secrets", JSON.stringify(secrets));
    localStorage.setItem("eval.env", env);
  }, [globals, scopes, secrets, env]);
  await reopen(page);
}
const kept = (page) => page.evaluate(() => {
  const scopes = JSON.parse(localStorage.getItem("eval.scopes") ?? "[]");
  return {
    scopes, globals: JSON.parse(localStorage.getItem("eval.globals") ?? "null"),
    values: Object.fromEntries(scopes.map((s) => [s, JSON.parse(localStorage.getItem(`eval.scope.${s}`) ?? "null")])),
    secrets: JSON.parse(localStorage.getItem("eval.secrets") ?? "{}"),
  };
});
const lastSent = async (mockUrl) => {
  const last = (await (await fetch(`${mockUrl}/_log`)).json()).at(-1);
  return last && { auth: last.headers.authorization, onlyGlobal: last.headers["x-only-global"], both: last.headers["x-both"], onlyLocal: last.headers["x-only-local"], secretGlobal: last.headers["x-secret-global"], secretLocal: last.headers["x-secret-local"], message: last.body?.message };
};
const clearLog = (mockUrl) => fetch(`${mockUrl}/_log`, { method: "DELETE" });
const runSuite = async (page, file, status = "passed 1/1") => {
  await page.locator(`#suiteList .list-row[data-file="${file}"] .list-open`).first().click();
  await page.click("#suiteRun");
  await expect(page.locator("#status")).toContainText(status);
};
const send = async (page, text) => {
  await page.fill("#input", text);
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/send/i);
};
const openPane = async (page, pane = "environments") => {
  await page.click("#openSettings");
  await page.click(`#settings-tab-${pane}`);
  await page.locator(pane === "environments" ? "#envGlobals" : "#secretsGlobals").waitFor();
};
const closeSettings = async (page) => {
  await page.click("#settingsClose");
  await page.locator("#settingsModal[open]").waitFor({ state: "detached" }).catch(() => {});
};
const row = (page, id) => page.locator(`[id="${id}"]`);
const envFile = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

test.describe("in the browser build", () => {
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("Environments: Globals pinned over the scopes, a line between, each list under its head; the entry picked with its head, search and table; override and inherited rows; rows added, edited, deleted; edit as .env", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, { env: "", scopes: {}, secrets: {}, globals: {} });
    await page.click("#scopeButton");
    // Down the left: GLOBALS, its one row; a line; SCOPES, with +, and (none yet) the form to add one
    const list = page.locator("#settingsContent .scope-list");
    await expect(list.locator(".scope-list-head .label")).toHaveText(["Globals", "Scopes"]);
    await expect(list.locator(".scope-list-line[role=separator]")).toHaveCount(1);
    await expect(page.locator("#envGlobals")).toHaveClass(/active/);
    await expect(page.locator("#environmentsEmpty")).toHaveText("No scopes yet: add one (stage, prod…).");
    await expect(page.locator("#newScopeForm")).toBeVisible();
    // Globals shown: its head, no name field, nothing to delete; the names the files use, not set
    await expect(page.locator("#envGlobalsTitle")).toHaveText("Globals");
    await expect(page.locator("#envScopeName")).toHaveCount(0);
    await expect(page.locator("#envDelete")).toHaveCount(0);
    await expect(page.locator("#envChosen")).toHaveText("no scope chosen");
    await expect(page.locator("#envVars .vars-head [role=columnheader]")).toHaveText(["Variable", "Value", "Source"]);
    await expect(page.locator("#envGlobals .list-size")).toHaveText("4 not set");
    await expect(row(page, "envVar-only_local")).toHaveAttribute("data-source", "unset");
    await expect(row(page, "envVar-only_local").locator(".vars-source")).toHaveText("not set");
    // Globals' values, typed into a not-set row's field and in the last row
    await row(page, "envVar-base_url").locator("input").fill(servers.mock.url);
    await row(page, "envVar-base_url").locator("input").press("Enter");
    await expect(row(page, "envVar-base_url")).toHaveAttribute("data-source", "own");
    await addValue(page, "only_global", "g");
    await addValue(page, "both", "from-globals");
    await expect(row(page, "envVar-both").locator(".vars-source")).toHaveText("Globals");
    await expect(row(page, "envVar-both").locator(".vars-use")).toHaveText("{{env.both}}");
    await expect(page.locator("#envGlobals .list-size")).toHaveText("1 not set");
    expect((await kept(page)).globals).toEqual({ base_url: servers.mock.url, only_global: "g", both: "from-globals" });
    // A scope's name Globals has is refused, and said why
    await page.click("#newScope");
    await page.fill("#newScopeName", "globals");
    await page.click("#newScopeForm button[type=submit]");
    await expect(page.locator("#newScopeProblem")).toContainText("Globals' name");
    await page.fill("#newScopeName", "stage.secret");
    await page.click("#newScopeForm button[type=submit]");
    await expect(page.locator("#newScopeProblem")).toContainText("doesn't end .secret");
    // A scope: shown once made; its own values, Globals' it doesn't override listed (muted, from Globals)
    await newScope(page, "stage");
    await expect(page.locator("#envScopeName")).toHaveValue("stage");
    await expect(row(page, "envVar-only_global")).toHaveAttribute("data-source", "globals");
    await expect(row(page, "envVar-only_global").locator(".vars-source")).toHaveText("from Globals");
    await expect(row(page, "envVar-only_global").locator("input")).toHaveCount(0);
    await expect(row(page, "envVar-only_global").locator(".vars-value")).toHaveText("g");
    await addValue(page, "both", "from-stage");
    await expect(row(page, "envVar-both")).toHaveAttribute("data-source", "override");
    await expect(row(page, "envVar-both").locator(".vars-source")).toHaveText("overrides Globals");
    await addValue(page, "only_local", "l");
    await expect(row(page, "envVar-only_local").locator(".vars-source")).toHaveText("this scope");
    await expect(page.locator("#envScope-stage .list-size")).toHaveCount(0);
    // (Globals' row says which scopes override it)
    await showEntry(page, "");
    await expect(row(page, "envVar-both").locator(".vars-source")).toHaveText("Globals · overridden in stage");
    await showEntry(page, "stage");
    // The rows: its own, then Globals' it doesn't override
    await expect(page.locator("#envVars .vars-row:not(.vars-add)")).toHaveCount(4);
    await expect(page.locator("#envVars .vars-row:not(.vars-add) .vars-name")).toHaveText(["both", "only_local", "base_url", "only_global"]);
    // Search: by name or value, case aside; Esc clears it; the last row stays
    await page.fill("#envSearch", "ONLY");
    await expect(page.locator("#envVars .vars-row:not(.vars-add) .vars-name")).toHaveText(["only_local", "only_global"]);
    await page.fill("#envSearch", "from-stage");
    await expect(page.locator("#envVars .vars-row:not(.vars-add) .vars-name")).toHaveText(["both"]);
    await page.fill("#envSearch", "zzz");
    await expect(page.locator("#envVarsEmpty")).toHaveText('No variables match "zzz".');
    await expect(page.locator("#envVarAdd")).toBeVisible();
    await page.press("#envSearch", "Escape");
    await expect(page.locator("#envSearch")).toHaveValue("");
    await expect(page.locator("#settingsModal")).toBeVisible();
    // Override: the scope's own, Globals' value to start from, its field focused
    await page.click("#envVar-only_global-override");
    await expect(row(page, "envVar-only_global")).toHaveAttribute("data-source", "override");
    await expect(row(page, "envVar-only_global").locator("input")).toBeFocused();
    await row(page, "envVar-only_global").locator("input").fill("g-stage");
    await row(page, "envVar-only_global").locator("input").press("Enter");
    expect((await kept(page)).values.stage).toEqual({ both: "from-stage", only_local: "l", only_global: "g-stage" });
    // Deleted, asking first: Globals' shows through again
    await page.click("#envVar-only_global-delete");
    await expect(page.locator("#envVar-only_global-delete")).toHaveText("delete");
    await page.click("#envVar-only_global-delete");
    await expect(row(page, "envVar-only_global")).toHaveAttribute("data-source", "globals");
    // Edit as .env: its own values as text; saved, they're its values (one taken out goes)
    await page.click("#envText");
    await expect(page.locator("#editorText")).toHaveValue("both=from-stage\nonly_local=l\n");
    await page.fill("#editorText", "both=edited\nextra=x\n");
    await page.click("#editorSave");
    await expect(row(page, "envVar-both").locator("input")).toHaveValue("edited");
    await expect(row(page, "envVar-only_local")).toHaveAttribute("data-source", "unset");
    expect((await kept(page)).values.stage).toEqual({ both: "edited", extra: "x" });
    // Chosen from its head; the list marks it
    await page.click("#envChoose");
    await expect(page.locator("#envChosen")).toHaveText("chosen now");
    await expect(page.locator("#envScope-stage .icon-check")).toHaveCount(1);
    await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
  });

  test("a scope's menu (its row's more, a right-click, its head's more): choose it, rename it, duplicate it with its values and secrets, delete it after asking", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, { env: "", scopes: { stage: STAGE, prod: { both: "p" } } });
    await page.click("#scopeButton");
    await expect(page.locator("#envScopes .list-row .list-open")).toHaveText(["stage", "prod"]);
    // Choose it
    await page.locator("#envScope-stage").hover();
    await page.click("#envScope-stage-more");
    await expect(page.locator("#contextMenu")).toBeVisible();
    await page.click("#menu-scope-choose");
    await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
    await expect(page.locator("#envScope-stage .icon-check")).toHaveCount(1);
    // Rename: shows it, its name field focused; Enter renames, its values and secrets with it
    await page.click("#envScope-stage-open", { button: "right" });
    await page.click("#menu-scope-rename");
    await expect(page.locator("#envScopeName")).toBeFocused();
    await page.keyboard.type("staging");
    await page.keyboard.press("Enter");
    await expect(page.locator("#envScope-staging")).toHaveClass(/active/);
    await expect(page.locator("#scopeButton .scope-name")).toHaveText("staging");
    let now = await kept(page);
    expect(now.scopes).toEqual(["staging", "prod"]);
    expect(now.values.staging).toEqual(STAGE);
    expect(now.secrets.staging).toEqual(SECRETS.stage);
    expect(now.secrets.stage).toBeUndefined();
    // A name that won't do is refused, said, and put back
    await page.fill("#envScopeName", "prod");
    await page.press("#envScopeName", "Enter");
    await expect(page.locator("#environmentsError")).toContainText('There\'s a scope "prod" already');
    await expect(page.locator("#envScopeName")).toHaveValue("staging");
    // Duplicate (the head's more): a copy after it, with its values and secrets, shown; not chosen
    await page.click("#envMore");
    await page.click("#menu-scope-duplicate");
    await expect(page.locator("#envScope-staging-copy")).toHaveClass(/active/);
    await expect(page.locator("#envScopes .list-row .list-open")).toHaveText(["staging", "staging-copy", "prod"]);
    await expect(page.locator("#envChoose")).toHaveText("choose it");
    now = await kept(page);
    expect(now.values["staging-copy"]).toEqual(STAGE);
    expect(now.secrets["staging-copy"]).toEqual(SECRETS.stage);
    // The Secrets pane has the same entries and menu
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsScopes .list-row .list-open")).toHaveText(["staging", "staging-copy", "prod"]);
    await expect(page.locator("#secretsScope-staging")).toHaveClass(/active/);
    // Delete (asking first): its values and secrets go
    await page.locator("#secretsScope-staging-copy").hover();
    await page.click("#secretsScope-staging-copy-more");
    await page.click("#menu-scope-delete");
    await expect(page.locator("#menu-scope-delete")).toHaveText("Click again to delete its values and secrets");
    await page.click("#menu-scope-delete");
    await expect(page.locator("#secretsScope-staging-copy")).toHaveCount(0);
    now = await kept(page);
    expect(now.scopes).toEqual(["staging", "prod"]);
    expect(now.secrets["staging-copy"]).toBeUndefined();
    expect(await page.evaluate(() => localStorage.getItem("eval.scope.staging-copy"))).toBeNull();
    // Esc in the menu closes the menu, not Settings
    await page.click("#secretsMore");
    await page.keyboard.press("Escape");
    await expect(page.locator("#contextMenu")).toHaveCount(0);
    await expect(page.locator("#settingsModal")).toBeVisible();
  });

  test("the panes explain nothing in words (Secrets: one line, while unencrypted), every action is an outlined button, the line between the entries and the one picked runs the whole height, the last row adds on Enter (no button), and Source is last and small, so a long value shows whole", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, { scopes: { stage: { ...STAGE, base_url: "https://stage.acme.example" } } });
    await openPane(page);
    await expect(page.locator("#envScope-stage")).toHaveClass(/active/);
    const box = (selector) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON());
    const columns = () => page.locator("#envVars").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").map(parseFloat));
    // No words: nothing under the title, nothing under the table
    await expect(page.locator("#settingsContent > .note")).toHaveCount(0);
    await expect(page.locator("#settingsContent .scope-main > .hint:not(.error)")).toHaveCount(0);
    // Every action an outlined button, none a ghost one; "chosen now" is the choose button, disabled
    await expect(page.locator("#settingsContent .scope-panes .btn-ghost")).toHaveCount(0);
    for (const id of ["newScope", "envScope-stage-more", "envChosen", "envMore", "envImport", "envExport", "envText", "envVar-both-delete", "envVar-only_global-override", "envDelete"]) {
      await expect(page.locator(`[id="${id}"]`)).toHaveClass(/\bbtn\b/);
    }
    await expect(page.locator("#envChosen")).toBeDisabled();
    // × an icon button, square, as tall as the field beside it
    expect(await box("#envVar-both-delete")).toMatchObject({ width: 28, height: 28 });
    // The line down the entries' right reaches the content's bottom edge, however little the entry has
    for (const entry of ["stage", ""]) {
      await showEntry(page, entry);
      expect(Math.round((await box("#settingsContent .scope-list")).bottom)).toBe(Math.round((await box("#settingsContent")).bottom));
    }
    await showEntry(page, "stage");
    // Three columns: Source last, as wide as its words (68px at most); the value has the most room, and
    // a long one shows whole at Settings' width
    const [name, value, source] = await columns();
    expect(source).toBeLessThanOrEqual(68);
    expect(value).toBeGreaterThan(name + source);
    const url = row(page, "envVar-base_url").locator("input");
    await expect(url).toHaveValue("https://stage.acme.example");
    expect(await url.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // × asking takes its room from its own row's field: the columns stay as they were
    await page.click("#envVar-both-delete");
    await expect(page.locator("#envVar-both-delete")).toHaveText("delete");
    expect(await columns()).toEqual([name, value, source]);
    await page.locator("#envSearch").hover();
    // The last row: its two fields, no button. Enter in either adds it, then the name is focused for the
    // next; with no name, Enter goes to the name; a name that won't do says why
    await expect(page.locator("#envVarAdd button")).toHaveCount(0);
    await expect(page.locator("#envVarValue")).toHaveAttribute("placeholder", "its value, then Enter");
    await page.fill("#envVarName", "added");
    await page.fill("#envVarValue", "by-enter");
    await page.press("#envVarName", "Enter");
    await expect(row(page, "envVar-added").locator("input")).toHaveValue("by-enter");
    await expect(page.locator("#envVarName")).toBeFocused();
    await expect(page.locator("#envVarName")).toHaveValue("");
    await page.fill("#envVarValue", "x");
    await page.press("#envVarValue", "Enter");
    await expect(page.locator("#envVarName")).toBeFocused();
    await page.fill("#envVarName", "2nd");
    await page.press("#envVarName", "Enter");
    await expect(page.locator("#environmentsError")).toContainText("not starting with a digit");
    expect((await kept(page)).values.stage).toEqual({ ...STAGE, base_url: "https://stage.acme.example", added: "by-enter" });

    // Secrets: the same, and its one line, a warning, since the browser build keeps them unencrypted
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsNote")).toHaveText("Kept in this browser's storage, unencrypted: use the desktop app for keys that matter.");
    expect(await page.locator("#secretsNote").evaluate((el) => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1)).toBe(true);
    await expect(page.locator("#settingsContent .scope-main > .hint:not(.error)")).toHaveCount(0);
    await expect(page.locator("#settingsContent .scope-panes .btn-ghost")).toHaveCount(0);
    for (const id of ["secretsRevealAll", "secret-API_KEY-reveal", "secret-API_KEY-forget", "secret-ONLY_GLOBAL_SECRET-override", "secretsExport", "secretsDelete"]) {
      await expect(page.locator(`[id="${id}"]`)).toHaveClass(/\bbtn\b/);
    }
    expect(Math.round((await box("#settingsContent .scope-list")).bottom)).toBe(Math.round((await box("#settingsContent")).bottom));
    // (with no value yet, Enter goes to the value: a secret can't be empty)
    await expect(page.locator("#secretAdd button")).toHaveCount(0);
    await page.fill("#secretName", "NEW_ONE");
    await page.press("#secretName", "Enter");
    await expect(page.locator("#secretValue")).toBeFocused();
    await page.fill("#secretValue", "n1");
    await page.press("#secretValue", "Enter");
    await expect(row(page, "secret-NEW_ONE")).toHaveAttribute("data-source", "own");
    await expect(page.locator("#secretName")).toBeFocused();
    await expect.poll(async () => (await kept(page)).secrets.stage).toMatchObject({ NEW_ONE: "n1" });
  });

  test("Secrets: masked, shown one at a time or all, a new value typed in place; Globals' inherited (override), not set counted after Globals; imported names the engine takes (db.password); a problem never quotes a line", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, { secrets: { "": { API_KEY: "k-global", ONLY_GLOBAL_SECRET: "sg" }, stage: { API_KEY: "k-stage" } } });
    await openPane(page, "secrets");
    await expect(page.locator("#secretsScope-stage")).toHaveClass(/active/);
    await expect(page.locator("#secretsList .vars-head [role=columnheader]")).toContainText(["Name", "Value", "Source"]);
    // Masked: a password field, empty, never the value
    const key = row(page, "secret-API_KEY");
    await expect(key).toHaveAttribute("data-source", "override");
    await expect(key.locator(".vars-source")).toHaveText("overrides Globals");
    await expect(key.locator("input")).toHaveAttribute("type", "password");
    await expect(key.locator("input")).toHaveValue("");
    await expect(key.locator("input")).toHaveAttribute("placeholder", "••••••••");
    await expect(row(page, "secret-ONLY_GLOBAL_SECRET")).toHaveAttribute("data-source", "globals");
    await expect(row(page, "secret-ONLY_GLOBAL_SECRET").locator(".vars-value")).toHaveText("••••••••");
    await expect(row(page, "secret-ONLY_LOCAL_SECRET").locator(".vars-source")).toHaveText("not set");
    await expect(page.locator("#secretsScope-stage .list-size")).toHaveText("1 not set");
    await expect(page.locator("#secretsGlobals .list-size")).toHaveText("1 not set");
    // Shown, then hidden; show all shows Globals' inherited too
    await page.click("#secret-API_KEY-reveal");
    await expect(key.locator("input")).toHaveAttribute("type", "text");
    await expect(key.locator("input")).toHaveValue("k-stage");
    await page.click("#secret-API_KEY-reveal");
    await expect(key.locator("input")).toHaveValue("");
    await page.click("#secretsRevealAll");
    await expect(page.locator("#secretsRevealAll")).toHaveText("hide all");
    await expect(key.locator("input")).toHaveValue("k-stage");
    await expect(row(page, "secret-ONLY_GLOBAL_SECRET").locator(".vars-value")).toHaveText("sg");
    await page.click("#secretsRevealAll");
    await expect(row(page, "secret-ONLY_GLOBAL_SECRET").locator(".vars-value")).toHaveText("••••••••");
    // A new value typed in place, kept on Enter; an empty one left changes nothing
    await key.locator("input").fill("k-stage-2");
    await key.locator("input").press("Enter");
    await expect.poll(async () => (await kept(page)).secrets.stage.API_KEY).toBe("k-stage-2");
    await key.locator("input").focus();
    await key.locator("input").press("Tab");
    expect((await kept(page)).secrets.stage.API_KEY).toBe("k-stage-2");
    // Set where it was not set, in its own row
    await row(page, "secret-ONLY_LOCAL_SECRET").locator("input").fill("sl");
    await row(page, "secret-ONLY_LOCAL_SECRET").locator("input").press("Enter");
    await expect(row(page, "secret-ONLY_LOCAL_SECRET")).toHaveAttribute("data-source", "own");
    await expect(page.locator("#secretsScope-stage .list-size")).toHaveCount(0);
    // Override Globals': its name in the last row, its value focused
    await page.click("#secret-ONLY_GLOBAL_SECRET-override");
    await expect(page.locator("#secretName")).toHaveValue("ONLY_GLOBAL_SECRET");
    await expect(page.locator("#secretValue")).toBeFocused();
    await page.fill("#secretValue", "sg-stage");
    await page.press("#secretValue", "Enter");
    await expect(row(page, "secret-ONLY_GLOBAL_SECRET")).toHaveAttribute("data-source", "override");
    // Search by name
    await page.fill("#secretsSearch", "only");
    await expect(page.locator("#secretsList .vars-row:not(.vars-add) .vars-name")).toHaveText(["ONLY_LOCAL_SECRET", "ONLY_GLOBAL_SECRET"]);
    await page.fill("#secretsSearch", "");
    // Forget asks first
    await page.click("#secret-ONLY_GLOBAL_SECRET-forget");
    await expect(page.locator("#secret-ONLY_GLOBAL_SECRET-forget")).toHaveText("forget it?");
    await page.click("#secret-ONLY_GLOBAL_SECRET-forget");
    await expect(row(page, "secret-ONLY_GLOBAL_SECRET")).toHaveAttribute("data-source", "globals");
    // Imported: a dotted name, as the engine and a --secret file take it
    await page.setInputFiles("#secretsImportFile", envFile("stage.secret.env", "db.password=p1\nmy-key=p2\n"));
    await expect(row(page, "secret-db.password")).toHaveAttribute("data-source", "own");
    expect((await kept(page)).secrets.stage).toMatchObject({ "db.password": "p1", "my-key": "p2" });
    // A problem says where, never what's in the line
    await page.setInputFiles("#secretsImportFile", envFile("bad.secret.env", 'OK=1\nTOKEN="sk-live-123"sk-live-456\n'));
    await expect(page.locator("#secretsError")).toHaveText("bad.secret.env: line 2: after a quoted value, only a # comment. Nothing was changed.");
    await page.setInputFiles("#secretsImportFile", envFile("bad.secret.env", "1sk-live-789=x\n"));
    await expect(page.locator("#secretsError")).toHaveText("bad.secret.env: line 1: that isn't a name (letters, digits, _ . -, not starting with a digit). Nothing was changed.");
    expect(JSON.stringify((await kept(page)).secrets)).not.toContain("OK");
    // Edit as .env: its own as text (read for it); saved, a name taken out is forgotten
    await page.click("#secretsText");
    await expect(page.locator("#editorText")).toHaveValue(/API_KEY=k-stage-2\n/);
    await page.fill("#editorText", "API_KEY=k-edited\nNEW_ONE=n\n");
    await page.click("#editorSave");
    await expect(row(page, "secret-NEW_ONE")).toHaveAttribute("data-source", "own");
    await expect.poll(async () => (await kept(page)).secrets.stage).toEqual({ API_KEY: "k-edited", NEW_ONE: "n" });
    // Globals: relabelled, its own rows; System One's key isn't here
    await showEntry(page, "", "secrets");
    await expect(page.locator("#secretsGlobalsTitle")).toHaveText("Globals");
    await expect(row(page, "secret-API_KEY").locator(".vars-source")).toHaveText("Globals · overridden in stage");
  });

  test("precedence in a run, a conversation and the fields: a name only Globals has is Globals', one both have the scope's, one only the scope has the scope's; with no scope, Globals alone", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url);
    const expected = { auth: "Bearer k-stage", onlyGlobal: "g", both: "from-stage", onlyLocal: "l", secretGlobal: "sg", secretLocal: "sl" };
    // A run, in stage
    await clearLog(servers.mock.url);
    await runSuite(page, "prec.hafen.yml");
    expect(await lastSent(servers.mock.url)).toEqual({ ...expected, message: "hello" });
    // A conversation, in stage
    await page.click("#newConversation");
    await page.selectOption("#convProvider", "providers/prec.yml");
    await send(page, "x {{env.only_global}} {{env.both}} {{env.only_local}}");
    expect(await lastSent(servers.mock.url)).toEqual({ ...expected, message: "x g from-stage l" });
    await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: x g from-stage l");
    // The fields, in stage: each is there
    await page.fill("#input", "{{env.only_global}} {{env.both}} {{env.only_local}} {{secret.ONLY_GLOBAL_SECRET}} {{secret.ONLY_LOCAL_SECRET}}");
    await expect(page.locator("#inputProblem")).toHaveCount(0);
    await page.fill("#input", "{{env.nope}}");
    await expect(page.locator("#inputProblem")).toHaveText('{{env.nope}} isn\'t in the scope "stage" or in Globals: add it in Settings → Environments');
    await page.fill("#input", "{{secret.NOPE}}");
    await expect(page.locator("#inputProblem")).toHaveText('{{secret.NOPE}} isn\'t a secret of the scope "stage" or of Globals: add it in Settings → Secrets');
    await page.fill("#input", "");
    // A value changed in Globals applies where the scope hasn't its own
    await openPane(page);
    await showEntry(page, "");
    await row(page, "envVar-only_global").locator("input").fill("g2");
    await row(page, "envVar-only_global").locator("input").press("Enter");
    await row(page, "envVar-both").locator("input").fill("from-globals-2");
    await row(page, "envVar-both").locator("input").press("Enter");
    await closeSettings(page);
    await send(page, "y");
    expect(await lastSent(servers.mock.url)).toEqual({ ...expected, onlyGlobal: "g2", message: "y" });

    // No scope: Globals alone. What takes only Globals' runs, with Globals' values and secrets
    await chooseScope(page, "");
    await clearLog(servers.mock.url);
    await runSuite(page, "globals-only.hafen.yml");
    const sent = (await (await fetch(`${servers.mock.url}/_log`)).json()).at(-1);
    expect([sent.headers.authorization, sent.headers["x-both"]]).toEqual(["Bearer k-global", "from-globals-2"]);
    // A conversation too
    await page.click("#newConversation");
    await page.selectOption("#convProvider", "providers/globals-only.yml");
    await send(page, "z {{env.both}} {{env.only_global}}");
    await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: z from-globals-2 g2");
    // What takes a scope's only: refused, nothing sent, and said so; as the fields say
    await clearLog(servers.mock.url);
    await page.locator('#suiteList .list-row[data-file="prec.hafen.yml"] .list-open').first().click();
    await page.click("#suiteRun");
    await expect(page.locator(".toast", { hasText: "Couldn't run" })).toContainText("only_local");
    expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
    await page.click("#newConversation");
    await page.fill("#input", "{{env.only_local}}");
    await expect(page.locator("#inputProblem")).toHaveText("{{env.only_local}} isn't in Globals, and no scope is chosen: add it in Settings → Environments");
    await page.fill("#input", "{{env.only_global}} {{secret.API_KEY}}");
    await expect(page.locator("#inputProblem")).toHaveCount(0);
    await page.fill("#input", "{{secret.ONLY_LOCAL_SECRET}}");
    await expect(page.locator("#inputProblem")).toHaveText("{{secret.ONLY_LOCAL_SECRET}} isn't in Globals, and no scope is chosen: add it in Settings → Secrets");
  });

  test("a secret is looked up by its own name only: {{secret.constructor}} is a secret nobody set, so nothing is sent", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, {
      files: { "providers/proto.yml": `kind: http\nurl: "{{env.base_url}}/json"\nheaders: { X-C: "{{secret.constructor}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`, "proto.hafen.yml": suite("Proto", "providers/proto.yml") },
    });
    await clearLog(servers.mock.url);
    await page.locator('#suiteList .list-row[data-file="proto.hafen.yml"] .list-open').first().click();
    await page.click("#suiteRun");
    await expect(page.locator(".toast", { hasText: "Couldn't run" })).toContainText("{{secret.constructor}}");
    expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
  });

  test("another tab follows a change to the values and to the secrets: its panes, and what it runs with", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url);
    const other = await page.context().newPage();
    await other.goto(page.url());
    await other.locator("html:not(.loading)").waitFor();
    await openPane(other, "secrets");
    await expect(row(other, "secret-API_KEY")).toHaveAttribute("data-source", "override");
    // Changed here: a value of Globals', a secret of the scope's
    await openPane(page);
    await showEntry(page, "");
    await addValue(page, "added_elsewhere", "yes");
    await page.click("#settings-tab-secrets");
    await page.click("#secret-API_KEY-forget");
    await page.click("#secret-API_KEY-forget");
    await expect(row(page, "secret-API_KEY")).toHaveAttribute("data-source", "globals");
    await closeSettings(page);
    // There: the Secrets pane says so, and so does Environments
    await expect(row(other, "secret-API_KEY")).toHaveAttribute("data-source", "globals");
    await other.click("#settings-tab-environments");
    await expect(row(other, "envVar-added_elsewhere")).toHaveAttribute("data-source", "globals");
    await closeSettings(other);
    // and its run takes Globals' API_KEY now
    await clearLog(servers.mock.url);
    await runSuite(other, "prec.hafen.yml");
    expect((await lastSent(servers.mock.url)).auth).toBe("Bearer k-global");
    await other.close();
  });

  test("Export writes Globals' and the scope's files, each its own, only the ones with something in them; the CI command it copies names exactly those, and runs them in the command line", async ({ app: { page, servers } }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await seed(page, servers.mock.url);
    await page.locator('#suiteList .list-row[data-file="prec.hafen.yml"] .list-open').first().click();
    await page.click("#suiteExport");
    await expect(page.locator("#exportDialog label.check")).toHaveText("Also write globals.env and stage.env: the values of Globals and of the stage scope");
    await expect(page.locator("#exportSecretsHint")).toHaveText("Export with secrets also writes globals.secret.env and stage.secret.env, the secrets in plain text: keep them out of version control.");
    await pickFolder(page, "ci-out");
    await page.click("#exportWithSecrets");
    await expect(page.locator("#exportWithSecrets")).toHaveText("write them in plain text?");
    await page.click("#exportWithSecrets");
    await expect(page.locator("#exportDialog")).toHaveCount(0);
    const out = await storedFiles(page, "ci-out");
    expect(Object.keys(out).sort()).toEqual(["globals.env", "globals.secret.env", "prec.hafen.yml", "providers/prec.yml", "stage.env", "stage.secret.env"]);
    expect(parseEnvText(out["globals.env"]).values).toEqual(GLOBALS(servers.mock.url));
    expect(parseEnvText(out["stage.env"]).values).toEqual(STAGE);
    expect(parseEnvText(out["globals.secret.env"]).values).toEqual(SECRETS[""]);
    expect(parseEnvText(out["stage.secret.env"]).values).toEqual(SECRETS.stage);
    await expect(page.locator("#suiteCiHint")).toHaveText("Runs ci-out, exported just now with globals.env, stage.env, globals.secret.env and stage.secret.env: export again after a change.");
    await page.click("#suiteCopyCi");
    const command = await page.evaluate(() => navigator.clipboard.readText());
    expect(command).toBe('npx hafen run "ci-out" --env ci-out/globals.env --env ci-out/stage.env --secret ci-out/globals.secret.env --secret ci-out/stage.secret.env --report junit:results/junit.xml --report run:results/run.hafen-run.json');
    // The folder on a disk, and the command run there, as CI would: it passes, with the scope's values
    // over Globals'
    const repo = await mkdtemp(join(tmpdir(), "hafen-ci-"));
    try {
      for (const [path, text] of Object.entries(out)) {
        await mkdir(join(repo, "ci-out", path, ".."), { recursive: true });
        await writeDisk(join(repo, "ci-out", path), text);
      }
      await clearLog(servers.mock.url);
      const args = command.replace(/^npx hafen /, "").match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ""));
      const env = { ...process.env };
      for (const name of ["API_KEY", "ONLY_GLOBAL_SECRET", "ONLY_LOCAL_SECRET"]) delete env[name];
      const result = await run(process.execPath, [join(ROOT, "packages/hafen/cli/hafen.js"), ...args], { cwd: repo, env }).catch((err) => err);
      expect(result.code ?? 0, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await lastSent(servers.mock.url)).toEqual({ auth: "Bearer k-stage", onlyGlobal: "g", both: "from-stage", onlyLocal: "l", secretGlobal: "sg", secretLocal: "sl", message: "hello" });
      expect(await readFile(join(repo, "results/junit.xml"), "utf8")).toContain("Precedence hello");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
    // Exported again without the values: the command names none of them (none was written)
    await page.click("#suiteExport");
    await page.uncheck("#exportEnv");
    await page.click("#exportGo");
    await expect(page.locator("#exportDialog")).toHaveCount(0);
    await page.click("#suiteCopyCi");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx hafen run "ci-out" --report junit:results/junit.xml --report run:results/run.hafen-run.json');
    await expect(page.locator("#suiteCiHint")).toContainText("No .env file went with it");
  });

  test("a run file hides every secret the scope and Globals hold, used or not", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, { secrets: { ...SECRETS, "": { ...SECRETS[""], UNUSED: "zz-unused-secret-4711" } } });
    await page.click("#newConversation");
    await page.selectOption("#convProvider", "providers/prec.yml");
    await send(page, "say zz-unused-secret-4711 back");
    const kept = await page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const all = await done(db.transaction("conversations").objectStore("conversations").getAll());
      db.close();
      return JSON.stringify(all);
    });
    expect(kept).toContain("say ");
    expect(kept).not.toContain("zz-unused-secret-4711");
  });

  test("a kept conversation carries on after a reload: its messages refilled from what was typed, their secrets filled in again, never [redacted]", async ({ app: { page, servers } }) => {
    await seed(page, servers.mock.url, {
      files: { ...FILES, "providers/history.yml": `kind: http\nurl: "{{env.base_url}}/json"\nbody: { message: "{{user}}", messages: "{{messages}}" }\nresponse: { text: $.data.reply }\n` },
    });
    await page.click("#newConversation");
    await page.selectOption("#convProvider", "providers/history.yml");
    await send(page, "my key is {{secret.API_KEY}}");
    const keptRun = async () => page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const all = await done(db.transaction("conversations").objectStore("conversations").getAll());
      db.close();
      return all[0];
    });
    const kept = await keptRun();
    expect(kept.run.turns[0].user_template).toBe("my key is {{secret.API_KEY}}");
    expect(JSON.stringify(kept)).not.toContain("k-stage");
    await reopen(page);
    await page.locator("#conversationList .list-open").first().click();
    await clearLog(servers.mock.url);
    await send(page, "and again");
    // (the user's turns from what was typed, filled in again; a reply that showed the secret stays hidden,
    // as the kept run has it)
    const sent = (await (await fetch(`${servers.mock.url}/_log`)).json()).at(-1);
    expect(sent.body.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["my key is k-stage", "and again"]);
    expect(sent.body.messages.find((m) => m.role === "assistant").content).not.toContain("k-stage");
  });
});

plain.describe("in the desktop app", () => {
  plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

  plain("Globals' values and secrets are kept across a restart; each secret in secrets.json says whether it's encrypted; shown only when asked; runs take the scope's over Globals'", async () => {
    const mock = await startMock({ chunkMs: 10 });
    const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
    const folder = join(data, "workspace");
    await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
    await mkdir(join(folder, "providers"), { recursive: true });
    for (const [path, text] of Object.entries(FILES)) await writeDisk(join(folder, path), text);
    const env = { ...process.env, HAFEN_LAB_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    let app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
    try {
      let page = await app.firstWindow();
      await expect(page.locator('#suiteList .list-row[data-file="prec.hafen.yml"]')).toHaveCount(1);
      // Globals' values and secrets, and a scope's, made in Settings
      await page.click("#scopeButton");
      await showEntry(page, "");
      for (const [name, value] of Object.entries(GLOBALS(mock.url))) await addValue(page, name, value);
      await newScope(page, "stage");
      for (const [name, value] of Object.entries(STAGE)) await addValue(page, name, value);
      await page.click("#envChoose");
      await page.click("#settings-tab-secrets");
      await showEntry(page, "", "secrets");
      for (const [name, value] of Object.entries(SECRETS[""])) await addSecret(page, name, value);
      await showEntry(page, "stage", "secrets");
      for (const [name, value] of Object.entries(SECRETS.stage)) await addSecret(page, name, value);
      // Shown only when asked: the main process decrypts it for the page then
      await expect(row(page, "secret-API_KEY").locator("input")).toHaveValue("");
      await page.click("#secret-API_KEY-reveal");
      await expect(row(page, "secret-API_KEY").locator("input")).toHaveValue("k-stage");
      await closeSettings(page);
      await runSuite(page, "prec.hafen.yml");
      expect(await lastSent(mock.url)).toEqual({ auth: "Bearer k-stage", onlyGlobal: "g", both: "from-stage", onlyLocal: "l", secretGlobal: "sg", secretLocal: "sl", message: "hello" });
      // Each value in the file says whether it's encrypted; none is there as typed
      const stored = JSON.parse(await readFile(join(data, "secrets.json"), "utf8"));
      expect(Object.keys(stored).sort()).toEqual(["", "stage"]);
      const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
      for (const names of Object.values(stored)) {
        for (const value of Object.values(names)) {
          expect(Object.keys(value).sort()).toEqual(["encrypted", "value"]);
          expect(value.encrypted).toBe(encrypted);
        }
      }
      if (encrypted) for (const value of ["k-stage", "k-global", "sg", "sl"]) expect(JSON.stringify(stored)).not.toContain(value);
      await expect.poll(() => page.evaluate(() => window.hafen.invoke("secrets_state"))).toMatchObject({ names: { "": ["API_KEY", "ONLY_GLOBAL_SECRET"], stage: ["API_KEY", "ONLY_LOCAL_SECRET"] }, storage: { encrypted } });
      await app.close();

      // Started again: Globals' values and secrets are there, and the run takes them
      app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
      page = await app.firstWindow();
      await expect(page.locator('#suiteList .list-row[data-file="prec.hafen.yml"]')).toHaveCount(1);
      await expect(page.locator("#scopeButton .scope-name")).toHaveText("stage");
      await page.click("#scopeButton");
      await showEntry(page, "");
      await expect(row(page, "envVar-only_global").locator("input")).toHaveValue("g");
      await page.click("#settings-tab-secrets");
      await showEntry(page, "", "secrets");
      await expect(row(page, "secret-ONLY_GLOBAL_SECRET")).toHaveAttribute("data-source", "own");
      await closeSettings(page);
      await chooseScope(page, "");
      await clearLog(mock.url);
      await runSuite(page, "globals-only.hafen.yml");
      const sent = (await (await fetch(`${mock.url}/_log`)).json()).at(-1);
      expect([sent.headers.authorization, sent.headers["x-both"]]).toEqual(["Bearer k-global", "from-globals"]);
    } finally {
      await app.close();
      await mock.close();
      await rm(data, { recursive: true, force: true });
    }
  });
});
