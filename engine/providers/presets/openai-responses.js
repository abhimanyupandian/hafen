// OpenAI's Responses API, streamed (contracts/provider.md, Presets; research §11–12; verify against the
// API's current docs). Thinking is a reasoning summary (asked for when a test checks thinking).
// Live history continues from the previous response (`previous_response_id`); pinned history sends
// the earlier turns as plain messages.

import { sse } from "../../stream/sse.js";
import { tryJSON } from "../http.js";
import { apiKey, failed, num, post } from "./common.js";

export function openaiResponses(config) {
  return {
    kind: "openai-responses",
    config,
    async *send({ message, history, scope, transport, signal, wantThinking, extraInput = [], previousResponseId }) {
      const base = scope.resolve(config.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
      const key = apiKey(config, scope, "OPENAI_API_KEY");
      const params = scope.resolve(config.params ?? {});
      if (wantThinking) params.reasoning = { summary: "auto", ...(params.reasoning ?? {}) };
      // Tool results continue this turn's response; otherwise a turn continues the last one's
      const previous = previousResponseId ?? history.at(-1)?.raw?.response_id;
      const input = previousResponseId
        ? extraInput
        : previous
        ? [{ role: "user", content: message }, ...extraInput]
        : [...history.flatMap((t) => [{ role: "user", content: t.user }, { role: "assistant", content: t.reply ?? "" }]), { role: "user", content: message }, ...extraInput];
      const body = {
        model: scope.resolve(config.model),
        input,
        ...(previous ? { previous_response_id: previous } : {}),
        ...(config.system ? { instructions: scope.resolve(config.system) } : {}),
        ...params,
        stream: true,
      };
      const res = yield* post({ url: `${base}/responses`, headers: key ? { authorization: `Bearer ${key}` } : {}, body, transport, signal });
      if (res.status >= 400) return yield* failed(res);

      const calls = new Map();  // item id -> {id, name, args}
      let responseId;
      let finish;
      let last = null;
      const chunks = [];
      for await (const item of sse(res.body, { onText: (t) => chunks.push(t) })) {
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
        const data = tryJSON(item.data);
        if (!data || typeof data !== "object") continue;
        last = data;
        switch (data.type) {
          case "response.output_text.delta":
            yield { type: "text", text: data.delta ?? "" };
            break;
          case "response.reasoning_summary_text.delta":
            yield { type: "thinking", text: data.delta ?? "", visibility: "summary" };
            break;
          case "response.output_item.added":
            if (data.item?.type === "function_call") calls.set(data.item.id, { id: data.item.call_id ?? data.item.id, name: data.item.name, args: data.item.arguments ?? "" });
            break;
          case "response.function_call_arguments.delta": {
            const call = calls.get(data.item_id);
            if (call) call.args += data.delta ?? "";
            break;
          }
          case "response.output_item.done":
            if (data.item?.type === "function_call") {
              const call = calls.get(data.item.id) ?? { id: data.item.call_id, name: data.item.name };
              yield { type: "tool_call", id: data.item.call_id ?? call.id, name: data.item.name ?? call.name, args: tryJSON(data.item.arguments ?? call.args) };
              calls.delete(data.item.id);
            }
            break;
          case "response.completed":
          case "response.incomplete": {
            const r = data.response ?? {};
            responseId = r.id;
            finish = data.type === "response.completed" ? "stop" : r.incomplete_details?.reason ?? "incomplete";
            const u = r.usage ?? {};
            yield {
              type: "usage",
              input: num(u.input_tokens),
              output: num(u.output_tokens),
              thinking: num(u.output_tokens_details?.reasoning_tokens),
              cached: num(u.input_tokens_details?.cached_tokens),
            };
            break;
          }
          case "response.failed":
          case "error":
            yield { type: "error", message: data.response?.error?.message ?? data.message ?? data.error?.message ?? JSON.stringify(data) };
            break;
          default:
            break;
        }
      }
      while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      yield { type: "body", body: last };
      if (responseId) yield { type: "raw", value: { response_id: responseId } };
      yield { type: "done", finish };
    },
    toolInput(results) {
      return results.map((r) => ({ type: "function_call_output", call_id: r.id, output: typeof r.result === "string" ? r.result : JSON.stringify(r.result) }));
    },
  };
}
