// Plugins (docs/plugins.md): provider, check and judge plugins in their workers, the hosts they reach,
// the secrets their code names, what they're given (never a secret), and plugins the engine refuses.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { noNetwork } from "../../engine/plugin-worker-core.js";
import { loadPlugins, satisfies, secretsNamed } from "../../engine/plugins.js";
import { preflight } from "../../engine/preflight.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { fetchTransport } from "../../engine/transport.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
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

describe("provider plugins", () => {
  it("a JSON body's {{secret.…}}s are filled in (nested, in lists)", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const r = await run({
      "plugins/p.js": providerPlugin(`    await transport.fetch({ url: "https://api.acme.example/x", method: "POST", body: {
      auth: { key: "{{secret.ACME_KEY}}" },
      list: ["Bearer {{secret.ACME_KEY}}"],
    }, signal });
    yield { type: "text", text: "sent" };`, { hosts: ["api.acme.example"] }),
      "providers/p.yml": "kind: plugin:p\n",
      "s.hafen.yml": suiteWith("      - { user: hi, expect: [ { contains: sent } ] }"),
    }, { secrets: { ACME_KEY: "k-12345" }, transport });
    assert.equal(r.verdict, "passed", JSON.stringify(r.error ?? r.turns));
    assert.deepEqual(JSON.parse(transport.requests[0].body), {
      auth: { key: "k-12345" },
      list: ["Bearer k-12345"],
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

const PROVIDER_PLUGIN = (hosts) => `export default {
  kind: "provider",
  name: "acme",
  version: "1.4.0",
  hosts: ${JSON.stringify(hosts)},
  async *send({ message, history, settings, transport, signal }) {
    // It never has the secret: not in the environment, not in what it's given
    yield { type: "thinking", text: "env has MOCK_TOKEN: " + (typeof process !== "undefined" && process.env && process.env.MOCK_TOKEN !== undefined) };
    const res = await transport.fetch({ url: settings.url, method: "POST", headers: { authorization: "Bearer {{secret.ACME_KEY}}" }, body: { message: message + " (" + history.length + " before)" }, signal });
    const data = await res.json();
    yield { type: "text", text: data.data.reply };
    yield { type: "usage", input: 3, output: 5 };
    yield { type: "done" };
  },
};
`;
const CHECK_PLUGIN = `export default {
  kind: "check",
  name: "polite",
  version: "1.0.0",
  async check({ value, params }) {
    const rude = /\\b(stupid|idiot)\\b/i.test(String(value));
    return { status: rude ? "fail" : "pass", reason: rude ? "found an insult" : "no insults in " + typeof value, value: String(value).length };
  },
};
`;
const JUDGE_PLUGIN = `export default {
  kind: "judge",
  name: "house",
  version: "2.1.0",
  async judge({ input, question }) {
    return { value: input.includes("4417") ? 0.9 : 0.1, confidence: 0.8, reason: "looked for the order in: " + question };
  },
};
`;

describe("plugins", () => {
  it("a provider, a check and a judge plugin, each in its worker: secret headers filled in by the engine, never seen", async () => {
    mock.reset();
    const host = memoryHost({
      "s.hafen.yml": `version: 1
provider: { kind: "plugin:acme@^1", url: "${mock.url}/json" }
plugins: [ ./plugins/acme.js, ./plugins/polite.js, ./plugins/house.js ]
judges:
  mine: { kind: plugin, plugin: house }
tests:
  - name: one
    turns:
      - user: a refund for 4417
        expect:
          - { type: polite }
          - { type: polite, path: $.text }
          - { type: judge, judge: mine, rubric: "mentions the order", min: 0.5 }
      - user: again
        expect: [ { contains: "again" } ]
`,
      "plugins/acme.js": PROVIDER_PLUGIN(["127.0.0.1"]),
      "plugins/polite.js": CHECK_PLUGIN,
      "plugins/house.js": JUDGE_PLUGIN,
    });
    host.secrets = (name) => ({ ACME_KEY: "acme-secret-1" })[name];
    process.env.MOCK_TOKEN = "in-the-engine's-environment";
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    const run = await runSuites({ suites: [suite], host, options: {} });
    delete process.env.MOCK_TOKEN;
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "passed", JSON.stringify(run.turns.map((t) => t.results)));
    const [first, second] = run.turns;
    assert.equal(first.reply, "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?");
    assert.deepEqual(first.thinking.map((t) => t.text), ["env has MOCK_TOKEN: false"]);
    assert.deepEqual(first.usage, { input: 3, output: 5, thinking: undefined, cached: undefined });
    assert.equal(mock.log[0].headers.authorization, "Bearer acme-secret-1");
    assert.equal(mock.log[1].body.message, "again (1 before)");
    assert.deepEqual(first.results.map((r) => [r.status, r.reason]), [
      ["pass", "no insults in string"], ["pass", "no insults in string"], ["pass", "looked for the order in: mentions the order"],
    ]);
    assert.equal(first.results[2].value, 0.9);
    assert.ok(!JSON.stringify(run).includes("acme-secret-1"), "the secret is redacted");
  });

  it("a plugin reaches only its hosts; a missing or bad plugin, or a version that doesn't fit, is a setup error", async () => {
    const files = (extra) => ({
      "s.hafen.yml": `version: 1\nprovider: { kind: "plugin:acme${extra.range ?? ""}", url: "${mock.url}/json" }\nplugins: [ ${extra.entry ?? "./plugins/acme.js"} ]\ntests:\n  - name: one\n    turns: [ { user: hi } ]\n`,
      "plugins/acme.js": extra.source ?? PROVIDER_PLUGIN(["127.0.0.1"]),
    });
    const go = async (extra) => {
      const host = memoryHost(files(extra));
      host.secrets = () => "k";
      return runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: {} });
    };
    const elsewhere = await go({ source: PROVIDER_PLUGIN(["api.acme.example"]) });
    assert.match(elsewhere.turns[0].error, /127\.0\.0\.1 isn't one of the plugin's hosts \(api\.acme\.example\)/);
    assert.match((await go({ entry: "./plugins/none.js" })).error.message, /the plugin \.\/plugins\/none\.js doesn't exist/);
    assert.match((await go({ range: "@^2" })).error.message, /"acme" is version 1\.4\.0, not \^2/);
    assert.match((await go({ source: "export default { kind: 'thing', name: 'x' };" })).error.message, /its kind is "thing"/);
    assert.match((await go({ source: "export default {" })).error.message, /can't be loaded/);
  });

  it("versions: ^, ~ and exact ranges", () => {
    assert.ok(satisfies("1.4.0", "^1"));
    assert.ok(satisfies("1.4.0", "^1.2"));
    assert.ok(!satisfies("2.0.0", "^1"));
    assert.ok(satisfies("1.4.3", "~1.4.0"));
    assert.ok(!satisfies("1.5.0", "~1.4"));
    assert.ok(satisfies("0.3.1", "^0.3"));
    assert.ok(!satisfies("0.4.0", "^0.3"));
    assert.ok(satisfies("2.1.0", "2.1.0"));
    assert.ok(!satisfies("2.1.1", "2.1.0"));
    assert.ok(satisfies("3.0.0", "*"));
  });

  it("the engine lists the folder's plugins (what each is, which suites use it), and a conversation can use a plugin's provider", async () => {
    mock.reset();
    const host = memoryHost({
      "s.hafen.yml": "version: 1\nprovider: providers/acme.yml\nplugins: [ ./plugins/acme.js ]\ntests:\n  - name: one\n    turns: [ { user: hi } ]\n",
      "providers/acme.yml": `kind: "plugin:acme"\nurl: ${mock.url}/json\n`,
      "plugins/acme.js": PROVIDER_PLUGIN(["127.0.0.1"]),
      "plugins/broken.js": "export default 42;",
    });
    host.secrets = () => "k";
    const call = connect(async () => host);
    await call("open", {});
    const list = await call("plugins", {});
    assert.deepEqual(list.map((p) => [p.file, p.meta?.name ?? null, p.meta?.kind ?? null, p.usedBy, !!p.error]), [
      ["plugins/acme.js", "acme", "provider", ["s.hafen.yml"], false],
      ["plugins/broken.js", null, null, [], true],
    ]);
    const out = await call("send", { token: "c1", providerFile: "providers/acme.yml", suiteFile: "s.hafen.yml", message: "a refund please" });
    assert.match(out.record.reply, /refund for order 4417/);
    await call("reset", { token: "c1" });
  });
});

describe("new plugins' files", () => {
  it("each kind's starting file loads as that kind, and the check works as it is", async () => {
    const { PLUGIN_KINDS, pluginTemplate } = await import("../../engine/plugin-templates.js");
    const { loadPlugins } = await import("../../engine/plugins.js");
    const files = Object.fromEntries(PLUGIN_KINDS.map((k) => [`plugins/my-${k.id}.js`, pluginTemplate(k.id, `my-${k.id}`)]));
    const host = memoryHost(files);
    const loaded = await loadPlugins(host, Object.keys(files));
    assert.deepEqual(loaded.problems, []);
    assert.deepEqual(Object.values(loaded.plugins).map((p) => [p.meta.name, p.meta.kind, p.meta.version]), [
      ["my-provider", "provider", "1.0.0"], ["my-check", "check", "1.0.0"], ["my-judge", "judge", "1.0.0"], ["my-fixture", "fixture", "1.0.0"],
    ]);
    assert.deepEqual(loaded.plugins["my-provider"].meta.hosts, ["api.example.com"]);
    assert.deepEqual(loaded.plugins["my-fixture"].meta.provides, ["EXAMPLE_COOKIE", "EXAMPLE_CSRF"]);
    assert.deepEqual(await loaded.plugins["my-check"].check({ value: "Yes, please", params: {} }), { status: "pass", reason: 'says "please"' });
    assert.equal((await loaded.plugins["my-judge"].judge({ input: "short", question: "q" })).value, 0.3);
    loaded.close();
  });
});

describe("a provider plugin is given the variables and its settings filled in, never a secret", () => {
  const SECRET = "sk-very-secret-4242";

  async function run(files, { options = {}, secrets = { MY_KEY: SECRET }, file = "s.hafen.yml" } = {}) {
    const host = memoryHost(files, { secrets });
    const events = [];
    const suite = await loadSuite(host, file);
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    const out = await runSuites({ suites: [suite], host, options, onEvent: (e) => events.push(e) });
    return { run: out, events };
  }

  // (what it's given goes in base64: a {{secret.…}} in its request would be filled in as it leaves)
  const PLUGIN = `export default {
  kind: "provider", name: "echo", version: "1.0.0", hosts: ["127.0.0.1"],
  async *send({ message, variables, settings, env, transport, signal }) {
    const given = btoa(JSON.stringify({ variables, settings, env }));
    const res = await transport.fetch({ url: settings.url, method: "POST", body: { message, given }, signal });
    const data = await res.json();
    yield { type: "text", text: data.data.reply };
    yield { type: "done" };
  },
};
`;

  it("settings' {{name}}s are filled from the variables and {{env.NAME}} from the environment; a {{secret.…}} isn't", async () => {
    const { run: r } = await run({
      "plugins/echo.js": PLUGIN,
      "s.hafen.yml": `version: 1
provider: { kind: "plugin:echo", url: "{{base_url}}/json", region: "{{env.region}}", team: "{{team}}", key: "{{secret.MY_KEY}}", port: "{{port}}" }
plugins: [ ./plugins/echo.js ]
environments:
  stage: { base_url: "${mock.url}", port: 8080 }
variables: { team: refunds, token: "{{secret.MY_KEY}}" }
tests:
  - name: t
    data: data/rows.csv
    turns:
      - user: "hi {{row.who}}"
        extract: { said: $.text }
      - user: again
`,
      "data/rows.csv": "who\npriya\n",
    }, { options: { environment: { name: "stage", values: { region: "eu-1" } } } });
    assert.equal(r.status, "done", JSON.stringify(r.error));
    assert.equal(r.verdict, "passed", JSON.stringify(r.turns.map((t) => t.error)));
    const [first, second] = mock.log.map((x) => JSON.parse(atob(x.body.given)));
    assert.equal(first.settings.url, `${mock.url}/json`);
    assert.equal(first.settings.region, "eu-1");
    assert.equal(first.settings.team, "refunds");
    assert.equal(first.settings.port, 8080, "a whole {{name}} keeps its type");
    assert.equal(first.settings.key, "{{secret.MY_KEY}}", "a secret isn't filled in for a plugin");
    assert.equal(first.variables.team, "refunds");
    assert.equal(first.variables.base_url, mock.url);
    assert.equal(first.variables.token, "{{secret.MY_KEY}}");
    assert.deepEqual(first.variables.row, { who: "priya" });
    assert.equal(first.variables.scope, undefined);
    assert.deepEqual(first.env, { base_url: mock.url, port: 8080, region: "eu-1" });
    assert.equal(first.variables.test.name, "t");
    // An extraction (from the reply the plugin gave) reaches the next turn's variables
    assert.equal(second.variables.said, "You said: hi priya");
    assert.ok(!JSON.stringify(mock.log).includes(SECRET));
  });

  it("scope.plain and scope.variables on their own", () => {
    const used = new Set();
    const scope = createScope({
      layers: [{ a: 1, s: "x {{secret.K}}" }, { a: 2, b: "two" }],
      trusted: [],
      secrets: (n) => ({ K: "kkkk-secret", P: "pppp-secret" })[n],
      used,
      environment: { name: "stage", values: { db: { host: "h" } } },
    });
    assert.deepEqual(scope.plain({ x: "{{a}}", y: "{{b}}/{{a}}", z: "{{env.db.host}}", s: "{{s}}", e: "{{secret.K}}", p: "Bearer {{secrets.P}}", m: "{{missing}}" }),
      { x: 1, y: "two/1", z: "h", s: "x {{secret.K}}", e: "{{secret.K}}", p: "Bearer {{secrets.P}}", m: "{{missing}}" });
    assert.deepEqual(scope.variables(), { a: 1, b: "two", s: "x {{secret.K}}" });
    assert.deepEqual(scope.envValues(), { db: { host: "h" } });
    assert.equal(used.size, 0, "no secret was looked up");
  });
});

describe("the secrets a plugin names in its code", () => {
  const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);

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

  it("are read from its text, each where it's first written", () => {
    assert.deepEqual(secretsNamed(LOGIN), [{ name: "ACME_PASSWORD", line: 13, column: 38 }]);
    assert.deepEqual(secretsNamed('const a = "{{secret.A}}";\nconst b = `Bearer {{ secrets.B }}`;\n// "{{secret.A}}"\n').map((s) => [s.name, s.line, s.column]), [["A", 1, 12], ["B", 2, 19]]);
    // (a name built as it runs can't be seen)
    assert.deepEqual(secretsNamed('"{{" + "secret.MADE}}"'), []);
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

describe("a plugin's worker has no fetch of its own (J)", () => {
  // A host whose secrets are kept per scope ("" for every scope, as the app's), with the lookups made
  function hostWith(files, { secrets = {}, reply = () => ({ body: JSON.stringify({ a: "ok" }) }) } = {}) {
    const transport = fakeTransport(reply);
    const host = memoryHost(files, { transport });
    const lookups = [];
    host.secrets = (name, { env } = {}) => {
      lookups.push(`${name}@${env}`);
      return secrets[env ?? ""]?.[name] ?? secrets[""]?.[name];
    };
    return { host, transport, lookups };
  }
  async function runFiles(files, { options = {}, secrets, reply, hostHook } = {}) {
    const { host, transport, lookups } = hostWith(files, { secrets, reply });
    hostHook?.(host);
    const suites = [];
    for (const f of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) suites.push(await loadSuite(host, f));
    const events = [];
    const run = await runSuites({ suites, host, options, onEvent: (e) => events.push(e) });
    return { run, transport, lookups, events, host };
  }

  it("fetch, WebSocket, XMLHttpRequest and EventSource throw, saying to use transport.fetch; transport.fetch reaches its hosts", async () => {
    const files = {
      "plugins/net.js": `export default {
  kind: "check", name: "net", version: "1.0.0", hosts: ["x.example"],
  async check({ transport }) {
    const said = {};
    for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
      try {
        if (name === "fetch") await fetch("https://x.example/");
        else new globalThis[name]("wss://x.example/");
        said[name] = "went";
      } catch (e) {
        said[name] = e.message;
      }
    }
    const res = await transport.fetch({ url: "https://x.example/ok" });
    said.transport = res.status;
    return { status: "pass", reason: JSON.stringify(said) };
  },
};
`,
      "providers/p.yml": "kind: http\nurl: https://x.example/chat\nbody: { message: \"{{user}}\" }\nresponse: { text: $.a }\n",
      "s.hafen.yml": "version: 1\nname: s\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: hi\n        expect: [{ type: net }]\n",
    };
    const { run, transport } = await runFiles(files);
    assert.equal(run.status, "done", JSON.stringify(run.error));
    const result = run.turns[0].results[0];
    assert.equal(result.status, "pass", result.reason);
    assert.deepEqual(JSON.parse(result.reason), { fetch: noNetwork("fetch"), WebSocket: noNetwork("WebSocket"), XMLHttpRequest: noNetwork("XMLHttpRequest"), EventSource: noNetwork("EventSource"), transport: 200 });
    assert.equal(noNetwork("fetch"), "a plugin has no fetch (use transport.fetch: it's the one that reaches the plugin's hosts)");
    assert.deepEqual(transport.requests.map((r) => r.url), ["https://x.example/chat", "https://x.example/ok"]);
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
