// hafen pack: suites packed with everything they need into one file that runs anywhere with Node alone;
// what a pack can do; its secrets and environment values, never in it, their names in examples beside
// it; and hafen installed without rolldown. Against the mock endpoint.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLI, JSON_PROVIDER, cli, dirs, mock, project, readJSON, said, useMock } from "./helpers.js";

useMock();

describe("hafen pack", () => {
  // A node process running `file` (a pack) in `dir`, as cli() runs the command line
  const node = (dir, file, args, env = {}) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: dir, env: { PATH: process.env.PATH, NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr, all: stdout + stderr }));
  });
  // A project: a suite with a data file and an environment's value; its provider logs in first (a
  // fixture, its password a secret); a check plugin importing a file outside the project, a package
  // and JSON
  const files = {
    "project/package.json": "{}",
    "project/tests/refunds.hafen.yml": `version: 1
provider: ../providers/acme.yml
tests:
  - name: polite
    data: ../data/rows.csv
    turns: [ { user: "{{row.q}}", expect: [ { type: polite }, { type: status, equals: 200 } ] } ]
`,
    "project/data/rows.csv": "q\nhello there\nsay please\n",
    "project/providers/acme.yml": `kind: http
fixtures: { beforeAll: [acme-login] }
url: "{{env.base_url}}/auth/chat"
login_url: "{{env.base_url}}/auth/login"
headers: { cookie: "{{secret.ACME_COOKIE}}", x-csrf-token: "{{secret.ACME_CSRF}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
    "project/plugins/acme-login.js": `export default {
  kind: "fixture", name: "acme-login", version: "1.0.0", hosts: ["127.0.0.1"], provides: ["ACME_COOKIE", "ACME_CSRF"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status >= 400) throw new Error("login failed: " + res.status);
    const { csrf_token } = await res.json();
    return { ACME_COOKIE: [res.headers["set-cookie"]].flat().map((c) => c.split(";")[0]).join("; "), ACME_CSRF: csrf_token };
  },
};
`,
    "project/plugins/polite.js": `import { words } from "../lib/words.js";
import { lower } from "../../shared/text.js";
import { count } from "fake-counter";
import extra from "./extra.json" with { type: "json" };
export default { kind: "check", name: "polite", version: "1.0.0", async check({ value }) {
  const found = [...words, ...extra.words].filter((w) => lower(value).includes(w));
  return { status: found.length ? "pass" : "fail", reason: "found " + count(found) };
} };
`,
    "project/plugins/extra.json": `{ "words": ["said"] }`,
    "project/lib/words.js": `export const words = ["please"];\n`,
    "shared/text.js": `export const lower = (s) => String(s).toLowerCase();\n`,
    "project/node_modules/fake-counter/package.json": `{ "name": "fake-counter", "type": "module", "exports": "./index.js" }`,
    "project/node_modules/fake-counter/index.js": `export const count = (list) => list.length;\n`,
  };

  it("packs suites with everything they need into one file, which runs anywhere with Node alone: no hafen, no project, no node_modules", async () => {
    const dir = await project(files);
    const packed = await cli(join(dir, "project"), ["pack", "tests", "-o", "out/refunds.hafen-pack.mjs"]);
    assert.equal(packed.code, 0, said(packed));
    assert.match(packed.stdout, /packed refunds\.hafen-pack\.mjs \([\d.]+ (kB|MB)\)/);
    assert.match(packed.stdout, /1 suite · 1 provider · 2 plugins \(bundled with \d+ files\) · 1 data file\n/);
    assert.match(packed.stdout, /environment values it uses, from --env <file>: base_url/);
    assert.match(packed.stdout, /secrets it needs, from --secret <file> or the environment: ACME_PASSWORD/);
    const text = await readFile(join(dir, "project/out/refunds.hafen-pack.mjs"), "utf8");
    assert.ok(!text.includes(dir) && !text.includes(process.cwd()), "no path of this machine's in it");
    assert.ok(!text.includes("qa-pass-1234"), "no secret in it");

    assert.ok(!text.includes(mock.url), "no environment's value in it");

    // Somewhere else, empty: only the pack, and the environment's values given where it runs
    const away = await mkdtemp(join(tmpdir(), "hafen-pack-run-"));
    dirs.push(away);
    await writeFile(join(away, "refunds.hafen-pack.mjs"), text);
    await writeFile(join(away, "stage.env"), `base_url=${mock.url}\n`);
    const info = await node(away, "refunds.hafen-pack.mjs", ["info"]);
    assert.equal(info.code, 0, said(info));
    assert.match(info.stdout, /suites \(1\):\n {2}tests\/refunds\.hafen\.yml/);
    assert.match(info.stdout, /plugins\/acme-login\.js {2}fixture acme-login 1\.0\.0/);
    assert.match(info.stdout, /plugins\/polite\.js {2}check polite 1\.0\.0 · [3-9] files/);
    assert.match(info.stdout, /data\/rows\.csv/);
    assert.match(info.stdout, /secrets it needs, from --secret <file> or the environment: ACME_PASSWORD/);
    // Without the secret: a setup error, before anything's sent (in the scope the run will have: the
    // secrets are checked once the rest is right, its plugin's as its files')
    const missing = await node(away, "refunds.hafen-pack.mjs", ["validate", "--env", "stage.env", "--env-check"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.all, /\{\{secret\.ACME_PASSWORD\}\} isn't set/);
    // With it: the run, its reports written where it runs
    const run = await node(away, "refunds.hafen-pack.mjs", ["run", "--env", "stage.env", "--report", "run:out/run.json", "--verbose"], { ACME_PASSWORD: "qa-pass-1234" });
    assert.equal(run.code, 0, said(run));
    assert.match(run.stdout, /✓ refunds › polite {3}2\/2 rows {3}4\/4 checks/);
    assert.match(run.stdout, /⚙ fixture acme-login · beforeAll · providers\/acme\.yml {2}ok/);
    const record = await readJSON(away, "out/run.json");
    assert.equal(record.verdict, "passed");
    assert.equal(record.where.pack, "refunds.hafen-pack.mjs");
    assert.ok(!JSON.stringify(record).includes("qa-pass-1234"));
    // One suite by its path; one that isn't in it; what a pack can't do
    assert.equal((await node(away, "refunds.hafen-pack.mjs", ["run", "tests/refunds.hafen.yml", "--env", "stage.env"], { ACME_PASSWORD: "qa-pass-1234" })).code, 0);
    const nope = await node(away, "refunds.hafen-pack.mjs", ["run", "tests/other.hafen.yml"]);
    assert.equal(nope.code, 2);
    assert.match(nope.all, /tests\/other\.hafen\.yml isn't a suite in the pack \(it has tests\/refunds\.hafen\.yml\)/);
    const serve = await node(away, "refunds.hafen-pack.mjs", ["serve"]);
    assert.equal(serve.code, 2);
    assert.match(serve.all, /a pack runs its suites/);
    assert.match((await node(away, "refunds.hafen-pack.mjs", ["--help"])).stdout, /node refunds\.hafen-pack\.mjs run \[suites…\]/);
  });

  it("packs nothing when a suite has problems, or a plugin imports what can't be found", async () => {
    const broken = await project({ ...files, "project/tests/refunds.hafen.yml": files["project/tests/refunds.hafen.yml"].replace("../providers/acme.yml", "../providers/none.yml") });
    const r = await cli(join(broken, "project"), ["pack", "tests", "-o", "x.mjs"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.all, /none\.yml doesn't exist[\s\S]*nothing was packed/);
    const unfound = await project({ ...files, "project/plugins/polite.js": `import { nope } from "not-installed-anywhere";\n${files["project/plugins/polite.js"]}` });
    const u = await cli(join(unfound, "project"), ["pack", "tests", "-o", "x.mjs"]);
    assert.equal(u.code, 2, said(u));
    assert.match(u.all, /plugins\/polite\.js|not-installed-anywhere/);
    assert.match(u.all, /nothing was packed/);
  });
});

describe("a pack's secrets", () => {
  // The secrets' values where it's packed: none of them may end up in a file
  const PACKED_WITH = { MOCK_TOKEN: "tok-packing-secret-5150", OPENAI_API_KEY: "sk-packing-secret-8080" };
  // And where it runs
  const RUN_WITH = { MOCK_TOKEN: "tok-running-secret-2718", OPENAI_API_KEY: "sk-running-secret-3141" };

  // A suite with a provider file whose header is a secret ({{secret.MOCK_TOKEN}}), and a test on a
  // preset that takes its default key (OPENAI_API_KEY); their address is the environment's
  const files = {
    "tests/smoke.hafen.yml": `version: 1
name: Smoke
provider: ../providers/mock.yml
tests:
  - name: refund
    turns:
      - user: I want a refund
        expect:
          - { type: status, equals: 200 }
          - { path: $.data.order.id, equals: 4417 }
  - name: preset
    provider: { kind: openai-chat, model: gpt-test, base_url: "{{env.base_url}}/openai" }
    turns:
      - user: hello
        expect: [ { type: status, equals: 200 } ]
`,
    "providers/mock.yml": `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
  };

  // A folder with these files (paths to text), the mock's address in them
  async function project(these) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-pack-env-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(these)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }

  // A node process in `dir` (the command line, or a pack), with only this environment
  function node(dir, args, env = {}) {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, args, { cwd: dir, env: { PATH: process.env.PATH, NO_COLOR: "1", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolveRun({ code, stdout, stderr, all: stdout + stderr }));
    });
  }
  const exists = (path) => access(path).then(() => true, () => false);

  // The suites packed (with their secrets set, as they would be on a developer's machine) and the pack
  // copied somewhere empty: { dir, away, packed }
  async function packed(these = files) {
    const dir = await project(these);
    const r = await node(dir, [CLI, "pack", "tests", "-o", "out/smoke.hafen-pack.mjs"], PACKED_WITH);
    assert.equal(r.code, 0, said(r));
    const away = await mkdtemp(join(tmpdir(), "hafen-pack-env-run-"));
    dirs.push(away);
    await writeFile(join(away, "smoke.hafen-pack.mjs"), await readFile(join(dir, "out/smoke.hafen-pack.mjs")));
    return { dir, away, packed: r };
  }

  it("writes their names next to it, in <name>.secret.example, each with what uses it, and the environment's in <name>.env.example; no value in them or in the pack", async () => {
    const { dir, packed: r } = await packed();
    assert.match(r.stdout, /environment values it uses, from --env <file>: base_url \(their names are in smoke\.hafen-pack\.env\.example\)/);
    assert.match(r.stdout, /secrets it needs, from --secret <file> or the environment: MOCK_TOKEN, OPENAI_API_KEY \(their names are in smoke\.hafen-pack\.secret\.example\)/);
    const example = await readFile(join(dir, "out/smoke.hafen-pack.secret.example"), "utf8");
    assert.equal(example, `# The secrets smoke.hafen-pack.mjs needs: their names, never their values. Fill in a copy (never commit
# it) and give it with --secret, or set them as environment variables where it runs:
#   node smoke.hafen-pack.mjs run --env staging.env --secret staging.secrets.env

# used by providers/mock.yml
MOCK_TOKEN=
# used by tests/smoke.hafen.yml (the openai-chat preset's default key)
OPENAI_API_KEY=
`);
    const envExample = await readFile(join(dir, "out/smoke.hafen-pack.env.example"), "utf8");
    assert.match(envExample, /\n\nbase_url=\n$/);
    const pack = await readFile(join(dir, "out/smoke.hafen-pack.mjs"), "utf8");
    for (const value of [...Object.values(PACKED_WITH), mock.url]) {
      assert.ok(!pack.includes(value), `${value} isn't in the pack`);
      assert.ok(!example.includes(value) && !envExample.includes(value), `${value} isn't in the examples`);
    }
    // Its names, as the files name them (never a value)
    assert.ok(pack.includes("Bearer {{secret.MOCK_TOKEN}}"));
    // (the .env.example that once held the secrets' names is the environment's now)
    assert.ok(!envExample.includes("MOCK_TOKEN"));
  });

  it("writes no .secret.example when it needs none, and says so", async () => {
    const dir = await project({ ...files, "providers/mock.yml": files["providers/mock.yml"].replace(/^headers:.*\n/m, ""), "tests/smoke.hafen.yml": files["tests/smoke.hafen.yml"].replace("kind: openai-chat,", "kind: openai-chat, api_key: \"\",") });
    const r = await node(dir, [CLI, "pack", "tests", "-o", "out/smoke.hafen-pack.mjs"], PACKED_WITH);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /secrets it needs, from --secret <file> or the environment: none\n/);
    assert.ok(!r.stdout.includes(".secret.example"));
    assert.ok(await exists(join(dir, "out/smoke.hafen-pack.mjs")));
    assert.ok(!(await exists(join(dir, "out/smoke.hafen-pack.secret.example"))));
  });

  it("runs with --secret <file>: the file's secrets reach the run; one it leaves empty stops it before anything is sent, unless an environment variable has it", async () => {
    const { dir, away } = await packed();
    for (const where of [dir, away]) await writeFile(join(where, "staging.env"), `base_url=${mock.url}\n`);
    await writeFile(join(away, "staging.secrets.env"), `# staging\nMOCK_TOKEN=${RUN_WITH.MOCK_TOKEN}\nOPENAI_API_KEY=${RUN_WITH.OPENAI_API_KEY}\n`);
    const both = ["--env", "staging.env", "--secret", "staging.secrets.env"];
    const check = await node(away, ["smoke.hafen-pack.mjs", "validate", ...both, "--env-check"]);
    assert.equal(check.code, 0, said(check));
    const run = await node(away, ["smoke.hafen-pack.mjs", "run", ...both, "--report", "run:out/run.json"]);
    assert.equal(run.code, 0, said(run));
    assert.match(run.stdout, /✓ Smoke › refund/);
    assert.match(run.stdout, /✓ Smoke › preset/);
    assert.equal(mock.log.find((x) => x.path === "/json").headers.authorization, `Bearer ${RUN_WITH.MOCK_TOKEN}`);
    assert.equal(mock.log.find((x) => x.path === "/openai/chat/completions").headers.authorization, `Bearer ${RUN_WITH.OPENAI_API_KEY}`);
    const record = await readFile(join(away, "out/run.json"), "utf8");
    for (const value of Object.values(RUN_WITH)) assert.ok(!record.includes(value), `${value} is redacted from the run file`);

    // One the file leaves empty (as the example has it): validate --env-check names it, as the command
    // line does in the project, and run sends nothing
    mock.reset();
    for (const where of [dir, away]) await writeFile(join(where, "staging.secrets.env"), `MOCK_TOKEN=\nOPENAI_API_KEY=${RUN_WITH.OPENAI_API_KEY}\n`);
    const missing = await node(away, ["smoke.hafen-pack.mjs", "validate", ...both, "--env-check"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.all, /MOCK_TOKEN/);
    assert.ok(!missing.all.includes("OPENAI_API_KEY"));
    const unpacked = await node(dir, [CLI, "validate", "tests", ...both, "--env-check"]);
    assert.equal(unpacked.code, 2, said(unpacked));
    assert.equal(missing.all, unpacked.all);
    const stopped = await node(away, ["smoke.hafen-pack.mjs", "run", ...both]);
    assert.equal(stopped.code, 2, said(stopped));
    assert.match(stopped.all, /MOCK_TOKEN[\s\S]*nothing was sent/);
    assert.equal(mock.log.length, 0);
    // An environment variable fills what the file leaves empty
    const env = await node(away, ["smoke.hafen-pack.mjs", "run", ...both], { MOCK_TOKEN: RUN_WITH.MOCK_TOKEN });
    assert.equal(env.code, 0, said(env));
    // And the secrets from environment variables alone, a .env Node reads included (no --secret)
    await writeFile(join(away, ".env"), `MOCK_TOKEN=${RUN_WITH.MOCK_TOKEN}\nOPENAI_API_KEY=${RUN_WITH.OPENAI_API_KEY}\n`);
    const dotenv = await node(away, ["--env-file=.env", "smoke.hafen-pack.mjs", "run", "--env", "staging.env"]);
    assert.equal(dotenv.code, 0, said(dotenv));
  });

  it("lists a plugin's secret, a System One check's default key and a suite's own secret, each with what uses it; a folder's environments/*.yml isn't packed", async () => {
    const { dir, packed: r } = await packed({
      ...files,
      "environments/staging.yml": "base_url: MOCK_URL\n",
      "tests/smoke.hafen.yml": `${files["tests/smoke.hafen.yml"].replace("I want a refund", "I want a refund {{secret.REGION}}").replace("- { type: status, equals: 200 }\n          - { path:", "- { type: status, equals: 200 }\n          - { type: systemone.noul, question: \"Is it kind?\", min: 0.5 }\n          - { type: signed }\n          - { path:")}`,
      "plugins/signed.js": `export default { kind: "check", name: "signed", version: "1.0.0", async check({ transport }) {
  await transport.fetch({ url: "https://sign.example/", headers: { authorization: "Bearer {{secret.SIGNING_KEY}}" } });
  return { status: "pass", reason: "ok" };
} };
`,
    });
    const example = await readFile(join(dir, "out/smoke.hafen-pack.secret.example"), "utf8");
    assert.match(example, /\n# used by tests\/smoke\.hafen\.yml \(System One's default key\)\nJEV_API_KEY=\n/);
    assert.match(example, /\n# used by providers\/mock\.yml\nMOCK_TOKEN=\n/);
    assert.match(example, /\n# used by plugins\/signed\.js\nSIGNING_KEY=\n/);
    assert.match(example, /\n# used by tests\/smoke\.hafen\.yml\nREGION=\n/);
    assert.equal(example.match(/^[A-Z_]+=$/gm).length, 5);
    assert.match(r.stdout, /1 suite · 1 provider · 1 plugin \(bundled with 1 file\)\n/);
    assert.ok(!(await readFile(join(dir, "out/smoke.hafen-pack.mjs"), "utf8")).includes("environments/staging.yml"));
  });
});

describe("a pack's own commands, and hafen installed without rolldown", () => {
  const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
  const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Cover
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

  async function project(files, { withJson = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-cli-"));
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
      const child = spawn(process.execPath, args, { cwd: dir, env: { ...base, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
      child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    });
  }
  const cli = (dir, args, opts) => node(dir, [CLI, ...args], opts);

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
      away = await mkdtemp(join(tmpdir(), "hafen-pack-away-"));
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
});
