// The chosen scope reaching the engine (contracts/test-file.md, Scopes): a conversation goes with the
// scope chosen for each message (its environment's values, its secrets, the suite's environment of its
// name, and what its fixtures give), not the one it began in; and a scope that has only secrets is
// one the engine knows of.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { preflight } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { fakeTransport, memoryHost } from "../helpers.js";

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
