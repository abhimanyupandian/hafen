// Ollama's chat API (POST /api/chat; contracts/provider.md, Presets), streamed as newline-delimited
// JSON. Each line has a piece of `message.thinking` (thinking models, with `think`) or of
// `message.content`; tool calls arrive whole, with their arguments as an object; the last line has
// `done`, the token counts and Ollama's own timings (nanoseconds). Checked against Ollama 0.35.
// No key by default (a local server); `api_key` sends one as a bearer token (ollama.com, a proxy).

import { ndjson } from "../../stream/ndjson.js";
import { formatMessages } from "../history.js";
import { failed, num, post } from "./common.js";

export function ollama(config) {
  return {
    kind: "ollama",
    config,
    async *send({ message, history, scope, transport, signal, wantThinking, extraMessages = [] }) {
      const base = scope.resolve(config.base_url ?? "http://localhost:11434").replace(/\/+$/, "").replace(/\/api$/, "");
      const key = config.api_key ? scope.resolve(config.api_key) : "";
      const params = scope.resolve(config.params ?? {});
      if (wantThinking && params.think === undefined) params.think = true;
      const messages = [...formatMessages("openai", history, message, { system: config.system && scope.resolve(config.system) }), ...extraMessages];
      const body = { model: scope.resolve(config.model), messages, ...params, stream: true };
      const res = yield* post({ url: `${base}/api/chat`, headers: key ? { authorization: `Bearer ${key}` } : {}, body, transport, signal });
      if (res.status >= 400) return yield* failed(res);

      let text = "";
      let thinking = "";
      let finish;
      let last = null;
      const toolCalls = [];
      const chunks = [];
      for await (const data of ndjson(res.body, { onText: (t) => chunks.push(t) })) {
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
        if (!data || typeof data !== "object") continue;
        last = data;
        if (data.error) {
          yield { type: "error", message: typeof data.error === "string" ? data.error : JSON.stringify(data.error) };
          continue;
        }
        const m = data.message ?? {};
        if (m.thinking) {
          thinking += m.thinking;
          yield { type: "thinking", text: m.thinking, visibility: "full" };
        }
        if (m.content) {
          text += m.content;
          yield { type: "text", text: m.content };
        }
        for (const call of m.tool_calls ?? []) {
          const entry = { id: call.id ?? `call_${toolCalls.length}`, name: call.function?.name ?? "", args: call.function?.arguments ?? {} };
          toolCalls.push(entry);
          yield { type: "tool_call", ...entry };
        }
        if (data.done) {
          finish = data.done_reason;
          yield { type: "usage", input: num(data.prompt_eval_count), output: num(data.eval_count), cached: num(data.prompt_eval_cached_count) };
        }
      }
      while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      yield { type: "body", body: last };
      // Replayed as the assistant's message in live history
      yield {
        type: "raw",
        value: {
          message: {
            role: "assistant",
            content: text,
            ...(thinking ? { thinking } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })) } : {}),
          },
        },
      };
      yield { type: "done", finish };
    },
    // Tool results, as the next request's messages (tool mocks: contracts/test-file.md)
    toolMessages(raw, results) {
      return [raw.message, ...results.map((r) => ({ role: "tool", tool_name: r.name, tool_call_id: r.id, content: typeof r.result === "string" ? r.result : JSON.stringify(r.result) }))];
    },
  };
}
