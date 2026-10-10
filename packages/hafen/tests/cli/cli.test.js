// The command-line runner (contracts/cli.md): exit codes, validate, reports, compare, cancelling. (The
// relay, `hafen serve` before, serves the app's build: it's the app's, in tests/app/relay.test.js.)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
let dir;

const PROVIDER = `kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;
const suite = (expect, extra = "") => `version: 1
name: CLI
provider: providers/p.yml
${extra}
tests:
  - name: refund
    turns:
      - user: a refund for 4417
        expect:
${expect.map((e) => `          - ${e}`).join("\n")}
`;

function cli(args, { env = {}, cwd = dir, signalAfterMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  mock = await startMock({ chunkMs: 1 });
  dir = await mkdtemp(join(tmpdir(), "hafen-cli-"));
  await mkdir(join(dir, "providers"));
  await writeFile(join(dir, "providers/p.yml"), PROVIDER);
  await writeFile(join(dir, "pass.hafen.yml"), suite(["{ type: status, equals: 200 }", '{ path: $.data.order.id, equals: 4417 }']));
  await writeFile(join(dir, "fail.hafen.yml"), suite(['{ contains: "not in the reply" }']));
  await writeFile(join(dir, "broken.hafen.yml"), "version: 1\nprovider: providers/p.yml\ntests:\n  - name: x\n    repeat: many\n    turns: [ { user: hi } ]\n");
  await writeFile(join(dir, "slow.hafen.yml"), suite(["{ type: status, equals: 200 }"], "").replace("{{base_url}}", "{{base_url}}").replace("tests:", "defaults: { repeat: 20 }\ntests:"));
});
after(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

const base = () => ["--var", `base_url=${mock.url}`];

describe("hafen run", () => {
  it("exits 0 when everything passes, and writes a run file", async () => {
    const r = await cli(["run", "pass.hafen.yml", ...base(), "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/summary.md", "--report", "json:out/summary.json"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /✓ CLI › refund/);
    const run = JSON.parse(await readFile(join(dir, "out/run.json"), "utf8"));
    assert.equal(run.kind, "hafen-run");
    assert.equal(run.verdict, "passed");
    assert.equal(run.where.app, "cli");
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testsuite name="CLI" file="pass.hafen.yml" tests="1" failures="0"/);
    assert.match(await readFile(join(dir, "out/summary.md"), "utf8"), /## Hafen · passed/);
    assert.equal(JSON.parse(await readFile(join(dir, "out/summary.json"), "utf8")).results.length, 2);
  });

  it("groups: suites and tests in different groups run at once; each test's turns, results and report stay its own", async () => {
    const many = (prefix, group) => `version: 1\nname: ${prefix.toUpperCase()}\ngroup: ${group}\nprovider: providers/p.yml\ntests:\n${[0, 1, 2, 3].map((k) => `  - name: ${prefix}${k}\n    group: ${k % 2 + 1}\n    turns:\n      - user: "${prefix}${k} one"\n        expect: [ { contains: "${prefix}${k} one" } ]\n      - user: "${prefix}${k} two"\n        expect: [ { contains: "${prefix}${k} two" } ]`).join("\n")}\n`;
    await writeFile(join(dir, "many-a.hafen.yml"), many("a", 1));
    await writeFile(join(dir, "many-b.hafen.yml"), many("b", 2));
    const r = await cli(["run", "many-a.hafen.yml", "many-b.hafen.yml", "--var", `base_url=${mock.url}/slow?ms=40&x=`, "--report", "run:out/many.json", "--report", "junit:out/many.xml"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const run = JSON.parse(await readFile(join(dir, "out/many.json"), "utf8"));
    assert.equal(run.tests.length, 8);
    assert.ok(run.tests.every((t) => t.status === "passed"));
    for (const t of run.tests) {
      const turns = t.instances[0].turns.map((g) => run.turns[g]);
      assert.deepEqual(turns.map((x) => x.user), [`${t.name} one`, `${t.name} two`], t.name);
    }
    const junit = await readFile(join(dir, "out/many.xml"), "utf8");
    assert.match(junit, /<testsuite name="A" file="many-a.hafen.yml" tests="4" failures="0"/);
    assert.match(junit, /<testsuite name="B" file="many-b.hafen.yml" tests="4" failures="0"/);
    // The suites (groups 1 and 2) ran at once; in each, its two test groups at once, a group's tests in order
    const [sa, sb] = run.spans.filter((x) => x.kind === "suite");
    assert.ok(sa.start < sb.end && sb.start < sa.end);
    const span = (name) => run.spans.find((x) => x.kind === "test" && x.name === name);
    assert.ok(span("a0").end <= span("a2").start && span("a1").end <= span("a3").start);
    assert.ok(span("a0").start < span("a1").end && span("a1").start < span("a0").end);
  });

  it("never writes a secret into a report", async () => {
    await cli(["run", "pass.hafen.yml", ...base(), "--report", "run:out/secret.json"]);
    const text = await readFile(join(dir, "out/secret.json"), "utf8");
    assert.ok(!text.includes("tok-secret-9876"));
    assert.match(text, /\[redacted\]/);
  });

  it("exits 1 when a test fails, naming the check in JUnit", async () => {
    const r = await cli(["run", "fail.hafen.yml", ...base(), "--report", "junit:out/fail.xml"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ CLI › refund/);
    assert.match(await readFile(join(dir, "out/fail.xml"), "utf8"), /<failure message="contains not in the reply: didn&apos;t find not in the reply"/);
  });

  it("exits 2 on a setup error, naming the file and line, and sends nothing", async () => {
    mock.reset();
    const r = await cli(["run", "broken.hafen.yml", ...base()]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /broken\.hafen\.yml:5:\d+ +tests\.0\.repeat: must be integer/);
    assert.equal(mock.log.length, 0);
  });

  it("exits 2 when a secret isn't set, before sending anything", async () => {
    mock.reset();
    const r = await cli(["run", "pass.hafen.yml", ...base()], { env: { MOCK_TOKEN: "" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /\{\{secret\.MOCK_TOKEN\}\} isn't set/);
  });

  it("exits 2 when a variable isn't given", async () => {
    const r = await cli(["run", "pass.hafen.yml"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\{\{base_url\}\}/);
  });

  it("exits 3 when the spending limit is reached", async () => {
    const r = await cli(["run", "slow.hafen.yml", ...base(), "--max-cost", "0.00001"]);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /stopped: the run's cost reached the limit/);
  });

  it("exits 3 when cancelled, writing what ran", async () => {
    const r = await cli(["run", "slow.hafen.yml", "--var", `base_url=${mock.url}/slow?ms=300&x=`, "--report", "run:out/cancel.json"], { signalAfterMs: 1200 });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const run = JSON.parse(await readFile(join(dir, "out/cancel.json"), "utf8"));
    assert.equal(run.status, "stopped");
  });
});

describe("hafen validate", () => {
  it("passes good files and fails broken ones, sending nothing", async () => {
    mock.reset();
    const ok = await cli(["validate", "pass.hafen.yml", "--var", "base_url=http://x"]);
    assert.equal(ok.code, 0, ok.stderr);
    const noVar = await cli(["validate", "pass.hafen.yml"]);
    assert.equal(noVar.code, 2);
    assert.match(noVar.stderr, /\{\{base_url\}\}/);
    const bad = await cli(["validate", "."]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /broken\.hafen\.yml:5/);
    assert.equal(mock.log.length, 0);
  });
  it("--env-check finds unset secrets", async () => {
    const r = await cli(["validate", "pass.hafen.yml", "--var", "base_url=http://x", "--env-check"], { env: { MOCK_TOKEN: "" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /MOCK_TOKEN/);
  });
});

describe("hafen report and compare", () => {
  it("writes reports from a run file", async () => {
    await cli(["run", "pass.hafen.yml", ...base(), "--report", "run:out/a.json"]);
    const r = await cli(["report", "out/a.json", "--report", "junit:-"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /<testsuites name="Hafen"/);
  });
  it("compare exits 1 on a regression", async () => {
    await cli(["run", "pass.hafen.yml", ...base(), "--report", "run:out/base.json"]);
    await cli(["run", "fail.hafen.yml", ...base(), "--report", "run:out/worse.json"]);
    const r = await cli(["compare", "out/worse.json", "--baseline", "out/base.json", "--fail-on", "pass_rate=5"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /pass rate fell 100 points/);
  });
  it("run --baseline fails when slower than the threshold allows", async () => {
    await cli(["run", "pass.hafen.yml", ...base(), "--report", "run:out/fast.json"]);
    const r = await cli(["run", "pass.hafen.yml", "--var", `base_url=${mock.url}/slow?ms=250&x=`, "--baseline", "out/fast.json", "--fail-on", "p95=20"]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /regressed: p95 rose/);
  });
});
