// --env and --secret, each as often as wanted (contracts/cli.md, Environments and secrets): their
// files' values merged in the order given, a later file's winning; the environment's name is the last
// --env's; the secrets files' values, then the environment's variables. Every value of the secrets
// files (one a later file overrides too) is hidden wherever it would show. In run, validate and a
// pack's run, against the mock endpoint: the CI recipe, --env globals.env --env staging.env --secret
// globals.secret.env --secret staging.secret.env.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { environmentOptions } from "../../cli/commands.js";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
const dirs = [];

const GLOBAL_TOKEN = "tok-global-1111";
const STAGING_TOKEN = "tok-staging-2222";
const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
// (the mock answers "You said: <message>")
const SUITE = `version: 1
name: Files
provider: ../providers/mock.yml
environments:
  staging: { label: from staging }
  prod: { label: from prod }
tests:
  - name: echo
    turns:
      - user: "{{env.greeting}} {{env.region}} {{label}} {{note}}"
        expect:
          - { type: status, equals: 200 }
`;
const files = {
  "proj/package.json": "{}",
  "proj/providers/mock.yml": PROVIDER,
  "proj/tests/files.hafen.yml": SUITE,
  "ci/globals.env": "base_url=MOCK_URL\ngreeting=hello\nregion=global-region\n",
  "ci/staging.env": "region=eu-staging\n",
  "ci/globals.secret.env": `MOCK_TOKEN=${GLOBAL_TOKEN}\nSHARED=shared-secret-3333\n`,
  "ci/staging.secret.env": `MOCK_TOKEN=${STAGING_TOKEN}\nSHARED=\n`,
};
const RECIPE = ["--env", "../ci/globals.env", "--env", "../ci/staging.env", "--secret", "../ci/globals.secret.env", "--secret", "../ci/staging.secret.env"];

async function project(these = files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "hafen-env-repeat-")));
  dirs.push(dir);
  for (const [path, text] of Object.entries(these)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}
function node(cwd, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const cli = (dir, args, env) => node(join(dir, "proj"), [CLI, ...args], env);
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;
const read = (dir, path) => readFile(join(dir, path), "utf8");

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("--env and --secret, read in order", () => {
  it("the environment files' values merged, a later one's winning; the name is the last --env's (a file's, or a name)", async () => {
    const dir = await project();
    const at = (p) => join(dir, "ci", p);
    const both = await environmentOptions({ env: [at("globals.env"), at("staging.env")] });
    assert.equal(both.env, "staging");
    assert.deepEqual(both.environment, { name: "staging", values: { base_url: mock.url, greeting: "hello", region: "eu-staging" } });
    // (the other way round: the globals' over staging's)
    assert.equal((await environmentOptions({ env: [at("staging.env"), at("globals.env")] })).environment.values.region, "global-region");
    // A name last: that environment, with the files' values
    assert.deepEqual(await environmentOptions({ env: [at("globals.env"), "prod"] }), { env: "prod", environment: { name: "prod", values: { base_url: mock.url, greeting: "hello", region: "global-region" } }, secrets: {}, secretValues: [], secretFiles: [] });
    // Names alone: the last one's, and no values (the suites' environment of that name)
    assert.deepEqual(await environmentOptions({ env: ["prod", "staging"] }), { env: "staging", secrets: {}, secretValues: [], secretFiles: [] });
  });

  it("the secrets files' values merged, a later one's winning; one a file leaves empty (NAME=) stays the earlier one's; every value is one to hide", async () => {
    const dir = await project();
    const at = (p) => join(dir, "ci", p);
    const given = await environmentOptions({ secret: [at("globals.secret.env"), at("staging.secret.env")] });
    assert.deepEqual(given.secrets, { MOCK_TOKEN: STAGING_TOKEN, SHARED: "shared-secret-3333" });
    assert.deepEqual(given.secretValues, [GLOBAL_TOKEN, "shared-secret-3333", STAGING_TOKEN]);
    assert.deepEqual(given.secretFiles, [at("globals.secret.env"), at("staging.secret.env")]);
  });

  it("lines that aren't NAME=value, in any of the files: each at its file:line:column, all of them", async () => {
    const dir = await project({ ...files, "ci/bad.env": "region=x\nno equals\n", "ci/bad.secret.env": "OK=1\n\"sk-leaky-9999\"\n" });
    const at = (p) => join(dir, "ci", p);
    await assert.rejects(environmentOptions({ env: [at("globals.env"), at("bad.env")], secret: [at("globals.secret.env"), at("bad.secret.env")] }), (e) => {
      assert.deepEqual(e.problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.message}`), [
        `${at("bad.secret.env")}:2:1 line 2 isn't NAME=value`,
        `${at("bad.env")}:2:1 line 2 isn't NAME=value`,
      ]);
      return e.setup;
    });
    // One that doesn't exist: said, whichever it is
    await assert.rejects(environmentOptions({ env: [at("globals.env"), at("nope.env")] }), (e) => e.setup && e.message === `the environment file ${at("nope.env")} doesn't exist`);
  });
});

describe("run with the CI recipe", () => {
  it("--env globals.env --env staging.env --secret globals.secret.env --secret staging.secret.env: staging's over the globals', the staging environment", async () => {
    const dir = await project();
    const r = await cli(dir, ["run", "tests", ...RECIPE, "--var", `note=${GLOBAL_TOKEN}`, "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.length, 1);
    assert.equal(mock.log[0].headers.authorization, `Bearer ${STAGING_TOKEN}`);
    assert.deepEqual(mock.log[0].body, { message: `hello eu-staging from staging ${GLOBAL_TOKEN}` });
    const run = await read(dir, "proj/out/run.json");
    assert.equal(JSON.parse(run).settings.env, "staging");
    // The overridden one's value too (a file's secret, used or not): never printed or written
    for (const [where, text] of [["the output", r.all], ["the run file", run], ["junit", await read(dir, "proj/out/junit.xml")]]) {
      for (const value of [GLOBAL_TOKEN, STAGING_TOKEN, "shared-secret-3333"]) assert.ok(!text.includes(value), `${value} isn't in ${where}`);
    }
    assert.match(run, /\[redacted\]/);
  });

  it("--secret and --secrets mixed: one list, in the order given; then the environment's variables", async () => {
    const dir = await project();
    const r = await cli(dir, ["run", "tests", "--env", "../ci/globals.env", "--env", "../ci/staging.env", "--secrets", "../ci/staging.secret.env", "--secret", "../ci/globals.secret.env", "--var", "note=x"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.at(-1).headers.authorization, `Bearer ${GLOBAL_TOKEN}`);
    // A name no file sets: the environment's variable
    const dir2 = await project({ ...files, "ci/globals.secret.env": "OTHER=1\n", "ci/staging.secret.env": "MOCK_TOKEN=\n" });
    const fromEnv = await cli(dir2, ["run", "tests", ...RECIPE, "--var", "note=x"], { MOCK_TOKEN: "tok-env-4444" });
    assert.equal(fromEnv.code, 0, said(fromEnv));
    assert.equal(mock.log.at(-1).headers.authorization, "Bearer tok-env-4444");
    // Nowhere: exit 2, saying where it was looked for
    const sent = mock.log.length;
    const nowhere = await cli(dir2, ["run", "tests", ...RECIPE, "--var", "note=x"]);
    assert.equal(nowhere.code, 2, said(nowhere));
    assert.match(nowhere.stderr, /\{\{secret\.MOCK_TOKEN\}\} isn't set \(not in the --secret files or the environment\)/);
    assert.equal(mock.log.length, sent);
  });

  it("a bad line in the second file: exit 2 at its file:line:column, nothing sent", async () => {
    const dir = await project({ ...files, "ci/staging.env": "region=eu\ngreeting hello\n" });
    const r = await cli(dir, ["run", "tests", ...RECIPE, "--var", "note=x"]);
    assert.equal(r.code, 2, said(r));
    assert.equal(r.stderr, `${join(dir, "ci/staging.env")}:2:1  line 2 isn't NAME=value\n\n1 problem: nothing was sent.\n`);
    assert.equal(mock.log.length, 0);
  });

  it("--help says so", async () => {
    const dir = await project();
    const r = await cli(dir, ["--help"]);
    assert.match(r.stdout, /--env globals\.env --env staging\.env --secret globals\.secret\.env --secret staging\.secret\.env/);
  });
});

describe("validate and a pack, with the recipe", () => {
  it("validate --env-check: the merged values and secrets", async () => {
    const dir = await project();
    const ok = await cli(dir, ["validate", "tests", ...RECIPE, "--var", "note=x", "--env-check"]);
    assert.equal(ok.code, 0, said(ok));
    // (staging's region only: without staging.env, the globals' does)
    const partial = await project({ ...files, "ci/globals.env": "base_url=MOCK_URL\ngreeting=hello\n" });
    const missing = await cli(partial, ["validate", "tests", "--env", "../ci/globals.env", "--secret", "../ci/globals.secret.env", "--var", "note=x"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.stderr, /\{\{env\.region\}\} isn't set: the environment "globals" has no region/);
    assert.ok(!missing.all.includes(GLOBAL_TOKEN));
  });

  it("a pack's run takes them the same way", async () => {
    const dir = await project();
    const packed = await cli(dir, ["pack", "tests", "-o", "out/files.hafen-pack.mjs"]);
    assert.equal(packed.code, 0, said(packed));
    const away = await mkdtemp(join(tmpdir(), "hafen-env-repeat-run-"));
    dirs.push(away);
    await writeFile(join(away, "files.hafen-pack.mjs"), await read(dir, "proj/out/files.hafen-pack.mjs"));
    const recipe = RECIPE.map((a) => (a.startsWith("../ci/") ? join(dir, a.slice(3)) : a));
    const r = await node(away, ["files.hafen-pack.mjs", "run", ...recipe, "--var", `note=${GLOBAL_TOKEN}`, "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log[0].headers.authorization, `Bearer ${STAGING_TOKEN}`);
    assert.deepEqual(mock.log[0].body, { message: `hello eu-staging from staging ${GLOBAL_TOKEN}` });
    const run = await read(away, "out/run.json");
    assert.ok(!run.includes(GLOBAL_TOKEN) && !run.includes(STAGING_TOKEN) && !r.all.includes(GLOBAL_TOKEN));
    assert.match((await node(away, ["files.hafen-pack.mjs", "--help"])).stdout, /--env globals\.env --env staging\.env/);
  });
});
