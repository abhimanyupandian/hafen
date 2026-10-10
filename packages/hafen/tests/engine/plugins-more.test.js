// More of plugins (contracts/provider.md, Code plugins and Fixtures; contracts/checks.md, Plugins):
// secrets named in a JSON body, hosts with wildcards, a provider plugin's errors, stops and replayed
// raw events, a check plugin's input and odd answers, a judge plugin's limits, plugins the engine
// refuses, cookies and redirects as a plugin reads them, and fixtures across suites and scopes.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { loadPlugins } from "../../engine/plugins.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { fetchTransport } from "../../engine/transport.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

// A provider plugin whose send() is `body` (its arguments: message, history, settings, transport, signal)
const providerPlugin = (body, { name = "p", hosts = ["127.0.0.1"] } = {}) => `export default {
  kind: "provider",
  name: "${name}",
  version: "1.0.0",
  hosts: ${JSON.stringify(hosts)},
  async *send({ message, history, settings, variables, transport, signal }) {
${body}
  },
};
`;
// A suite of one test (its turns given), with the plugin provider p
const suiteWith = (turns, { provider = "providers/p.yml", extra = "" } = {}) => `version: 1
provider: ${provider}
environments:
  local: { base_url: "${mock.url}" }
${extra}
tests:
  - name: t
    turns:
${turns}
`;
async function run(files, { secrets = {}, transport, signal, options = {} } = {}) {
  const host = memoryHost(files, transport ? { transport } : {});
  host.secrets = (name, { env } = {}) => secrets[env]?.[name] ?? secrets[""]?.[name] ?? secrets[name];
  const suites = [];
  for (const f of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) suites.push(await loadSuite(host, f));
  return runSuites({ suites, host, signal, options });
}

describe("provider plugins", () => {
  it("a JSON body's {{secret.…}}s are filled in (nested, in lists); an object with a secret key and others is sent as it is", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const r = await run({
      "plugins/p.js": providerPlugin(`    await transport.fetch({ url: "https://api.acme.example/x", method: "POST", body: {
      auth: { key: "{{secret.ACME_KEY}}" },
      list: ["Bearer {{secret.ACME_KEY}}"],
      literal: { secret: "not-a-ref", note: "has other keys" },
    }, signal });
    yield { type: "text", text: "sent" };`, { hosts: ["api.acme.example"] }),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: hi, expect: [ { contains: sent } ] }"),
    }, { secrets: { ACME_KEY: "k-12345" }, transport });
    assert.equal(r.verdict, "passed", JSON.stringify(r.error ?? r.turns));
    assert.deepEqual(JSON.parse(transport.requests[0].body), {
      auth: { key: "k-12345" },
      list: ["Bearer k-12345"],
      literal: { secret: "not-a-ref", note: "has other keys" },
    });
    assert.equal(transport.requests[0].headers["content-type"], "application/json");
    assert.ok(!JSON.stringify(r).includes("k-12345"));
  });

  it("a secret its code names that isn't set: a problem before anything is sent; one named only as it runs: the turn is an error saying which", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: "{}" }));
    const named = await run({
      "plugins/p.js": providerPlugin(`    await transport.fetch({ url: "https://api.acme.example/x", body: { key: "{{secret.NOT_SET}}" }, signal });
    yield { type: "text", text: "never" };`, { hosts: ["api.acme.example"] }),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: hi }"),
    }, { transport });
    assert.equal(named.status, "error");
    assert.match(named.error.message, /\{\{secret\.NOT_SET\}\} isn't set for the scope "local" \(the provider plugin "p" names it/);
    assert.equal(named.turns.length, 0);
    // (a name its code makes as it runs can't be known before: the turn says it)
    const made = await run({
      "plugins/p.js": providerPlugin(`    await transport.fetch({ url: "https://api.acme.example/x", body: { key: "{{" + ["secret", "NOT_SET"].join(".") + "}}" }, signal });
    yield { type: "text", text: "never" };`, { hosts: ["api.acme.example"] }),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: hi }"),
    }, { transport });
    assert.match(made.turns[0].error, /\{\{secret\.NOT_SET\}\} isn't set for the scope "local"/);
    assert.equal(transport.requests.length, 0);
  });

  it("hosts: an exact name, or *.name for it and its subdomains, and nothing else", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: "{}" }));
    const r = await run({
      "plugins/p.js": providerPlugin(`    const out = [];
    for (const url of settings.urls) {
      try { await transport.fetch({ url, method: "GET", signal }); out.push("ok"); } catch (err) { out.push(err.message.includes("isn't one of the plugin's hosts") ? "refused" : err.message); }
    }
    yield { type: "text", text: out.join(",") };`, { hosts: ["*.acme.example", "exact.example"] }),
      "providers/p.yml": `kind: plugin:p
urls: [https://api.acme.example/a, https://acme.example/b, https://deep.api.acme.example/c, https://evilacme.example/d, https://acme.example.evil.com/e, https://exact.example/f, https://sub.exact.example/g, "not a url"]
`,
      "s.hafen.yml": suiteWith("      - { user: hi }"),
    }, { transport });
    assert.equal(r.turns[0].reply, "ok,ok,ok,refused,refused,ok,refused,not a url isn't an address");
    assert.deepEqual(transport.requests.map((q) => new URL(q.url).hostname), ["api.acme.example", "acme.example", "deep.api.acme.example", "exact.example"]);
  });

  it("an error it throws ends its turn as an error, keeping what it said before", async () => {
    const r = await run({
      "plugins/p.js": providerPlugin(`    yield { type: "text", text: "half a rep" };
    throw new Error("the backend hung up");`),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: hi, expect: [ { contains: half } ] }"),
    });
    assert.equal(r.turns[0].reply, "half a rep");
    assert.match(r.turns[0].error, /the backend hung up/);
    assert.equal(r.tests[0].status, "error");
  });

  it("what it yields as raw comes back in the next turn's history; its variables never hold a secret", async () => {
    const r = await run({
      "plugins/p.js": providerPlugin(`    yield { type: "raw", value: { turn: history.length + 1, said: message } };
    const before = history.map((h) => h.raw?.said ?? "none").join("|");
    yield { type: "text", text: "before: " + (before || "nothing") + "; token: " + JSON.stringify(variables.token ?? null) };`),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: first }\n      - { user: second }\n      - { user: third }", { extra: "variables:\n  token: \"{{secret.API_TOKEN}}\"" }),
    }, { secrets: { API_TOKEN: "tok-should-not-show" } });
    assert.deepEqual(r.turns.map((t) => t.reply), [
      'before: nothing; token: "{{secret.API_TOKEN}}"',
      'before: first; token: "{{secret.API_TOKEN}}"',
      'before: first|second; token: "{{secret.API_TOKEN}}"',
    ]);
  });

  it("each HTTP call it makes is a step under the turn's request: what it sent (secrets redacted), what came back; a refused one too", async () => {
    mock.reset();
    const r = await run({
      "plugins/p.js": providerPlugin(`    const res = await transport.fetch({ url: settings.url, method: "POST", headers: { authorization: "Bearer {{secret.ACME_KEY}}", "x-trace": "t-1" }, body: { message, key: "{{secret.ACME_KEY}}" }, signal });
    const data = await res.json();
    try { await transport.fetch({ url: "https://elsewhere.example/x", signal }); } catch {}
    yield { type: "text", text: data.data.reply };`),
      "providers/p.yml": `kind: plugin:p\nurl: "{{base_url}}/json"\n`,
      "s.hafen.yml": suiteWith("      - { user: a refund for 4417 }"),
    }, { secrets: { ACME_KEY: "k-secret-778" } });
    assert.equal(r.turns[0].reply, "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?");
    const request = r.spans.find((x) => x.kind === "request");
    const calls = r.spans.filter((x) => x.kind === "call");
    assert.deepEqual(calls.map((c) => [c.name, c.parent === request._id, c.status, c.plugin]), [
      [`POST ${new URL(mock.url).host}/json`, true, "ok", "provider p"],
      ["GET elsewhere.example/x", true, "error", "provider p"],
    ]);
    const [sent, refused] = calls;
    assert.equal(sent.request.headers.authorization, "[redacted]");
    assert.equal(sent.request.headers["x-trace"], "t-1");
    assert.deepEqual(JSON.parse(sent.request.body), { message: "a refund for 4417", key: "[redacted]" });
    assert.equal(sent.response.status, 200);
    assert.match(sent.response.body, /"order":\{"id":4417\}/);
    assert.match(refused.error, /elsewhere\.example isn't one of the plugin's hosts/);
    assert.ok(!JSON.stringify(r).includes("k-secret-778"));
  });

  it("stopping the run aborts its signal: the turn is stopped, not an error", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await run({
      "plugins/p.js": providerPlugin(`    yield { type: "text", text: "waiting" };
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted: " + signal.aborted);`),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: hi }"),
    }, { signal: controller.signal });
    assert.equal(r.status, "stopped");
    assert.equal(r.tests[0].status, "stopped");
  });
});

describe("check and judge plugins", () => {
  const CHECK = `export default {
  kind: "check",
  name: "shape",
  version: "1.0.0",
  async check({ value, turn, conversation, params }) {
    if (params.mode === "throw") throw new Error("the check broke");
    if (params.mode === "odd") return { status: "maybe" };
    return { status: value === params.want ? "pass" : "fail", reason: "got " + JSON.stringify(value) + " after " + conversation.length + " turn(s), status " + turn.status, value, expected: params.want, actual: value };
  },
};
`;
  it("a check plugin is given what on/path selects, the turn and its fields; a status it can't give, or a throw, is an error", async () => {
    const r = await run({
      "plugins/shape.js": CHECK,
      "providers/json.yml": `kind: http\nurl: "{{base_url}}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suiteWith(`      - user: a refund for 4417
        expect:
          - { type: shape, path: $.data.order.id, want: 4417 }
          - { type: shape, path: $.data.order.id, want: 1 }
          - { type: shape, mode: odd }
          - { type: shape, mode: throw }`, { provider: "providers/json.yml" }),
    });
    const results = r.turns[0].results;
    assert.deepEqual(results.map((x) => x.status), ["pass", "fail", "error", "error"]);
    assert.equal(results[0].reason, "got 4417 after 1 turn(s), status 200");
    assert.deepEqual([results[1].expected, results[1].actual], [1, 4417]);
    assert.equal(results[2].reason, "the plugin's check gave no status");
    assert.match(results[3].reason, /the check broke/);
  });

  it("a judge plugin's value against the check's min and max, and its confidence against unsure_below (a value that misses fails, whatever its confidence)", async () => {
    const judge = `export default {
  kind: "judge",
  name: "house",
  version: "1.0.0",
  async judge({ question }) {
    const [value, confidence] = question.split(" ").map(Number);
    return { value, confidence, reason: "said " + question };
  },
};
`;
    const r = await run({
      "plugins/house.js": judge,
      "providers/json.yml": `kind: http\nurl: "{{base_url}}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suiteWith(`      - user: hi
        expect:
          - { type: judge, judge: mine, rubric: "0.9 0.9", min: 0.5 }
          - { type: judge, judge: mine, rubric: "0.2 0.9", min: 0.5 }
          - { type: judge, judge: mine, rubric: "0.9 0.3", min: 0.5 }
          - { type: judge, judge: mine, rubric: "0.9 0.9", min: 0.1, max: 0.5 }
          - { type: judge, judge: mine, rubric: "0.2 0.3", min: 0.5 }`, { provider: "providers/json.yml", extra: "judges:\n  mine: { kind: plugin, plugin: house }" }),
    });
    assert.deepEqual(r.turns[0].results.map((x) => x.status), ["pass", "fail", "unsure", "fail", "fail"], JSON.stringify(r.turns[0].results));
    assert.equal(r.turns[0].results[2].reason, "said 0.9 0.3, but confidence 0.3 is below 0.6");
  });
});

describe("plugins the engine refuses", () => {
  const files = (entries) => Object.fromEntries(entries.map(([name, source]) => [`plugins/${name}.js`, source]));
  it("two plugins of one name, a provider plugin used as a fixture or the other way round, a bad provides, a default export that isn't one", async () => {
    const host = memoryHost(files([
      ["a", "export default { kind: 'check', name: 'same', check: async () => ({ status: 'pass' }) };"],
      ["b", "export default { kind: 'check', name: 'same', check: async () => ({ status: 'pass' }) };"],
      ["c", "export default { kind: 'fixture', name: 'bad-provides', provides: ['ok', '1st'], setup: async () => ({}) };"],
      ["d", "export default { kind: 'fixture', name: 'no-setup' };"],
      ["e", "export default 42;"],
    ]));
    const loaded = await loadPlugins(host, [...host.store.keys()]);
    const messages = loaded.problems.map((p) => p.message);
    loaded.close();
    assert.ok(messages.some((m) => /two plugins are named "same"/.test(m)), messages.join("\n"));
    assert.ok(messages.some((m) => /its provides is a list of names/.test(m)), messages.join("\n"));
    assert.ok(messages.some((m) => /a fixture plugin has run\(\)/.test(m)), messages.join("\n"));
    assert.ok(messages.some((m) => /its default export isn't a plugin/.test(m)), messages.join("\n"));
  });

  it("a fixture named as a provider's kind, and a provider plugin named as a fixture: setup errors before anything's sent", async () => {
    mock.reset();
    const fixture = "export default { kind: 'fixture', name: 'login', version: '1.0.0', provides: ['T'], setup: async () => ({ T: 'x' }) };";
    const asProvider = await run({ "plugins/login.js": fixture, "providers/p.yml": "kind: plugin:login\n", "s.hafen.yml": suiteWith("      - { user: hi }") });
    assert.match(asProvider.error.message, /the plugin "login" is a fixture, not a provider/);
    const asFixture = await run({ "plugins/p.js": providerPlugin('    yield { type: "text", text: "x" };'), "providers/p.yml": "kind: plugin:p\nfixtures: { beforeAll: [p] }\n", "s.hafen.yml": suiteWith("      - { user: hi }") });
    assert.match(asFixture.error.message, /the plugin "p" \(fixtures\.beforeAll\) is a provider, not a fixture/);
    assert.equal(mock.log.length, 0);
  });
});

describe("what a plugin reads of a response", () => {
  it("every Set-Cookie, as a list; redirect: manual gives the redirect itself", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/login") {
        res.writeHead(302, { location: "/home", "set-cookie": ["sid=abc123; Path=/; HttpOnly", "region=eu; Path=/"] });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "after=redirect" });
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const transport = fetchTransport();
      const manual = await transport.send({ url: `${url}/login`, method: "GET", redirect: "manual" });
      assert.equal(manual.status, 302);
      assert.deepEqual(manual.headers["set-cookie"], ["sid=abc123; Path=/; HttpOnly", "region=eu; Path=/"]);
      const followed = await transport.send({ url: `${url}/login`, method: "GET" });
      assert.equal(followed.status, 200);
      assert.deepEqual(followed.headers["set-cookie"], ["after=redirect"]);
      // And through a plugin's transport, as a fixture reads them
      const host = memoryHost({
        "plugins/f.js": `export default { kind: "fixture", name: "f", version: "1.0.0", hosts: ["127.0.0.1"], provides: ["COOKIES", "STATUS"],
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "GET", redirect: "manual", signal });
    return { COOKIES: res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; "), STATUS: res.status };
  } };`,
      });
      const loaded = await loadPlugins(host, ["plugins/f.js"]);
      const got = await loaded.plugins.f.run({ settings: { login_url: `${url}/login` }, variables: {} });
      loaded.close();
      assert.deepEqual(got, { COOKIES: "sid=abc123; region=eu", STATUS: 302 });
    } finally {
      server.close();
    }
  });
});

describe("fixtures across suites, scopes and steps", () => {
  // A login to the mock (/login gives an access token), and how many times it ran; the settings it's
  // given go in base64 (a {{secret.…}} in its request would be filled in as it leaves)
  const FIXTURE = `export default {
  kind: "fixture",
  name: "login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["TOKEN"],
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { scope: settings.scope_name, given: btoa(JSON.stringify(settings)) }, signal });
    return { TOKEN: (await res.json()).access_token + "-" + settings.scope_name };
  },
};
`;
  const PROVIDER = `kind: http
fixtures: { beforeAll: [login] }
url: "{{base_url}}/json"
login_url: "{{base_url}}/login"
scope_name: "{{who}}"
password_hint: "{{secret.LOGIN_PASSWORD}}"
headers: { x-token: "{{secret.TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const suite = (env, who, extra = "") => `version: 1
provider: providers/login.yml
environments:
  ${env}: { base_url: "${mock.url}", who: ${who} }
${extra}
tests:
  - name: t
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`;
  const logins = () => mock.log.filter((x) => x.path === "/login");
  const tokens = () => mock.log.filter((x) => x.path === "/json").map((x) => x.headers["x-token"]);

  it("once per run and scope: two suites of one scope share it; another scope logs in again", async () => {
    mock.reset();
    const r = await run({
      "plugins/login.js": FIXTURE, "providers/login.yml": PROVIDER,
      "a.hafen.yml": suite("stage", "stage-a"), "b.hafen.yml": suite("stage", "stage-b"), "c.hafen.yml": suite("prod", "prod-c"),
    }, { secrets: { LOGIN_PASSWORD: "pw-hidden" } });
    assert.equal(r.verdict, "passed", JSON.stringify(r.error));
    assert.deepEqual(logins().map((x) => x.body.scope), ["stage-a", "prod-c"], "once for stage (the first suite's settings), once for prod");
    assert.deepEqual(tokens(), ["tok_mock_123-stage-a", "tok_mock_123-stage-a", "tok_mock_123-prod-c"]);
    // Its settings: {{name}}s filled in, a secret never (as written)
    const given = JSON.parse(atob(logins()[0].body.given));
    assert.equal(given.password_hint, "{{secret.LOGIN_PASSWORD}}");
    assert.equal(given.fixture, undefined, "(its own key isn't one of them)");
    assert.equal(r.spans.filter((s) => s.kind === "fixture").length, 2);
  });

  it("before the suite's setup steps, which can use what it gave", async () => {
    mock.reset();
    const r = await run({
      "plugins/login.js": FIXTURE, "providers/login.yml": PROVIDER,
      "s.hafen.yml": suite("stage", "stage-a", `setup:
  - name: warm up
    request: { url: "{{base_url}}/json", method: POST, headers: { x-token: "{{secret.TOKEN}}" }, body: { message: warm } }`),
    }, { secrets: { LOGIN_PASSWORD: "pw" } });
    assert.equal(r.verdict, "passed", JSON.stringify(r.error));
    assert.deepEqual(mock.log.map((x) => x.path), ["/login", "/json", "/json"]);
    assert.deepEqual(tokens(), ["tok_mock_123-stage-a", "tok_mock_123-stage-a"]);
    const kinds = r.spans.filter((s) => ["fixture", "setup"].includes(s.kind)).map((s) => s.kind);
    assert.deepEqual(kinds, ["fixture", "setup"]);
  });

  it("only for the tests chosen: a run whose chosen tests don't use it doesn't log in", async () => {
    mock.reset();
    const r = await run({
      "plugins/login.js": FIXTURE, "providers/login.yml": PROVIDER,
      "providers/json.yml": `kind: http\nurl: "{{base_url}}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": `version: 1
provider: providers/login.yml
environments:
  stage: { base_url: "${mock.url}", who: x }
tests:
  - name: behind the login
    turns: [ { user: hi } ]
  - name: open
    provider: providers/json.yml
    turns: [ { user: hi } ]
`,
    }, { secrets: { LOGIN_PASSWORD: "pw" }, options: { tests: ["open"] } });
    assert.equal(r.verdict, "passed", JSON.stringify(r.error));
    assert.equal(logins().length, 0);
  });

  it("one that takes longer than the provider's timeout_ms fails, saying so", async () => {
    mock.reset();
    const r = await run({
      "plugins/login.js": FIXTURE.replace('settings.login_url', '"' + mock.url + '/slow?ms=2000"'),
      "providers/login.yml": PROVIDER.replace("fixtures: { beforeAll: [login] }", "fixtures: { beforeAll: [login] }\ntimeout_ms: 200"),
      "s.hafen.yml": suite("stage", "s"),
    }, { secrets: { LOGIN_PASSWORD: "pw" } });
    assert.equal(r.status, "error");
    assert.match(r.error.message, /the fixture "login" \(beforeAll\) failed: timed out after 200 ms/);
  });

  it("the plugins list says what a fixture gives and which suites use it (by their providers)", async () => {
    const host = memoryHost({ "plugins/login.js": FIXTURE, "providers/login.yml": PROVIDER, "s.hafen.yml": suite("stage", "s"), "other.hafen.yml": "version: 1\nprovider: openai-chat\ntests: []\n" });
    const call = connect(async () => host);
    await call("open", {});
    const list = await call("plugins", {});
    assert.deepEqual(list.map((p) => [p.meta.name, p.meta.kind, p.meta.provides, p.usedBy]), [["login", "fixture", ["TOKEN"], ["s.hafen.yml"]]]);
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
