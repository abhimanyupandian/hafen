// Where redaction and a stream's rules used to go quietly wrong: a secret written into a run file
// escaped or encoded (a JSON body, a query value, base64), the phone pattern taking an address's IP
// or a hash's digits (and the card pattern any long number), and a stream whose rules matched only
// its usage event, a blank reply without a word why.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createProvider } from "../../engine/providers/index.js";
import { createRedactor, hideSeenSecrets, noteSecret } from "../../engine/redact.js";
import { runSuites } from "../../engine/runner.js";
import { createSpans } from "../../engine/spans.js";
import { fetchTransport } from "../../engine/transport.js";
import { executeTurn } from "../../engine/turn.js";
import { createScope } from "../../engine/vars.js";
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

// A turn by one provider config, straight (no suite)
const now = () => performance.now();
async function turn(config, message, { transport = fetchTransport() } = {}) {
  const provider = createProvider(config);
  const scope = createScope({ layers: [{ base_url: mock.url }] });
  return executeTurn({ provider, message, scope, transport, spans: createSpans({ now }), now, timeoutMs: 5000, retries: 0 });
}
const usage = { when: { "$.type": "usage" }, usage: { input: "$.input_tokens", output: "$.output_tokens" } };
const sse = (events) => fakeTransport(() => ({ headers: { "content-type": "text/event-stream" }, chunks: sseChunks(events) }));

describe("a stream whose rules match some events but none gives the reply", () => {
  it("SSE: only the usage event matched (the text rule's when is wrong): an error saying so and showing the first unmatched", async () => {
    // A refund's reply comes as 5 text deltas, then usage, then [DONE] (not an event)
    const out = await turn({ kind: "http", url: "{{base_url}}/sse", body: { message: "{{user}}" }, stream: "sse", events: [{ when: { "$.type": "text" }, text: "$.delta" }, usage] }, "refund");
    assert.equal(out.record.reply, "");
    assert.equal(out.error, `6 events arrived; the rules matched 1 (usage) but none gave text, thinking or a tool call (the first unmatched: {"type":"text_delta","delta":"I'm sorry it arrived "}): check the text rule's when (events[].when)`);
    assert.ok(out.record.usage.output > 0, "what matched is still read");
  });

  it("the text rule matched but its path finds nothing; a rule before it took its events; NDJSON counts lines", async () => {
    const path = await turn({ kind: "http", url: "{{base_url}}/sse", body: { message: "{{user}}" }, stream: "sse", events: [{ when: { "$.type": "text_delta" }, text: "$.text" }, usage] }, "refund");
    assert.equal(path.error, "6 events arrived; the rules matched 6 (text, usage) but none gave text, thinking or a tool call: check the text rule's path (events[].text)");
    const taken = await turn({ kind: "http", url: "{{base_url}}/sse", body: { message: "{{user}}" }, stream: "sse", events: [{ usage: { output: "$.output_tokens" } }, { when: { "$.type": "text_delta" }, text: "$.delta" }] }, "refund");
    assert.equal(taken.error, "6 events arrived; the rules matched 6 (usage) but none gave text, thinking or a tool call: check the text rule's when (events[].when), and that no rule before it takes its events");
    const lines = await turn({ kind: "http", url: "{{base_url}}/ndjson", body: { message: "{{user}}" }, stream: "ndjson", events: [{ when: { "$.type": "text" }, text: "$.delta" }, usage] }, "refund");
    assert.match(lines.error, /^6 lines arrived; the rules matched 1 \(usage\) but none gave text, thinking or a tool call \(the first unmatched: \{"type":"text_delta"/);
  });

  it("isn't an error for a tool call alone, thinking alone, an empty text the path found, a provider with no rule for text, or a rule's own error", async () => {
    const rules = [{ when: { "$.type": "text_delta" }, text: "$.delta" }, { when: { "$.type": "thinking_delta" }, thinking: "$.delta" }, { when: { "$.type": "omitted" }, thinking: "$.none", thinking_visibility: "omitted" }, { when: { "$.type": "tool_call" }, tool_call: { id: "$.id", name: "$.name", args: "$.args" } }, { when: { "$.type": "error" }, error: "$.message" }, usage];
    const config = { kind: "http", url: "http://x/chat", stream: "sse", events: rules };
    const tool = await turn(config, "hi", { transport: sse([{ type: "tool_call", id: "c1", name: "lookup_order", args: { order_id: 4417 } }, { type: "usage", output_tokens: 9 }, "[DONE]"]) });
    assert.equal(tool.error, null);
    assert.deepEqual(tool.record.tool_calls, [{ id: "c1", name: "lookup_order", args: { order_id: 4417 } }]);
    const thinking = await turn(config, "hi", { transport: sse([{ type: "thinking_delta", delta: "Hmm." }, { type: "usage", output_tokens: 2 }, "[DONE]"]) });
    assert.equal(thinking.error, null);
    assert.equal(thinking.record.thinking[0].text, "Hmm.");
    const omitted = await turn(config, "hi", { transport: sse([{ type: "omitted" }, { type: "usage", output_tokens: 2 }, "[DONE]"]) });
    assert.equal(omitted.error, null);
    // An OpenAI-like stream whose content is empty: the path found it (the reply is empty, not lost)
    const empty = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [{ when: { "$.object": "chunk" }, text: "$.choices[0].delta.content" }, usage] }, "hi", { transport: sse([{ object: "chunk", choices: [{ delta: { role: "assistant", content: "" } }] }, { type: "usage", output_tokens: 0 }, "[DONE]"]) });
    assert.equal(empty.error, null);
    // Usage alone, from a provider with no rule for the reply
    const counted = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [usage] }, "hi", { transport: sse([{ type: "text_delta", delta: "Hi" }, { type: "usage", output_tokens: 1 }, "[DONE]"]) });
    assert.equal(counted.error, null);
    // A rule's error is the turn's error, nothing added
    const failed = await turn(config, "hi", { transport: sse([{ type: "error", message: "overloaded" }, "[DONE]"]) });
    assert.equal(failed.error, "overloaded");
  });

  it("a WebSocket's messages too", async () => {
    // (Straight to the provider, with a socket that answers each message sent with these)
    const send = async (config, messages) => {
      const socket = {
        send: () => {
          for (const m of messages) setTimeout(() => socket.onmessage({ data: JSON.stringify(m) }));
          setTimeout(() => socket.onclose());
        },
        close: () => {},
      };
      const transport = { websocket: () => { setTimeout(() => socket.onopen()); return socket; } };
      const out = [];
      for await (const e of createProvider(config).send({ message: "hi", history: [], scope: createScope(), transport })) out.push(e);
      return { errors: out.filter((e) => e.type === "error").map((e) => e.message), reply: out.filter((e) => e.type === "text").map((e) => e.text).join("") };
    };
    const config = { kind: "websocket", url: "ws://x/chat", events: [{ when: { "$.kind": "text" }, text: "$.value" }, { when: { "$.kind": "end" }, done: true }] };
    const out = await send(config, [{ kind: "token", value: "Hi" }, { kind: "token", value: " there" }, { kind: "end" }]);
    assert.deepEqual(out.errors, [`3 messages arrived; the rules matched 1 (done) but none gave text, thinking or a tool call (the first unmatched: {"kind":"token","value":"Hi"}): check the text rule's when (events[].when)`]);
    const fine = await send({ ...config, events: [{ when: { "$.kind": "token" }, text: "$.value" }, ...config.events.slice(1)] }, [{ kind: "token", value: "Hi" }, { kind: "end" }]);
    assert.deepEqual(fine, { errors: [], reply: "Hi" });
  });
});
