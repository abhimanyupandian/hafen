// Fixtures (contracts/provider.md, Fixtures): a plugin a provider names (fixtures: { beforeAll: [acme-login] }) that
// logs in before the provider's first request; what it gives (a session cookie, a CSRF token) is kept
// for the run as secrets: a provider plugin's request and a provider file use them as {{secret.NAME}},
// and they're redacted everywhere. Against the mock's /auth/login and /auth/chat.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { fixturesOf } from "../../engine/fixture-lists.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { AUTH } from "../fixtures/mock-endpoint.mjs";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
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

  it("fixture: (one name) is no longer read, and a list that isn't one of the four is a problem: setup errors before anything's sent", async () => {
    mock.reset();
    const old = (await runWith(files({ "providers/p.yml": PROVIDER().replace(/^fixtures: .*$/m, "fixture: login") }))).run;
    assert.equal(old.status, "error");
    assert.match(old.error.all.map((p) => p.message).join("\n"), /fixtures: \{ beforeAll: \[acme-login\] \} \(fixture: is no longer read\)/);
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
