// Environments and secrets: {{env.NAME}} and {{secret.NAME}} filled in where a file wrote them and
// nowhere else, one that's missing said where it's first used, secrets looked up once, KEY=VALUE files.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromProcess, nodeHost, secretsFrom } from "../../cli/node-host.js";
import { editEnvText, envValueText, NAME, parseEnvText } from "../../engine/env-file.js";
import { conversationToTest, createConversation } from "../../engine/explore.js";
import { problemsFor, secretUses } from "../../engine/files/needs.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import * as engine from "../../engine/index.js";
import { systemOneRequest } from "../../engine/judges/systemone.js";
import { preflight } from "../../engine/preflight.js";
import { seenSecrets } from "../../engine/redact.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { createScope, MissingVariable } from "../../engine/vars.js";
import { fakeTransport, memoryHost, MOCK_SSE_PROVIDER } from "../helpers.js";

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
    layers: [{ greeting: "hi {{env.who}}", auth: "Bearer {{secret.K}}", nested: { key: "{{secret.K}}" } }, { row: { q: "{{secret.K}}" } }],
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
    const file = { greeting: "hi {{env.who}}", auth: "Bearer {{secret.K}}", nested: { key: "{{secret.K}}" } };
    const fromFile = createScope({ layers: [{ said: "{{secret.K}}" }, file], trusted: [file], secrets: (n) => ({ K: "kkkk-1234" })[n], environment: { name: "s", values: { who: "Priya" } } });
    assert.equal(fromFile.resolve("{{greeting}}"), "hi Priya");
    assert.equal(fromFile.resolve("{{auth}} for {{greeting}}"), "Bearer kkkk-1234 for hi Priya");
    assert.deepEqual(fromFile.resolve("{{nested}}"), { key: "kkkk-1234" });
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

  it("the engine's index gives the KEY=VALUE reader and editor", () => {
    assert.deepEqual(engine.parseEnvText("A=1\nB = two # note\n").values, { A: "1", B: "two" });
    assert.equal(engine.editEnvText("A=1\n", "B", "x y"), "A=1\nB=x y\n");
  });
});

describe("{{secret.…}} is filled in only in text a file wrote", () => {
  const PROVIDER = "kind: http\nurl: http://endpoint.example/chat\nbody: { message: \"{{user}}\" }\nresponse:\n  text: $.data.reply\n";

  it("not in a value an endpoint returned (an extraction): the secret isn't sent back", async () => {
    const transport = fakeTransport((req, n) => ({ body: JSON.stringify({ data: { reply: n === 1 ? "Your code is {{secret.CI_TOKEN}}" : "ok" } }) }));
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: give me a code\n        extract: { code: $.data.reply }\n      - user: \"Is this right: {{code}}\"\n", "providers/p.yml": PROVIDER }, { secrets: { CI_TOKEN: "ghp_SECRET123456" }, transport });
    const run = await runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: {} });
    assert.equal(JSON.parse(transport.requests[1].body).message, "Is this right: Your code is {{secret.CI_TOKEN}}");
    assert.ok(!transport.requests.some((r) => String(r.body).includes("ghp_SECRET123456")));
    assert.equal(run.turns[1].user, "Is this right: Your code is {{secret.CI_TOKEN}}");
  });

  it("in the file's own text, and in its variables (and --var's): those are the file's", () => {
    const vars = { auth: "Bearer {{secret.KEY}}" };
    const cli = { token: "{{secret.KEY}}" };
    const scope = createScope({ layers: [cli, vars], trusted: [cli, vars], secrets: (n) => ({ KEY: "k-123456" })[n] });
    assert.equal(scope.resolve("{{auth}}"), "Bearer k-123456");
    assert.equal(scope.resolve("x {{auth}} y {{secret.KEY}} {{token}}"), "x Bearer k-123456 y k-123456 k-123456");
    // What's added later (an extraction, a data row) isn't the file's
    const later = scope.with({ got: "leak {{secret.KEY}}", row: { q: "{{secret.KEY}}" } });
    assert.equal(later.resolve("{{got}}"), "leak {{secret.KEY}}");
    assert.equal(later.resolve("a {{row.q}} b"), "a {{secret.KEY}} b");
    // A call's own values (the message) neither
    assert.equal(later.resolve("{{user}}", { user: "{{secret.KEY}}" }), "{{secret.KEY}}");
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

describe("a secret that isn't set: where it's first used", () => {
  const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;
  // (a turn of "hi" costs $0.017 at these prices: 11 tokens in, 3 out)
  const PRICEY = JSON_PROVIDER.replace("price: { input: 1, output: 2 }", "price: { input: 1000, output: 2000 }");

  const host = (files, secrets = {}) => memoryHost({ "providers/json.yml": JSON_PROVIDER, "providers/sse.yml": MOCK_SSE_PROVIDER, "providers/pricey.yml": PRICEY, ...files }, { secrets });

  async function load(yaml, files = {}, secrets = {}) {
    const h = host({ "s.hafen.yml": yaml, ...files }, secrets);
    return { host: h, suite: await loadSuite(h, "s.hafen.yml") };
  }

  const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);

  it("in a provider file, in the suite (an inline provider, a setup step), and a preset's key at its kind", async () => {
    const { suite } = await load(`version: 1
provider: providers/keyed.yml
providers:
  judge: anthropic-messages
  inline: { kind: gemini, model: m }
setup:
  - name: log in
    request: { url: "{{base_url}}/login", body: { password: "{{secret.QA_PASSWORD}}" } }
tests:
  - name: a
    provider:
      kind: http
      url: "{{base_url}}/json"
      headers: { x-key: "{{secret.INLINE_KEY}}" }
    turns: [ { user: "hi {{secret.QA_PASSWORD}}" } ]
`, { "providers/keyed.yml": `# a provider with a key
kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.ACME_KEY}}" }
` });
    assert.deepEqual(suite.errors, []);
    const problems = problemsFor(suite, { base_url: "x" }, () => undefined);
    assert.deepEqual(at(problems), [
      "s.hafen.yml:8:62  {{secret.QA_PASSWORD}} isn't set",
      "s.hafen.yml:14:26  {{secret.INLINE_KEY}} isn't set",
      "s.hafen.yml:4:10  {{secret.ANTHROPIC_API_KEY}} isn't set",
      "s.hafen.yml:5:19  {{secret.GEMINI_API_KEY}} isn't set",
      "providers/keyed.yml:4:35  {{secret.ACME_KEY}} isn't set",
    ]);
    assert.deepEqual(problems.map((p) => p.variable), ["QA_PASSWORD", "INLINE_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "ACME_KEY"]);
    // A preset's kind in a provider file
    const file = await load("version: 1\nprovider: providers/claude.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n", { "providers/claude.yml": "model: claude-x\nkind: anthropic-messages\n" });
    assert.deepEqual(at(problemsFor(file.suite, {}, () => undefined)), ["providers/claude.yml:2:7  {{secret.ANTHROPIC_API_KEY}} isn't set"]);
  });

  it("System One's key at its judge, or with none declared, at the first check that asks it", async () => {
    const asks = `tests:
  - name: a
    turns:
      - user: hi
        expect:
          - { type: systemone.noul, question: "off?", enabled: false }
          - { type: systemone.noul, question: "why?" }
`;
    const judged = await load(`version: 1\nprovider: providers/json.yml\njudges:\n  default:\n    kind: systemone\n${asks}`);
    assert.deepEqual(at(problemsFor(judged.suite, { base_url: "x" }, () => undefined)), ["s.hafen.yml:5:11  {{secret.JEV_API_KEY}} isn't set"]);
    const bare = await load(`version: 1\nprovider: providers/json.yml\n${asks}`);
    assert.deepEqual(at(problemsFor(bare.suite, { base_url: "x" }, () => undefined)), ["s.hafen.yml:9:21  {{secret.JEV_API_KEY}} isn't set"]);
  });

  it("a check turned off isn't a use; a run's check keeps each problem's suite", async () => {
    const { host: h, suite } = await load(`version: 1
provider: providers/json.yml
tests:
  - name: a
    turns:
      - user: hi
        expect:
          - { contains: "{{secret.OFF_KEY}}", enabled: false }
          - { contains: "{{secret.ON_KEY}}" }
`);
    assert.deepEqual(secretUses(suite), [{ name: "ON_KEY", file: "s.hafen.yml", line: 9, column: 26 }]);
    const checked = await preflight({ suites: [suite], host: h, options: { vars: { base_url: "x" } } });
    checked.close();
    assert.deepEqual(checked.problems, [{ file: "s.hafen.yml", line: 9, column: 26, variable: "ON_KEY", message: "{{secret.ON_KEY}} isn't set", suite: "s.hafen.yml" }]);
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

describe("a folder's environments", () => {
  const PASSED = { name: "stage", values: { base_url: "https://passed.example", who: "passed-team" } };

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
    // A name with no environment passed: chosen as a run chooses, the suite's environment of that name,
    // with no values (the folder's environments/stage.yml isn't read)
    await assert.rejects(call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "stage", message: "{{env.region}}" }), /\{\{env\.region\}\} isn't set: the environment "stage" has no region/);
    assert.equal(transport.requests.length, sent);
  });

  it("preflight takes it too: the problems a run would have, and the suite's warnings", async () => {
    const { host } = hostWith(files, { secrets: SECRETS });
    const call = connect(async () => host);
    await call("open", {});
    const [checked] = await call("preflight", { files: ["s.hafen.yml"], env: "stage", environment: { name: "stage", values: { base_url: "x" } } });
    assert.deepEqual(checked.problems.map((p) => p.message), ['{{env.region}} isn\'t set: the environment "stage" has no region']);
    assert.match(checked.warnings.map((w) => w.message).join("\n"), /"a" has no checks/);
    const [fine] = await call("preflight", { files: ["s.hafen.yml"], env: "stage", environment: STAGE });
    assert.deepEqual(fine.problems, []);
    // run: environment beside the options
    const run = await call("run", { token: "r", files: ["s.hafen.yml"], options: {}, env: "stage", environment: STAGE });
    assert.equal(run.status, "done", JSON.stringify(run.error));
  });
});

describe("conversations", () => {
  // The engine behind a port, as the app has it: call(cmd, args), and the log lines it sends
  function connect(host) {
    let handler;
    const waiting = new Map();
    const logs = [];
    let next = 1;
    servePort({ receive: (h) => { handler = h; }, send: (m) => { if (m.log) logs.push(m.log); waiting.get(m.id)?.(m); } }, async () => host);
    const call = (cmd, args) => new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
      handler({ id, cmd, args });
    });
    return { call, logs };
  }

  it("\"save as test\" keeps the message as typed ({{env.NAME}}, {{secret.NAME}}), and the turn's start shows it redacted", async () => {
    const transport = fakeTransport(() => ({ body: '{"r":"ok"}' }));
    const host = memoryHost({}, { secrets: { order_token: "tok_live_123456" }, transport });
    const events = [];
    const c = createConversation({ host, providerConfig: { kind: "http", url: "http://e/chat", body: { m: "{{user}}" }, response: { text: "$.r" } }, scopeValues: { name: "stage", values: { customer: "cust-42" } }, onEvent: (e) => events.push(e) });
    c.setScope({ name: "stage", values: { customer: "cust-42" } });
    await c.send("look up {{env.customer}} with {{secret.order_token}}");
    assert.equal(JSON.parse(transport.requests[0].body).m, "look up cust-42 with tok_live_123456");
    assert.equal(events.find((e) => e.type === "turn:start").user, "look up cust-42 with [redacted]");
    assert.equal(conversationToTest(c.run, { name: "t" }).turns[0].user, "look up {{env.customer}} with {{secret.order_token}}");
  });

  it("with a scope the suite has no environment for, a conversation gets none of its variables (as a run)", async () => {
    const transport = fakeTransport(() => ({ body: '{"data":{"reply":"ok"}}' }));
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\nenvironments:\n  local: { who: local-one }\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n", "providers/p.yml": "kind: http\nurl: http://e/chat\nbody: { m: \"{{user}}\", who: \"{{who}}\" }\nresponse: { text: $.data.reply }\n" }, { transport });
    const { call } = connect(host);
    await call("open", {});
    // (the turn's error: nothing's sent)
    const stage = await call("send", { token: "c1", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "stage", message: "hi" });
    assert.match(stage.record.error, /\{\{who\}\} isn't set/);
    assert.equal(transport.requests.length, 0);
    await call("send", { token: "c2", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "local", message: "hi" });
    assert.equal(JSON.parse(transport.requests.at(-1).body).who, "local-one");
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

describe("secrets looked up once, filled in again, and named by one rule", () => {
  // Where a text is in a file: "line:column"
  const where = (text, needle) => {
    const before = text.slice(0, text.indexOf(needle));
    return `${before.split("\n").length}:${before.length - before.lastIndexOf("\n")}`;
  };

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
  // A pretend port: call(cmd, args) → the engine's answer
  function connect(host) {
    let handler;
    const waiting = new Map();
    let next = 1;
    const events = [];
    servePort({ receive: (h) => { handler = h; }, send: (m) => { if (m.event) events.push(m.event); waiting.get(m.id)?.(m); } }, async () => host);
    const call = (cmd, args) => new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
      handler({ id, cmd, args });
    });
    return { call, events };
  }

  const PROVIDER = `kind: http
url: "{{env.base_url}}/chat"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
body: { message: "{{user}}" }
response: { text: $.a }
`;
  const SUITE = `version: 1
name: s
provider: providers/p.yml
environments:
  staging: { base_url: "https://staging.example" }
  prod: { base_url: "https://prod.example" }
tests:
  - name: t
    turns: [{ user: hi }]
`;
  const FILES = { "providers/p.yml": PROVIDER, "s.hafen.yml": SUITE };
  const SECRETS = { "": { API_KEY: "sk-every-scope-0000" }, staging: { API_KEY: "sk-staging-1111" }, prod: { API_KEY: "sk-prod-2222" } };

  describe("secrets looked up once per run, and once per message (bug 2)", () => {
    const THREE = { "providers/p.yml": PROVIDER, "s.hafen.yml": "version: 1\nname: s\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns: [{ user: one }, { user: two }, { user: three }]\n" };
    const STAGING = { name: "staging", values: { base_url: "https://staging.example" } };

    it("a scope's secrets moved while the run goes: its later turns send what the first did", async () => {
      const secrets = structuredClone(SECRETS);
      const { run, transport, lookups } = await runFiles(THREE, {
        options: { environment: STAGING },
        secrets,
        reply: (req, n) => {
          if (n === 1) {
            secrets.stage = secrets.staging;
            delete secrets.staging;
          }
          return { body: JSON.stringify({ a: "ok" }) };
        },
      });
      assert.equal(run.status, "done", JSON.stringify(run.error));
      assert.deepEqual(transport.requests.map((r) => r.headers.Authorization), Array(3).fill("Bearer sk-staging-1111"));
      assert.deepEqual(lookups, ["API_KEY@staging"]);
    });

    it("a conversation's message looks each up once, and the next message again (an edit applies from then)", async () => {
      const secrets = structuredClone(SECRETS);
      const { host, transport, lookups } = hostWith(THREE, { secrets });
      const { call } = connect(host);
      await call("open", {});
      const send = () => call("send", { token: "c", providerFile: "providers/p.yml", environment: STAGING, message: "{{secret.API_KEY}} {{secret.API_KEY}}" });
      await send();
      assert.deepEqual(lookups, ["API_KEY@staging"]);
      secrets.staging.API_KEY = "sk-staging-edited";
      await send();
      assert.deepEqual(transport.requests.map((r) => r.headers.Authorization), ["Bearer sk-staging-1111", "Bearer sk-staging-edited"]);
      assert.equal(lookups.length, 2);
    });
  });

  describe("carried and seeded turns are sent with their message filled in again (bug 4)", () => {
    const HISTORY = `kind: http
url: "https://x.example/chat"
body: { messages: "{{messages}}" }
response: { text: $.a }
`;
    const TOKEN = "tok-778899aabb";

    it("run this turn only: a turn carried from the last run (kept redacted) is history with its secret, not \"[redacted]\"", async () => {
      const files = { "providers/p.yml": HISTORY, "s.hafen.yml": "version: 1\nname: s\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: \"my token is {{secret.ORDER_TOKEN}}\"\n      - user: and again\n" };
      const secrets = { "": { ORDER_TOKEN: TOKEN } };
      const full = await runFiles(files, { secrets });
      assert.equal(full.run.turns[0].user, "my token is [redacted]");
      const only = await runFiles(files, { secrets, options: { onlyTurn: 1, carry: { t: [full.run.turns[0]] } } });
      assert.equal(only.run.status, "done", JSON.stringify(only.run.error));
      assert.equal(only.transport.requests.length, 1);
      assert.deepEqual(JSON.parse(only.transport.requests[0].body).messages[0], { role: "user", content: `my token is ${TOKEN}` });
      // (stored, it's redacted all the same)
      assert.equal(only.run.turns[0].user, "my token is [redacted]");
      assert.equal(only.run.turns[0].carried, "last run");
      assert.ok(!JSON.stringify(only.run).includes(TOKEN));
    });

    it("a seeded conversation (the app's kept run) sends its typed {{secret.…}} filled in again; one the scope hasn't stops the message", async () => {
      const transport = fakeTransport(() => ({ body: JSON.stringify({ a: "ok" }) }));
      const host = memoryHost({}, { transport });
      host.secrets = (name) => ({ ORDER_TOKEN: TOKEN })[name];
      const providerConfig = { kind: "http", url: "https://x.example/chat", body: { messages: "{{messages}}" }, response: { text: "$.a" } };
      const first = await createConversation({ host, providerConfig, scopeValues: { name: "s", values: {} } }).send("my token is {{secret.ORDER_TOKEN}}");
      assert.equal(first.run.turns[0].user, "my token is [redacted]");
      const seeded = createConversation({ host, providerConfig, scopeValues: { name: "s", values: {} }, seed: first.run });
      await seeded.send("and again");
      assert.deepEqual(JSON.parse(transport.requests.at(-1).body).messages[0], { role: "user", content: `my token is ${TOKEN}` });
      // (and kept as it was sent: the next message has it too, looked up no more)
      host.secrets = () => undefined;
      await seeded.send("once more");
      assert.equal(JSON.parse(transport.requests.at(-1).body).messages[0].content, `my token is ${TOKEN}`);
      // A scope that hasn't the secret: said, and nothing sent
      const before = transport.requests.length;
      const other = createConversation({ host, providerConfig, scopeValues: { name: "s", values: {} }, seed: first.run });
      await assert.rejects(other.send("and again"), /message 1 of the conversation, sent again as its history: \{\{secret\.ORDER_TOKEN\}\} isn't set for the scope "s"/);
      assert.equal(transport.requests.length, before);
      assert.ok(!transport.requests.some((r) => r.body.includes("[redacted]")));
    });
  });

  describe("one rule for names (bug 7)", () => {
    it("NAME: letters, digits, _ . -, not starting with a digit", () => {
      for (const name of ["API_KEY", "db.password", "my-key", "_x", "a1"]) assert.ok(NAME.test(name), name);
      for (const name of ["1KEY", "-x", ".x", "a b", ""]) assert.ok(!NAME.test(name), name);
    });

    it("a {{secret.NAME}} or {{env.NAME}} whose NAME isn't one is a problem where it's written, in the suite and in its provider file", async () => {
      const provider = PROVIDER.replace("{{secret.API_KEY}}", "{{secret.1KEY}}");
      const suite = SUITE.replace("turns: [{ user: hi }]", "turns: [{ user: \"hi {{env.-region}}\" }]");
      const { host } = hostWith({ "providers/p.yml": provider, "s.hafen.yml": suite });
      const loaded = await loadSuite(host, "s.hafen.yml");
      assert.deepEqual(at(loaded.errors), [
        `s.hafen.yml:${where(suite, "{{env.-region}}")}  {{env.-region}}: "-region" isn't a name (letters, digits, _ . -, not starting with a digit)`,
        `providers/p.yml:${where(provider, "{{secret.1KEY}}")}  {{secret.1KEY}}: "1KEY" isn't a name (letters, digits, _ . -, not starting with a digit)`,
      ]);
    });

    it("as it runs (a typed message, a --var's value): said, never looked up", () => {
      const looked = [];
      const scope = createScope({ secrets: (name) => { looked.push(name); return "x"; }, environment: { name: "s", values: { "1x": "y" } } });
      assert.throws(() => scope.typed("{{secret.1KEY}}"), /\{\{secret\.1KEY\}\}: "1KEY" isn't a name/);
      assert.throws(() => scope.resolve("{{env.1x}}"), /\{\{env\.1x\}\}: "1x" isn't a name/);
      assert.deepEqual(looked, []);
      // A dotted or dashed one is a name, as a KEY=VALUE file's is
      assert.equal(createScope({ secrets: (name) => ({ "db.password": "pw-123456" })[name] }).typed("{{secret.db.password}}"), "pw-123456");
    });

    it("a fixture gives a dotted name, and a request uses it", async () => {
      const files = {
        "plugins/login.js": `export default { kind: "fixture", name: "login", version: "1.0.0", provides: ["db.password"], async run() { return { "db.password": "pw-fixture-4242" }; } };`,
        "providers/p.yml": "kind: http\nurl: https://x.example/chat\nheaders: { X-Pass: \"{{secret.db.password}}\" }\nbody: { message: \"{{user}}\" }\nresponse: { text: $.a }\nfixtures: { beforeAll: [login] }\n",
        "s.hafen.yml": "version: 1\nname: s\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns: [{ user: hi }]\n",
      };
      const { run, transport } = await runFiles(files);
      assert.equal(run.status, "done", JSON.stringify(run.error));
      assert.equal(transport.requests[0].headers["X-Pass"], "pw-fixture-4242");
    });
  });

  describe("a host's secrets: its own text only (bug 8)", () => {
    it("the command line's: a name its prototype has isn't set (constructor, toString, __proto__)", () => {
      const secrets = secretsFrom({ API_KEY: "k-123456" });
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        assert.equal(secrets(name), undefined, name);
        assert.equal(fromProcess(name), undefined, name);
      }
      assert.equal(secrets("API_KEY"), "k-123456");
      assert.equal(nodeHost({ root: "." }).secrets("constructor"), undefined);
    });

    it("the engine takes only text from any host: anything else is a secret not set", async () => {
      const scope = createScope({ secrets: (name) => ({}[name]) });
      assert.throws(() => scope.resolve("{{secret.constructor}}"), MissingVariable);
      const { run, transport } = await runFiles(FILES, { options: { environment: { name: "staging", values: {} } }, hostHook: (host) => { host.secrets = () => Object; } });
      assert.deepEqual(run.error.all.map((p) => p.message), ['{{secret.API_KEY}} isn\'t set for the scope "staging"']);
      assert.equal(transport.requests.length, 0);
    });
  });

  describe("a scope made from another keeps where its secrets come from (bug 12)", () => {
    it("a --var's {{secret.NAME}} that isn't set says where it was looked for", async () => {
      const files = { "providers/p.yml": "kind: http\nurl: https://x.example/chat\nbody: { message: \"{{user}}\" }\nresponse: { text: $.a }\n", "s.hafen.yml": "version: 1\nname: s\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns: [{ user: \"{{token}}\" }]\n" };
      const { run } = await runFiles(files, { options: { vars: { token: "{{secret.NOPE}}" }, secretsFrom: "not in the --secret file or the environment" } });
      assert.equal(run.turns[0].error, "{{secret.NOPE}} isn't set (not in the --secret file or the environment)");
      const scope = createScope({ secretsFrom: "from here" });
      for (const made of [scope.with({}), scope.withSecrets(new Map())]) assert.throws(() => made.resolve("{{secret.X}}"), /\(from here\)/);
    });
  });
});

describe("KEY=VALUE files", () => {
  it("reads names and values: comments, blank lines, export, spaces, quotes, dotted names", () => {
    const { values, errors } = parseEnvText([
      "# staging",
      "",
      "base_url=https://staging.acme.example/#top",
      "db.host = db.internal  # the database",
      "export REGION=eu",
      "greeting=\"Hello, \\\"you\\\"\\n\"",
      "raw='a # b \\n'",
      "EMPTY=",
    ].join("\n"), "environments/staging.env");
    assert.deepEqual(errors, []);
    assert.deepEqual(values, {
      base_url: "https://staging.acme.example/#top",
      "db.host": "db.internal",
      REGION: "eu",
      greeting: "Hello, \"you\"\n",
      raw: "a # b \\n",
      EMPTY: "",
    });
  });

  it("each problem with its file, line and column: not NAME=value, a bad name, a name set twice, an unclosed quote", () => {
    const { errors } = parseEnvText("A=1\nno equals here\n1x=2\nA=3\nB=\"open\n", "s.env");
    assert.deepEqual(errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.message}`), [
      "s.env:2:1 line 2 isn't NAME=value",
      "s.env:3:1 \"1x\" isn't a name (letters, digits, _ . -, not starting with a digit)",
      "s.env:4:1 A is on line 1 too: a name is set once",
      "s.env:5:3 a value that starts with \" ends with one",
    ]);
  });

  it("edits one name in its place, adds one at the end, takes one out: every other line as it was", () => {
    const text = "# the stage environment\nA=1\n\n# the db\nB=2\n";
    assert.equal(editEnvText(text, "A", "x"), "# the stage environment\nA=x\n\n# the db\nB=2\n");
    assert.equal(editEnvText(text, "C", "3"), "# the stage environment\nA=1\n\n# the db\nB=2\nC=3\n");
    assert.equal(editEnvText(text, "B", null), "# the stage environment\nA=1\n\n# the db\n");
    assert.equal(editEnvText("A=1\r\nB=2\r\n", "A", "x"), "A=x\r\nB=2\r\n");
    assert.throws(() => editEnvText(text, "no spaces", "x"), /isn't a name/);
  });

  it("a value that wouldn't read back as it is is quoted, and reads back the same", () => {
    for (const value of ["plain", "with spaces inside", " padded ", "a #comment", "#start", "quote \" and \\", "two\nlines", ""]) {
      const text = editEnvText("", "K", value);
      assert.equal(parseEnvText(text).values.K, value, `${JSON.stringify(value)} as ${text}`);
    }
    assert.equal(envValueText("https://x.example/#frag"), "https://x.example/#frag");
  });
});

describe("KEY=VALUE files: KEY= # note is empty (bug 6)", () => {
  it("a # after the = and a space is a comment; right after the =, it's the value's", () => {
    assert.deepEqual(parseEnvText("A= # not set yet\nB=   #x\nC=#fragment\nD=a#b\nE=a # note\nF=\n").values, { A: "", B: "", C: "#fragment", D: "a#b", E: "a", F: "" });
  });
});
