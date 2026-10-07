// From the command line, against the mock endpoint: a test that names a provider under providers
// runs with it (and one that names nothing says so, with the one it most likely meant); a secret
// that isn't set is said where it's first used; and a run stopped by --max-cost counts the test that
// had already failed as failed, in its summary and its reports.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
const dirs = [];

// A JSON provider (one reply), its key a secret
const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

// A folder with these files (paths to text), its environment's base_url the mock's
async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), "hafen-fixes-"));
  dirs.push(dir);
  const all = { "providers/json.yml": JSON_PROVIDER, ...files };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}

function cli(dir, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const readJSON = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

// A suite: its head (provider, providers…), then its tests (YAML)
const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Flows
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

const NAMED = `provider: providers/json.yml
providers:
  toolsy:
    kind: http
    url: "{{base_url}}/json"
    headers: { x-which: toolsy }
    body: { message: "{{user}}" }
    response: { text: $.data.reply }`;

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("a test's provider by name", () => {
  it("validates and runs with the named provider; the other test with the suite's", async () => {
    const dir = await project({ "s.hafen.yml": suite(`  - name: by name
    provider: toolsy
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: the suite's
    turns: [ { user: hello, expect: [ { contains: "You said" } ] } ]
`, NAMED) });
    const checked = await cli(dir, ["validate", "--env-check"]);
    assert.equal(checked.code, 0, said(checked));
    assert.match(checked.stdout, /✓ s\.hafen\.yml/);
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual(mock.log.map((x) => [x.body.message, x.headers["x-which"] ?? null, x.headers.authorization ?? null]), [["hi", "toolsy", null], ["hello", null, "Bearer tok-secret-9876"]]);
  });

  it("a name that's nothing: exit 2, where it is, the suite's names and the one it most likely meant", async () => {
    const dir = await project({ "s.hafen.yml": suite(`  - name: a
    provider: toolsi
    turns: [ { user: hi } ]
`, NAMED) });
    const r = await cli(dir, ["validate"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /^s\.hafen\.yml:15:15 {2}tests\.0\.provider: there's no provider named "toolsi" \(under providers: toolsy\), and it isn't a preset or a file \(did you mean "toolsy"\?\)$/m);
    const run = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(run.code, 2, said(run));
    assert.equal(mock.log.length, 0);
  });
});

describe("a secret that isn't set", () => {
  it("is said at its {{secret.…}} in the provider file, by validate --env-check and by run, nothing sent", async () => {
    const dir = await project({ "s.hafen.yml": suite(`  - name: a
    turns: [ { user: hi } ]
`) });
    const checked = await cli(dir, ["validate", "--env-check"], { env: { MOCK_TOKEN: "" } });
    assert.equal(checked.code, 2, said(checked));
    assert.match(checked.stderr, /^providers\/json\.yml:3:35 {2}\{\{secret\.MOCK_TOKEN\}\} isn't set \(not in the environment: set it, or pass --secret <file>\)$/m);
    const r = await cli(dir, ["run", "s.hafen.yml"], { env: { MOCK_TOKEN: "" } });
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /^providers\/json\.yml:3:35 {2}\{\{secret\.MOCK_TOKEN\}\} isn't set \(not in the environment: set it, or pass --secret <file>\)$/m);
    assert.equal(mock.log.length, 0);
  });

  it("is said in the suite for an inline provider or a step, and at the provider's kind for a preset's own key", async () => {
    const dir = await project({ "s.hafen.yml": suite(`  - name: a
    provider: judge
    setup:
      - request: { url: "{{base_url}}/login", body: { password: "{{secret.QA_PASSWORD}}" } }
    turns: [ { user: hi } ]
`, `provider: { kind: http, url: "{{base_url}}/json", headers: { x-key: "{{secret.INLINE_KEY}}" }, body: { message: "{{user}}" } }
providers:
  judge: { kind: anthropic-messages, model: claude-x }`) });
    const r = await cli(dir, ["validate", "--env-check"]);
    assert.equal(r.code, 2, said(r));
    // (a preset's own key, written nowhere, as it would be written)
    const unset = r.stderr.split("\n").filter((l) => l.includes("isn't set"));
    assert.deepEqual(unset.slice(0, 2), [
      "s.hafen.yml:3:70  {{secret.INLINE_KEY}} isn't set (not in the environment: set it, or pass --secret <file>)",
      "s.hafen.yml:12:66  {{secret.QA_PASSWORD}} isn't set (not in the environment: set it, or pass --secret <file>)",
    ]);
    assert.match(unset[2], /^s\.hafen\.yml:5:18 {2}\{\{secret\.ANTHROPIC_API_KEY\}\} isn't set\b/);
    assert.equal(unset.length, 3);
  });
});

describe("--max-cost", () => {
  it("a test that had failed before the stop is failed: the summary, the run file and the reports say so (exit 3)", async () => {
    const dir = await project({
      "providers/pricey.yml": JSON_PROVIDER.replace("price: { input: 1, output: 2 }", "price: { input: 1000, output: 2000 }"),
      "s.hafen.yml": suite(`  - name: t1
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: t2
    turns: [ { user: hi, expect: [ { contains: "nope" } ] } ]
  - name: t3
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/pricey.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--max-cost", "0.03", "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/summary.md", "--report", "json:out/summary.json"]);
    assert.equal(r.code, 3, said(r));
    assert.match(r.stdout, /^✗ Flows › t2 {3}0\/1 {3}0\/1 checks/m);
    assert.match(r.stdout, /^1 suite · 3 tests · 1 failed · 0 unsure · 2 checks · /m);
    assert.match(r.stdout, /stopped: the run's cost reached the limit \(\$0\.03\)/);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.equal(run.verdict, "failed");
    assert.deepEqual(run.tests.map((t) => [t.name, t.status]), [["t1", "passed"], ["t2", "failed"], ["t3", "skipped"]]);
    assert.deepEqual([run.summary.tests.failed, run.summary.tests.skipped, run.summary.tests.stopped], [1, 1, 0]);
    const xml = await readFile(join(dir, "out/junit.xml"), "utf8");
    const t2 = xml.match(/<testcase [^>]*name="t2"[^>]*>[\s\S]*?<\/testcase>/)[0];
    assert.match(t2, /<failure /);
    assert.doesNotMatch(t2, /<skipped/);
    assert.match(xml, /<testsuites name="Hafen" tests="3" failures="1" errors="0" skipped="1"/);
    assert.match(await readFile(join(dir, "out/summary.md"), "utf8"), /3 tests · 1 failed ·[\s\S]*\| ✗ \| t2 \|/);
    const json = await readJSON(dir, "out/summary.json");
    assert.deepEqual([json.verdict, json.summary.tests.failed], ["failed", 1]);
  });
});
