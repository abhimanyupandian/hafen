// How a run's last try shows (contracts/ui.md, Top bar, Suites, Runs, Thread): a run that broke off
// before its test (a provider's fixture that couldn't reach its login) or was refused before sending
// anything (no scope for {{env.base_url}}) is what the top bar, the Suites tree, the test's thread and
// panel and Runs say, not the run before it; an errored run opened from Runs shows its error where the
// conversation would be, under its test's name; everywhere uses the same words (passed, failed, error,
// stopped, couldn't run); and a stopped test or message is grey, not red. In the browser build, and the
// errored run in the desktop app (Electron, as desktop.spec.js runs it).

import { _electron as electron } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";
import { addScope, chooseScope, expect, reopen, showEntry, test } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AUTH = "auth.hafen.yml";

// A login before the run (a provider's beforeAll fixture), at the scope's base_url: up, the mock's
// /login; down, an address nothing answers at
const LOGIN = `export default {
  kind: "fixture", name: "acme-login", version: "1.0.0", hosts: ["127.0.0.1"], provides: ["ACME_TOKEN"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa-bot" }, signal });
    if (res.status >= 400) throw new Error(\`the login answered \${res.status}\`);
    return { ACME_TOKEN: (await res.json()).access_token };
  },
};
`;
const BEHIND_LOGIN = `kind: http
url: "{{env.base_url}}/json"
login_url: "{{env.base_url}}/login"
headers: { x-token: "{{secret.ACME_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
fixtures: { beforeAll: [acme-login] }
`;
const AUTH_SUITE = `version: 1
name: Auth
provider: providers/behind-login.yml
tests:
  - name: login and chat
    id: t_auth0001
    turns:
      - user: I want a refund for order 4417
        expect: [{ type: status, equals: 200 }]
`;
const DOWN = "http://127.0.0.1:9";

const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const authFiles = async (page) => {
  await writeFile(page, "plugins/acme-login.js", LOGIN);
  await writeFile(page, "providers/behind-login.yml", BEHIND_LOGIN);
  await writeFile(page, AUTH, AUTH_SUITE);
};
const openApp = async (page, file = "smoke.hafen.yml") => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${file}"]`)).toHaveCount(1);
};
const suiteRow = (page, file) => page.locator(`#suiteList .list-row[data-file="${file}"]`).first();
const testRow = (page, name) => page.locator("#suiteList .list-row", { has: page.locator(".list-open", { hasText: name }) }).first();
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
const runRows = (page) => page.locator("#runList .list-row:not([id^='run-live-'])");
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);
const colour = (locator) => locator.evaluate((el) => getComputedStyle(el).color);

// No scope chosen: Settings → Environments, Globals, "choose no scope"
async function chooseNoScope(page) {
  await page.click("#scopeButton");
  await page.locator("#envGlobals").waitFor();
  await showEntry(page, "");
  if (await page.locator("#envChoose").count()) await page.click("#envChoose");
  await page.locator("#envChosen").waitFor();
  await page.click("#settingsClose");
  await page.locator("#settingsModal[open]").waitFor({ state: "detached" }).catch(() => {});
  await page.locator("#scopeAlert").waitFor();
}

// What a test errored by its fixture shows: the top bar, its row and its suite's, the thread, the panel
async function showsTheError(page) {
  const status = page.locator("#status");
  await expect(status).toHaveAttribute("data-status", "error");
  await expect(status).toHaveText(/^error · /);
  await expect(status).toHaveClass(/error/);
  await expect(status).toHaveAttribute("title", /^error: auth\.hafen\.yml: the fixture "acme-login" \(beforeAll\) failed/);
  await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("error");
  await expect(testRow(page, "login and chat")).toHaveAttribute("data-status", "error");
  await expect(testRow(page, "login and chat").locator(".list-open")).toHaveAttribute("title", /error: auth\.hafen\.yml: the fixture "acme-login"/);
  await expect(suiteRow(page, AUTH).locator(".list-size")).toHaveText("1 test · 1 error");
  // The thread: why, where the turns would be; the turn itself not run by it
  await expect(page.locator("#runError")).toBeVisible();
  await expect(page.locator("#runErrorStatus")).toHaveText(/^error · /);
  await expect(page.locator("#runError-0")).toContainText('the fixture "acme-login" (beforeAll) failed');
  await expect(page.locator("#turn-0 .turn-summary")).toHaveText("not run yet · 1 check");
  // The panel: its last run, and why
  await expect(page.locator("#testLastStatus")).toHaveText("error");
  await expect(page.locator("#testRunError")).toContainText('the fixture "acme-login" (beforeAll) failed');
}

test.describe("in the browser build", () => {
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("a run that errored, or couldn't run, is what the top bar, the Suites tree, the test and Runs show, not the run before it; opened from Runs, its error is in the middle under its test's name", async ({ app: { page, servers } }) => {
    await authFiles(page);
    await openApp(page, AUTH);
    await addScope(page, "up", { base_url: servers.mock.url });
    await openTest(page, "login and chat");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("passed 1/1");

    // Its login can't be reached: an error, everywhere, with why
    await addScope(page, "down", { base_url: DOWN });
    await page.click("#testRun");
    await expect(page.locator(".toast", { hasText: "Error: login and chat" })).toBeVisible();
    await showsTheError(page);
    await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
    await expect(runRows(page).first().locator(".list-label")).toHaveText("login and chat");

    // No scope: refused before anything's sent, and said so with its first problem (not a result)
    await chooseNoScope(page);
    await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
    await page.click("#testRun");
    await expect(page.locator(".toast", { hasText: "Couldn't run: login and chat" })).toBeVisible();
    expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
    const status = page.locator("#status");
    await expect(status).toHaveText(/^couldn't run: \{\{env\.base_url\}\} isn't set/);
    await expect(status).toHaveAttribute("data-status", "error");
    await expect(status).toHaveClass(/error/);
    await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("couldn't run");
    await expect(testRow(page, "login and chat")).toHaveAttribute("data-status", "error");
    await expect(page.locator("#runErrorStatus")).toHaveText(/^couldn't run · nothing was sent/);
    await expect(page.locator("#runError-0")).toContainText("{{env.base_url}} isn't set");
    await expect(page.locator("#testLastStatus")).toHaveText("couldn't run");
    await expect(page.locator("#testRunError")).toContainText("{{env.base_url}} isn't set");
    await expect(runRows(page).first().locator(".list-size")).toHaveText("couldn't run");
    await expect(runRows(page).locator(".list-size")).toHaveText(["couldn't run", "error", "passed"]);

    // The errored run, opened from Runs: its test's name, and its error where the conversation would be
    await runRows(page).nth(1).locator(".list-open").click();
    await expect(page.locator("#evalTitle")).toHaveText("login and chat · run");
    await expect(page.locator("#status")).toHaveText(/^error · /);
    await expect(page.locator("#runError-0")).toContainText('the fixture "acme-login" (beforeAll) failed');
    await expect(page.locator("#thread")).not.toContainText("isn't in the open folder");
    await expect(page.locator("#runTestsNone")).toHaveText("None ran: it broke off before its tests.");
    // The one that couldn't run, the same way
    await runRows(page).first().locator(".list-open").click();
    await expect(page.locator("#evalTitle")).toHaveText("login and chat · run");
    await expect(page.locator("#runErrorStatus")).toHaveText(/^couldn't run · nothing was sent/);
    await expect(page.locator("#runTestsNone")).toHaveText("None ran: it was refused before anything was sent.");

    // Up again, it passes, and that's what shows (in the panel too); reloaded, each run still says so
    await chooseScope(page, "up");
    await openTest(page, "login and chat");
    await page.click("#testRun");
    await expect(page.locator("#status")).toHaveText(/^passed 1\/1/);
    await expect(page.locator("#runError")).toHaveCount(0);
    await expect(page.locator("#testRunError")).toHaveCount(0);
    await openApp(page, AUTH);
    await expect(runRows(page).locator(".list-size")).toHaveText(["passed", "couldn't run", "error", "passed"]);
    await expect(runRows(page).locator(".list-label")).toHaveText(Array(4).fill("login and chat"));
    await expect(testRow(page, "login and chat").locator(".list-size")).toHaveText("passed 1/1");
  });

  test("a whole suite's run that broke off shows on each of its tests, and in its view", async ({ app: { page, servers } }) => {
    await authFiles(page);
    await openApp(page, AUTH);
    await addScope(page, "up", { base_url: servers.mock.url });
    await openTest(page, "login and chat");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    await addScope(page, "down", { base_url: DOWN });
    await suiteRow(page, AUTH).locator(".list-open").click();
    await page.click("#suiteRun");
    await expect(page.locator("#status")).toHaveText(/^error · /);
    await expect(page.locator("#status")).toHaveAttribute("title", /the fixture "acme-login" \(beforeAll\) failed/);
    await expect(page.locator("#runError-0")).toContainText('the fixture "acme-login" (beforeAll) failed');
    await expect(page.locator("#suiteTest-0 .turn-summary").first()).toHaveText(/^error · /);
    await expect(suiteRow(page, AUTH).locator(".list-size")).toHaveText("1 test · 1 error");
    await expect(runRows(page).first().locator(".list-label")).toHaveText("Auth");
    await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
    await openTest(page, "login and chat");
    await showsTheError(page);
  });

  test("one set of words: an errored test is `error` in Runs, its row, its suite's row and the top bar (not `failed`); a failed one `failed`", async ({ app: { page, servers } }) => {
    await writeFile(page, "providers/mock-err.yml", 'kind: http\nurl: "{{base_url}}/error/500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\nretries: 0\n');
    await writeFile(page, "broken.hafen.yml", `version: 1\nname: Broken\nprovider: providers/mock-err.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: errs\n    id: t_errs0001\n    turns:\n      - user: hi\n        expect: [{ contains: hello }]\n`);
    await openApp(page, "broken.hafen.yml");
    await openTest(page, "errs");
    await page.click("#testRun");
    await expect(page.locator("#status")).toHaveText(/^error · /);
    await expect(page.locator("#status")).toHaveAttribute("data-status", "error");
    await expect(testRow(page, "errs").locator(".list-size")).toHaveText("error");
    await expect(suiteRow(page, "broken.hafen.yml").locator(".list-size")).toHaveText("1 test · 1 error");
    await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
    await expect(runRows(page).first()).toHaveAttribute("data-status", "error");
    // (a test that errs on its own has its turns: no run error above them)
    await expect(page.locator("#runError")).toHaveCount(0);
    // A failure is a failure, in each place
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toHaveText(/^failed 0\/1/);
    await expect(testRow(page, "refund for a broken item").locator(".list-size")).toHaveText("failed 0/1");
    await expect(suiteRow(page, "smoke.hafen.yml").locator(".list-size")).toHaveText("1 test · 1 failed");
    await expect(runRows(page).first().locator(".list-size")).toHaveText("failed");
    // Both, in the same colour
    const danger = await token(page, "--danger");
    expect(await colour(runRows(page).first().locator(".list-size"))).toBe(danger);
    expect(await colour(runRows(page).nth(1).locator(".list-size"))).toBe(danger);
  });

  test("a stopped test and a stopped message are grey (stopped), not red: its turn's head, its tree row and the top bar", async ({ app: { page, servers } }) => {
    await writeFile(page, "providers/mock-slow.yml", 'kind: http\nurl: "{{base_url}}/slow?ms=4000"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n');
    await writeFile(page, "slow.hafen.yml", `version: 1\nname: Slow\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: takes its time\n    id: t_slow0001\n    turns:\n      - user: hi\n        expect: [{ type: status, equals: 200 }, { contains: hi }]\n`);
    await openApp(page, "slow.hafen.yml");
    const muted = await token(page, "--muted");
    const danger = await token(page, "--danger");
    // A test stopped while its turn waits for its reply
    await openTest(page, "takes its time");
    await page.click("#testRun");
    await expect(page.locator("#status")).toHaveText("running…");
    await page.click("#testHeaderRun");
    await expect(page.locator("#status")).toHaveText(/^stopped · /);
    await expect(page.locator("#status")).toHaveAttribute("data-status", "stopped");
    await expect(page.locator("#status")).not.toHaveClass(/error/);
    expect(await colour(page.locator("#status"))).toBe(muted);
    const head = page.locator("#turn-0 .turn-summary");
    await expect(head).toHaveText(/^stopped/);
    await expect(head).toHaveAttribute("data-status", "stopped");
    expect(await colour(head)).toBe(muted);
    await expect(page.locator("#turn-0-cut")).toHaveText("Stopped before any reply came.");
    expect(await colour(page.locator("#turn-0-cut"))).toBe(muted);
    // (its turn's row in the tree: turn-<test id>-<i>)
    const turnItem = page.locator("#turn-t_slow0001-0");
    await expect(turnItem.locator(".list-size")).toHaveText("stopped");
    await expect(turnItem).toHaveAttribute("data-status", "stopped");
    expect(await colour(turnItem.locator(".list-size"))).toBe(muted);
    expect(await colour(turnItem.locator(".turn-icon"))).toBe(muted);
    await expect(testRow(page, "takes its time").locator(".list-size")).toHaveText("stopped");
    expect(await colour(testRow(page, "takes its time").locator(".list-size"))).toBe(muted);
    await expect(suiteRow(page, "slow.hafen.yml").locator(".list-size")).toHaveText("1 test");
    await expect(runRows(page).first().locator(".list-size")).toHaveText("stopped");
    expect(await colour(runRows(page).first().locator(".list-size"))).toBe(muted);
    // Beside a failed one, red
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toHaveText(/^failed 0\/1/);
    const failed = page.locator("#turn-1 .turn-summary");
    await expect(failed).toHaveAttribute("data-status", "failed");
    expect(await colour(failed)).toBe(danger);
    // A message stopped while it waits
    await page.click("#newConversation");
    await page.selectOption("#convProvider", "providers/mock-slow.yml");
    await page.fill("#input", "hello?");
    await page.click("#send");
    await expect(page.locator("#status")).toHaveText("sending…");
    await page.click("#send");
    const message = page.locator("#turn-0 .turn-summary");
    await expect(message).toHaveText(/^stopped/);
    await expect(message).toHaveAttribute("data-status", "stopped");
    expect(await colour(message)).toBe(muted);
    await expect(page.locator("#turn-0-reply .msg-body.error")).toHaveCount(0);
    await expect(page.locator("#turn-0-cut")).toHaveText("Stopped before any reply came.");
  });
});

test("in the desktop app, a run whose fixture can't reach its login is what the top bar, the Suites tree and the test show, not the pass before it", async () => {
  test.skip(process.platform === "linux" && !process.env.DISPLAY, "needs a display (run under xvfb-run on Linux)");
  const mock = await startMock({ chunkMs: 10 });
  const data = await mkdtemp(join(tmpdir(), "hafen-data-"));
  // (the app's workspace, in its data folder: filled before it starts)
  const folder = join(data, "workspace");
  await cp(join(ROOT, "packages/hafen/tests/fixtures/suites"), folder, { recursive: true });
  const smoke = join(folder, "smoke.hafen.yml");
  await writeDisk(smoke, (await readFile(smoke, "utf8")).replace("http://127.0.0.1:8791", mock.url));
  await mkdir(join(folder, "plugins"));
  await writeDisk(join(folder, "plugins", "acme-login.js"), LOGIN);
  await writeDisk(join(folder, "providers", "behind-login.yml"), BEHIND_LOGIN);
  await writeDisk(join(folder, AUTH), AUTH_SUITE);
  const env = { ...process.env, HAFEN_LAB_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(suiteRow(page, AUTH)).toHaveCount(1);
    await addScope(page, "up", { base_url: mock.url });
    await openTest(page, "login and chat");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("passed 1/1");
    await addScope(page, "down", { base_url: DOWN });
    await page.click("#testRun");
    await showsTheError(page);
    await expect(page.locator("#status")).toHaveAttribute("title", /Couldn't reach http:\/\/127\.0\.0\.1:9\/login/);
    await expect(runRows(page).first().locator(".list-size")).toHaveText("error");
    await runRows(page).first().locator(".list-open").click();
    await expect(page.locator("#evalTitle")).toHaveText("login and chat · run");
    await expect(page.locator("#runError-0")).toContainText("Couldn't reach http://127.0.0.1:9/login");
  } finally {
    await app.close();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});
