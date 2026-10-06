// A provider for endpoints that chat over a WebSocket (contracts/provider.md; research §24): connect,
// send the turn's message (a template), read each message by the same event rules as a stream, until
// a rule says it's done or the socket is quiet for `end.idle_ms`.

import { formatMessages } from "./history.js";
import { fromRule, matches, tryJSON } from "./http.js";
import { thinkTagSplitter } from "../stream/think-tags.js";
import { abortError } from "../util.js";

export function websocketProvider(config) {
  return {
    kind: "websocket",
    config,
    async *send({ message, history, scope, transport, signal, session }) {
      const extra = { user: message, messages: formatMessages(config.messages_format ?? "openai", history, message), session: session ?? "" };
      const url = scope.resolve(config.url, extra);
      const payload = scope.resolve(config.send ?? "{{user}}", extra);
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      yield { type: "request", request: { url, method: "WEBSOCKET", headers: {}, body: text } };

      const open = transport.websocket ?? ((u, p) => new WebSocket(u, p));
      const socket = open(url, config.protocols);
      const inbox = [];
      let wake = null;
      let closed = false;
      let failure = null;
      const push = (item) => {
        inbox.push(item);
        wake?.();
      };
      socket.onmessage = (e) => push(typeof e.data === "string" ? e.data : String(e.data));
      socket.onerror = () => { failure = new Error(`The WebSocket to ${url} failed`); wake?.(); };
      socket.onclose = () => { closed = true; wake?.(); };
      const stop = () => { try { socket.close(); } catch {} };
      signal?.addEventListener("abort", stop, { once: true });

      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error(`Couldn't open a WebSocket to ${url}`));
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      socket.onerror = () => { failure = new Error(`The WebSocket to ${url} failed`); wake?.(); };
      yield { type: "response", status: 101, headers: {} };
      socket.send(text);

      const idle = config.end?.idle_ms ?? 30000;
      const tags = config.think_tags ? thinkTagSplitter(config.think_tags) : null;
      const textOut = function* (t) {
        if (!t) return;
        if (!tags) return yield { type: "text", text: t };
        for (const part of tags.feed(t)) yield part.type === "thinking" ? { type: "thinking", text: part.text, visibility: "full" } : { type: "text", text: part.text };
      };
      const toolArgs = new Map();
      let last = null;
      let finish = "end";
      try {
        for (;;) {
          if (!inbox.length) {
            if (closed || failure) break;
            const timedOut = await new Promise((resolve) => {
              const timer = setTimeout(() => resolve(true), idle);
              wake = () => { clearTimeout(timer); wake = null; resolve(false); };
            });
            if (timedOut) {
              finish = "quiet";
              break;
            }
            continue;
          }
          const raw = inbox.shift();
          yield { type: "chunk", text: raw };
          const data = tryJSON(raw);
          last = data;
          const rule = (config.events ?? []).find((r) => matches(r.when, "message", data));
          if (!rule) continue;
          yield* fromRule(rule, data, { textOut, visibility: "full", toolArgs });
          if (rule.done) {
            finish = "stop";
            break;
          }
        }
        if (failure && finish === "end") yield { type: "error", message: failure.message };
      } finally {
        stop();
      }
      for (const call of toolArgs.values()) yield { type: "tool_call", id: call.id, name: call.name, args: tryJSON(call.args) };
      if (tags) for (const part of tags.end()) yield part.type === "thinking" ? { type: "thinking", text: part.text, visibility: "full" } : { type: "text", text: part.text };
      yield { type: "body", body: last };
      yield { type: "done", finish };
    },
  };
}
