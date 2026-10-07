// What a run does with a provider's own settings (timeout_ms, retries: the test's, then the suite's
// defaults, then the provider's), the secrets plugins name in their code (checked before anything is
// sent), the old ways to write a secret or an environment's value (each a problem), a turn the stop
// cut short (its checks skipped), how a timeout and a stream cut off are said, a provider file outside the
// folder, and where each problem is (file, line and column). Against the mock endpoint.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse } from "yaml";
import { nodeHost } from "../../cli/node-host.js";
import { climbsOut, loadSuite, problemsFor } from "../../engine/files/suite-file.js";
import { fixturesOf } from "../../engine/fixture-lists.js";
import { oldSecretsNamed, secretsNamed } from "../../engine/plugins.js";
import { createProvider } from "../../engine/providers/index.js";
import { preflight, runSuites } from "../../engine/runner.js";
import { createSpans } from "../../engine/spans.js";
import { executeTurn } from "../../engine/turn.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, MOCK_SSE_PROVIDER, sseChunks, startMock } from "../helpers.js";

let mock;
const dirs = [];
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);
const statuses = (record) => record.results.map((r) => [r.name, r.status, r.reason]);

// A JSON provider on one of the mock's paths, with more of its keys
const provider = (path, more = "") => `kind: http
url: "{{base_url}}${path}"
body: { message: "{{user}}" }
response: { text: $.data.reply }
${more}`;

// A suite of one test on providers/p.yml (its head and test keys given)
const suite = ({ head = "", test = "", expect = "[ { contains: \"You said\" } ]" } = {}) => `version: 1
provider: providers/p.yml
${head}
tests:
  - name: t
${test}    turns: [ { user: hi, expect: ${expect} } ]
`;

async function runFiles(files, { secrets = {}, transport, signal, options = {} } = {}) {
  const host = memoryHost(files, { secrets, ...(transport ? { transport } : {}) });
  const s = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(s.errors, [], JSON.stringify(s.errors));
  return runSuites({ suites: [s], host, signal, options: { vars: { base_url: mock.url }, ...options } });
}

describe("a provider's timeout_ms and retries: the test's, then the suite's defaults, then the provider's, then Hafen's", () => {
  it("a provider's timeout_ms: 300 times out a reply that takes 1.5 s, saying 300 ms", async () => {
    const started = Date.now();
    const r = await runFiles({ "providers/p.yml": provider("/slow?ms=1500", "timeout_ms: 300\nretries: 0\n"), "s.hafen.yml": suite() });
    assert.ok(Date.now() - started < 1400, `${Date.now() - started} ms`);
    assert.equal(r.tests[0].status, "error");
    assert.equal(r.turns[0].error, "timed out after 300 ms");
    assert.equal(r.tests[0].settings.timeout_ms, 300);
  });

  it("the suite's defaults win over the provider's, and the test's over both", async () => {
    const files = { "providers/p.yml": provider("/slow?ms=600", "timeout_ms: 200\nretries: 0\n") };
    const defaults = await runFiles({ ...files, "s.hafen.yml": suite({ head: "defaults: { timeout_ms: 5000 }" }) });
    assert.equal(defaults.tests[0].status, "passed", JSON.stringify(defaults.turns[0].error));
    assert.equal(defaults.tests[0].settings.timeout_ms, 5000);
    const test = await runFiles({ ...files, "s.hafen.yml": suite({ head: "defaults: { timeout_ms: 5000 }", test: "    timeout_ms: 250\n" }) });
    assert.equal(test.turns[0].error, "timed out after 250 ms");
    // (--timeout, over all of them)
    const option = await runFiles({ ...files, "s.hafen.yml": suite({ test: "    timeout_ms: 250\n" }) }, { options: { timeoutMs: 5000 } });
    assert.equal(option.tests[0].status, "passed");
  });

  it("a provider's retries: 0 sends a 500 once; none, three times; the suite's and the test's win over it", async () => {
    const calls = async (more, s) => {
      const transport = fakeTransport(() => ({ status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" }, body: "{\"error\":\"down\"}" }));
      const r = await runFiles({ "providers/p.yml": provider("/json", more), "s.hafen.yml": s }, { transport });
      assert.equal(r.tests[0].status, "error");
      return transport.requests.length;
    };
    assert.equal(await calls("retries: 0\n", suite()), 1);
    assert.equal(await calls("", suite()), 3);
    assert.equal(await calls("retries: 0\n", suite({ head: "defaults: { retries: 1 }" })), 2);
    assert.equal(await calls("retries: 3\n", suite({ head: "defaults: { retries: 1 }", test: "    retries: 0\n" })), 1);
  });

  it("a turn given no settings (a conversation) takes the provider's own", async () => {
    const transport = fakeTransport(() => ({ status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" }, body: "{}" }));
    const spans = createSpans({ now: () => performance.now() });
    const scope = createScope({ layers: [{ base_url: mock.url }] });
    const out = await executeTurn({ provider: createProvider(parse(provider("/json", "retries: 0\n"))), message: "hi", scope, transport, spans, now: () => performance.now() });
    assert.equal(transport.requests.length, 1);
    assert.match(out.error, /^500/);
    const slow = await executeTurn({ provider: createProvider(parse(provider("/slow?ms=1500", "timeout_ms: 1200\n"))), message: "hi", scope, transport: memoryHost().transport, spans, now: () => performance.now() });
    assert.equal(slow.error, "timed out after 1.2 s");
  });
});

// A fixture that logs in with a password it names ("{{secret.ACME_PASSWORD}}"), and logs out after the run
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
const LOGIN_FILES = (more = {}) => ({
  "plugins/acme-login.js": LOGIN,
  "providers/p.yml": `${provider("/json")}headers: { cookie: "{{secret.ACME_COOKIE}}" }\nlogin_url: "{{base_url}}/login"\nlogout_url: "{{base_url}}/json"\nfixtures: { beforeAll: [acme-login], afterAll: [acme-login] }\n`,
  "s.hafen.yml": suite(),
  ...more,
});

describe("the secrets a plugin names in its code", () => {
  it("are read from its text, each where it's first written", () => {
    assert.deepEqual(secretsNamed(LOGIN), [{ name: "ACME_PASSWORD", line: 13, column: 38 }]);
    assert.deepEqual(secretsNamed('const a = "{{secret.A}}";\nconst b = `Bearer {{ secrets.B }}`;\n// "{{secret.A}}"\n').map((s) => [s.name, s.line, s.column]), [["A", 1, 12], ["B", 2, 19]]);
    // (the old way, { secret: "NAME" }, apart: each is a problem)
    assert.deepEqual(oldSecretsNamed("const a = { secret: 'A' };\nconst b = {secret:\"B\", prefix: 'x'};\n// { secret: `A` }\n").map((s) => [s.name, s.line, s.column]), [["A", 1, 13], ["B", 2, 12]]);
    assert.deepEqual(oldSecretsNamed(LOGIN), []);
    // (a name built as it runs can't be seen)
    assert.deepEqual(secretsNamed('"{{" + "secret.MADE}}"'), []);
    assert.deepEqual(oldSecretsNamed("({ secret: name }); ({ secret: \"lower-case\" })"), []);
  });

  it("one that isn't set stops the run before anything is sent (no login, no logout), said at its line in the plugin", async () => {
    const host = memoryHost(LOGIN_FILES());
    const s = await loadSuite(host, "s.hafen.yml");
    const r = await runSuites({ suites: [s], host, options: { vars: { base_url: mock.url } } });
    assert.equal(r.status, "error");
    assert.deepEqual(at(r.error.all), [`plugins/acme-login.js:13:38  {{secret.ACME_PASSWORD}} isn't set (the fixture plugin "acme-login" names it)`]);
    assert.equal(r.error.all[0].suite, "s.hafen.yml");
    assert.deepEqual(r.fixtures, []);
    assert.equal(mock.log.length, 0);
  });

  it("set, a fixture's to give, or a plugin the suite doesn't use: no problem", async () => {
    const set = await runFiles(LOGIN_FILES(), { secrets: { ACME_PASSWORD: "pw-1" } });
    assert.equal(set.verdict, "passed", JSON.stringify(set.error));
    assert.deepEqual(mock.log.map((x) => x.path), ["/login", "/json", "/json"]);
    // A provider plugin naming the cookie its fixture gives
    const given = memoryHost(LOGIN_FILES({ "plugins/acme-login.js": LOGIN.replace("\"{{secret.ACME_PASSWORD}}\"", "\"pw\""), "plugins/uses-cookie.js": "export default { kind: \"check\", name: \"uses-cookie\", version: \"1.0.0\", async check() { return { status: \"pass\", reason: \"ok\", c: \"{{secret.ACME_COOKIE}}\" }; } };\n", "s.hafen.yml": suite({ expect: "[ { type: uses-cookie } ]" }) }));
    const checked = await preflight({ suites: [await loadSuite(given, "s.hafen.yml")], host: given, options: { vars: { base_url: mock.url } } });
    checked.close();
    assert.deepEqual(checked.problems, []);
    // One the suite names but never uses
    const unused = memoryHost({ "plugins/other.js": LOGIN.replace("acme-login", "other"), "providers/p.yml": provider("/json"), "s.hafen.yml": suite({ head: "plugins: [./plugins/other.js]" }) });
    const quiet = await preflight({ suites: [await loadSuite(unused, "s.hafen.yml")], host: unused, options: { vars: { base_url: mock.url } } });
    quiet.close();
    assert.deepEqual(quiet.problems, []);
  });

  it("not checked when the secrets aren't (validate without --env-check)", async () => {
    const host = memoryHost(LOGIN_FILES());
    const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: mock.url } }, secretsFor: () => () => "(not checked)" });
    checked.close();
    assert.deepEqual(checked.problems, []);
  });
});

describe("the old ways, {{scope.NAME}} and ${env:NAME}", () => {
  const OLD = {
    "environments/stage.yml": "base_url: http://stage.example\n",
    "providers/p.yml": `${provider("/json")}headers: { x-team: "{{ scope.team }}", x-key: "\${env:KEY}" }\n`,
    "s.hafen.yml": suite({ head: "variables: { base_url: x }", expect: "[ { contains: \"{{scope.region}}\" } ]" }).replace("user: hi", "user: \"hi {{scope.base_url}}\""),
  };
  const scoped = (name) => `{{scope.${name}}} is the old way: write {{env.${name}}} (a value of the environment) or {{secret.${name}}} (a secret)`;
  const OLD_PROBLEMS = [
    `s.hafen.yml:6:26  ${scoped("base_url")}`,
    `s.hafen.yml:6:70  ${scoped("region")}`,
    "providers/p.yml:5:48  ${env:KEY} is the old way to write a secret: write {{secret.KEY}}",
    `providers/p.yml:5:21  ${scoped("team")}`,
  ];

  it("each is a problem where it's first written (the suite's, then a provider file's), saying the new way, whether the secrets are checked or not", async () => {
    for (const secretsFor of [() => () => "(not checked)", () => (name) => ({ team: "refunds", region: "eu", base_url: "x", KEY: "k" })[name]]) {
      const host = memoryHost(OLD);
      const s = await loadSuite(host, "s.hafen.yml");
      const out = await preflight({ suites: [s], host, options: { env: "stage" }, secretsFor });
      out.close();
      assert.deepEqual(at(out.problems), OLD_PROBLEMS);
      assert.deepEqual(at(s.errors), OLD_PROBLEMS, "the suite's own problems: validate and the app say them as it loads");
    }
    // None chosen: the same
    const s = await loadSuite(memoryHost(OLD), "s.hafen.yml");
    assert.deepEqual(at(problemsFor(s, {}, () => undefined, null)), OLD_PROBLEMS);
  });
});

describe("a turn the stop cut short", () => {
  it("has every check skipped, latency and status too; a turn that failed on its own still has them checked", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const expect = "[ { type: latency, max_ms: 5000 }, { type: status, equals: 200 }, { contains: \"You said\" } ]";
    const stopped = await runFiles({ "providers/p.yml": provider("/slow?ms=3000"), "s.hafen.yml": suite({ expect }) }, { signal: controller.signal });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.turns[0].error, "stopped");
    assert.deepEqual(statuses(stopped.turns[0]), [
      ["latency ≤ 5.0 s", "skipped", "the run was stopped"],
      ["status 200", "skipped", "the run was stopped"],
      ["contains You said", "skipped", "the run was stopped"],
    ]);
    assert.equal(stopped.verdict, null);
    // One that failed on its own (a 500): its latency and status are what it had
    const failed = await runFiles({ "providers/p.yml": provider("/error/500", "retries: 0\n"), "s.hafen.yml": suite({ expect }) });
    assert.deepEqual(statuses(failed.turns[0]).map(([name, status]) => [name, status]), [["latency ≤ 5.0 s", "pass"], ["status 200", "fail"], ["contains You said", "skipped"]]);
  });
});

describe("how a turn's error is said", () => {
  const turn = (config, transport, rest = {}) => executeTurn({
    provider: createProvider(typeof config === "string" ? parse(config) : config), message: "hi", scope: createScope({ layers: [{ base_url: mock.url, scenario: "cut" }] }),
    transport, spans: createSpans({ now: () => performance.now() }), now: () => performance.now(), retries: 0, ...rest,
  });

  it("a timeout in ms or s, as latency is", async () => {
    const hang = { send: (req, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) };
    assert.equal((await turn(provider("/json"), hang, { timeoutMs: 300 })).error, "timed out after 300 ms");
    assert.equal((await turn(provider("/json"), hang, { timeoutMs: 1200 })).error, "timed out after 1.2 s");
  });

  it("a stream cut off mid-reply: the response ended early, after how many chunks, and the reply so far is kept", async () => {
    const out = await turn(MOCK_SSE_PROVIDER, memoryHost().transport);
    // (how many chunks the reader saw depends on how the network grouped the mock's writes: 1 or 2)
    assert.match(out.error, /^the response ended early: the connection closed after [12] chunks? \(the reply so far is kept\)$/);
    assert.match(out.record.reply, /^This reply is going /);
    assert.equal(out.stopped, false);
    // A body cut before any of it was read; a network simulation's drop
    const cut = (chunks, extra = {}) => ({ async send() { return { status: 200, headers: { "content-type": "text/event-stream" }, body: (async function* body() { for (const c of chunks) yield new TextEncoder().encode(c); throw Object.assign(new TypeError("terminated"), extra); })() }; } });
    assert.equal((await turn(provider("/json"), cut([]))).error, "the response ended early: the connection closed before its body was all in");
    assert.equal((await turn(MOCK_SSE_PROVIDER, cut(sseChunks([{ type: "text_delta", delta: "Hello" }], { split: 100 }), { network: true }))).error, "the response ended early: the connection dropped (network simulation) after 1 chunk (the reply so far is kept)");
  });

  it("errors before the response, and the turn's own after it, are said as they were", async () => {
    const refused = { send: async () => { throw new TypeError("fetch failed"); } };
    assert.equal((await turn(provider("/json"), refused)).error, "fetch failed");
    // (a tool call the test has no result for: after the stream ended, not a cut)
    const asks = fakeTransport(() => ({ headers: { "content-type": "text/event-stream" }, chunks: sseChunks([{ type: "tool_call", id: "c1", name: "lookup_order", args: { id: 1 } }, "[DONE]"]) }));
    const out = await turn(`${MOCK_SSE_PROVIDER}done_marker: "[DONE]"\n`, asks, { tools: { other: { result: 1 } } });
    assert.match(out.error, /^The model called lookup_order, and the test has no result for it/);
  });
});

describe("a provider file outside the opened folder", () => {
  it("climbsOut: a path with more ../ than its file is deep", () => {
    assert.equal(climbsOut("s.hafen.yml", "../outside.yml"), true);
    assert.equal(climbsOut("tests/s.hafen.yml", "../providers/p.yml"), false);
    assert.equal(climbsOut("tests/s.hafen.yml", "../../p.yml"), true);
    assert.equal(climbsOut("tests/s.hafen.yml", "a/../../../p.yml"), true);
    assert.equal(climbsOut("./s.hafen.yml", "./p.yml"), false);
    assert.equal(climbsOut("s.hafen.yml", "/abs/p.yml"), false);
    assert.equal(climbsOut("../other/s.hafen.yml", "../p.yml"), false);
  });

  it("is said to be outside it, once: not as a file that doesn't exist, and not as no provider too (nor the one in the folder it would have found)", async () => {
    const host = memoryHost({ "outside.yml": provider("/json"), "s.hafen.yml": suite().replace("providers/p.yml", "../outside.yml") });
    const s = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(at(s.errors), ["s.hafen.yml:2:11  provider: the provider file ../outside.yml isn't in the opened folder (only files in it are read)"]);
    // On disk, the file there
    const root = await mkdtemp(join(tmpdir(), "hafen-outside-"));
    dirs.push(root);
    const files = { "outside.yml": provider("/json"), "proj/s.hafen.yml": suite().replace("providers/p.yml", "../outside.yml"), "proj/data.hafen.yml": suite({ test: "    data: ../rows.csv\n" }), "proj/providers/p.yml": provider("/json"), "rows.csv": "a\n1\n" };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const disk = nodeHost({ root: join(root, "proj") });
    assert.deepEqual(at((await loadSuite(disk, "s.hafen.yml")).errors), ["s.hafen.yml:2:11  provider: the provider file ../outside.yml isn't in the opened folder (only files in it are read)"]);
    assert.deepEqual((await loadSuite(disk, "data.hafen.yml")).errors.map((e) => e.message), ["the data file ../rows.csv isn't in the opened folder (only files in it are read)"]);
  });

  it("one that doesn't exist, or a name that's none: said once, no \"no provider\" after it; a test with no provider at all still is", async () => {
    const host = memoryHost({ "s.hafen.yml": suite().replace("providers/p.yml", "providers/nope.yml") });
    assert.deepEqual(at((await loadSuite(host, "s.hafen.yml")).errors), ["s.hafen.yml:2:11  provider: the provider file providers/nope.yml doesn't exist"]);
    const tests = memoryHost({ "s.hafen.yml": "version: 1\ntests:\n  - name: a\n    provider: nope\n    turns: [ { user: hi } ]\n  - name: b\n    turns: [ { user: hi } ]\n" });
    assert.deepEqual((await loadSuite(tests, "s.hafen.yml")).errors.map((e) => e.message), [
      "tests.0.provider: there's no provider named \"nope\" (the suite has none under providers), and it isn't a preset or a file",
      "no provider: set provider at the top, or on every test",
    ]);
  });

  it("a plugin a suite names outside it: the same", async () => {
    const host = memoryHost({ "plugins/p.js": "export default {};", "providers/p.yml": provider("/json"), "s.hafen.yml": suite({ head: "plugins: [../plugins/p.js]" }) });
    const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: "x" } } });
    checked.close();
    assert.deepEqual(checked.problems.map((p) => p.message), ["the plugin ../plugins/p.js isn't in the opened folder (only files in it are read)"]);
  });
});

describe("every problem has its file, line and column", () => {
  it("a provider file's fixture lists: at the fixture in its list (or the list, or the key)", async () => {
    const files = {
      "plugins/check.js": "export default { kind: \"check\", name: \"a-check\", version: \"1.0.0\", async check() { return { status: \"pass\" }; } };\n",
      "providers/p.yml": `${provider("/json")}fixtures:\n  beforeAll: [nothere]\n  before: [a-check, a-check]\n  later: [x]\n`,
      "providers/q.yml": `${provider("/json")}fixture: old\nfixtures:\n  after: [ok, 3]\n`,
      "s.hafen.yml": `${suite()}  - name: q\n    provider: providers/q.yml\n    turns: [ { user: hi } ]\n`,
    };
    const host = memoryHost(files);
    const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: "x" } } });
    checked.close();
    // (the schema's own problems with these files are there too, each with its place)
    assert.deepEqual(at(checked.problems.filter((p) => /fixture/.test(p.message) && !/unknown key|must be/.test(p.message))), [
      "providers/p.yml:7:21  fixtures.before names a-check twice: a list runs each fixture once (another list can name it too)",
      "providers/p.yml:8:10  fixtures has no list \"later\": its lists are beforeAll, before, after and afterAll",
      "providers/p.yml:6:15  the fixture \"nothere\" (fixtures.beforeAll) isn't in the folder's plugins/ or the suite's plugins",
      "providers/p.yml:7:12  the plugin \"a-check\" (fixtures.before) is a check, not a fixture",
      "providers/q.yml:5:10  a provider's fixtures are in its fixtures: map, by when they run: fixtures: { beforeAll: [acme-login] } (fixture: is no longer read)",
      "providers/q.yml:7:15  fixtures.after is a list of fixture plugins' names",
    ]);
    assert.ok(checked.problems.every((p) => p.line && p.column), at(checked.problems).join("\n"));
    assert.deepEqual(fixturesOf({ fixtures: { before: ["a", "b", "a"] } }).at, [["fixtures", "before", 2]]);
  });

  it("a provider's {{variable}} the suite doesn't set, an --env that isn't there, a plugin entry that isn't, a load test with --load", async () => {
    const files = { "providers/p.yml": "kind: http\nurl: x\nheaders: { x-who: \"{{ who }}\" }\nbody: { m: \"{{user}}\" }\n", "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n" };
    const varsHost = memoryHost(files);
    const vars = await preflight({ suites: [await loadSuite(varsHost, "s.hafen.yml")], host: varsHost });
    vars.close();
    assert.deepEqual(at(vars.problems), ["providers/p.yml:3:20  the provider uses {{who}}, which the suite doesn't set"]);
    const inline = memoryHost({ "s.hafen.yml": "version: 1\nprovider:\n  kind: http\n  url: \"x/{{nope}}\"\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n" });
    assert.deepEqual(at((await loadSuite(inline, "s.hafen.yml")).missing), ["s.hafen.yml:4:11  the provider uses {{nope}}, which the suite doesn't set"]);
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\nplugins: [./plugins/missing.js]\nenvironments:\n  local: {}\ntests:\n  - name: a\n    load: { users: 2, requests: 4, concurrency: 2 }\n    turns: [ { user: hi } ]\n" });
    const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { env: "stagnig", load: true }, secretsFor: () => () => "x" });
    checked.close();
    assert.deepEqual(at(checked.problems.filter((p) => !/load: /.test(p.message))), [
      "s.hafen.yml:5:3  there's no environment or scope \"stagnig\" (local)",
      "s.hafen.yml:3:11  the plugin ./plugins/missing.js doesn't exist",
      "s.hafen.yml:8:11  \"a\" is a load test, and load tests can't run yet (load mode isn't built): leave out --load to skip it",
    ]);
    assert.ok(checked.problems.every((p) => !("entry" in p)));
  });

  it("a fixture list written in the suite, and a provider plugin that isn't there: in the suite", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider:\n  kind: http\n  url: x\n  fixtures: { before: [nobody] }\nproviders:\n  acme: { kind: \"plugin:acme\" }\ntests:\n  - name: a\n    provider: acme\n    turns: [ { user: hi } ]\n" });
    const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host });
    checked.close();
    assert.deepEqual(at(checked.problems), [
      "s.hafen.yml:7:17  the provider plugin \"acme\" isn't in the folder's plugins/ or the suite's plugins",
      "s.hafen.yml:5:24  the fixture \"nobody\" (fixtures.before) isn't in the folder's plugins/ or the suite's plugins",
    ]);
  });
});
