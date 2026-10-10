// Fixtures (docs/plugins.md): the four lists and when each runs, what a fixture gives (a secret,
// redacted everywhere), its phases, what its run() returns, env.set, and fixtures in a conversation.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createConversation } from "../../engine/explore.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { fixturesOf } from "../../engine/fixture-lists.js";
import { loadPlugins } from "../../engine/plugins.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { casesOf, tally } from "../../engine/reports/outcome.js";
import { serializeRun } from "../../engine/reports/run-file.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { AUTH } from "../fixtures/mock-endpoint.mjs";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

const FIXTURE = ({ provides = '["ACME_COOKIE", "ACME_CSRF"]', give = "{ ACME_COOKIE: cookies.join(\"; \"), ACME_CSRF: csrf_token }" } = {}) => `export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.2.0",
  hosts: ["127.0.0.1"],
  provides: ${provides},
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: settings.user, password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status >= 400) throw new Error("login failed: " + res.status);
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token } = await res.json();
    return ${give};
  },
};
`;
const PROVIDER_PLUGIN = `export default {
  kind: "provider",
  name: "acme",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  async *send({ message, settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.url, method: "POST", headers: { cookie: "{{secret.ACME_COOKIE}}", "x-csrf-token": "{{secret.ACME_CSRF}}" }, body: { message }, signal });
    const data = await res.json();
    if (res.status >= 400) throw new Error(data.error.message);
    yield { type: "text", text: data.data.reply };
    yield { type: "done" };
  },
};
`;
const FILES = (extra = {}) => ({
  "plugins/acme-login.js": FIXTURE(),
  "plugins/acme.js": PROVIDER_PLUGIN,
  "providers/acme.yml": `kind: plugin:acme\nfixtures: { beforeAll: [acme-login] }\nurl: "{{base_url}}/auth/chat"\nlogin_url: "{{base_url}}/auth/login"\nuser: qa-bot\n`,
  // The same login, for an HTTP provider: its values as {{secret.…}}
  "providers/acme-http.yml": `kind: http\nfixtures: { beforeAll: [acme-login@^1] }\nurl: "{{base_url}}/auth/chat"\nlogin_url: "{{base_url}}/auth/login"\nuser: qa-bot\nheaders: { cookie: "{{secret.ACME_COOKIE}}", x-csrf-token: "{{secret.ACME_CSRF}}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
  "s.hafen.yml": `version: 1
provider: providers/acme.yml
environments:
  local: { base_url: "${mock.url}" }
tests:
  - name: one
    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]
  - name: two
    turns: [ { user: again, expect: [ { contains: "You said: again" } ] } ]
  - name: over http
    provider: providers/acme-http.yml
    turns: [ { user: hi, expect: [ { type: status, equals: 200 }, { contains: "You said: hi" } ] } ]
`,
  ...extra,
});
const SECRETS = { ACME_PASSWORD: AUTH.password };

async function runWith(files, secrets = SECRETS) {
  const host = memoryHost(files);
  host.secrets = (name) => secrets[name];
  const suite = await loadSuite(host, "s.hafen.yml");
  return { run: await runSuites({ suites: [suite], host }), suite };
}
const logins = () => mock.log.filter((x) => x.path === "/auth/login");
const chats = () => mock.log.filter((x) => x.path === "/auth/chat");

// A pretend port, as serve-port.test.js has
function connect(makeHost) {
  let handler;
  const waiting = new Map();
  let next = 1;
  servePort({ receive: (h) => { handler = h; }, send: (m) => { if (m.id) waiting.get(m.id)?.(m); } }, makeHost);
  return (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
}

describe("fixtures", () => {
  it("log in once for the run, before the first request; a provider plugin and an HTTP provider use what it gave; all of it redacted", async () => {
    mock.reset();
    const { run, suite } = await runWith(FILES());
    assert.deepEqual(suite.missing, []);
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "passed", JSON.stringify(run.tests.map((t) => [t.name, t.status, t.instances[0]?.results])));
    // Once, though two providers and three tests use it; the password filled into the body by the engine
    assert.equal(logins().length, 1);
    assert.deepEqual(logins()[0].body, { user: "qa-bot", password: AUTH.password });
    // Every chat with both cookies and the CSRF token
    assert.equal(chats().length, 3);
    for (const c of chats()) {
      assert.equal(c.headers.cookie, `sid=${AUTH.sid}; region=eu`);
      assert.equal(c.headers["x-csrf-token"], AUTH.csrf);
    }
    // On the timeline, under the suite, before the tests; the names it gave, not their values
    const span = run.spans.find((s) => s.kind === "fixture");
    assert.equal(span.name, "acme-login · beforeAll");
    assert.equal(span.status, "ok");
    assert.deepEqual(span.metrics.provides, ["ACME_COOKIE", "ACME_CSRF"]);
    assert.equal(run.spans.find((s) => s._id === span.parent).kind, "suite");
    const text = JSON.stringify(run);
    for (const secret of [AUTH.sid, AUTH.csrf, AUTH.password]) assert.ok(!text.includes(secret), `${secret} is redacted from the run`);
  });

  it("a fixture that fails is a setup error for the suite, and nothing else is sent", async () => {
    mock.reset();
    const wrong = (await runWith(FILES(), { ACME_PASSWORD: "not-it" })).run;
    assert.equal(wrong.status, "error");
    assert.match(wrong.error.message, /s\.hafen\.yml: the fixture "acme-login" \(beforeAll\) failed: login failed: 401/);
    assert.equal(logins().length, 1);
    assert.equal(chats().length, 0);
    assert.equal(wrong.spans.find((s) => s.kind === "fixture").status, "error");
  });

  it("it gives every name it provides, and no other", async () => {
    mock.reset();
    const short = (await runWith(FILES({ "plugins/acme-login.js": FIXTURE({ give: "{ ACME_COOKIE: cookies.join(\"; \") }" }) }))).run;
    assert.match(short.error.message, /the fixture "acme-login" \(beforeAll\) failed: it didn't give ACME_CSRF/);
    const extra = (await runWith(FILES({ "plugins/acme-login.js": FIXTURE({ give: "{ ACME_COOKIE: \"a\", ACME_CSRF: \"b\", OTHER: \"c\" }" }) }))).run;
    assert.match(extra.error.message, /it gave OTHER, which isn't in its provides/);
    assert.equal(chats().length, 0);
  });

  it("a fixture that isn't there, isn't a fixture, or isn't the version asked for: a setup error before anything's sent", async () => {
    mock.reset();
    const missing = (await runWith(FILES({ "providers/acme.yml": "kind: plugin:acme\nfixtures: { beforeAll: [nope] }\nurl: x\n" }))).run;
    assert.equal(missing.status, "error");
    assert.match(missing.error.message, /the fixture "nope" \(fixtures\.beforeAll\) isn't in the folder's plugins/);
    const notFixture = (await runWith(FILES({ "providers/acme.yml": "kind: plugin:acme\nfixtures: { beforeAll: [acme] }\nurl: x\n" }))).run;
    assert.match(notFixture.error.message, /the plugin "acme" \(fixtures\.beforeAll\) is a provider, not a fixture/);
    const version = (await runWith(FILES({ "providers/acme-http.yml": "kind: http\nfixtures: { beforeAll: [acme-login@^2] }\nurl: x\n" }))).run;
    assert.match(version.error.message, /the fixture "acme-login" is version 1\.2\.0, not \^2/);
    assert.equal(mock.log.length, 0);
  });

  it("a name it provides counts as set before the run; one nothing sets is still a problem", async () => {
    mock.reset();
    const files = FILES({ "providers/acme-http.yml": `kind: http\nfixtures: { beforeAll: [acme-login] }\nurl: "{{base_url}}/auth/chat"\nheaders: { cookie: "{{secret.ACME_COOKIE}}", x-other: "{{secret.NOT_SET}}" }\nbody: { message: "{{user}}" }\n` });
    const { run } = await runWith(files);
    assert.equal(run.status, "error");
    assert.deepEqual(run.error.all.map((p) => p.message), ['{{secret.NOT_SET}} isn\'t set for the scope "local"']);
    assert.equal(mock.log.length, 0);
  });

  it("in a conversation: it logs in before the first message, once, and again after it failed", async () => {
    const host = memoryHost(FILES());
    let password = "not-yet";
    host.secrets = (name) => (name === "ACME_PASSWORD" ? password : undefined);
    const call = connect(async () => host);
    await call("open", {});
    mock.reset();
    const failed = await call("send", { token: "c", providerFile: "providers/acme.yml", suiteFile: "s.hafen.yml", message: "hello" });
    assert.match(failed.record.error, /the fixture "acme-login" \(beforeAll\) failed: login failed: 401/);
    assert.equal(chats().length, 0);
    password = AUTH.password;
    const first = await call("send", { token: "c", providerFile: "providers/acme.yml", suiteFile: "s.hafen.yml", message: "hello" });
    assert.equal(first.record.reply, "You said: hello");
    const second = await call("send", { token: "c", providerFile: "providers/acme.yml", suiteFile: "s.hafen.yml", message: "again" });
    assert.equal(second.record.reply, "You said: again");
    assert.equal(logins().length, 2, "the failed login, then one that worked");
    assert.equal(chats().length, 2);
    assert.equal(second.run.spans.filter((s) => s.kind === "fixture").length, 2);
    const text = JSON.stringify(second);
    for (const secret of [AUTH.sid, AUTH.csrf, AUTH.password]) assert.ok(!text.includes(secret), `${secret} is redacted from the conversation`);
    // (let go, as the app does: its plugins' workers close)
    await call("reset", { token: "c" });
  });
});

describe("fixtures' lists: beforeAll, before, after, afterAll", () => {
  // A fixture that says when it ran (a POST to the mock's /fixture-log, which the mock logs), and gives
  // its names' values (each saying who gave it, when, for which test)
  const fixture = (name, { provides = [], fail = "" } = {}) => `export default {
  kind: "fixture",
  name: "${name}",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ${JSON.stringify(provides)},
  async run({ phase, settings, test, signal, transport }) {
    const at = test ? " " + test.name + " " + test.repeat + (test.status ? " " + test.status : "") : "";
    await transport.fetch({ url: settings.log_url, method: "POST", body: { said: "${name} " + phase + at }, signal });
    if (${JSON.stringify(fail)} && (test?.name === ${JSON.stringify(fail)} || ${JSON.stringify(fail)} === "*")) throw new Error("${name} broke");
    return { ${provides.map((p) => `${p}: "${name}-" + phase + (test ? "-" + test.name + "-" + test.repeat : "")`).join(", ")} };
  },
};
`;
  const PROVIDER = (lists = "{ beforeAll: [login, warm], before: [session], after: [cleanup], afterAll: [logout] }") => `kind: http
fixtures: ${lists}
url: "{{base_url}}/json"
log_url: "{{base_url}}/fixture-log"
headers: { x-run: "{{secret.RUN_TOKEN}}", x-test: "{{secret.TEST_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const SUITE = () => `version: 1
provider: providers/p.yml
environments:
  local: { base_url: "${mock.url}" }
tests:
  - name: a
    repeat: 2
    turns: [ { user: hello, expect: [ { contains: "You said" } ] } ]
  - name: b
    turns: [ { user: hello, expect: [ { contains: "not said" } ] } ]
`;
  const files = (over = {}) => ({
    "plugins/login.js": fixture("login", { provides: ["RUN_TOKEN"] }),
    "plugins/warm.js": fixture("warm"),
    "plugins/session.js": fixture("session", { provides: ["TEST_TOKEN"] }),
    "plugins/cleanup.js": fixture("cleanup"),
    "plugins/logout.js": fixture("logout"),
    "providers/p.yml": PROVIDER(),
    "s.hafen.yml": SUITE(),
    ...over,
  });
  const said = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body.said);
  const chats = () => mock.log.filter((x) => x.path === "/json");

  it("a list names each fixture once: twice (with a range or without) stops the run before anything is sent; another list can name it", async () => {
    const read = fixturesOf({ fixtures: { beforeAll: ["login", "warm", "login@^1"], before: ["session"], after: ["cleanup", "session", "cleanup", "cleanup"] } });
    assert.deepEqual(read.problems, [
      "fixtures.beforeAll names login twice: a list runs each fixture once (another list can name it too)",
      "fixtures.after names cleanup twice: a list runs each fixture once (another list can name it too)",
    ]);
    assert.deepEqual(read.duplicates.map((d) => [d.phase, d.name]), [["beforeAll", "login"], ["after", "cleanup"]]);
    // (the lists are still read, as written)
    assert.deepEqual(read.beforeAll.map((r) => r.entry), ["login", "warm", "login@^1"]);
    mock.reset();
    const { run } = await runWith(files({ "providers/p.yml": PROVIDER("{ beforeAll: [login, warm, login@^1], before: [session], after: [cleanup, session], afterAll: [logout] }") }));
    assert.equal(run.status, "error");
    assert.match(run.error.message, /fixtures\.beforeAll names login twice/);
    assert.equal(run.error.all.length, 1, "session in before and after is fine");
    assert.deepEqual(said(), []);
    assert.deepEqual(chats(), []);
  });

  it("each list in its order: beforeAll once, before and after around every test (each run), afterAll at the end", async () => {
    mock.reset();
    const { run } = await runWith(files());
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "failed", "b's check fails (by design): its after fixture still runs");
    assert.deepEqual(said(), [
      "login beforeAll", "warm beforeAll",
      "session before a 1", "cleanup after a 1 passed",
      "session before a 2", "cleanup after a 2 passed",
      "session before b 1", "cleanup after b 1 failed",
      "logout afterAll",
    ]);
    // beforeAll's value for the run; before's for each test's run
    assert.deepEqual(chats().map((x) => [x.headers["x-run"], x.headers["x-test"]]), [
      ["login-beforeAll", "session-before-a-1"], ["login-beforeAll", "session-before-a-2"], ["login-beforeAll", "session-before-b-1"],
    ]);
    // Recorded, in order, with what they gave (names, not values)
    assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.test?.name ?? null, f.status, f.provides, f.calls]), [
      ["login", "beforeAll", null, "ok", ["RUN_TOKEN"], 1], ["warm", "beforeAll", null, "ok", [], 1],
      ["session", "before", "a", "ok", ["TEST_TOKEN"], 1], ["cleanup", "after", "a", "ok", [], 1],
      ["session", "before", "a", "ok", ["TEST_TOKEN"], 1], ["cleanup", "after", "a", "ok", [], 1],
      ["session", "before", "b", "ok", ["TEST_TOKEN"], 1], ["cleanup", "after", "b", "ok", [], 1],
      ["logout", "afterAll", null, "ok", [], 1],
    ]);
    assert.equal(run.fixtures[0].provider, "providers/p.yml");
    assert.deepEqual(run.summary.fixtures, { total: 9, failed: 0 });
    // As steps: beforeAll under the suite, before and after under each run of a test, afterAll under the run; each with its call
    const parentKind = (s) => run.spans.find((p) => p._id === s.parent)?.kind;
    const steps = run.spans.filter((s) => s.kind === "fixture");
    assert.deepEqual(steps.map((s) => [s.name, parentKind(s)]), [
      ["login · beforeAll", "suite"], ["warm · beforeAll", "suite"],
      ["session · before", "repeat"], ["cleanup · after", "repeat"], ["session · before", "repeat"], ["cleanup · after", "repeat"],
      ["session · before", "repeat"], ["cleanup · after", "repeat"], ["logout · afterAll", "run"],
    ]);
    const call = run.spans.find((s) => s.kind === "call" && s.parent === steps[0]._id);
    assert.equal(call.name, `POST ${new URL(mock.url).host}/fixture-log`);
    assert.equal(call.plugin, "fixture login");
    assert.equal(call.request.body, JSON.stringify({ said: "login beforeAll" }));
    assert.equal(call.response.status, 404);
    // Every value redacted
    const text = JSON.stringify(run);
    for (const v of ["login-beforeAll", "session-before-a-1", "session-before-b-1"]) assert.ok(!text.includes(v), `${v} is redacted`);
  });

  it("a before that fails: that test is an error (no setup, no turns sent), its after still runs, and the others go on", async () => {
    mock.reset();
    const { run } = await runWith(files({ "plugins/session.js": fixture("session", { provides: ["TEST_TOKEN"], fail: "b" }) }));
    const b = run.tests.find((t) => t.name === "b");
    assert.equal(b.status, "error");
    assert.match(b.instances[0].reason, /the fixture "session" \(before\) failed: session broke/);
    assert.equal(run.tests.find((t) => t.name === "a").status, "passed");
    assert.deepEqual(said().slice(-3), ["session before b 1", "cleanup after b 1 error", "logout afterAll"]);
    assert.equal(chats().length, 2, "b sent nothing");
  });

  it("an after or afterAll that fails changes no result: it's recorded (and said), as a teardown step's would be", async () => {
    mock.reset();
    const { run } = await runWith(files({
      "plugins/cleanup.js": fixture("cleanup", { fail: "a" }), "plugins/logout.js": fixture("logout", { fail: "*" }),
      "s.hafen.yml": SUITE().replace(/  - name: b[\s\S]*$/, ""),
    }));
    assert.equal(run.verdict, "passed");
    assert.deepEqual(run.tests[0].instances.map((i) => i.after_errors), [
      ['the fixture "cleanup" (after) failed: cleanup broke'], ['the fixture "cleanup" (after) failed: cleanup broke'],
    ]);
    assert.deepEqual(run.fixtures.filter((f) => f.status === "error").map((f) => [f.name, f.phase, f.error]), [
      ["cleanup", "after", "cleanup broke"], ["cleanup", "after", "cleanup broke"], ["logout", "afterAll", "logout broke"],
    ]);
    assert.deepEqual(run.summary.fixtures, { total: 7, failed: 3 });
  });

  it("a list that isn't one of the four is a problem: a setup error before anything's sent", async () => {
    mock.reset();
    const odd = (await runWith(files({ "providers/p.yml": PROVIDER("{ beforeEach: [login] }") }))).run;
    assert.equal(odd.status, "error");
    assert.match(odd.error.all.map((p) => p.message).join("\n"), /beforeEach/);
    assert.equal(mock.log.length, 0);
  });

  it("the reports say which ran, when, and how: Markdown, JSON (with every call) and JUnit", async () => {
    mock.reset();
    const { run } = await runWith(files());
    const { markdown, jsonSummary, junit } = await import("../../engine/index.js");
    const md = markdown(run);
    assert.match(md, /### Fixtures/);
    assert.match(md, /\| ✓ \| login \| beforeAll \| providers\/p\.yml \|  \| [\d.]+ s \| 1 \| gave RUN_TOKEN \|/);
    assert.match(md, /\| ✓ \| cleanup \| after \| providers\/p\.yml \| a · run 2 \|/);
    const json = JSON.parse(jsonSummary(run));
    assert.equal(json.fixtures.length, 9);
    assert.deepEqual(json.calls.map((c) => [c.plugin, c.in]).slice(0, 2), [["fixture login", "login · beforeAll"], ["fixture warm", "warm · beforeAll"]]);
    const xml = junit(run);
    assert.match(xml, /<system-out>[^<]*fixture login \(beforeAll\) · providers\/p\.yml · ok/);
    assert.match(xml, /fixture session \(before\) · providers\/p\.yml · a · ok/);
  });

  it("in a conversation: beforeAll and before before the first message, after and afterAll when it's let go", async () => {
    const host = memoryHost(files());
    host.secrets = () => undefined;
    const call = connect(async () => host);
    await call("open", {});
    mock.reset();
    await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "one" });
    await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "two" });
    assert.deepEqual(said(), ["login beforeAll", "warm beforeAll", "session before"]);
    assert.deepEqual(chats().map((x) => x.headers["x-test"]), ["session-before", "session-before"]);
    await call("reset", { token: "c" });
    assert.deepEqual(said().slice(3), ["cleanup after", "logout afterAll"]);
  });

  // Its plugins were loaded with its first message, for the provider as it was then: one with no
  // fixtures had none, and a fixture added later "isn't in the folder's plugins/"
  it("in a conversation: fixtures added to its provider after the first message run with the next one; one that isn't there is said before anything is sent", async () => {
    const host = memoryHost(files({ "providers/p.yml": PROVIDER().replace(/^fixtures: .*\n/m, "") }));
    host.secrets = (name) => ({ RUN_TOKEN: "from-env", TEST_TOKEN: "from-env" })[name];
    const call = connect(async () => host);
    await call("open", {});
    mock.reset();
    await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "one" });
    assert.deepEqual(said(), []);
    // The Fixtures editor adds two to the provider's file
    await host.files.write("providers/p.yml", PROVIDER("{ beforeAll: [login], before: [session] }"));
    const two = await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "two" });
    assert.equal(two.record.error, undefined, two.record.error);
    assert.equal(two.record.reply, "You said: two");
    assert.deepEqual(said(), ["login beforeAll", "session before"]);
    assert.equal(chats()[1].headers["x-run"], "login-beforeAll", "what it gave is used");
    // A name no plugin has: the problem a run would say, and nothing sent
    await host.files.write("providers/p.yml", PROVIDER("{ beforeAll: [login, nobody] }"));
    await assert.rejects(call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "three" }), /the fixture "nobody" \(fixtures\.beforeAll\) isn't in the folder's plugins\//);
    assert.equal(chats().length, 2);
    await call("reset", { token: "c" });
  });
});

describe("a provider's afterAll fixtures run however the run ends (docs/plugins.md, Fixtures)", () => {
  const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

  async function runFiles(files, { options = {}, secrets = {}, signal, onEvent } = {}) {
    const host = memoryHost({ "providers/json.yml": JSON_PROVIDER, ...files }, { secrets });
    const suites = [];
    for (const file of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) {
      const suite = await loadSuite(host, file);
      assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
      suites.push(suite);
    }
    return runSuites({ suites, host, options: { vars: { base_url: mock.url }, ...options }, signal, onEvent });
  }

  const fixture = (name, { provides = [], fail = false } = {}) => `export default {
  kind: "fixture", name: "${name}", version: "1.0.0", hosts: ["127.0.0.1"], provides: ${JSON.stringify(provides)},
  async run({ phase, settings, transport, signal }) {
    await transport.fetch({ url: settings.log_url, method: "POST", body: { message: "${name} " + phase }, signal });
    if (${fail}) throw new Error("${name} broke");
    return { ${provides.map((p) => `${p}: "v-${name}-1234"`).join(", ")} };
  },
};
`;
  const provider = (lists) => `kind: http
fixtures: ${lists}
url: "{{base_url}}/slow?ms=150"
log_url: "{{base_url}}/fixture-log"
headers: { x-token: "{{secret.TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const suite = (n = 3) => `version: 1\nprovider: providers/p.yml\ntests:\n${Array.from({ length: n }, (_, k) => `  - name: t${k}\n    turns: [ { user: "chat ${k}" } ]\n`).join("")}`;
  const files = (over = {}) => ({
    "plugins/login.js": fixture("login", { provides: ["TOKEN"] }),
    "plugins/logout.js": fixture("logout"),
    "providers/p.yml": provider("{ beforeAll: [login], afterAll: [logout] }"),
    "s.hafen.yml": suite(),
    ...over,
  });
  const said = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body.message);
  const chats = () => mock.log.filter((x) => x.path === "/slow");

  it("a beforeAll that fails: the suite is a setup error, nothing of it is sent, and the afterAll logout is still sent", async () => {
    const run = await runFiles(files({ "plugins/login.js": fixture("login", { provides: ["TOKEN"], fail: true }) }));
    assert.equal(run.status, "error");
    assert.match(run.error.message, /the fixture "login" \(beforeAll\) failed: login broke/);
    assert.deepEqual(said(), ["login beforeAll", "logout afterAll"]);
    assert.equal(chats().length, 0);
    assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status]), [["login", "beforeAll", "error"], ["logout", "afterAll", "ok"]]);
  });

  it("a run stopped part way (cancelled): its afterAll still runs, after what was sent", async () => {
    const controller = new AbortController();
    const run = await runFiles(files(), { signal: controller.signal, onEvent: (e) => { if (e.type === "test:end") controller.abort(); } });
    assert.equal(run.status, "stopped");
    assert.ok(chats().length < 3, `${chats().length} chats`);
    assert.deepEqual(said(), ["login beforeAll", "logout afterAll"]);
  });

  it("two suites of one scope: beforeAll once at the start, afterAll once at the end", async () => {
    const run = await runFiles(files({ "t.hafen.yml": suite(1).replace("t0", "u0") }));
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.deepEqual(said(), ["login beforeAll", "logout afterAll"]);
    assert.equal(chats().length, 4);
    assert.ok(chats().every((c) => c.headers["x-token"] === "v-login-1234"));
    assert.ok(!JSON.stringify(run).includes("v-login-1234"), "what it gave is redacted");
  });
});

describe("a fixture's values, redacted", () => {
  const TOKEN = "tok_mock_123";
  // A login that gives its token with its scheme; then (to show a call after the login is held back
  // too) a call that sends the token it got, in a header it builds itself
  const BEARER = `export default {
  kind: "fixture",
  name: "login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["AUTH"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa" }, signal });
    const { access_token } = await res.json();
    await transport.fetch({ url: settings.login_url.replace("/login", "/json"), method: "POST", headers: { "x-token": access_token }, body: { message: "hi " + access_token }, signal });
    return { AUTH: \`Bearer \${access_token}\` };
  },
};
`;
  // The mock's /auth/login: two cookies, and a CSRF token given with a scheme
  const CSRF = `export default {
  kind: "fixture",
  name: "login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["ACME_COOKIE", "ACME_CSRF"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url.replace("/login", "/auth/login"), method: "POST", body: { user: "qa", password: "{{secret.ACME_PASSWORD}}" }, signal });
    const cookies = [res.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]);
    const { csrf_token } = await res.json();
    return { ACME_COOKIE: cookies.join("; "), ACME_CSRF: \`Token \${csrf_token}\` };
  },
};
`;
  // (headers that aren't secret headers by name: only the fixture's values make them secret)
  const PROVIDER = `kind: http
fixtures: { beforeAll: [login] }
url: "${"{{base_url}}"}/json"
login_url: "${"{{base_url}}"}/login"
headers: { x-auth: "{{secret.AUTH}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const files = (plugin, provider = PROVIDER) => ({
    "plugins/login.js": plugin,
    "providers/p.yml": provider,
    "s.hafen.yml": `version: 1
provider: providers/p.yml
environments:
  local: { base_url: "${mock.url}" }
tests:
  - name: t
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`,
  });

  async function run(plugin, provider, secrets = {}) {
    const host = memoryHost(files(plugin, provider));
    host.secrets = (name) => secrets[name];
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    const events = [];
    const out = await runSuites({ suites: [suite], host, onEvent: (e) => events.push(e) });
    assert.equal(out.verdict, "passed", JSON.stringify(out.error ?? out.turns.map((t) => [t.error, t.results])));
    return { run: out, events };
  }
  // Every place the run shows: its file, its events, each report
  const everywhere = ({ run, events }) => ({ run: serializeRun(run), events: JSON.stringify(events), json: jsonSummary(run), markdown: markdown(run), junit: junit(run) });
  const nowhere = (secret, shown) => {
    for (const [where, text] of Object.entries(shown)) assert.ok(!text.includes(secret), `${secret} shows in the ${where}`);
  };

  it("Bearer <token>: the token in its login's answer, in a call it made with it, and everywhere else", async () => {
    mock.reset();
    const out = await run(BEARER);
    // It was given, and sent
    assert.equal(mock.log.find((x) => x.path === "/json" && x.headers["x-auth"])?.headers["x-auth"], `Bearer ${TOKEN}`);
    nowhere(TOKEN, everywhere(out));
    // On the login's step: its answer, the token hidden in it
    const [login, again] = out.run.spans.filter((s) => s.kind === "call");
    assert.equal(login.response.body, '{"access_token":"[redacted]"}');
    assert.equal(again.request.headers["x-token"], "[redacted]");
    assert.match(again.request.body, /"hi \[redacted\]"/);
  });

  it("no event shows a fixture's call before what it gives is known: its steps get their request and response after", async () => {
    mock.reset();
    const { events } = await run(BEARER);
    const fixtureEnd = events.findIndex((e) => e.type === "fixture:end");
    const calls = events.filter((e, i) => i < fixtureEnd && e.type === "span" && e.span.kind === "call");
    // (as each call ends, its status: the CLI's --verbose line)
    assert.ok(calls.some((e) => e.action === "end" && e.span.response?.status === 200 && e.span.request === undefined && e.span.response.body === undefined));
    const shown = calls.filter((e) => e.span.request);
    assert.equal(shown.length, 2);
    for (const e of shown) assert.ok(!JSON.stringify(e).includes(TOKEN));
  });

  it("the mock's /auth/login: its cookies and the CSRF token given as `Token <csrf>`", async () => {
    mock.reset();
    const provider = PROVIDER.replace('headers: { x-auth: "{{secret.AUTH}}" }', 'headers: { x-session: "{{secret.ACME_COOKIE}}", x-csrf: "{{secret.ACME_CSRF}}" }');
    const out = await run(CSRF, provider, { ACME_PASSWORD: AUTH.password });
    assert.equal(mock.log.find((x) => x.path === "/json")?.headers["x-csrf"], `Token ${AUTH.csrf}`);
    for (const secret of [AUTH.csrf, AUTH.sid, AUTH.password]) nowhere(secret, everywhere(out));
    const login = out.run.spans.find((s) => s.kind === "call");
    assert.equal(login.response.body, '{"csrf_token":"[redacted]"}');
  });

  it("a conversation (Try it): its record and events the same", async () => {
    mock.reset();
    const host = memoryHost(files(BEARER));
    const loaded = await loadPlugins(host, ["plugins/login.js"], null, { secrets: () => undefined, transport: host.transport });
    const events = [];
    const c = createConversation({
      host, providerFile: "providers/p.yml", plugins: loaded.plugins, onEvent: (e) => events.push(e), environment: { base_url: mock.url },
      providerConfig: { kind: "http", fixtures: { beforeAll: ["login"] }, url: "{{base_url}}/json", login_url: "{{base_url}}/login", headers: { "x-auth": "{{secret.AUTH}}" }, body: { message: "{{user}}" }, response: { text: "$.data.reply" } },
    });
    const { record, run: conversation } = await c.send("hi");
    assert.equal(record.reply, "You said: hi");
    await c.close();
    loaded.close();
    nowhere(TOKEN, { run: JSON.stringify(conversation), events: JSON.stringify(events) });
  });
});

describe("phases, what run() returns, and env.set", () => {
  // A fixture that tells the mock what it saw (its phase, the test and its status, the env as it was
  // given), then does `body` (its run()'s own lines: what it sets, what it returns)
  const fixture = (name, { phases, sets, provides, body = "" } = {}) => `let calls = 0;
export default {
  kind: "fixture",
  name: "${name}",
  version: "1.0.0",
  hosts: ["127.0.0.1"],${phases ? `\n  phases: ${JSON.stringify(phases)},` : ""}${sets ? `\n  sets: ${JSON.stringify(sets)},` : ""}${provides ? `\n  provides: ${JSON.stringify(provides)},` : ""}
  async run({ phase, settings, env, test, signal, transport }) {
    calls += 1;
    const at = test ? " " + test.name + " " + test.repeat + (test.status ? " " + test.status : "") : "";
    await transport.fetch({ url: settings.log_url, method: "POST", body: { said: "${name} " + phase + at, env: { ...env } }, signal });
    ${body}
  },
};
`;
  const PROVIDER = (lists, url = "{{env.base_url}}/json") => `kind: http
fixtures: ${lists}
url: "${url}"
log_url: "{{env.base_url}}/fixture-log"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const SUITE = (tests = `  - name: a
    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]
  - name: b
    turns: [ { user: again, expect: [ { contains: "You said: again" } ] } ]
`, env = "") => `version: 1
name: S
provider: providers/p.yml
environments:
  local: { base_url: "${mock.url}"${env} }
tests:
${tests}`;

  async function runWith(files, { options = {}, suites = ["s.hafen.yml"], host = memoryHost(files) } = {}) {
    host.secrets = () => undefined;
    const loaded = [];
    for (const file of suites) loaded.push(await loadSuite(host, file));
    return { run: await runSuites({ suites: loaded, host, options }), host };
  }
  const fixtureLog = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body);
  const said = () => fixtureLog().map((b) => b.said);
  const chats = () => mock.log.filter((x) => x.path === "/json");

  describe("a fixture's phases", () => {
    it("it runs only in the lists its phases name, with no check of its phase in run(); a provider may list it in each", async () => {
      const { run } = await runWith({
        "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"] }),
        "plugins/audit.js": fixture("audit", { phases: ["after"] }),
        "providers/p.yml": PROVIDER("{ beforeAll: [gate], after: [audit], afterAll: [gate] }"),
        "s.hafen.yml": SUITE(),
      });
      assert.equal(run.status, "done", JSON.stringify(run.error));
      assert.equal(run.verdict, "passed");
      assert.deepEqual(said(), ["gate beforeAll", "audit after a 1 passed", "audit after b 1 passed", "gate afterAll"]);
    });

    it("a provider naming it in a list it isn't for: a problem at that name in the provider's file, before anything is sent (a run, validate, a conversation)", async () => {
      const files = {
        "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"] }),
        "providers/p.yml": PROVIDER("{ beforeAll: [gate], after: [gate] }"),
        "s.hafen.yml": SUITE(),
      };
      const { run, host } = await runWith(files);
      assert.equal(run.status, "error");
      assert.deepEqual(run.error.all.map((p) => [p.file, p.line, p.column, p.message]), [
        ["providers/p.yml", 2, 40, 'the fixture "gate" runs only in beforeAll and afterAll: it can\'t be in fixtures.after'],
      ]);
      assert.equal(mock.log.length, 0, "nothing was sent");
      const call = connect(async () => host);
      await call("open", {});
      await assert.rejects(call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "hi" }), /the fixture "gate" runs only in beforeAll and afterAll: it can't be in fixtures\.after/);
      assert.equal(mock.log.length, 0);
    });

    it("phases that aren't a list of the four: the plugin doesn't load, saying why", async () => {
      const host = memoryHost({
        "plugins/a.js": fixture("a", { phases: ["beforeEach"] }),
        "plugins/b.js": fixture("b", { phases: [] }),
        "plugins/c.js": fixture("c").replace('hosts: ["127.0.0.1"],', 'hosts: ["127.0.0.1"], phases: "beforeAll",'),
        "plugins/d.js": fixture("d", { phases: ["before", "before", "beforeAll"] }),
      });
      const loaded = await loadPlugins(host, ["plugins/a.js", "plugins/b.js", "plugins/c.js", "plugins/d.js"]);
      assert.deepEqual(loaded.problems.map((p) => p.message), [
        'the plugin plugins/a.js can\'t be loaded: its phases is a list of when it runs: any of beforeAll, before, after, afterAll, and "beforeEach" isn\'t one',
        'the plugin plugins/b.js can\'t be loaded: its phases is a list of when it runs: any of beforeAll, before, after, afterAll (phases: ["beforeAll", "afterAll"])',
        'the plugin plugins/c.js can\'t be loaded: its phases is a list of when it runs: any of beforeAll, before, after, afterAll (phases: ["beforeAll", "afterAll"])',
      ]);
      // (each once, in the lists' order)
      assert.deepEqual(loaded.plugins.d.meta.phases, ["beforeAll", "before"]);
      loaded.close();
    });

    it("the app's lists say each fixture's phases (all four when it doesn't say) and the environment's names it sets", async () => {
      const host = memoryHost({
        "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"], body: 'env.set("chat_path", "json");' }),
        "plugins/any.js": fixture("any", { sets: ["region"], body: 'const n = "reg" + "ion"; env.set(n, "eu");' }),
        "plugins/polite.js": 'export default { kind: "check", name: "polite", version: "1.0.0", async check() { return { status: "pass", reason: "" }; } };\n',
        "s.hafen.yml": SUITE(),
        "providers/p.yml": PROVIDER("{ beforeAll: [gate] }"),
      });
      const call = connect(async () => host);
      const opened = await call("open", {});
      assert.deepEqual(opened.plugins.map((p) => [p.name, p.phases, p.sets]), [
        ["any", ["beforeAll", "before", "after", "afterAll"], ["region"]],
        ["gate", ["beforeAll", "afterAll"], ["chat_path"]],
        ["polite", undefined, undefined],
      ]);
      const listed = await call("plugins", {});
      assert.deepEqual(listed.map((p) => [p.meta.name, p.meta.phases, p.meta.sets]), [
        ["any", ["beforeAll", "before", "after", "afterAll"], ["region"]],
        ["gate", ["beforeAll", "afterAll"], ["chat_path"]],
        ["polite", undefined, undefined],
      ]);
    });
  });

  describe("what a fixture's run() returns", () => {
    it("false in beforeAll: the run stops before the provider's tests are sent, each skipped saying why; the lists after it don't run, afterAll does; the reports say so", async () => {
      const files = {
        "plugins/warm.js": fixture("warm"),
        "plugins/gate.js": fixture("gate", { body: "return false;" }),
        "plugins/later.js": fixture("later"),
        "plugins/logout.js": fixture("logout"),
        "providers/p.yml": PROVIDER("{ beforeAll: [warm, gate, later], before: [later], afterAll: [logout] }"),
        "s.hafen.yml": SUITE(),
        "t.hafen.yml": SUITE().replace("name: S", "name: T"),
      };
      const { run } = await runWith(files, { suites: ["s.hafen.yml", "t.hafen.yml"] });
      const why = 'the fixture "gate" (beforeAll) said to stop';
      assert.equal(run.status, "stopped");
      assert.equal(run.stopped, why);
      assert.equal(run.verdict, null);
      assert.deepEqual(run.tests.map((t) => [t.suite, t.name, t.status, t.reason]), [["s.hafen.yml", "a", "skipped", why], ["s.hafen.yml", "b", "skipped", why]]);
      assert.deepEqual(said(), ["warm beforeAll", "gate beforeAll", "logout afterAll"]);
      assert.equal(chats().length, 0);
      assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status, f.stop ?? false]), [["warm", "beforeAll", "ok", false], ["gate", "beforeAll", "ok", true], ["logout", "afterAll", "ok", false]]);
      assert.equal(run.spans.find((s) => s.kind === "suite").status, "skipped");
      assert.deepEqual(run.spans.find((s) => s.name === "gate · beforeAll").metrics.stop, true);
      // Each report: the tests skipped, why; the suite the run never reached, not run
      const cases = casesOf(run);
      assert.deepEqual(cases.map((c) => [c.suiteName, c.name, c.status, c.reason]), [
        ["S", "a", "skipped", why], ["S", "b", "skipped", why], ["T", "(not run)", "skipped", `not run: ${why}`],
      ]);
      assert.deepEqual(tally(run, cases), { passed: 0, failed: 0, unsure: 0, error: 0, skipped: 3, stopped: 0, total: 3 });
      const xml = junit(run);
      assert.equal(xml.match(/<skipped message="the fixture &quot;gate&quot; \(beforeAll\) said to stop"\/>/g).length, 2);
      assert.match(xml, /fixture gate \(beforeAll\) · providers\/p\.yml · ok · [\d.]+ s · said to stop · 1 call/);
      assert.match(markdown(run), /- \*\*S › a\*\* · the fixture "gate" \(beforeAll\) said to stop/);
      assert.match(markdown(run), /\| ✓ \| gate \| beforeAll \| providers\/p\.yml \|  \| [\d.]+ s \| 1 \| said to stop \|/);
      assert.equal(JSON.parse(jsonSummary(run)).fixtures.find((f) => f.name === "gate").stop, true);
    });

    it("false in before: that run (or row) is stopped saying why (no setup, no turns), its after fixtures still run, and the others go on", async () => {
      const { run } = await runWith({
        "plugins/session.js": fixture("session", { body: 'if (test.name === "b" || test.repeat === 2) return false;' }),
        "plugins/cleanup.js": fixture("cleanup"),
        "providers/p.yml": PROVIDER("{ before: [session], after: [cleanup] }"),
        "s.hafen.yml": SUITE(`  - name: a
    repeat: 2
    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]
  - name: b
    setup: [ { request: { url: "${mock.url}/json", body: { message: setup } } } ]
    turns: [ { user: again, expect: [ { contains: "You said: again" } ] } ]
  - name: c
    turns: [ { user: third } ]
`),
      });
      const why = 'the fixture "session" (before) said to stop';
      assert.equal(run.status, "done", JSON.stringify(run.error));
      assert.deepEqual(run.tests.map((t) => [t.name, t.status, t.reason, t.instances.map((i) => i.status)]), [
        ["a", "stopped", why, ["passed", "stopped"]], ["b", "stopped", why, ["stopped"]], ["c", "passed", undefined, ["passed"]],
      ]);
      assert.equal(run.tests[1].instances[0].reason, why);
      // Its turns aren't sent: each skipped, saying why, its checks too
      const skipped = run.turns.filter((t) => t.skipped);
      assert.deepEqual(skipped.map((t) => [t.test, t.skipped, t.results.map((r) => [r.status, r.reason])]), [
        ["a", why, [["skipped", why]]], ["b", why, [["skipped", why]]],
      ]);
      assert.deepEqual(chats().map((x) => x.body.message), ["hello", "third"], "b's setup step wasn't sent either");
      assert.deepEqual(said(), ["session before a 1", "cleanup after a 1 passed", "session before a 2", "cleanup after a 2 stopped", "session before b 1", "cleanup after b 1 stopped", "session before c 1", "cleanup after c 1 passed"]);
      // (a test stopped by its fixture is skipped in the reports, saying why; the run isn't stopped)
      assert.equal(run.verdict, "passed");
      assert.equal(junit(run).match(/<skipped message="the fixture &quot;session&quot; \(before\) said to stop"\/>/g).length, 2);
    });

    it("false in after or afterAll changes nothing: it's recorded", async () => {
      const { run } = await runWith({
        "plugins/cleanup.js": fixture("cleanup", { body: "return false;" }),
        "plugins/logout.js": fixture("logout", { body: "return false;" }),
        "providers/p.yml": PROVIDER("{ after: [cleanup], afterAll: [logout] }"),
        "s.hafen.yml": SUITE(),
      });
      assert.equal(run.status, "done");
      assert.equal(run.verdict, "passed");
      assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status, f.stop]), [["cleanup", "after", "ok", true], ["cleanup", "after", "ok", true], ["logout", "afterAll", "ok", true]]);
      assert.deepEqual(run.tests[0].instances[0].after_errors, undefined);
    });

    it("true or nothing goes on; one that provides names still gives them; anything else is a failure saying what it returns", async () => {
      const ok = await runWith({
        "plugins/yes.js": fixture("yes", { body: "return true;" }),
        "plugins/quiet.js": fixture("quiet"),
        "providers/p.yml": PROVIDER("{ beforeAll: [yes], before: [quiet, yes] }"),
        "s.hafen.yml": SUITE(),
      });
      assert.equal(ok.run.verdict, "passed", JSON.stringify(ok.run.error));
      assert.equal(chats().length, 2);
      const owes = await runWith({
        "plugins/yes.js": fixture("yes", { provides: ["TOKEN"], body: "return true;" }),
        "providers/p.yml": PROVIDER("{ beforeAll: [yes] }"),
        "s.hafen.yml": SUITE(),
      });
      assert.match(owes.run.error.message, /the fixture "yes" \(beforeAll\) failed: it didn't give TOKEN/);
      const odd = await runWith({
        "plugins/yes.js": fixture("yes", { body: 'return "yes";' }),
        "providers/p.yml": PROVIDER("{ before: [yes] }"),
        "s.hafen.yml": SUITE(),
      });
      assert.equal(odd.run.tests[0].status, "error");
      assert.equal(odd.run.tests[0].instances[0].reason, 'the fixture "yes" (before) failed: its run() returns the values it gives, by name ({ ACME_COOKIE: "…" }), true or nothing to go on, or false to stop');
    });

    it("in a conversation: false in beforeAll or before refuses the message (sent to no one, not its history); they run again with the next", async () => {
      // (each says to stop the first time it's asked, and to go on after that)
      const host = memoryHost({
        "plugins/gate.js": fixture("gate", { body: "return calls > 1;" }),
        "plugins/session.js": fixture("session", { body: "return calls > 1;" }),
        "providers/p.yml": PROVIDER("{ beforeAll: [gate], before: [session] }"),
        "s.hafen.yml": SUITE(),
      });
      host.secrets = () => undefined;
      const call = connect(async () => host);
      await call("open", {});
      const send = (message) => call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message });
      const first = await send("one");
      assert.deepEqual([first.record.skipped, first.record.error, first.record.reply], ['the fixture "gate" (beforeAll) said to stop', undefined, ""]);
      assert.equal(first.run.spans.find((s) => s.kind === "turn").status, "skipped");
      const second = await send("two");
      assert.equal(second.record.skipped, 'the fixture "session" (before) said to stop');
      const third = await send("three");
      assert.equal(third.record.reply, "You said: three");
      assert.deepEqual(said(), ["gate beforeAll", "gate beforeAll", "session before", "session before"]);
      assert.deepEqual(chats().map((x) => x.body.message), ["three"], "the refused messages were sent to no one");
      await call("reset", { token: "c" });
    });
  });

  describe("env.set: the environment's values, for the rest of the run", () => {
    const SETTER = fixture("setter", { phases: ["beforeAll"], body: `env.set("chat_path", "json");
    env.set("greeting", "hello from the fixture");
    env.set("count", 3);
    // (the env it was given shows what it set)
    await transport.fetch({ url: settings.log_url, method: "POST", body: { said: "setter sees", env: { ...env } }, signal });` });
    const FILES = (over = {}) => ({
      "plugins/setter.js": SETTER,
      "plugins/watcher.js": fixture("watcher"),
      "providers/p.yml": PROVIDER("{ beforeAll: [setter], before: [watcher] }", "{{env.base_url}}/{{env.chat_path}}"),
      "s.hafen.yml": SUITE(`  - name: a
    turns: [ { user: "{{env.greeting}}", expect: [ { contains: "You said: {{env.greeting}}" }, { contains: "hello from the fixture" } ] } ]
  - name: b
    turns: [ { user: "{{env.count}} more" } ]
`, ', greeting: "from the file"'),
      ...over,
    });

    it("later requests, checks and fixtures have it as {{env.NAME}}, over the environment's own; recorded by name; never written; not a secret", async () => {
      const environment = { name: "local", values: { base_url: mock.url } };
      const before = JSON.stringify(environment);
      const files = FILES();
      const { run, host } = await runWith(files, { options: { environment } });
      assert.equal(run.status, "done", JSON.stringify(run.error));
      assert.equal(run.verdict, "passed", JSON.stringify(run.tests.map((t) => t.instances.map((i) => i.reason))));
      assert.deepEqual(chats().map((x) => x.body.message), ["hello from the fixture", "3 more"]);
      const logs = fixtureLog();
      assert.equal(logs[0].env.chat_path, undefined, "not set before it ran");
      assert.deepEqual([logs[1].said, logs[1].env.chat_path, logs[1].env.greeting, logs[1].env.count], ["setter sees", "json", "hello from the fixture", "3"]);
      assert.deepEqual([logs[2].said, logs[2].env.chat_path, logs[2].env.greeting], ["watcher before a 1", "json", "hello from the fixture"]);
      assert.deepEqual(run.fixtures[0].sets, ["chat_path", "greeting", "count"]);
      assert.deepEqual(run.spans.find((s) => s.name === "setter · beforeAll").metrics.sets, ["chat_path", "greeting", "count"]);
      // Never written: the environment passed is as it was, and so is every file
      assert.equal(JSON.stringify(environment), before);
      for (const [file, text] of Object.entries(files)) assert.equal(host.store.get(file), text, file);
      assert.deepEqual([...host.store.keys()].sort(), Object.keys(files).sort());
      // Not a secret: shown as it is
      assert.equal(run.turns[0].user, "hello from the fixture");
      assert.match(run.turns[0].request.url, /\/json$/);
    });

    it("gone when the run ends: a second run doesn't have it; within the run, each fixture after it does", async () => {
      const files = {
        "plugins/counter.js": fixture("counter", { phases: ["before"], body: 'env.set("visits", Number(env.visits ?? 0) + 1);' }),
        "providers/p.yml": PROVIDER("{ before: [counter] }"),
        "s.hafen.yml": SUITE(),
      };
      const host = memoryHost(files);
      await runWith(files, { host });
      await runWith(files, { host });
      assert.deepEqual(fixtureLog().map((b) => [b.said, b.env.visits]), [
        ["counter before a 1", undefined], ["counter before b 1", "1"],
        ["counter before a 1", undefined], ["counter before b 1", "1"],
      ]);
    });

    it("the check before a run: an {{env.NAME}} only a fixture sets isn't missing (env.set(\"NAME\", …) in its code, or its sets); one nothing sets still is", async () => {
      const dynamic = (sets) => fixture("dyn", { sets, body: 'const name = ["dyn", "path"].join("_"); env.set(name, "json");' });
      const files = (sets) => ({
        "plugins/setter.js": SETTER,
        "plugins/dyn.js": dynamic(sets),
        // (a check plugin whose code writes {{env.dyn_path}}: checked as the files are)
        "plugins/echo.js": 'export default { kind: "check", name: "echo", version: "1.0.0", hosts: ["127.0.0.1"], async check() { return { status: "pass", reason: "{{env.dyn_path}}" }; } };\n',
        "providers/p.yml": PROVIDER("{ beforeAll: [setter], before: [dyn] }", "{{env.base_url}}/{{env.chat_path}}"),
        "s.hafen.yml": SUITE(`  - name: a
    turns: [ { user: "{{env.dyn_path}}", expect: [ { type: echo } ] } ]
`),
      });
      const ok = await runWith(files(["dyn_path"]));
      assert.equal(ok.run.status, "done", JSON.stringify(ok.run.error));
      assert.equal(ok.run.turns[0].user, "json");
      mock.reset();
      const missing = await runWith(files(undefined));
      assert.equal(missing.run.status, "error");
      assert.deepEqual(missing.run.error.all.map((p) => [p.file, p.line, p.message]), [["s.hafen.yml", 8, '{{env.dyn_path}} isn\'t set: the environment "local" has no dyn_path']]);
      assert.equal(mock.log.length, 0);
      // (only beforeAll's and before's count: one after the requests sets it too late)
      const late = await runWith({ ...files(["dyn_path"]), "providers/p.yml": PROVIDER("{ beforeAll: [setter], after: [dyn] }", "{{env.base_url}}/{{env.chat_path}}") });
      assert.match(late.run.error.all.map((p) => p.message).join("\n"), /\{\{env\.dyn_path\}\} isn't set/);
    });

    it("a name that isn't one, or a value that isn't text: the fixture fails, saying so", async () => {
      const files = (body) => ({ "plugins/setter.js": fixture("setter", { body }), "providers/p.yml": PROVIDER("{ beforeAll: [setter] }"), "s.hafen.yml": SUITE() });
      const bad = await runWith(files('env.set("1bad", "x");'));
      assert.equal(bad.run.status, "error");
      assert.equal(bad.run.error.message, 's.hafen.yml: the fixture "setter" (beforeAll) failed: env.set: "1bad" isn\'t a name (letters, digits, _ . -, not starting with a digit)');
      const object = await runWith(files('env.set("chat_path", { a: 1 });'));
      assert.equal(object.run.error.message, 's.hafen.yml: the fixture "setter" (beforeAll) failed: env.set("chat_path", …) takes text (a number or true/false is made text)');
    });

    it("in a conversation: it's there for every message after, until the conversation's let go; a first message's own {{env.NAME}} is filled in after its fixtures", async () => {
      const files = {
        "plugins/counter.js": fixture("counter", { phases: ["beforeAll"], body: 'env.set("visits", Number(env.visits ?? 0) + 1); env.set("chat_path", "json");' }),
        "providers/p.yml": PROVIDER("{ beforeAll: [counter] }", "{{env.base_url}}/{{env.chat_path}}"),
        "s.hafen.yml": SUITE(),
      };
      const host = memoryHost(files);
      host.secrets = () => undefined;
      const call = connect(async () => host);
      await call("open", {});
      const environment = { name: "local", values: { base_url: mock.url } };
      const send = (message) => call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "local", environment, message });
      const first = await send("visit {{env.visits}} via {{env.chat_path}}");
      assert.equal(first.record.reply, "You said: visit 1 via json");
      assert.equal(first.record.user_template, "visit {{env.visits}} via {{env.chat_path}}");
      const second = await send("still {{env.visits}}");
      assert.equal(second.record.reply, "You said: still 1");
      // (once its fixtures have run, a name nothing sets is refused, as ever)
      await assert.rejects(send("{{env.nope}}"), /\{\{env\.nope\}\} isn't set: the environment "local" has no nope/);
      // Let go: the next conversation starts without it
      await call("reset", { token: "c" });
      const again = await send("visit {{env.visits}}");
      assert.equal(again.record.reply, "You said: visit 1");
      assert.deepEqual(fixtureLog().map((b) => b.env.visits), [undefined, undefined]);
      assert.deepEqual(environment.values, { base_url: mock.url }, "never written into the environment passed");
      await call("reset", { token: "c" });
    });
  });
});
