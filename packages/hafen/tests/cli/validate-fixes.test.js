// What validate and run say, from the command line, against the mock endpoint: a provider's own
// timeout_ms and retries, the secrets a plugin names in its code (validate --env-check and run's own
// check, before anything is sent), the old ways to write a secret or an environment's value (each a
// problem), a turn the stop cut short, a stream cut off, a provider file outside the folder, and
// every problem's file, line and column. Each test has a folder of its own.

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

// A folder with these files (paths to text, MOCK_URL the mock's address); the command runs in `at`
async function project(files, at = "") {
  const root = await mkdtemp(join(tmpdir(), "hafen-validate-fixes-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return join(root, at);
}

function cli(dir, args, { env = {}, signalAfterMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;
const readJSON = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));

// A JSON provider on one of the mock's paths, with more of its keys
const provider = (path, more = "") => `kind: http
url: "MOCK_URL${path}"
body: { message: "{{user}}" }
response: { text: $.data.reply }
${more}`;
const suite = ({ head = "", test = "", expect = "[ { contains: \"You said\" } ]", user = "hi" } = {}) => `version: 1
provider: providers/p.yml
${head}
tests:
  - name: t
${test}    turns: [ { user: "${user}", expect: ${expect} } ]
`;

before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("a provider's timeout_ms and retries", () => {
  it("timeout_ms: 300 on a reply that takes 1.5 s: an error after 300 ms, said so; the suite's defaults win over it", async () => {
    const dir = await project({ "providers/p.yml": provider("/slow?ms=1500", "timeout_ms: 300\nretries: 0\n"), "s.hafen.yml": suite(), "d.hafen.yml": suite({ head: "defaults: { timeout_ms: 5000 }" }) });
    const started = Date.now();
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 1, said(r));
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
    assert.match(r.stdout, /turn 1 · error: timed out after 300 ms/);
    const d = await cli(dir, ["run", "d.hafen.yml"]);
    assert.equal(d.code, 0, said(d));
  });

  it("retries: 0 on a 500: one request", async () => {
    const dir = await project({ "providers/p.yml": provider("/error/500", "retries: 0\n"), "s.hafen.yml": suite() });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 1, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/error/500").length, 1);
  });
});

// A fixture that logs in with a password it names in its code, and logs out when the run ends
const LOGIN = `export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["ACME_COOKIE"],
  async run({ phase, settings, transport, signal }) {
    if (phase === "afterAll") {
      await transport.fetch({ url: settings.logout_url, method: "POST", body: {}, signal });
      return;
    }
    const res = await transport.fetch({ url: settings.login_url, method: "POST",
      body: { user: "qa", password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status >= 400) throw new Error("login failed: " + res.status);
    return { ACME_COOKIE: "c-1" };
  },
};
`;

describe("a secret a plugin names in its code", () => {
  const files = {
    "plugins/acme-login.js": LOGIN,
    "providers/p.yml": `${provider("/json")}headers: { cookie: "{{secret.ACME_COOKIE}}" }\nlogin_url: "MOCK_URL/login"\nlogout_url: "MOCK_URL/json"\nfixtures: { beforeAll: [acme-login], afterAll: [acme-login] }\n`,
    "s.hafen.yml": suite(),
  };
  const PROBLEM = `plugins/acme-login.js:13:38  {{secret.ACME_PASSWORD}} isn't set (not in the environment: set it, or pass --secret <file>) (the fixture plugin "acme-login" names it)`;

  it("unset: validate --env-check exits 2 naming it at its line in the plugin; run sends nothing (no login, no logout), exit 2", async () => {
    const dir = await project(files);
    const env = { ACME_PASSWORD: "" };
    const checked = await cli(dir, ["validate", "s.hafen.yml", "--env-check"], { env });
    assert.equal(checked.code, 2, said(checked));
    assert.ok(checked.stderr.includes(PROBLEM), said(checked));
    // (without --env-check, secrets aren't checked)
    const unchecked = await cli(dir, ["validate", "s.hafen.yml"], { env });
    assert.equal(unchecked.code, 0, said(unchecked));
    const ran = await cli(dir, ["run", "s.hafen.yml"], { env });
    assert.equal(ran.code, 2, said(ran));
    assert.ok(ran.stderr.includes(PROBLEM), said(ran));
    assert.match(ran.stderr, /1 problem: nothing was sent\./);
    assert.equal(mock.log.length, 0);
  });

  it("set: validate --env-check passes, and the run logs in, sends, logs out", async () => {
    const dir = await project(files);
    const env = { ACME_PASSWORD: "pw-1" };
    const checked = await cli(dir, ["validate", "s.hafen.yml", "--env-check"], { env });
    assert.equal(checked.code, 0, said(checked));
    const ran = await cli(dir, ["run", "s.hafen.yml"], { env });
    assert.equal(ran.code, 0, said(ran));
    assert.deepEqual(mock.log.map((x) => x.path), ["/login", "/json", "/json"]);
    assert.equal(mock.log[0].body.password, "pw-1");
  });
});

describe("the old ways to write a secret or an environment's value", () => {
  // Each is a problem where it's written, saying what to write instead: validate exits 2 (with or
  // without --env-check), and run exits 2 with nothing sent, whatever is set
  const fails = async (files, problem) => {
    const dir = await project(files);
    const env = { API_KEY: "k-1", ACME_PASSWORD: "pw-1" };
    for (const args of [["validate", "s.hafen.yml"], ["validate", "s.hafen.yml", "--env-check"], ["run", "s.hafen.yml", "--env", "stage"]]) {
      const r = await cli(dir, args, { env });
      assert.equal(r.code, 2, said(r));
      assert.ok(r.stderr.includes(problem), said(r));
    }
    assert.equal(mock.log.length, 0);
  };

  it("${env:NAME}: write {{secret.NAME}}", () => fails({
    "providers/p.yml": `${provider("/json")}headers: { x-key: "\${env:API_KEY}" }\n`,
    "s.hafen.yml": suite(),
  }, "providers/p.yml:5:20  ${env:API_KEY} is the old way to write a secret: write {{secret.API_KEY}}"));

  it("{{scope.NAME}}: write {{env.NAME}} or {{secret.NAME}}", () => fails({
    "environments/stage.yml": "who: stage-crew\n",
    "providers/p.yml": provider("/json"),
    "s.hafen.yml": suite({ user: "hi from {{scope.who}}" }),
  }, "s.hafen.yml:6:31  {{scope.who}} is the old way: write {{env.who}} (a value of the environment) or {{secret.who}} (a secret)"));

  it("a plugin's { secret: \"NAME\" }: write \"{{secret.NAME}}\" in its request", () => fails({
    "plugins/acme-login.js": LOGIN.replace('"{{secret.ACME_PASSWORD}}"', '{ secret: "ACME_PASSWORD" }'),
    "providers/p.yml": `${provider("/json")}headers: { cookie: "{{secret.ACME_COOKIE}}" }\nlogin_url: "MOCK_URL/login"\nfixtures: { beforeAll: [acme-login] }\n`,
    "s.hafen.yml": suite(),
  }, `plugins/acme-login.js:13:39  { secret: "ACME_PASSWORD" } is the old way to name a secret: write "{{secret.ACME_PASSWORD}}" in the request (a header's "Bearer {{secret.ACME_PASSWORD}}")`));
});

describe("a turn the stop cut short", () => {
  it("has its latency and status checks skipped too (the run was stopped), exit 3", async () => {
    const dir = await project({ "providers/p.yml": provider("/slow?ms=4000"), "s.hafen.yml": suite({ expect: "[ { type: latency, max_ms: 5000 }, { type: status, equals: 200 }, { contains: \"You said\" } ]" }) });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"], { signalAfterMs: 1000 });
    assert.equal(r.code, 3, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.turns[0].results.map((x) => [x.status, x.reason]), [["skipped", "the run was stopped"], ["skipped", "the run was stopped"], ["skipped", "the run was stopped"]]);
    assert.equal(run.summary.checks.passed, 0);
  });
});

describe("a stream cut off mid-reply", () => {
  it("says the response ended early, after how many chunks, and keeps the reply so far", async () => {
    const dir = await project({ "providers/p.yml": `kind: http\nurl: "MOCK_URL/cut"\nbody: { message: "{{user}}" }\nstream: sse\ndone_marker: "[DONE]"\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n`, "s.hafen.yml": suite() });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    // (how many chunks the reader saw depends on how the network grouped the mock's writes: 1 or 2)
    assert.match(r.stdout, /turn 1 · error: the response ended early: the connection closed after [12] chunks? \(the reply so far is kept\)/);
    assert.equal((await readJSON(dir, "out/run.json")).turns[0].reply, "This reply is going ");
  });
});

describe("a provider file outside the opened folder", () => {
  it("is said to be outside it, one problem (not \"doesn't exist\", and no \"no provider\" after it); nothing sent", async () => {
    const dir = await project({ "outside.yml": provider("/json"), "proj/s.hafen.yml": suite().replace("providers/p.yml", "../outside.yml") }, "proj");
    const r = await cli(dir, ["validate", "s.hafen.yml"]);
    assert.equal(r.code, 2, said(r));
    assert.equal(r.stderr.trim(), "s.hafen.yml:2:11  provider: the provider file ../outside.yml isn't in the opened folder (only files in it are read)\n\n1 problem");
    const ran = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(ran.code, 2, said(ran));
    assert.equal(mock.log.length, 0);
  });
});

describe("every problem has its file, line and column", () => {
  it("a provider file's fixture lists: at the fixture in its list", async () => {
    const dir = await project({ "providers/p.yml": `${provider("/json")}fixtures:\n  beforeAll: [nothere]\n  before: [one, one]\n`, "s.hafen.yml": suite() });
    const r = await cli(dir, ["validate", "s.hafen.yml"]);
    assert.equal(r.code, 2, said(r));
    assert.deepEqual(r.stderr.trim().split("\n"), [
      "providers/p.yml:7:17  fixtures.before names one twice: a list runs each fixture once (another list can name it too)",
      "providers/p.yml:6:15  the fixture \"nothere\" (fixtures.beforeAll) isn't in the folder's plugins/ or the suite's plugins",
      "providers/p.yml:7:12  the fixture \"one\" (fixtures.before) isn't in the folder's plugins/ or the suite's plugins",
      "",
      "3 problems",
    ]);
  });
});
