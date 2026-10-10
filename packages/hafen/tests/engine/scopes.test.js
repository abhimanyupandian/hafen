// Scopes: the environment and secrets chosen for a run or a message (the values passed, then the
// suite's environment of that name, never a folder's file), and a conversation whose scope changes.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { environmentOf } from "../../engine/environment.js";
import { envUses, secretUses } from "../../engine/files/needs.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { preflight } from "../../engine/preflight.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

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

describe("scopes", () => {
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

describe("a scope chosen for each message", () => {
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

  // A host whose secrets are kept per scope, as the app's are ("" for every scope)
  function scopedHost(files, secrets, transport) {
    const host = memoryHost(files, { transport });
    host.secrets = (name, { env } = {}) => secrets[env ?? ""]?.[name] ?? secrets[""]?.[name];
    host.secretScopes = () => Object.keys(secrets).filter((env) => env && Object.keys(secrets[env]).length);
    return host;
  }

  const SUITE = `version: 1
provider: providers/p.yml
environments:
  stage: { tier: s-stage }
  prod: { tier: s-prod }
variables: { customer: Priya }
tests:
  - name: a
    turns: [ { user: hi } ]
`;
  const PROVIDER = `kind: http
url: "http://x/{{env.path}}"
headers: { X-Key: "{{secret.API_KEY}}", X-Tier: "{{tier}}", X-Customer: "{{customer}}" }
body: { message: "{{user}}" }
response: { text: $.a }
`;
  const SECRETS = { stage: { API_KEY: "k-stage" }, prod: { API_KEY: "k-prod" }, "": { SHARED: "every" } };
  const FILES = { "s.hafen.yml": SUITE, "providers/p.yml": PROVIDER };
  // The scopes' environment values, as the app keeps them and passes the chosen one's with each message
  const VALUES = { stage: { path: "stage-path" }, prod: { path: "prod-path" } };
  const scope = (env, values = VALUES[env] ?? {}) => (env ? { env, environment: { name: env, values } } : { env: null, environment: null });

  describe("a conversation, as the scope chosen changes", () => {
    it("each message goes with the scope chosen for it: its plain variables, its secrets and the suite's environment of its name", async () => {
      const transport = fakeTransport(() => ({ body: JSON.stringify({ a: "ok" }) }));
      const call = connect(async () => scopedHost(FILES, SECRETS, transport));
      await call("open", {});
      const sent = async (env, message = "hi") => {
        await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", ...scope(env), message });
        const r = transport.requests.at(-1);
        return { url: r.url, key: r.headers["X-Key"], tier: r.headers["X-Tier"], customer: r.headers["X-Customer"], message: JSON.parse(r.body).message };
      };
      assert.deepEqual(await sent("stage"), { url: "http://x/stage-path", key: "k-stage", tier: "s-stage", customer: "Priya", message: "hi" });
      // Another scope chosen in the same conversation: all of it is that scope's (the suite's
      // environment too, which the conversation used to keep from its first message)
      assert.deepEqual(await sent("prod", "{{env.path}} now"), { url: "http://x/prod-path", key: "k-prod", tier: "s-prod", customer: "Priya", message: "prod-path now" });
      // And back
      assert.deepEqual(await sent("stage"), { url: "http://x/stage-path", key: "k-stage", tier: "s-stage", customer: "Priya", message: "hi" });
    });

    it("the suite's variables are read again for each message, as the provider's are, and the scope's values are each message's", async () => {
      const transport = fakeTransport(() => ({ body: JSON.stringify({ a: "ok" }) }));
      const host = scopedHost(FILES, SECRETS, transport);
      const call = connect(async () => host);
      await call("open", {});
      const send = (values) => call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", ...scope("stage", values), message: "hi" });
      await send();
      assert.equal(transport.requests.at(-1).headers["X-Customer"], "Priya");
      host.store.set("s.hafen.yml", SUITE.replace("customer: Priya", "customer: Arun").replace("tier: s-stage", "tier: s-stage-2"));
      await send({ path: "moved" });
      const r = transport.requests.at(-1);
      assert.deepEqual([r.url, r.headers["X-Customer"], r.headers["X-Tier"]], ["http://x/moved", "Arun", "s-stage-2"]);
    });

    it("a scope's secrets aren't used once another (or none) is chosen", async () => {
      const transport = fakeTransport(() => ({ body: JSON.stringify({ a: "ok" }) }));
      const files = { ...FILES, "providers/p.yml": "kind: http\nurl: http://x/chat\nheaders: { X-Key: \"{{secret.API_KEY}}\" }\nresponse: { text: $.a }\n" };
      const call = connect(async () => scopedHost(files, SECRETS, transport));
      await call("open", {});
      await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", ...scope("stage"), message: "hi" });
      assert.equal(transport.requests.at(-1).headers["X-Key"], "k-stage");
      const out = await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", ...scope(null), message: "hi" });
      assert.match(out.record.error, /\{\{secret\.API_KEY\}\} isn't set/);
      assert.equal(transport.requests.length, 1);
    });

    it("its fixtures run again for another scope, with that scope's secrets; let go, each scope's after and afterAll run", async () => {
      const transport = fakeTransport((req) => (req.url.startsWith("https://auth.example.com/")
        ? { body: JSON.stringify({ token: `tok-${JSON.parse(req.body).password}` }) }
        : { body: JSON.stringify({ a: "ok" }) }));
      // A login (beforeAll) whose password is a secret it names, a session (before), a logout (afterAll)
      const LOGIN = `export default { kind: "fixture", name: "login", version: "1.0.0", hosts: ["auth.example.com"], provides: ["TOKEN"],
  async run({ phase, transport }) {
    const url = "https://auth.example.com/" + phase;
    if (phase === "afterAll") { await transport.fetch({ url, method: "POST", body: { password: "-" } }); return; }
    const res = await transport.fetch({ url, method: "POST", body: { password: "{{secret.PASSWORD}}" } });
    return { TOKEN: (await res.json()).token };
  } };`;
      const SESSION = `export default { kind: "fixture", name: "session", version: "1.0.0", hosts: ["auth.example.com"], provides: ["SESSION"],
  async run({ phase, transport }) {
    if (phase !== "before") return;
    const res = await transport.fetch({ url: "https://auth.example.com/session", method: "POST", body: { password: "{{secret.PASSWORD}}" } });
    return { SESSION: (await res.json()).token };
  } };`;
      const files = {
        ...FILES,
        "providers/p.yml": "kind: http\nurl: http://x/chat\nfixtures: { beforeAll: [login], before: [session], afterAll: [login] }\nheaders: { X-Token: \"{{secret.TOKEN}}\", X-Session: \"{{secret.SESSION}}\" }\nresponse: { text: $.a }\n",
        "plugins/login.js": LOGIN,
        "plugins/session.js": SESSION,
      };
      const secrets = { stage: { PASSWORD: "pw-stage" }, prod: { PASSWORD: "pw-prod" } };
      const call = connect(async () => scopedHost(files, secrets, transport));
      await call("open", {});
      const send = async (env) => {
        transport.requests.length = 0;
        await call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", ...scope(env), message: "hi" });
        return transport.requests.map((r) => (r.url === "http://x/chat" ? `chat ${r.headers["X-Token"]} ${r.headers["X-Session"]}` : `${r.url.slice(25)} ${JSON.parse(r.body).password}`));
      };
      assert.deepEqual(await send("stage"), ["beforeAll pw-stage", "session pw-stage", "chat tok-pw-stage tok-pw-stage"]);
      // (Once per scope: not again for the next message in it)
      assert.deepEqual(await send("stage"), ["chat tok-pw-stage tok-pw-stage"]);
      // Another scope: its own login and session, with its own password (not the first scope's)
      assert.deepEqual(await send("prod"), ["beforeAll pw-prod", "session pw-prod", "chat tok-pw-prod tok-pw-prod"]);
      // Back: what the first scope's fixtures gave
      assert.deepEqual(await send("stage"), ["chat tok-pw-stage tok-pw-stage"]);
      transport.requests.length = 0;
      await call("reset", { token: "c" });
      assert.deepEqual(transport.requests.map((r) => r.url.slice(25)), ["afterAll", "afterAll"]);
    });
  });

  describe("a scope that has only secrets", () => {
    it("is one the engine knows of, from the host's scopes with secrets (CI's host has none): not a problem where the suite's environments don't name it", async () => {
      const check = async (host, env) => {
        const out = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { env }, secretsFor: () => () => "(not checked)" });
        out.close();
        return out.problems.map((p) => p.message);
      };
      const files = { ...FILES, "providers/p.yml": PROVIDER.replace("{{env.path}}", "chat") };
      const host = scopedHost(files, { solo: { API_KEY: "k" }, stage: { API_KEY: "s" }, empty: {} }, null);
      // (known: no "there's no environment or scope". But its provider's {{tier}} only the suite's
      // environments give, and none of them is the scope's: said before a turn needs it)
      assert.deepEqual(await check(host, "solo"), ['{{tier}} isn\'t set: of the suite\'s environments, "stage", "prod" give it, not "solo"']);
      assert.deepEqual(await check(scopedHost({ ...files, "providers/p.yml": files["providers/p.yml"].replace("{{tier}}", "t") }, { solo: { API_KEY: "k" } }, null), "solo"), []);
      assert.deepEqual(await check(host, "empty"), ['there\'s no environment or scope "empty" (stage, prod)', '{{tier}} isn\'t set: of the suite\'s environments, "stage", "prod" give it, not "empty"']);
      assert.deepEqual(await check(memoryHost(files), "solo"), ['there\'s no environment or scope "solo" (stage, prod)', '{{tier}} isn\'t set: of the suite\'s environments, "stage", "prod" give it, not "solo"']);
    });
  });
});
