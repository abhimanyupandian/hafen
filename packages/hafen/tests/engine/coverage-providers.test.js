// Coverage of docs/providers.md, An HTTP provider: the keys a provider file takes that providers.test.js
// doesn't reach: messages_format (anthropic, gemini, text), history: session's send (body, header,
// cookie), response.error, response.finish and response.session, method GET with a query, thinking's
// request merged only when a test checks thinking, tool-call arguments streamed in pieces joined by
// id, a turn's tools answered by `when`, and prices (cached_input). Each against a transport that
// keeps what was sent and answers as the test says.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createProvider } from "../../engine/providers/index.js";
import { runSuites } from "../../engine/runner.js";
import { withNetwork } from "../../engine/transport.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, sseChunks } from "../helpers.js";

// A run of the suite with this provider (inline) and these turns; the endpoint answers `answer(req, n)`
// (default: a JSON reply saying back the message)
async function run(provider, turns, { answer, test = "", files = {}, head = "" } = {}) {
  const transport = fakeTransport(answer ?? ((req, n) => ({ body: JSON.stringify({ reply: `reply ${n}`, session_id: `sess-${n}` }) })));
  const host = memoryHost({
    "s.hafen.yml": `version: 1\nprovider: ${JSON.stringify(provider)}\n${head}tests:\n  - name: t\n${test}    turns:\n${turns}\n`,
    ...files,
  }, { transport });
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
  const out = await runSuites({ suites: [suite], host });
  return { run: out, sent: transport.requests, bodies: transport.requests.map((r) => (r.body ? JSON.parse(r.body) : undefined)) };
}
const two = "      - user: first\n      - user: second";
const base = { kind: "http", url: "http://x.example/chat", response: { text: "$.reply" } };

describe("history: messages, shaped by messages_format", () => {
  it("openai (the default): [{ role, content }]", async () => {
    const { bodies } = await run({ ...base, history: "messages", body: { messages: "{{messages}}" } }, two);
    assert.deepEqual(bodies[1].messages, [{ role: "user", content: "first" }, { role: "assistant", content: "reply 1" }, { role: "user", content: "second" }]);
  });

  it("anthropic: [{ role, content: [blocks] }]", async () => {
    const { bodies } = await run({ ...base, history: "messages", messages_format: "anthropic", body: { messages: "{{messages}}" } }, two);
    assert.deepEqual(bodies[1].messages, [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  });

  it("gemini: [{ role, parts }], the model's turns as role model", async () => {
    const { bodies } = await run({ ...base, history: "messages", messages_format: "gemini", body: { contents: "{{messages}}" } }, two);
    assert.deepEqual(bodies[1].contents, [{ role: "user", parts: [{ text: "first" }] }, { role: "model", parts: [{ text: "reply 1" }] }, { role: "user", parts: [{ text: "second" }] }]);
  });

  it("text: one string, User: …\\nAssistant: …", async () => {
    const { bodies } = await run({ ...base, history: "messages", messages_format: "text", body: { prompt: "{{messages}}" } }, two);
    assert.equal(bodies[0].prompt, "User: first");
    assert.equal(bodies[1].prompt, "User: first\nAssistant: reply 1\nUser: second");
  });

  it("{{history}} as part of a text is the pairs as JSON; a whole {{history}} is the list", async () => {
    const { bodies } = await run({ ...base, body: { q: "{{user}}", history: "{{history}}" } }, two);
    assert.deepEqual(bodies[0].history, []);
    assert.deepEqual(bodies[1].history, [{ query: "first", response: "reply 1" }]);
  });
});

describe("history: session, and how the session goes back", () => {
  const session = (send, name) => ({ ...base, history: "session", session: { extract: "$.session_id", ...(send ? { send } : {}), ...(name ? { name } : {}) }, body: { message: "{{user}}", session: "{{session}}" } });

  it("in the body (the default), as {{session}}: empty on the first turn, the reply's after", async () => {
    const { bodies } = await run(session(), two);
    assert.deepEqual(bodies.map((b) => b.session), ["", "sess-1"]);
  });

  it("send: header, under session.name (x-session-id without one)", async () => {
    const named = await run(session("header", "X-Conversation"), two);
    assert.equal(named.sent[0].headers["X-Conversation"], undefined);
    assert.equal(named.sent[1].headers["X-Conversation"], "sess-1");
    const unnamed = await run(session("header"), two);
    assert.equal(unnamed.sent[1].headers["x-session-id"], "sess-1");
  });

  it("send: cookie, as <name>=<session>", async () => {
    const { sent } = await run(session("cookie", "sid"), two);
    assert.equal(sent[0].headers.cookie, undefined);
    assert.equal(sent[1].headers.cookie, "sid=sess-1");
  });

  it("response.session reads it instead of session.extract", async () => {
    const { bodies } = await run({ ...base, history: "session", response: { text: "$.reply", session: "$.meta.sid" }, body: { session: "{{session}}" } }, two, {
      answer: (req, n) => ({ body: JSON.stringify({ reply: "ok", meta: { sid: `m-${n}` } }) }),
    });
    assert.deepEqual(bodies.map((b) => b.session), ["", "m-1"]);
  });
});

describe("what a reply says besides its text", () => {
  it("response.error: when its path matches anything, the turn is an error with that message (even with a 200)", async () => {
    const { run: r } = await run({ ...base, response: { text: "$.reply", error: "$.error.message" }, body: { m: "{{user}}" } }, "      - user: hi\n        expect: [ { contains: ok } ]", {
      answer: () => ({ body: JSON.stringify({ error: { message: "quota exceeded for this key" } }) }),
    });
    assert.equal(r.turns[0].error, "quota exceeded for this key");
    assert.equal(r.tests[0].status, "error");
    // (an empty or absent one is no error)
    const fine = await run({ ...base, response: { text: "$.reply", error: "$.error.message" }, body: { m: "{{user}}" } }, "      - user: hi", { answer: () => ({ body: JSON.stringify({ reply: "ok", error: { message: "" } }) }) });
    assert.equal(fine.run.turns[0].error, undefined);
    assert.equal(fine.run.turns[0].reply, "ok");
  });

  it("response.error on a 4xx: the path's message, not the status line", async () => {
    const { run: r } = await run({ ...base, retries: 0, response: { text: "$.reply", error: "$.detail" }, body: { m: "{{user}}" } }, "      - user: hi", {
      answer: () => ({ status: 422, body: JSON.stringify({ detail: "the message is too long" }) }),
    });
    assert.equal(r.turns[0].error, "the message is too long");
  });

  it("response.finish: why it ended, kept on the turn", async () => {
    const { run: r } = await run({ ...base, response: { text: "$.reply", finish: "$.stop_reason" }, body: { m: "{{user}}" } }, "      - user: hi", {
      answer: () => ({ body: JSON.stringify({ reply: "cut", stop_reason: "length" }) }),
    });
    assert.equal(r.turns[0].finish, "length");
  });

  it("response.text an array of strings: joined", async () => {
    const { run: r } = await run({ ...base, response: { text: "$.parts[*]" }, body: { m: "{{user}}" } }, "      - user: hi", {
      answer: () => ({ body: JSON.stringify({ parts: ["Hello, ", "you."] }) }),
    });
    assert.equal(r.turns[0].reply, "Hello, you.");
  });

  it("a reply that isn't JSON (stream: none): the reply text is the whole body", async () => {
    const { run: r } = await run({ kind: "http", url: "http://x.example/chat", body: { m: "{{user}}" } }, "      - user: hi\n        expect: [ { contains: plain } ]", {
      answer: () => ({ headers: { "content-type": "text/plain" }, body: "just plain text" }),
    });
    assert.equal(r.turns[0].reply, "just plain text");
    assert.equal(r.tests[0].status, "passed");
  });

  it("response.tool_calls: { path, name, args, id }, each call's fields relative to it (args given as JSON text are parsed)", async () => {
    const { run: r } = await run({ ...base, response: { text: "$.reply", tool_calls: { path: "$.calls[*]", name: "$.fn", args: "$.arguments", id: "$.cid" } }, body: { m: "{{user}}" } },
      "      - user: hi\n        expect: [ { type: tool.called, tool: lookup, args: { $.id: 7 } }, { type: tool.order, order: [lookup, notify], match: exact } ]", {
        answer: () => ({ body: JSON.stringify({ reply: "done", calls: [{ fn: "lookup", arguments: '{"id":7}', cid: "a" }, { fn: "notify", arguments: { to: "me" }, cid: "b" }] }) }),
      });
    assert.deepEqual(r.turns[0].tool_calls.map((c) => [c.id, c.name, c.args]), [["a", "lookup", { id: 7 }], ["b", "notify", { to: "me" }]]);
    assert.equal(r.tests[0].status, "passed");
  });
});

describe("the request", () => {
  it("method GET sends no body; query is templated and form-encoded onto the address", async () => {
    const { sent } = await run({ ...base, method: "GET", url: "http://x.example/ask?v=1", query: { q: "{{user}}", lang: "{{lang}}" }, body: { never: "sent" } }, "      - user: a & b", { head: "variables: { lang: en }\n" });
    assert.equal(sent[0].method, "GET");
    assert.equal(sent[0].body, undefined);
    assert.equal(sent[0].url, "http://x.example/ask?v=1&q=a+%26+b&lang=en");
  });

  it("thinking.request is merged into the body only when a test checks thinking", async () => {
    const provider = { ...base, body: { m: "{{user}}", options: { temperature: 0 } }, thinking: { request: { options: { think: true }, reasoning: { effort: "low" } }, visibility: "summary" }, response: { text: "$.reply", thinking: "$.thoughts" } };
    const answer = () => ({ body: JSON.stringify({ reply: "ok", thoughts: "hmm" }) });
    const plain = await run(provider, "      - user: hi\n        expect: [ { contains: ok } ]", { answer });
    assert.deepEqual(plain.bodies[0], { m: "hi", options: { temperature: 0 } });
    const checked = await run(provider, "      - user: hi\n        expect: [ { on: thinking, contains: hmm } ]", { answer });
    assert.deepEqual(checked.bodies[0], { m: "hi", options: { temperature: 0, think: true }, reasoning: { effort: "low" } });
    // (its visibility is what the thinking is said to be)
    assert.deepEqual(checked.run.turns[0].thinking, [{ text: "hmm", visibility: "summary" }]);
    assert.equal(checked.run.tests[0].status, "passed");
  });
});

describe("streams", () => {
  it("a tool call's arguments streamed in pieces are joined by id, at the end", async () => {
    const provider = { kind: "http", url: "http://x.example/chat", body: { m: "{{user}}" }, stream: "sse", events: [
      { when: { "$.type": "call" }, tool_call: { id: "$.id", name: "$.name", args: "$.args" } },
      { when: { "$.type": "text" }, text: "$.delta" },
    ] };
    const { run: r } = await run(provider, "      - user: hi\n        expect: [ { type: tool.called, tool: lookup_order, args: { $.order_id: 4417 } } ]", {
      answer: () => ({ headers: { "content-type": "text/event-stream" }, chunks: sseChunks([
        { type: "call", id: "c1", name: "lookup_order", args: '{"order' },
        { type: "call", id: "c2", name: "notify", args: '{"to":' },
        { type: "call", id: "c1", args: '_id": 4417}' },
        { type: "call", id: "c2", args: '"me"}' },
        { type: "text", delta: "Done." },
        "[DONE]",
      ], { split: 5 }) }),
    });
    assert.equal(r.turns[0].error, undefined, r.turns[0].error);
    assert.deepEqual(r.turns[0].tool_calls.map((c) => [c.id, c.name, c.args]), [["c1", "lookup_order", { order_id: 4417 }], ["c2", "notify", { to: "me" }]]);
    assert.equal(r.tests[0].status, "passed");
  });

  it("an SSE event's name picks a rule (when: { event }), and a rule's done: true ends the stream", async () => {
    const provider = { kind: "http", url: "http://x.example/chat", body: { m: "{{user}}" }, stream: "sse", events: [
      { when: { event: "delta" }, text: "$.t" },
      { when: { event: "end" }, done: true },
    ] };
    const text = "event: delta\ndata: {\"t\":\"Hel\"}\n\nevent: ping\ndata: {}\n\nevent: delta\ndata: {\"t\":\"lo\"}\n\nevent: end\ndata: {}\n\nevent: delta\ndata: {\"t\":\" never\"}\n\n";
    const { run: r } = await run(provider, "      - user: hi", { answer: () => ({ headers: { "content-type": "text/event-stream" }, chunks: [text] }) });
    assert.equal(r.turns[0].reply, "Hello");
    assert.equal(r.turns[0].finish, "stop");
  });
});

describe("a turn's tools: results for a model that asks for one", () => {
  // An OpenAI-compatible endpoint (fake): it asks for get_weather for the city in the message, then
  // says what the result it's given says
  const answer = (req) => {
    const body = JSON.parse(req.body);
    const tool = body.messages.find((m) => m.role === "tool");
    const city = /Tokyo/.test(body.messages[0].content) ? "Tokyo" : "Paris";
    const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    const events = tool
      ? [chunk({ content: `It's ${JSON.parse(tool.content).temp} degrees.` }), chunk({}, "stop"), "[DONE]"]
      : [chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city }) } }] }), chunk({}, "tool_calls"), "[DONE]"];
    return { headers: { "content-type": "text/event-stream" }, chunks: sseChunks(events) };
  };
  const preset = { kind: "openai-chat", base_url: "http://x.example/v1", model: "m", api_key: "" };
  const tools = "        tools:\n          get_weather:\n            - { when: { $.city: Tokyo }, result: { temp: 5 } }\n            - { when: { $.city: Paris }, result: { temp: 21 } }\n";

  it("a list of { when, result }: the first whose paths match the call's arguments", async () => {
    const paris = await run(preset, `      - user: weather in Paris?\n${tools}        expect: [ { contains: "21 degrees" } ]`, { answer });
    assert.equal(paris.run.tests[0].status, "passed", JSON.stringify(paris.run.turns[0].error));
    const tokyo = await run(preset, `      - user: weather in Tokyo?\n${tools}        expect: [ { contains: "5 degrees" } ]`, { answer });
    assert.equal(tokyo.run.tests[0].status, "passed");
    assert.deepEqual(tokyo.run.turns[0].tool_calls[0].result, { temp: 5 });
  });

  it("none matching, or no result for the tool: the turn is an error that says so", async () => {
    const none = await run(preset, "      - user: weather in Paris?\n        tools:\n          get_weather:\n            - { when: { $.city: Oslo }, result: { temp: 1 } }", { answer });
    assert.match(none.run.turns[0].error, /No result for get_weather matches its arguments/);
    const missing = await run(preset, "      - user: weather in Paris?\n        tools: { other: { result: 1 } }", { answer });
    assert.match(missing.run.turns[0].error, /The model called get_weather, and the test has no result for it/);
  });
});

describe("prices", () => {
  const answer = () => ({ body: JSON.stringify({ reply: "ok", usage: { in: 1000, out: 500, cached: 400 } }) });
  const priced = (price) => ({ ...base, model: "m1", body: { m: "{{user}}" }, response: { text: "$.reply", usage: { input: "$.usage.in", output: "$.usage.out", cached: "$.usage.cached" } }, ...(price ? { price } : {}) });

  it("a provider's price: cached input tokens at cached_input, the rest at input, output at output (USD per million)", async () => {
    const { run: r } = await run(priced({ input: 2, output: 10, cached_input: 0.5 }), "      - user: hi", { answer });
    assert.equal(r.turns[0].metrics.cost, (600 * 2 + 400 * 0.5 + 500 * 10) / 1e6);
    const plain = await run(priced({ input: 2, output: 10 }), "      - user: hi", { answer });
    assert.equal(plain.run.turns[0].metrics.cost, (1000 * 2 + 500 * 10) / 1e6, "no cached_input: cached tokens at the input price");
  });

  it("a suite's prices file, by the provider's model; one that doesn't exist is a problem before anything is sent", async () => {
    const { run: r } = await run(priced(), "      - user: hi\n        expect: [ { type: cost, max_cost: 0.01 } ]", { answer, head: "prices: prices.yml\n", files: { "prices.yml": "m1: { input: 2, output: 10, cached_input: 1 }\n" } });
    assert.equal(r.turns[0].metrics.cost, (600 * 2 + 400 * 1 + 500 * 10) / 1e6);
    assert.equal(r.tests[0].status, "passed");
    const transport = fakeTransport(answer);
    const host = memoryHost({ "s.hafen.yml": `version: 1\nprovider: ${JSON.stringify(priced())}\nprices: prices/nope.yml\ntests:\n  - name: t\n    turns: [ { user: hi } ]\n` }, { transport });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors.map((e) => [e.line, e.message]), [[3, "the prices file prices/nope.yml doesn't exist"]]);
    const stopped = await runSuites({ suites: [suite], host });
    assert.equal(stopped.status, "error");
    assert.equal(transport.requests.length, 0);
  });

  it("no price anywhere: the cost is unknown (never $0), and a cost check is an error", async () => {
    const { run: r } = await run(priced(), "      - user: hi\n        expect: [ { type: cost, max_cost: 1 } ]", { answer });
    assert.equal(r.turns[0].metrics.cost, undefined);
    assert.equal(r.turns[0].results[0].status, "error");
  });
});

describe("a WebSocket that never says it's done", () => {
  it("end: { idle_ms }: the turn ends when the socket is quiet that long, with what came", async () => {
    // A socket that answers with two messages and then stays open, saying nothing more
    let closed = false;
    const socket = {
      send: () => { setTimeout(() => socket.onmessage({ data: JSON.stringify({ t: "Hel" }) }), 5); setTimeout(() => socket.onmessage({ data: JSON.stringify({ t: "lo" }) }), 20); },
      close: () => { closed = true; },
    };
    const transport = { websocket: () => { setTimeout(() => socket.onopen()); return socket; } };
    const provider = createProvider({ kind: "websocket", url: "ws://x.example/ws", events: [{ text: "$.t" }], end: { idle_ms: 200 } });
    const started = Date.now();
    const out = [];
    for await (const e of provider.send({ message: "hi", history: [], scope: createScope(), transport })) out.push(e);
    const took = Date.now() - started;
    assert.equal(out.filter((e) => e.type === "text").map((e) => e.text).join(""), "Hello");
    assert.equal(out.find((e) => e.type === "done").finish, "quiet");
    assert.equal(out.filter((e) => e.type === "error").length, 0);
    assert.ok(took >= 200 && took < 2000, `${took} ms`);
    assert.ok(closed, "the socket is closed after");
  });
});

describe("a network profile shapes the response (docs/cli.md, --network)", () => {
  const body = "x".repeat(1000);
  const timed = async (profile, draw) => {
    const started = Date.now();
    const res = await withNetwork(fakeTransport(() => ({ chunks: [body.slice(0, 500), body.slice(500)] })), profile, { random: () => draw }).send({ url: "x" });
    let text = "";
    for await (const c of res.body) text += new TextDecoder().decode(c);
    return { ms: Date.now() - started, text };
  };

  it("jitter: the delay give or take jitter_ms", async () => {
    const low = await timed({ delay_ms: 300, jitter_ms: 200 }, 0);       // 300 - 200
    const high = await timed({ delay_ms: 300, jitter_ms: 200 }, 0.999);  // about 300 + 200
    assert.ok(low.ms >= 90 && low.ms < 280, `low ${low.ms} ms`);
    assert.ok(high.ms >= 480, `high ${high.ms} ms`);
    assert.equal(high.text, body);
  });

  it("kbps: the body paced to the bandwidth (1000 bytes at 40 kbps: 0.2 s), all of it", async () => {
    const paced = await timed({ kbps: 40 }, 0.5);
    assert.ok(paced.ms >= 180, `${paced.ms} ms`);
    assert.equal(paced.text, body);
    const free = await timed({}, 0.5);
    assert.ok(free.ms < 100, `${free.ms} ms`);
  });
});
