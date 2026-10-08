// Environments and secrets, the review's fixes (contracts/test-file.md, Environments and secrets): a
// passed environment ({ name, values }, name "" for the app's "no scope") never falls back to a
// suite's first; a run and a message choose alike; secrets looked up once per run (and per message);
// only the chosen environment's block is read for the names it needs; carried and seeded turns sent
// with their message filled in again, never "[redacted]"; KEY= # note is empty; one rule for names;
// a host's own text only; every secret the host knows hidden, used or not; a plugin has no fetch of
// its own; and what's redacted isn't redacted again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAME, parseEnvText } from "../../engine/env-file.js";
import { createConversation } from "../../engine/explore.js";
import { loadSuite, secretUses, envUses } from "../../engine/files/suite-file.js";
import { noNetwork } from "../../engine/plugin-worker-core.js";
import { createRedactor } from "../../engine/redact.js";
import { environmentOf, runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { createScope, MissingVariable } from "../../engine/vars.js";
import { fromProcess, nodeHost, secretsFrom } from "../../cli/node-host.js";
import { fakeTransport, memoryHost } from "../helpers.js";

const NO_ENV = "isn't set: no environment is chosen (the app's scope, or --env <file> in the CLI)";
const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);
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
const GLOBAL = { name: "", values: { base_url: "https://global.example" } };
const sent = (transport) => transport.requests.map((r) => `${r.url} ${r.headers.Authorization}`);

describe("an environment passed never falls back to the suite's first (bug 1)", () => {
  it("environmentOf: passed, the suite's of its name only; null, none; not passed, --env's name, else the first", () => {
    const suite = { data: { environments: { staging: { a: 1 }, prod: { a: 2 } } } };
    assert.deepEqual(environmentOf(suite, { environment: GLOBAL }), { envName: null, environment: { name: "", values: GLOBAL.values, suite: {} } });
    assert.deepEqual(environmentOf(suite, { environment: { name: "prod", values: { b: 3 } } }), { envName: "prod", environment: { name: "prod", values: { b: 3 }, suite: { a: 2 } } });
    // (a name the suite has no environment of: none of its)
    assert.deepEqual(environmentOf(suite, { environment: { name: "qa", values: {} } }).environment.suite, {});
    assert.deepEqual(environmentOf(suite, { environment: null }), { envName: null, environment: null });
    // (passed, env is the passed one's name: the app sends both)
    assert.equal(environmentOf(suite, { env: "prod", environment: GLOBAL }).envName, null);
    // Not passed: --env's name, else the first (the CLI with no --env)
    assert.equal(environmentOf(suite, { env: "prod" }).environment.suite.a, 2);
    assert.equal(environmentOf(suite, {}).envName, "staging");
    assert.deepEqual(environmentOf({}, {}), { envName: null, environment: null });
  });

  it("a run with no scope ({ name: \"\", values }) sends with those values and every scope's secrets, never the first environment's", async () => {
    const { run, transport, lookups } = await runFiles(FILES, { options: { environment: GLOBAL }, secrets: SECRETS });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(sent(transport), ["https://global.example/chat Bearer sk-every-scope-0000"]);
    assert.deepEqual([...new Set(lookups)], ["API_KEY@null"]);
    assert.equal(run.settings.env, null);
    // A {{env.NAME}} only the suite's environments have: not set, nothing sent
    const bare = await runFiles(FILES, { options: { environment: { name: "", values: {} } }, secrets: SECRETS });
    assert.deepEqual(at(bare.run.error.all), ["providers/p.yml:2:7  {{env.base_url}} isn't set: the environment has no base_url"]);
    assert.equal(bare.transport.requests.length, 0);
  });

  it("environment null: none chosen (not the suite's first); a scope: its own, its values over the suite's", async () => {
    const none = await runFiles(FILES, { options: { environment: null }, secrets: SECRETS });
    assert.deepEqual(at(none.run.error.all), [`providers/p.yml:2:7  {{env.base_url}} ${NO_ENV}`]);
    assert.equal(none.transport.requests.length, 0);
    const prod = await runFiles(FILES, { options: { env: "prod", environment: { name: "prod", values: {} } }, secrets: SECRETS });
    assert.deepEqual(sent(prod.transport), ["https://prod.example/chat Bearer sk-prod-2222"]);
    const merged = await runFiles(FILES, { options: { environment: { name: "prod", values: { base_url: "https://mine.example" } } }, secrets: SECRETS });
    assert.deepEqual(sent(merged.transport), ["https://mine.example/chat Bearer sk-prod-2222"]);
  });

  it("a {{name}} only the suite's environments give, with no scope (or another): said before anything is sent, where it's used", async () => {
    const suite = SUITE.replace("staging: { base_url: \"https://staging.example\" }", "staging: { base_url: \"https://staging.example\", label: s }").replace("turns: [{ user: hi }]", "turns: [{ user: \"hi {{label}}\" }]");
    const files = { ...FILES, "s.hafen.yml": suite };
    const none = await runFiles(files, { options: { environment: GLOBAL }, secrets: SECRETS });
    assert.deepEqual(at(none.run.error.all), [`s.hafen.yml:${where(suite, "{{label}}")}  {{label}} isn't set: of the suite's environments, "staging" gives it, and none of them is chosen`]);
    assert.equal(none.transport.requests.length, 0);
    const prod = await runFiles(files, { options: { environment: { name: "prod", values: {} } }, secrets: SECRETS });
    assert.deepEqual(prod.run.error.all.map((p) => p.message), ['{{label}} isn\'t set: of the suite\'s environments, "staging" gives it, not "prod"']);
    // Its own, a --var or a variable: set
    for (const options of [{ environment: { name: "staging", values: {} } }, { environment: GLOBAL, vars: { label: "v" } }]) {
      const { run } = await runFiles(files, { options, secrets: SECRETS });
      assert.equal(run.status, "done", JSON.stringify(run.error));
    }
  });

  it("passed nothing (the CLI with no --env): the suite's first environment, as before", async () => {
    const { run, transport } = await runFiles(FILES, { secrets: SECRETS });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(sent(transport), ["https://staging.example/chat Bearer sk-staging-1111"]);
  });

  it("a conversation's message chooses as a run does: the same environment, the same secrets", async () => {
    for (const [environment, want] of [
      [GLOBAL, "https://global.example/chat Bearer sk-every-scope-0000"],
      [{ name: "prod", values: {} }, "https://prod.example/chat Bearer sk-prod-2222"],
      [undefined, "https://staging.example/chat Bearer sk-staging-1111"],
    ]) {
      const { host, transport } = hostWith(FILES, { secrets: SECRETS });
      const { call } = connect(host);
      await call("open", {});
      await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: environment?.name, ...(environment !== undefined ? { environment } : {}), message: "hi" });
      const ran = await runFiles(FILES, { options: environment !== undefined ? { environment } : {}, secrets: SECRETS });
      assert.deepEqual(sent(transport), [want], JSON.stringify(environment));
      assert.deepEqual(sent(ran.transport), [want], JSON.stringify(environment));
    }
    // None chosen: both say so, and send nothing
    const { host, transport } = hostWith(FILES, { secrets: SECRETS });
    const { call } = connect(host);
    await call("open", {});
    const out = await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", environment: null, message: "hi" });
    assert.equal(out.record.error, `{{env.base_url}} ${NO_ENV}`);
    assert.equal(transport.requests.length, 0);
  });
});

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

describe("only the chosen environment's block is read for the names it needs (bug 3)", () => {
  const files = {
    "providers/p.yml": PROVIDER,
    "s.hafen.yml": `version: 1\nname: s\nprovider: providers/p.yml\nenvironments:\n  staging: { base_url: "https://staging.example" }\n  prod: { base_url: "https://prod.example", extra: "{{secret.PROD_ONLY_KEY}}", region: "{{env.PROD_REGION}}" }\ntests:\n  - name: t\n    turns: [{ user: hi }]\n`,
  };

  it("a secret or {{env.NAME}} only another environment's values name doesn't stop the run", async () => {
    const { run, transport } = await runFiles(files, { options: { env: "staging", environment: { name: "staging", values: {} } }, secrets: { staging: { API_KEY: "sk-staging-1111" } } });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(transport.requests.length, 1);
    // Its own: they do
    const prod = await runFiles(files, { options: { environment: { name: "prod", values: {} } }, secrets: { prod: { API_KEY: "sk-prod-2222" } } });
    assert.deepEqual(prod.run.error.all.map((p) => p.message), ['{{env.PROD_REGION}} isn\'t set: the environment "prod" has no PROD_REGION']);
    const prodEnv = await runFiles(files, { options: { environment: { name: "prod", values: { PROD_REGION: "eu" } } }, secrets: { prod: { API_KEY: "sk-prod-2222" } } });
    assert.deepEqual(prodEnv.run.error.all.map((p) => p.message), ['{{secret.PROD_ONLY_KEY}} isn\'t set for the scope "prod"']);
  });

  it("secretUses and envUses: the chosen one's block (none for null); every block when none is said (a pack's list)", async () => {
    const { host } = hostWith(files);
    const suite = await loadSuite(host, "s.hafen.yml");
    const names = (uses) => uses.map((u) => u.name).sort();
    assert.deepEqual(names(secretUses(suite)), ["API_KEY", "PROD_ONLY_KEY"]);
    assert.deepEqual(names(secretUses(suite, { name: "staging" })), ["API_KEY"]);
    assert.deepEqual(names(secretUses(suite, { name: "prod" })), ["API_KEY", "PROD_ONLY_KEY"]);
    assert.deepEqual(names(secretUses(suite, null)), ["API_KEY"]);
    assert.deepEqual(names(envUses(suite)), ["PROD_REGION", "base_url"]);
    assert.deepEqual(names(envUses(suite, { name: "" })), ["base_url"]);
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

describe("KEY=VALUE files: KEY= # note is empty (bug 6)", () => {
  it("a # after the = and a space is a comment; right after the =, it's the value's", () => {
    assert.deepEqual(parseEnvText("A= # not set yet\nB=   #x\nC=#fragment\nD=a#b\nE=a # note\nF=\n").values, { A: "", B: "", C: "#fragment", D: "a#b", E: "a", F: "" });
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

describe("every secret the host knows is hidden, used or not (bug 14)", () => {
  const KNOWN = "sk-known-unused-5555";
  const echo = () => ({ body: JSON.stringify({ a: `the key is ${KNOWN}` }) });

  it("a run: a reply that echoes a secret the run never sent hides it, in the run and in every event", async () => {
    const asked = [];
    const { run, events } = await runFiles(FILES, {
      options: { environment: { name: "staging", values: {} } },
      secrets: SECRETS,
      reply: echo,
      hostHook: (host) => { host.knownSecrets = (env) => { asked.push(env); return env === "staging" ? [KNOWN, ""] : []; }; },
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.turns[0].reply, "the key is [redacted]");
    assert.ok(!JSON.stringify(run).includes(KNOWN));
    assert.ok(!JSON.stringify(events).includes(KNOWN));
    assert.deepEqual(asked, ["staging"]);
  });

  it("a conversation: the scope's, asked with each message", async () => {
    const { host, transport } = hostWith(FILES, { secrets: SECRETS, reply: echo });
    const asked = [];
    host.knownSecrets = async (env) => { asked.push(env); return [KNOWN]; };
    const { call, events } = connect(host);
    await call("open", {});
    const out = await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", environment: { name: "prod", values: {} }, message: "hi" });
    assert.equal(transport.requests.length, 1);
    assert.equal(out.record.reply, "the key is [redacted]");
    assert.ok(!JSON.stringify([out, events]).includes(KNOWN));
    assert.deepEqual(asked, ["prod"]);
  });

  it("one that can't be read: the run doesn't go on, and says why", async () => {
    const { run, transport } = await runFiles(FILES, { secrets: SECRETS, hostHook: (host) => { host.knownSecrets = () => { throw new Error("the keystore is locked"); }; } });
    assert.equal(run.status, "error");
    assert.equal(run.error.message, "the secrets to hide couldn't be read: the keystore is locked");
    assert.equal(transport.requests.length, 0);
  });
});

describe("a plugin's worker has no fetch of its own (J)", () => {
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

describe("what's redacted isn't redacted again (K)", () => {
  it("a redactor gives back what it gave, as it is, until a secret is added; then redacts it again", () => {
    const secrets = new Set(["sk-first-1111"]);
    const r = createRedactor({ secrets });
    const out = r.redact({ reply: "sk-first-1111 and sk-later-2222", headers: { authorization: "Bearer x" } });
    assert.deepEqual(out, { reply: "[redacted] and sk-later-2222", headers: { authorization: "[redacted]" } });
    assert.equal(r.redact({ turns: [out] }).turns[0], out);
    secrets.add("sk-later-2222");
    const again = r.redact({ turns: [out] }).turns[0];
    assert.notEqual(again, out);
    assert.equal(again.reply, "[redacted] and [redacted]");
    // (under a "headers" key, never taken as it is: a secret header goes by its name there)
    const h = r.redact({ authorization: "Bearer y" });
    assert.deepEqual(r.redact({ headers: h }).headers, { authorization: "[redacted]" });
  });

  it("a run: a turn's record is the same in the event that says it ended and in the run; a secret a later turn uses is hidden from the first event on", async () => {
    const LATE = "late-secret-7777";
    const files = { "providers/p.yml": "kind: http\nurl: https://x.example/chat\nbody: { message: \"{{user}}\" }\nresponse: { text: $.a }\n", "s.hafen.yml": "version: 1\nname: s\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: one\n      - user: \"{{secret.LATE}}\"\n" };
    const { run, events } = await runFiles(files, { secrets: { "": { LATE } }, reply: () => ({ body: JSON.stringify({ a: `echo ${LATE}` }) }) });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.turns[0].reply, "echo [redacted]");
    assert.ok(!JSON.stringify(run).includes(LATE));
    const ended = events.filter((e) => e.type === "turn:end").map((e) => e.record);
    assert.equal(ended[1], run.turns[1]);
    // (the check before a run looked it up: known before anything was sent, so the first turn's event,
    // before the turn that uses it, hides it too)
    assert.equal(ended[0].reply, "echo [redacted]");
    assert.equal(ended[0], run.turns[0]);
    assert.ok(!JSON.stringify(events).includes(LATE));
  });

  it("a conversation's run, as each message returns it: its earlier turns as they were, the suite read again when it changes", async () => {
    const { host, transport } = hostWith(FILES, { secrets: SECRETS });
    const { call } = connect(host);
    await call("open", {});
    const send = (message) => call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", environment: { name: "staging", values: {} }, message });
    const one = await send("hi");
    const two = await send("{{secret.API_KEY}}");
    assert.equal(two.run.turns.length, 2);
    assert.deepEqual(two.run.turns[0], one.run.turns[0]);
    assert.equal(two.run.turns[1].user, "[redacted]");
    // The suite changed: the next message has its environment as it is now
    host.store.set("s.hafen.yml", SUITE.replace("https://staging.example", "https://staging-2.example"));
    await send("again");
    assert.equal(transport.requests.at(-1).url, "https://staging-2.example/chat");
  });
});
