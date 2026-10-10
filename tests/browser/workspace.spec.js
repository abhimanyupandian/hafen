// The app keeps its own work (contracts/ui.md, The workspace; Import and Export): a first start, what's
// added kept across a reload; Suites' import and export all; Import from files or a folder, Export to a
// folder the command line runs as it is; and the desktop app's workspace, kept across a restart.

import { _electron as electron, test as plain } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addScope, expect, fileText, fixtureFiles, openYaml, pickFolder, reopen, showEntry, storedFiles, test, toast, writeFile, writeFiles } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "packages/hafen/cli/hafen.js");
const SUITE = "smoke.hafen.yml";

// A suite that uses everything there is to copy: its provider file (its address the scope's, its key a
// secret), a data file, a prices file, a JSON Schema, and a check plugin by name that imports a helper
const ORDERS = {
  "orders.hafen.yml": `version: 1
name: Orders
provider: providers/orders.yml
prices: prices.yml
tests:
  - name: each order
    id: t_orders01
    data: data/orders.csv
    turns:
      - user: "order {{row.id}}"
        expect:
          - { type: status, equals: 200 }
          - { path: $.data, schema: schemas/reply.json }
          - { type: polite, word: said }
`,
  "providers/orders.yml": "kind: http\nurl: \"{{env.base_url}}/json\"\nheaders: { Authorization: \"Bearer {{secret.ORDERS_KEY}}\" }\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n",
  "data/orders.csv": "id\n4417\n4418\n",
  "prices.yml": "gpt: { input: 1, output: 2 }\n",
  "schemas/reply.json": "{ \"type\": \"object\", \"required\": [\"reply\", \"order\"] }\n",
  "plugins/polite.js": "import { has } from \"./lib/has.js\";\nexport default { kind: \"check\", name: \"polite\", version: \"1.0.0\", async check({ value, params }) { return { status: has(value, params.word) ? \"pass\" : \"fail\", reason: \"\" }; } };\n",
  "plugins/lib/has.js": "export const has = (value, word) => String(value ?? \"\").toLowerCase().includes(String(word).toLowerCase());\n",
};
const ORDER_FILES = Object.keys(ORDERS).sort();

// The command line, run from a folder of its own, on a folder on the disk (in a process of its own,
// while this one's mock answers it): { status, out }
const cli = (cwd, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});

// Files written into a folder on the disk
async function onDisk(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeDisk(join(dir, path), text);
  }
}

// Every file in a folder on the disk: { path: text }
async function fromDisk(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[join(entry.parentPath ?? entry.path, entry.name).slice(dir.length + 1).split("\\").join("/")] = await readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8");
  }
  return out;
}

const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`);

// Settings → Providers, where the providers are
async function openProviders(page) {
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await expect(page.locator("#settingsTitle")).toHaveText("Providers");
}

test("deletes a provider in Settings and a suite from its panel, in the workspace", async ({ app: { page } }) => {
  const exists = (path) => page.evaluate(async (path) => {
    const parts = path.split("/");
    let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      await dir.getFileHandle(parts.at(-1));
      return true;
    } catch {
      return false;
    }
  }, path);
  await expect(page.locator("#providersSection")).toHaveCount(0);
  await openProviders(page);
  const row = page.locator("#provider-mock-sse");
  await page.click("#provider-mock-sse-delete");
  await expect(page.locator("#provider-mock-sse-delete")).toHaveText("delete file?");
  await page.click("#provider-mock-sse-delete");
  await expect(row).toHaveCount(0);
  expect(await exists("providers/mock-sse.yml")).toBe(false);
  expect(await exists("providers/mock-json.yml")).toBe(true);
  await page.click("#settingsClose");

  await page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"] .list-open').click();
  await page.click("#suiteDelete");
  await expect(page.locator("#suiteDelete")).toHaveText("delete this file?");
  await page.click("#suiteDelete");
  await expect(page.locator("#suitesEmpty")).toBeVisible();
  expect(await exists("smoke.hafen.yml")).toBe(false);
  await expect(page.locator("#panel .panel-head")).toContainText("Conversation");
});

test.describe("in the browser build", () => {
  // A suite to import, with the provider it uses (picked with it, found by the path it names it by)
  const MORE = {
    "more.hafen.yml": "version: 1\nname: More\nprovider: providers/more.yml\ntests:\n  - name: one more\n    turns: [ { user: hello } ]\n",
    "providers/more.yml": "kind: http\nurl: http://127.0.0.1:9/json\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n",
  };

  // The browser's file picker answered with these files, one by one (no folders to go by)
  const pickFiles = (page, files) => page.evaluate((files) => {
    window.showOpenFilePicker = async () => Object.entries(files).map(([path, text]) => {
      const name = path.split("/").pop();
      return { kind: "file", name, getFile: async () => new File([text], name) };
    });
  }, files);

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test.describe("a first start", () => {
    test.use({ workspace: {} });

    test("nothing to open: a provider, a conversation, a suite and a plugin, each from the first steps, kept by the app across a reload", async ({ app: { page, servers } }) => {
      await expect(page.locator("body")).not.toContainText(/open a folder|open files/i);
      await expect(page.locator("#suitesEmpty")).toHaveText("No suites yet: press + to start one, or import some from files or a folder.");
      // A provider, from the thread's first step
      await page.click("#threadAddProvider");
      await page.selectOption("#newProviderKind", "http");
      await page.fill("#newProviderName", "mock");
      await page.click("#newProviderCreate");
      await openYaml(page);
      await page.fill("#providerYaml", `kind: http\nurl: ${servers.mock.url}/json\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
      await page.locator("#providerYaml").blur();
      await expect.poll(async () => parse(await fileText(page, "providers/mock.yml")).url).toBe(`${servers.mock.url}/json`);
      await page.click("#providerTry");
      // A conversation
      await page.fill("#input", "hello there");
      await page.press("#input", "Enter");
      await expect(page.locator("#turn-0-reply .msg-body")).toHaveText("You said: hello there");
      await expect(page.locator("#conversationList .list-row")).toHaveCount(1);
      // A suite, from a new conversation's first steps: the Suites section's form, named first
      await page.click("#newConversation");
      await page.click("#threadNewSuite");
      await expect(page.locator("#newSuiteName")).toBeFocused();
      await page.fill("#newSuiteName", "first");
      await page.press("#newSuiteName", "Enter");
      await expect(suiteRow(page, "first.hafen.yml")).toHaveCount(1);
      expect(parse(await fileText(page, "first.hafen.yml")).provider).toBe("providers/mock.yml");
      // A plugin
      await page.click("#openSettings");
      await page.click("#settings-tab-plugins");
      await page.selectOption("#newPluginKind", "check");
      await page.fill("#newPluginName", "polite");
      await page.click("#newPluginForm button[type=submit]");
      await expect(page.locator("#plugin-polite")).toContainText("polite · check · 1.0.0");
      await page.click("#settingsClose");
      // All kept, the next time the app starts
      await reopen(page);
      await expect(suiteRow(page, "first.hafen.yml")).toHaveCount(1);
      await expect(page.locator("#conversationList .list-row")).toHaveCount(1);
      await page.click("#openSettings");
      await page.click("#settings-tab-providers");
      await expect(page.locator("#provider-mock")).toBeVisible();
      await page.click("#settings-tab-plugins");
      await expect(page.locator("#plugin-polite")).toContainText("polite · check · 1.0.0");
      expect(await fileText(page, "plugins/polite.js")).toContain('kind: "check"');
    });

    test("Import: suite files, each found by the path its suite names it by, then a folder; a file here with another text asked about once", async ({ app: { page } }) => {
      // Files picked one by one (no folders to go by): the suite, and the files it uses
      await page.evaluate((files) => {
        window.showOpenFilePicker = async () => Object.entries(files).map(([path, text]) => {
          const name = path.split("/").pop();
          return { kind: "file", name, getFile: async () => new File([text], name) };
        });
      }, ORDERS);
      await page.click("#suitesImport");
      await expect(page.locator("#menu-export-all")).toHaveCount(0);
      await page.click("#menu-import-files");
      await expect(toast(page, "Imported 1 suite from 7 files")).toBeVisible();
      await expect(suiteRow(page, "orders.hafen.yml")).toHaveCount(1);
      await expect(page.locator("#evalTitle")).toHaveText("Orders");
      for (const path of ORDER_FILES) expect(await fileText(page, path), path).toBe(ORDERS[path]);

      // A folder: its suites, with what they use (a suite in a folder below too); not what nothing uses
      await pickFolder(page, "repo", {
        ...ORDERS,
        "providers/orders.yml": ORDERS["providers/orders.yml"].replace("/json", "/json?v=2"),
        "support/refunds.hafen.yml": "# theirs\nversion: 1\nprovider: ../providers/orders.yml\ntests:\n  - name: refund\n    turns: [ { user: refund } ]\n",
        "notes.txt": "not a suite's\n",
        "staging.secret.env": "ORDERS_KEY=never-copied\n",
      });
      await page.click("#importSuites");
      await page.click("#menu-import-folder");
      // One question for the import: the files here with another text
      await expect(page.locator("#question")).toBeVisible();
      await expect(page.locator("#questionNote")).toHaveText("1 file from repo is here already, with another text:");
      await expect(page.locator("#questionFiles")).toHaveText("providers/orders.yml");
      await page.click("#questionBoth");
      await expect(toast(page, "Imported 2 suites from repo")).toBeVisible();
      // Theirs beside yours, the suite imported pointed at it (its comment kept); yours as it was
      expect(await fileText(page, "providers/orders.yml")).toBe(ORDERS["providers/orders.yml"]);
      expect(await fileText(page, "providers/orders-2.yml")).toContain("/json?v=2");
      expect(await fileText(page, "support/refunds.hafen.yml")).toBe("# theirs\nversion: 1\nprovider: ../providers/orders-2.yml\ntests:\n  - name: refund\n    turns: [ { user: refund } ]\n");
      const kept = await storedFiles(page, "workspace");
      expect(Object.keys(kept)).not.toContain("notes.txt");
      expect(Object.keys(kept)).not.toContain("staging.secret.env");

      // Again, theirs changed again: replace (theirs over yours), then skip (yours kept), then cancel
      await pickFolder(page, "repo", { "providers/orders.yml": ORDERS["providers/orders.yml"].replace("/json", "/json?v=3") });
      await page.click("#importSuites");
      await page.click("#menu-import-folder");
      // (the suite imported beside yours was pointed at it: theirs, as it is, is another text now)
      await expect(page.locator("#questionFiles")).toHaveText("providers/orders.yml\nsupport/refunds.hafen.yml");
      await page.click("#questionReplace");
      await expect.poll(() => fileText(page, "providers/orders.yml")).toContain("/json?v=3");
      expect(await fileText(page, "support/refunds.hafen.yml")).toContain("provider: ../providers/orders.yml\n");
      await pickFolder(page, "repo", { "providers/orders.yml": ORDERS["providers/orders.yml"].replace("/json", "/json?v=4") });
      for (const answer of ["#questionSkip", "#questionClose"]) {
        await page.click("#importSuites");
        await page.click("#menu-import-folder");
        await page.click(answer);
        await expect(page.locator("#question")).toHaveCount(0);
        expect(await fileText(page, "providers/orders.yml")).toContain("/json?v=3");
      }
    });
  });

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

  test("a new provider's kinds: the built-in ones and the provider plugins kept, one added in Plugins there at once", async ({ app: { page } }) => {
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await page.fill("#newPluginName", "acme");
    await page.click("#newPluginForm button[type=submit]");
    await expect(page.locator("#plugin-acme")).toContainText("acme · provider · 1.0.0");
    await page.click("#settings-tab-providers");
    await page.click("#newProvider");
    await expect(page.locator("#newProviderKind option[value='ollama']")).toHaveText("Ollama");
    await expect(page.locator("#newProviderKind optgroup[label='Your provider plugins'] option")).toHaveText(["acme (plugin)"]);
    await page.selectOption("#newProviderKind", "plugin:acme");
    await expect(page.locator("#newProviderAbout")).toContainText('Your provider plugin "acme" (plugins/acme.js, version 1.0.0)');
    // (the plugin's own provider file is acme.yml, made with it: this one's name is free)
    await expect(page.locator("#newProviderName")).toHaveValue("acme-2");
    await expect(page.locator("#newProviderModel, #newProviderUrl")).toHaveCount(0);
    await page.click("#newProviderCreate");
    await expect.poll(async () => parse(await fileText(page, "providers/acme-2.yml")).kind).toBe("plugin:acme");
    await expect(page.locator("#providerFacts")).toContainText("plugin:acme");
    await page.click("#settingsClose");
    await expect(page.locator("#convProvider")).toHaveValue("providers/acme-2.yml");
  });

  test.describe("Export", () => {
    test.use({ workspace: ORDERS });

    test("a suite, with everything it uses and the scope's files, to a folder (files there asked about first); all of them; the folder runs with the command line as it is, as Copy CI command says", async ({ app: { page, servers } }) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await writeFiles(page, await fixtureFiles(servers.mock.url));
      await reopen(page);
      await addScope(page, "stage", { base_url: servers.mock.url });
      await page.click("#openSettings");
      await page.click("#settings-tab-secrets");
      await showEntry(page, "stage", "secrets");
      await page.fill("#secretName", "ORDERS_KEY");
      await page.fill("#secretValue", "k-orders-1");
      await page.press("#secretValue", "Enter");
      await expect(page.locator("#secret-ORDERS_KEY")).toHaveAttribute("data-source", "own");
      await page.click("#settingsClose");

      // One suite: what it takes, the scope's values beside it, and (asked first) its secrets
      await suiteRow(page, "orders.hafen.yml").locator(".list-open").click();
      await pickFolder(page, "out");
      await page.click("#suiteExport");
      await expect(page.locator("#exportFiles")).toHaveText(ORDER_FILES.join("\n"));
      await expect(page.locator("#exportEnv")).toBeChecked();
      await expect(page.locator("#exportSecretsHint")).toContainText("stage.secret.env");
      await page.click("#exportWithSecrets");
      await expect(page.locator("#exportWithSecrets")).toHaveText("write them in plain text?");
      await page.click("#exportWithSecrets");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      await expect(toast(page, "Exported orders.hafen.yml to out")).toBeVisible();
      const out = await storedFiles(page, "out");
      expect(Object.keys(out).sort()).toEqual([...ORDER_FILES, "stage.env", "stage.secret.env"].sort());
      for (const path of ORDER_FILES) expect(out[path], path).toBe(ORDERS[path]);
      expect(out["stage.env"]).toContain(`base_url=${servers.mock.url}`);
      expect(out["stage.secret.env"]).toContain("ORDERS_KEY=k-orders-1");

      // The same again: nothing asked (it's all there as it is); changed here, the files there are listed
      // first (cancel: nothing written; overwrite: written)
      await page.click("#suiteExport");
      await page.click("#exportGo");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      await expect(page.locator("#question")).toHaveCount(0);
      await page.fill("#suiteName", "Orders, renamed");
      await page.press("#suiteName", "Enter");
      await expect.poll(async () => parse(await fileText(page, "orders.hafen.yml")).name).toBe("Orders, renamed");
      await page.click("#suiteExport");
      await page.click("#exportGo");
      await expect(page.locator("#questionNote")).toHaveText("1 file is in out already, and exporting writes over it:");
      await expect(page.locator("#questionFiles")).toHaveText("orders.hafen.yml");
      await page.click("#questionCancel");
      expect((await storedFiles(page, "out"))["orders.hafen.yml"]).toBe(ORDERS["orders.hafen.yml"]);
      await page.click("#exportGo");
      await page.click("#questionOverwrite");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      expect(parse((await storedFiles(page, "out"))["orders.hafen.yml"]).name).toBe("Orders, renamed");

      // Copy CI command: the folder it went to, with exactly what this export wrote there: the scope's
      // values (its secrets were written the time before, not this time, so they aren't named)
      await page.click("#suiteCopyCi");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx hafen run "out" --env out/stage.env --report junit:results/junit.xml --report run:results/run.hafen-run.json');

      // The folder, on the disk as it was picked, runs with the command line as it is, from anywhere
      const dir = await mkdtemp(join(tmpdir(), "hafen-out-"));
      const elsewhere = await mkdtemp(join(tmpdir(), "hafen-elsewhere-"));
      try {
        await onDisk(dir, await storedFiles(page, "out"));
        const run = await cli(elsewhere, ["run", dir, "--env", join(dir, "stage.env"), "--secret", join(dir, "stage.secret.env"), "--report", `run:${join(elsewhere, "run.json")}`]);
        expect(run.status, run.out).toBe(0);
        expect(run.out).toContain("each order");
        const sent = (await (await fetch(`${servers.mock.url}/_log`)).json()).filter((r) => /^order 44/.test(r.body?.message ?? ""));
        expect(sent.map((r) => r.headers.authorization)).toEqual(["Bearer k-orders-1", "Bearer k-orders-1"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(elsewhere, { recursive: true, force: true });
      }

      // All of them (Suites' export all), each remembering where it went
      await pickFolder(page, "all");
      await page.click("#exportSuites");
      await expect(page.locator("#exportNote")).toContainText("your 2 suites");
      await expect(page.locator("#exportFiles")).toContainText("smoke.hafen.yml");
      await page.click("#exportGo");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      const all = await storedFiles(page, "all");
      expect(Object.keys(all).sort()).toEqual([...ORDER_FILES, "providers/mock-json.yml", "smoke.hafen.yml", "stage.env"].sort());
      await suiteRow(page, "smoke.hafen.yml").locator(".list-open").click();
      await expect(page.locator("#suiteCiHint")).toContainText("Runs all, exported just now with stage.env");
    });
  });
});

test.describe("Getting started's command line", () => {
  // A file written into the app's workspace (the browser's private file system)
  const writeOpfs = writeFile;

  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("Getting started's command line: the scope's Export .env, given to hafen with --env, runs the same files; without it, exit 2 and the line that says why", async ({ app: { page, servers } }) => {
    const files = {
      "providers/gs.yml": "kind: http\nurl: \"{{env.base_url}}/json\"\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n",
      "gs.hafen.yml": "version: 1\nname: smoke\nprovider: providers/gs.yml\ntests:\n  - name: refund\n    turns:\n      - user: I want a refund for order 4417\n        expect: [ { type: status, equals: 200 } ]\n      - user: It arrived broken\n        expect: [ { contains: refund } ]\n",
    };
    for (const [path, text] of Object.entries(files)) await writeOpfs(page, path, text);
    await reopen(page);
    await addScope(page, "local", { base_url: servers.mock.url });
    // In the app: the run fails as Getting started says (the second reply doesn't say "refund")
    await page.locator("#suiteList .list-open", { hasText: "refund" }).first().click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    // Export .env: local.env
    await page.click("#scopeButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#envExport")]);
    expect(download.suggestedFilename()).toBe("local.env");
    const exported = await readFile(await download.path(), "utf8");
    await page.click("#settingsClose");
    // The same files on the disk, and the exported file beside them
    const dir = await mkdtemp(join(tmpdir(), "hafen-getting-started-"));
    try {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeDisk(join(dir, path), text);
      }
      await writeDisk(join(dir, "local.env"), exported);
      const cli = (args) => new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "" } });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        child.on("close", (code) => resolve({ code, out }));
      });
      expect((await cli(["validate", ".", "--env", "local.env"])).code).toBe(0);
      const ran = await cli(["run", ".", "--env", "local.env"]);
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toMatch(/✗ smoke › refund/);
      for (const command of ["validate", "run"]) {
        const bare = await cli([command, "."]);
        expect(bare.code, bare.out).toBe(2);
        expect(bare.out).toContain("providers/gs.yml:2:7  {{env.base_url}} isn't set: no environment is chosen (the app's scope, or --env <file> in the CLI)");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

plain.describe("the desktop app", () => {
  plain.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

  const launch = (data, more = {}) => {
    const env = { ...process.env, HAFEN_LAB_DATA: data, ...more };
    delete env.ELECTRON_RUN_AS_NODE;
    return electron.launch({ args: [ROOT], cwd: ROOT, env });
  };

  // Its dialogs answered with this path
  const picks = (app, path) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path);

  plain("its workspace is in its data folder, kept across a restart; Import and Export go through its dialogs, and the folder exported runs with the command line", async () => {
    const mock = await startMock({ chunkMs: 10 });
    const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
    const source = await mkdtemp(join(tmpdir(), "hafen-source-"));
    const target = await mkdtemp(join(tmpdir(), "hafen-target-"));
    await onDisk(source, ORDERS);
    let app = await launch(data);
    try {
      let page = await app.firstWindow();
      await expect(page.locator("#threadAddProvider")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(/open a folder/i);
      // Import a folder (its dialog), into the workspace on the disk
      await picks(app, source);
      await page.click("#importSuites");
      await page.click("#menu-import-folder");
      await expect(suiteRow(page, "orders.hafen.yml")).toHaveCount(1);
      expect(await fromDisk(join(data, "workspace"))).toEqual(ORDERS);
      // Kept across a restart
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(suiteRow(page, "orders.hafen.yml")).toHaveCount(1);
      // A scope, its value and secret; then Export with secrets (its dialog; the secrets written by the
      // app itself, never through the page)
      await addScope(page, "stage", { base_url: mock.url });
      await page.evaluate(() => window.hafen.invoke("secrets_set", { env: "stage", name: "ORDERS_KEY", value: "k-desk-2" }));
      await page.reload();
      await page.locator("html:not(.loading)").waitFor();
      await suiteRow(page, "orders.hafen.yml").locator(".list-open").click();
      await picks(app, target);
      await page.click("#suiteExport");
      await page.click("#exportWithSecrets");
      await page.click("#exportWithSecrets");
      await expect(page.locator("#exportDialog")).toHaveCount(0);
      const out = await fromDisk(target);
      expect(Object.keys(out).sort()).toEqual([...ORDER_FILES, "stage.env", "stage.secret.env"].sort());
      expect(out["stage.secret.env"]).toContain("ORDERS_KEY=k-desk-2");
      await expect(page.locator("#suiteCiHint")).toContainText(`Runs ${target}, exported just now with stage.env and stage.secret.env`);
      // (from a folder with no plugins of its own: the target's are found beside its suites)
      const run = await cli(data, ["run", target, "--env", join(target, "stage.env"), "--secret", join(target, "stage.secret.env"), "--report", `run:${join(data, "run.json")}`]);
      expect(run.status, run.out).toBe(0);
    } finally {
      await app.close();
      await mock.close();
      for (const d of [data, source, target]) await rm(d, { recursive: true, force: true });
    }
  });
});
