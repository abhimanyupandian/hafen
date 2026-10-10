// Redaction: a secret hidden however it was encoded, in a run, its events and the page's HTTP log; the
// email, card and phone patterns; and every secret the host knows, used or not.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { createConversation } from "../../engine/explore.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createRedactor, hideSeenSecrets, noteSecret } from "../../engine/redact.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { fakeTransport, memoryHost, sseChunks, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

// A password with a quote (JSON escapes it), a query value with a space, &, =, / and é (a form
// encodes each), and a base64 key with +, / and =
const PW = 'hunter2"x';
const QK = "q k&v=1/é";
const B64 = "aGVsbG8+d29y/bGQ=";
const SECRETS = { PW, QK, B64 };

async function run(files, { secrets = SECRETS, transport } = {}) {
  const host = memoryHost(files, { secrets, ...(transport ? { transport } : {}) });
  const events = [];
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
  const out = await runSuites({ suites: [suite], host, options: {}, onEvent: (e) => events.push(e) });
  return { run: out, events, file: JSON.stringify(out, null, 2) };
}
const SUITE = "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: \"echo {{secret.PW}}\"\n";
// Nothing of any of them, in any form: the run file as written, and every event sent out
const leaks = (text) => ["hunter2", "aHVudGVyMi", "q k", "q+k", "q%20k", "v%3D1", "aGVsbG8"].filter((s) => text.includes(s));

describe("a secret is redacted however it was encoded", () => {
  it("in a run's record: JSON-escaped in the body sent and the stream that echoes it, form-encoded in a query, a base64 key's + / =", async () => {
    const { run: r, events, file } = await run({
      "providers/p.yml": `kind: http
url: "${mock.url}/sse"
query: { key: "{{secret.QK}}", b64: "{{secret.B64}}" }
body: { message: "{{user}}", password: "{{secret.PW}}" }
stream: sse
events:
  - when: { $.type: text_delta }
    text: $.delta
`,
      "s.hafen.yml": SUITE,
    });
    // Each went as it should
    assert.equal(mock.log[0].query, `?${new URLSearchParams({ key: QK, b64: B64 })}`);
    assert.equal(mock.log[0].body.password, PW);
    assert.equal(r.turns[0].reply, `You said: echo ${PW}`.replace(PW, "[redacted]"));
    // The record has none of them, as sent or as the stream echoed them (its raw chunks are JSON)
    assert.equal(r.turns[0].request.url, `${mock.url}/sse?key=[redacted]&b64=[redacted]`);
    assert.equal(r.turns[0].request.body, '{"message":"echo [redacted]","password":"[redacted]"}');
    assert.match(r.turns[0].response.chunks.join(""), /\[redacted\]/);
    assert.deepEqual(leaks(file), []);
    assert.deepEqual(events.filter((e) => leaks(JSON.stringify(e)).length).map((e) => e.type), []);
  });

  it("in a reply: JSON in a JSON string (escaped twice), \\u escapes, base64 in Basic auth, a percent-encoded address; split across the raw stream's chunks", async () => {
    const basic = btoa(`user:${PW}`);
    const said = [
      JSON.stringify({ config: JSON.stringify({ pw: PW }) }),
      JSON.stringify(QK).replace("é", "\\u00e9"),
      `Basic ${basic}`,
      encodeURI(`https://x.example/?q=${QK}`),
      encodeURIComponent(QK),
      btoa(B64).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
    ];
    const transport = fakeTransport(() => ({ headers: { "content-type": "text/event-stream" }, chunks: sseChunks([...said.map((delta) => ({ type: "text_delta", delta: `${delta}\n` })), "[DONE]"]) }));
    const { run: r, file } = await run({
      "providers/p.yml": "kind: http\nurl: http://x.example/chat\nquery: { key: \"{{secret.QK}}\", b64: \"{{secret.B64}}\" }\nbody: { message: \"{{user}}\" }\nstream: sse\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n",
      "s.hafen.yml": SUITE,
    }, { transport });
    assert.equal(r.turns[0].error, undefined);
    const lines = r.turns[0].reply.split("\n");
    assert.equal(lines[0], '{"config":"{\\"pw\\":\\"[redacted]\\"}"}');
    assert.equal(lines[1], '"[redacted]"');
    // What's left of Basic auth's base64 is the letters "user:" made, and the padding: none of the password
    assert.equal(lines[2], `Basic ${basic.slice(0, 7)}[redacted]${basic.slice(18)}`);
    assert.deepEqual(lines.slice(3, 6), ["https://x.example/?q=[redacted]", "[redacted]", "[redacted]"]);
    // The raw stream came in 7-character chunks, so each secret fell across several: hidden all the same
    assert.ok(r.turns[0].response.chunks.length > 30);
    assert.deepEqual(leaks(r.turns[0].response.chunks.join("")), []);
    assert.deepEqual(leaks(file), []);
    assert.ok(!file.includes(basic.slice(7, 18)));
  });

  it("headers(), text() and the HTTP log's hideSeenSecrets hide the forms too; a secret added later is hidden from then on", () => {
    const secrets = new Set([QK]);
    const r = createRedactor({ secrets });
    assert.deepEqual(r.headers({ "x-trace": `k=${new URLSearchParams({ k: QK }).toString().slice(2)}`, authorization: "Bearer x" }), { "x-trace": "k=[redacted]", authorization: "[redacted]" });
    assert.equal(r.text(`a ${JSON.stringify(PW)}`), `a ${JSON.stringify(PW)}`);
    secrets.add(PW);
    assert.equal(r.text(`a ${JSON.stringify(PW)}`), 'a "[redacted]"');
    assert.deepEqual(r.redact({ url: `http://x/?k=${encodeURIComponent(QK)}`, list: [btoa(PW)] }), { url: "http://x/?k=[redacted]", list: ["[redacted]"] });
    noteSecret("seen-secret 1/2");
    assert.equal(hideSeenSecrets("http://x/a?b=seen-secret+1%2F2&c=seen-secret%201%2F2"), "http://x/a?b=[redacted]&c=[redacted]");
  });

  it("a secret under 4 characters isn't (it would be cut out of ordinary words and numbers); one containing another goes whole", () => {
    const r = createRedactor({ secrets: new Set(["abc", "8080", "pass word", "pass word two"]) });
    assert.equal(r.text("abc at :8080"), "abc at :[redacted]");
    assert.equal(r.text("pass+word+two, pass%20word"), "[redacted], [redacted]");
  });

  it("a stream's raw chunks as the text they make: each keeps its place, the label where what it hides began", () => {
    const r = createRedactor({ secrets: new Set(["sk-abcd-1234"]), patterns: ["phone"] });
    const out = r.redact({ response: { chunks: ["key sk-ab", "cd-", "1234 end 555-12", "3-4567 x"] }, list: ["sk-ab", "cd-1234"] });
    assert.deepEqual(out.response.chunks, ["key [redacted]", "", " end [phone]", " x"]);
    assert.deepEqual(out.list, ["sk-ab", "cd-1234"], "any other list is item by item");
  });
});

describe("the patterns: what they find, and what they leave", () => {
  const all = createRedactor({ patterns: ["email", "card", "phone"] });
  const each = (list, label) => list.map((s) => [s, all.text(s) === label]);

  it("email", () => {
    assert.deepEqual(each(["a@b.co", "priya.k+test@acme.example"], "[email]").filter(([, ok]) => !ok), []);
    for (const s of ["@handle", "a@b", "user@localhost", "x@y.z"]) assert.equal(all.text(s), s);
  });

  it("card: 13 to 19 digits that start as a card does and pass the Luhn check", () => {
    const cards = ["4111 1111 1111 1111", "4242-4242-4242-4242", "5555555555554444", "378282246310005", "3782 822463 10005", "6011000990139424"];
    assert.deepEqual(each(cards, "[card]").filter(([, ok]) => !ok), []);
    // Luhn fails; a timestamp in milliseconds and an id that pass it, but start with 1 or 9; digits in a hex id
    const notCards = ["4111 1111 1111 1112", "5555555555554445", "1696600000008", "9111111111111110", "8a9e26cb4111111111111111a3"];
    for (const s of notCards) assert.equal(all.text(s), s, s);
    // Applied before phone, whichever order they're asked in (an Amex number is 15 digits in groups)
    assert.equal(createRedactor({ patterns: ["phone", "card"] }).text("3782 822463 10005"), "[card]");
  });

  it("phone: 7 to 15 digits after a + or in groups", () => {
    const phones = ["+1 555 123 4567", "+1-555-123-4567", "+1 (555) 123-4567", "(555) 123-4567", "(555)123-4567", "555-123-4567", "555.123.4567", "555-1234", "+44 20 7946 0958", "+442079460958", "020 7946 0958", "+33 1 23 45 67 89", "1-800-555-0199"];
    assert.deepEqual(each(phones, "[phone]").filter(([, ok]) => !ok), []);
    assert.equal(all.text('call me on 555-123-4567. Or {"tel":"+1 555 123 4567"}'), 'call me on [phone]. Or {"tel":"[phone]"}');
  });

  it("phone: not an address's IP or host:port, digits in a hash or an id, a date or time, a grouped or bare number", () => {
    const sha = createHash("sha256").update("hafen").digest("hex");
    const notPhones = [
      "http://127.0.0.1:8812/chat", "ws://10.0.0.12:8791/ws", "localhost:8791", "192.168.100.200", "::ffff:192.168.100.200",
      sha, `sha256:${sha}`, "550e8400-e29b-41d4-a716-446655440000", "id_12345678", "8a9e26cb1234567890a36",
      "2026-10-07", "2026-10-07T12:30:45.123Z", "2026-10-07 12:30:45", "2026-10-07T12:30:45+02:00", "07.10.2026", "10-07-2026",
      "1.234.567", "1.234.567,89", "12 345 678", "1696600000000", "15551234567", "order 4417", "v1.2.3", "1.22.333",
      "10 20 30 40", "25.99-30.99", "p50 0.0 s · p95 1.2 s", "555 - 123 - 4567",
    ];
    assert.deepEqual(notPhones.filter((s) => all.text(s) !== s).map((s) => [s, all.text(s)]), []);
  });
});

describe("every event a run sends out is redacted", () => {
  const SECRET = "sk-very-secret-4242";

  async function run(files, { options = {}, secrets = { MY_KEY: SECRET }, file = "s.hafen.yml" } = {}) {
    const host = memoryHost(files, { secrets });
    const events = [];
    const suite = await loadSuite(host, file);
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    const out = await runSuites({ suites: [suite], host, options, onEvent: (e) => events.push(e) });
    return { run: out, events };
  }

  it("a check's reason, the message, the streamed reply, a test's end, a span: none holds the secret (it was sent)", async () => {
    const { run: r, events } = await run({
      "providers/p.yml": `kind: http\nurl: "${mock.url}/sse"\nheaders: { Authorization: "Bearer {{secret.MY_KEY}}" }\nbody: { message: "{{user}}" }\nstream: sse\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n`,
      "s.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: leaks
    turns:
      - user: "echo {{secret.MY_KEY}}"
        expect:
          - { contains: "not {{secret.MY_KEY}} here" }
          - { not_contains: "{{secret.MY_KEY}}" }
    teardown:
      - name: "tell {{secret.MY_KEY}}"
        request: { url: "${mock.url}/json", method: POST, body: { message: "bye" } }
`,
    });
    // The secret went where it was meant to
    assert.equal(mock.log[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(mock.log[0].body.message, `echo ${SECRET}`);
    // The reasons name it (redacted)
    assert.deepEqual(r.turns[0].results.map((x) => x.status), ["fail", "fail"]);
    const kinds = new Set(events.map((e) => e.type));
    for (const kind of ["test:start", "test:end", "turn:start", "turn:event", "turn:end", "span", "run:end"]) assert.ok(kinds.has(kind), kind);
    const leaked = events.filter((e) => JSON.stringify(e).includes(SECRET)).map((e) => e.type);
    assert.deepEqual(leaked, []);
    // The test's end still says why it failed, the secret hidden
    const end = events.find((e) => e.type === "test:end");
    assert.match(end.test.instances[0].results[0].reason, /\[redacted\]/);
  });

  it("a turn skipped after a failure (on_fail: stop), and a turn whose message can't be made: redacted too", async () => {
    const { events } = await run({
      "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: stops
    on_fail: stop
    turns:
      - { user: "first {{secret.MY_KEY}}", expect: [ { contains: "nope" } ] }
      - { user: "second {{secret.MY_KEY}}" }
`,
    });
    const skipped = events.find((e) => e.type === "turn:end" && e.record.skipped);
    assert.ok(skipped);
    assert.equal(skipped.record.user, "second [redacted]");
    assert.ok(!JSON.stringify(events).includes(SECRET));
  });

  it("a conversation's events too (a reply that echoes the secret)", async () => {
    const transport = fakeTransport((req) => ({ body: JSON.stringify({ r: `you sent ${JSON.parse(req.body).m}` }) }));
    const host = memoryHost({}, { secrets: { MY_KEY: SECRET }, transport });
    const events = [];
    const c = createConversation({ host, providerConfig: { kind: "http", url: "http://e/chat", body: { m: "{{user}}" }, response: { text: "$.r" } }, scopeValues: { name: "stage", values: {} }, onEvent: (e) => events.push(e) });
    c.setScope({ name: "stage", values: {} });
    await c.send("my key is {{secret.MY_KEY}}");
    assert.equal(JSON.parse(transport.requests[0].body).m, `my key is ${SECRET}`);
    assert.ok(events.some((e) => e.type === "turn:event"));
    assert.deepEqual(events.filter((e) => JSON.stringify(e).includes(SECRET)).map((e) => e.type), []);
  });
});

describe("the page's HTTP log", () => {
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

  it("the HTTP log the page sees hides a secret wherever it is in the address, and in an error", async () => {
    const host = memoryHost({
      "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    retries: 0\n    turns: [ { user: hi } ]\n",
      "providers/p.yml": 'kind: http\nurl: "http://127.0.0.1:1/v1/{{secret.BOT_TOKEN}}/chat?api_key={{secret.API_KEY}}"\nbody: { m: "{{user}}" }\nresponse: { text: $.r }\n',
    }, { secrets: { BOT_TOKEN: "bot-SECRET-123456", API_KEY: "sk-SECRET-987654" } });
    const { call, logs } = connect(host);
    await call("open", {});
    await call("run", { token: "t", files: ["s.hafen.yml"] });
    const http = logs.filter((l) => l.name === "http.request");
    assert.ok(http.length);
    for (const l of http) assert.ok(!JSON.stringify(l).includes("SECRET"), JSON.stringify(l));
    assert.match(http[0].url, /\/v1\/\[redacted\]\/chat/);
  });
});

describe("what's redacted, and what isn't", () => {
  const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

  async function runFiles(files, { options = {}, secrets = {}, signal, onEvent } = {}) {
    const host = memoryHost({ "providers/json.yml": JSON_PROVIDER, ...files }, { secrets });
    const suites = [];
    for (const file of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) {
      const suite = await loadSuite(host, file);
      assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
      suites.push(suite);
    }
    return runSuites({ suites, host, options: { vars: { base_url: mock.url }, ...options }, signal, onEvent });
  }

  it("an environment's values aren't secret, so they stay in the record; a secret beside them is redacted", async () => {
    const run = await runFiles({
      "providers/env.yml": `kind: http\nurl: "{{env.base}}/json"\nheaders: { X-Region: "{{env.region}}", X-Key: "{{secret.API_KEY}}" }\nbody: { message: "{{user}} in {{env.region}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": "version: 1\nprovider: providers/env.yml\ntests:\n  - name: t\n    turns: [ { user: hello } ]\n",
    }, { options: { env: "stage", environment: { name: "stage", values: { base: mock.url, region: "eu-west-77" } } }, secrets: { API_KEY: "sk-redact-me-1234" } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.equal(mock.log[0].headers["x-key"], "sk-redact-me-1234");
    const text = JSON.stringify(run);
    assert.ok(!text.includes("sk-redact-me-1234"));
    assert.equal(run.turns[0].request.headers["X-Region"], "eu-west-77");
    assert.equal(run.turns[0].reply, "You said: hello in eu-west-77");
  });
});

describe("the host's secrets, and what's already hidden", () => {
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
});
