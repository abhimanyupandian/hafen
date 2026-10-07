// Environments and secrets (contracts/test-file.md, Environments and secrets): {{env.NAME}} is a value
// of the environment whoever runs the engine passes (options.environment, then the suite's own
// environments.<name>), {{secret.NAME}} (or {{secrets.NAME}}) a secret from the host. Either is filled
// in everywhere text is (a file's fields, a typed message, the values a file gives, a plugin's request
// as it leaves) and never in what came from a reply, a row or an extraction; one that isn't there is
// an error that says why, never sent as written. The old ways (${env:NAME}, {{scope.NAME}},
// { secret: "NAME" }) are problems, each saying the new way, and nothing fills them in; a folder's
// environments/<name>.yml isn't read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as engine from "../../engine/index.js";
import { loadSuite, problemsFor } from "../../engine/files/suite-file.js";
import { systemOneRequest } from "../../engine/judges/systemone.js";
import { seenSecrets } from "../../engine/redact.js";
import { preflight, runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { createScope, MissingVariable } from "../../engine/vars.js";
import { fakeTransport, memoryHost } from "../helpers.js";

const NO_ENV = "isn't set: no environment is chosen (the app's scope, or --env <file> in the CLI)";
const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);

// A host whose secrets are kept per scope ("" for every scope), answering every request with `reply`
function hostWith(files, { secrets = {}, reply = (req) => ({ body: JSON.stringify({ a: `ok ${req.url}` }) }) } = {}) {
  const transport = fakeTransport(reply);
  const host = memoryHost(files, { transport });
  host.secrets = (name, { env } = {}) => secrets[env ?? ""]?.[name] ?? secrets[""]?.[name];
  return { host, transport };
}
async function runFiles(files, { options = {}, secrets, reply } = {}) {
  const { host, transport } = hostWith(files, { secrets, reply });
  const suites = [];
  for (const f of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) suites.push(await loadSuite(host, f));
  const run = await runSuites({ suites, host, options });
  return { run, transport, suites, host };
}
// A pretend port: call(cmd, args) → the engine's answer
function connect(makeHost) {
  let handler;
  const waiting = new Map();
  let next = 1;
  servePort({ receive: (h) => { handler = h; }, send: (m) => { waiting.get(m.id)?.(m); } }, makeHost);
  return (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
}

const PROVIDER = `kind: http
url: "{{env.base_url}}/chat"
headers: { Authorization: "Bearer {{secret.API_KEY}}", X-Alias: "{{secrets.API_KEY}}", X-Region: "{{env.region}}" }
body: { message: "{{user}}" }
response: { text: $.a }
`;
const STAGE = { name: "stage", values: { base_url: "https://stage.acme.example", region: "eu-1" } };
const SECRETS = { stage: { API_KEY: "sk-stage-123456" }, prod: { API_KEY: "sk-prod-654321" } };

describe("{{env.NAME}} and {{secret.NAME}} in a scope", () => {
  const scope = createScope({
    layers: [{ greeting: "hi {{env.who}}", auth: "Bearer {{secret.K}}", nested: { key: "{{secret.K}}" }, legacy: "${env:K}" }, { row: { q: "{{secret.K}}" } }],
    trusted: [],
    secrets: (name) => ({ K: "kkkk-1234", "db.pass": "dotted-secret" })[name],
    environment: { name: "stage", values: { who: "Priya", "db.host": "flat-host", db: { host: "deep-host", port: 5432 }, uses_secret: "token {{secret.K}}" }, suite: { region: "eu-1", who: "from-the-suite" } },
  });

  it("fills each, the alias too, in a whole value (its type kept) and in text; dotted names: the key first", () => {
    assert.equal(scope.resolve("{{env.who}} in {{env.region}}"), "Priya in eu-1");
    assert.equal(scope.resolve("Bearer {{secret.K}} / {{secrets.K}}"), "Bearer kkkk-1234 / kkkk-1234");
    assert.equal(scope.resolve("{{env.db.host}}"), "flat-host", "the key \"db.host\" before db's host");
    assert.equal(scope.resolve("{{env.db.port}}"), 5432, "a whole {{env.…}} keeps its type");
    assert.equal(scope.resolve("{{secret.db.pass}}"), "dotted-secret");
    // (an environment's value is trusted: its own {{secret.…}} is filled in)
    assert.equal(scope.resolve("{{env.uses_secret}}"), "token kkkk-1234");
    assert.ok(scope.secretsUsed.has("kkkk-1234") && seenSecrets.has("kkkk-1234"), "every secret filled in is remembered, to be redacted");
  });

  it("the values given come before the suite's environment of that name", () => {
    assert.equal(scope.resolve("{{env.who}}"), "Priya");
    assert.equal(scope.resolve("{{env.region}}"), "eu-1");
  });

  it("in the values a file wrote (deeply), never in what came from elsewhere (a row, an extraction)", () => {
    // (the layers above aren't trusted: what they bring is as it was)
    assert.equal(scope.resolve("{{greeting}}"), "hi {{env.who}}");
    assert.equal(scope.resolve("{{row.q}}"), "{{secret.K}}");
    const file = { greeting: "hi {{env.who}}", auth: "Bearer {{secret.K}}", nested: { key: "{{secret.K}}" }, legacy: "${env:K}" };
    const fromFile = createScope({ layers: [{ said: "{{secret.K}}" }, file], trusted: [file], secrets: (n) => ({ K: "kkkk-1234" })[n], environment: { name: "s", values: { who: "Priya" } } });
    assert.equal(fromFile.resolve("{{greeting}}"), "hi Priya");
    assert.equal(fromFile.resolve("{{auth}} for {{greeting}}"), "Bearer kkkk-1234 for hi Priya");
    assert.deepEqual(fromFile.resolve("{{nested}}"), { key: "kkkk-1234" });
    // (an old way's ${env:…}, though a file wrote it, is filled in no more)
    assert.throws(() => fromFile.resolve("{{legacy}}"), { message: "${env:K} is the old way to write a secret: write {{secret.K}}" });
    // (an extraction's: as it was, and what a plugin's request mustn't fill in)
    assert.equal(fromFile.resolve("{{said}}"), "{{secret.K}}");
    assert.deepEqual(fromFile.tainted(), ["{{secret.K}}"]);
  });

  it("one that isn't there is an error saying why", () => {
    const err = (fn) => { try { fn(); } catch (e) { return [e instanceof MissingVariable, e.message, e.variable]; } return null; };
    assert.deepEqual(err(() => scope.resolve("{{env.nope}}")), [true, "{{env.nope}} isn't set: the environment \"stage\" has no nope", "env.nope"]);
    assert.deepEqual(err(() => scope.resolve("x {{secret.NOPE}}")), [true, "{{secret.NOPE}} isn't set for the scope \"stage\"", "NOPE"]);
    assert.deepEqual(err(() => scope.resolve("{{secrets.NOPE}}")), [true, "{{secret.NOPE}} isn't set for the scope \"stage\"", "NOPE"]);
    const none = createScope({ secrets: () => undefined, environment: null });
    assert.deepEqual(err(() => none.resolve("{{env.base_url}}/chat")), [true, `{{env.base_url}} ${NO_ENV}`, "env.base_url"]);
    assert.deepEqual(err(() => none.resolve("{{secret.K}}")), [true, "{{secret.K}} isn't set", "K"]);
    // (an environment's value that uses itself)
    const loop = createScope({ environment: { name: "s", values: { a: "x {{env.b}}", b: "{{env.a}}" } } });
    assert.throws(() => loop.resolve("{{env.a}}"), /\{\{env\.a\}\} uses itself \(\{\{env\.a\}\} → \{\{env\.b\}\} → \{\{env\.a\}\}\)/);
  });

  it("a message typed in a conversation: its {{env.…}} and {{secret.…}} filled in, its other {{…}} as typed", () => {
    assert.equal(scope.typed("I'm {{env.who}}, key {{secret.K}}, {{user}} {{not.one}}"), "I'm Priya, key kkkk-1234, {{user}} {{not.one}}");
    assert.throws(() => scope.typed("{{env.nope}}"), /\{\{env\.nope\}\} isn't set: the environment "stage" has no nope/);
  });

  it("what a plugin is given: settings with {{env.…}} filled in and {{secret.…}} as written; env, the environment's values", () => {
    assert.deepEqual(scope.plain({ url: "https://{{env.region}}.acme.example", key: "Bearer {{secret.K}}", alias: "{{secrets.K}}", whole: "{{env.db.port}}" }),
      { url: "https://eu-1.acme.example", key: "Bearer {{secret.K}}", alias: "{{secrets.K}}", whole: 5432 });
    assert.throws(() => scope.plain({ url: "{{env.nope}}" }), /\{\{env\.nope\}\} isn't set: the environment "stage" has no nope/);
    assert.deepEqual(scope.envValues(), { region: "eu-1", who: "Priya", "db.host": "flat-host", db: { host: "deep-host", port: 5432 }, uses_secret: "token {{secret.K}}" });
  });

  it("the old ways, ${env:NAME} and {{scope.NAME}}, are filled in no more: each is an error saying the new way", () => {
    const env = { message: "${env:K} is the old way to write a secret: write {{secret.K}}" };
    const scoped = { message: "{{scope.who}} is the old way: write {{env.who}} (a value of the environment) or {{secret.who}} (a secret)" };
    assert.throws(() => scope.resolve("Bearer ${env:K}"), env);
    assert.throws(() => scope.resolve("hi {{scope.who}}"), scoped);
    assert.throws(() => scope.typed("hi {{scope.who}}"), scoped);
    assert.throws(() => scope.plain({ url: "{{scope.who}}" }), scoped);
  });

  it("the engine's index gives the KEY=VALUE reader and editor", () => {
    assert.deepEqual(engine.parseEnvText("A=1\nB = two # note\n").values, { A: "1", B: "two" });
    assert.equal(engine.editEnvText("A=1\n", "B", "x y"), "A=1\nB=x y\n");
  });
});

describe("in a run", () => {
  const SUITE = `version: 1
provider: providers/p.yml
environments:
  stage: { base_url: "https://suite.example", tier: gold, word: ok }
variables:
  auth: "Bearer {{secret.API_KEY}}"
setup:
  - name: log in
    request: { url: "{{env.base_url}}/login", headers: { Authorization: "{{auth}}" }, body: { region: "{{env.region}}", key: "{{secret.API_KEY}}" } }
    extract: { said: $.said }
tests:
  - name: t
    data: data/rows.csv
    turns:
      - user: "{{row.q}} from {{env.region}} ({{env.tier}})"
        extract: { echoed: $.echo }
        expect:
          - { contains: "{{env.word}}" }
      - user: "again {{echoed}} {{said}}"
    teardown:
      - request: { url: "{{env.base_url}}/logout", headers: { X-Key: "{{secrets.API_KEY}}" } }
`;
  const FILES = { "s.hafen.yml": SUITE, "providers/p.yml": PROVIDER, "data/rows.csv": "q\n\"ask {{secret.API_KEY}}\"\n" };
  // (the reply echoes what it's sent, and says a placeholder back)
  const reply = (req) => ({ body: JSON.stringify({ a: "ok", echo: "{{secret.API_KEY}}", said: "{{env.region}}" }) });

  it("fills them in every field (a provider's, a setup step's, a turn's, a check's, a teardown's), from the environment passed; never in a row, an extraction or a reply", async () => {
    const { run, transport } = await runFiles(FILES, { options: { env: "stage", environment: STAGE }, secrets: SECRETS, reply });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "passed", JSON.stringify(run.turns.map((t) => t.results)));
    const [login, first, second, logout] = transport.requests;
    assert.equal(login.url, "https://stage.acme.example/login", "the values passed, before the suite's");
    assert.equal(login.headers.Authorization, "Bearer sk-stage-123456", "a variable's value the file wrote");
    assert.deepEqual(JSON.parse(login.body), { region: "eu-1", key: "sk-stage-123456" });
    assert.equal(first.url, "https://stage.acme.example/chat");
    assert.deepEqual([first.headers.Authorization, first.headers["X-Alias"], first.headers["X-Region"]], ["Bearer sk-stage-123456", "sk-stage-123456", "eu-1"]);
    // The row's {{secret.API_KEY}} is sent as written; the suite's environment gives what the values don't
    assert.equal(JSON.parse(first.body).message, "ask {{secret.API_KEY}} from eu-1 (gold)");
    // What a reply said (an extraction from it, a setup step's) goes as it was
    assert.equal(JSON.parse(second.body).message, "again {{secret.API_KEY}} {{env.region}}");
    assert.equal(logout.url, "https://stage.acme.example/logout");
    assert.equal(logout.headers["X-Key"], "sk-stage-123456");
    // Every secret filled in is redacted from the run
    assert.ok(!JSON.stringify(run).includes("sk-stage-123456"));
    assert.equal(run.settings.env, "stage");
  });

  it("with no values passed, the suite's environment of that name (the first, with none chosen)", async () => {
    const files = { ...FILES, "s.hafen.yml": SUITE.replace("word: ok", "word: ok, region: suite-region") };
    const { run, transport } = await runFiles(files, { secrets: { "": SECRETS.stage }, reply });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(transport.requests[0].url, "https://suite.example/login");
    assert.equal(JSON.parse(transport.requests[1].body).message, "ask {{secret.API_KEY}} from suite-region (gold)");
  });

  it("values passed for an environment the suite has none of are its environment all the same", async () => {
    const { run, transport } = await runFiles({ ...FILES, "s.hafen.yml": SUITE.replace("{{env.tier}}", "x").replace("{{env.word}}", "ok") }, { options: { env: "qa", environment: { name: "qa", values: { base_url: "https://qa.example", region: "us" } } }, secrets: { "": SECRETS.stage }, reply });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(transport.requests[0].url, "https://qa.example/login");
  });

  it("one that isn't there stops the run before anything is sent, said where it's first used", async () => {
    const missing = await runFiles(FILES, { options: { environment: { name: "stage", values: { base_url: "https://x.example" } } }, secrets: SECRETS, reply });
    assert.equal(missing.run.status, "error");
    assert.deepEqual(at(missing.run.error.all), ['s.hafen.yml:9:104  {{env.region}} isn\'t set: the environment "stage" has no region']);
    assert.equal(missing.transport.requests.length, 0);
    const noSecret = await runFiles(FILES, { options: { environment: STAGE }, secrets: {}, reply });
    assert.deepEqual(at(noSecret.run.error.all), ['s.hafen.yml:6:17  {{secret.API_KEY}} isn\'t set for the scope "stage"']);
    // None chosen at all (no values, no name, no environments in the suite)
    const bare = await runFiles({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests: [ { name: t, turns: [ { user: hi } ] } ]\n", "providers/p.yml": PROVIDER }, { secrets: { "": SECRETS.stage } });
    assert.deepEqual(at(bare.run.error.all), [`providers/p.yml:2:7  {{env.base_url}} ${NO_ENV}`, `providers/p.yml:3:99  {{env.region}} ${NO_ENV}`]);
    assert.equal(bare.transport.requests.length, 0);
  });
});

describe("before a run (preflight), and validate", () => {
  const files = {
    "s.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: t
    turns:
      - user: "hi {{env.who}}"
        expect: [ { contains: "{{secret.WANTED}}" } ]
`,
    "providers/p.yml": PROVIDER,
  };
  const check = async (options, secretsFor) => {
    const host = memoryHost(files);
    host.secrets = (name) => ({ API_KEY: "k" })[name];
    const suite = await loadSuite(host, "s.hafen.yml");
    const out = await preflight({ suites: [suite], host, options, ...(secretsFor ? { secretsFor } : {}) });
    out.close();
    return out;
  };

  it("an {{env.NAME}} the environment hasn't is a problem at its first use, whenever an environment is given", async () => {
    assert.deepEqual(at((await check({ environment: { name: "stage", values: { base_url: "x", region: "y" } } })).problems), ['s.hafen.yml:6:19  {{env.who}} isn\'t set: the environment "stage" has no who']);
    // (the suite's first, then its provider file's)
    assert.deepEqual(at((await check({ environment: { name: "stage", values: { base_url: "x" } } }, () => () => "(not checked)")).problems), [
      's.hafen.yml:6:19  {{env.who}} isn\'t set: the environment "stage" has no who',
      'providers/p.yml:3:99  {{env.region}} isn\'t set: the environment "stage" has no region',
    ]);
    // With none, each is said too
    assert.deepEqual(at((await check({}, () => () => "(not checked)")).problems).map((p) => p.split("  ")[1]), [`{{env.who}} ${NO_ENV}`, `{{env.base_url}} ${NO_ENV}`, `{{env.region}} ${NO_ENV}`]);
  });

  it("a {{secret.NAME}} that isn't set: a problem where it's first used, when secrets are checked (always before a run; validate --env-check)", async () => {
    const env = { name: "stage", values: { base_url: "x", region: "y", who: "z" } };
    assert.deepEqual(at((await check({ environment: env })).problems), ['s.hafen.yml:7:32  {{secret.WANTED}} isn\'t set for the scope "stage"']);
    assert.deepEqual((await check({ environment: env }, () => () => "(not checked)")).problems, []);
  });

  it("problemsFor with no environment chosen: each {{env.NAME}} says so", async () => {
    const suite = await loadSuite(memoryHost(files), "s.hafen.yml");
    assert.deepEqual(at(problemsFor(suite, {}, null, null)).map((p) => p.split("  ")[1]), [`{{env.who}} ${NO_ENV}`, `{{env.base_url}} ${NO_ENV}`, `{{env.region}} ${NO_ENV}`]);
    assert.deepEqual(problemsFor(suite, {}, null, undefined), [], "not looked at without one (undefined)");
  });
});

describe("names a suite can't give its own values", () => {
  it("a variable, an environment's value or an extraction named env, secret or secrets is a problem where it's written; a data column isn't", async () => {
    const host = memoryHost({
      "s.hafen.yml": `version: 1
provider: { kind: http, url: "http://x/chat", response: { text: $.a } }
environments:
  stage: { secret: x, ok: y }
variables: { env: 1, env.region: eu, fine: 2 }
setup:
  - request: { url: "http://x/login" }
    extract: { secrets: $.token }
tests:
  - name: t
    data: data/rows.csv
    turns:
      - user: "{{row.env}}"
        extract: { env: $.a }
`,
      "data/rows.csv": "env\nprod\n",
    });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(at(suite.errors), [
      's.hafen.yml:5:14  variables.env: a variable can\'t be called "env" ({{env.NAME}} is a value of the environment): call it something else',
      's.hafen.yml:5:22  variables.env.region: a variable can\'t be called "env.region" ({{env.NAME}} is a value of the environment): call it something else',
      's.hafen.yml:4:12  environments.stage.secret: a variable can\'t be called "secret" ({{secret.NAME}} is a secret): call it something else',
      's.hafen.yml:8:16  setup.0.extract.secrets: an extraction can\'t be called "secrets" ({{secrets.NAME}} is a secret): call it something else',
      's.hafen.yml:14:20  tests.0.turns.0.extract.env: an extraction can\'t be called "env" ({{env.NAME}} is a value of the environment): call it something else',
    ]);
  });
});

describe("the old ways", () => {
  const files = {
    "s.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: t
    turns:
      - user: "hi {{scope.who}} \${env:API_KEY}"
`,
    "providers/p.yml": "kind: http\nurl: \"{{scope.base_url}}/chat\"\nheaders: { X-Key: \"${env:API_KEY}\" }\nbody: { message: \"{{user}}\" }\nresponse: { text: $.a }\n",
  };
  const PASSED = { name: "stage", values: { base_url: "https://passed.example", who: "passed-team" } };

  it("${env:NAME} and {{scope.NAME}} are problems, each once where it's first written, saying the new way: nothing is sent, whatever is set", async () => {
    const { run, transport, suites } = await runFiles(files, { options: { environment: PASSED }, secrets: SECRETS });
    assert.equal(run.status, "error");
    const problems = [
      "s.hafen.yml:6:33  ${env:API_KEY} is the old way to write a secret: write {{secret.API_KEY}}",
      "s.hafen.yml:6:19  {{scope.who}} is the old way: write {{env.who}} (a value of the environment) or {{secret.who}} (a secret)",
      "providers/p.yml:3:20  ${env:API_KEY} is the old way to write a secret: write {{secret.API_KEY}}",
      "providers/p.yml:2:7  {{scope.base_url}} is the old way: write {{env.base_url}} (a value of the environment) or {{secret.base_url}} (a secret)",
    ];
    assert.deepEqual(at(run.error.all), problems);
    assert.equal(transport.requests.length, 0);
    // (the suite's own problems: validate and the app say them as it loads)
    assert.deepEqual(at(suites[0].errors), problems);
    assert.ok(!suites[0].warnings.some((w) => /old way/.test(w.message)));
  });

  it("a folder's environments/<name>.yml isn't read: --env <name> names the environment, with none of the file's values", async () => {
    const folder = {
      "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: \"hi {{env.who}}\"\n",
      "providers/p.yml": "kind: http\nurl: \"{{env.base_url}}/chat\"\nbody: { message: \"{{user}}\" }\nresponse: { text: $.a }\n",
      "environments/stage.yml": "base_url: https://folder.example\nwho: folder-team\n",
    };
    for (const options of [{ env: "stage" }, { env: "stage", environment: null }]) {
      const { run, transport, suites } = await runFiles(folder, { options, secrets: SECRETS });
      assert.deepEqual(at(run.error.all), [
        's.hafen.yml:6:19  {{env.who}} isn\'t set: the environment "stage" has no who',
        'providers/p.yml:2:7  {{env.base_url}} isn\'t set: the environment "stage" has no base_url',
      ]);
      assert.equal(transport.requests.length, 0);
      assert.deepEqual(suites[0].warnings.filter((w) => w.file === "environments/stage.yml"), []);
    }
    // Values passed are the environment's
    const passed = await runFiles(folder, { options: { env: "stage", environment: PASSED }, secrets: SECRETS });
    assert.equal(passed.run.status, "done", JSON.stringify(passed.run.error));
    assert.equal(passed.transport.requests[0].url, "https://passed.example/chat");
    assert.equal(JSON.parse(passed.transport.requests[0].body).message, "hi passed-team");
  });
});

describe("plugins", () => {
  // A provider plugin that sends what its settings say, as they say, and says what it was given
  const PLUGIN = `export default {
  kind: "provider", name: "p", version: "1.0.0", hosts: ["api.acme.example", "stage.acme.example"],
  async *send({ message, history, settings, env, variables, transport, signal }) {
    const res = await transport.fetch({
      url: settings.url ?? "{{env.base_url}}/chat",
      method: "POST",
      headers: { authorization: "Bearer {{secret.API_KEY}}", "x-from-settings": settings.key },
      body: { message, history, deep: [{ key: "{{secrets.API_KEY}}", region: "{{env.region}}" }], text: "env {{env.region}}" },
      signal,
    });
    await res.text();
    yield { type: "text", text: JSON.stringify({ env, settings, said: "{{secret.API_KEY}} " + message }) };
  },
};
`;
  const files = (turns = "      - user: hi") => ({
    "plugins/p.js": PLUGIN,
    "providers/p.yml": "kind: plugin:p\nkey: \"{{secret.API_KEY}}\"\nregion: \"{{env.region}}\"\n",
    "s.hafen.yml": `version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n${turns}\n`,
  });

  it("a request's {{secret.…}} and {{env.…}} are filled in as it leaves (address, headers, body deep); the plugin is given env, never a secret", async () => {
    const { run, transport } = await runFiles(files(), { options: { environment: STAGE }, secrets: SECRETS });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    const [req] = transport.requests;
    assert.equal(req.url, "https://stage.acme.example/chat");
    assert.deepEqual([req.headers.authorization, req.headers["x-from-settings"]], ["Bearer sk-stage-123456", "sk-stage-123456"]);
    const body = JSON.parse(req.body);
    assert.deepEqual([body.deep, body.text], [[{ key: "sk-stage-123456", region: "eu-1" }], "env eu-1"]);
    const given = JSON.parse(run.turns[0].reply.replace(/\[redacted\]/g, "R"));
    assert.deepEqual(given.env, STAGE.values);
    assert.deepEqual(given.settings, { kind: "plugin:p", key: "{{secret.API_KEY}}", region: "eu-1" }, "settings: {{env.…}} filled in, {{secret.…}} as written");
    assert.equal(given.said, "{{secret.API_KEY}} hi", "what the plugin says isn't filled in: only its requests are");
    assert.ok(!JSON.stringify(run).includes("sk-stage-123456"));
  });

  it("not inside what it was given from a reply: the history it sends has a reply's {{secret.…}} as it was", async () => {
    const { run, transport } = await runFiles(files("      - user: first\n      - user: second"), { options: { environment: STAGE }, secrets: SECRETS });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    const sent = JSON.parse(transport.requests[1].body);
    // (the first reply said {{secret.API_KEY}}: in the second request's history, it's as it was)
    assert.match(sent.history[0].reply, /"said":"\{\{secret\.API_KEY\}\} first"/);
    assert.equal(sent.deep[0].key, "sk-stage-123456", "the plugin's own still is");
  });

  it("one not set: a problem before anything is sent, where the plugin's code writes it; one its code can't show, the request fails saying which", async () => {
    const before = await runFiles(files(), { options: { environment: { name: "stage", values: { base_url: "https://stage.acme.example" } } }, secrets: SECRETS });
    assert.deepEqual(at(before.run.error.all), ['providers/p.yml:3:10  {{env.region}} isn\'t set: the environment "stage" has no region']);
    const noKey = await runFiles({ ...files(), "providers/p.yml": "kind: plugin:p\n" }, { options: { environment: STAGE }, secrets: {} });
    assert.deepEqual(at(noKey.run.error.all), [
      'plugins/p.js:7:41  {{secret.API_KEY}} isn\'t set for the scope "stage" (the provider plugin "p" names it)',
    ]);
    // (a name its code builds as it runs)
    const built = PLUGIN.replace('"Bearer {{secret.API_KEY}}"', '"Bearer {{" + "secret.MADE}}"');
    const made = await runFiles({ ...files(), "plugins/p.js": built }, { options: { environment: STAGE }, secrets: SECRETS });
    assert.equal(made.run.turns[0].error, '{{secret.MADE}} isn\'t set for the scope "stage"');
    assert.equal(made.transport.requests.length, 0);
  });

  it("its { secret: NAME } is a problem where its file has it, saying the new way, and nothing is sent; one it builds as it runs fails the request, saying the same", async () => {
    const old = PLUGIN.replace('"Bearer {{secret.API_KEY}}"', '{ secret: "API_KEY", prefix: "Bearer " }');
    const { run, transport } = await runFiles({ ...files(), "plugins/p.js": old }, { options: { environment: STAGE }, secrets: SECRETS });
    assert.deepEqual(at(run.error.all), [
      'plugins/p.js:7:35  { secret: "API_KEY" } is the old way to name a secret: write "{{secret.API_KEY}}" in the request (a header\'s "Bearer {{secret.API_KEY}}")',
    ]);
    assert.equal(transport.requests.length, 0);
    // (a name its code builds as it runs: the request isn't sent)
    const built = PLUGIN.replace('"Bearer {{secret.API_KEY}}"', '{ ["sec" + "ret"]: "API_KEY", prefix: "Bearer " }');
    const made = await runFiles({ ...files(), "plugins/p.js": built }, { options: { environment: STAGE }, secrets: SECRETS });
    assert.match(made.run.turns[0].error, /\{ secret: "API_KEY" \} is the old way to name a secret: write "\{\{secret\.API_KEY\}\}" in the request/);
    assert.equal(made.transport.requests.length, 0);
  });

  it("a check, a judge and a fixture plugin are given env too", async () => {
    const CHECK = `export default { kind: "check", name: "seen", version: "1.0.0", async check({ env }) { return { status: env.region === "eu-1" ? "pass" : "fail", reason: JSON.stringify(env) }; } };`;
    const JUDGE = `export default { kind: "judge", name: "j", version: "1.0.0", hosts: [], async judge({ env }) { return { value: env.region === "eu-1" ? 1 : 0, reason: JSON.stringify(env) }; } };`;
    const LOGIN = `export default { kind: "fixture", name: "login", version: "1.0.0", hosts: ["stage.acme.example"], provides: ["TOKEN"],
  async run({ env, transport }) {
    const res = await transport.fetch({ url: env.base_url + "/login", method: "POST", body: { password: "{{secret.PASSWORD}}", region: env.region } });
    return { TOKEN: "tok-" + (await res.json()).a };
  } };`;
    const { run, transport } = await runFiles({
      "plugins/seen.js": CHECK, "plugins/j.js": JUDGE, "plugins/login.js": LOGIN,
      "providers/p.yml": "kind: http\nurl: \"{{env.base_url}}/chat\"\nfixtures: { before: [login] }\nheaders: { X-Token: \"{{secret.TOKEN}}\" }\nbody: { m: \"{{user}}\" }\nresponse: { text: $.a }\n",
      "s.hafen.yml": "version: 1\nprovider: providers/p.yml\njudges: { mine: { kind: plugin, plugin: j } }\ntests:\n  - name: t\n    turns:\n      - user: hi\n        expect: [ { type: seen }, { type: judge, judge: mine, rubric: fine } ]\n",
    }, { options: { environment: STAGE }, secrets: { stage: { PASSWORD: "pw-stage-1" } } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.turns[0]?.results ?? run.error));
    const [login, chat] = transport.requests;
    assert.deepEqual(JSON.parse(login.body), { password: "pw-stage-1", region: "eu-1" });
    assert.equal(chat.headers["X-Token"], "tok-ok https://stage.acme.example/login");
  });
});

describe("a conversation, the environment passed with each message", () => {
  const files = {
    "s.hafen.yml": "version: 1\nprovider: providers/p.yml\nenvironments:\n  prod: { region: suite-prod }\ntests: [ { name: a, turns: [ { user: hi } ] } ]\n",
    "providers/p.yml": PROVIDER,
    // (the folder's: never read)
    "environments/stage.yml": "base_url: https://folder.example\nregion: folder\n",
  };
  const PROD = { name: "prod", values: { base_url: "https://prod.acme.example" } };

  it("each message goes with the environment passed for it: its values, its secrets and the suite's environment of its name", async () => {
    const { host, transport } = hostWith(files, { secrets: SECRETS });
    const call = connect(async () => host);
    await call("open", {});
    const send = async (environment, message = "hi") => {
      const out = await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: environment?.name ?? null, environment, message });
      const r = transport.requests.at(-1);
      return { url: r.url, key: r.headers.Authorization, region: r.headers["X-Region"], message: JSON.parse(r.body).message, user: out.record.user, template: out.record.user_template };
    };
    assert.deepEqual(await send(STAGE, "{{env.region}} {{secret.API_KEY}}"), { url: "https://stage.acme.example/chat", key: "Bearer sk-stage-123456", region: "eu-1", message: "eu-1 sk-stage-123456", user: "eu-1 [redacted]", template: "{{env.region}} {{secret.API_KEY}}" });
    // Another chosen in the same conversation: all of it is that one's (its region from the suite's prod)
    assert.deepEqual(await send(PROD, "{{env.region}}"), { url: "https://prod.acme.example/chat", key: "Bearer sk-prod-654321", region: "suite-prod", message: "suite-prod", user: "suite-prod", template: "{{env.region}}" });
    // And back
    assert.equal((await send(STAGE)).url, "https://stage.acme.example/chat");
    // None chosen: an {{env.…}} it needs says so, and nothing is sent
    const sent = transport.requests.length;
    await assert.rejects(send(null, "{{env.region}}"), new RegExp(`\\{\\{env\\.region\\}\\} ${NO_ENV.replace(/[()]/g, "\\$&")}`));
    const out = await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: null, environment: null, message: "hi" });
    assert.equal(out.record.error, `{{env.base_url}} ${NO_ENV}`);
    assert.equal(transport.requests.length, sent);
    // A typed {{env.…}} the environment hasn't: the send is refused, saying which
    await assert.rejects(send(STAGE, "{{env.nope}}"), /\{\{env\.nope\}\} isn't set: the environment "stage" has no nope/);
    // A name with no environment passed: none is chosen (the folder's environments/stage.yml isn't read)
    await assert.rejects(call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "stage", message: "{{env.region}}" }), new RegExp(`\\{\\{env\\.region\\}\\} ${NO_ENV.replace(/[()]/g, "\\$&")}`));
    assert.equal(transport.requests.length, sent);
  });

  it("preflight takes it too: the problems a run would have (an old way's among them), and the suite's warnings", async () => {
    const { host } = hostWith(files, { secrets: SECRETS });
    const call = connect(async () => host);
    await call("open", {});
    const [checked] = await call("preflight", { files: ["s.hafen.yml"], env: "stage", environment: { name: "stage", values: { base_url: "x" } } });
    assert.deepEqual(checked.problems.map((p) => p.message), ['{{env.region}} isn\'t set: the environment "stage" has no region']);
    assert.match(checked.warnings.map((w) => w.message).join("\n"), /"a" has no checks/);
    host.store.set("s.hafen.yml", files["s.hafen.yml"].replace("user: hi", "user: \"hi {{scope.region}}\""));
    const [old] = await call("preflight", { files: ["s.hafen.yml"], env: "stage", environment: STAGE });
    assert.deepEqual(old.problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`), ["s.hafen.yml:5:42  {{scope.region}} is the old way: write {{env.region}} (a value of the environment) or {{secret.region}} (a secret)"]);
    host.store.set("s.hafen.yml", files["s.hafen.yml"]);
    const [fine] = await call("preflight", { files: ["s.hafen.yml"], env: "stage", environment: STAGE });
    assert.deepEqual(fine.problems, []);
    // run: environment beside the options
    const run = await call("run", { token: "r", files: ["s.hafen.yml"], options: {}, env: "stage", environment: STAGE });
    assert.equal(run.status, "done", JSON.stringify(run.error));
  });
});

describe("a judge's configuration", () => {
  it("System One's endpoint and key from the environment and a secret", () => {
    const scope = createScope({ secrets: (n) => ({ JEV: "jev-key-1234" })[n], environment: { name: "stage", values: { judge: "https://judge.example/" } } });
    const { request } = systemOneRequest({ judge: { endpoint: "{{env.judge}}", api_key: "{{secret.JEV}}" }, scope, state: "s", questions: {} });
    assert.equal(request.url, "https://judge.example/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer jev-key-1234");
    // (its default key: the secret JEV_API_KEY)
    assert.throws(() => systemOneRequest({ judge: {}, scope, state: "s", questions: {} }), /\{\{secret\.JEV_API_KEY\}\} isn't set for the scope "stage"/);
  });
});
