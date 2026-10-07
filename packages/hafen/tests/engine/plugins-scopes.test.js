// Scopes (the environment chosen: {{env.NAME}}, its values passed, then the suite's environment of its
// name; {{secret.NAME}}, its secrets; a folder's environments/<scope>.yml isn't read) and plugins (a
// provider, a check, a judge: each in a worker of its own, reaching only its hosts, its secret headers
// filled in by the engine, never seeing a secret's value).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { satisfies } from "../../engine/plugins.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
const SUITE = (extra = "") => `version: 1
provider: providers/p.yml
${extra}
tests:
  - name: a
    turns:
      - user: "hello from {{env.who}}"
        expect: [ { contains: "hello from stage-team" } ]
`;
async function runWith(files, options = {}, secrets = {}, secretScopes) {
  const host = memoryHost(files, { secrets });
  host.secrets = (name, { env } = {}) => secrets[env]?.[name] ?? secrets[""]?.[name];
  if (secretScopes) host.secretScopes = () => secretScopes;
  const suite = await loadSuite(host, "s.hafen.yml");
  return { run: await runSuites({ suites: [suite], host, options }), host, suite };
}
const stage = () => ({ name: "stage", values: { base_url: mock.url, who: "stage-team" } });

describe("scopes", () => {
  it("{{env.NAME}}: the chosen scope's values; {{secret.NAME}}: its secrets (redacted)", async () => {
    mock.reset();
    const { run, suite } = await runWith({ "s.hafen.yml": SUITE(), "providers/p.yml": PROVIDER }, { env: "stage", environment: stage() }, { stage: { API_KEY: "sk-stage-123" }, prod: { API_KEY: "sk-prod" } });
    assert.deepEqual(suite.missing, [], "the environment's names are checked when it runs, not as missing variables");
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "passed");
    assert.equal(mock.log[0].headers.authorization, "Bearer sk-stage-123");
    assert.equal(mock.log[0].body.message, "hello from stage-team");
    assert.ok(!JSON.stringify(run).includes("sk-stage-123"), "the secret is redacted from the run");
  });

  it("a name the scope hasn't, or no scope chosen, is a setup error before anything's sent; a folder's environments/<scope>.yml is never read", async () => {
    mock.reset();
    const files = { "s.hafen.yml": SUITE(), "providers/p.yml": PROVIDER, "environments/stage.yml": `base_url: ${mock.url}\nwho: stage-team\n` };
    const missing = (await runWith(files, { env: "stage", environment: { name: "stage", values: { base_url: mock.url } } }, { stage: { API_KEY: "k" } })).run;
    assert.equal(missing.status, "error");
    assert.match(missing.error.message, /\{\{env\.who\}\} isn't set: the environment "stage" has no who/);
    const none = (await runWith(files, {}, {})).run;
    assert.equal(none.status, "error");
    assert.match(none.error.message, /isn't set: no environment is chosen/);
    // (its name alone: the folder's file isn't read)
    const named = (await runWith(files, { env: "stage" }, { stage: { API_KEY: "k" } })).run;
    assert.deepEqual(named.error.all.map((p) => p.message), [
      '{{env.who}} isn\'t set: the environment "stage" has no who',
      '{{env.base_url}} isn\'t set: the environment "stage" has no base_url',
    ]);
    assert.equal(mock.log.length, 0);
  });

  it("values passed are the scope's even where the suite's environments don't name it; so is a name with secrets kept for it; another name is a problem", async () => {
    mock.reset();
    const { run } = await runWith({ "s.hafen.yml": SUITE("environments:\n  local: { unused: 1 }"), "providers/p.yml": PROVIDER }, { env: "stage", environment: stage() }, { "": { API_KEY: "k-every" } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.equal(mock.log[0].headers.authorization, "Bearer k-every", "a secret for every scope");
    // A scope with only secrets (the app's): a choice all the same
    const plain = { "s.hafen.yml": `version: 1\nprovider: { kind: http, url: "${mock.url}/json", headers: { Authorization: "Bearer {{secret.API_KEY}}" }, body: { message: "{{user}}" }, response: { text: $.data.reply } }\nenvironments:\n  local: { unused: 1 }\ntests:\n  - name: a\n    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]\n` };
    const solo = (await runWith(plain, { env: "solo" }, { solo: { API_KEY: "k-solo" } }, ["solo"])).run;
    assert.equal(solo.verdict, "passed", JSON.stringify(solo.error));
    assert.equal(mock.log.at(-1).headers.authorization, "Bearer k-solo");
    const nowhere = (await runWith(plain, { env: "nowhere" }, { "": { API_KEY: "k-every" }, solo: { API_KEY: "k-solo" } }, ["solo"])).run;
    assert.deepEqual(nowhere.error.all.map((p) => p.message), ['there\'s no environment or scope "nowhere" (local)']);
  });

  it("open lists no scopes (the folder's files aren't read); editFile edits a YAML file in place; a conversation's message has its {{env.NAME}}s and {{secret.NAME}}s filled in", async () => {
    const host = memoryHost({
      "s.hafen.yml": SUITE(), "providers/p.yml": PROVIDER,
      "environments/stage.yml": "# the stage scope, as it once was kept\nwho: folder-team\n",
      "config/stage.yml": `# the stage settings\nbase_url: ${mock.url}\nwho: stage-team\n`,
      "config/new.yml": "# nothing yet\n",
    });
    host.secrets = (name, { env } = {}) => ({ stage: { API_KEY: "sk-1" } })[env]?.[name];
    const call = connect(async () => host);
    const opened = await call("open", {});
    assert.equal(opened.scopes, undefined);
    await call("editFile", { file: "config/stage.yml", edits: [{ op: "set", path: ["region"], value: "eu" }] });
    assert.match(host.store.get("config/stage.yml"), /^# the stage settings\nbase_url: .*\nwho: stage-team\nregion: eu\n$/);
    await call("editFile", { file: "config/new.yml", edits: [{ op: "set", path: ["base_url"], value: "http://x" }] });
    assert.equal(host.store.get("config/new.yml"), "# nothing yet\nbase_url: http://x\n");
    mock.reset();
    const environment = { name: "stage", values: { base_url: mock.url, who: "stage-team", region: "eu" } };
    const out = await call("send", { token: "c", providerFile: "providers/p.yml", env: "stage", environment, message: "I'm {{env.who}} in {{env.region}}, key {{secret.API_KEY}}, {{not.a.scope}}" });
    assert.equal(mock.log[0].body.message, "I'm stage-team in eu, key sk-1, {{not.a.scope}}");
    assert.equal(out.record.user, "I'm stage-team in eu, key [redacted], {{not.a.scope}}");
    await assert.rejects(call("send", { token: "c", providerFile: "providers/p.yml", env: "stage", environment, message: "{{env.nope}}" }), /\{\{env\.nope\}\} isn't set: the environment "stage" has no nope/);
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
