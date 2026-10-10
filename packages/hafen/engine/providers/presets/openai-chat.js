// OpenAI's Chat Completions API, and every server compatible with it (contracts/provider.md,
// Presets): streamed (SSE), with thinking from `reasoning_content` or `reasoning` deltas when a server
// sends them (DeepSeek, OpenRouter, vLLM, llama.cpp's server), tool calls joined by index, and usage
// from the last chunk. Mappings: research §11 (verify against the API's current docs).

import { sse } from "../../stream/sse.js";
import { tryJSON } from "../http.js";
import { formatMessages } from "../history.js";
import { apiKey, failed, num, post } from "./common.js";

export function openaiChat(config) {
  return {
    kind: "openai-chat",
    config,
    async *send({ message, history, scope, transport, signal, extraMessages = [] }) {
      const base = scope.resolve(config.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
      const key = apiKey(config, scope, "OPENAI_API_KEY");
      const params = scope.resolve(config.params ?? {});
      const messages = [...formatMessages("openai", history, message, { system: config.system && scope.resolve(config.system) }), ...extraMessages];
      const body = { model: scope.resolve(config.model), messages, stream: true, stream_options: { include_usage: true }, ...params };
      const res = yield* post({ url: `${base}/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {}, body, transport, signal });
      if (res.status >= 400) return yield* failed(res);

      let text = "";
      let finish;
      let last = null;
      const calls = new Map();  // index -> {id, name, args}
      const chunks = [];
      for await (const item of sse(res.body, { onText: (t) => chunks.push(t) })) {
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
        if (item.data === "[DONE]") break;
        const data = tryJSON(item.data);
        if (!data || typeof data !== "object") continue;
        last = data;
        if (data.error) {
          yield { type: "error", message: data.error.message ?? JSON.stringify(data.error) };
          continue;
        }
        const choice = data.choices?.[0];
        const delta = choice?.delta ?? {};
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) yield { type: "thinking", text: thinking, visibility: "full" };
        if (delta.content) {
          text += delta.content;
          yield { type: "text", text: delta.content };
        }
        for (const call of delta.tool_calls ?? []) {
          const entry = calls.get(call.index ?? 0) ?? { id: call.id, name: "", args: "" };
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.name += call.function.name;
          if (call.function?.arguments) entry.args += call.function.arguments;
          calls.set(call.index ?? 0, entry);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (data.usage) {
          yield {
            type: "usage",
            input: num(data.usage.prompt_tokens),
            output: num(data.usage.completion_tokens),
            thinking: num(data.usage.completion_tokens_details?.reasoning_tokens),
            cached: num(data.usage.prompt_tokens_details?.cached_tokens),
          };
        }
      }
      while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      const toolCalls = [...calls.values()];
      for (const call of toolCalls) yield { type: "tool_call", id: call.id, name: call.name, args: tryJSON(call.args) };
      yield { type: "body", body: last };
      // Replayed as the assistant's message in live history
      yield {
        type: "raw",
        value: {
          message: {
            role: "assistant",
            content: text,
            ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) } : {}),
          },
        },
      };
      yield { type: "done", finish };
    },
    // Tool results, as the next request's messages (tool mocks: contracts/test-file.md)
    toolMessages(raw, results) {
      return [raw.message, ...results.map((r) => ({ role: "tool", tool_call_id: r.id, content: typeof r.result === "string" ? r.result : JSON.stringify(r.result) }))];
    },
  };
}
