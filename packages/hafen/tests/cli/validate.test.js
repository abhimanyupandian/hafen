// What validate finds, and run finds before it sends anything (exit 2), each at its file, line and
// column: a misspelled key, check type, plugin or schema; a check without what its type needs; a secret
// that isn't set; a test's provider by name; a provider file outside the folder; its fixture lists.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { CLI, JSON_PROVIDER, cli, dirs, mock, project, readJSON, said, suite, useMock } from "./helpers.js";

useMock();

const results = (run) => run.turns.map((t) => (t.results ?? []).map((r) => r.status));

describe("validate", () => {
  it("a newer version, a bad path, an unknown judge, a bad regex: each named with its line, exit 2", async () => {
    const dir = await project({
      "newer.hafen.yml": "version: 2\nprovider: providers/json.yml\ntests: []\n",
      "bad.hafen.yml": suite(`  - name: bad
    turns:
      - user: hi
        expect:
          - { path: "$.[", exists: true }
          - { matches: "(" }
          - { type: judge, judge: nobody, rubric: [x] }
`),
      "good.hafen.yml": suite(`  - name: good
    turns: [ { user: hi } ]
`),
      "empty.hafen.yml": suite("  []\n").replace("tests:\n  []", "tests: []"),
    });
    const r = await cli(dir, ["validate", "newer.hafen.yml", "bad.hafen.yml", "good.hafen.yml", "empty.hafen.yml"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /newer\.hafen\.yml.*version/);
    assert.match(r.stderr, /bad\.hafen\.yml:\d+:\d+/);
    assert.match(r.stderr, /nobody/);
    assert.match(r.stdout, /✓ good\.hafen\.yml/);
    assert.match(r.stdout, /✓ empty\.hafen\.yml/);
    assert.match(r.stderr, /no tests yet/);
    assert.equal(mock.log.length, 0);
    // Running only an empty suite: exit 2 (nothing ran)
    const empty = await cli(dir, ["run", "empty.hafen.yml"]);
    assert.equal(empty.code, 2, said(empty));
    assert.match(empty.stderr, /the suites have none yet/);
  });

  // What validate passes, run doesn't stop on: they're the same check (engine/runner.js, preflight).
  // Each of these passed validate, then sent the run, then failed it (or passed it, with checks that
  // never ran).
  it("a misspelled key or check type, a plugin that isn't there, an --env that isn't: validate finds each, and run sends nothing (exit 2)", async () => {
    const dir = await project({
      "typo-key.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expcet: [ { contains: "never in the reply" } ]
`),
      "typo-type.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expect: [ { type: contians, value: hi } ]
`),
      "no-plugin.hafen.yml": suite(`  - name: a
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`, 'provider: "plugin:nothere"'),
      "no-judge-plugin.hafen.yml": suite(`  - name: a
    turns: [ { user: hi, expect: [ { type: judge, judge: mine, rubric: [polite] } ] } ]
`, "provider: providers/json.yml\njudges:\n  mine: { kind: plugin, plugin: nobody }"),
    });
    const expected = {
      "typo-key.hafen.yml": /typo-key\.hafen\.yml:10:9 +tests\.0\.turns\.0: unknown key "expcet" \(did you mean "expect"\?\)/,
      "typo-type.hafen.yml": /typo-type\.hafen\.yml:10:\d+ +"contians" isn't a check type \(did you mean "contains"\?\)/,
      "no-plugin.hafen.yml": /the provider plugin "nothere" isn't in the folder's plugins/,
      "no-judge-plugin.hafen.yml": /the judge "mine" uses the plugin "nobody", which isn't/,
    };
    for (const [file, problem] of Object.entries(expected)) {
      const valid = await cli(dir, ["validate", file]);
      assert.equal(valid.code, 2, `${file}: ${said(valid)}`);
      assert.match(valid.stderr, problem);
      const ran = await cli(dir, ["run", file, "--report", "junit:out/junit.xml"]);
      assert.equal(ran.code, 2, `${file}: ${said(ran)}`);
      assert.match(ran.stderr, problem);
      assert.match(ran.stderr, /nothing was sent/);
      // (the reports are still written, so CI shows why)
      assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testsuites/);
    }
    // An environment that isn't there
    const env = await cli(dir, ["validate", "typo-type.hafen.yml", "--env", "stagnig"]);
    assert.match(env.stderr, /there's no environment or scope "stagnig" \(local\)/);
    assert.equal(mock.log.length, 0);
  });

  it("validate --env --env-check checks the secrets as run does", async () => {
    const dir = await project({
      "providers/scoped.yml": `kind: http
url: "MOCK_URL/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
      "s.hafen.yml": `version: 1
provider: providers/scoped.yml
tests:
  - name: a
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`,
    });
    const unchecked = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage"], { env: { API_KEY: "" } });
    assert.equal(unchecked.code, 0, said(unchecked));
    const checked = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage", "--env-check"], { env: { API_KEY: "" } });
    assert.equal(checked.code, 2, said(checked));
    assert.match(checked.stderr, /providers\/scoped\.yml:3:35 {2}\{\{secret\.API_KEY\}\} isn't set \(not in the environment: set it, or pass --secret <file>\)/);
    const set = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage", "--env-check"], { env: { API_KEY: "sk-1" } });
    assert.equal(set.code, 0, said(set));
  });

  it("run checks --report and --baseline before it sends anything", async () => {
    const dir = await project({ "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n") });
    const format = await cli(dir, ["run", "s.hafen.yml", "--report", "xml:out/x.xml"]);
    assert.equal(format.code, 2, said(format));
    assert.match(format.stderr, /unknown report format "xml" \(junit, run, md, json\)/);
    const baseline = await cli(dir, ["run", "s.hafen.yml", "--baseline", "nope.json"]);
    assert.equal(baseline.code, 2, said(baseline));
    assert.match(baseline.stderr, /the baseline can't be read/);
    assert.equal(mock.log.length, 0);
  });

  it("a check's schema can be a file (JSON or YAML); one that isn't there stops the run before it sends", async () => {
    const dir = await project({
      "schemas/reply.json": '{ "type": "object", "required": ["reply"], "properties": { "reply": { "type": "string" } } }',
      "schemas/strict.yml": "type: object\nrequired: [nothing]\n",
      "s.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expect:
          - { path: $.data, schema: schemas/reply.json }
          - { path: $.data, schema: schemas/strict.yml }
`),
      "missing.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expect: [ { path: $.data, schema: schemas/nope.json } ]
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    assert.deepEqual(results(await readJSON(dir, "out/run.json")), [["pass", "fail"]]);
    mock.reset();
    const missing = await cli(dir, ["validate", "missing.hafen.yml"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.stderr, /missing\.hafen\.yml:10:\d+ +the schema file schemas\/nope\.json doesn't exist/);
    assert.equal(mock.log.length, 0);
  });

  it("{{turn.index}} is the turn's number, from 1", async () => {
    const dir = await project({ "s.hafen.yml": suite(`  - name: a
    turns:
      - { user: "turn {{turn.index}}", expect: [ { contains: "turn 1" } ] }
      - { user: "turn {{turn.index}}", expect: [ { contains: "turn 2" } ] }
`) });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual(mock.log.map((x) => x.body.message), ["turn 1", "turn 2"]);
  });
});

describe("a check without what its type needs, from the command line", () => {
  async function project(files) {
    const root = await mkdtemp(join(tmpdir(), "hafen-check-needs-"));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return root;
  }

  function cli(dir, args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  const FILES = {
    "providers/p.yml": `kind: http
url: "MOCK_URL/json"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
    "checks.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: refund
    turns:
      - user: I want a refund
        expect:
          - { type: tool.not_called, name: lookup_order }
          - { type: length }
          - { type: tool.order, value: [lookup_order, refund] }
          - { type: sequence, order: [thinking, text] }
          - { type: length, enabled: false }
          - { contains: refund }
`,
  };
  const PROBLEMS = [
    "checks.hafen.yml:8:13  a tool.not_called check needs tool (the tool's name): \"name\" is the check's own label (did you mean \"tool\"?)",
    "checks.hafen.yml:9:13  a length check needs min_length or max_length (a limit in characters)",
    "checks.hafen.yml:10:13  a tool.order check needs order (the tools' names, in order): \"value\" is for contains, not_contains, matches and sequence checks (did you mean \"order\"?)",
    "checks.hafen.yml:11:13  a sequence check needs value (a list of event kinds, in order): \"order\" is for tool.order checks (did you mean \"value\"?)",
  ];

  it("validate: each at its file, line and column, exit 2", async () => {
    const dir = await project(FILES);
    const r = await cli(dir, ["validate"]);
    assert.equal(r.code, 2, said(r));
    for (const line of PROBLEMS) assert.ok(r.stdout.includes(line) || r.stderr.includes(line), `${line}\n---\n${said(r)}`);
    assert.match(said(r), /4 problems/);
  });

  it("run: the same problems, exit 2, and nothing sent", async () => {
    const dir = await project(FILES);
    const r = await cli(dir, ["run"]);
    assert.equal(r.code, 2, said(r));
    for (const line of PROBLEMS) assert.ok(r.stderr.includes(line), `${line}\n---\n${said(r)}`);
    assert.match(r.stderr, /4 problems: nothing was sent\./);
    assert.deepEqual(mock.log, []);
  });

  it("written as each type needs it, the same suite runs and passes", async () => {
    const dir = await project({ ...FILES, "checks.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: refund
    turns:
      - user: I want a refund
        expect:
          - { type: tool.not_called, tool: lookup_order }
          - { type: length, max_length: 2000 }
          - { type: tool.order, order: [lookup_order, refund], enabled: false }
          - { type: sequence, value: [text] }
          - { type: length, enabled: false }
          - { contains: refund }
` });
    const r = await cli(dir, ["run"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/json").length, 1);
  });
});

describe("a provider file and the plugins it names", () => {
  // A folder with these files (paths to text, MOCK_URL the mock's address); the command runs in `at`
  async function project(files, at = "") {
    const root = await mkdtemp(join(tmpdir(), "hafen-cli-"));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return join(root, at);
  }

  function cli(dir, args, { env = {}, signalAfterMs } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  // A JSON provider on one of the mock's paths, with more of its keys
  const provider = (path, more = "") => `kind: http
url: "MOCK_URL${path}"
body: { message: "{{user}}" }
response: { text: $.data.reply }
${more}`;
  const suite = ({ head = "", test = "", expect = "[ { contains: \"You said\" } ]" } = {}) => `version: 1
provider: providers/p.yml
${head}
tests:
  - name: t
${test}    turns: [ { user: "hi", expect: ${expect} } ]
`;

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
});

describe("what a suite names: a test's provider, a secret", () => {
  // A folder with these files (paths to text), its environment's base_url the mock's
  async function project(files) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-cli-"));
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
        env: { ...process.env, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  const NAMED = `provider: providers/json.yml
providers:
  toolsy:
    kind: http
    url: "{{base_url}}/json"
    headers: { x-which: toolsy }
    body: { message: "{{user}}" }
    response: { text: $.data.reply }`;

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
});
