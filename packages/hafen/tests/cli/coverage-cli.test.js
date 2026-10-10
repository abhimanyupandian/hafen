// Coverage of docs/cli.md and docs/ci.md that the other CLI tests don't reach, end to end from the
// command line against the mock endpoint: the folders a search leaves out (.git, release), --test given
// more than once, compare's cost threshold, the output's "…N more (see the report)" and its fixtures'
// count, --redact phone and card, a provider's afterAll fixture still sent after a beforeAll that
// failed (exit 2) and after a run that was cancelled (exit 3), what a pack can do (info with hashes,
// report and compare, --version; not pack), and an install without rolldown (--omit=optional): run,
// validate, report and compare work, and pack says what to install (exit 2). Each test has a folder of
// its own.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(PACKAGE, "cli/hafen.js");
let mock;
const dirs = [];

const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;
const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Cover
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

async function project(files, { withJson = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hafen-coverage-"));
  dirs.push(dir);
  const all = { ...(withJson ? { "providers/json.yml": JSON_PROVIDER } : {}), ...files };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}

// A node process: the command line (or a pack, or another copy of hafen) in `dir`
function node(dir, args, { env = {}, signalAfterMs, clean = false } = {}) {
  return new Promise((resolve) => {
    const base = clean ? { PATH: process.env.PATH } : process.env;
    const child = spawn(process.execPath, args, { cwd: dir, env: { ...base, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const cli = (dir, args, opts) => node(dir, [CLI, ...args], opts);
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;
const readJSON = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));

before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("choosing what runs", () => {
  it("a folder search leaves out .git and release too (as node_modules, .hafen and dist)", async () => {
    const one = suite("  - name: one\n    turns: [ { user: hi, expect: [ { contains: \"You said\" } ] } ]\n");
    const dir = await project({
      "a.hafen.yml": one.replace("name: Cover", "name: A"),
      ".git/x.hafen.yml": one.replace("name: Cover", "name: GIT"),
      "release/y.hafen.yml": one.replace("name: Cover", "name: RELEASE"),
      "sub/release-notes.hafen.yml": one.replace("name: Cover", "name: NOTES").replace("providers/json.yml", "../providers/json.yml"),
    });
    const r = await cli(dir, ["run", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual((await readJSON(dir, "out/run.json")).suites.map((s) => s.file), ["a.hafen.yml", "sub/release-notes.hafen.yml"]);
  });

  it("--test given more than once: tests whose name contains any of them", async () => {
    const dir = await project({ "s.hafen.yml": suite(["alpha", "beta", "gamma"].map((n) => `  - name: ${n}\n    turns: [ { user: ${n} } ]\n`).join("")) });
    const r = await cli(dir, ["run", "--test", "alp", "--test", "GAMMA", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual(mock.log.map((x) => x.body.message), ["alpha", "gamma"]);
    assert.deepEqual((await readJSON(dir, "out/run.json")).tests.map((t) => [t.name, t.status]), [["alpha", "passed"], ["gamma", "passed"]]);
  });
});

describe("compare and --fail-on", () => {
  it("cost=<percent>: a run whose cost rose by more is a regression (exit 1); within it, not; the thresholds combine", async () => {
    const dir = await project({ "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n") });
    assert.equal((await cli(dir, ["run", "--report", "run:base.json"])).code, 0);
    const base = await readJSON(dir, "base.json");
    const withCost = (factor) => ({ ...base, summary: { ...base.summary, cost: base.summary.cost * factor } });
    await writeFile(join(dir, "dearer.json"), JSON.stringify(withCost(1.5)));
    await writeFile(join(dir, "about.json"), JSON.stringify(withCost(1.05)));
    const dearer = await cli(dir, ["compare", "dearer.json", "--baseline", "base.json", "--fail-on", "cost=10"]);
    assert.equal(dearer.code, 1, said(dearer));
    assert.match(dearer.stdout, /^## Hafen · regressed$/m);
    assert.match(dearer.stdout, /\*\*Regressed:\*\* cost rose 50% \(limit 10%\)/);
    const about = await cli(dir, ["compare", "about.json", "--baseline", "base.json", "--fail-on", "cost=10"]);
    assert.equal(about.code, 0, said(about));
    // Only the thresholds given are looked at: without cost=, a dearer run passes
    assert.equal((await cli(dir, ["compare", "dearer.json", "--baseline", "base.json", "--fail-on", "pass_rate=5,p95=20"])).code, 0);
    assert.equal((await cli(dir, ["compare", "dearer.json", "--baseline", "base.json", "--fail-on", "pass_rate=5,cost=60"])).code, 0);
  });
});

describe("the output", () => {
  it("a test's line says up to three things that went wrong, then …N more (see the report)", async () => {
    const dir = await project({
      "data/rows.csv": `q\n${[1, 2, 3, 4, 5].map((n) => `row ${n}`).join("\n")}\n`,
      "s.hafen.yml": suite("  - name: rows\n    data: data/rows.csv\n    turns: [ { user: \"{{row.q}}\", expect: [ { contains: nowhere } ] } ]\n"),
    });
    const r = await cli(dir, ["run"]);
    assert.equal(r.code, 1, said(r));
    const lines = r.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("✗ Cover › rows"));
    assert.match(lines[at], /0\/5 rows {3}0\/5 checks/);
    // (each row named by its first column: q)
    assert.deepEqual(lines.slice(at + 1, at + 5).map((l) => l.trim().replace(/(nowhere): .*/, "$1")), ["row 1: row 1 · turn 1 · contains nowhere", "row 2: row 2 · turn 1 · contains nowhere", "row 3: row 3 · turn 1 · contains nowhere", "…2 more (see the report)"]);
  });

  it("a fixture that failed gets a line of its own (without --verbose), and the summary counts the fixtures that ran", async () => {
    const dir = await project({
      "plugins/warm.js": 'export default { kind: "fixture", name: "warm", version: "1.0.0", hosts: [], provides: [], async run() {} };\n',
      "plugins/logout.js": 'export default { kind: "fixture", name: "logout", version: "1.0.0", hosts: [], provides: [], async run() { throw new Error("no session to end"); } };\n',
      "providers/p.yml": JSON_PROVIDER.replace("kind: http\n", "kind: http\nfixtures: { beforeAll: [warm], afterAll: [logout] }\n"),
      "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n", "provider: providers/p.yml"),
    });
    const r = await cli(dir, ["run", "--report", "md:out/s.md", "--report", "junit:out/j.xml"]);
    assert.equal(r.code, 0, `an afterAll that fails changes no result\n${said(r)}`);
    assert.match(r.stdout, /^ {2}⚙ fixture logout · afterAll · providers\/p\.yml {2}failed: no session to end$/m);
    assert.doesNotMatch(r.stdout, /⚙ fixture warm/, "one that went well: only with --verbose");
    assert.match(r.stdout, / · 2 fixtures \(1 failed\) · /);
    assert.match(await readFile(join(dir, "out/s.md"), "utf8"), /\| ✗ \| logout \| afterAll \| providers\/p\.yml \|/);
    assert.match(await readFile(join(dir, "out/j.xml"), "utf8"), /<system-err>fixture logout \(afterAll\) · providers\/p\.yml · failed: no session to end/);
  });
});

describe("--redact", () => {
  it("phone and card: a number in a reply is hidden in the output, the run file and every report", async () => {
    const dir = await project({ "s.hafen.yml": suite('  - name: a\n    turns: [ { user: "call +44 20 7946 0958 or pay with 4242 4242 4242 4242", expect: [ { contains: nothing-like-this } ] } ]\n') });
    const reports = ["run:out/run.json", "junit:out/j.xml", "md:out/s.md", "json:out/s.json"].flatMap((x) => ["--report", x]);
    const r = await cli(dir, ["run", "--redact", "phone,card", "--verbose", ...reports]);
    assert.equal(r.code, 1, said(r));
    assert.equal(mock.log[0].body.message, "call +44 20 7946 0958 or pay with 4242 4242 4242 4242", "sent as written");
    for (const [where, text] of [["the output", r.all], ...await Promise.all(["run.json", "j.xml", "s.md", "s.json"].map(async (f) => [f, await readFile(join(dir, "out", f), "utf8")]))]) {
      assert.ok(!text.includes("7946 0958") && !text.includes("4242 4242"), `in ${where}`);
    }
    assert.match((await readJSON(dir, "out/run.json")).turns[0].reply, /You said: call \[phone\] or pay with \[card\]/);
  });
});

describe("a provider's afterAll fixture (a logout) is sent however the run ends", () => {
  const fixture = (name, { provides = [], fail = false } = {}) => `export default {
  kind: "fixture", name: "${name}", version: "1.0.0", hosts: ["127.0.0.1"], provides: ${JSON.stringify(provides)},
  async run({ phase, settings, transport, signal }) {
    await transport.fetch({ url: settings.log_url, method: "POST", body: { message: "${name} " + phase }, signal });
    if (${fail}) throw new Error("${name} broke");
    return { ${provides.map((p) => `${p}: "v-${name}-1234"`).join(", ")} };
  },
};
`;
  const files = (login = {}) => ({
    "plugins/login.js": fixture("login", { provides: ["TOKEN"], ...login }),
    "plugins/logout.js": fixture("logout"),
    "providers/p.yml": `kind: http
fixtures: { beforeAll: [login], afterAll: [logout] }
url: "{{base_url}}/slow?ms=300"
log_url: "{{base_url}}/fixture-log"
headers: { x-token: "{{secret.TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
    "s.hafen.yml": suite("  - name: slow\n    repeat: 20\n    turns: [ { user: chat } ]\n", "provider: providers/p.yml"),
  });
  const fixtureLog = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body.message);

  it("a beforeAll that failed: exit 2, no chat sent, and the logout sent all the same", async () => {
    const dir = await project(files({ fail: true }));
    const r = await cli(dir, ["run", "--report", "junit:out/j.xml"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.all, /the fixture "login" \(beforeAll\) failed: login broke/);
    assert.deepEqual(fixtureLog(), ["login beforeAll", "logout afterAll"]);
    assert.equal(mock.log.filter((x) => x.path === "/slow").length, 0);
  });

  it("a run cancelled part way (SIGTERM): exit 3, and the logout sent before it exits", async () => {
    const dir = await project(files());
    const r = await cli(dir, ["run", "--report", "run:out/run.json"], { signalAfterMs: 1500 });
    assert.equal(r.code, 3, said(r));
    assert.deepEqual(fixtureLog(), ["login beforeAll", "logout afterAll"]);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status]), [["login", "beforeAll", "ok"], ["logout", "afterAll", "ok"]]);
  });
});

describe("what a pack can do", () => {
  let dir;
  let away;
  before(async () => {
    dir = await project({
      "package.json": "{}",
      "tests/smoke.hafen.yml": `version: 1\nname: Smoke\nprovider: ../providers/env.yml\ntests:\n  - name: hello\n    turns: [ { user: hello, expect: [ { contains: hello } ] } ]\n`,
      "providers/env.yml": `kind: http\nurl: "{{env.base_url}}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply, usage: { input: $.usage.input_tokens, output: $.usage.output_tokens } }\nprice: { input: 1, output: 2 }\n`,
    }, { withJson: false });
    const packed = await cli(dir, ["pack", "tests", "-o", "out/smoke.hafen-pack.mjs"]);
    assert.equal(packed.code, 0, said(packed));
    away = await mkdtemp(join(tmpdir(), "hafen-coverage-pack-"));
    dirs.push(away);
    await cp(join(dir, "out/smoke.hafen-pack.mjs"), join(away, "smoke.hafen-pack.mjs"));
    await writeFile(join(away, "stage.env"), `base_url=${mock.url}\n`);
  });
  const pack = (args, opts) => node(away, ["smoke.hafen-pack.mjs", ...args], { clean: true, ...opts });

  it("info: what's in it, each file with its hash", async () => {
    const r = await pack(["info"]);
    assert.equal(r.code, 0, said(r));
    const text = await readFile(join(dir, "tests/smoke.hafen.yml"), "utf8");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(text).digest("hex").slice(0, 12);
    assert.match(r.stdout, new RegExp(`suites \\(1\\):\\n {2}tests/smoke\\.hafen\\.yml {2}${sha}\\n`));
    assert.match(r.stdout, /providers\/env\.yml {2}[0-9a-f]{12}/);
  });

  it("--version says which hafen packed it, and when", async () => {
    const r = await pack(["--version"]);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /^\d+\.\d+\.\d+ \(pack smoke\.hafen-pack\.mjs, packed .+ with hafen \d+\.\d+\.\d+\)\n$/);
  });

  it("report and compare work on its run files, where it runs; a regression exits 1", async () => {
    assert.equal((await pack(["run", "--env", "stage.env", "--report", "run:base.json"])).code, 0);
    const report = await pack(["report", "base.json", "--report", "md:out/s.md", "--report", "junit:out/j.xml"]);
    assert.equal(report.code, 0, said(report));
    assert.match(await readFile(join(away, "out/s.md"), "utf8"), /## Hafen · passed/);
    assert.match(await readFile(join(away, "out/j.xml"), "utf8"), /<testsuite name="Smoke" file="tests\/smoke\.hafen\.yml" tests="1" failures="0"/);
    assert.equal((await pack(["compare", "base.json", "--baseline", "base.json"])).code, 0);
    const base = JSON.parse(await readFile(join(away, "base.json"), "utf8"));
    await writeFile(join(away, "worse.json"), JSON.stringify({ ...base, summary: { ...base.summary, cost: base.summary.cost * 3 } }));
    const worse = await pack(["compare", "worse.json", "--baseline", "base.json", "--fail-on", "cost=10"]);
    assert.equal(worse.code, 1, said(worse));
    assert.match(worse.stdout, /## Hafen · regressed/);
  });

  it("a pack can't pack: that needs hafen itself (exit 2, said in a line)", async () => {
    const r = await pack(["pack", "tests", "-o", "again.mjs"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.all, /^a pack runs its suites \(run, validate, report, compare, info\): pack needs hafen itself\n$/);
    assert.ok(!(await readdir(away)).includes("again.mjs"));
  });
});

describe("hafen installed without rolldown (npm install hafen --omit=optional)", () => {
  // The package as installed: engine/, cli/ and package.json, beside a node_modules with its
  // dependencies (ajv, json-p3, yaml and theirs) and no rolldown
  let bin;
  let dir;
  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "hafen-omit-optional-"));
    dirs.push(root);
    for (const part of ["engine", "cli", "package.json"]) await cp(join(PACKAGE, part), join(root, "node_modules/hafen", part), { recursive: true });
    const installed = join(PACKAGE, "../../node_modules");
    for (const name of await readdir(installed)) {
      if (/rolldown|^hafen$|^\.bin$/.test(name)) continue;
      await symlink(join(installed, name), join(root, "node_modules", name));
    }
    bin = join(root, "node_modules/hafen/cli/hafen.js");
    dir = join(root, "project");
    await mkdir(join(dir, "providers"), { recursive: true });
    await writeFile(join(dir, "providers/json.yml"), JSON_PROVIDER);
    await writeFile(join(dir, "s.hafen.yml"), suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n").replaceAll("MOCK_URL", mock.url));
  });

  it("run, validate, report and compare work", async () => {
    const run = await node(dir, [bin, "run", "--report", "run:base.json"]);
    assert.equal(run.code, 0, said(run));
    assert.match(run.stdout, /✓ Cover › a/);
    assert.equal((await node(dir, [bin, "validate"])).code, 0);
    const report = await node(dir, [bin, "report", "base.json"]);
    assert.equal(report.code, 0, said(report));
    assert.match(report.stdout, /## Hafen · passed/);
    assert.equal((await node(dir, [bin, "compare", "base.json", "--baseline", "base.json"])).code, 0);
  });

  it("pack says rolldown is needed and how to install it (exit 2), and writes nothing", async () => {
    const r = await node(dir, [bin, "pack", ".", "-o", "out/x.mjs"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /hafen pack bundles with rolldown, an optional dependency of hafen that isn't installed: npm install rolldown \(or install hafen without --omit=optional\)/);
    assert.ok(!(await readdir(dir)).includes("out"));
  });
});
