// The desktop app (spec US3; research §4–5): Electron, the engine in a utility process (Node, as in
// CI), the window without a title bar, and each run written to the folder's .hafen/runs.

import { _electron as electron, expect, test } from "@playwright/test";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { startMock } from "../helpers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

test("runs a test in the desktop app and writes the run file", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const folder = await mkdtemp(join(tmpdir(), "hafen-desktop-"));
  await cp(join(ROOT, "tests/fixtures/suites"), folder, { recursive: true });
  const suite = join(folder, "smoke.hafen.yml");
  await writeFile(suite, (await readFile(suite, "utf8")).replace("http://127.0.0.1:8791", mock.url));
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  const env = { ...process.env, HAFEN_LAB_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  try {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    const page = await app.firstWindow();
    await expect(page.locator("html")).toHaveClass(/app-window/);
    // Its icon, as Electron loads it (the Dock's when run from here; the window's on Windows and Linux)
    expect(await app.evaluate(({ nativeImage }, p) => nativeImage.createFromPath(p).getSize(), join(ROOT, "desktop/icons/icon.png"))).toEqual({ width: 1024, height: 1024 });
    await page.click("#openFolder");
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    const runs = await readdir(join(folder, ".hafen", "runs"));
    expect(runs).toHaveLength(1);
    const run = JSON.parse(await readFile(join(folder, ".hafen", "runs", runs[0]), "utf8"));
    expect(run.where.app).toBe("desktop");
    expect(await readFile(join(folder, ".hafen", ".gitignore"), "utf8")).toContain("*");
  } finally {
    await app.close();
    await mock.close();
    await rm(folder, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("the desktop app edits the files on disk, and gets its engine back if it stops", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const folder = await mkdtemp(join(tmpdir(), "hafen-desktop-"));
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  await cp(join(ROOT, "tests/fixtures/suites"), folder, { recursive: true });
  const suite = join(folder, "smoke.hafen.yml");
  await writeFile(suite, (await readFile(suite, "utf8")).replace("http://127.0.0.1:8791", mock.url));
  const env = { ...process.env, HAFEN_LAB_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const disk = async (file = "smoke.hafen.yml") => parse(await readFile(join(folder, file), "utf8"));
  const onDisk = (check, file) => expect.poll(async () => { try { return check(await disk(file)); } catch { return false; } }, { timeout: 5000 }).toBe(true);
  try {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    const page = await app.firstWindow();
    await page.click("#openFolder");
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
    await onDisk((d) => d.tests.length === 1, "tests.hafen.yml");
    await page.locator('#suiteList .list-row[data-file="tests.hafen.yml"] .list-open').click();
    await page.fill("#suiteFile", "checkout");
    await page.press("#suiteFile", "Enter");
    await onDisk((d) => d.tests.length === 1, "checkout.hafen.yml");
    await expect.poll(() => readdir(folder)).not.toContain("tests.hafen.yml");
    await page.click("#suiteDelete");
    await page.click("#suiteDelete");
    await expect.poll(() => readdir(folder)).not.toContain("checkout.hafen.yml");
    // Delete the test
    await page.locator("#suiteList .list-open", { hasText: "renamed on disk" }).click();
    await page.click("#testDelete");
    await page.click("#testDelete");
    await onDisk((d) => Array.isArray(d.tests) && d.tests.length === 0);
    expect(await readFile(suite, "utf8")).toContain("tests: []");
    // The engine stops: it's started again, and the folder is open again
    const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics());
    const engine = metrics.find((m) => m.type === "Utility" && m.name === "Hafen engine");
    expect(engine).toBeTruthy();
    process.kill(engine.pid, "SIGKILL");
    await expect(page.locator(".toast", { hasText: "The engine was restarted" })).toBeVisible({ timeout: 10000 });
    await page.click("#newSuite");
    await onDisk((d) => d.tests.length === 1, "tests.hafen.yml");
    await expect(page.locator('#suiteList .list-row[data-file="tests.hafen.yml"]')).toHaveCount(1);
  } finally {
    await app.close();
    await mock.close();
    await rm(folder, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("in development on macOS the app runs as Hafen (not Electron; Hafen Lab inside, beside the hafen app), and plugins load in its engine", async () => {
  test.skip(process.platform !== "darwin", "macOS names apps by their bundle");
  const { devElectron } = await import("../../desktop/start.js");
  const into = await mkdtemp(join(tmpdir(), "hafen-dev-"));
  const folder = await mkdtemp(join(tmpdir(), "hafen-desktop-"));
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  await cp(join(ROOT, "tests/fixtures/suites"), folder, { recursive: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(folder, "plugins"));
  const { pluginTemplate } = await import("../../engine/plugin-templates.js");
  await writeFile(join(folder, "plugins", "polite.js"), pluginTemplate("check", "polite"));
  const executable = devElectron({ into });
  expect(executable).toContain("Hafen.app/Contents/MacOS/Electron");
  const { execFileSync } = await import("node:child_process");
  const plist = execFileSync("plutil", ["-p", join(executable, "..", "..", "Info.plist")], { encoding: "utf8" });
  expect(plist).toContain('"CFBundleName" => "Hafen"');
  expect(plist).toContain('"CFBundleDisplayName" => "Hafen"');
  expect(plist).toContain('"CFBundleIdentifier" => "dev.hafen.lab.dev"');
  execFileSync("codesign", ["--verify", "--deep", join(executable, "..", "..", "..")]);
  const env = { ...process.env, HAFEN_LAB_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: [ROOT], cwd: ROOT, env });
  try {
    // Inside, Hafen Lab (its data folder's and keychain entry's name, apart from the hafen app's); seen,
    // Hafen: the bundle (the menu bar, the Dock), the app menu, About and the window
    expect(await app.evaluate(({ app: a }) => [a.getName(), process.execPath.includes("Hafen.app")])).toEqual(["Hafen Lab", true]);
    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map((i) => i.label).filter(Boolean));
    expect(menu).toEqual(expect.arrayContaining(["About Hafen", "Hide Hafen", "Quit Hafen"]));
    expect(menu.join(" ")).not.toContain("Lab");
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    const page = await app.firstWindow();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe("Hafen");
    await page.click("#openFolder");
    await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
    await page.click("#openSettings");
    await page.click("#settings-tab-plugins");
    await expect(page.locator("#plugin-polite")).toContainText("polite · check · 1.0.0");
  } finally {
    await app.close();
    await rm(into, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("what the app kept as hafen eval (its data folder, its database) is carried over to Hafen once", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const folder = await mkdtemp(join(tmpdir(), "hafen-desktop-"));
  const legacy = await mkdtemp(join(tmpdir(), "hafen-legacy-"));
  const fresh = await mkdtemp(join(tmpdir(), "hafen-data-"));
  await cp(join(ROOT, "tests/fixtures/suites"), folder, { recursive: true });
  const suite = join(folder, "smoke.hafen.yml");
  await writeFile(suite, (await readFile(suite, "utf8")).replace("http://127.0.0.1:8791", mock.url));
  const launch = (env) => {
    const e = { ...process.env, ...env };
    delete e.ELECTRON_RUN_AS_NODE;
    return electron.launch({ args: [ROOT], cwd: ROOT, env: e });
  };
  try {
    // The old app's data: a run in its database ("hafen-eval"), and the dark theme chosen
    let app = await launch({ HAFEN_LAB_DATA: legacy });
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    let page = await app.firstWindow();
    await page.click("#openFolder");
    await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    await page.click("#openSettings");
    await page.click("#settings-tab-appearance");
    await page.selectOption("#themeSelect", "dark");
    const runId = await page.evaluate(async () => {
      const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const now = await done(indexedDB.open("hafen"));
      const runs = await done(now.transaction("runs").objectStore("runs").getAll());
      const old = indexedDB.open("hafen-eval", 2);
      old.onupgradeneeded = () => { old.result.createObjectStore("runs", { keyPath: "_id" }); old.result.createObjectStore("conversations", { keyPath: "_id" }); };
      const legacyDb = await done(old);
      const tx = legacyDb.transaction("runs", "readwrite");
      for (const r of runs) tx.objectStore("runs").put({ ...r, kind: "hafen-eval-run" });
      await new Promise((r) => { tx.oncomplete = r; });
      const clear = now.transaction("runs", "readwrite");
      clear.objectStore("runs").clear();
      await new Promise((r) => { clear.oncomplete = r; });
      legacyDb.close();
      now.close();
      return runs[0]._id;
    });
    await app.close();

    // Hafen, on a data folder of its own, carrying over from the old one
    app = await launch({ HAFEN_LAB_DATA: fresh, HAFEN_LAB_CARRY_FROM: legacy });
    page = await app.firstWindow();
    await expect(page.locator(`#run-${runId}`)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const mark = JSON.parse(await readFile(join(fresh, "carried-over.json"), "utf8"));
    expect(mark.copied).toEqual(expect.arrayContaining(["IndexedDB", "Local Storage"]));
    await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort())).toEqual(["hafen"]);
    await app.close();

    // Once only: started again, nothing is copied over what's there now
    const { stat } = await import("node:fs/promises");
    const before = (await stat(join(fresh, "carried-over.json"))).mtimeMs;
    app = await launch({ HAFEN_LAB_DATA: fresh, HAFEN_LAB_CARRY_FROM: legacy });
    page = await app.firstWindow();
    await expect(page.locator(`#run-${runId}`)).toBeVisible();
    expect((await stat(join(fresh, "carried-over.json"))).mtimeMs).toBe(before);
    await app.close();
  } finally {
    await mock.close();
    for (const d of [folder, legacy, fresh]) await rm(d, { recursive: true, force: true });
  }
});

test("a run that ends while the window is in the background: the system's notification (on by default here); clicked, the window comes forward on what ran", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const folder = await mkdtemp(join(tmpdir(), "hafen-desktop-"));
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  await cp(join(ROOT, "tests/fixtures/suites"), folder, { recursive: true });
  const suite = join(folder, "smoke.hafen.yml");
  await writeFile(suite, (await readFile(suite, "utf8")).replace("http://127.0.0.1:8791", mock.url));
  const env = { ...process.env, HAFEN_LAB_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  try {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    // The system's notifications, kept rather than shown (each one's click can then be made)
    await app.evaluate(({ Notification }) => {
      globalThis.__notes = [];
      Notification.prototype.show = function show() { globalThis.__notes.push(this); };
    });
    const page = await app.firstWindow();
    await page.click("#openFolder");
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
    await rm(folder, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
