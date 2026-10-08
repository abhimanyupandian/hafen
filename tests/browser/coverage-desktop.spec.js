// Coverage of contracts/ui.md, Head (and Settings → Secrets, which says nothing in words but, on a system
// that offers the app no encryption, that they're kept unencrypted) in the desktop app: a
// {{secret.NAME}} that Settings → Secrets has no value for takes the environment variable the app was
// started with; one Settings has (for the scope, or for every scope) wins over it; and neither value is
// in the runs the app keeps. In Electron, as desktop.spec.js runs it.

import { _electron as electron, expect, test } from "@playwright/test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { showEntry } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

test("a secret Settings hasn't got comes from the environment the desktop app was started with; one Settings has wins; neither is in the runs kept", async () => {
  const mock = await startMock({ chunkMs: 10 });
  // (the app's workspace, in a data folder of the test's own, filled before it starts)
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  const folder = join(data, "workspace");
  await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
  await writeFile(join(folder, "providers/keyed.yml"), `kind: http\nurl: "${mock.url}/json"\nheaders: { Authorization: "Bearer {{secret.HAFEN_COVER_KEY}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(join(folder, "keyed.hafen.yml"), "version: 1\nname: Keyed\nprovider: providers/keyed.yml\ntests:\n  - name: keyed hello\n    turns: [ { user: hello, expect: [ { type: status, equals: 200 } ] } ]\n");
  const env = { ...process.env, HAFEN_LAB_DATA: data, HAFEN_COVER_KEY: "k-from-env-4242" };
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
    // (no words, but a warning while the system offers the app no encryption)
    const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    if (encrypted) await expect(page.locator("#secretsNote")).toHaveCount(0);
    else await expect(page.locator("#secretsNote")).toHaveText("Kept unencrypted: this system offers the app no encryption yet.");
    await showEntry(page, "", "secrets");
    await page.fill("#secretName", "HAFEN_COVER_KEY");
    await page.fill("#secretValue", "k-from-app-1234");
    await page.press("#secretValue", "Enter");
    await expect(page.locator("#secret-HAFEN_COVER_KEY .vars-source")).toHaveText("Globals");
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
