// A provider described by configuration alone (contracts/provider.md): the request is a template, the
// reply is read by JSONPath, from one JSON body or from each event of an SSE or NDJSON stream.
//
// send() yields what happened, in order. Besides TurnEvents (thinking, text, tool_call, tool_result,
// usage, done, error) it yields records for the engine:
//   { type: "request", request }          what was sent
//   { type: "response", status, headers }  the response began (its first byte)
//   { type: "chunk", text }                raw stream text, for the record
//   { type: "body", body }                 the parsed body (not streamed), or the last event's data
//   { type: "session", value }             a session id to carry to the next turn
//   { type: "raw", value }                 what to replay with this turn in live history

import { first, select } from "../jsonpath.js";
import { ndjson } from "../stream/ndjson.js";
import { sse } from "../stream/sse.js";
import { thinkTagSplitter } from "../stream/think-tags.js";
import { isObject, short as oneLine, textChunks } from "../util.js";
import { formatMessages, historyPairs } from "./history.js";

export function httpProvider(config) {
  return {
    kind: "http",
    config,
    async *send({ message, history, scope, transport, signal, wantThinking, session }) {
      const messages = formatMessages(config.messages_format ?? "openai", history, message);
      const extra = { user: message, messages, history: historyPairs(history), session: session ?? "" };
      let body = config.body;
      if (wantThinking && isObject(config.thinking?.request) && isObject(body)) body = deepMerge(body, config.thinking.request);
      const query = config.query ? scope.resolve(config.query, extra) : null;
      let url = scope.resolve(config.url, extra);
      if (query) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
      const headers = { "content-type": "application/json", ...scope.resolve(config.headers ?? {}, extra) };
      if (config.history === "session" && config.session?.send === "header" && session) headers[config.session.name ?? "x-session-id"] = session;
      if (config.history === "session" && config.session?.send === "cookie" && session) headers.cookie = `${config.session.name ?? "session"}=${session}`;
      const method = config.method ?? "POST";
      const resolvedBody = body === undefined || method === "GET" ? undefined : scope.resolve(body, extra);
      const request = { url, method, headers, body: resolvedBody === undefined ? undefined : typeof resolvedBody === "string" ? resolvedBody : JSON.stringify(resolvedBody) };
      yield { type: "request", request };

      const res = await transport.send(request, { signal });
      yield { type: "response", status: res.status, headers: res.headers };

      const visibility = config.response?.thinking_visibility ?? config.thinking?.visibility ?? "full";
      const tags = config.think_tags ? thinkTagSplitter(config.think_tags) : null;
      const textOut = function* (text) {
        if (!text) return;
        if (!tags) {
          yield { type: "text", text };
          return;
        }
        for (const part of tags.feed(text)) yield part.type === "thinking" ? { type: "thinking", text: part.text, visibility: "full" } : { type: "text", text: part.text };
      };

      const stream = config.stream ?? "none";
      if (stream === "none") {
        let raw = "";
        for await (const text of textChunks(res.body)) raw += text;
        let parsed = null;
        const json = /json/i.test(res.headers["content-type"] ?? "") || /^\s*[[{]/.test(raw);
        if (json) {
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
        }
        yield { type: "body", body: parsed ?? raw, text: raw };
        if (res.status >= 400 && !(parsed && config.response?.error && first(config.response.error, parsed) !== undefined)) {
          yield { type: "error", message: `${res.status}: ${short(raw)}`, status: res.status };
          return;
        }
        if (parsed === null) {
          yield* textOut(raw);
        } else {
          yield* fromMap(config.response ?? {}, parsed, { textOut, visibility });
          if (config.session?.extract) {
            const value = first(config.session.extract, parsed);
            if (value !== undefined) yield { type: "session", value };
          }
        }
        if (tags) for (const part of tags.end()) yield part.type === "thinking" ? { type: "thinking", text: part.text, visibility: "full" } : { type: "text", text: part.text };
        yield { type: "done", finish: config.response?.finish ? first(config.response.finish, parsed ?? {}) : undefined };
        return;
      }

      if (res.status >= 400) {
        let raw = "";
        for await (const text of textChunks(res.body)) raw += text;
        yield { type: "body", body: tryJSON(raw), text: raw };
        yield { type: "error", message: `${res.status}: ${short(raw)}`, status: res.status };
        return;
      }

      const toolArgs = new Map();  // tool calls streamed in pieces, joined by id
      const chunks = [];           // raw text as it arrived, for the record
      let last = null;
      const items = stream === "sse"
        ? sse(res.body, { onText: (text) => chunks.push(text) })
        : ndjson(res.body, { onText: (text) => chunks.push(text) });
      let ended = false;
      let seen = 0;  // events read, and how many a rule matched (none: the rules are wrong)
      let matched = 0;
      let unmatched;
      let gave = false;          // whether any gave the reply (text, thinking, a tool call)
      const kinds = new Set();   // what the rules that matched read
      for await (const item of items) {
        while (chunks.length) yield { type: "chunk", text: chunks.shift() };
        let data;
        let eventName = "message";
        if (stream === "sse") {
          eventName = item.event;
          if (config.done_marker !== undefined ? item.data === config.done_marker : item.data === "[DONE]") {
            ended = true;
            break;
          }
          data = tryJSON(item.data);
        } else {
          data = item;
        }
        last = data;
        seen += 1;
        const rule = (config.events ?? []).find((r) => matches(r.when, eventName, data));
        if (!rule) {
          unmatched ??= [eventName !== "message" && `event ${eventName}`, oneLine(data, 60)].filter(Boolean).join(", ") || "empty";
          continue;
        }
        matched += 1;
        for (const kind of ruleReads(rule)) kinds.add(kind);
        if (yield* fromRule(rule, data, { textOut, visibility, toolArgs })) gave = true;
        if (rule.done) {
          ended = true;
          break;
        }
      }
      while (chunks.length) yield { type: "chunk", text: chunks.shift() };
      const noun = stream === "sse" ? "event" : "line";
      if (seen && !matched) yield { type: "error", message: noRuleMatched(seen, noun, unmatched, config.events) };
      else if (seen && !gave) {
        const blank = nothingRead(seen, noun, matched, kinds, unmatched, config.events);
        if (blank) yield { type: "error", message: blank };
      }
      for (const call of toolArgs.values()) yield { type: "tool_call", id: call.id, name: call.name, args: tryJSON(call.args) };
      if (tags) for (const part of tags.end()) yield part.type === "thinking" ? { type: "thinking", text: part.text, visibility: "full" } : { type: "text", text: part.text };
      yield { type: "body", body: last };
      if (config.session?.extract && last) {
        const value = first(config.session.extract, last);
        if (value !== undefined) yield { type: "session", value };
      }
      yield { type: "done", finish: ended ? "stop" : "end of stream" };
    },
  };
}

// The non-streamed reply's paths
function* fromMap(map, body, { textOut, visibility }) {
  if (map.error) {
    const error = first(map.error, body);
    if (error !== undefined && error !== null && error !== "") {
      yield { type: "error", message: typeof error === "string" ? error : JSON.stringify(error) };
      return;
    }
  }
  if (map.thinking) {
    const thinking = joinText(select(map.thinking, body));
    if (thinking) yield { type: "thinking", text: thinking, visibility };
  }
  if (map.tool_calls) yield* toolCalls(map.tool_calls, body);
  const text = map.text ? joinText(select(map.text, body)) : typeof body === "string" ? body : "";
  yield* textOut(text);
  if (map.usage) yield usageOf(map.usage, body);
  const session = map.session ? first(map.session, body) : undefined;
  if (session !== undefined) yield { type: "session", value: session };
}

// One stream event, by the rule that matched it. Returns whether it gave any of the reply: text,
// thinking or a tool call that its paths found (an empty string is found; nothing there isn't), or
// thinking the rule says is hidden
export function* fromRule(rule, data, { textOut, visibility, toolArgs }) {
  if (rule.error) {
    const error = first(rule.error, data);
    yield { type: "error", message: typeof error === "string" ? error : JSON.stringify(error ?? data) };
    return false;
  }
  let gave = false;
  if (rule.thinking) {
    const values = select(rule.thinking, data);
    const shown = rule.thinking_visibility ?? visibility;
    gave = found(values) || ["omitted", "redacted"].includes(shown);
    yield { type: "thinking", text: joinText(values), visibility: shown };
  }
  if (rule.text) {
    const values = select(rule.text, data);
    gave ||= found(values);
    yield* textOut(joinText(values));
  }
  if (rule.tool_call) {
    const id = rule.tool_call.id ? first(rule.tool_call.id, data) : undefined;
    const name = first(rule.tool_call.name, data);
    const args = rule.tool_call.args ? first(rule.tool_call.args, data) : undefined;
    gave ||= name !== undefined || args !== undefined;
    // A whole call in one event: now, in order. Arguments streamed as text: joined by id, at the end.
    if (typeof args !== "string" && !toolArgs.has(id ?? name)) {
      yield { type: "tool_call", id: String(id ?? `call_${toolArgs.size}`), name, args };
      return gave;
    }
    const key = id ?? name ?? toolArgs.size;
    const call = toolArgs.get(key) ?? { id: id ?? String(key), name, args: "" };
    if (name) call.name = name;
    call.args = typeof args === "string" ? call.args + args : args ?? call.args;
    toolArgs.set(key, call);
  }
  if (rule.tool_result) {
    gave = true;
    yield { type: "tool_result", id: String(first(rule.tool_result.id ?? "$.id", data) ?? ""), name: first(rule.tool_result.name, data), result: first(rule.tool_result.result ?? "$.result", data) };
  }
  if (rule.usage) yield usageOf(rule.usage, data);
  if (rule.session) {
    const value = first(rule.session, data);
    if (value !== undefined) yield { type: "session", value };
  }
  return gave;
}

function* toolCalls(map, body) {
  const items = map.path ? select(map.path, body) : [body];
  let n = 0;
  for (const item of items.flat()) {
    const name = first(map.name, item);
    if (name === undefined) continue;
    const args = map.args ? first(map.args, item) : undefined;
    yield { type: "tool_call", id: String((map.id ? first(map.id, item) : undefined) ?? `call_${n++}`), name, args: typeof args === "string" ? tryJSON(args) : args };
    if (map.result) {
      const result = first(map.result, item);
      if (result !== undefined) yield { type: "tool_result", id: String((map.id ? first(map.id, item) : undefined) ?? `call_${n - 1}`), name, result };
    }
  }
}

function usageOf(map, data) {
  const num = (path) => {
    if (!path) return undefined;
    const v = first(path, data);
    return Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined;
  };
  const usage = { type: "usage" };
  for (const field of ["input", "output", "thinking", "cached"]) {
    const v = num(map[field]);
    if (v !== undefined) usage[field] = v;
  }
  return usage;
}

// A stream whose events arrived and no rule matched would have a blank reply, without a word why:
// a turn error instead, saying how many came and what the first looked like. (Keep-alives and other
// events no rule wants are fine beside ones that are read.)
export function noRuleMatched(count, noun, firstOne, rules) {
  if (!rules?.length) return `${arrived(count, noun)}, and the provider has no events rules to read them (the first: ${firstOne}): add events`;
  return `${arrived(count, noun)}, and none matched the provider's events rules (the first: ${firstOne}): check events[].when`;
}

// Nor when some matched but none gave any of the reply (no text, thinking or tool call), from a
// provider with a rule to read it: that rule's when or path is wrong (the usage event matched, the
// text deltas didn't). A turn error too, saying what matched and the first that didn't. (Not for a
// provider with no such rule, only usage or done ones; nor when a rule read an error.)
export function nothingRead(count, noun, matched, kinds, firstOne, rules) {
  const want = READERS.find((key) => rules?.some((r) => r[key]));
  if (!want || kinds.has("error")) return null;
  const read = READERS.find((key) => kinds.has(key));
  const hint = read ? `check the ${read} rule's path (events[].${read})`
    : `check the ${want} rule's when (events[].when)${firstOne ? "" : ", and that no rule before it takes its events"}`;
  const what = kinds.size ? ` (${[...kinds].join(", ")})` : "";
  return `${arrived(count, noun)}; the rules matched ${matched}${what} but none gave text, thinking or a tool call${firstOne ? ` (the first unmatched: ${firstOne})` : ""}: ${hint}`;
}

const arrived = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"} arrived`;
// What a rule reads: the parts of the reply, then the rest
const READERS = ["text", "thinking", "tool_call"];
export const ruleReads = (rule) => [...READERS, "tool_result", "usage", "session", "done", "error"].filter((key) => rule[key]);

// `when`: an SSE event name and/or { <path>: value } pairs, all of which must match
export function matches(when, eventName, data) {
  if (!when) return true;
  for (const [key, expected] of Object.entries(when)) {
    if (key === "event") {
      if (eventName !== expected) return false;
    } else if (key.startsWith("$")) {
      if (data === null || typeof data !== "object") return false;
      if (first(key, data) !== expected) return false;
    }
  }
  return true;
}

const joinText = (values) => values.flat().filter((v) => v !== null && v !== undefined).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("");
const found = (values) => values.flat().some((v) => v !== null && v !== undefined);
const short = (text) => (text.length > 300 ? `${text.slice(0, 299)}…` : text).trim();
export function tryJSON(text) {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(v) && isObject(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}
