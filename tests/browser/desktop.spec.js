// The desktop app (spec US3; research §4–5): Electron, the engine in a utility process (Node, as in
// CI), on the app's own workspace (<its data folder>/workspace: plain files), the window without a title
// bar, each run kept by the app, its notifications, and its secrets from the environment it started in.

import { _electron as electron, expect, test } from "@playwright/test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addScope, showEntry } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

// The app's workspace in a data folder of a test's own (HAFEN_DATA), filled with the fixture
// suites before the app starts, the mock's address in them: { data, folder (the workspace) }
async function workspaceWith(mock) {
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  const folder = join(data, "workspace");
  await mkdir(folder, { recursive: true });
  await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
  if (mock) {
    const suite = join(folder, "smoke.hafen.yml");
    await writeFile(suite, (await readFile(suite, "utf8")).replace("http://127.0.0.1:8791", mock.url));
  }
  return { data, folder };
}

test("runs a test in the desktop app, on its own workspace, and keeps the run", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const { data, folder } = await workspaceWith(mock);
  const env = { ...process.env, HAFEN_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("html")).toHaveClass(/app-window/);
    // Its icon, as Electron loads it (the Dock's when run from here; the window's on Windows and Linux)
    expect(await app.evaluate(({ nativeImage }, p) => nativeImage.createFromPath(p).getSize(), join(ROOT, "desktop/icons/icon.png"))).toEqual({ width: 1024, height: 1024 });
    // No folder asked for: the suites are the workspace's from the start. (Their environment is local:
    // the scope of that name, made and chosen, gives it.)
    await addScope(page, "local");
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    // The run is the app's (Runs), from the desktop app's engine; nothing is written beside the suites
    await expect(page.locator("#runList .list-row")).toHaveCount(1);
    const where = await page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const runs = await done(db.transaction("runs").objectStore("runs").getAll());
      db.close();
      return runs.map((r) => r.where.app);
    });
    expect(where).toEqual(["desktop"]);
    expect(await readdir(folder)).not.toContain(".hafen");
  } finally {
    await app.close();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("the desktop app edits the files in its workspace, and gets its engine back if it stops", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const { data, folder } = await workspaceWith(mock);
  const suite = join(folder, "smoke.hafen.yml");
  const env = { ...process.env, HAFEN_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const disk = async (file = "smoke.hafen.yml") => parse(await readFile(join(folder, file), "utf8"));
  const onDisk = (check, file) => expect.poll(async () => { try { return check(await disk(file)); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  try {
    const page = await app.firstWindow();
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
    // A test's name, a turn added and deleted
    await page.fill("#testName", "renamed on disk");
    await page.press("#testName", "Enter");
    await onDisk((d) => d.tests[0].name === "renamed on disk");
    await page.fill("#input", "a third turn");
    await page.click("#send");
    await onDisk((d) => d.tests[0].turns.length === 3);
    await page.click("#turnDelete");
    await page.click("#turnDelete");
    await onDisk((d) => d.tests[0].turns.length === 2);
    // A new suite, renamed, then deleted
    await page.click("#newSuite");
    await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
    await onDisk((d) => d.tests.length === 1, "tests.hafen.yml");
    await page.locator('#suiteList .list-row[data-file="tests.hafen.yml"] .list-open').click();
    await page.fill("#suiteFile", "checkout");
    await page.press("#suiteFile", "Enter");
    await onDisk((d) => d.tests.length === 1, "checkout.hafen.yml");
    await expect.poll(() => readdir(folder)).not.toContain("tests.hafen.yml");
    // (once the page has it by its new name: its panel's drawn afresh then, and a delete asked about
    // before would be forgotten)
    await expect(page.locator('#suiteList .list-row[data-file="checkout.hafen.yml"]')).toHaveCount(1);
    await expect(page.locator("#suiteFile")).toHaveValue("checkout");
    await page.click("#suiteDelete");
    await expect(page.locator("#suiteDelete")).toHaveClass(/confirm/);
    await page.click("#suiteDelete");
    await expect.poll(() => readdir(folder)).not.toContain("checkout.hafen.yml");
    // Delete the test
    await page.locator("#suiteList .list-open", { hasText: "renamed on disk" }).click();
    await page.click("#testDelete");
    await page.click("#testDelete");
    await onDisk((d) => Array.isArray(d.tests) && d.tests.length === 0);
    expect(await readFile(suite, "utf8")).toContain("tests: []");
    // The engine stops: it's started again, and the workspace is open again
    const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics());
    const engine = metrics.find((m) => m.type === "Utility" && m.name === "Hafen engine");
    expect(engine).toBeTruthy();
    process.kill(engine.pid, "SIGKILL");
    await expect(page.locator(".toast", { hasText: "The engine was restarted" })).toBeVisible({ timeout: 10000 });
    await page.click("#newSuite");
    await page.press("#newSuiteName", "Enter");  // (+ asks for a name: the one it offers)
    await onDisk((d) => d.tests.length === 1, "tests.hafen.yml");
    await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(1);
  } finally {
    await app.close();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("in development on macOS the app runs as Hafen (not Electron; its data folder apart from the hafen app's), and plugins load in its engine", async () => {
  test.skip(process.platform !== "darwin", "macOS names apps by their bundle");
  const { devElectron } = await import("../../desktop/start.js");
  const into = await mkdtemp(join(tmpdir(), "hafen-dev-"));
  const { data, folder } = await workspaceWith();
  await mkdir(join(folder, "plugins"));
  const { pluginTemplate } = await import("hafen/engine/plugin-templates.js");
  await writeFile(join(folder, "plugins", "polite.js"), pluginTemplate("check", "polite"));
  // One that imports a file outside plugins/: loaded from its file, its import resolves
  await mkdir(join(folder, "lib"));
  await writeFile(join(folder, "lib", "version.js"), 'export const version = "2.3.4";\n');
  await writeFile(join(folder, "plugins", "imported.js"), 'import { version } from "../lib/version.js";\nexport default { kind: "check", name: "imported", version, async check() { return { status: "pass", reason: "" }; } };\n');
  const executable = devElectron({ into });
  expect(executable).toContain("Hafen.app/Contents/MacOS/Electron");
  const { execFileSync } = await import("node:child_process");
  const plist = execFileSync("plutil", ["-p", join(executable, "..", "..", "Info.plist")], { encoding: "utf8" });
  expect(plist).toContain('"CFBundleName" => "Hafen"');
  expect(plist).toContain('"CFBundleDisplayName" => "Hafen"');
  expect(plist).toContain('"CFBundleIdentifier" => "dev.hafen.app.dev"');
  execFileSync("codesign", ["--verify", "--deep", join(executable, "..", "..", "..")]);
  const env = { ...process.env, HAFEN_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: [ROOT], cwd: ROOT, env });
  try {
    // Hafen: its name, the bundle (the menu bar, the Dock), the app menu, About and the window; its data
    // folder named by its id, apart from the hafen app's
    expect(await app.evaluate(({ app: a }) => [a.getName(), process.execPath.includes("Hafen.app")])).toEqual(["Hafen", true]);
    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map((i) => i.label).filter(Boolean));
    expect(menu).toEqual(expect.arrayContaining(["About Hafen", "Hide Hafen", "Quit Hafen"]));
    expect(menu.join(" ")).not.toContain("Lab");
    const page = await app.firstWindow();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe("Hafen");
    await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#plugin-polite")).toContainText("polite · check · 1.0.0");
    await expect(page.locator("#plugin-imported")).toContainText("imported · check · 2.3.4");
  } finally {
    await app.close();
    await rm(into, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("a run that ends while the window is in the background: the system's notification (on by default here); clicked, the window comes forward on what ran", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const { data } = await workspaceWith(mock);
  const env = { ...process.env, HAFEN_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  try {
    // The system's notifications, kept rather than shown (each one's click can then be made); on a
    // system with no notification service (Linux in CI), as if it had one
    await app.evaluate(({ Notification }) => {
      globalThis.__notes = [];
      Notification.isSupported = () => true;
      Notification.prototype.show = function show() { globalThis.__notes.push(this); };
    });
    const page = await app.firstWindow();
    await addScope(page, "local");
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
    // In the background (the page told it isn't in front), another view open
    await page.click("#newConversation");
    await page.evaluate(() => { document.hasFocus = () => false; });
    await page.locator("#suiteList .list-row[id^='test-']", { hasText: "refund for a broken item" }).hover();
    await page.locator("#suiteList .list-row[id^='test-']", { hasText: "refund for a broken item" }).locator("[id$='-run']").click();
    await page.click("#newConversation");
    await expect.poll(() => app.evaluate(() => globalThis.__notes.length), { timeout: 15000 }).toBe(1);
    expect(await app.evaluate(() => [globalThis.__notes[0].title, globalThis.__notes[0].silent])).toEqual(["Failed: refund for a broken item", true]);
    await expect(page.locator("#evalTitle")).toHaveText("New conversation");
    // Clicked: the page opens the test
    await page.evaluate(() => { document.hasFocus = () => true; });
    await app.evaluate(() => globalThis.__notes[0].emit("click"));
    await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
    await expect(page.locator("#testRun")).toBeVisible();
  } finally {
    await app.close();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});

// The system's keychain (which may ask the user to allow it) is used only when a secret's value is
// needed: a value set, and, started again, the first run that needs them. Never as the app starts, nor
// to list or forget what's kept.
test("the desktop app uses the system's keychain only when a secret's value is needed", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  const folder = join(data, "workspace");
  await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
  await writeFile(join(folder, "providers/keyed.yml"), `kind: http\nurl: "${mock.url}/json"\nheaders: { Authorization: "Bearer {{secret.HAFEN_COVER_KEY}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(join(folder, "keyed.hafen.yml"), "version: 1\nname: Keyed\nprovider: providers/keyed.yml\ntests:\n  - name: keyed hello\n    turns: [ { user: hello, expect: [ { type: status, equals: 200 } ] } ]\n");
  const env = { ...process.env, HAFEN_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HAFEN_COVER_KEY;
  const lastAuth = async () => (await (await fetch(`${mock.url}/_log`)).json()).at(-1)?.headers.authorization;
  const used = () => app.evaluate(() => globalThis.hafenKeychainUsed ?? false);
  const start = async () => {
    app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !document.documentElement.classList.contains("loading"));
    await expect(page.locator("#suiteList .list-open", { hasText: "keyed hello" })).toHaveCount(1);
    return page;
  };
  const secrets = async (page) => {
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await showEntry(page, "", "secrets");
  };
  let app;
  try {
    // Started, and Settings → Secrets with nothing kept: not used
    let page = await start();
    await secrets(page);
    expect(await used()).toBe(false);
    // A value set: used
    for (const [name, value] of [["HAFEN_COVER_KEY", "k-kept-1234"], ["HAFEN_SPARE_KEY", "k-spare-5678"]]) {
      await page.fill("#secretName", name);
      await page.fill("#secretValue", value);
      await page.press("#secretValue", "Enter");
      await expect(page.locator(`#secret-${name}`)).toHaveCount(1);
    }
    expect(await used()).toBe(true);
    await app.close();
    // Started again: the names listed, and one forgotten, without it
    page = await start();
    expect(await used()).toBe(false);
    await secrets(page);
    await expect(page.locator("#secret-HAFEN_COVER_KEY .vars-source")).toHaveText("Globals");
    await page.click("#secret-HAFEN_SPARE_KEY-forget");
    await page.click("#secret-HAFEN_SPARE_KEY-forget");
    await expect(page.locator("#secret-HAFEN_SPARE_KEY")).toHaveCount(0);
    expect(await used()).toBe(false);
    // The first run that needs them: used, and the value kept is the one sent
    await page.click("#settingsClose");
    await page.locator("#suiteList .list-open", { hasText: "keyed hello" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-kept-1234");
    expect(await used()).toBe(true);
    expect(Object.keys(JSON.parse(await readFile(join(data, "secrets.json"), "utf8"))[""])).toEqual(["HAFEN_COVER_KEY"]);
  } finally {
    await app?.close();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});

// A {{secret.NAME}} that Settings → Secrets has no value for takes the environment variable the app was
// started with; one Settings has (for the scope, or for every scope) wins over it; neither is in the runs
// the app keeps. (Settings → Secrets says nothing in words, but, with no encryption, that it's unencrypted
// once one's kept.)
test("a secret Settings hasn't got comes from the environment the desktop app was started with; one Settings has wins; neither is in the runs kept", async () => {
  const mock = await startMock({ chunkMs: 10 });
  // (the app's workspace, in a data folder of the test's own, filled before it starts)
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  const folder = join(data, "workspace");
  await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
  await writeFile(join(folder, "providers/keyed.yml"), `kind: http\nurl: "${mock.url}/json"\nheaders: { Authorization: "Bearer {{secret.HAFEN_COVER_KEY}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(join(folder, "keyed.hafen.yml"), "version: 1\nname: Keyed\nprovider: providers/keyed.yml\ntests:\n  - name: keyed hello\n    turns: [ { user: hello, expect: [ { type: status, equals: 200 } ] } ]\n");
  const env = { ...process.env, HAFEN_DATA: data, HAFEN_COVER_KEY: "k-from-env-4242" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const lastAuth = async () => (await (await fetch(`${mock.url}/_log`)).json()).at(-1)?.headers.authorization;
  try {
    const page = await app.firstWindow();
    // The runs the app keeps, each as its run file has it
    const runFiles = () => page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const db = await done(indexedDB.open("hafen"));
      const runs = await done(db.transaction("runs").objectStore("runs").getAll());
      db.close();
      return runs.map((r) => JSON.stringify(r));
    });
    await expect(page.locator('#suiteList .list-row[data-file="keyed.hafen.yml"]')).toHaveCount(1);
    // Nothing in Settings: the environment variable's
    await page.locator("#suiteList .list-open", { hasText: "keyed hello" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-from-env-4242");
    // Settings → Secrets, for every scope: that one wins
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#secretsNote")).toHaveCount(0);
    await showEntry(page, "", "secrets");
    await page.fill("#secretName", "HAFEN_COVER_KEY");
    await page.fill("#secretValue", "k-from-app-1234");
    await page.press("#secretValue", "Enter");
    await expect(page.locator("#secret-HAFEN_COVER_KEY .vars-source")).toHaveText("Globals");
    // (no words, but a warning while the system offers the app no encryption)
    const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    if (encrypted) await expect(page.locator("#secretsNote")).toHaveCount(0);
    else await expect(page.locator("#secretsNote")).toHaveText("Kept unencrypted: this system offers the app no encryption yet.");
    await page.click("#settingsClose");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-from-app-1234");
    // Forgotten again: the environment variable's once more
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await showEntry(page, "", "secrets");
    await page.click("#secret-HAFEN_COVER_KEY-forget");
    await page.click("#secret-HAFEN_COVER_KEY-forget");
    await page.click("#settingsClose");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-from-env-4242");
    // The runs kept: three, neither value in any
    await expect.poll(async () => (await runFiles()).length).toBe(3);
    for (const text of await runFiles()) {
      expect(text).not.toContain("k-from-env-4242");
      expect(text).not.toContain("k-from-app-1234");
    }
  } finally {
    await app.close();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});
