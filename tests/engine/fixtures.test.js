// Fixtures (contracts/provider.md, Fixtures): a plugin a provider names (fixture: acme-login) that
// logs in before the provider's first request; what it gives (a session cookie, a CSRF token) is kept
// for the run as secrets: a provider plugin names them ({ secret: NAME }), a provider file uses
// ${env:NAME}, and they're redacted everywhere. Against the mock's /auth/login and /auth/chat.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
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
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: settings.user, password: { secret: "ACME_PASSWORD" } }, signal });
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
    const res = await transport.fetch({ url: settings.url, method: "POST", headers: { cookie: { secret: "ACME_COOKIE" }, "x-csrf-token": { secret: "ACME_CSRF" } }, body: { message }, signal });
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
  "providers/acme.yml": `kind: plugin:acme\nfixture: acme-login\nurl: "{{base_url}}/auth/chat"\nlogin_url: "{{base_url}}/auth/login"\nuser: qa-bot\n`,
  // The same login, for an HTTP provider: its values as \${env:…}
  "providers/acme-http.yml": `kind: http\nfixture: acme-login@^1\nurl: "{{base_url}}/auth/chat"\nlogin_url: "{{base_url}}/auth/login"\nuser: qa-bot\nheaders: { cookie: "\${env:ACME_COOKIE}", x-csrf-token: "\${env:ACME_CSRF}" }\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
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
    assert.equal(span.name, "fixture acme-login");
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
    assert.match(wrong.error.message, /s\.hafen\.yml: the fixture "acme-login" failed: login failed: 401/);
    assert.equal(logins().length, 1);
    assert.equal(chats().length, 0);
    assert.equal(wrong.spans.find((s) => s.kind === "fixture").status, "error");
  });

  it("it gives every name it provides, and no other", async () => {
    mock.reset();
    const short = (await runWith(FILES({ "plugins/acme-login.js": FIXTURE({ give: "{ ACME_COOKIE: cookies.join(\"; \") }" }) }))).run;
    assert.match(short.error.message, /the fixture "acme-login" failed: it didn't give ACME_CSRF/);
    const extra = (await runWith(FILES({ "plugins/acme-login.js": FIXTURE({ give: "{ ACME_COOKIE: \"a\", ACME_CSRF: \"b\", OTHER: \"c\" }" }) }))).run;
    assert.match(extra.error.message, /it gave OTHER, which isn't in its provides/);
    assert.equal(chats().length, 0);
  });

  it("a fixture that isn't there, isn't a fixture, or isn't the version asked for: a setup error before anything's sent", async () => {
    mock.reset();
    const missing = (await runWith(FILES({ "providers/acme.yml": "kind: plugin:acme\nfixture: nope\nurl: x\n" }))).run;
    assert.equal(missing.status, "error");
    assert.match(missing.error.message, /the fixture "nope" isn't in the folder's plugins/);
    const notFixture = (await runWith(FILES({ "providers/acme.yml": "kind: plugin:acme\nfixture: acme\nurl: x\n" }))).run;
    assert.match(notFixture.error.message, /the plugin "acme" is a provider, not a fixture/);
    const version = (await runWith(FILES({ "providers/acme-http.yml": "kind: http\nfixture: acme-login@^2\nurl: x\n" }))).run;
    assert.match(version.error.message, /the fixture "acme-login" is version 1\.2\.0, not \^2/);
    assert.equal(mock.log.length, 0);
  });

  it("a name it provides counts as set before the run; one nothing sets is still a problem", async () => {
    mock.reset();
    const files = FILES({ "providers/acme-http.yml": `kind: http\nfixture: acme-login\nurl: "{{base_url}}/auth/chat"\nheaders: { cookie: "\${env:ACME_COOKIE}", x-other: "\${env:NOT_SET}" }\nbody: { message: "{{user}}" }\n` });
    const { run } = await runWith(files);
    assert.equal(run.status, "error");
    assert.deepEqual(run.error.all.map((p) => p.message), ["${env:NOT_SET} isn't set"]);
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
    assert.match(failed.record.error, /the fixture "acme-login" failed: login failed: 401/);
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
