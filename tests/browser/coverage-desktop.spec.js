// Coverage of contracts/ui.md, Head (and Settings → Secrets' note) in the desktop app: a
// {{secret.NAME}} that Settings → Secrets has no value for takes the environment variable the app was
// started with; one Settings has (for the scope, or for every scope) wins over it; and neither value is
// written to the run file the folder's .hafen/runs gets. In Electron, as desktop.spec.js runs it.

import { _electron as electron, expect, test } from "@playwright/test";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");

test("a secret Settings hasn't got comes from the environment the desktop app was started with; one Settings has wins; neither is written to the run file", async () => {
  const mock = await startMock({ chunkMs: 10 });
  const folder = await mkdtemp(join(tmpdir(), "hafen-desktop-"));
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
  await writeFile(join(folder, "providers/keyed.yml"), `kind: http\nurl: "${mock.url}/json"\nheaders: { Authorization: "Bearer {{secret.HAFEN_COVER_KEY}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
  await writeFile(join(folder, "keyed.hafen.yml"), "version: 1\nname: Keyed\nprovider: providers/keyed.yml\ntests:\n  - name: keyed hello\n    turns: [ { user: hello, expect: [ { type: status, equals: 200 } ] } ]\n");
  const env = { ...process.env, HAFEN_LAB_DATA: data, HAFEN_COVER_KEY: "k-from-env-4242" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const lastAuth = async () => (await (await fetch(`${mock.url}/_log`)).json()).at(-1)?.headers.authorization;
  const runFiles = async () => Promise.all((await readdir(join(folder, ".hafen", "runs"))).map((f) => readFile(join(folder, ".hafen", "runs", f), "utf8")));
  try {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    const page = await app.firstWindow();
    await page.click("#openFolder");
    await expect(page.locator('#suiteList .list-row[data-file="keyed.hafen.yml"]')).toHaveCount(1);
    // Nothing in Settings: the environment variable's
    await page.locator("#suiteList .list-open", { hasText: "keyed hello" }).click();
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-from-env-4242");
    // Settings → Secrets, for every scope: that one wins
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await expect(page.locator("#settingsModal")).toContainText("A name with no value here uses the environment variable the app was started with");
    await page.selectOption("#secretsEnv", "");
    await page.fill("#secretName", "HAFEN_COVER_KEY");
    await page.fill("#secretValue", "k-from-app-1234");
    await page.click("#secretAdd button[type=submit]");
    await expect(page.locator("#secret-HAFEN_COVER_KEY .hint")).toContainText("set");
    await page.click("#settingsClose");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-from-app-1234");
    // Forgotten again: the environment variable's once more
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await page.selectOption("#secretsEnv", "");
    await page.click("#secret-HAFEN_COVER_KEY-forget");
    await page.click("#secret-HAFEN_COVER_KEY-forget");
    await page.click("#settingsClose");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    expect(await lastAuth()).toBe("Bearer k-from-env-4242");
    // The run files in the folder: three, neither value in any
    await expect.poll(async () => (await runFiles()).length).toBe(3);
    for (const text of await runFiles()) {
      expect(text).not.toContain("k-from-env-4242");
      expect(text).not.toContain("k-from-app-1234");
    }
  } finally {
    await app.close();
    await mock.close();
    await rm(folder, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
