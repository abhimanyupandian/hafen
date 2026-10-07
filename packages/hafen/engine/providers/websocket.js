// A provider for endpoints that chat over a WebSocket (contracts/provider.md; research §24): connect,
// send the turn's message (a template), read each message by the same event rules as a stream, until
// a rule says it's done or the socket is quiet for `end.idle_ms`.

import { formatMessages } from "./history.js";
import { fromRule, matches, noRuleMatched, nothingRead, ruleReads, tryJSON } from "./http.js";
import { thinkTagSplitter } from "../stream/think-tags.js";
import { abortError, short } from "../util.js";

export function websocketProvider(config) {
  return {
    kind: "websocket",
    config,
    async *send({ message, history, scope, transport, signal, session }) {
      const extra = { user: message, messages: formatMessages(config.messages_format ?? "openai", history, message), session: session ?? "" };
      const url = scope.resolve(config.url, extra);
      const payload = scope.resolve(config.send ?? "{{user}}", extra);
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      const headers = scope.resolve(config.headers ?? {}, extra);
      yield { type: "request", request: { url, method: "WEBSOCKET", headers, body: text } };

      const open = transport.websocket ?? openSocket;
      const socket = open(url, { protocols: config.protocols, headers });
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
      let seen = 0;
      let matched = 0;
      let unmatched;
      let gave = false;
      const kinds = new Set();
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
          seen += 1;
          const rule = (config.events ?? []).find((r) => matches(r.when, "message", data));
          if (!rule) {
            unmatched ??= short(data, 60) || "empty";
            continue;
          }
          matched += 1;
          for (const kind of ruleReads(rule)) kinds.add(kind);
          if (yield* fromRule(rule, data, { textOut, visibility: "full", toolArgs })) gave = true;
          if (rule.done) {
            finish = "stop";
            break;
          }
        }
        if (failure && finish === "end") yield { type: "error", message: failure.message };
        else if (seen && !matched) yield { type: "error", message: noRuleMatched(seen, "message", unmatched, config.events) };
        else if (seen && !gave) {
          const blank = nothingRead(seen, "message", matched, kinds, unmatched, config.events);
          if (blank) yield { type: "error", message: blank };
        }
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

// The platform's WebSocket. Node's (the CLI, the desktop app's engine) sends headers; a browser's
// can't, and would leave them out without a word, so there a provider with headers is an error.
function openSocket(url, { protocols, headers }) {
  const browser = typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined";
  if (!browser) return new WebSocket(url, { protocols, headers });
  const names = Object.keys(headers);
  if (names.length) throw new Error(`A WebSocket in a browser can't send headers (this provider sets ${names.join(", ")}): put credentials in its url or protocols, or use the desktop app or the CLI`);
  return new WebSocket(url, protocols);
}
