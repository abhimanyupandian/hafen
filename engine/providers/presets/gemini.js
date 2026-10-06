// Google's Gemini API, streamed (`streamGenerateContent?alt=sse`; contracts/provider.md, Presets;
// research §11; verify against the API's current docs). Thought summaries come as parts marked
// `thought: true` when a test checks thinking (the preset asks for `includeThoughts`); every part is
// kept and replayed in live history.

import { sse } from "../../stream/sse.js";
import { tryJSON } from "../http.js";
import { formatMessages } from "../history.js";
import { apiKey, failed, num, post } from "./common.js";

export function gemini(config) {
  return {
    kind: "gemini",
    config,
    async *send({ message, history, scope, transport, signal, wantThinking, extraContents = [] }) {
      const base = scope.resolve(config.base_url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
      const key = apiKey(config, scope, "GEMINI_API_KEY");
      const params = scope.resolve(config.params ?? {});
      const generationConfig = { ...(params.generationConfig ?? {}) };
      if (wantThinking) generationConfig.thinkingConfig = { includeThoughts: true, ...(generationConfig.thinkingConfig ?? {}) };
      const { generationConfig: _, ...rest } = params;
      const body = {
        contents: [...formatMessages("gemini", history, message), ...extraContents],
        ...(config.system ? { systemInstruction: { parts: [{ text: scope.resolve(config.system) }] } } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        ...rest,
      };
      const model = scope.resolve(config.model);
      const res = yield* post({ url: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, headers: { "x-goog-api-key": key }, body, transport, signal });
      if (res.status >= 400) return yield* failed(res);

      const parts = [];
      let finish;
      let last = null;
      let n = 0;
      const chunks = [];
      for await (const item of sse(res.body, { onText: (t) => chunks.push(t) })) {
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
        const data = tryJSON(item.data);
        if (!data || typeof data !== "object") continue;
        last = data;
        if (data.error) {
          yield { type: "error", message: data.error.message ?? JSON.stringify(data.error) };
          continue;
        }
        const candidate = data.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          parts.push(part);
          if (part.functionCall) yield { type: "tool_call", id: part.functionCall.id ?? `call_${n++}`, name: part.functionCall.name, args: part.functionCall.args };
          else if (part.thought) yield { type: "thinking", text: part.text ?? "", visibility: "summary" };
          else if (part.text) yield { type: "text", text: part.text };
        }
        if (candidate?.finishReason) finish = candidate.finishReason;
        const u = data.usageMetadata;
        if (u) {
          yield { type: "usage", input: num(u.promptTokenCount), output: num(u.candidatesTokenCount), thinking: num(u.thoughtsTokenCount), cached: num(u.cachedContentTokenCount) };
        }
      }
      while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      yield { type: "body", body: last };
      yield { type: "raw", value: { parts: mergeText(parts) } };
      yield { type: "done", finish };
    },
    toolContents(raw, results) {
      return [
        { role: "model", parts: raw.parts },
        { role: "user", parts: results.map((r) => ({ functionResponse: { name: r.name, response: typeof r.result === "object" && r.result !== null ? r.result : { result: r.result } } })) },
      ];
    },
  };
}

// Streamed text parts joined, so the replayed reply isn't hundreds of fragments
function mergeText(parts) {
  const out = [];
  for (const part of parts) {
    const prev = out.at(-1);
    if (prev && typeof prev.text === "string" && typeof part.text === "string" && !!prev.thought === !!part.thought && Object.keys(part).every((k) => k === "text" || k === "thought")) {
      prev.text += part.text;
    } else out.push({ ...part });
  }
  return out;
}
