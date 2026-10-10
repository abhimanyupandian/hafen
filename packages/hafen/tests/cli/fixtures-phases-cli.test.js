// A fixture's phases, its run() saying to stop, and env.set, from the command line against the mock
// endpoint: a beforeAll that says to stop exits 3 ("stopped early"), its line said without --verbose,
// every test skipped saying why in the console and the reports; a before that says to stop skips
// that test only; a provider naming a fixture in a list its phases leave out is a problem `validate`
// says where; and an {{env.NAME}} only a fixture sets passes validate and is there in the run. Each
// test has a folder of its own.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = join(fileURLToPath(new URL("../../", import.meta.url)), "cli/hafen.js");
let mock;
const dirs = [];

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
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;
const fixtureLog = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body.message);
const chats = () => mock.log.filter((x) => x.path === "/json");

before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

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
