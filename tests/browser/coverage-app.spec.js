// Coverage of docs/app.md, docs/getting-started.md and contracts/ui.md that the other browser tests
// don't reach, in the browser build: a run's Compare with (an earlier run of its suites: pass rate,
// p50, p95 and cost, the checks that flipped, and a regression said); every operator the response's
// Add check form offers, each written as the check it says; a test's charts of its last runs; a turn's
// fixed reply with pinned history; the suite's YAML editor saved with YAML that doesn't parse (kept,
// said, fixable); Settings → Relay, saying the relay answers; Settings → Secrets saying, in the browser
// build, that its values are kept unencrypted; a new scope's name rules; Shift+Enter in the message
// box; a suite's panel listing an old spelling among its problems; and Getting started's command line,
// the scope's Export .env given to hafen with --env. (System One's Review, Agree and Disagree, isn't
// built: the coverage audit's failing/check-review.spec.js holds it.)

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile as writeDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { addScope, expect, fileText, test } from "./fixtures.js";

const CLI = fileURLToPath(new URL("../../packages/hafen/cli/hafen.js", import.meta.url));
// A file written into the folder the app opened (the browser's private file system)
const writeOpfs = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);

const SUITE = "smoke.hafen.yml";
const suiteData = async (page) => parse(await fileText(page, SUITE));
const fileSays = (page, check) => expect.poll(async () => { try { return check(await suiteData(page)); } catch { return false; } }, { timeout: 5000 }).toBe(true);
const openTest = (page, name = "refund for a broken item") => page.locator("#suiteList .list-open", { hasText: name }).first().click();
const turnRow = (page, n) => page.locator(`#suiteList .list-open[aria-label^="turn ${n}:"]`).first();
const run = async (page, status) => {
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText(status);
  await expect(page.locator("#runList li[id^='run-live-']")).toHaveCount(0);
};

test.beforeEach(async ({ app: { page } }) => {
  await page.click("#openFolder");
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("a run's Compare with: an earlier run of its suites, each number as run · was · change, the checks that flipped, and a regression said", async ({ app: { page } }) => {
  await openTest(page);
  await run(page, "failed 0/1");
  // Turn 2's message changed so its check (contains refund) passes: the same check, flipped
  await turnRow(page, 2).click();
  await page.fill("#turnUser", "a refund, please");
  await page.locator("#turnUser").blur();
  await fileSays(page, (d) => d.tests[0].turns[1].user === "a refund, please");
  await openTest(page);
  await run(page, "passed 1/1");
  // The later run (newest first), compared with the earlier
  await expect(page.locator("#runList .list-row")).toHaveCount(2);
  await page.locator("#runList .list-open").first().click();
  await expect(page.locator("#evalTitle")).toHaveText(/· run$/);
  await expect(page.locator("#runBaseline option")).toHaveCount(2);
  await expect(page.locator("#runComparison")).toHaveCount(0);
  await page.selectOption("#runBaseline", { index: 1 });
  const facts = page.locator("#runComparison");
  await expect(facts).toContainText("pass rate");
  await expect(facts).toContainText("100% · was 0% · +100 pts");
  for (const label of ["p50", "p95", "cost"]) await expect(facts).toContainText(label);
  await expect(facts).toContainText(/cost\s*\$[\d.]+ · was \$[\d.]+/);
  await expect(page.locator("#panel")).toContainText("refund for a broken item · turn 2 · contains refund: fail → pass");
  // (the app's thresholds are pass_rate 5, p95 20%, cost 20%: the pass rate rose, so it isn't that)
  await expect(page.locator("#panel .hint.error", { hasText: "pass rate fell" })).toHaveCount(0);
  // The earlier run, compared with the later one: it's worse, and said so
  await page.locator("#runList .list-open").nth(1).click();
  // (another run open: its own choice, none yet, and no comparison of the other's left showing)
  await expect(page.locator("#status")).toContainText("failed");
  await expect(page.locator("#runBaseline")).toHaveValue("");
  await expect(page.locator("#runComparison")).toHaveCount(0);
  await page.selectOption("#runBaseline", { index: 1 });
  await expect(page.locator("#runComparison")).toContainText("0% · was 100% · -100 pts");
  await expect(page.locator("#panel")).toContainText("refund for a broken item · turn 2 · contains refund: pass → fail");
  await expect(page.locator("#panel .hint.error")).toContainText("Regressed: pass rate fell 100 points (limit 5)");
});

test("a value of the response, checked with each operator the form offers: the check it says, in the file", async ({ app: { page } }) => {
  await openTest(page);
  await run(page, "failed 0/1");
  const add = async (value, op, typed) => {
    await turnRow(page, 1).click();
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
    await page.locator("#turnResponse .json-value").filter({ hasText: value }).first().click();
    await page.selectOption("#pathOp", op);
    if (typed !== undefined) await page.fill("#pathValue", typed);
    else await expect(page.locator("#pathValue")).toHaveCount(0);
    await page.click("#pathAdd");
    await expect(page.locator("#panel .panel-head")).toContainText("Check");
  };
  // (a number's operator starts on equals, its value filled in; a text's on contains)
  await turnRow(page, 1).click();
  await page.locator("#turnResponse .json-value").filter({ hasText: /^4417$/ }).click();
  await expect(page.locator("#pathOp")).toHaveValue("equals");
  await expect(page.locator("#pathValue")).toHaveValue("4417");
  await page.locator("#turnResponse .json-value").filter({ hasText: /^"sess_1"$|^sess_1$/ }).first().click();
  await expect(page.locator("#pathOp")).toHaveValue("contains");
  await expect(page.locator("#pathValue")).toHaveValue("sess_1");
  await add(/^4417$/, "not_equals", "4418");
  await add(/^4417$/, "gt", "4000");
  await add(/^4417$/, "lt", "5000");
  await add(/^4417$/, "type_is", "integer");
  await add(/^4417$/, "exists");
  await add(/^"sess_1"$|^sess_1$/, "matches", "^sess_\\d+$");
  await fileSays(page, (d) => d.tests[0].turns[0].expect.length === 10);
  expect((await suiteData(page)).tests[0].turns[0].expect.slice(4)).toEqual([
    { path: "$.data.order.id", not_equals: 4418 },
    { path: "$.data.order.id", gt: 4000 },
    { path: "$.data.order.id", lt: 5000 },
    { path: "$.data.order.id", type_is: "integer" },
    { path: "$.data.order.id", exists: true },
    { path: "$.session_id", matches: "^sess_\\d+$" },
  ]);
  // Each passes when the test runs again
  await openTest(page);
  await run(page, "failed 0/1");
  await expect(page.locator("#turn-0-reply .check-badge[data-status='pass']")).toHaveCount(10);
});

test("a test's charts: pass rate, p95 and cost over its runs, once it has two", async ({ app: { page } }) => {
  await openTest(page);
  await expect(page.locator("#testChartPass")).toHaveCount(0);
  await run(page, "failed 0/1");
  await expect(page.locator("#testChartPass")).toHaveCount(0);
  await run(page, "failed 0/1");
  for (const [id, label] of [["testChartPass", "Pass rate"], ["testChartP95", "p95"], ["testChartCost", "Cost"]]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator(`#${id}`)).toHaveAttribute("aria-label", new RegExp(`^${label}: latest `));
  }
  await expect(page.locator("#testChartPass")).toHaveAttribute("aria-label", "Pass rate: latest 0%, from 0% to 0%");
  await expect(page.locator("#testChartPass .chart-point")).toHaveCount(2);
});

test("with pinned history a turn has a fixed reply, written to the file; with live history it has none", async ({ app: { page } }) => {
  await openTest(page);
  await turnRow(page, 1).click();
  await expect(page.locator("#turnReply")).toHaveCount(0);
  await openTest(page);
  await page.selectOption("#testHistory", "pinned");
  await fileSays(page, (d) => d.tests[0].history === "pinned");
  await turnRow(page, 1).click();
  await expect(page.locator("#turnReply")).toBeVisible();
  await page.fill("#turnReply", "A FIXED REPLY");
  await page.locator("#turnReply").blur();
  await fileSays(page, (d) => d.tests[0].turns[0].reply === "A FIXED REPLY");
  // Back to live: the field goes, the file keeps the reply (it's the turn's, for another time)
  await openTest(page);
  await page.selectOption("#testHistory", "live");
  await fileSays(page, (d) => d.tests[0].history === undefined || d.tests[0].history === "live");
  await turnRow(page, 1).click();
  await expect(page.locator("#turnReply")).toHaveCount(0);
});

test("Settings → Relay (the browser build): the relay's address, and that it answers with the endpoints it allows", async ({ app: { page, servers, errors } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-relay");
  await expect(page.locator("#relayAddress")).toHaveValue(servers.url.replace(/\/$/, ""));
  await expect(page.locator(".server-status.ok")).toHaveText("The relay answers, allowing 1 endpoint prefix.");
  // An address with no relay: said so, and how to start one
  await page.fill("#relayAddress", "http://127.0.0.1:59998");
  await page.locator("#relayAddress").press("Enter");
  await expect(page.locator(".server-status.error")).toHaveText("No relay answers there. Start one in Hafen's folder: npm run serve -- --allow-endpoint <url>");
  // (the browser logs the refused connection itself: that's the one error expected here)
  for (let i = errors.length - 1; i >= 0; i--) if (/Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(errors[i])) errors.splice(i, 1);
});

test("the suite's YAML editor saved with YAML that doesn't parse: what was typed isn't lost, the problem is said, and fixed it's the suite again", async ({ app: { page } }) => {
  await openTest(page);
  await page.click("#testYamlEdit");
  const editor = page.locator("#editorText");
  await expect(editor).toBeVisible();
  const good = await editor.inputValue();
  const broken = good.replace("tests:\n", "tests: [\n");
  await editor.fill(broken);
  await page.click("#editorSave");
  await expect(page.locator(".toast", { hasText: `${SUITE} has problems` })).toBeVisible();
  // Kept as typed (nothing thrown away), and the suite says what's wrong
  expect(await fileText(page, SUITE)).toBe(broken);
  await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
  await expect(page.locator("#panel .problems")).toBeVisible();
  // Opened again, the editor has it as it was typed; fixed, the suite and its test are back
  await page.click("#suiteYamlEdit");
  await expect(page.locator("#editorText")).toHaveValue(broken);
  await page.fill("#editorText", good);
  await page.click("#editorSave");
  await expect.poll(() => fileText(page, SUITE)).toBe(good);
  await expect(page.locator("#panel .problems")).toHaveCount(0);
  await openTest(page);
  await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
});

test("Settings → Secrets and System One say plainly that the browser build keeps them unencrypted", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-secrets");
  await expect(page.locator("#settingsModal")).toContainText("In the browser build they're kept in this browser's storage, unencrypted: use the desktop app for keys that matter.");
  await page.click("#settings-tab-systemone");
  await expect(page.locator("#settingsModal")).toContainText("In the browser build its key is kept in this browser's storage, unencrypted");
});

test("a new scope's name: letters, digits, '.', '-' and '_', and not one there is: else refused, said, and nothing made", async ({ app: { page } }) => {
  await page.click("#scopeButton");
  await page.locator("#newScopeName").waitFor();
  for (const bad of ["my scope", "stage!", "-stage", ".hidden"]) {
    await page.fill("#newScopeName", bad);
    await page.click("#newScopeForm button[type=submit]");
    await expect(page.locator("#environmentsError")).toHaveText("A scope's name is letters, digits, '.', '-' and '_'.");
  }
  await expect(page.locator("#environmentsEmpty")).toBeVisible();
  await page.fill("#newScopeName", "stage-2.eu_1");
  await page.click("#newScopeForm button[type=submit]");
  await expect(page.locator("#envScope")).toHaveValue("stage-2.eu_1");
  await page.fill("#newScopeName", "stage-2.eu_1");
  await page.click("#newScopeForm button[type=submit]");
  await expect(page.locator("#environmentsError")).toHaveText('There\'s a scope "stage-2.eu_1" already.');
  expect(await page.evaluate(() => localStorage.getItem("eval.scopes"))).toBe('["stage-2.eu_1"]');
});

test("the message box: Shift+Enter adds a line, Enter sends it as typed (its lines kept)", async ({ app: { page, servers } }) => {
  await page.evaluate(async (url) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("providers", { create: true });
    const w = await (await dir.getFileHandle("plain.yml", { create: true })).createWritable();
    await w.write(`kind: http\nurl: "${url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`);
    await w.close();
  }, servers.mock.url);
  await page.click("#openFolder");
  await page.selectOption("#convProvider", "providers/plain.yml");
  await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
  await page.locator("#input").pressSequentially("first line");
  await page.locator("#input").press("Shift+Enter");
  await page.locator("#input").pressSequentially("second line");
  await expect(page.locator("#input")).toHaveValue("first line\nsecond line");
  expect(await (await fetch(`${servers.mock.url}/_log`)).json()).toEqual([]);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: first line");
  await expect(page.locator("#input")).toHaveValue("");
  expect((await (await fetch(`${servers.mock.url}/_log`)).json()).map((x) => x.body.message)).toEqual(["first line\nsecond line"]);
});

test("a suite's panel lists an old way to write a value or a secret among its problems, saying the new way", async ({ app: { page } }) => {
  await writeOpfs(page, "providers/old.yml", "kind: http\nurl: \"http://127.0.0.1:1/json\"\nheaders: { X-Key: \"${env:OLD_KEY}\" }\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n");
  await writeOpfs(page, "old.hafen.yml", "version: 1\nname: Old\nprovider: providers/old.yml\ntests:\n  - name: old hello\n    turns:\n      - user: \"hi {{scope.who}}\"\n        expect: [ { contains: hi } ]\n");
  await page.click("#openFolder");
  await page.locator('#suiteList .list-row[data-file="old.hafen.yml"] .list-open').first().click();
  const problems = page.locator("#panel .problems");
  await expect(problems).toContainText("{{scope.who}} is the old way: write {{env.who}} (a value of the environment) or {{secret.who}} (a secret)");
  await expect(problems).toContainText("providers/old.yml:3: ${env:OLD_KEY} is the old way to write a secret: write {{secret.OLD_KEY}}");
  // (its row says it has problems before it's run)
  await expect(page.locator('#suiteList .list-row[data-file="old.hafen.yml"] .list-size')).toContainText(/problem/);
});

test("Getting started's command line: the scope's Export .env, given to hafen with --env, runs the same files; without it, exit 2 and the line that says why", async ({ app: { page, servers } }) => {
  const files = {
    "providers/gs.yml": "kind: http\nurl: \"{{env.base_url}}/json\"\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n",
    "gs.hafen.yml": "version: 1\nname: smoke\nprovider: providers/gs.yml\ntests:\n  - name: refund\n    turns:\n      - user: I want a refund for order 4417\n        expect: [ { type: status, equals: 200 } ]\n      - user: It arrived broken\n        expect: [ { contains: refund } ]\n",
  };
  for (const [path, text] of Object.entries(files)) await writeOpfs(page, path, text);
  await page.click("#openFolder");
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
