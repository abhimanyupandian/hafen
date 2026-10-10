// What the browser tests share: the mock endpoint, the relay serving the built app, and the app's
// workspace (the Origin Private File System's workspace/ folder, which the browser build keeps its
// suites, providers and plugins in), filled with the fixture suites before the app loads.

import { expect, test as base } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRelay } from "../../server/relay.js";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";

const FIXTURES = fileURLToPath(new URL("../../packages/hafen/tests/fixtures/suites/", import.meta.url));

export async function fixtureFiles(mockUrl) {
  return {
    "smoke.hafen.yml": (await readFile(`${FIXTURES}smoke.hafen.yml`, "utf8")).replace("http://127.0.0.1:8791", mockUrl),
    "providers/mock-json.yml": await readFile(`${FIXTURES}providers/mock-json.yml`, "utf8"),
    "providers/mock-sse.yml": (await readFile(`${FIXTURES}providers/mock-sse.yml`, "utf8")).replace("{{scenario}}", "tools"),
  };
}

// Files written into the app's workspace (paths to text), as it keeps them: in the page's origin, so
// from any page of it (the app, or before it loads, the relay's own)
export const writeFiles = (page, files) => page.evaluate(async (files) => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("workspace", { create: true });
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
}, files);
export const writeFile = (page, path, text) => writeFiles(page, { [path]: text });

// The app loaded again (it reads its workspace as it starts): after files are written into it, say
export async function reopen(page) {
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
}

// workspace: the files the app starts with (none: an empty workspace, a first start); by default the
// fixture suites and their providers, the mock's address in them. scope: the scope the app has made and
// chosen as it starts (null: none); by default, with the fixture suites, local: their environment's name
// (the engine takes a suite's environment only of the scope chosen's name, never its first by itself)
export const test = base.extend({
  servers: [async ({}, use) => {
    const mock = await startMock({ chunkMs: 20 });
    const relay = createRelay({ allow: [mock.url] });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    await use({ mock, url: `http://127.0.0.1:${relay.address().port}/` });
    relay.close();
    await mock.close();
  }, { scope: "worker" }],
  workspace: [undefined, { option: true }],
  scope: [undefined, { option: true }],
  app: async ({ page, servers, workspace, scope }, use) => {
    const files = workspace ?? (await fixtureFiles(servers.mock.url));
    const chosen = scope === undefined ? (workspace === undefined ? "local" : null) : scope;
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    // (the workspace filled, and the scope made, from a page of the app's origin, before the app itself loads)
    if (Object.keys(files).length || chosen) {
      await page.goto(`${servers.url}relay/ping`);
      await writeFiles(page, files);
      if (chosen) await page.evaluate((name) => { localStorage.setItem("eval.scopes", JSON.stringify([name])); localStorage.setItem("eval.env", name); }, chosen);
    }
    await page.goto(servers.url);
    await page.locator("html:not(.loading)").waitFor();
    await use({ page, errors, servers });
  },
});

export { expect };

// The text of a file in the browser's private file system (path from its top: workspace/… is the
// app's workspace). While the engine writes a file it's swapped in (createWritable), and for a moment
// can't be read or found: it's read again a little later.
export const storedText = (page, path) => page.evaluate(async (path) => {
  const parts = path.split("/");
  for (let tries = 0; ; tries++) {
    try {
      let dir = await navigator.storage.getDirectory();
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      return await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    } catch (err) {
      if (!["NotReadableError", "NotFoundError"].includes(err.name) || tries >= 20) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}, path);
// The text of a file in the app's workspace
export const fileText = (page, path) => storedText(page, `workspace/${path}`);

// The folder picker (Import a folder, Export) answered with a folder of the browser's private file
// system, beside the workspace (`name`), as a folder on the disk would be; filled with `files` first
export async function pickFolder(page, name, files = {}) {
  await page.evaluate(async ([name, files]) => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      let dir = folder;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    window.showDirectoryPicker = async () => folder;
  }, [name, files]);
}
// Every file in a folder of the browser's private file system: { path: text }
export const storedFiles = (page, name) => page.evaluate(async (name) => {
  const out = {};
  const walk = async (dir, prefix) => {
    for await (const [entry, handle] of dir.entries()) {
      if (handle.kind === "directory") await walk(handle, `${prefix}${entry}/`);
      else out[`${prefix}${entry}`] = await (await handle.getFile()).text();
    }
  };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), "");
  return out;
}, name);

// Make a scope as one does, and choose it: the scope button at the top of the sidebar opens Settings →
// Environments, where it's added (Scopes' +, its name, add: shown once it's made; one there already, as
// the fixture suites' local is, shown), given its values in the table's last row (Enter adds each) and
// chosen ("choose it"); then Settings is closed and the button names it. (Only this makes a scope: a suite's environment
// of the same name gives it values, but isn't one.)
export async function addScope(page, name, values = {}) {
  await page.click("#scopeButton");
  await page.locator("#envScopes, #environmentsEmpty").first().waitFor();
  if (await page.locator(`[id="envScope-${name}"]`).count()) await showEntry(page, name);
  else await newScope(page, name);
  for (const [key, value] of Object.entries(values)) await addValue(page, key, value);
  if (await page.locator("#envChoose").count()) await page.click("#envChoose");
  await expect(page.locator("#envChosen")).toHaveText("chosen now");
  await page.click("#settingsClose");
  await page.locator("#settingsModal[open]").waitFor({ state: "detached" }).catch(() => {});
  await page.locator("#scopeButton .scope-name", { hasText: name }).waitFor();
}

// In Settings → Environments (or Secrets): a new scope, made with Scopes' + (its form is open already
// while there are none), then shown
export async function newScope(page, name, pane = "env") {
  if (!(await page.locator("#newScopeName").isVisible())) await page.click("#newScope");
  await page.fill("#newScopeName", name);
  await page.click("#newScopeForm button[type=submit]");
  await expect(page.locator(`#${pane}Scope-${name}`)).toHaveClass(/active/);
}

// In Settings → Environments: show an entry ("" Globals), as a click on its row does
export async function showEntry(page, name, pane = "env") {
  await page.click(name ? `#${pane}Scope-${name}-open` : `#${pane}Globals-open`);
  await expect(page.locator(name ? `#${pane}Scope-${name}` : `#${pane}Globals`)).toHaveClass(/active/);
}

// In Settings → Environments: a value added to the entry shown, in the table's last row (it has no add
// button: Enter in its value adds it)
export async function addValue(page, name, value) {
  await page.fill("#envVarName", name);
  await page.fill("#envVarValue", value);
  await page.press("#envVarValue", "Enter");
  await expect(page.locator(`[id="envVar-${name}"] input`)).toHaveValue(value);
}

// In Settings → Secrets: a secret added to the entry shown, in the table's last row (Enter adds it)
export async function addSecret(page, name, value) {
  await page.fill("#secretName", name);
  await page.fill("#secretValue", value);
  await page.press("#secretValue", "Enter");
  await expect(page.locator(`[id="secret-${name}"] .vars-source`)).not.toHaveText("not set");
  await expect(page.locator(`[id="secret-${name}"]`)).toHaveAttribute("data-source", /own|override/);
}

// Choose a scope as one does ("" or null: none, Globals alone): the scope button at the top of the
// sidebar opens Settings → Environments, where it's shown and chosen ("choose it", or Globals' "choose no
// scope"); then Settings is closed and the button says so.
export async function chooseScope(page, name) {
  await page.click("#scopeButton");
  await page.locator("#envGlobals").waitFor();
  await showEntry(page, name || "");
  if (await page.locator("#envChoose").count()) await page.click("#envChoose");
  await expect(page.locator("#envChosen")).toHaveText(name ? "chosen now" : "no scope chosen");
  await page.click("#settingsClose");
  await page.locator("#settingsModal[open]").waitFor({ state: "detached" }).catch(() => {});
  if (name) await page.locator("#scopeButton .scope-name", { hasText: name }).waitFor();
  else await expect(page.locator("#scopeButton")).toHaveAttribute("data-scope", "");
}

// In Settings → Providers, a provider open: its YAML's section opened, as a click on its head does (it's
// closed until it's opened, then remembered so), and the field shown
export async function openYaml(page) {
  const toggle = page.locator("#providerYamlToggle");
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(page.locator("#providerYaml")).toBeVisible();
}
