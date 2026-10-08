// The scope chosen with the scope button reaching the endpoint (contracts/test-file.md, Scopes;
// contracts/ui.md, Head): its environment values (Settings → Environments), its secrets (Settings →
// Secrets) and each suite's environment of its name, as {{env.NAME}}, {{secret.NAME}} and {{NAME}}: in
// a conversation that carries on as the scope changes, in a test's run and a suite's, after a secret is
// changed, after a reload; and in the desktop app, after it's started again. The scopes are made in
// the app, as one makes them: nothing comes from the folder but the suite's environments.

import { _electron as electron, test as plain } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addScope, addSecret, chooseScope, expect, reopen, showEntry, test } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
  const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
    const parts = path.split("/");
    let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }, [path, text]);
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
    const env = { ...process.env, HAFEN_LAB_DATA: data };
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
