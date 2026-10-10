// The command line itself: --help, --version and the suites it finds; each command's exit codes, on one
// folder's suites; its number options and the paths it's given; a folder the app exported, run from
// anywhere; and serve, which is the app's now. Against the mock endpoint.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startMock } from "../helpers.js";
import { CLI, JSON_PROVIDER as PROVIDER, NO_SIGNALS, cli, dirs, mock, project, readJSON, said, suite, useMock } from "./helpers.js";

useMock();

describe("the command itself", () => {
  it("--help and --version exit 0; an unknown command or option exits 2", async () => {
    const dir = await project({});
    const help = await cli(dir, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /hafen run \[paths…\]/);
    assert.match(help.stdout, /Exit codes: 0 passed · 1 failed · 2 setup error · 3 stopped early/);
    const version = await cli(dir, ["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
    const unknown = await cli(dir, ["frobnicate"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command "frobnicate"/);
    const badOption = await cli(dir, ["run", "--frobnicate"]);
    assert.equal(badOption.code, 2, said(badOption));
    assert.match(badOption.stderr, /frobnicate/);
    assert.doesNotMatch(badOption.stderr, /at .*\.js:\d+/, "a plain message, not a stack trace");
  });

  it("with no paths, runs every suite under the current folder (not node_modules, .hafen or dist), in name order", async () => {
    const one = suite(`  - name: one
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`);
    const dir = await project({
      "b.hafen.yml": one.replace("name: Flows", "name: B"),
      "nested/a.hafen.yaml": one.replace("name: Flows", "name: A").replaceAll("providers/json.yml", "../providers/json.yml"),
      "node_modules/x/c.hafen.yml": one.replace("name: Flows", "name: C"),
      ".hafen/d.hafen.yml": one.replace("name: Flows", "name: D"),
      "dist/e.hafen.yml": one.replace("name: Flows", "name: E"),
      "f.hafen.json": JSON.stringify({ version: 1, name: "F", provider: "providers/json.yml", environments: { local: { base_url: mock.url } }, tests: [{ name: "one", turns: [{ user: "hi", expect: [{ contains: "You said" }] }] }] }),
    });
    const r = await cli(dir, ["run", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.suites.map((s) => s.file ?? s), ["b.hafen.yml", "f.hafen.json", "nested/a.hafen.yaml"]);
    assert.match(r.stdout, /3 suites · 3 tests · 0 failed/);
  });

  it("a path that doesn't exist, or a folder with no suites, exits 2 and sends nothing", async () => {
    const dir = await project({ "notes.txt": "nothing here" });
    const missing = await cli(dir, ["run", "nope.hafen.yml"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /nope\.hafen\.yml doesn't exist/);
    const none = await cli(dir, ["run", "."]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no suites found/);
    const validate = await cli(dir, ["validate"]);
    assert.equal(validate.code, 2);
    assert.equal(mock.log.length, 0);
  });
});

// (one folder for these, made once: suites that pass, fail, are broken and are slow; a mock of its own)
describe("exit codes, validate, reports, compare and cancelling", () => {
  let mock;
  let dir;

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

    it("exits 3 when cancelled, writing what ran", { skip: NO_SIGNALS }, async () => {
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
});

describe("the command line's numbers and paths", () => {
  let mock;
  let dir;

  function cli(args, cwd) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  before(async () => {
    mock = await startMock({ chunkMs: 1 });
    dir = await mkdtemp(join(tmpdir(), "hafen-cli-opts-"));
    await mkdir(join(dir, "proj", "providers"), { recursive: true });
    await mkdir(join(dir, "proj", "suites"), { recursive: true });
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await writeFile(join(dir, "proj", "providers", "json.yml"), `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse:\n  text: $.data.reply\n  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }\nprice: { input: 100000, output: 100000 }\n`);
    await writeFile(join(dir, "proj", "suites", "a.hafen.yml"), `version: 1\nprovider: ../providers/json.yml\ntests:\n${[1, 2, 3, 4, 5].map((i) => `  - name: t${i}\n    turns:\n      - user: hi ${i}\n`).join("")}`);
    await writeFile(join(dir, "elsewhere", "secret.txt"), "SECRET");
  });
  after(async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("number options", () => {
    for (const [option, value] of [["--max-cost", "$1"], ["--timeout", "5s"], ["--timeout", "0"], ["--repeat", "x"], ["--repeat", "1.5"]]) {
      it(`${option} ${value}: exit 2, saying what it takes`, async () => {
        const r = await cli(["run", option, value, "--report", "json:/dev/null"], join(dir, "proj"));
        assert.equal(r.code, 2, r.stdout + r.stderr);
        assert.match(r.stderr, new RegExp(`${option} takes`));
        assert.equal(mock.log.length, 0);
      });
    }

    it("--max-cost 1 stops the run at $1 (exit 3)", async () => {
      const r = await cli(["run", "--max-cost", "1", "--report", "json:/dev/null"], join(dir, "proj"));
      assert.equal(r.code, 3, r.stdout + r.stderr);
    });
  });

  describe("paths outside the current folder", () => {
    it("a folder named there is searched for suites, and they run, reaching their project's providers", async () => {
      // (its project: the nearest folder above it with a package.json or a .git)
      await writeFile(join(dir, "proj", "package.json"), "{}");
      const r = await cli(["run", join(dir, "proj", "suites"), "--report", "json:/dev/null"], join(dir, "elsewhere"));
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /5 tests/);
      await rm(join(dir, "proj", "package.json"));
      // With no project to it, only the folder named is read: its suites' ../providers aren't
      const bare = await cli(["validate", join(dir, "proj", "suites")], join(dir, "elsewhere"));
      assert.equal(bare.code, 2);
      assert.match(bare.stdout + bare.stderr, /isn't in the opened folder/);
    });

    it("a suite can't read a file outside the current folder and the ones named", async () => {
      await writeFile(join(dir, "proj", "suites", "b.hafen.yml"), `version: 1\nprovider: ../providers/json.yml\ntests:\n  - name: t\n    data: ${join(dir, "elsewhere", "secret.txt")}\n    turns: [ { user: "{{row}}" } ]\n`);
      const r = await cli(["validate", join(dir, "proj", "suites", "b.hafen.yml")], join(dir, "proj"));
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /isn't in the opened folder/);
      await rm(join(dir, "proj", "suites", "b.hafen.yml"));
    });
  });
});

describe("an exported folder", () => {
  const cli = (cwd, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    let all = "";
    child.stdout.on("data", (d) => { all += d; });
    child.stderr.on("data", (d) => { all += d; });
    child.on("close", (code) => resolve({ code, all }));
  });

  // A provider plugin that answers by itself (no network), and a check plugin, each used by name; the
  // provider's helper imported beside it
  const FILES = {
    "echo.hafen.yml": "version: 1\nname: Echo\nprovider: providers/echo.yml\ntests:\n  - name: echoes\n    turns:\n      - user: hello\n        expect: [ { contains: \"echo: hello\" }, { type: polite, word: echo } ]\n",
    "providers/echo.yml": "kind: plugin:echo\n",
    "plugins/echo.js": 'import { prefix } from "./lib/prefix.js";\nexport default { kind: "provider", name: "echo", version: "1.0.0", hosts: [], async *send({ message }) { yield { type: "text", text: `${prefix}${message}` }; yield { type: "done" }; } };\n',
    "plugins/lib/prefix.js": 'export const prefix = "echo: ";\n',
    "plugins/polite.js": 'export default { kind: "check", name: "polite", version: "1.0.0", async check({ value, params }) { return { status: String(value).includes(params.word) ? "pass" : "fail", reason: "" }; } };\n',
  };

  it("runs from another folder: its plugins are found in its plugins/, by the folder or a suite in it", async () => {
    const exported = await mkdtemp(join(tmpdir(), "hafen-exported-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hafen-elsewhere-"));
    dirs.push(exported, elsewhere);
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(exported, path)), { recursive: true });
      await writeFile(join(exported, path), text);
    }
    const byFolder = await cli(elsewhere, ["run", exported, "--report", `run:${join(elsewhere, "run.json")}`]);
    assert.equal(byFolder.code, 0, byFolder.all);
    assert.match(byFolder.all, /echoes/);
    const byFile = await cli(elsewhere, ["run", join(exported, "echo.hafen.yml")]);
    assert.equal(byFile.code, 0, byFile.all);
    const checked = await cli(elsewhere, ["validate", exported]);
    assert.equal(checked.code, 0, checked.all);
    // (from inside it, as before)
    const inside = await cli(exported, ["run", "."]);
    assert.equal(inside.code, 0, inside.all);
  });

  it("packs with the JSON Schemas its checks name, as with its other files (what Export writes, pack takes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hafen-schemas-"));
    const away = await mkdtemp(join(tmpdir(), "hafen-away-"));
    dirs.push(dir, away);
    const files = {
      "said.hafen.yml": "version: 1\nprovider: plugin:jsonish\ntests:\n  - name: said\n    turns:\n      - user: hello\n        expect: [ { type: json, schema: schemas/said.json } ]\n",
      "plugins/jsonish.js": 'export default { kind: "provider", name: "jsonish", version: "1.0.0", hosts: [], async *send({ message }) { yield { type: "text", text: JSON.stringify({ said: message }) }; yield { type: "done" }; } };\n',
      "schemas/said.json": '{ "type": "object", "required": ["said"] }\n',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    const packed = await cli(dir, ["pack", ".", "-o", join(away, "said.hafen-pack.mjs")]);
    assert.equal(packed.code, 0, packed.all);
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["said.hafen-pack.mjs", "run", "--report", "md:-"], { cwd: away, env: { ...process.env, NO_COLOR: "1" } });
      let all = "";
      child.stdout.on("data", (d) => { all += d; });
      child.stderr.on("data", (d) => { all += d; });
      child.on("close", (code) => resolve({ code, all }));
    });
    assert.equal(run.code, 0, run.all);
  });
});

describe("serve", () => {
  // The relay that serves the browser build is the app's (npm run serve in Hafen's repository): hafen
  // says so, in a line, whatever options it's given
  it("hafen serve: a setup error that says where it is now (exit 2)", async () => {
    const dir = await project({});
    for (const args of [["serve"], ["serve", "--port", "8790", "--allow-endpoint", `${mock.url}/json`]]) {
      const r = await cli(dir, args);
      assert.equal(r.code, 2, said(r));
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, "hafen serve is the Hafen app's now: in Hafen's repository, npm run serve -- --allow-endpoint <url> serves the browser build and its relay\n");
    }
  });
});
