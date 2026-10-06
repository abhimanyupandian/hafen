// What the browser tests share: the mock endpoint, the relay serving the built app, and a folder the
// app "opens": the Origin Private File System, filled with the fixture suites, handed to the app in
// place of the folder picker.

import { test as base } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRelay } from "../../cli/relay.js";
import { startMock } from "../helpers.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/suites/", import.meta.url));

export async function fixtureFiles(mockUrl) {
  return {
    "smoke.hafen.yml": (await readFile(`${FIXTURES}smoke.hafen.yml`, "utf8")).replace("http://127.0.0.1:8791", mockUrl),
    "providers/mock-json.yml": await readFile(`${FIXTURES}providers/mock-json.yml`, "utf8"),
    "providers/mock-sse.yml": (await readFile(`${FIXTURES}providers/mock-sse.yml`, "utf8")).replace("{{scenario}}", "tools"),
  };
}

export const test = base.extend({
  servers: [async ({}, use) => {
    const mock = await startMock({ chunkMs: 20 });
    const relay = createRelay({ allow: [mock.url] });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    await use({ mock, url: `http://127.0.0.1:${relay.address().port}/` });
    relay.close();
    await mock.close();
  }, { scope: "worker" }],
  app: async ({ page, servers }, use) => {
    const files = await fixtureFiles(servers.mock.url);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.addInitScript((files) => {
      window.showDirectoryPicker = async () => {
        const root = await navigator.storage.getDirectory();
        for (const [path, text] of Object.entries(files)) {
          const parts = path.split("/");
          let dir = root;
          for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
          const handle = await dir.getFileHandle(parts.at(-1), { create: true });
          const w = await handle.createWritable();
          await w.write(text);
          await w.close();
        }
        return root;
      };
    }, files);
    await page.goto(servers.url);
    await page.locator("html:not(.loading)").waitFor();
    await use({ page, errors, servers });
  },
});

export { expect } from "@playwright/test";

// The text of a file in the folder the app opened. While the engine writes a file it's swapped in
// (createWritable), and for a moment can't be read or found: it's read again a little later.
export const fileText = (page, path) => page.evaluate(async (path) => {
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

// Choose a scope as one does: the scope button at the top of the sidebar opens Settings →
// Environments, where it's chosen ("choose it"); then Settings is closed and the button names it.
export async function chooseScope(page, name) {
  await page.click("#scopeButton");
  await page.locator("#envScope").waitFor();
  await page.selectOption("#envScope", name);
  if (await page.locator("#envChoose").count()) await page.click("#envChoose");
  await page.locator("#envChosen").waitFor();
  await page.click("#settingsClose");
  await page.locator("#settingsModal[open]").waitFor({ state: "detached" }).catch(() => {});
  await page.locator("#scopeButton .scope-name", { hasText: name }).waitFor();
}
