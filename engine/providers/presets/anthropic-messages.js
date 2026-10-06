// Anthropic's Messages API, streamed (contracts/provider.md, Presets; research §11–12; verify against
// the API's current docs). Thinking arrives in `thinking` blocks: summaries when a test checks
// thinking (the preset asks for `display: "summarized"`), empty ("omitted") otherwise on current
// models, or `redacted_thinking`. Every block is kept, with its signature, and replayed unchanged in
// live history; pinned turns are sent as plain text, with no thinking blocks.

import { sse } from "../../stream/sse.js";
import { tryJSON } from "../http.js";
import { formatMessages } from "../history.js";
import { apiKey, failed, num, post } from "./common.js";

export function anthropicMessages(config) {
  return {
    kind: "anthropic-messages",
    config,
    async *send({ message, history, scope, transport, signal, wantThinking, extraMessages = [] }) {
      const base = scope.resolve(config.base_url ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
      const key = apiKey(config, scope, "ANTHROPIC_API_KEY");
      const params = scope.resolve(config.params ?? {});
      if (wantThinking && !params.thinking) params.thinking = { type: "adaptive", display: "summarized" };
      const display = params.thinking?.display;
      const summaryVisibility = display === "summarized" ? "summary" : display === "updates" ? "progress" : "summary";
      const body = {
        model: scope.resolve(config.model),
        max_tokens: 4096,
        messages: [...formatMessages("anthropic", history, message), ...extraMessages],
        ...(config.system ? { system: scope.resolve(config.system) } : {}),
        ...params,
        stream: true,
      };
      const headers = { "x-api-key": key, "anthropic-version": config.version ?? "2023-06-01" };
      const res = yield* post({ url: `${base}/messages`, headers, body, transport, signal });
      if (res.status >= 400) return yield* failed(res);

      const blocks = [];  // the reply's content blocks, rebuilt for replay
      let finish;
      let last = null;
      const chunks = [];
      for await (const item of sse(res.body, { onText: (t) => chunks.push(t) })) {
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
        const data = tryJSON(item.data);
        if (!data || typeof data !== "object") continue;
        last = data;
        switch (data.type) {
          case "message_start": {
            const u = data.message?.usage ?? {};
            yield { type: "usage", input: num(u.input_tokens), cached: num(u.cache_read_input_tokens) };
            break;
          }
          case "content_block_start": {
            const b = data.content_block ?? {};
            if (b.type === "text") blocks[data.index] = { type: "text", text: b.text ?? "" };
            else if (b.type === "thinking") blocks[data.index] = { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "", _deltas: 0 };
            else if (b.type === "redacted_thinking") {
              blocks[data.index] = { type: "redacted_thinking", data: b.data };
              yield { type: "thinking", text: "", visibility: "redacted" };
            } else if (b.type === "tool_use") blocks[data.index] = { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {}, _json: "" };
            else blocks[data.index] = { ...b };
            break;
          }
          case "content_block_delta": {
            const b = blocks[data.index];
            const d = data.delta ?? {};
            if (d.type === "text_delta" && b) {
              b.text += d.text;
              yield { type: "text", text: d.text };
            } else if (d.type === "thinking_delta" && b) {
              b.thinking += d.thinking;
              b._deltas += 1;
              if (d.thinking) yield { type: "thinking", text: d.thinking, visibility: summaryVisibility };
            } else if (d.type === "signature_delta" && b) {
              b.signature += d.signature;
            } else if (d.type === "input_json_delta" && b) {
              b._json += d.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
            const b = blocks[data.index];
            if (b?.type === "tool_use") {
              if (b._json) b.input = tryJSON(b._json);
              yield { type: "tool_call", id: b.id, name: b.name, args: b.input };
            } else if (b?.type === "thinking" && !b.thinking) {
              yield { type: "thinking", text: "", visibility: "omitted" };
            }
            break;
          }
          case "message_delta": {
            if (data.delta?.stop_reason) finish = data.delta.stop_reason;
            if (data.usage) yield { type: "usage", output: num(data.usage.output_tokens) };
            break;
          }
          case "error":
            yield { type: "error", message: data.error?.message ?? JSON.stringify(data.error ?? data) };
            break;
          default:
            break;
        }
      }
      while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      const content = blocks.filter(Boolean).map(({ _deltas, _json, ...b }) => b);
      yield { type: "body", body: last };
      yield { type: "raw", value: { content } };
      yield { type: "done", finish };
    },
    toolMessages(raw, results) {
      return [
        { role: "assistant", content: raw.content },
        { role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: typeof r.result === "string" ? r.result : JSON.stringify(r.result) })) },
      ];
    },
  };
}
