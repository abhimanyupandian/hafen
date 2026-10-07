// What a turn reads and checks, where it used to go quietly wrong: a stream whose events no rule
// matches (a blank reply, now an error saying why), a WebSocket's headers (sent from Node; in a
// browser, which can't, an error), and lengths in characters as a reader counts them (not UTF-16
// code units).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";
import { runRule } from "../../engine/checks/index.js";
import { characters, evaluate } from "../../engine/checks/operators.js";
import { createProvider } from "../../engine/providers/index.js";
import { providerTemplate } from "../../engine/providers/templates.js";
import { createSpans } from "../../engine/spans.js";
import { fetchTransport } from "../../engine/transport.js";
import { executeTurn } from "../../engine/turn.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, sseChunks, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

const now = () => performance.now();
async function turn(config, message, { transport = fetchTransport(), vars = {}, secrets = {}, ...rest } = {}) {
  const provider = createProvider(config);
  const spans = createSpans({ now });
  const scope = createScope({ layers: [{ base_url: mock.url, ...vars }], secrets: (n) => secrets[n] });
  return executeTurn({ provider, message, scope, transport, spans, now, timeoutMs: 5000, retries: 0, ...rest });
}
const REFUND = "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?";
// The mock streams { type: text_delta, delta }: rules for { type: text } match none of it
const wrongRules = [{ when: { "$.type": "text" }, text: "$.delta" }];

describe("a stream whose events no rule matches", () => {
  it("SSE: an error that counts them and shows the first, not a blank reply", async () => {
    // A refund's reply comes as 5 text deltas, then usage, then [DONE] (not an event)
    const out = await turn({ kind: "http", url: "{{base_url}}/sse", body: { message: "{{user}}" }, stream: "sse", events: wrongRules }, "refund");
    assert.equal(out.record.reply, "");
    assert.equal(out.error, `6 events arrived, and none matched the provider's events rules (the first: {"type":"text_delta","delta":"I'm sorry it arrived "}): check events[].when`);
    assert.ok(out.record.events.some((e) => e.type === "error"));
    assert.ok(out.record.response.chunks.length > 0, "the raw stream is kept");
    // A long first event is shortened
    const long = fakeTransport(() => ({ chunks: sseChunks([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello there, how can I help you today?" } }, "[DONE]"]) }));
    const cut = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: wrongRules }, "hi", { transport: long });
    assert.equal(cut.error, `1 event arrived, and none matched the provider's events rules (the first: {"type":"content_block_delta","index":0,"delta":{"type":"te…): check events[].when`);
  });

  it("NDJSON: the same, counted in lines", async () => {
    const out = await turn({ kind: "http", url: "{{base_url}}/ndjson", body: { message: "{{user}}" }, stream: "ndjson", events: wrongRules }, "refund");
    assert.match(out.error, /^6 lines arrived, and none matched .*\(the first: \{"type":"text_delta"/);
  });

  it("an SSE event's name is shown when it has one; no rules at all says so", async () => {
    const named = fakeTransport(() => ({ headers: { "content-type": "text/event-stream" }, chunks: ['event: content\ndata: {"text":"Hi"}\n\n', "data: [DONE]\n\n"] }));
    const out = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [{ when: { event: "delta" }, text: "$.text" }] }, "hi", { transport: named });
    assert.equal(out.error, `1 event arrived, and none matched the provider's events rules (the first: event content, {"text":"Hi"}): check events[].when`);
    const bare = fakeTransport(() => ({ chunks: sseChunks([{ text: "Hi" }, "[DONE]"]) }));
    const none = await turn({ kind: "http", url: "http://x/chat", stream: "sse" }, "hi", { transport: bare });
    assert.match(none.error, /^1 event arrived, and the provider has no events rules to read them \(the first: \{"text":"Hi"\}\): add events$/);
  });

  it("isn't an error when some events match: keep-alives and events no rule wants beside them", async () => {
    const t = fakeTransport(() => ({ chunks: sseChunks([{ type: "ping" }, { type: "text_delta", delta: "Hi" }, { type: "ping" }, { type: "progress", pct: 50 }, "[DONE]"]) }));
    const out = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [{ when: { "$.type": "text_delta" }, text: "$.delta" }] }, "hi", { transport: t });
    assert.equal(out.error, null);
    assert.equal(out.record.reply, "Hi");
  });

  it("isn't an error when a stream ends with a tool call and no text, or only a done marker or usage matched", async () => {
    const tool = fakeTransport(() => ({ chunks: sseChunks([{ type: "ping" }, { type: "tool_call", id: "c1", name: "lookup_order", args: { order_id: 4417 } }, "[DONE]"]) }));
    const out = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [{ when: { "$.type": "text_delta" }, text: "$.delta" }, { when: { "$.type": "tool_call" }, tool_call: { id: "$.id", name: "$.name", args: "$.args" } }] }, "hi", { transport: tool });
    assert.equal(out.error, null);
    assert.equal(out.record.reply, "");
    assert.deepEqual(out.record.tool_calls, [{ id: "c1", name: "lookup_order", args: { order_id: 4417 } }]);
    const done = fakeTransport(() => ({ chunks: sseChunks([{ type: "ping" }, { type: "end" }]) }));
    const ended = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [{ when: { "$.type": "end" }, done: true }] }, "hi", { transport: done });
    assert.equal(ended.error, null);
    const usage = fakeTransport(() => ({ chunks: sseChunks([{ type: "usage", output_tokens: 0 }, "[DONE]"]) }));
    const counted = await turn({ kind: "http", url: "http://x/chat", stream: "sse", events: [{ when: { "$.type": "usage" }, usage: { output: "$.output_tokens" } }] }, "hi", { transport: usage });
    assert.equal(counted.error, null);
  });

  it("the new SSE and NDJSON providers' starting rules read the mock's streams (with API_KEY set)", async () => {
    for (const [id, path] of [["http-sse", "sse"], ["http-ndjson", "ndjson"]]) {
      const text = providerTemplate(id, { url: `${mock.url}/${path}` });
      assert.match(text, /set the secret API_KEY, or remove these two lines/);
      assert.match(text, /when none match, the turn says so and shows the first/);
      const out = await turn(parse(text), "refund", { secrets: { API_KEY: "sk-1" } });
      assert.equal(out.error, null, id);
      assert.equal(out.record.reply, REFUND, id);
      assert.ok(out.record.usage.output > 0, id);
    }
    // Without the key, the turn says which secret to set
    const out = await turn(parse(providerTemplate("http-sse", { url: `${mock.url}/sse` })), "refund");
    assert.match(out.error, /\{\{secret\.API_KEY\}\} isn't set/);
  });
});

// A WebSocket server for the tests (node:http's upgrade, text frames only): what each connection's
// handshake sent, and `answer(message)` → the messages to send back
async function wsServer(answer) {
  const handshakes = [];
  const sockets = new Set();
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    handshakes.push(req.headers);
    sockets.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const protocol = req.headers["sec-websocket-protocol"]?.split(",")[0].trim();
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), "", ""].join("\r\n"));
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        // A client's frame: masked, its length in 7 bits, or 16 or 64 more
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); at = 4; }
        else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); at = 10; }
        if (buffer.length < at + 4 + length) return;
        const mask = buffer.subarray(at, at + 4);
        const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.subarray(at + 4 + length);
        if (opcode === 8) return socket.end(Buffer.from([0x88, 0]));
        if (opcode === 1) for (const out of answer(payload.toString("utf8"))) socket.write(frame(typeof out === "string" ? out : JSON.stringify(out)));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/chat`,
    handshakes,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}
const frame = (text) => {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
};

describe("WebSocket providers", () => {
  let ws;
  before(async () => {
    ws = await wsServer((message) => {
      const { text } = JSON.parse(message);
      if (text === "quiet") return [{ kind: "hello" }, { kind: "token", value: "Hi" }, { kind: "bye" }];
      return [{ type: "delta", text: "You said: " }, { type: "delta", text }, { type: "end" }];
    });
  });
  after(() => ws.close());
  const config = (more = {}) => ({ kind: "websocket", url: ws.url, send: { type: "message", text: "{{user}}" }, events: [{ when: { "$.type": "delta" }, text: "$.text" }, { when: { "$.type": "end" }, done: true }], end: { idle_ms: 300 }, ...more });

  it("sends its headers, templated, with its protocols (Node)", async () => {
    ws.handshakes.length = 0;
    const out = await turn(config({ protocols: ["chat-v2"], headers: { Authorization: "Bearer {{token}}", "X-Client": "hafen" } }), "hello", { vars: { token: "tok-1" } });
    assert.equal(out.error, null);
    assert.equal(out.record.reply, "You said: hello");
    assert.equal(ws.handshakes[0].authorization, "Bearer tok-1");
    assert.equal(ws.handshakes[0]["x-client"], "hafen");
    assert.equal(ws.handshakes[0]["sec-websocket-protocol"], "chat-v2");
    assert.deepEqual(out.record.request.headers, { Authorization: "Bearer tok-1", "X-Client": "hafen" });
  });

  it("without headers, connects as before", async () => {
    ws.handshakes.length = 0;
    const out = await turn(config(), "hello");
    assert.equal(out.error, null);
    assert.equal(out.record.reply, "You said: hello");
    assert.equal(ws.handshakes[0].authorization, undefined);
  });

  it("in a browser, which can't send them, headers are an error before connecting; none is fine", async () => {
    ws.handshakes.length = 0;
    globalThis.WorkerGlobalScope = class {};
    try {
      const out = await turn(config({ headers: { Authorization: "Bearer {{token}}" } }), "hello", { vars: { token: "tok-1" } });
      assert.equal(out.error, "A WebSocket in a browser can't send headers (this provider sets Authorization): put credentials in its url or protocols, or use the desktop app or the CLI");
      assert.equal(ws.handshakes.length, 0, "it didn't connect");
      const plain = await turn(config({ protocols: ["chat-v2"] }), "hello");
      assert.equal(plain.error, null);
      assert.equal(plain.record.reply, "You said: hello");
    } finally {
      delete globalThis.WorkerGlobalScope;
    }
  });

  it("messages no rule matches: an error that counts them and shows the first", async () => {
    const out = await turn(config(), "quiet");
    assert.equal(out.record.reply, "");
    assert.equal(out.error, `3 messages arrived, and none matched the provider's events rules (the first: {"kind":"hello"}): check events[].when`);
    const some = await turn(config({ events: [{ when: { "$.kind": "token" }, text: "$.value" }] }), "quiet");
    assert.equal(some.error, null);
    assert.equal(some.record.reply, "Hi");
  });
});

describe("lengths in characters", () => {
  const ctx = (reply) => ({ turn: { reply } });

  it("a length check counts what a reader sees: accents, emoji and CJK are one each", () => {
    const reply = "You said: héllo 👋 日本";
    assert.equal(reply.length, 21, "UTF-16 code units");
    const r = runRule({ type: "length", max_length: 20 }, ctx(reply));
    assert.equal(r.status, "pass", r.reason);
    assert.equal(r.reason, "length 20 ≤ 20");
    assert.equal(r.actual, 20);
    const over = runRule({ type: "length", max_length: 19 }, ctx(reply));
    assert.equal(over.status, "fail");
    assert.equal(over.reason, "length 20 > 19");
    assert.equal(runRule({ type: "length", min_length: 21 }, ctx(reply)).status, "fail");
  });

  it("min_length and max_length on a string: grapheme clusters (a skin tone, a flag, a combining accent)", () => {
    assert.equal(characters("👋🏽"), 1);
    assert.equal(characters("🇯🇵"), 1);
    assert.equal(characters("é"), 1);
    assert.equal(characters("👨‍👩‍👧"), 1);
    assert.equal(characters(""), 0);
    assert.equal(evaluate({ max_length: 3 }, ["👋🏽🇯🇵é"]).pass, true);
    assert.equal(evaluate({ min_length: 4 }, ["👋🏽🇯🇵é"]).why, "length 3 < 4");
    assert.equal(evaluate({ max_length: 5 }, ["hello"]).pass, true);
    assert.equal(evaluate({ max_length: 4 }, ["hello"]).pass, false);
  });

  it("an array still counts its items, an object its keys", () => {
    assert.equal(evaluate({ min_length: 2, max_length: 2 }, [["👋🏽", "日本語"]]).why, "length 2 ≥ 2, length 2 ≤ 2");
    assert.equal(evaluate({ max_length: 1 }, [{ a: 1, b: 2 }]).pass, false);
    assert.equal(evaluate({ max_length: 1 }, [42]).why, "has no length (integer)");
  });

  it("a tokens check still reads the reported usage, never the text", () => {
    const r = runRule({ type: "tokens", max_tokens: 3 }, { turn: { reply: "👋".repeat(50), usage: { output: 3 } } });
    assert.equal(r.status, "pass");
    assert.equal(r.reason, "3 output tokens ≤ 3");
  });
});
