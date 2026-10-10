// Fixtures from the command line, against the mock endpoint: a provider's fixture logging in first, the
// values it gives redacted; a fixture's phases, saying to stop, and env.set; an afterAll fixture (a
// logout) sent however the run ends.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { CLI, JSON_PROVIDER, cli, dirs, mock, project, readJSON, said, useMock } from "./helpers.js";

useMock();

describe("fixtures", () => {
  // A login (the mock's /auth/login): its cookies and CSRF token, for an HTTP provider as {{secret.…}}
  const files = {
    "plugins/acme-login.js": `export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["ACME_COOKIE", "ACME_CSRF"],
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa-bot", password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status >= 400) throw new Error("login failed: " + res.status);
    const { csrf_token } = await res.json();
    return { ACME_COOKIE: [res.headers["set-cookie"]].flat().map((c) => c.split(";")[0]).join("; "), ACME_CSRF: csrf_token };
  },
};
`,
    "providers/acme.yml": `kind: http
fixtures: { beforeAll: [acme-login] }
url: "{{base_url}}/auth/chat"
login_url: "{{base_url}}/auth/login"
headers: { cookie: "{{secret.ACME_COOKIE}}", x-csrf-token: "{{secret.ACME_CSRF}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
    "s.hafen.yml": `version: 1
provider: providers/acme.yml
environments:
  local: { base_url: "MOCK_URL" }
tests:
  - name: behind the login
    turns: [ { user: hello, expect: [ { type: status, equals: 200 }, { contains: "You said: hello" } ] } ]
`,
  };

  it("a provider's fixture logs in first; the names it gives count as set for validate and run; their values are redacted", async () => {
    const dir = await project(files);
    const env = { ACME_PASSWORD: "qa-pass-1234" };
    const valid = await cli(dir, ["validate", "s.hafen.yml", "--env-check"], { env });
    assert.equal(valid.code, 0, said(valid));
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"], { env });
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.spans.find((s) => s.kind === "fixture")?.status, "ok");
    const text = JSON.stringify(run) + r.all;
    for (const secret of ["sess-5f2a9c71", "csrf-0b7e41d2", "qa-pass-1234"]) assert.ok(!text.includes(secret), `${secret} is redacted`);
    // --verbose: each fixture as it ends, and each call it made
    const verbose = await cli(dir, ["run", "s.hafen.yml", "--verbose"], { env });
    assert.equal(verbose.code, 0, said(verbose));
    assert.match(verbose.stdout, /⚙ fixture acme-login · beforeAll · providers\/acme\.yml {2}ok {2}[\d.]+ s {2}gave ACME_COOKIE, ACME_CSRF · 1 call/);
    assert.match(verbose.stdout, /POST 127\.0\.0\.1:\d+\/auth\/login {2}200 {2}[\d.]+ s {2}\(fixture acme-login\)/);
    assert.match(verbose.stdout, /1 fixture · p50/);
    // Without the password: the run is a setup error (exit 2), saying why
    const failed = await cli(dir, ["run", "s.hafen.yml"], { env: { ACME_PASSWORD: "wrong" } });
    assert.equal(failed.code, 2, said(failed));
    assert.match(failed.all, /the fixture "acme-login" \(beforeAll\) failed: login failed: 401/);
    assert.match(failed.stdout, /⚙ fixture acme-login · beforeAll · providers\/acme\.yml {2}failed: login failed: 401/);
  });
});

describe("a fixture's phases, saying to stop, and env.set", () => {
  const fixture = (name, { phases, body = "" } = {}) => `export default {
  kind: "fixture", name: "${name}", version: "1.0.0", hosts: ["127.0.0.1"],${phases ? ` phases: ${JSON.stringify(phases)},` : ""}
  async run({ phase, settings, env, test, transport, signal }) {
    await transport.fetch({ url: settings.log_url, method: "POST", body: { message: "${name} " + phase + (test ? " " + test.name : "") }, signal });
    ${body}
  },
};
`;
  const provider = (lists, url = "{{env.base_url}}/json") => `kind: http
fixtures: ${lists}
url: "${url}"
log_url: "{{env.base_url}}/fixture-log"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const SUITE = `version: 1
name: S
provider: providers/p.yml
environments:
  local: { base_url: "MOCK_URL" }
tests:
  - name: a
    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]
  - name: b
    turns: [ { user: again, expect: [ { contains: "You said: again" } ] } ]
`;

  async function project(files) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-fixture-phases-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }
  function cli(dir, args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    });
  }
  const fixtureLog = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body.message);
  const chats = () => mock.log.filter((x) => x.path === "/json");

  describe("a fixture that says to stop", () => {
    it("in beforeAll: exit 3, nothing of the provider's sent, its line said, every test skipped saying why (console, JUnit, Markdown, the run file)", async () => {
      const dir = await project({
        "plugins/gate.js": fixture("gate", { phases: ["beforeAll"], body: "return false;" }),
        "plugins/logout.js": fixture("logout", { phases: ["afterAll"] }),
        "providers/p.yml": provider("{ beforeAll: [gate], afterAll: [logout] }"),
        "s.hafen.yml": SUITE,
      });
      const r = await cli(dir, ["run", "--report", "junit:out/j.xml", "--report", "md:out/s.md", "--report", "run:out/run.json"]);
      const why = 'the fixture "gate" (beforeAll) said to stop';
      assert.equal(r.code, 3, said(r));
      assert.equal(chats().length, 0);
      assert.deepEqual(fixtureLog(), ["gate beforeAll", "logout afterAll"]);
      assert.match(r.stdout, /^ {2}⚙ fixture gate · beforeAll · providers\/p\.yml {2}said to stop {2}[\d.]+ s {2}1 call$/m);
      assert.match(r.stdout, / · 2 skipped · /);
      assert.match(r.stdout, new RegExp(`^stopped: ${why.replace(/[()]/g, "\\$&")}$`, "m"));
      const xml = await readFile(join(dir, "out/j.xml"), "utf8");
      assert.equal(xml.match(/<skipped message="the fixture &quot;gate&quot; \(beforeAll\) said to stop"\/>/g).length, 2);
      assert.match(await readFile(join(dir, "out/s.md"), "utf8"), /- \*\*S › a\*\* · the fixture "gate" \(beforeAll\) said to stop/);
      const run = JSON.parse(await readFile(join(dir, "out/run.json"), "utf8"));
      assert.deepEqual([run.status, run.stopped, run.tests.map((t) => [t.status, t.reason])], ["stopped", why, [["skipped", why], ["skipped", why]]]);
    });

    it("in before: that test is skipped saying why, the others pass, exit 0", async () => {
      const dir = await project({
        "plugins/session.js": fixture("session", { phases: ["before"], body: 'return test.name !== "b";' }),
        "providers/p.yml": provider("{ before: [session] }"),
        "s.hafen.yml": SUITE,
      });
      const r = await cli(dir, ["run", "--report", "junit:out/j.xml"]);
      assert.equal(r.code, 0, said(r));
      assert.match(r.stdout, /^✓ S › a /m);
      assert.match(r.stdout, /^– S › b .*the fixture "session" \(before\) said to stop$/m);
      assert.match(r.stdout, /^ {2}⚙ fixture session · before · providers\/p\.yml · b {2}said to stop/m);
      assert.deepEqual(chats().map((x) => x.body.message), ["hello"]);
      assert.match(await readFile(join(dir, "out/j.xml"), "utf8"), /<testcase [^>]*name="b"[^>]*>\s*<skipped message="the fixture &quot;session&quot; \(before\) said to stop"\/>/);
    });
  });

  describe("phases and env.set, checked before anything is sent", () => {
    it("a provider naming a fixture in a list its phases leave out: validate says where (exit 2), and run sends nothing", async () => {
      const dir = await project({
        "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"] }),
        "providers/p.yml": provider("{ beforeAll: [gate], after: [gate] }"),
        "s.hafen.yml": SUITE,
      });
      const v = await cli(dir, ["validate"]);
      assert.equal(v.code, 2, said(v));
      assert.match(v.all, /providers\/p\.yml:2:40 {2}the fixture "gate" runs only in beforeAll and afterAll: it can't be in fixtures\.after/);
      const r = await cli(dir, ["run"]);
      assert.equal(r.code, 2, said(r));
      assert.equal(mock.log.length, 0);
    });

    it("an {{env.NAME}} only a fixture sets: validate passes, and the run has it from then on; without the fixture, it's a problem", async () => {
      const files = {
        "plugins/paths.js": fixture("paths", { phases: ["beforeAll"], body: 'env.set("chat_path", "json"); env.set("who", "the fixture");' }),
        "providers/p.yml": provider("{ beforeAll: [paths] }", "{{env.base_url}}/{{env.chat_path}}"),
        "s.hafen.yml": SUITE.replace("user: hello, expect: [ { contains: \"You said: hello\" } ]", "user: \"hello {{env.who}}\", expect: [ { contains: \"You said: hello the fixture\" } ]"),
      };
      const dir = await project(files);
      const v = await cli(dir, ["validate"]);
      assert.equal(v.code, 0, said(v));
      const r = await cli(dir, ["run", "--verbose"]);
      assert.equal(r.code, 0, said(r));
      assert.match(r.stdout, /⚙ fixture paths · beforeAll · providers\/p\.yml {2}ok {2}[\d.]+ s {2}set chat_path, who · 1 call/);
      assert.deepEqual(chats().map((x) => x.body.message), ["hello the fixture", "again"]);
      const without = await project({ ...files, "providers/p.yml": provider("{}", "{{env.base_url}}/{{env.chat_path}}") });
      const missing = await cli(without, ["validate"]);
      assert.equal(missing.code, 2, said(missing));
      assert.match(missing.all, /\{\{env\.chat_path\}\} isn't set: the environment "local" has no chat_path/);
    });
  });
});

describe("a provider's afterAll fixture (a logout) is sent however the run ends", () => {
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
