// What a fixture gives is a secret (contracts/provider.md, Fixtures), and so is the credential in a
// "<scheme> <credential>" value it gives: a login whose fixture gives AUTH: `Bearer ${access_token}`
// has its answer ({"access_token":"tok_mock_123"}) on its call's step, and the token is hidden there
// too. Its calls' requests and responses go on their steps only once what it gives is known, so no
// event shows one before. Nowhere in the run, its events, a conversation's record or the reports
// (JSON, Markdown, JUnit). Against the mock's /login and /auth/login.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createConversation } from "../../engine/explore.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { serializeRun } from "../../engine/reports/run-file.js";
import { runSuites } from "../../engine/runner.js";
import { loadPlugins } from "../../engine/plugins.js";
import { AUTH } from "../fixtures/mock-endpoint.mjs";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

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

describe("a fixture's values, redacted", () => {
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
