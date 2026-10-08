// Suites' head (contracts/ui.md, Suites; spec/design/components.md, Suites import and export): `+`, then
// `import` and `export all` as words, as Runs' `open` and `clear all` are, in place of the menu button
// they were in: import opens the Import items under it, export all the Export dialog for every suite
// (only with a suite). And secrets kept for names that aren't scopes now (from before the scopes were
// only the ones made here: the desktop app's secrets.json, the browser build's eval.secrets): listed in
// Settings → Secrets by name only, never made a scope nor deleted by themselves, deleted when asked
// (from the keystore too), and gone after a reload or a restart.

import { _electron as electron, test as plain } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, pickFolder, reopen, showEntry, storedFiles, test, writeFiles } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// A suite to import, with the provider it uses (picked with it, found by the path it names it by)
const MORE = {
  "more.hafen.yml": "version: 1\nname: More\nprovider: providers/more.yml\ntests:\n  - name: one more\n    turns: [ { user: hello } ]\n",
  "providers/more.yml": "kind: http\nurl: http://127.0.0.1:9/json\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n",
};
const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`);
const toast = (page, text) => page.locator(".toast", { hasText: text });
// The browser's file picker answered with these files, one by one (no folders to go by)
const pickFiles = (page, files) => page.evaluate((files) => {
  window.showOpenFilePicker = async () => Object.entries(files).map(([path, text]) => {
    const name = path.split("/").pop();
    return { kind: "file", name, getFile: async () => new File([text], name) };
  });
}, files);
const openSecrets = async (page) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-secrets");
  await page.locator("#secretsGlobals").waitFor();
};
const keptSecrets = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("eval.secrets") ?? "{}"));

/* ---------- the browser build ---------- */

test.describe("in the browser build", () => {
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  /* ---------- Suites' head ---------- */

  test("Suites' head: +, then import and export all as words, as Runs' open and clear all are; no menu button", async ({ app: { page } }) => {
    await expect(page.locator("#suitesMenu")).toHaveCount(0);
    expect(await page.locator("#suitesSection > .section-head > button").evaluateAll((all) => all.map((b) => b.id))).toEqual(["suitesToggle", "newSuite", "importSuites", "exportSuites"]);
    await expect(page.locator("#importSuites")).toHaveText("import");
    await expect(page.locator("#exportSuites")).toHaveText("export all");
    // (the same ghost words as Runs' head has)
    for (const id of ["#importSuites", "#exportSuites"]) expect(await page.locator(id).getAttribute("class")).toBe(await page.locator("#openRun").getAttribute("class"));
    await expect(page.locator("#importSuites svg, #exportSuites svg")).toHaveCount(0);

    // import: the Import items, under it; then suite files picked
    await pickFiles(page, MORE);
    await page.click("#importSuites");
    await expect(page.locator("#contextMenu")).toBeVisible();
    await expect(page.locator("#contextMenu .context-menu-item")).toHaveText([/^Import suite files…/, /^Import a folder…/]);
    const link = await page.locator("#importSuites").boundingBox();
    const menu = await page.locator("#contextMenu").boundingBox();
    expect(Math.abs(menu.y - (link.y + link.height))).toBeLessThan(2);
    await page.click("#menu-import-files");
    await expect(toast(page, "Imported 1 suite from 2 files")).toBeVisible();
    await expect(suiteRow(page, "more.hafen.yml")).toHaveCount(1);

    // export all: the Export dialog for every suite, then the folder picked
    await pickFolder(page, "all");
    await page.click("#exportSuites");
    await expect(page.locator("#exportDialog")).toBeVisible();
    await expect(page.locator("#exportNote")).toContainText("your 2 suites");
    await page.click("#exportGo");
    await expect(page.locator("#exportDialog")).toHaveCount(0);
    const out = Object.keys(await storedFiles(page, "all"));
    expect(out).toEqual(expect.arrayContaining(["smoke.hafen.yml", "more.hafen.yml", "providers/more.yml"]));

    // Closed, Suites shows + alone
    await page.click("#suitesToggle");
    await expect(page.locator("#importSuites")).toBeHidden();
    await expect(page.locator("#exportSuites")).toBeHidden();
    await expect(page.locator("#newSuite")).toBeVisible();
  });

  test.describe("with no suites yet", () => {
    test.use({ workspace: {} });

    test("export all shows only once there's a suite; import, and the note's import some, open the same Import items", async ({ app: { page } }) => {
      await expect(page.locator("#importSuites")).toBeVisible();
      await expect(page.locator("#exportSuites")).toBeHidden();
      for (const from of ["#importSuites", "#suitesImport"]) {
        await page.click(from);
        await expect(page.locator("#contextMenu .context-menu-item")).toHaveText([/^Import suite files…/, /^Import a folder…/]);
        await page.keyboard.press("Escape");
        await expect(page.locator("#contextMenu")).toHaveCount(0);
      }
      await writeFiles(page, MORE);
      await reopen(page);
      await expect(suiteRow(page, "more.hafen.yml")).toHaveCount(1);
      await expect(page.locator("#exportSuites")).toBeVisible();
    });
  });

  /* ---------- secrets of scopes that no longer exist ---------- */

  test("secrets kept for names that aren't scopes now: listed by name only, never a scope, deleted only when asked, and gone after a reload", async ({ app: { page } }) => {
    // None: no section
    await openSecrets(page);
    await expect(page.locator("#goneScopesLabel, #goneScopes, #goneScopesHint")).toHaveCount(0);
    await page.click("#settingsClose");
    // (kept before the scopes were only the ones made here: stage is a scope; ghost and old aren't)
    const kept = { "": { SHARED: "v-every" }, stage: { API_KEY: "v-stage" }, ghost: { TOKEN: "v-ghost-1", API_KEY: "v-ghost-2" }, old: { OLD_KEY: "v-old" } };
    await page.evaluate((kept) => {
      localStorage.setItem("eval.scopes", JSON.stringify(["stage"]));
      localStorage.setItem("eval.secrets", JSON.stringify(kept));
    }, kept);
    await reopen(page);
    await openSecrets(page);
    // Not scopes: the scopes are the ones made here
    await expect(page.locator("#secretsScopes .list-open")).toHaveText(["stage"]);
    // Listed after the scope's secrets, a row each, its secrets by name
    await expect(page.locator("#goneScopesLabel")).toHaveText("Secrets of scopes that no longer exist");
    await expect(page.locator("#goneScopes .settings-row")).toHaveCount(2);
    await expect(page.locator("#goneScopes .settings-row-name")).toHaveText(["ghost", "old"]);
    await expect(page.locator("#goneScope-ghost .hint")).toHaveText("API_KEY, TOKEN");
    await expect(page.locator("#goneScope-old .hint")).toHaveText("OLD_KEY");
    // (after all of the entry's own: its list, its add row)
    expect(await page.evaluate(() => !!(document.getElementById("secretAdd").compareDocumentPosition(document.getElementById("goneScopesLabel")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    // Never a value
    const shown = await page.locator("#settingsModal").innerText();
    for (const value of ["v-ghost-1", "v-ghost-2", "v-old"]) expect(shown).not.toContain(value);
    for (const value of await page.locator("#settingsModal input").evaluateAll((all) => all.map((i) => i.value))) expect(value).not.toMatch(/^v-/);

    // Asked first; moving away cancels
    await page.click("#goneScope-ghost-delete");
    await expect(page.locator("#goneScope-ghost-delete")).toHaveText("delete its secrets?");
    await page.locator("#goneScopesLabel").hover();
    await expect(page.locator("#goneScope-ghost-delete")).toHaveText("delete");
    expect(await keptSecrets(page)).toEqual(kept);
    await page.click("#goneScope-ghost-delete");
    await page.click("#goneScope-ghost-delete");
    await expect(page.locator("#goneScope-ghost")).toHaveCount(0);
    await expect(page.locator("#goneScopes .settings-row")).toHaveCount(1);
    const { ghost, ...rest } = kept;
    expect(await keptSecrets(page)).toEqual(rest);

    // After a reload: ghost's still gone, old's still there (nothing goes by itself)
    await page.click("#settingsClose");
    await reopen(page);
    await openSecrets(page);
    await expect(page.locator("#goneScopes .settings-row-name")).toHaveText(["old"]);
    await page.click("#goneScope-old-delete");
    await page.click("#goneScope-old-delete");
    // None left: the section goes
    await expect(page.locator("#goneScopesLabel, #goneScopes, #goneScopesHint")).toHaveCount(0);
    expect(await keptSecrets(page)).toEqual({ "": { SHARED: "v-every" }, stage: { API_KEY: "v-stage" } });
    await page.click("#settingsClose");
    await reopen(page);
    await openSecrets(page);
    await expect(page.locator("#goneScopesLabel, #goneScopes, #goneScopesHint")).toHaveCount(0);
    // The scope's own as they were
    await showEntry(page, "stage", "secrets");
    await expect(page.locator("#secret-API_KEY")).toHaveAttribute("data-source", /own|override/);
  });
});

/* ---------- the desktop app ---------- */

plain.describe("in the desktop app", () => {
  plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

  plain("secrets kept for a name that isn't a scope now: listed by name (no value reaches the page), deleted when asked, and secrets.json loses that scope only", async () => {
    const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
    const env = { ...process.env, HAFEN_LAB_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => electron.launch({ args: [ROOT], cwd: ROOT, env });
    const file = async () => JSON.parse(await readFile(join(data, "secrets.json"), "utf8"));
    const SECRETS = { "": { SHARED: "s-every" }, stage: { API_KEY: "k-stage" }, ghost: { TOKEN: "t-ghost", API_KEY: "k-ghost" } };
    let app = await launch();
    try {
      let page = await app.firstWindow();
      await page.locator("html:not(.loading)").waitFor();
      // Kept as the app keeps them (encrypted by its main process), for stage, a scope of the app's, and
      // for ghost, which isn't one
      await page.evaluate(() => localStorage.setItem("eval.scopes", JSON.stringify(["stage"])));
      for (const [scope, values] of Object.entries(SECRETS)) await page.evaluate(([scope, values]) => window.hafen.invoke("secrets_set_many", { env: scope, values }), [scope, values]);
      expect(Object.keys(await file()).sort()).toEqual(["", "ghost", "stage"]);
      await app.close();

      app = await launch();
      page = await app.firstWindow();
      await page.locator("html:not(.loading)").waitFor();
      // The names as the file keeps them, never a value
      const names = await page.evaluate(() => window.hafen.invoke("secrets_names"));
      expect(Object.fromEntries(Object.entries(names).map(([scope, list]) => [scope, [...list].sort()]))).toEqual({ "": ["SHARED"], stage: ["API_KEY"], ghost: ["API_KEY", "TOKEN"] });
      await openSecrets(page);
      await expect(page.locator("#secretsScopes .list-open")).toHaveText(["stage"]);
      await expect(page.locator("#goneScopes .settings-row-name")).toHaveText(["ghost"]);
      await expect(page.locator("#goneScope-ghost .hint")).toHaveText("API_KEY, TOKEN");
      const html = await page.content();
      for (const value of ["s-every", "k-stage", "t-ghost", "k-ghost"]) expect(html).not.toContain(value);
      // Asked first: nothing goes until it's asked again
      await page.click("#goneScope-ghost-delete");
      await expect(page.locator("#goneScope-ghost-delete")).toHaveText("delete its secrets?");
      expect(Object.keys(await file()).sort()).toEqual(["", "ghost", "stage"]);
      await page.click("#goneScope-ghost-delete");
      await expect(page.locator("#goneScopesLabel, #goneScopes, #goneScopesHint")).toHaveCount(0);
      // The file: ghost gone, the others as they were (their names, and their values as the app reads them)
      const after = await file();
      expect(Object.keys(after).sort()).toEqual(["", "stage"]);
      expect(Object.keys(after.stage)).toEqual(["API_KEY"]);
      expect(Object.keys(after[""])).toEqual(["SHARED"]);
      // (each value says whether it's encrypted: { encrypted, value })
      const decrypt = (kept) => app.evaluate(({ safeStorage }, { encrypted, value }) => (encrypted ? safeStorage.decryptString(Buffer.from(value, "base64")) : value), kept);
      expect(await decrypt(after.stage.API_KEY)).toBe("k-stage");
      expect(await decrypt(after[""].SHARED)).toBe("s-every");
      await page.click("#settingsClose");
      await app.close();

      // Started again: none to list
      app = await launch();
      page = await app.firstWindow();
      await page.locator("html:not(.loading)").waitFor();
      await openSecrets(page);
      await expect(page.locator("#secretsScopes .list-open")).toHaveText(["stage"]);
      await expect(page.locator("#goneScopesLabel, #goneScopes, #goneScopesHint")).toHaveCount(0);
      expect(Object.keys(await file()).sort()).toEqual(["", "stage"]);
    } finally {
      await app.close();
      await rm(data, { recursive: true, force: true });
    }
  });
});
