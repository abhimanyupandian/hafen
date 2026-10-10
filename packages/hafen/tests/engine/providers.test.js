// Providers (docs/providers.md): the HTTP provider against the mock endpoint and every key its file
// takes, the presets against recorded streams, history: none, and stream rules that match nothing.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse } from "yaml";
import { createConversation } from "../../engine/explore.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createProvider } from "../../engine/providers/index.js";
import { PROVIDER_KINDS, providerTemplate } from "../../engine/providers/templates.js";
import { runSuites } from "../../engine/runner.js";
import { validateProviderSchema } from "../../engine/schema.js";
import { createSpans } from "../../engine/spans.js";
import { fetchTransport } from "../../engine/transport.js";
import { executeTurn } from "../../engine/turn.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, MOCK_SSE_PROVIDER, sseChunks, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

const now = () => performance.now();
async function turn(config, message, { history = [], transport = fetchTransport(), vars = {}, ...rest } = {}) {
  const provider = createProvider(config);
  const spans = createSpans({ now });
  const scope = createScope({ layers: [{ base_url: mock.url, ...vars }], secrets: (n) => ({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant", GEMINI_API_KEY: "g-key" })[n] });
  return executeTurn({ provider, message, history, scope, transport, spans, now, timeoutMs: 5000, retries: 1, ...rest });
}
const sseProvider = (scenario) => parse(MOCK_SSE_PROVIDER.replace("{{scenario}}", scenario));
const REFUND = "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?";

describe("http provider", () => {
  it("one JSON reply, with paths", async () => {
    const out = await turn({ kind: "http", url: "{{base_url}}/json", body: { message: "{{user}}" }, response: { text: "$.data.reply", usage: { input: "$.usage.input_tokens", output: "$.usage.output_tokens" } } }, "a refund please");
    assert.equal(out.record.reply, REFUND);
    assert.equal(out.record.response.status, 200);
    assert.equal(out.response.data.order.id, 4417);
    assert.ok(out.record.usage.output > 0);
    assert.ok(out.record.metrics.ms > 0);
    assert.equal(out.error, null);
  });

  it("SSE, assembled for response checks", async () => {
    const out = await turn(sseProvider("sse"), "refund?");
    assert.equal(out.record.reply, REFUND);
    assert.equal(out.record.events.filter((e) => e.type === "text").length, 1, "deltas merge into one text event");
    assert.ok(out.record.response.streamed);
    assert.equal(out.response.text, REFUND);
    assert.ok(out.record.metrics.ttft_ms !== undefined);
  });

  it("{{history}}: the earlier turns as { query, response } pairs", async () => {
    const t = fakeTransport(() => ({ body: JSON.stringify({ reply: "Ronaldo." }) }));
    const history = [{ user: "my name is ronaldo", reply: "Nice to meet you!", raw: { message: { role: "assistant", content: "Nice to meet you!", thinking: "…" } } }];
    const out = await turn({ kind: "http", url: "http://x/chat", body: { query: "{{user}}", history: "{{history}}" }, response: { text: "$.reply" } }, "what is my name?", { transport: t, history });
    assert.deepEqual(JSON.parse(t.requests[0].body), { query: "what is my name?", history: [{ query: "my name is ronaldo", response: "Nice to meet you!" }] });
    assert.equal(out.record.reply, "Ronaldo.");
  });

  it("NDJSON", async () => {
    const out = await turn({ ...sseProvider("ndjson"), stream: "ndjson" }, "refund?");
    assert.equal(out.record.reply, REFUND);
  });

  it("thinking: full, summary, omitted", async () => {
    const full = await turn(sseProvider("thinking/full"), "refund");
    assert.equal(full.record.thinking[0].visibility, "full");
    assert.match(full.record.thinking[0].text, /refund window/);
    assert.ok(full.record.metrics.thinking_ms >= 0);
    assert.ok(full.record.metrics.first_answer_ms > full.record.metrics.first_thinking_ms);
    const summary = await turn(sseProvider("thinking/summary"), "refund");
    assert.equal(summary.record.thinking[0].visibility, "summary");
    const omitted = await turn(sseProvider("thinking/omitted"), "refund");
    assert.deepEqual(omitted.record.thinking, [{ text: "", visibility: "omitted" }]);
  });

  it("thinking in <think> tags, split across chunks", async () => {
    const out = await turn({ ...sseProvider("thinking/tags"), think_tags: ["<think>", "</think>"] }, "refund");
    assert.equal(out.record.thinking[0].text, "Check the refund window.");
    assert.equal(out.record.reply, REFUND);
  });

  it("tool calls and results, in order", async () => {
    const out = await turn(sseProvider("tools"), "refund");
    const kinds = out.record.events.map((e) => e.type);
    assert.deepEqual(kinds.filter((k) => k !== "usage" && k !== "done"), ["thinking", "tool_call", "tool_result", "text"]);
    assert.deepEqual(out.record.tool_calls[0], { id: "c1", name: "lookup_order", args: { order_id: 4417 }, result: { status: "delivered" } });
  });

  it("an error status is an error turn, with the body kept", async () => {
    const out = await turn({ kind: "http", url: "{{base_url}}/error/500", body: { message: "{{user}}" }, response: { text: "$.reply" } }, "hi", { retries: 0 });
    assert.match(out.error, /500/);
    assert.equal(out.record.response.status, 500);
  });

  it("a stream cut off midway is an error, keeping what arrived", async () => {
    const out = await turn(sseProvider("cut"), "hi");
    assert.ok(out.error);
    assert.ok(out.record.reply.length > 0);
  });

  it("rate limits are retried", async () => {
    const out = await turn({ kind: "http", url: "{{base_url}}/ratelimit", body: { message: "{{user}}" }, response: { text: "$.data.reply" } }, "hello");
    assert.equal(out.error, null);
    assert.equal(out.record.reply, "You said: hello");
  });

  it("a session carried from turn to turn", async () => {
    const config = { kind: "http", url: "{{base_url}}/session", body: { message: "{{user}}", session_id: "{{session}}" }, history: "session", session: { extract: "$.session_id" }, response: { text: "$.reply" } };
    const one = await turn(config, "hi");
    const two = await turn(config, "again", { session: one.session });
    assert.match(two.record.reply, /turn 2/);
  });

  it("times out", async () => {
    const out = await turn({ kind: "http", url: "{{base_url}}/slow?ms=500", body: {}, response: { text: "$.data.reply" } }, "hi", { timeoutMs: 100 });
    assert.match(out.error, /timed out/);
  });
});

describe("presets", () => {
  it("openai-chat: text, reasoning, usage, against an OpenAI-compatible server", async () => {
    const out = await turn({ kind: "openai-chat", base_url: `${mock.url}/openai`, model: "mock-thinking" }, "a refund");
    assert.equal(out.record.reply, REFUND);
    assert.match(out.record.thinking[0].text, /think about the order/);
    assert.deepEqual(out.record.usage, { input: 12, output: 9, thinking: 6, cached: undefined });
  });

  it("openai-chat: tool calls joined by index, answered with mocked results", async () => {
    const out = await turn({ kind: "openai-chat", base_url: `${mock.url}/tools/ask`, model: "m", api_key: "" }, "weather?", { tools: { get_weather: { result: { temp: 21 } } } });
    assert.equal(out.error, null);
    assert.deepEqual(out.record.tool_calls[0], { id: "call_1", name: "get_weather", args: { city: "Paris" }, result: { temp: 21 } });
    assert.equal(out.record.reply, "It's 21 degrees in Paris.");
  });

  it("anthropic-messages: thinking blocks (summarized), signatures kept for replay", async () => {
    const t = fakeTransport(() => ({
      headers: { "content-type": "text/event-stream" },
      chunks: sseChunks([
        { type: "message_start", message: { usage: { input_tokens: 20 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the window." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Sure, " } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "why?" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
        { type: "message_stop" },
      ]),
    }));
    const out = await turn({ kind: "anthropic-messages", model: "claude-opus-5-5" }, "refund", { transport: t, wantThinking: true });
    const sent = JSON.parse(t.requests[0].body);
    assert.deepEqual(sent.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(t.requests[0].headers["x-api-key"], "sk-ant");
    assert.equal(out.record.reply, "Sure, why?");
    assert.deepEqual(out.record.thinking, [{ text: "Check the window.", visibility: "summary" }]);
    assert.deepEqual(out.record.raw_blocks[0].content[0], { type: "thinking", thinking: "Check the window.", signature: "sig123" });
    assert.deepEqual(out.record.usage, { input: 20, output: 15, thinking: undefined, cached: undefined });
    // Replayed unchanged in live history
    const t2 = fakeTransport(() => ({ chunks: sseChunks([{ type: "message_stop" }]) }));
    await turn({ kind: "anthropic-messages", model: "m" }, "next", { transport: t2, history: [{ user: "refund", reply: "Sure, why?", raw: out.record.raw_blocks[0] }] });
    assert.deepEqual(JSON.parse(t2.requests[0].body).messages[1].content[0].signature, "sig123");
  });

  it("anthropic-messages: omitted and redacted thinking", async () => {
    const t = fakeTransport(() => ({
      chunks: sseChunks([
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "xyz" } },
        { type: "content_block_stop", index: 1 },
      ]),
    }));
    const out = await turn({ kind: "anthropic-messages", model: "m" }, "hi", { transport: t });
    assert.deepEqual(out.record.thinking.map((x) => x.visibility), ["omitted", "redacted"]);
  });

  it("openai-responses: summary thinking, function calls, and continuing from the last response", async () => {
    const t = fakeTransport(() => ({
      chunks: sseChunks([
        { type: "response.reasoning_summary_text.delta", delta: "Thinking briefly." },
        { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "call_9", name: "lookup", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"id":' },
        { type: "response.function_call_arguments.delta", item_id: "fc1", delta: "1}" },
        { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "call_9", name: "lookup", arguments: '{"id":1}' } },
        { type: "response.output_text.delta", delta: "Done." },
        { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 5, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } } } },
      ]),
    }));
    const out = await turn({ kind: "openai-responses", model: "m" }, "hi", { transport: t, wantThinking: true });
    assert.deepEqual(JSON.parse(t.requests[0].body).reasoning, { summary: "auto" });
    assert.equal(out.record.thinking[0].visibility, "summary");
    assert.deepEqual(out.record.tool_calls[0], { id: "call_9", name: "lookup", args: { id: 1 } });
    assert.equal(out.record.reply, "Done.");
    assert.deepEqual(out.record.usage, { input: 5, output: 7, thinking: 3, cached: undefined });
    const t2 = fakeTransport(() => ({ chunks: sseChunks([]) }));
    await turn({ kind: "openai-responses", model: "m" }, "next", { transport: t2, history: [{ user: "hi", reply: "Done.", raw: out.record.raw_blocks[0] }] });
    assert.equal(JSON.parse(t2.requests[0].body).previous_response_id, "resp_1");
  });

  it("gemini: thought summaries, function calls, usage", async () => {
    const t = fakeTransport(() => ({
      chunks: sseChunks([
        { candidates: [{ content: { parts: [{ text: "Hmm.", thought: true }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { id: 1 } } }] } }] },
        { candidates: [{ content: { parts: [{ text: "All " }] } }] },
        { candidates: [{ content: { parts: [{ text: "done." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 2 } },
      ]),
    }));
    const out = await turn({ kind: "gemini", model: "gemini-x" }, "hi", { transport: t, wantThinking: true });
    assert.match(t.requests[0].url, /models\/gemini-x:streamGenerateContent\?alt=sse/);
    assert.deepEqual(JSON.parse(t.requests[0].body).generationConfig.thinkingConfig, { includeThoughts: true });
    assert.equal(out.record.reply, "All done.");
    assert.deepEqual(out.record.thinking, [{ text: "Hmm.", visibility: "summary" }]);
    assert.equal(out.record.tool_calls[0].name, "lookup");
    assert.deepEqual(out.record.usage, { input: 4, output: 6, thinking: 2, cached: undefined });
  });

  // Lines as Ollama 0.35 streams them (recorded from qwen3:0.6b), split in awkward places
  const ndjsonChunks = (lines, split = 7) => {
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
    const out = [];
    for (let i = 0; i < text.length; i += split) out.push(text.slice(i, i + split));
    return out;
  };
  const line = (message, extra = {}) => ({ model: "qwen3:0.6b", created_at: "2026-10-05T09:39:27.152409Z", message: { role: "assistant", content: "", ...message }, done: false, ...extra });
  const done = (extra = {}) => line({}, { done: true, done_reason: "stop", total_duration: 1887277416, load_duration: 4140791, prompt_eval_count: 17, prompt_eval_cached_count: 3, prompt_eval_duration: 225716000, eval_count: 215, eval_duration: 1589993000, ...extra });

  it("ollama: thinking and the answer from /api/chat, with Ollama's token counts", async () => {
    const t = fakeTransport(() => ({
      headers: { "content-type": "application/x-ndjson" },
      chunks: ndjsonChunks([line({ thinking: "Okay" }), line({ thinking: ", three words." }), line({ content: "Hi" }), line({ content: " there, friend!" }), done()]),
    }));
    const out = await turn({ kind: "ollama", model: "gemma4" }, "Say hi in 3 words.", { transport: t, wantThinking: true });
    assert.equal(t.requests[0].url, "http://localhost:11434/api/chat");
    assert.equal(t.requests[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(t.requests[0].body), { model: "gemma4", messages: [{ role: "user", content: "Say hi in 3 words." }], think: true, stream: true });
    assert.equal(out.error, null);
    assert.equal(out.record.reply, "Hi there, friend!");
    assert.deepEqual(out.record.thinking, [{ text: "Okay, three words.", visibility: "full" }]);
    assert.deepEqual(out.record.usage, { input: 17, output: 215, thinking: undefined, cached: 3 });
    // The conversation so far is sent with the next turn
    const t2 = fakeTransport(() => ({ chunks: ndjsonChunks([line({ content: "Sure." }), done()]) }));
    await turn({ kind: "ollama", base_url: "http://gpu-box:11434/", model: "gemma4", api_key: "{{secret.OPENAI_API_KEY}}", params: { options: { temperature: 0 } } }, "again", { transport: t2, history: [{ user: "Say hi in 3 words.", reply: out.record.reply, raw: out.record.raw_blocks[0] }] });
    const sent = JSON.parse(t2.requests[0].body);
    assert.equal(t2.requests[0].url, "http://gpu-box:11434/api/chat");
    assert.equal(t2.requests[0].headers.authorization, "Bearer sk-test");
    assert.deepEqual(sent.options, { temperature: 0 });
    // Earlier turns go back as their query and response only: no thinking, no assistant object
    assert.deepEqual(sent.messages.slice(0, 3), [{ role: "user", content: "Say hi in 3 words." }, { role: "assistant", content: "Hi there, friend!" }, { role: "user", content: "again" }]);
  });

  it("ollama: whole tool calls, answered with mocked results", async () => {
    const t = fakeTransport((req, n) => ({
      chunks: n === 1
        ? ndjsonChunks([line({ tool_calls: [{ id: "call_r7f4rha8", function: { index: 0, name: "get_weather", arguments: { city: "Tokyo" } } }] }), done({ eval_count: 21 })])
        : ndjsonChunks([line({ content: "It's 21 degrees in Tokyo." }), done({ eval_count: 9 })]),
    }));
    const out = await turn({ kind: "ollama", model: "qwen3:0.6b" }, "weather?", { transport: t, tools: { get_weather: { result: { temp: 21 } } } });
    assert.equal(out.error, null);
    assert.deepEqual(out.record.tool_calls[0], { id: "call_r7f4rha8", name: "get_weather", args: { city: "Tokyo" }, result: { temp: 21 } });
    assert.equal(out.record.reply, "It's 21 degrees in Tokyo.");
    const second = JSON.parse(t.requests[1].body).messages;
    assert.deepEqual(second.slice(1), [
      { role: "assistant", content: "", tool_calls: [{ id: "call_r7f4rha8", function: { name: "get_weather", arguments: { city: "Tokyo" } } }] },
      { role: "tool", tool_name: "get_weather", tool_call_id: "call_r7f4rha8", content: '{"temp":21}' },
    ]);
  });

  it("ollama: a model that isn't pulled, and an error in the stream", async () => {
    const missing = fakeTransport(() => ({ status: 404, body: '{"error":"model \'gemma4\' not found"}' }));
    const out = await turn({ kind: "ollama", model: "gemma4" }, "hi", { transport: missing, retries: 0 });
    assert.match(out.error, /404: model 'gemma4' not found/);
    const cut = fakeTransport(() => ({ chunks: ndjsonChunks([line({ content: "Hel" }), { error: "an error was encountered while running the model" }]) }));
    const out2 = await turn({ kind: "ollama", model: "gemma4" }, "hi", { transport: cut, retries: 0 });
    assert.match(out2.error, /error was encountered while running the model/);
    assert.equal(out2.record.reply, "Hel");
  });
});

describe("new providers", () => {
  it("every kind the app lists starts as a valid provider file", () => {
    for (const { id } of PROVIDER_KINDS) {
      for (const options of [{}, { model: "qwen3:0.6b", base: "http://gpu-box:11434", url: "https://x.example/chat" }]) {
        const text = providerTemplate(id, options);
        const config = parse(text);
        assert.ok(validateProviderSchema(config), `${id}: ${JSON.stringify(validateProviderSchema.errors)}`);
        assert.doesNotThrow(() => createProvider(config), id);
      }
    }
    const ollama = parse(providerTemplate("ollama", { model: "qwen3:0.6b", base: "http://gpu-box:11434" }));
    assert.deepEqual(ollama, { kind: "ollama", model: "qwen3:0.6b", base_url: "http://gpu-box:11434" });
    assert.deepEqual(parse(providerTemplate("ollama")), { kind: "ollama", model: "gemma4" });
  });

  it("an HTTP endpoint's starting file runs in a suite as it is: {{user}} and {{history}} are the provider's own", async () => {
    const { memoryHost } = await import("../helpers.js");
    const { loadSuite } = await import("../../engine/files/suite-file.js");
    for (const id of ["http", "http-sse", "http-ndjson"]) {
      const host = memoryHost({
        "providers/p.yml": providerTemplate(id, { url: "https://x.example/chat" }),
        "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests: [ { name: t, turns: [ { user: hi } ] } ]\n",
      });
      assert.deepEqual((await loadSuite(host, "s.hafen.yml")).missing, [], id);
    }
  });
});

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

// Two turns through a provider written inline: the requests it sent
async function twoTurns(provider, transport) {
  const host = memoryHost({ "s.hafen.yml": `version: 1
provider: ${provider}
tests:
  - name: t
    turns: [ { user: first }, { user: second } ]
` }, { transport });
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(suite.errors, []);
  const run = await runSuites({ suites: [suite], host });
  assert.equal(run.status, "done", JSON.stringify(run.error));
  return run;
}
const replying = () => fakeTransport((req, n) => ({ body: JSON.stringify({ reply: `reply ${n}`, session_id: `sess-${n}` }) }));
const HTTP = (history) => `{ kind: http, url: "http://x.example/chat"${history ? `, history: ${history}` : ""}, body: { messages: "{{messages}}", history: "{{history}}", session: "{{session}}" }, session: { extract: $.session_id }, response: { text: $.reply } }`;

describe("history: none", () => {
  it("the second turn sends only its own message ({{messages}} one message, {{history}} empty)", async () => {
    const transport = replying();
    await twoTurns(HTTP("none"), transport);
    const second = JSON.parse(transport.requests[1].body);
    assert.deepEqual(second.messages, [{ role: "user", content: "second" }]);
    assert.deepEqual(second.history, []);
    // (and no session to carry the conversation on)
    assert.equal(second.session, "");
  });

  it("without it, the second turn sends the conversation (as before)", async () => {
    const transport = replying();
    await twoTurns(HTTP(""), transport);
    const second = JSON.parse(transport.requests[1].body);
    assert.deepEqual(second.messages, [{ role: "user", content: "first" }, { role: "assistant", content: "reply 1" }, { role: "user", content: "second" }]);
    assert.deepEqual(second.history, [{ query: "first", response: "reply 1" }]);
    assert.equal(second.session, "sess-1");
  });

  it("messages_format text: this turn's message alone", async () => {
    const transport = replying();
    await twoTurns(`{ kind: http, url: "http://x.example/chat", history: none, messages_format: text, body: { prompt: "{{messages}}" }, response: { text: $.reply } }`, transport);
    assert.equal(JSON.parse(transport.requests[1].body).prompt, "User: second");
  });

  it("a preset (openai-chat) sends only this turn's message", async () => {
    mock.reset();
    await twoTurns(`{ kind: openai-chat, base_url: "${mock.url}/openai", model: m, api_key: "", history: none }`);
    const sent = mock.log.filter((x) => x.path === "/openai/chat/completions");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body.messages, [{ role: "user", content: "second" }]);
  });

  it("a conversation (Try it) with the provider's history: none sends each message alone", async () => {
    const transport = replying();
    const host = memoryHost({}, { transport });
    const c = createConversation({ host, providerConfig: { kind: "http", url: "http://x.example/chat", history: "none", body: { messages: "{{messages}}", history: "{{history}}" }, response: { text: "$.reply" } } });
    await c.send("first");
    await c.send("second");
    const second = JSON.parse(transport.requests[1].body);
    assert.deepEqual(second.messages, [{ role: "user", content: "second" }]);
    assert.deepEqual(second.history, []);
    await c.close();
  });
});

describe("a stream whose events no rule matches", () => {
  async function turn(config, message, { transport = fetchTransport(), vars = {}, secrets = {}, ...rest } = {}) {
    const provider = createProvider(config);
    const spans = createSpans({ now });
    const scope = createScope({ layers: [{ base_url: mock.url, ...vars }], secrets: (n) => secrets[n] });
    return executeTurn({ provider, message, scope, transport, spans, now, timeoutMs: 5000, retries: 0, ...rest });
  }

  // The mock streams { type: text_delta, delta }: rules for { type: text } match none of it
  const wrongRules = [{ when: { "$.type": "text" }, text: "$.delta" }];

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

describe("a stream whose rules match some events but none gives the reply", () => {
  // A turn by one provider config, straight (no suite)
  async function turn(config, message, { transport = fetchTransport() } = {}) {
    const provider = createProvider(config);
    const scope = createScope({ layers: [{ base_url: mock.url }] });
    return executeTurn({ provider, message, scope, transport, spans: createSpans({ now }), now, timeoutMs: 5000, retries: 0 });
  }

  const usage = { when: { "$.type": "usage" }, usage: { input: "$.input_tokens", output: "$.output_tokens" } };
  const sse = (events) => fakeTransport(() => ({ headers: { "content-type": "text/event-stream" }, chunks: sseChunks(events) }));

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
});
