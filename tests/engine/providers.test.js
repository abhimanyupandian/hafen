// Providers (contracts/provider.md): the configured HTTP provider against the mock endpoint (one JSON
// reply, SSE, NDJSON, thinking, think tags, tool calls, errors, cut streams, sessions), and the
// presets against recorded streams.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";
import { createProvider } from "../../engine/providers/index.js";
import { PROVIDER_KINDS, providerTemplate } from "../../engine/providers/templates.js";
import { validateProviderSchema } from "../../engine/schema.js";
import { createSpans } from "../../engine/spans.js";
import { fetchTransport } from "../../engine/transport.js";
import { executeTurn } from "../../engine/turn.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, MOCK_SSE_PROVIDER, sseChunks, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
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
    await turn({ kind: "ollama", base_url: "http://gpu-box:11434/", model: "gemma4", api_key: "${env:OPENAI_API_KEY}", params: { options: { temperature: 0 } } }, "again", { transport: t2, history: [{ user: "Say hi in 3 words.", reply: out.record.reply, raw: out.record.raw_blocks[0] }] });
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
});
