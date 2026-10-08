// docs/getting-started.md, step by step, as a new user does it in the app: a first start (nothing in
// the app, nothing to open), a provider for the mock, a conversation, saved as a test in a new suite,
// run, checks added (a value clicked in the response, and a Text card), run again, the address then
// kept in a scope; then exported to a folder, which the command line validates and runs as it is. When
// the app and the guide part, this fails: change both.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { expect, fileText, openYaml, pickFolder, storedFiles, test } from "./fixtures.js";

const CLI = fileURLToPath(new URL("../../packages/hafen/cli/hafen.js", import.meta.url));

// A first start: the app's workspace empty
test.use({ workspace: {} });

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("getting started: a provider, a conversation, saved as a test, run, checks added, run again, exported and run from the command line", async ({ app: { page, servers } }) => {
  // A first start: no suites, the first steps offered, nothing to open
  await expect(page.locator("#suiteList .list-row")).toHaveCount(0);
  await expect(page.locator("#threadEmpty")).toContainText("Add a provider");
  await expect(page.locator("body")).not.toContainText(/open a folder/i);

  // Add a provider: Add a provider (Settings → Providers → new provider), HTTP endpoint · one JSON
  // reply, named mock
  await page.click("#threadAddProvider");
  await page.selectOption("#newProviderKind", { label: "HTTP endpoint · one JSON reply" });
  await page.fill("#newProviderName", "mock");
  await page.click("#newProviderCreate");
  // … its YAML (its section opened) replaced with the guide's (the mock's address is this test's)
  await openYaml(page);
  await page.fill("#providerYaml", `# providers/mock.yml
kind: http
url: ${servers.mock.url}/json
body: { message: "{{user}}", session_id: "{{session}}" }
history: session              # the endpoint keeps the conversation
session:
  extract: $.session_id       # read the session from each reply, send it back next turn
response:
  text: $.data.reply          # where the reply text is
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
`);
  await page.locator("#providerYaml").blur();
  await expect.poll(async () => parse(await fileText(page, "providers/mock.yml")).session?.extract).toBe("$.session_id");
  // Try it: Settings closes, the message box is ready
  await page.click("#providerTry");
  await expect(page.locator("#settingsModal")).toHaveCount(0);

  // Explore
  await page.fill("#input", "I want a refund for order 4417");
  await page.press("#input", "Enter");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("Could you tell me why you want a refund for order 4417?");
  await page.fill("#input", "It arrived broken");
  await page.press("#input", "Enter");
  await expect(page.locator("#turn-1-reply .msg-body")).toHaveText("You said: It arrived broken");
  // A reply clicked: the request that was sent, and the response as a JSON tree; the timeline's steps
  await page.locator("#turn-0-reply .msg-body").click();
  await expect(page.locator("#turnResponse .json-value").filter({ hasText: /^4417$/ })).toBeVisible();
  await expect(page.locator(".timeline-bar").first()).toBeVisible();

  // Save it as a test: a new suite named smoke, the test named refund
  await expect(page.locator("#saveSuite option").first()).toHaveText("New suite (tests.hafen.yml)");
  await page.fill("#saveSuiteName", "smoke");
  await expect(page.locator("#saveSuite option").first()).toHaveText("New suite (smoke.hafen.yml)");
  await page.fill("#saveName", "refund");
  await page.click("#saveTest");
  const suite = async () => parse(await fileText(page, "smoke.hafen.yml"));
  await expect.poll(async () => (await suite()).tests?.[0]?.name).toBe("refund");
  const saved = await suite();
  expect(saved.provider).toBe("providers/mock.yml");
  expect(saved.tests[0].turns.map((t) => t.user)).toEqual(["I want a refund for order 4417", "It arrived broken"]);
  // (each turn starts with a status check)
  expect(saved.tests[0].turns.map((t) => t.expect)).toEqual([[{ type: "status", equals: 200 }], [{ type: "status", equals: 200 }]]);
  await expect(page.locator("#evalTitle")).toHaveText("refund");

  // Run it: ▷ on the test; both turns pass
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText("passed 1/1");

  // Add checks: turn 1's response, the value 4417 clicked, equals kept, Add check
  await page.locator("#turn-0-reply .msg-body").click();
  await page.locator("#turnResponse .json-value").filter({ hasText: /^4417$/ }).click();
  await page.click("#pathAdd");
  await expect.poll(async () => (await suite()).tests[0].turns[0].expect).toEqual([{ type: "status", equals: 200 }, { path: "$.data.order.id", equals: 4417 }]);
  // (only the check's lines are new: the rest of the file is as it was)
  const text = await fileText(page, "smoke.hafen.yml");
  expect(text).toContain("          - path: $.data.order.id\n            equals: 4417\n");
  // Checks in the sidebar: turn 2 selected, the Text card adds `contains: text`, changed to refund
  await page.locator("#turn-1-reply .msg-body").click();
  await page.click("#checksToggle");
  await page.click("#palette-text");
  await expect.poll(async () => (await suite()).tests[0].turns[1].expect.at(-1)).toEqual({ contains: "text" });
  await page.fill("#checkYaml", "contains: refund");
  await page.locator("#checkYaml").blur();
  await expect.poll(async () => (await suite()).tests[0].turns[1].expect.at(-1)).toEqual({ contains: "refund" });

  // Run it again: turn 2's contains refund fails (the mock's second reply doesn't say it)
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator("#turn-1 .turn-summary")).toHaveAttribute("data-status", "failed");
  await expect(page.locator(`#suiteList .list-row[data-file="smoke.hafen.yml"]`)).toContainText("failed");
  // Its badge, clicked: why
  await page.locator("#turn-1-reply .badge", { hasText: "contains refund" }).click();
  await expect(page.locator("#panel")).toContainText("didn't find refund");

  // Keep the address in a scope: the scope button (no scope) → Environments (Globals, then Scopes),
  // local, its base_url, chosen; the provider's url from it; ▷ runs as before
  await expect(page.locator("#scopeButton")).toHaveAttribute("aria-label", "No scope chosen: choose one");
  await page.click("#scopeButton");
  await expect(page.locator("#settingsContent .scope-list-head .label")).toHaveText(["Globals", "Scopes"]);
  await page.fill("#newScopeName", "local");
  await page.click("#newScopeForm button[type=submit]");
  await expect(page.locator("#envScope-local")).toHaveClass(/active/);
  await page.fill("#envVarName", "base_url");
  await page.fill("#envVarValue", servers.mock.url);
  await page.press("#envVarValue", "Enter");
  await page.click("#envChoose");
  await expect(page.locator("#envChosen")).toBeVisible();
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-open");
  // (its YAML's section open still: remembered)
  await expect(page.locator("#providerYaml")).toBeVisible();
  await expect(page.locator("#providerYaml")).toHaveValue(/url: /);
  const yaml = await page.locator("#providerYaml").inputValue();
  await page.fill("#providerYaml", yaml.replace(`url: ${servers.mock.url}/json`, 'url: "{{env.base_url}}/json"'));
  await page.locator("#providerYaml").blur();
  await expect.poll(async () => parse(await fileText(page, "providers/mock.yml")).url).toBe("{{env.base_url}}/json");
  await page.click("#settingsClose");
  await expect(page.locator("#scopeButton .scope-name")).toHaveText("local");
  await fetch(`${servers.mock.url}/_log`, { method: "DELETE" });
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  expect((await (await fetch(`${servers.mock.url}/_log`)).json()).map((r) => r.path)).toEqual(["/json", "/json"]);

  // Export it: the suite's panel → Export…, local.env written beside it, a folder picked (here one of
  // the browser's own, read back onto the disk as the folder picked would be)
  await pickFolder(page, "my-tests");
  await page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"] .list-open').click();
  await page.click("#suiteExport");
  await expect(page.locator("#exportFiles")).toHaveText("providers/mock.yml\nsmoke.hafen.yml");
  await expect(page.locator("#exportEnv")).toBeChecked();
  await page.click("#exportGo");
  await expect(page.locator("#exportDialog")).toHaveCount(0);
  const exported = await storedFiles(page, "my-tests");
  expect(Object.keys(exported).sort()).toEqual(["local.env", "providers/mock.yml", "smoke.hafen.yml"]);
  expect(exported["smoke.hafen.yml"]).toBe(await fileText(page, "smoke.hafen.yml"));
  const dir = await mkdtemp(join(tmpdir(), "hafen-guide-"));
  try {
    for (const [path, text] of Object.entries(exported)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    // The command line: validate sends nothing; run exits 1 (a check fails); without --env, 2, saying why
    // (in a process of its own, while this one's mock answers it)
    const cli = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (status) => resolve({ status, out }));
    });
    const valid = await cli(["validate", dir, "--env", join(dir, "local.env")]);
    expect(valid.status, valid.out).toBe(0);
    const run = await cli(["run", dir, "--env", join(dir, "local.env")]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("refund");
    const bare = await cli(["run", dir]);
    expect(bare.status).toBe(2);
    expect(bare.out).toContain("{{env.base_url}} isn't set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
