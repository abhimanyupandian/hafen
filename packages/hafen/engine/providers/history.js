// A conversation, as each kind of API wants it sent (contracts/provider.md, History). `history` is the
// earlier turns: { user, reply, raw }, where `raw` is what the provider kept to replay (signed
// thinking blocks, a response id). Pinned turns have no `raw`: they're sent as plain text. In the
// OpenAI shape (openai-chat, ollama, http) each earlier turn is only its query and its response, as
// text: not the assistant's whole message (its thinking and tool calls).

// The earlier turns as { query, response } pairs (an HTTP provider's {{history}})
export const historyPairs = (history) => history.map((turn) => ({ query: turn.user, response: turn.reply ?? "" }));

export function formatMessages(format, history, message, { system } = {}) {
  switch (format) {
    case "anthropic": {
      const out = [];
      for (const turn of history) {
        out.push({ role: "user", content: [{ type: "text", text: turn.user }] });
        out.push({ role: "assistant", content: Array.isArray(turn.raw?.content) ? turn.raw.content : [{ type: "text", text: turn.reply ?? "" }] });
      }
      out.push({ role: "user", content: [{ type: "text", text: message }] });
      return out;
    }
    case "gemini": {
      const out = [];
      for (const turn of history) {
        out.push({ role: "user", parts: [{ text: turn.user }] });
        out.push({ role: "model", parts: Array.isArray(turn.raw?.parts) ? turn.raw.parts : [{ text: turn.reply ?? "" }] });
      }
      out.push({ role: "user", parts: [{ text: message }] });
      return out;
    }
    case "text":
      return [...history.flatMap((t) => [`User: ${t.user}`, `Assistant: ${t.reply ?? ""}`]), `User: ${message}`].join("\n");
    case "openai":
    default: {
      const out = system ? [{ role: "system", content: system }] : [];
      for (const turn of history) {
        out.push({ role: "user", content: turn.user });
        out.push({ role: "assistant", content: turn.reply ?? "" });
      }
      out.push({ role: "user", content: message });
      return out;
    }
  }
}
